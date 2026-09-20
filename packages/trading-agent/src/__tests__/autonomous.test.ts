import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RiskSupervisionReport } from "@nikopack/ti-trading-engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseTradingArgs } from "../args.ts";
import { type AutonomousConfig, validateAutonomousConfig } from "../autonomous/config.ts";
import { modelWorkerEnvironment, WORKER_FORCE_KILL_MS } from "../autonomous/model-process.ts";
import { type AutonomousModel, AutonomousRuntime } from "../autonomous/runtime.ts";
import { AutonomousStore, enqueueAutonomousEvent } from "../autonomous/state.ts";
import {
	createFileMonitoringStore,
	createMemoryMonitoringStore,
	type MonitoringScope,
	type MonitoringStore,
} from "../monitoring-state.ts";

const config: AutonomousConfig = {
	enabled: true,
	mode: "paper",
	exchange: "binance",
	marketType: "spot",
	quoteCurrency: "USDT",
	objective: "Decide freely; waiting is valid",
	provider: "fixture",
	model: "fixture",
	pollIntervalMs: 100,
	modelTimeoutMs: 1000,
	serviceTimeoutMs: 500,
	maxAttempts: 2,
	retryBaseMs: 100,
	retryMaxMs: 500,
	protectionAttempts: 2,
	services: [],
};
const scope: MonitoringScope = {
	mode: "paper",
	exchange: "binance",
	marketType: "spot",
	quoteCurrency: "USDT",
	accountId: "fixture",
};
const initialTime = Date.parse("2026-09-14T00:00:00Z");
afterEach(() => vi.useRealTimers());

function fixture(model?: AutonomousModel) {
	let time = initialTime;
	const state = new AutonomousStore(createMemoryMonitoringStore(), scope, () => time);
	state.mutate((state) => {
		state.control = "running";
	});
	const run = vi.fn(async () => "Wait; no trade.");
	const stop = vi.fn(async () => {});
	const supervise = vi.fn(async (): Promise<RiskSupervisionReport> => ({ at: time, reasons: [], actions: [] }));
	const block = vi.fn();
	const recover = vi.fn(async () => {});
	const runtime = new AutonomousRuntime({
		state,
		config,
		model: model ?? { run, stop },
		supervise,
		ticker: async (symbol) => {
			if (symbol === "MISSING/USDT") throw new Error("fixture disconnected");
			return { last: 100, timestamp: time };
		},
		block,
		recover,
		now: () => time,
	});
	return {
		state,
		runtime,
		run,
		stop,
		supervise,
		block,
		recover,
		advance: (ms: number) => {
			time += ms;
		},
	};
}
async function flush(): Promise<void> {
	for (let index = 0; index < 15; index++) await Promise.resolve();
}

