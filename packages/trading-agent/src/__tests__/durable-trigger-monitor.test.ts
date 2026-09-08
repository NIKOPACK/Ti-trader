import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Position } from "@nikopack/ti-trading-engine";
import type { Condition, TriggerDefinition, TriggerPolicy } from "@nikopack/ti-triggers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
	mode: "paper" as "paper" | "live",
	config: { monitor: { intervalSec: 5 } },
	marketData: { getTicker: vi.fn(async () => ({ last: 101, timestamp: Date.now() })) },
	tradingEngine: { getPositions: vi.fn(async (): Promise<Position[]> => []) },
}));
vi.mock("../context.ts", () => ({ getTrading: () => runtime }));

import {
	createMemoryMonitoringStore,
	enqueueMonitoringNotification,
	MONITORING_MAX_AGE_MS,
	type MonitoringScope,
	type MonitoringStore,
	readMonitoringHealth,
} from "../monitoring-state.ts";
import { createTriggerMonitorExtension } from "../trigger-monitor.ts";

const NOW = Date.parse("2026-01-01T00:00:00Z");
const SCOPE: MonitoringScope = {
	mode: "paper",
	exchange: "okx",
	marketType: "spot",
	quoteCurrency: "USDT",
	accountId: "account-a",
};

function definition(
	when: Condition = { kind: "compare", fact: { key: "price:BTC/USDT" }, operator: "gt", value: 100 },
	policy: TriggerPolicy = { mode: "once" },
): TriggerDefinition {
	return {
		id: "price",
		name: "price",
		when,
		// biome-ignore lint/suspicious/noThenProperty: public trigger action field
		then: { kind: "wake_agent", message: "review" },
		policy,
	};
}

