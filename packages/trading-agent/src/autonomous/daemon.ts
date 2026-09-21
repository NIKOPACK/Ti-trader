import { fork } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { join } from "node:path";
import {
	acquireFileLock,
	type ExecutionScope,
	readJsonFile,
	releaseFileLock,
	superviseAccountRisk,
	validateAccountRiskLimits,
	writeJsonFileDurable,
} from "@nikopack/ti-trading-engine";
import { AGENT_DIR, ensureAgentDir } from "../config.ts";
import { TradingRuntime } from "../context.ts";
import {
	createFileMonitoringStore,
	findMonitoringScope,
	monitoringScopeKey,
	validateMonitoringScope,
} from "../monitoring-state.ts";
import { loadTradingConfig, loadTradingState } from "../state.ts";
import { type AutonomousConfig, loadAutonomousConfig } from "./config.ts";
import { ModelProcess } from "./model-process.ts";
import { AutonomousRuntime, failureCode, withDeadline } from "./runtime.ts";
import { AutonomousStore } from "./state.ts";
import { AutonomousTools } from "./tools.ts";

export type AutonomousCommand = "start" | "run" | "status" | "pause" | "resume" | "stop";
interface DaemonManifest {
	version: 1;
	scope: ExecutionScope;
	pid: number;
	startedAt: number;
}
const manifestPath = join(AGENT_DIR, "autonomous-process.json");
const expectedScopeEnvironmentKey = "TI_AUTONOMOUS_EXPECTED_SCOPE";

export function assertAutonomousScope(expected: ExecutionScope, actual: ExecutionScope): void {
	if (monitoringScopeKey(expected) !== monitoringScopeKey(actual))
		throw new Error(
			"Autonomous account differs from the active TUI account; switch to the matching account before controlling it",
		);
}

function readStatus(existing: DaemonManifest, state: AutonomousStore) {
	const current = state.read();
	const risk = loadTradingState();
	return {
		mode: existing.scope.mode,
		exchange: existing.scope.exchange,
		marketType: existing.scope.marketType,
		pid: existing.pid,
		processAlive: processExists(existing.pid),
		control: current.control,
		heartbeat: current.heartbeat,
		pendingEvents: current.events.length,
		coalescedEvents: current.coalescedEvents ?? 0,
		droppedEvents: current.droppedEvents ?? 0,
		currentDecision: current.decision,
		wakes: findMonitoringScope(state.store.read(), existing.scope)?.triggers.filter((trigger) =>
			current.triggerIds.includes(trigger.definition.id),
		),
		lastDecision: current.summaries.at(-1),
		failures: current.failures.slice(-10),
		risk: risk.accountRisk,
	};
}

export type AutonomousStatus = ReturnType<typeof readStatus>;
export interface AutonomousCommandOptions {
	expectedScope?: ExecutionScope;
	output?: (message: string) => void;
	onStatus?: (status: AutonomousStatus) => void;
}

/** A manifest file counts even when malformed: it proves setup ran before. */
export function hasAutonomousManifest(): boolean {
	try {
		return manifest() !== undefined;
	} catch {
		return existsSync(manifestPath);
	}
}

function manifest(): DaemonManifest | undefined {
	const value = readJsonFile(manifestPath);
	if (value === undefined) return undefined;
	if (
		!value ||
		typeof value !== "object" ||
		!("scope" in value) ||
		!("pid" in value) ||
		!Number.isSafeInteger(value.pid) ||
		Number(value.pid) <= 0 ||
		!("version" in value) ||
		value.version !== 1
	)
		throw new Error("Invalid autonomous process manifest");
	validateMonitoringScope(value.scope);
	return value as DaemonManifest;
}
function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return false;
		throw error;
	}
}

