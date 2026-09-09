/**
 * Spawn a read-only coding-agent child. The child has no Ti trading runtime
 * and no exchange credentials; callers must already have allowlisted tools.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { extractProposedOrder, PROPOSE_ORDER_TOOL, type ProposedOrder } from "./child-orders.ts";

export const CHILD_TIMEOUT_MS = 120_000;
export const FORCE_KILL_DELAY_MS = 2_000;
export const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export type IsolatedChildContent =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; arguments: Record<string, unknown> };

export type IsolatedChildMessage = {
	role: string;
	content: IsolatedChildContent[];
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		totalTokens?: number;
		cost?: { total?: number };
	};
};

export type IsolatedChildEvent =
	| { type: "message_end" | "tool_result_end"; message: IsolatedChildMessage }
	| { type: "tool_execution_end"; toolName: string; isError: boolean; result: unknown };

export type IsolatedChildRequest = {
	cwd: string;
	prompt: string;
	systemPrompt: string;
	tools: readonly string[];
	extensionPaths: readonly string[];
	model?: string;
	thinkingLevel?: string;
	timeoutMs?: number;
	maxOutputBytes?: number;
	signal: AbortSignal;
	onEvent?: (event: IsolatedChildEvent) => void;
};

export type IsolatedChildResult = {
	exitCode: number;
	messages: IsolatedChildMessage[];
	proposals?: ProposedOrder[];
	stderr: string;
	aborted: boolean;
	timedOut: boolean;
	outputTooLarge: boolean;
	error?: string;
};

type Termination = "abort" | "timeout" | "output";

export function resolveCodingAgentCli(): string {
	const packageEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	const packageEntryDirectory = path.dirname(packageEntry);
	const packageRoot = path.resolve(packageEntryDirectory, "..");
	const candidates = [
		path.join(packageEntryDirectory, "bundle", "cli.js"),
		path.join(packageEntryDirectory, "cli.js"),
		path.join(packageRoot, "dist", "bundle", "cli.js"),
		path.join(packageRoot, "dist", "cli.js"),
		path.join(packageEntryDirectory, "cli.ts"),
		path.join(packageRoot, "src", "cli.ts"),
	];
	const cli = candidates.find((candidate) => existsSync(candidate));
	if (!cli) throw new Error("Unable to locate the pi coding-agent CLI");
	return cli;
}

export function resolveSiblingMarketLab(fromFile: string): string {
	const extensionDirectory = path.dirname(fromFile);
	const compiled = path.resolve(extensionDirectory, "../market-lab/index.js");
	if (existsSync(compiled)) return compiled;
	const source = path.resolve(extensionDirectory, "../market-lab/index.ts");
	if (existsSync(source)) return source;
	throw new Error("Unable to locate the bundled market-lab extension");
}

export function resolveChildOrdersExtension(fromFile: string): string {
	const extensionDirectory = path.dirname(fromFile);
	const compiled = path.join(extensionDirectory, "child-orders.js");
	if (existsSync(compiled)) return compiled;
	const source = path.join(extensionDirectory, "child-orders.ts");
	if (existsSync(source)) return source;
	throw new Error("Unable to locate the bundled subagent order-proposal extension");
}

function emptyChildResult(error: string, aborted = false): IsolatedChildResult {
	return {
		exitCode: 1,
		messages: [],
		proposals: [],
		stderr: "",
		aborted,
		timedOut: false,
		outputTooLarge: false,
		error,
	};
}

export function childEnvironment(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const name of [
		"HOME",
		"PATH",
		"TMPDIR",
		"TMP",
		"TEMP",
		"LANG",
		"LC_ALL",
		"LC_CTYPE",
		"TZ",
		"SSL_CERT_FILE",
		"SSL_CERT_DIR",
	]) {
		if (process.env[name] !== undefined) env[name] = process.env[name];
	}
	const dataRoot = process.env.TI_DATA_DIR?.trim() || path.join(homedir(), ".ti-trader");
	env.PI_CODING_AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? path.join(dataRoot, "agent");
	return env;
}

function killChild(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
	if (child.pid !== undefined && process.platform !== "win32") {
		try {
			process.kill(-child.pid, signal);
			return;
		} catch {
			// The child may not have created its process group yet.
		}
	}
	child.kill(signal);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function parseContent(value: unknown): IsolatedChildContent[] {
	if (!Array.isArray(value)) return [];
	const parts: IsolatedChildContent[] = [];
	for (const item of value) {
		const part = asRecord(item);
		if (!part) continue;
		if (part.type === "text" && typeof part.text === "string") {
			parts.push({ type: "text", text: part.text });
			continue;
		}
		if (part.type === "toolCall" && typeof part.name === "string") {
			const args = asRecord(part.arguments) ?? asRecord(part.args) ?? {};
			parts.push({ type: "toolCall", name: part.name, arguments: args });
		}
	}
	return parts;
}

function parseUsage(value: unknown): IsolatedChildMessage["usage"] {
	const usage = asRecord(value);
	if (!usage) return undefined;
	const cost = asRecord(usage.cost);
	return {
		input: typeof usage.input === "number" ? usage.input : undefined,
		output: typeof usage.output === "number" ? usage.output : undefined,
		cacheRead: typeof usage.cacheRead === "number" ? usage.cacheRead : undefined,
		cacheWrite: typeof usage.cacheWrite === "number" ? usage.cacheWrite : undefined,
		totalTokens: typeof usage.totalTokens === "number" ? usage.totalTokens : undefined,
		cost: cost && typeof cost.total === "number" ? { total: cost.total } : undefined,
	};
}

function parseMessage(value: unknown): IsolatedChildMessage | undefined {
	const message = asRecord(value);
	if (!message || typeof message.role !== "string") return undefined;
	return {
		role: message.role,
		content: parseContent(message.content),
		model: typeof message.model === "string" ? message.model : undefined,
		stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
		errorMessage: typeof message.errorMessage === "string" ? message.errorMessage : undefined,
		usage: parseUsage(message.usage),
	};
}

function parseEvent(line: string): IsolatedChildEvent | undefined {
	if (!line.trim()) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	const event = asRecord(parsed);
	if (!event) return undefined;
	if (event.type === "tool_execution_end" && typeof event.toolName === "string") {
		return {
			type: "tool_execution_end",
			toolName: event.toolName,
			isError: event.isError === true,
			result: event.result,
		};
	}
	if (event.type !== "message_end" && event.type !== "tool_result_end") return undefined;
	const message = parseMessage(event.message);
	if (!message) return undefined;
	return { type: event.type, message };
}

function writePromptFile(agentLabel: string, prompt: string): { dir: string; filePath: string } {
	const dir = mkdtempSync(path.join(tmpdir(), "ti-subagent-"));
	const safeName = agentLabel.replace(/[^\w.-]+/g, "_") || "agent";
	const filePath = path.join(dir, `prompt-${safeName}.md`);
	writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	return { dir, filePath };
}

export async function runIsolatedChild(request: IsolatedChildRequest): Promise<IsolatedChildResult> {
	if (request.signal.aborted) return emptyChildResult("Subagent was cancelled", true);
	if (request.tools.length === 0) return emptyChildResult("Subagent tool allowlist is empty");

	const timeoutMs = request.timeoutMs ?? CHILD_TIMEOUT_MS;
	const maxOutputBytes = request.maxOutputBytes ?? MAX_OUTPUT_BYTES;
	const tmp = writePromptFile("system", request.systemPrompt);
	const args = [
		resolveCodingAgentCli(),
		"--mode",
		"json",
		"--print",
		"--no-session",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--no-context-files",
		"--no-builtin-tools",
		"--system-prompt",
		tmp.filePath,
	];
	for (const extension of request.extensionPaths) {
		args.push("--extension", extension);
	}
	args.push("--tools", request.tools.join(","));
	if (request.model) args.push("--model", request.model);
	if (request.thinkingLevel) args.push("--thinking", request.thinkingLevel);
	args.push("--", request.prompt);

	const messages: IsolatedChildMessage[] = [];
	const proposals: ProposedOrder[] = [];
	let stderr = "";
	let outputBytes = 0;
	let termination: Termination | undefined;
	let spawnError: Error | undefined;

	try {
		const exitCode = await new Promise<number>((resolve, reject) => {
			const child = spawn(process.execPath, args, {
				cwd: request.cwd,
				stdio: ["ignore", "pipe", "pipe"],
				shell: false,
				detached: process.platform !== "win32",
				env: childEnvironment(),
			});
			let buffer = "";
			let settled = false;
			let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

			const finish = (callback: () => void): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				if (forceKillTimer) clearTimeout(forceKillTimer);
				request.signal.removeEventListener("abort", abort);
				callback();
			};
			const terminate = (reason: Termination): void => {
				if (termination) return;
				termination = reason;
				killChild(child, "SIGTERM");
				forceKillTimer = setTimeout(() => killChild(child, "SIGKILL"), FORCE_KILL_DELAY_MS);
				forceKillTimer.unref?.();
			};
			const timeout = setTimeout(() => terminate("timeout"), timeoutMs);
			timeout.unref?.();
			const abort = (): void => terminate("abort");
			request.signal.addEventListener("abort", abort, { once: true });
			if (request.signal.aborted) abort();

			const processLine = (line: string): void => {
				const event = parseEvent(line);
				if (!event) return;
				if (event.type === "tool_execution_end") {
					if (event.toolName === PROPOSE_ORDER_TOOL && !event.isError) {
						const proposal = extractProposedOrder(event.result);
						if (proposal) proposals.push(proposal);
					}
				} else {
					messages.push(event.message);
				}
				request.onEvent?.(event);
			};

			const append = (target: "output" | "error", chunk: Buffer): void => {
				if (termination) return;
				outputBytes += chunk.byteLength;
				if (outputBytes > maxOutputBytes) {
					terminate("output");
					return;
				}
				if (target === "error") {
					stderr += chunk.toString();
					return;
				}
				buffer += chunk.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			};

			child.stdout?.on("data", (chunk: Buffer) => append("output", chunk));
			child.stderr?.on("data", (chunk: Buffer) => append("error", chunk));
			child.on("error", (cause) => {
				spawnError = cause instanceof Error ? cause : new Error(String(cause));
				finish(() => reject(spawnError));
			});
			child.on("close", (code) => {
				finish(() => {
					if (buffer.trim()) processLine(buffer);
					resolve(code ?? 0);
				});
			});
		});

		const error =
			termination === "abort"
				? "Subagent was cancelled"
				: termination === "timeout"
					? "Subagent timed out"
					: termination === "output"
						? "Subagent output was too large"
						: undefined;
		return {
			exitCode: error ? 1 : exitCode,
			messages,
			proposals,
			stderr,
			aborted: termination === "abort",
			timedOut: termination === "timeout",
			outputTooLarge: termination === "output",
			error,
		};
	} finally {
		try {
			rmSync(tmp.dir, { recursive: true, force: true });
		} catch {
			// Temp prompt files are best-effort cleanup.
		}
	}
}

export function assistantText(messages: IsolatedChildMessage[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type === "text" && part.text.trim()) return part.text;
		}
	}
	return "";
}