function harness(store: MonitoringStore, scope = SCOPE) {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
	let command: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
	const sendMessage = vi.fn<ExtensionAPI["sendMessage"]>();
	const notify = vi.fn();
	const ctx = {
		hasUI: true,
		mode: "tui",
		isIdle: () => true,
		ui: { notify },
	} as unknown as ExtensionCommandContext;
	const api: Partial<ExtensionAPI> = {
		registerCommand: (_name, options) => {
			command = options.handler;
		},
		on: (event, handler) => {
			handlers.set(event, handler as (event: unknown, ctx: ExtensionContext) => Promise<void>);
		},
		sendMessage,
	};
	createTriggerMonitorExtension({ store, getScope: () => ({ ...scope, mode: runtime.mode }) })(api as ExtensionAPI);
	return {
		sendMessage,
		notify,
		add: async (trigger = definition()) => command?.(`add ${JSON.stringify(trigger)}`, ctx),
		command: async (args: string) => command?.(args, ctx),
		start: async () => handlers.get("session_start")?.({}, ctx),
		stop: async () => handlers.get("session_shutdown")?.({}, ctx),
	};
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	vi.spyOn(console, "error").mockImplementation(() => {});
	runtime.mode = "paper";
	runtime.config.monitor.intervalSec = 5;
	runtime.marketData.getTicker.mockClear();
	runtime.marketData.getTicker.mockImplementation(async () => ({ last: 101, timestamp: Date.now() }));
});
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("durable trigger monitor", () => {
	it.each(["sendMessage", "notify"] as const)(
		"continues collecting facts while a pending %s delivery fails every minute",
		async (sink) => {
			const store = createMemoryMonitoringStore();
			const monitor = harness(store);
			runtime.config.monitor.intervalSec = 60;
			await monitor.add(
				definition({
					kind: "compare",
					fact: { key: "price:BTC/USDT" },
					operator: "gt",
					value: 200,
				}),
			);
			store.transact((state) => {
				const entry = state.scopes[0];
				enqueueMonitoringNotification(
					entry,
					{
						source: "triggers",
						customType: "trigger",
						content: "pending review",
						notices: ["pending review"],
						level: "info",
						wake: true,
						triggerRevision: entry.triggers[0].revision,
					},
					NOW,
				);
			});
			monitor[sink].mockImplementation(() => {
				throw new Error("notification sink unavailable");
			});
			await monitor.start();
			await vi.advanceTimersByTimeAsync(240_000);
			expect(runtime.marketData.getTicker).toHaveBeenCalledTimes(5);
			expect(store.read().scopes[0].facts[0].observedAt).toBe(NOW + 240_000);
			expect(readMonitoringHealth(store, SCOPE, NOW + 240_000)[0]).toMatchObject({
				lastSuccessAt: NOW + 240_000,
				lastFailureAt: NOW + 240_000,
				lastDeliveryFailureAt: NOW + 240_000,
				errorCode: "delivery-failed",
				pendingNotifications: 1,
			});
			expect(console.error).toHaveBeenCalled();
		},
	);

	it.each(["missing", "stale", "future"] as const)(
		"invalidates stable-for continuity on a %s fact even when no fact advances",
		async (failure) => {
			const store = createMemoryMonitoringStore();
			const monitor = harness(store);
			let broken = false;
			runtime.marketData.getTicker.mockImplementation(async () => {
				if (broken && failure === "missing") throw new Error("ticker unavailable");
				return {
					last: 101,
					timestamp: broken
						? failure === "stale"
							? NOW - MONITORING_MAX_AGE_MS - 1
							: Date.now() + 60_000
						: Date.now(),
				};
			});
			await monitor.add(
				definition({
					kind: "stable_for",
					durationSec: 10,
					condition: { kind: "compare", fact: { key: "price:BTC/USDT" }, operator: "gt", value: 100 },
				}),
			);
			await monitor.start();
			expect(store.read().scopes[0].triggers[0].state.stableSince).toBe(NOW);
			broken = true;
			await vi.advanceTimersByTimeAsync(5_000);
			expect(store.read().scopes[0].triggers[0].state.stableSince).toBeUndefined();
			expect(store.read().scopes[0].triggers[0].state.stableSinceByPath).toEqual({});
			broken = false;
			await vi.advanceTimersByTimeAsync(5_000);
			expect(monitor.sendMessage).not.toHaveBeenCalled();
			expect(store.read().scopes[0].triggers[0].state.stableSince).toBe(NOW + 10_000);
			await vi.advanceTimersByTimeAsync(10_000);
			expect(monitor.sendMessage).toHaveBeenCalledOnce();
		},
	);

	it("invalidates only the affected nested continuity path", async () => {
		const store = createMemoryMonitoringStore();
		const monitor = harness(store);
		await monitor.add(
			definition({
				kind: "all",
				conditions: [
					{
						kind: "stable_for",
						durationSec: 10,
						condition: { kind: "compare", fact: { key: "price:BTC/USDT" }, operator: "gt", value: 100 },
					},
					{ kind: "stable_for", durationSec: 20, condition: { kind: "time", at: new Date(NOW).toISOString() } },
				],
			}),
		);
		await monitor.start();
		runtime.marketData.getTicker.mockRejectedValueOnce(new Error("ticker unavailable"));
		await vi.advanceTimersByTimeAsync(5_000);
		expect(store.read().scopes[0].triggers[0].state.stableSinceByPath).toEqual({ "$.1": NOW });
		await vi.advanceTimersByTimeAsync(5_000);
		expect(store.read().scopes[0].triggers[0].state.stableSinceByPath).toEqual({ "$.0": NOW + 10_000, "$.1": NOW });
		await vi.advanceTimersByTimeAsync(5_000);
		expect(monitor.sendMessage).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(monitor.sendMessage).toHaveBeenCalledOnce();
	});

	it.each(["any", "nested-all", "not", "stable-any", "any-stable"] as const)(
		"allows an independent %s clock proof while the ticker is unavailable",
		async (shape) => {
			const store = createMemoryMonitoringStore();
			const monitor = harness(store);
			const price: Condition = { kind: "compare", fact: { key: "price:BTC/USDT" }, operator: "gt", value: 100 };
			const time: Condition = { kind: "time", at: new Date(NOW).toISOString() };
			const either: Condition = { kind: "any", conditions: [time, price] };
			const condition: Condition =
				shape === "nested-all"
					? { kind: "all", conditions: [time, either] }
					: shape === "not"
						? {
								kind: "not",
								condition: {
									kind: "all",
									conditions: [{ kind: "time", at: new Date(NOW + 60_000).toISOString() }, price],
								},
							}
						: shape === "stable-any"
							? { kind: "stable_for", condition: either, durationSec: 10 }
							: shape === "any-stable"
								? { kind: "any", conditions: [{ kind: "stable_for", condition: time, durationSec: 10 }, price] }
								: either;
			runtime.marketData.getTicker.mockRejectedValue(new Error("ticker unavailable"));
			await monitor.add(definition(condition));
			await monitor.start();
			const delayed = shape === "stable-any" || shape === "any-stable";
			expect(monitor.sendMessage).toHaveBeenCalledTimes(delayed ? 0 : 1);
			await vi.advanceTimersByTimeAsync(10_000);
			expect(monitor.sendMessage).toHaveBeenCalledOnce();
		},
	);

	it("does not bypass a required unknown fact merely because an all-branch clock is true", async () => {
		const store = createMemoryMonitoringStore();
		const monitor = harness(store);
		await monitor.add(
			definition({
				kind: "all",
				conditions: [
					{ kind: "time", at: new Date(NOW).toISOString() },
					{ kind: "compare", fact: { key: "price:BTC/USDT" }, operator: "gt", value: 100 },
				],
			}),
		);
		runtime.marketData.getTicker.mockRejectedValueOnce(new Error("ticker unavailable"));
		await monitor.start();
		expect(monitor.sendMessage).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(monitor.sendMessage).toHaveBeenCalledOnce();
	});

	it("suppresses a duplicated price branch until its independent clock branch becomes due", async () => {
		const store = createMemoryMonitoringStore();
		const monitor = harness(store);
		runtime.marketData.getTicker.mockImplementation(async () => ({ last: 101, timestamp: NOW }));
		await monitor.add(
			definition(
				{
					kind: "any",
					conditions: [
						{ kind: "time", at: new Date(NOW + 60_000).toISOString() },
						{ kind: "compare", fact: { key: "price:BTC/USDT" }, operator: "gt", value: 100 },
					],
				},
				{ mode: "while_true" },
			),
		);
		await monitor.start();
		await vi.advanceTimersByTimeAsync(55_000);
		expect(monitor.sendMessage).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(monitor.sendMessage).toHaveBeenCalledTimes(2);
	});

	it("does not consume a once trigger when stable-for matures on a duplicate snapshot", async () => {
		const store = createMemoryMonitoringStore();
		const monitor = harness(store);
		runtime.marketData.getTicker.mockImplementation(async () => ({ last: 101, timestamp: NOW }));
		await monitor.add(
			definition({
				kind: "stable_for",
				durationSec: 10,
				condition: { kind: "compare", fact: { key: "price:BTC/USDT" }, operator: "gt", value: 100 },
			}),
		);
		await monitor.start();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(monitor.sendMessage).not.toHaveBeenCalled();
		expect(store.read().scopes[0].triggers[0].state.status).toBe("active");
		expect(store.read().scopes[0].triggers[0].state.lastFiredAt).toBeUndefined();
		runtime.marketData.getTicker.mockImplementation(async () => ({ last: 101, timestamp: Date.now() }));
		await vi.advanceTimersByTimeAsync(5_000);
		expect(monitor.sendMessage).toHaveBeenCalledOnce();
	});

	it("recovers a recent baseline and never redelivers an acknowledged once trigger", async () => {
		const store = createMemoryMonitoringStore();
		let price = 90;
		runtime.marketData.getTicker.mockImplementation(async () => ({ last: price, timestamp: Date.now() }));
		const first = harness(store);
		await first.add(definition({ kind: "cross", fact: { key: "price:BTC/USDT" }, direction: "above", value: 100 }));
		await first.start();
		await first.stop();
		vi.setSystemTime(NOW + 5_000);
		price = 110;
		const second = harness(store);
		await second.start();
		expect(second.sendMessage).toHaveBeenCalledOnce();
		const id = store.read().scopes[0].triggers[0].lastDeliveryId;
		expect(second.sendMessage.mock.calls[0][0].details).toEqual({ monitoringEventId: id });
		await second.stop();
		vi.setSystemTime(NOW + 10_000);
		const third = harness(store);
		await third.start();
		expect(third.sendMessage).not.toHaveBeenCalled();
		expect(store.read().scopes[0].triggers[0].state.status).toBe("fired");
	});

	it("does not turn a stale pre-restart baseline into a new crossing", async () => {
		const store = createMemoryMonitoringStore();
		let price = 90;
		runtime.marketData.getTicker.mockImplementation(async () => ({ last: price, timestamp: Date.now() }));
		const first = harness(store);
		await first.add(definition({ kind: "cross", fact: { key: "price:BTC/USDT" }, direction: "above", value: 100 }));
		await first.start();
		await first.stop();
		vi.setSystemTime(NOW + MONITORING_MAX_AGE_MS + 1);
		price = 110;
		const restarted = harness(store);
		await restarted.start();
		expect(restarted.sendMessage).not.toHaveBeenCalled();
		price = 90;
		await vi.advanceTimersByTimeAsync(5_000);
		price = 110;
		await vi.advanceTimersByTimeAsync(5_000);
		expect(restarted.sendMessage).toHaveBeenCalledOnce();
	});

	it.each(["stale", "future"] as const)("does not persist a %s observation as a crossing baseline", async (kind) => {
		const store = createMemoryMonitoringStore();
		runtime.marketData.getTicker.mockImplementation(async () => ({
			last: 90,
			timestamp: kind === "stale" ? NOW - MONITORING_MAX_AGE_MS - 1 : NOW + 60_000,
		}));
		const monitor = harness(store);
		await monitor.add(definition({ kind: "cross", fact: { key: "price:BTC/USDT" }, direction: "above", value: 100 }));
		await monitor.start();
		expect(store.read().scopes[0].facts).toEqual([]);
		expect(readMonitoringHealth(store, SCOPE, NOW)[0].errorCode).toBe("observation-failed");
		runtime.marketData.getTicker.mockImplementation(async () => ({ last: 110, timestamp: Date.now() }));
		await vi.advanceTimersByTimeAsync(5_000);
		expect(monitor.sendMessage).not.toHaveBeenCalled();
	});

	it("does not repeat while-true notifications from duplicate exchange snapshots", async () => {
		const store = createMemoryMonitoringStore();
		runtime.marketData.getTicker.mockImplementation(async () => ({ last: 110, timestamp: NOW }));
		const monitor = harness(store);
		await monitor.add(definition(undefined, { mode: "while_true" }));
		await monitor.start();
		await vi.advanceTimersByTimeAsync(15_000);
		expect(monitor.sendMessage).toHaveBeenCalledOnce();
	});

	it("atomically transitions and delivers only once with two concurrent monitors", async () => {
		const store = createMemoryMonitoringStore();
		const first = harness(store);
		const second = harness(store);
		await first.add(definition(undefined, { mode: "while_true" }));
		await Promise.all([first.start(), second.start()]);
		expect(first.sendMessage.mock.calls.length + second.sendMessage.mock.calls.length).toBe(1);
		expect(store.read().scopes[0].notifications).toHaveLength(1);
	});

	it("preserves concurrent definition replacement while a price query is pending", async () => {
		const store = createMemoryMonitoringStore();
		let resolveTicker: ((ticker: { last: number; timestamp: number }) => void) | undefined;
		runtime.marketData.getTicker.mockImplementation(
			() =>
				new Promise((done) => {
					resolveTicker = done;
				}),
		);
		const first = harness(store);
		const second = harness(store);
		await first.add();
		const pending = first.start();
		await second.command("clear");
		await second.add({ ...definition(), name: "replacement" });
		resolveTicker?.({ last: 110, timestamp: NOW });
		await pending;
		expect(first.sendMessage).not.toHaveBeenCalled();
		expect(store.read().scopes[0].triggers[0].definition.name).toBe("replacement");
		expect(store.read().scopes[0].triggers[0].state.status).toBe("active");
	});

	it("does not commit observations after shutdown or engine replacement", async () => {
		const store = createMemoryMonitoringStore();
		let resolveTicker: ((ticker: { last: number; timestamp: number }) => void) | undefined;
		runtime.marketData.getTicker.mockImplementation(
			() =>
				new Promise((done) => {
					resolveTicker = done;
				}),
		);
		const monitor = harness(store);
		await monitor.add();
		const before = store.read();
		const pending = monitor.start();
		await monitor.stop();
		resolveTicker?.({ last: 110, timestamp: NOW });
		await pending;
		expect(store.read()).toEqual(before);
		expect(monitor.sendMessage).not.toHaveBeenCalled();
	});

	it("keeps definitions and pending events isolated by account and configuration scope", async () => {
		const store = createMemoryMonitoringStore();
		const first = harness(store);
		await first.add();
		for (const scope of [
			{ ...SCOPE, accountId: "account-b" },
			{ ...SCOPE, exchange: "binance" },
			{ ...SCOPE, marketType: "usdm-futures" as const },
			{ ...SCOPE, quoteCurrency: "USDC" },
		]) {
			const other = harness(store, scope);
			await other.start();
			expect(other.sendMessage).not.toHaveBeenCalled();
			await other.stop();
		}
		runtime.mode = "live";
		const live = harness(store);
		await live.start();
		expect(live.sendMessage).not.toHaveBeenCalled();
		expect(store.read().scopes[0].triggers).toHaveLength(1);
	});

	it("does not advance state or notify when the atomic transition write fails", async () => {
		const base = createMemoryMonitoringStore();
		let fail = false;
		const store: MonitoringStore = {
			read: () => base.read(),
			transact: (operation) => {
				if (fail) throw new Error("disk failure");
				return base.transact(operation);
			},
		};
		const monitor = harness(store);
		await monitor.add();
		fail = true;
		await monitor.start();
		expect(monitor.sendMessage).not.toHaveBeenCalled();
		expect(base.read().scopes[0].triggers[0].state.status).toBe("active");
		expect(monitor.notify).toHaveBeenCalledWith(expect.stringContaining("disk failure"), "warning");
		fail = false;
		await vi.advanceTimersByTimeAsync(5_000);
		expect(monitor.sendMessage).toHaveBeenCalledOnce();
	});

	it("retries a failed delivery after restart with its original identity, notification-only", async () => {
		const store = createMemoryMonitoringStore();
		const first = harness(store);
		await first.add();
		first.sendMessage.mockImplementationOnce(() => {
			throw new Error("transport failed");
		});
		await first.start();
		const id = store.read().scopes[0].notifications[0].id;
		await first.stop();
		vi.setSystemTime(NOW + 5_000);
		const restarted = harness(store);
		await restarted.start();
		expect(restarted.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ details: { monitoringEventId: id } }),
			{ triggerTurn: false },
		);
		expect(store.read().scopes[0].notifications[0].status).toBe("delivered");
	});

	it("cancels removed-trigger retries while retaining their event history", async () => {
		const store = createMemoryMonitoringStore();
		const monitor = harness(store);
		await monitor.add();
		monitor.sendMessage.mockImplementationOnce(() => {
			throw new Error("transport failed");
		});
		await monitor.start();
		await monitor.command("remove price");
		expect(store.read().scopes[0].notifications[0].status).toBe("cancelled");
		await vi.advanceTimersByTimeAsync(5_000);
		expect(monitor.sendMessage).toHaveBeenCalledOnce();
		expect(store.read().scopes[0].triggers).toEqual([]);
	});

	it("drains a full durable outbox before admitting new trigger events", async () => {
		const store = createMemoryMonitoringStore();
		const monitor = harness(store);
		await monitor.add(definition(undefined, { mode: "while_true" }));
		store.transact((state) => {
			const entry = state.scopes[0];
			for (let index = 0; index < 256; index++) {
				enqueueMonitoringNotification(
					entry,
					{
						source: "triggers",
						customType: "trigger",
						content: "pending review",
						notices: [],
						level: "info",
						wake: true,
						triggerRevision: entry.triggers[0].revision,
					},
					NOW,
				);
			}
		});
		await monitor.start();
		expect(monitor.sendMessage.mock.calls.length).toBeGreaterThan(0);
		expect(monitor.sendMessage.mock.calls.every(([, options]) => options?.triggerTurn === false)).toBe(true);
		expect(store.read().scopes[0].notifications.filter((event) => event.status === "pending").length).toBeLessThan(
			256,
		);
		expect(monitor.notify).not.toHaveBeenCalledWith(expect.stringContaining("backlog is full"), "warning");
	});

	it("preserves cooldown across restart and allows a fresh later re-entry", async () => {
		const store = createMemoryMonitoringStore();
		let price = 110;
		runtime.marketData.getTicker.mockImplementation(async () => ({ last: price, timestamp: Date.now() }));
		const first = harness(store);
		await first.add(definition(undefined, { mode: "on_edge", cooldownSec: 60 }));
		await first.start();
		await first.stop();
		vi.setSystemTime(NOW + 5_000);
		const restarted = harness(store);
		await restarted.start();
		expect(restarted.sendMessage).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(restarted.sendMessage).not.toHaveBeenCalled();
		price = 90;
		await vi.advanceTimersByTimeAsync(5_000);
		price = 110;
		await vi.advanceTimersByTimeAsync(5_000);
		expect(restarted.sendMessage).toHaveBeenCalledOnce();
	});

	it("does not replay missed old time actions or expired pending events", async () => {
		const store = createMemoryMonitoringStore();
		const first = harness(store);
		await first.add(definition({ kind: "time", at: new Date(NOW).toISOString() }));
		first.sendMessage.mockImplementationOnce(() => {
			throw new Error("transport failed");
		});
		await first.start();
		await first.stop();
		vi.setSystemTime(NOW + MONITORING_MAX_AGE_MS + 1);
		const restarted = harness(store);
		await restarted.start();
		expect(restarted.sendMessage).not.toHaveBeenCalled();
		expect(store.read().scopes[0].notifications[0].status).toBe("expired");
		const other = harness(createMemoryMonitoringStore());
		await other.add(definition({ kind: "time", at: new Date(NOW).toISOString() }));
		await other.start();
		expect(other.sendMessage).not.toHaveBeenCalled();
	});

	it("does not infer stable-for continuity across a long restart gap", async () => {
		const store = createMemoryMonitoringStore();
		const first = harness(store);
		await first.add(
			definition({
				kind: "stable_for",
				durationSec: 60,
				condition: { kind: "compare", fact: { key: "price:BTC/USDT" }, operator: "gt", value: 100 },
			}),
		);
		await first.start();
		await first.stop();
		vi.setSystemTime(NOW + 120_000);
		const restarted = harness(store);
		await restarted.start();
		expect(restarted.sendMessage).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(restarted.sendMessage).toHaveBeenCalledOnce();
	});
});