describe("headless autonomous runtime", () => {
	it("retains historical risk evidence and results after consuming the event", async () => {
		const f = fixture();
		await f.runtime.initialize();
		f.supervise.mockResolvedValueOnce({
			at: initialTime,
			reasons: ["maxDailyLoss"],
			actions: [{ action: "reduce", reference: "BTC/USDT", status: "completed" }],
			snapshot: {
				source: "paper:fixture",
				epoch: "one",
				observedAt: initialTime,
				oldestPriceAt: initialTime,
				equity: 900,
				netExternalFlows: 1000,
				marginUsed: 0,
				positions: [],
				orders: [],
				prices: {},
				limitations: [],
			},
		});
		await f.runtime.tick();
		await flush();
		const restarted = new AutonomousStore(f.state.store, scope);
		expect(restarted.read().summaries[0].evidence).toMatchObject({
			source: "paper:fixture",
			equity: 900,
			actions: [{ action: "reduce", reference: "BTC/USDT", status: "completed" }],
		});
		await f.runtime.stop();
	});
	it("fires independent timers even when another wake's market observation fails", async () => {
		const f = fixture();
		await f.runtime.initialize();
		f.state.schedule({
			id: "bad-price",
			name: "Unavailable market",
			when: { kind: "compare", fact: { key: "price:MISSING/USDT" }, operator: "gt", value: 10 },
			// biome-ignore lint/suspicious/noThenProperty: TriggerDefinition action.
			then: { kind: "wake_agent", message: "Unavailable price" },
		});
		f.state.schedule({
			id: "due",
			name: "Timer",
			when: { kind: "time", at: new Date(initialTime).toISOString() },
			// biome-ignore lint/suspicious/noThenProperty: TriggerDefinition action.
			then: { kind: "wake_agent", message: "Review now" },
		});
		await f.runtime.tick();
		await flush();
		expect(f.run).toHaveBeenCalledTimes(1);
		expect(f.state.read().summaries[0].text).toBe("Wait; no trade.");
		expect(f.state.read().failures[0].source).toBe("wake:price:MISSING/USDT");
		await f.runtime.stop();
	});
	it("requires explicit CLI activation and leaves Paper/interactive defaults unchanged", () => {
		expect(parseTradingArgs([]).autonomous).toBeUndefined();
		expect(parseTradingArgs([]).mode).toBeUndefined();
		expect(parseTradingArgs(["--autonomous", "start"]).autonomous).toBe("start");
		expect(() => parseTradingArgs(["--autonomous", "start", "--extension", "/tmp/untrusted.ts"])).toThrow();
		expect(() => validateAutonomousConfig({ ...config, enabled: false })).toThrow("enabled");
		expect(() => validateAutonomousConfig({ ...config, modelTimeoutMs: 3_000_000_000 })).toThrow("timer range");
		expect(WORKER_FORCE_KILL_MS).toBeGreaterThan(2000);
		expect(
			modelWorkerEnvironment({
				BINANCE_API_KEY: "fixture-secret",
				BINANCE_SECRET: "fixture-secret",
				OPENAI_API_KEY: "fixture-model-token",
				PATH: "/bin",
			}),
		).toEqual({ OPENAI_API_KEY: "fixture-model-token", PATH: "/bin" });
	});
	it("runs without UI, deduplicates events and stays idle without model work", async () => {
		const f = fixture();
		await f.runtime.initialize();
		const event = { id: "stable-event", kind: "start" as const, at: initialTime, message: "Research or wait" };
		f.state.enqueue(event);
		f.state.enqueue(event);
		await f.runtime.tick();
		await flush();
		expect(f.run).toHaveBeenCalledTimes(1);
		expect(f.recover).toHaveBeenCalledTimes(1);
		for (let i = 0; i < 5; i++) {
			f.advance(100);
			await f.runtime.tick();
		}
		expect(f.run).toHaveBeenCalledTimes(1);
		expect(f.state.read().summaries[0].text).toBe("Wait; no trade.");
		await f.runtime.stop();
	});
	it("allows model-created, replaced and cancelled time/price wakes", async () => {
		const f = fixture();
		await f.runtime.initialize();
		const first = f.state.schedule({
			id: "later",
			name: "later",
			when: { kind: "time", at: new Date(initialTime + 200).toISOString() },
			// biome-ignore lint/suspicious/noThenProperty: TriggerDefinition action.
			then: { kind: "wake_agent", message: "Review later" },
			policy: { mode: "once" },
		});
		f.state.schedule({
			id: "cancelled",
			name: "cancelled",
			when: { kind: "time", at: new Date(initialTime + 100).toISOString() },
			// biome-ignore lint/suspicious/noThenProperty: TriggerDefinition action.
			then: { kind: "wake_agent", message: "Never run" },
		});
		f.state.cancelWake("autonomous-cancelled");
		await f.runtime.tick();
		expect(f.run).not.toHaveBeenCalled();
		f.advance(200);
		await f.runtime.tick();
		await flush();
		expect(f.run).toHaveBeenCalledTimes(1);
		f.advance(200);
		await f.runtime.tick();
		expect(f.run).toHaveBeenCalledTimes(1);
		f.state.cancelWake(first);
		await f.runtime.stop();
	});
	it("keeps independent risk supervision running while the model is disconnected", async () => {
		vi.useFakeTimers();
		let resolveModel: ((value: string) => void) | undefined;
		const model: AutonomousModel = {
			run: vi.fn(
				() =>
					new Promise<string>((resolve) => {
						resolveModel = resolve;
					}),
			),
			stop: vi.fn(async () => {
				resolveModel?.("aborted");
			}),
		};
		const f = fixture(model);
		await f.runtime.initialize();
		f.runtime.startEvent();
		await f.runtime.tick();
		f.advance(100);
		await f.runtime.tick();
		f.advance(100);
		await f.runtime.tick();
		expect(f.supervise).toHaveBeenCalledTimes(3);
		expect(model.run).toHaveBeenCalledTimes(1);
		f.state.mutate((state) => {
			state.control = "stopped";
		});
		await f.runtime.tick();
		await f.runtime.stop();
		expect(model.stop).toHaveBeenCalled();
	});
	it("records timeouts and performs bounded backoff without retrying attempted mutations", async () => {
		vi.useFakeTimers();
		const f = fixture({
			run: async () => {
				throw new Error("provider rate limited 429");
			},
			stop: async () => {},
		});
		await f.runtime.initialize();
		f.runtime.startEvent();
		await f.runtime.tick();
		await flush();
		expect(f.state.read().decision?.attempts).toBe(1);
		await f.runtime.tick();
		expect(f.state.read().decision?.attempts).toBe(1);
		f.advance(100);
		await f.runtime.tick();
		await flush();
		expect(f.state.read().decision).toBeUndefined();
		expect(f.state.read().summaries.at(-1)?.outcome).toBe("failed");
		expect(f.state.read().failures[0].reason).toBe("rate-limited");
		await f.runtime.stop();
	});
	it("retains pause, queued events and decision progress in isolated files across restart", () => {
		const directory = mkdtempSync(join(tmpdir(), "ti-autonomous-test-"));
		try {
			const path = join(directory, "monitoring-state.json");
			const first = new AutonomousStore(createFileMonitoringStore(path), scope, () => initialTime);
			first.mutate((state) => {
				state.control = "running";
			});
			first.enqueue({ id: "restart-event", kind: "start", at: initialTime, message: "Act once" });
			const decision = first.beginDecision()!;
			first.mutate((state) => {
				state.control = "paused";
			});
			const second = new AutonomousStore(createFileMonitoringStore(path), scope, () => initialTime);
			expect(second.read().control).toBe("paused");
			expect(second.read().decision?.id).toBe(decision.id);
			expect(second.beginDecision()).toBeUndefined();
			second.enqueue({ id: "restart-event", kind: "start", at: initialTime, message: "duplicate" });
			expect(second.read().events).toHaveLength(0);
			const live = new AutonomousStore(
				createFileMonitoringStore(path),
				{ ...scope, mode: "live" },
				() => initialTime,
			);
			// Constructing a store for another account no longer fabricates persisted state.
			expect(() => live.read()).toThrow("Autonomous state missing");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
	it("does not replay a crashed model decision with already-attempted actions", async () => {
		const f = fixture();
		f.runtime.startEvent();
		const decision = f.state.beginDecision()!;
		f.state.mutate((state) => {
			state.decision!.actions.push({ id: "a".repeat(64), name: "submit_order", args: {}, status: "started" });
		});
		await f.runtime.initialize();
		expect(f.state.read().decision).toBeUndefined();
		expect(f.state.read().unfinishedActions?.[0].decisionId).toBe(decision.id);
		await f.runtime.tick();
		expect(f.run).not.toHaveBeenCalled();
		await f.runtime.stop();
	});
	it("continuously waits between events and shuts down through its abort signal", async () => {
		vi.useFakeTimers();
		const f = fixture();
		const abort = new AbortController();
		f.runtime.startEvent();
		const running = f.runtime.run(abort.signal);
		await flush();
		for (let index = 0; index < 3; index++) {
			f.advance(100);
			await vi.advanceTimersByTimeAsync(100);
		}
		expect(f.run).toHaveBeenCalledTimes(1);
		expect(f.supervise.mock.calls.length).toBeGreaterThanOrEqual(3);
		abort.abort();
		await running;
		expect(f.stop).toHaveBeenCalled();
	});
	it("bounds retries of a model that never responds and records timeout rather than success", async () => {
		vi.useFakeTimers();
		const f = fixture({ run: () => new Promise<string>(() => {}), stop: async () => {} });
		await f.runtime.initialize();
		f.runtime.startEvent();
		await f.runtime.tick();
		f.advance(1000);
		await vi.advanceTimersByTimeAsync(1000);
		expect(f.state.read().failures[0].reason).toBe("timeout");
		f.advance(100);
		await f.runtime.tick();
		f.advance(1000);
		await vi.advanceTimersByTimeAsync(1000);
		expect(f.state.read().decision).toBeUndefined();
		expect(f.state.read().summaries[0].outcome).toBe("failed");
		await f.runtime.stop();
	});
	it("coalesces repeated observation events instead of exhausting the backlog", async () => {
		vi.useFakeTimers();
		let resolveModel: ((value: string) => void) | undefined;
		const run = vi.fn(
			() =>
				new Promise<string>((resolve) => {
					resolveModel = resolve;
				}),
		);
		const f = fixture({
			run,
			stop: async () => {
				resolveModel?.("aborted");
			},
		});
		const report = (amount: number): RiskSupervisionReport => ({
			at: initialTime,
			reasons: [],
			actions: [],
			snapshot: {
				source: "paper:fixture",
				epoch: "one",
				observedAt: initialTime,
				oldestPriceAt: initialTime,
				equity: 1000,
				netExternalFlows: 1000,
				marginUsed: 0,
				positions: [{ symbol: "BTC/USDT", asset: "BTC", amount }],
				orders: [],
				prices: {},
				limitations: [],
			},
		});
		await f.runtime.initialize();
		f.supervise.mockResolvedValue(report(1));
		await f.runtime.tick();
		expect(f.state.read().events).toHaveLength(0);
		for (const amount of [2, 3, 4, 5]) {
			f.supervise.mockResolvedValueOnce(report(amount));
			f.advance(100);
			await f.runtime.tick();
		}
		const read = f.state.read();
		expect(read.events).toHaveLength(1);
		expect(read.events[0].kind).toBe("position");
		expect(read.coalescedEvents).toBe(2);
		expect(run).toHaveBeenCalledTimes(1);
		f.state.mutate((state) => {
			state.control = "stopped";
		});
		await f.runtime.tick();
		await f.runtime.stop();
	});
	it("counts dropped wake events instead of stopping supervision when the backlog is full", async () => {
		const f = fixture();
		await f.runtime.initialize();
		f.state.mutate((state) => {
			for (let index = 0; index < 256; index++)
				enqueueAutonomousEvent(state, {
					id: `backlog-${index}`,
					kind: "timer",
					at: initialTime,
					message: "Queued",
				});
		});
		expect(f.state.read().events).toHaveLength(256);
		f.supervise.mockResolvedValueOnce({ at: initialTime, reasons: ["maxDailyLoss"], actions: [] });
		await f.runtime.tick();
		const read = f.state.read();
		expect(read.droppedEvents).toBe(1);
		expect(read.events.length).toBeLessThanOrEqual(256);
		expect(read.control).toBe("running");
		expect(f.block).not.toHaveBeenCalled();
		expect(read.failures.at(-1)).toMatchObject({ source: "observation:risk", reason: "event-backlog-full" });
		await f.runtime.stop();
	});
	it("compacts consumed receipts while the minted sequence stays monotonic", () => {
		const store = new AutonomousStore(createMemoryMonitoringStore(), scope, () => initialTime);
		store.mutate((state) => {
			state.control = "running";
		});
		for (let index = 0; index < 120; index++) {
			store.enqueue({ id: `event-${index}`, kind: "start", at: initialTime, message: "Act or wait" });
			const decision = store.beginDecision();
			expect(decision).toBeDefined();
			store.finishDecision(decision!.id, "Waited", "completed");
		}
		const state = store.read();
		expect(state.sequence).toBe(120);
		expect(Object.keys(state.receipts).length).toBeLessThanOrEqual(101);
		expect(state.summaries).toHaveLength(100);
	});
	it("persists one observation and one wake transaction per idle tick", async () => {
		const directory = mkdtempSync(join(tmpdir(), "ti-autonomous-writes-"));
		try {
			const path = join(directory, "monitoring-state.json");
			const inner = createFileMonitoringStore(path);
			let transactions = 0;
			const counting: MonitoringStore = {
				read: inner.read,
				transact: (operation) => {
					transactions++;
					return inner.transact(operation);
				},
			};
			const state = new AutonomousStore(counting, scope, () => initialTime);
			expect(transactions).toBe(0);
			state.mutate((current) => {
				current.control = "running";
			});
			const runtime = new AutonomousRuntime({
				state,
				config,
				model: { run: vi.fn(async () => "Wait"), stop: vi.fn(async () => {}) },
				supervise: async () => ({ at: initialTime, reasons: [], actions: [] }),
				ticker: async () => ({ last: 100, timestamp: initialTime }),
				block: vi.fn(),
				recover: async () => {},
				now: () => initialTime,
			});
			await runtime.initialize();
			const started = transactions;
			await runtime.tick();
			expect(transactions - started).toBe(2);
			await runtime.stop();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
