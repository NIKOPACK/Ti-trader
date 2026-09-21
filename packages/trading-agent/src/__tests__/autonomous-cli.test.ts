import { execFile, fork } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { writeJsonFileDurable } from "@nikopack/ti-trading-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AutonomousStore } from "../autonomous/state.ts";
import { createFileMonitoringStore } from "../monitoring-state.ts";
import { DEFAULT_CONFIG } from "../state.ts";

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const loader = require.resolve("tsx");
const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
const control = fileURLToPath(new URL("./fixtures/autonomous-control.ts", import.meta.url));
const tsconfig = fileURLToPath(new URL("../../../../tsconfig.json", import.meta.url));
let directory: string;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "ti-autonomous-cli-"));
});
afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

function environment(): NodeJS.ProcessEnv {
	return { PATH: process.env.PATH, HOME: directory, TI_DATA_DIR: directory, TSX_TSCONFIG_PATH: tsconfig };
}

describe("headless CLI and worker process boundaries", () => {
	it("refuses mismatched TUI startup and autonomous live mode before loading credentials or contacting a venue", async () => {
		const agentDir = join(directory, "agent");
		writeJsonFileDurable(join(agentDir, "trading.json"), {
			...DEFAULT_CONFIG,
			mode: "live",
			exchange: "binance",
			orderApproval: "unattended",
			risk: {
				...DEFAULT_CONFIG.risk,
				account: {
					maxGrossExposure: 100,
					maxNetExposure: 100,
					maxAssetExposure: 100,
					maxLeverage: 1,
					maxMarginUsagePct: 50,
					maxDailyLoss: 10,
					maxDrawdown: 20,
					maxDataAgeMs: 10000,
					maxPriceDeviationPct: 2,
					minDepthRatio: 1,
					minLiquidationDistancePct: 5,
					minProtectionCoveragePct: 95,
					maxStopDistancePct: 10,
					cancelEntriesOnBreach: true,
					reduceOnBreach: true,
				},
			},
		});
		writeJsonFileDurable(join(agentDir, "autonomous.json"), {
			enabled: true,
			mode: "live",
			exchange: "binance",
			marketType: "spot",
			quoteCurrency: "USDT",
			objective: "Must not run",
			provider: "fixture",
			model: "fixture",
			services: [],
			pollIntervalMs: 100,
			modelTimeoutMs: 1000,
			serviceTimeoutMs: 1000,
			maxAttempts: 1,
			retryBaseMs: 100,
			retryMaxMs: 100,
			protectionAttempts: 1,
		});
		await expect(
			execute(process.execPath, ["--import", loader, control, "start"], {
				env: environment(),
				timeout: 10000,
			}),
		).rejects.toThrow("Autonomous configuration differs from the active TUI account: mode");
		expect(existsSync(join(agentDir, "autonomous.log"))).toBe(false);
		await expect(
			execute(process.execPath, ["--import", loader, cli, "--autonomous", "run"], {
				env: environment(),
				timeout: 10000,
			}),
		).rejects.toThrow("Live autonomous mode is unavailable");
	});
	it("fails fast on missing or incomplete setup without forking a daemon", async () => {
		const agentDir = join(directory, "agent");
		const run = () =>
			execute(process.execPath, ["--import", loader, cli, "--autonomous", "start"], {
				env: environment(),
				timeout: 10000,
			});
		await expect(run()).rejects.toThrow("Autonomous is not configured");
		const account = {
			maxGrossExposure: 100,
			maxNetExposure: 100,
			maxAssetExposure: 100,
			maxLeverage: 1,
			maxMarginUsagePct: 50,
			maxDailyLoss: 10,
			maxDrawdown: 20,
			maxDataAgeMs: 10000,
			maxPriceDeviationPct: 2,
			minDepthRatio: 1,
			minLiquidationDistancePct: 5,
			minProtectionCoveragePct: 95,
			maxStopDistancePct: 10,
			cancelEntriesOnBreach: true,
			reduceOnBreach: true,
		};
		const autonomous = {
			enabled: true,
			mode: "paper",
			exchange: "okx",
			marketType: "spot",
			quoteCurrency: "USDT",
			objective: "Fixture",
			provider: "fixture",
			model: "fixture",
			services: [],
			pollIntervalMs: 100,
			modelTimeoutMs: 1000,
			serviceTimeoutMs: 1000,
			maxAttempts: 1,
			retryBaseMs: 100,
			retryMaxMs: 100,
			protectionAttempts: 1,
		};
		writeJsonFileDurable(join(agentDir, "trading.json"), { ...DEFAULT_CONFIG, orderApproval: "confirm" });
		writeJsonFileDurable(join(agentDir, "autonomous.json"), autonomous);
		await expect(run()).rejects.toThrow("risk.account");
		writeJsonFileDurable(join(agentDir, "trading.json"), {
			...DEFAULT_CONFIG,
			orderApproval: "confirm",
			risk: { ...DEFAULT_CONFIG.risk, account },
		});
		await expect(run()).rejects.toThrow('orderApproval: "unattended"');
		writeJsonFileDurable(join(agentDir, "autonomous.json"), { ...autonomous, exchange: "binance" });
		writeJsonFileDurable(join(agentDir, "trading.json"), {
			...DEFAULT_CONFIG,
			risk: { ...DEFAULT_CONFIG.risk, account },
		});
		await expect(run()).rejects.toThrow("does not match trading.json");
		expect(existsSync(join(agentDir, "autonomous.log"))).toBe(false);
		expect(existsSync(join(agentDir, "autonomous-process.json"))).toBe(false);
	}, 30000);

	it("reports status and persists pause, resume and stop without loading a model or exchange", async () => {
		const agentDir = join(directory, "agent");
		const scope = {
			mode: "paper" as const,
			exchange: "binance",
			marketType: "spot" as const,
			quoteCurrency: "USDT",
			accountId: "fixture",
			positionMode: "one-way" as const,
		};
		writeJsonFileDurable(join(agentDir, "autonomous-process.json"), {
			version: 1,
			scope,
			pid: process.pid,
			startedAt: Date.now(),
		});
		const store = new AutonomousStore(createFileMonitoringStore(join(agentDir, "monitoring-state.json")), scope);
		store.mutate((state) => {
			state.control = "running";
		});
		const run = (action: string) =>
			execute(process.execPath, ["--import", loader, cli, "--autonomous", action], {
				env: environment(),
				timeout: 10000,
			});
		const status = await run("status");
		expect(JSON.parse(status.stdout)).toMatchObject({ control: "running", processAlive: true });
		const callbackStatus = await execute(process.execPath, ["--import", loader, control, "status"], {
			env: environment(),
			timeout: 10000,
		});
		expect(JSON.parse(callbackStatus.stdout)).toMatchObject({ status: { control: "running", processAlive: true } });
		await run("pause");
		expect(store.read().control).toBe("paused");
		const callbackResume = await execute(process.execPath, ["--import", loader, control, "resume"], {
			env: environment(),
			timeout: 10000,
		});
		expect(JSON.parse(callbackResume.stdout).output).toContain("Model resumed");
		expect(store.read().control).toBe("running");
		await run("resume");
		expect(store.read().control).toBe("running");
		await run("stop");
		expect(store.read().control).toBe("stopped");
	}, 25000);

	it.each(["paper", "live"] as const)(
		"rejects controls of a different %s account without modifying state",
		async (mode) => {
			const agentDir = join(directory, "agent");
			const scope = {
				mode,
				exchange: "binance",
				marketType: "spot" as const,
				quoteCurrency: "USDT",
				positionMode: "one-way" as const,
				accountId: mode === "paper" ? "other" : "fixture",
			};
			writeJsonFileDurable(join(agentDir, "autonomous-process.json"), {
				version: 1,
				scope,
				pid: process.pid,
				startedAt: Date.now(),
			});
			const store = new AutonomousStore(createFileMonitoringStore(join(agentDir, "monitoring-state.json")), scope);
			store.mutate((state) => {
				state.control = "running";
			});
			const before = store.read();
			for (const action of ["status", "pause", "resume", "stop"]) {
				await expect(
					execute(process.execPath, ["--import", loader, control, action], {
						env: environment(),
						timeout: 10000,
					}),
				).rejects.toThrow("Autonomous account differs");
			}
			expect(store.read()).toEqual(before);
			expect(existsSync(join(agentDir, "trading-state.json"))).toBe(false);
		},
		25000,
	);

	it("boots the actual isolated worker and rejects an unavailable model before inference", async () => {
		const worker = fileURLToPath(new URL("../autonomous/worker.ts", import.meta.url));
		const child = fork(worker, [], {
			cwd: directory,
			execArgv: ["--import", loader],
			env: environment(),
			stdio: ["ignore", "ignore", "ignore", "ipc"],
		});
		const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		try {
			const message = new Promise<unknown>((resolve, reject) => {
				child.once("message", resolve);
				child.once("error", reject);
				child.once("exit", (code) => reject(new Error(`Worker exited before IPC response: ${code}`)));
			});
			child.send({
				kind: "start",
				request: {
					agentDir: directory,
					context: "No inference may occur.",
					tools: [],
					config: {
						enabled: true,
						mode: "paper",
						exchange: "binance",
						marketType: "spot",
						quoteCurrency: "USDT",
						objective: "Fixture",
						provider: "nonexistent-fixture-provider",
						model: "nonexistent-fixture-model",
						pollIntervalMs: 100,
						modelTimeoutMs: 1000,
						serviceTimeoutMs: 500,
						maxAttempts: 1,
						retryBaseMs: 100,
						retryMaxMs: 100,
						protectionAttempts: 1,
						services: [],
					},
				},
			});
			expect(await message).toMatchObject({ kind: "error" });
		} finally {
			child.kill("SIGKILL");
			await exited;
		}
	}, 10000);
});