export async function autonomousCommand(
	command: AutonomousCommand,
	options: AutonomousCommandOptions = {},
): Promise<void> {
	ensureAgentDir();
	const output = options.output ?? console.log;
	if (command === "run") {
		await runDaemon();
		return;
	}
	const existing = manifest();
	if (command === "start") {
		let config: AutonomousConfig;
		try {
			config = loadAutonomousConfig();
		} catch {
			throw new Error("Autonomous is not configured; run /autonomous in the Ti TUI to complete setup");
		}
		const tradingConfig = loadTradingConfig();
		try {
			validateAccountRiskLimits(tradingConfig.risk.account);
		} catch (error) {
			throw new Error(
				`${error instanceof Error ? error.message : String(error)}; run /autonomous to apply hard risk limits`,
			);
		}
		if (tradingConfig.orderApproval !== "unattended")
			throw new Error(
				'Autonomous trading requires orderApproval: "unattended" in trading.json; run /autonomous to apply it',
			);
		for (const key of ["mode", "exchange", "marketType", "quoteCurrency"] as const)
			if (config[key] !== tradingConfig[key])
				throw new Error(`autonomous.json ${key} does not match trading.json; run /autonomous to repair it`);
		if (options.expectedScope) {
			validateMonitoringScope(options.expectedScope);
			for (const key of ["mode", "exchange", "marketType", "quoteCurrency"] as const)
				if (config[key] !== options.expectedScope[key] || tradingConfig[key] !== options.expectedScope[key])
					throw new Error(`Autonomous configuration differs from the active TUI account: ${key}`);
			if (tradingConfig.positionMode !== options.expectedScope.positionMode)
				throw new Error("Autonomous position mode differs from the active TUI account");
		}
		if (config.mode === "live")
			throw new Error(
				"Live autonomous mode is unavailable: current adapters lack complete external-flow, fee and funding evidence required by account hard risk",
			);
		if (existing && processExists(existing.pid)) throw new Error("Autonomous process is already running");
		const logPath = join(AGENT_DIR, "autonomous.log");
		const log = openSync(logPath, "a", 0o600);
		const child = fork(process.argv[1], ["--autonomous", "run"], {
			detached: true,
			stdio: ["ignore", log, log, "ipc"],
			env: {
				...process.env,
				[expectedScopeEnvironmentKey]: options.expectedScope ? JSON.stringify(options.expectedScope) : undefined,
			},
		});
		closeSync(log);
		try {
			await withDeadline(
				new Promise<void>((resolve, reject) => {
					child.once("error", reject);
					child.once("exit", (code) =>
						reject(new Error(`Autonomous startup failed (${code}); inspect ${logPath}`)),
					);
					child.once("message", (message: unknown) => {
						if (message && typeof message === "object" && "ready" in message && message.ready === true) resolve();
						else reject(new Error("Autonomous startup did not acknowledge readiness"));
					});
				}),
				config.serviceTimeoutMs * config.maxAttempts,
				"autonomous-startup",
			);
		} catch (error) {
			child.kill("SIGTERM");
			throw error;
		} finally {
			if (child.connected) child.disconnect();
			child.unref();
		}
		output(`Autonomous runtime started. pid=${child.pid} mode=${config.mode} log=${logPath}`);
		return;
	}
	if (!existing) throw new Error("No autonomous runtime has been initialized");
	if (options.expectedScope) assertAutonomousScope(options.expectedScope, existing.scope);
	const state = new AutonomousStore(createFileMonitoringStore(), existing.scope);
	if (command === "status") {
		const status = readStatus(existing, state);
		if (options.onStatus) options.onStatus(status);
		else output(JSON.stringify(status, null, 2));
		return;
	}
	if (command === "pause") {
		state.mutate((state) => {
			state.control = "paused";
		});
		output(
			"Model paused. Independent risk monitoring and existing protection remain active. No implicit cancellation or liquidation.",
		);
	} else if (command === "resume") {
		if (!processExists(existing.pid)) throw new Error("Daemon is not running; start it before resuming");
		state.mutate((state) => {
			state.control = "running";
		});
		state.enqueue({
			id: `resume-${Date.now()}`,
			kind: "start",
			at: Date.now(),
			message: "Operator resumed model decisions. Re-evaluate authoritative account and persistent risk state.",
		});
		output("Model resumed. Persistent loss trips and unresolved execution blocks are unchanged.");
	} else {
		state.mutate((state) => {
			state.control = "stopped";
		});
		output(
			"Stop requested. Model and daemon will stop; no orders are cancelled and no positions are closed. Exchange-native protection remains.",
		);
	}
}

