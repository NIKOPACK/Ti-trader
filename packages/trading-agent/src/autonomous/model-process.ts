import { type ChildProcess, fork } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExecutionScope } from "@nikopack/ti-trading-engine";
import type { TSchema } from "typebox";
import type { AutonomousConfig } from "./config.ts";
import { type AutonomousModel, failureCode } from "./runtime.ts";
import type { AutonomousDecision } from "./schema.ts";
import { AUTONOMOUS_TOOLS, type AutonomousTools } from "./tools.ts";

export interface ModelWorkerRequest {
	config: AutonomousConfig;
	agentDir: string;
	context: string;
	researchScope: ExecutionScope;
	tools: Array<{ name: string; description: string; parameters: TSchema; mutating: boolean }>;
}
export type ModelWorkerMessage =
	| { kind: "tool"; id: string; ordinal: number; name: string; args: unknown }
	| { kind: "done"; text: string }
	| { kind: "error"; reason: string }
	| { kind: "service-failure"; source: string; reason: string };

/** Isolated children escalate to SIGKILL after 2s; the worker must outlive that watchdog. */
export const WORKER_FORCE_KILL_MS = 4_000;

export function modelWorkerEnvironment(env = process.env): NodeJS.ProcessEnv {
	const selected: NodeJS.ProcessEnv = {};
	for (const name of [
		"HOME",
		"PATH",
		"TMPDIR",
		"TMP",
		"TEMP",
		"LANG",
		"LC_ALL",
		"TZ",
		"SSL_CERT_FILE",
		"SSL_CERT_DIR",
		"OPENAI_API_KEY",
		"ANTHROPIC_API_KEY",
		"GEMINI_API_KEY",
		"GOOGLE_API_KEY",
		"OPENROUTER_API_KEY",
		"TAVILY_API_KEY",
		"ZHIHU_ACCESS_SECRET",
		"TI_ZHIHU_ACCESS_SECRET_FILE",
		"TI_FREQTRADE_URL",
		"TI_FREQTRADE_USERNAME",
		"TI_FREQTRADE_PASSWORD",
		"TI_DATA_DIR",
		"TSX_TSCONFIG_PATH",
	])
		if (env[name] !== undefined) selected[name] = env[name];
	if (selected.TSX_TSCONFIG_PATH) selected.TSX_TSCONFIG_PATH = resolve(selected.TSX_TSCONFIG_PATH);
	return selected;
}

export class ModelProcess implements AutonomousModel {
	private child: ChildProcess | undefined;
	private readonly config: AutonomousConfig;
	private readonly agentDir: string;
	private readonly tools: AutonomousTools;
	constructor(config: AutonomousConfig, agentDir: string, tools: AutonomousTools) {
		this.config = config;
		this.agentDir = agentDir;
		this.tools = tools;
	}
	async run(decision: AutonomousDecision, context: string, signal: AbortSignal): Promise<string> {
		if (this.child) throw new Error("Model process already running");
		if (signal.aborted) throw new Error("Model cancelled");
		const file = fileURLToPath(
			new URL(import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js", import.meta.url),
		);
		const child = fork(file, [], {
			cwd: this.agentDir,
			env: modelWorkerEnvironment(),
			stdio: ["ignore", "ignore", "ignore", "ipc"],
			serialization: "json",
		});
		this.child = child;
		try {
			return await new Promise<string>((resolve, reject) => {
				let finished = false;
				const abort = (): void => {
					child.kill("SIGTERM");
					reject(new Error("Model cancelled"));
				};
				signal.addEventListener("abort", abort, { once: true });
				child.once("error", reject);
				child.once("exit", () => {
					signal.removeEventListener("abort", abort);
					if (!finished) reject(new Error("Model disconnected before completing its decision"));
				});
				child.on("message", (message: unknown) => {
					if (!message || typeof message !== "object" || !("kind" in message)) {
						reject(new Error("Invalid model IPC message"));
						return;
					}
					const event = message as ModelWorkerMessage;
					if (
						event.kind === "service-failure" &&
						typeof event.source === "string" &&
						/^[a-z_]{1,64}$/.test(event.source) &&
						["timeout", "rate-limited", "authentication-failed", "disconnected", "operation-failed"].includes(
							event.reason,
						)
					) {
						this.tools.recordServiceFailure(event.source, event.reason);
						return;
					}
					if (event.kind === "done" && typeof event.text === "string") {
						finished = true;
						resolve(event.text);
						return;
					}
					if (event.kind === "error") {
						reject(new Error(`Model ${event.reason}`));
						return;
					}
					if (
						event.kind !== "tool" ||
						typeof event.id !== "string" ||
						!Number.isSafeInteger(event.ordinal) ||
						event.ordinal < 0 ||
						typeof event.name !== "string"
					) {
						reject(new Error("Invalid model tool request"));
						return;
					}
					void this.tools.callWithDeadline(decision.id, event.ordinal, event.name, event.args, signal).then(
						(result) => {
							if (child.connected) child.send({ kind: "result", id: event.id, result });
						},
						(error) => {
							if (child.connected)
								child.send({
									kind: "result",
									id: event.id,
									result: { status: "error", reason: failureCode(error), source: event.name },
								});
						},
					);
				});
				const request: ModelWorkerRequest = {
					config: this.config,
					agentDir: this.agentDir,
					context,
					researchScope: this.tools.researchScope(),
					tools: AUTONOMOUS_TOOLS,
				};
				child.send({ kind: "start", request });
			});
		} finally {
			await this.stop();
		}
	}
	async stop(): Promise<void> {
		const child = this.child;
		if (!child) return;
		this.child = undefined;
		if (child.exitCode !== null || child.signalCode !== null) return;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => child.kill("SIGKILL"), WORKER_FORCE_KILL_MS);
			child.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
			child.kill("SIGTERM");
		});
	}
}