export async function runDaemon(): Promise<void> {
	let expectedScope: ExecutionScope | undefined;
	const capturedScope = process.env[expectedScopeEnvironmentKey];
	if (capturedScope !== undefined) {
		const parsed: unknown = JSON.parse(capturedScope);
		validateMonitoringScope(parsed);
		if (parsed.positionMode === undefined) throw new Error("Expected autonomous position mode is missing");
		expectedScope = { ...parsed, positionMode: parsed.positionMode };
	}
	const config = loadAutonomousConfig();
	const tradingConfig = loadTradingConfig();
	for (const key of ["mode", "exchange", "marketType", "quoteCurrency"] as const) {
		if (tradingConfig[key] !== config[key]) throw new Error(`Autonomous scope does not match trading.json: ${key}`);
	}
	validateAccountRiskLimits(tradingConfig.risk.account);
	if (tradingConfig.orderApproval !== "unattended")
		throw new Error("Autonomous trading requires explicit orderApproval: unattended");
	// Existing live adapters do not expose complete cash-flow and fee evidence.
	// Refuse before loading exchange credentials rather than running with a fake loss budget.
	if (config.mode === "live")
		throw new Error(
			"Live autonomous mode is unavailable: current adapters lack complete external-flow, fee and funding evidence required by account hard risk",
		);
	const lock = await acquireFileLock(join(AGENT_DIR, "autonomous-daemon.lock"), {
		staleMs: Infinity,
		reclaimDeadOwner: true,
		timeoutMs: config.serviceTimeoutMs,
	});
	let trading: TradingRuntime | undefined;
	let monitor: TradingRuntime | undefined;
	let runtime: AutonomousRuntime | undefined;
	const abort = new AbortController();
	const stop = (): void => abort.abort(new Error("Daemon termination requested"));
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
	try {
		trading = await TradingRuntime.init();
		monitor = await TradingRuntime.init();
		const scope = trading.getExecutionScope();
		if (expectedScope) assertAutonomousScope(expectedScope, scope);
		const state = new AutonomousStore(createFileMonitoringStore(), scope);
		// Construction no longer materializes persisted state, so create this scope before
		// execution recovery reads it.
		state.mutate((current) => {
			current.heartbeat = Date.now();
		});
		const model = new ModelProcess(config, AGENT_DIR, new AutonomousTools(trading.tradingEngine, state, config));
		const monitorEngine = monitor.tradingEngine;
		runtime = new AutonomousRuntime({
			state,
			config,
			model,
			supervise: () =>
				superviseAccountRisk(monitorEngine, {
					timeoutMs: config.serviceTimeoutMs,
					protectionAttempts: config.protectionAttempts,
				}),
			ticker: (symbol) => monitorEngine.getTicker(symbol),
			block: (reason) => monitorEngine.accountRisk!.block(reason),
			recover: async () => {
				await trading!.recoverExecutions();
				await withDeadline(
					monitorEngine.accountRisk!.inspect(),
					config.serviceTimeoutMs,
					"startup-account-observation",
				);
			},
		});
		await runtime.initialize();
		const previous = state.read();
		// An explicit stop can be restarted. A persisted pause is never cleared by startup.
		state.mutate((state) => {
			if (state.control === "stopped") state.control = "running";
			state.pid = process.pid;
			state.heartbeat = Date.now();
		});
		if (!previous.decision) runtime.startEvent();
		writeJsonFileDurable(manifestPath, { version: 1, scope, pid: process.pid, startedAt: Date.now() }, 0o600);
		process.send?.({ ready: true });
		await runtime.run(abort.signal);
	} catch (error) {
		console.error(`[autonomous] ${failureCode(error)}`);
		throw new Error(
			`Autonomous runtime failed: ${failureCode(error)}; inspect persisted status and execution records`,
		);
	} finally {
		process.removeListener("SIGTERM", stop);
		process.removeListener("SIGINT", stop);
		try {
			await runtime?.stop();
		} finally {
			try {
				await withDeadline(
					Promise.all([trading?.close(), monitor?.close()]),
					config.serviceTimeoutMs,
					"trading-shutdown",
				);
			} finally {
				releaseFileLock(lock);
			}
		}
	}
}
