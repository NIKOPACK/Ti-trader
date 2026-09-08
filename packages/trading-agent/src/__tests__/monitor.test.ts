import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const monitorState = vi.hoisted(() => ({ runtime: undefined as unknown }));

vi.mock("../context.ts", () => ({
	getTrading: () => monitorState.runtime,
}));
vi.mock("../settings-menu.ts", () => ({
	openTradingSettings: vi.fn(async () => {}),
}));

import type { Order, Position } from "@earendil-works/ti-trading-engine";
import type { TradingRuntime } from "../context.ts";
import { createOrderMonitorExtension, isProtection, protectionCoverage } from "../monitor.ts";
import {
	createMemoryMonitoringStore,
	enqueueMonitoringNotification,
	ensureMonitoringScope,
	type MonitoringScope,
	type MonitoringStore,
	readMonitoringHealth,
} from "../monitoring-state.ts";
import { DEFAULT_CONFIG } from "../state.ts";

type EventHandler = (event: { type: string }, ctx: ExtensionContext) => Promise<void> | void;

const TEST_SCOPE: MonitoringScope = {
	mode: "paper",
	exchange: "okx",
	marketType: "spot",
	quoteCurrency: "USDT",
	accountId: "test-account",
};

function order(overrides: Partial<Order> = {}): Order {
	return {
		id: "pending-1",
		symbol: "BTC/USDT",
		side: "sell",
		type: "stop_market",
		amount: 1,
		filled: 0,
		remaining: 1,
		cost: 0,
		status: "open",
		timestamp: 1,
		...overrides,
	};
}

function setupMonitor(options: {
	openSnapshots: Order[][];
	historyResults: Array<Order[] | Error>;
	positions?: Position[];
	positionSnapshots?: Position[][];
	guardPositions?: boolean;
	enabled?: boolean;
	store?: MonitoringStore;
	scope?: MonitoringScope;
	intervalSec?: number;
	wakeAgent?: boolean;
	hasUI?: boolean;
	uiMode?: "tui" | "print";
}) {
	let openIndex = 0;
	let historyIndex = 0;
	let positionIndex = 0;
	const getOpenOrders = vi.fn(async () => {
		const snapshot = options.openSnapshots[Math.min(openIndex, options.openSnapshots.length - 1)] ?? [];
		openIndex++;
		return snapshot;
	});
	const getOrderHistory = vi.fn(async () => {
		const result = options.historyResults[Math.min(historyIndex, options.historyResults.length - 1)] ?? [];
		historyIndex++;
		if (result instanceof Error) throw result;
		return result;
	});
	const getPositions = vi.fn(async () => {
		const snapshots = options.positionSnapshots;
		const snapshot = snapshots ? snapshots[Math.min(positionIndex, snapshots.length - 1)] : (options.positions ?? []);
		positionIndex++;
		return snapshot ?? [];
	});
	monitorState.runtime = {
		config: {
			...DEFAULT_CONFIG,
			mode: options.scope?.mode ?? DEFAULT_CONFIG.mode,
			monitor: {
				...DEFAULT_CONFIG.monitor,
				intervalSec: options.intervalSec ?? 5,
				wakeAgent: options.wakeAgent ?? true,
				guardPositions: options.guardPositions ?? false,
				enabled: options.enabled ?? true,
			},
		},
		tradingEngine: {
			getOpenOrders,
			getOrderHistory,
			getPositions,
		},
	} as unknown as TradingRuntime;

	let startHandler: EventHandler | undefined;
	let shutdownHandler: EventHandler | undefined;
	const sendMessage = vi.fn<ExtensionAPI["sendMessage"]>();
	const api = {
		registerCommand: vi.fn(),
		on(event: string, handler: EventHandler) {
			if (event === "session_start") startHandler = handler;
			if (event === "session_shutdown") shutdownHandler = handler;
		},
		sendMessage,
	} as unknown as ExtensionAPI;
	createOrderMonitorExtension({
		store: options.store ?? createMemoryMonitoringStore(),
		getScope: () => options.scope ?? TEST_SCOPE,
	})(api);

	const notify = vi.fn();
	const context = {
		hasUI: options.hasUI ?? true,
		mode: options.uiMode ?? "tui",
		ui: { notify },
	} as unknown as ExtensionContext;
	return {
		runtime: monitorState.runtime,
		getOpenOrders,
		getOrderHistory,
		getPositions,
		notify,
		sendMessage,
		async start(): Promise<void> {
			if (!startHandler) throw new Error("session_start handler was not registered");
			await startHandler({ type: "session_start" }, context);
		},
		async stop(): Promise<void> {
			if (shutdownHandler) await shutdownHandler({ type: "session_shutdown" }, context);
		},
	};
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("order monitor config gating", () => {
	it("does not poll while the monitor is disabled in config", async () => {
		const monitor = setupMonitor({
			openSnapshots: [[]],
			historyResults: [[]],
			enabled: false,
		});
		await monitor.start();
		await vi.advanceTimersByTimeAsync(15_000);
		expect(monitor.getOpenOrders).not.toHaveBeenCalled();
		await monitor.stop();
	});
});

describe("order monitor delivery isolation", () => {
	it.each(["sendMessage", "notify"] as const)(
		"continues minute-interval observations while %s keeps throwing",
		async (sink) => {
			const store = createMemoryMonitoringStore();
			const now = Date.now();
			store.transact((state) => {
				enqueueMonitoringNotification(
					ensureMonitoringScope(state, TEST_SCOPE, now),
					{
						source: "orders",
						customType: "order-fill",
						content: "pending delivery",
						notices: ["pending delivery"],
						level: "info",
						wake: true,
					},
					now,
				);
			});
			const monitor = setupMonitor({
				openSnapshots: [[order()]],
				historyResults: [[]],
				guardPositions: true,
				intervalSec: 60,
				store,
			});
			monitor[sink].mockImplementation(() => {
				throw new Error("notification sink unavailable");
			});
			await monitor.start();
			await vi.advanceTimersByTimeAsync(240_000);
			expect(monitor.getOpenOrders).toHaveBeenCalledTimes(5);
			expect(monitor.getPositions).toHaveBeenCalledTimes(5);
			expect(store.read().scopes[0].orders).toMatchObject({
				cursor: now + 240_000,
				known: [{ id: "pending-1", symbol: "BTC/USDT" }],
			});
			expect(readMonitoringHealth(store, TEST_SCOPE, now + 240_000)[1]).toMatchObject({
				lastSuccessAt: now + 240_000,
				lastFailureAt: now + 240_000,
				lastDeliveryFailureAt: now + 240_000,
				errorCode: "delivery-failed",
				pendingNotifications: 1,
			});
			expect(console.error).toHaveBeenCalled();
			await monitor.stop();
		},
	);
});

describe("live order and guard wake compatibility", () => {
	const scope: MonitoringScope = { ...TEST_SCOPE, mode: "live" };
	const position: Position = { symbol: "BTC/USDT", asset: "BTC", amount: 1, quoteValue: 100 };
	const pending = order({ side: "buy", type: "limit" });
	const filled = order({ ...pending, status: "closed", filled: 1, remaining: 0 });

	it.each(["tui", "print", "headless", "wake-off"] as const)(
		"preserves fresh live fill and guard notification behavior in %s",
		async (scenario) => {
			const monitor = setupMonitor({
				openSnapshots: [[pending], []],
				historyResults: [[filled]],
				positions: [position],
				guardPositions: true,
				scope,
				uiMode: scenario === "print" ? "print" : "tui",
				hasUI: scenario !== "headless",
				wakeAgent: scenario !== "wake-off",
			});
			await monitor.start();
			await vi.advanceTimersByTimeAsync(5_000);
			expect(monitor.sendMessage.mock.calls.map(([message]) => message.customType)).toEqual([
				"order-fill",
				"position-alert",
			]);
			for (const [, options] of monitor.sendMessage.mock.calls) {
				expect(options).toEqual(
					scenario === "tui" ? { triggerTurn: true, deliverAs: "followUp" } : { triggerTurn: false },
				);
			}
			await monitor.stop();
		},
	);

	it("does not wake on live retries even though the first fresh attempts wake analysis", async () => {
		const store = createMemoryMonitoringStore();
		const monitor = setupMonitor({
			openSnapshots: [[pending], []],
			historyResults: [[filled]],
			positions: [position],
			guardPositions: true,
			scope,
			store,
		});
		await monitor.start();
		monitor.sendMessage.mockImplementation(() => {
			throw new Error("transport failure");
		});
		await vi.advanceTimersByTimeAsync(5_000);
		expect(monitor.sendMessage).toHaveBeenCalledTimes(2);
		expect(monitor.sendMessage.mock.calls.every(([, options]) => options?.triggerTurn === true)).toBe(true);
		const ids = store.read().scopes[0].notifications.map((event) => event.id);
		monitor.sendMessage.mockReset();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(monitor.sendMessage).toHaveBeenCalledTimes(2);
		expect(monitor.sendMessage.mock.calls.every(([, options]) => options?.triggerTurn === false)).toBe(true);
		expect(monitor.sendMessage.mock.calls.map(([message]) => message.details)).toEqual(
			ids.map((id) => ({ monitoringEventId: id })),
		);
		await monitor.stop();
	});

	it("does not wake on a live fill or guard recovered from a pre-restart baseline", async () => {
		const store = createMemoryMonitoringStore();
		const first = setupMonitor({
			openSnapshots: [[pending]],
			historyResults: [[]],
			positions: [position],
			guardPositions: true,
			scope,
			store,
		});
		await first.start();
		await first.stop();
		vi.setSystemTime(Date.now() + 5_000);
		const restarted = setupMonitor({
			openSnapshots: [[]],
			historyResults: [[filled]],
			positions: [position],
			guardPositions: true,
			scope,
			store,
		});
		await restarted.start();
		expect(restarted.sendMessage).toHaveBeenCalledTimes(2);
		expect(restarted.sendMessage.mock.calls.every(([, options]) => options?.triggerTurn === false)).toBe(true);
		await restarted.stop();
	});

	it.each(["same-instance", "new-instance"] as const)(
		"keeps delayed recovered fills non-waking after a %s restart and history failure",
		async (restart) => {
			const store = createMemoryMonitoringStore();
			const first = setupMonitor({
				openSnapshots: [[pending], [], []],
				historyResults: [new Error("history unavailable"), [filled]],
				scope,
				store,
			});
			await first.start();
			await first.stop();
			vi.setSystemTime(Date.now() + 5_000);
			const restarted =
				restart === "same-instance"
					? first
					: setupMonitor({
							openSnapshots: [[], []],
							historyResults: [new Error("history unavailable"), [filled]],
							scope,
							store,
						});
			await restarted.start();
			expect(restarted.sendMessage).not.toHaveBeenCalled();
			expect(store.read().scopes[0].orders.missing).toHaveLength(1);
			await vi.advanceTimersByTimeAsync(5_000);
			expect(restarted.getOrderHistory).toHaveBeenCalledTimes(2);
			expect(restarted.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: "order-fill" }), {
				triggerTurn: false,
			});
			expect(store.read().scopes[0].notifications[0]).toMatchObject({
				wake: false,
				attempts: 1,
				status: "delivered",
			});
			await restarted.stop();
		},
	);

	it("retains fresh live wakes when a restarted run actually observes the order open before delayed history", async () => {
		const store = createMemoryMonitoringStore();
		const first = setupMonitor({ openSnapshots: [[pending]], historyResults: [[]], scope, store });
		await first.start();
		await first.stop();
		vi.setSystemTime(Date.now() + 5_000);
		const restarted = setupMonitor({
			openSnapshots: [[pending], [], []],
			historyResults: [new Error("history unavailable"), [filled]],
			scope,
			store,
		});
		await restarted.start();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(restarted.sendMessage).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(restarted.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: "order-fill" }), {
			triggerTurn: true,
			deliverAs: "followUp",
		});
		await restarted.stop();
	});

	it("separates fresh and recovered orders resolved by the same history response", async () => {
		const store = createMemoryMonitoringStore();
		const first = setupMonitor({ openSnapshots: [[pending]], historyResults: [[]], scope, store });
		await first.start();
		await first.stop();
		vi.setSystemTime(Date.now() + 5_000);
		const fresh = order({ ...pending, id: "fresh-order", amount: 2, remaining: 2 });
		const freshFill = order({ ...fresh, status: "closed", filled: 2, remaining: 0 });
		const restarted = setupMonitor({
			openSnapshots: [[fresh], []],
			historyResults: [new Error("history unavailable"), [filled, freshFill]],
			scope,
			store,
		});
		await restarted.start();
		expect(restarted.sendMessage).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(restarted.sendMessage).toHaveBeenCalledTimes(2);
		const freshCall = restarted.sendMessage.mock.calls.find(([message]) => String(message.content).includes("BUY 2"));
		const recoveredCall = restarted.sendMessage.mock.calls.find(([message]) =>
			String(message.content).includes("BUY 1"),
		);
		expect(freshCall?.[1]).toEqual({ triggerTurn: true, deliverAs: "followUp" });
		expect(freshCall?.[0].content).not.toContain("BUY 1");
		expect(recoveredCall?.[1]).toEqual({ triggerTurn: false });
		expect(recoveredCall?.[0].content).not.toContain("BUY 2");
		await restarted.stop();
	});

	it("clears current-run open evidence when the monitored scope changes", async () => {
		const store = createMemoryMonitoringStore();
		const options: Parameters<typeof setupMonitor>[0] = {
			openSnapshots: [[pending], [], []],
			historyResults: [new Error("history unavailable"), [filled]],
			scope,
			store,
		};
		const monitor = setupMonitor(options);
		await monitor.start();
		const otherScope = { ...scope, accountId: "other-live-account" };
		store.transact((state) => {
			const other = ensureMonitoringScope(state, otherScope, Date.now());
			other.orders.seeded = true;
			other.orders.known = [{ id: pending.id, symbol: pending.symbol }];
		});
		options.scope = otherScope;
		await vi.advanceTimersByTimeAsync(5_000);
		expect(monitor.sendMessage).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(monitor.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: "order-fill" }), {
			triggerTurn: false,
		});
		await monitor.stop();
	});
});

describe("order monitor pending classification", () => {
	it("keeps a disappeared order pending when history fails and retries it", async () => {
		const pending = order();
		const closed = order({ status: "closed", filled: 1, remaining: 0, average: 90, cost: 90 });
		const monitor = setupMonitor({
			openSnapshots: [[pending], [], []],
			historyResults: [new Error("temporary history failure"), [closed]],
		});
		await monitor.start();

		await vi.advanceTimersByTimeAsync(5_000);
		expect(monitor.sendMessage).not.toHaveBeenCalled();
		expect(monitor.notify).toHaveBeenCalledWith(expect.stringContaining("history query failed"), "warning");

		await vi.advanceTimersByTimeAsync(5_000);
		expect(monitor.getOrderHistory).toHaveBeenCalledTimes(2);
		expect(monitor.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: "order-fill" }), {
			triggerTurn: true,
			deliverAs: "followUp",
		});
		await monitor.stop();
	});

	it("keeps an unknown terminal status pending until history becomes definitive", async () => {
		const pending = order();
		const unknown = order({ status: "unknown" });
		const closed = order({ status: "closed", filled: 1, remaining: 0, average: 90, cost: 90 });
		const monitor = setupMonitor({
			openSnapshots: [[pending], [], []],
			historyResults: [[unknown], [closed]],
		});
		await monitor.start();

		await vi.advanceTimersByTimeAsync(5_000);
		expect(monitor.sendMessage).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(5_000);

		expect(monitor.getOrderHistory).toHaveBeenCalledTimes(2);
		expect(monitor.sendMessage).toHaveBeenCalledOnce();
		await monitor.stop();
	});

	it("keeps an order missing from history pending until it appears", async () => {
		const pending = order();
		const closed = order({ status: "closed", filled: 1, remaining: 0, average: 90, cost: 90 });
		const monitor = setupMonitor({
			openSnapshots: [[pending], [], []],
			historyResults: [[], [closed]],
		});
		await monitor.start();

		await vi.advanceTimersByTimeAsync(5_000);
		expect(monitor.sendMessage).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(5_000);

		expect(monitor.getOrderHistory).toHaveBeenCalledTimes(2);
		expect(monitor.sendMessage).toHaveBeenCalledOnce();
		await monitor.stop();
	});

	it("keeps retrying after three history misses and reports a delayed fill", async () => {
		const pending = order();
		const lateClosed = order({ status: "closed", filled: 1, remaining: 0, average: 90, cost: 90 });
		const monitor = setupMonitor({
			openSnapshots: [[pending], [], [], [], [], []],
			historyResults: [[], [], [], [], [lateClosed]],
		});
		await monitor.start();

		await vi.advanceTimersByTimeAsync(15_000);
		expect(monitor.getOrderHistory).toHaveBeenCalledTimes(3);
		expect(monitor.notify).toHaveBeenCalledWith(
			expect.stringContaining("status unresolved after 3 history checks"),
			"warning",
		);
		expect(monitor.sendMessage).not.toHaveBeenCalled();

		// The unresolved order remains in the snapshot after the warning. A later
		// history response must still be able to classify and report its fill.
		await vi.advanceTimersByTimeAsync(5_000);
		expect(monitor.getOrderHistory).toHaveBeenCalledTimes(4);
		expect(monitor.sendMessage).not.toHaveBeenCalled();
		expect(monitor.notify.mock.calls.filter((call) => call[1] === "warning")).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(5_000);
		expect(monitor.getOrderHistory).toHaveBeenCalledTimes(5);
		expect(monitor.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "order-fill",
				content: expect.stringContaining("SELL 1 BTC/USDT"),
			}),
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		expect(monitor.notify.mock.calls.filter((call) => call[1] === "warning")).toHaveLength(1);
		await monitor.stop();
	});

	it("removes a canceled order from pending without reporting a fill", async () => {
		const pending = order();
		const canceled = order({ status: "canceled" });
		const closed = order({ status: "closed", filled: 1, remaining: 0, average: 90, cost: 90 });
		const monitor = setupMonitor({
			openSnapshots: [[pending], [], []],
			historyResults: [[canceled], [closed]],
		});
		await monitor.start();

		await vi.advanceTimersByTimeAsync(5_000);
		await vi.advanceTimersByTimeAsync(5_000);

		expect(monitor.getOrderHistory).toHaveBeenCalledOnce();
		expect(monitor.sendMessage).not.toHaveBeenCalled();
		await monitor.stop();
	});

	it.each(["canceled", "rejected", "expired"] as const)(
		"reports the actual partial fill when an order ends as %s",
		async (status) => {
			const pending = order({ amount: 10, remaining: 10 });
			const terminal = order({ status, amount: 10, filled: 4, remaining: 6, average: 90, cost: 360 });
			const monitor = setupMonitor({
				openSnapshots: [[pending], [], []],
				historyResults: [[terminal]],
			});
			await monitor.start();

			await vi.advanceTimersByTimeAsync(5_000);
			expect(monitor.sendMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					customType: "order-fill",
					content: expect.stringContaining("SELL 4 BTC/USDT"),
				}),
				{ triggerTurn: true, deliverAs: "followUp" },
			);

			await vi.advanceTimersByTimeAsync(5_000);
			expect(monitor.getOrderHistory).toHaveBeenCalledOnce();
			expect(monitor.sendMessage).toHaveBeenCalledOnce();
			await monitor.stop();
		},
	);
});

describe("position guard protection matching", () => {
	const long: Position = {
		symbol: "BTC/USDT:USDT",
		asset: "BTC",
		amount: 1,
		quoteValue: 100,
		positionSide: "LONG",
	};

	it("requires an exact hedge position-side match", () => {
		expect(isProtection(order({ symbol: long.symbol, positionSide: "LONG" }), long, 95, "hedge")).toBe(true);
		expect(isProtection(order({ symbol: long.symbol, positionSide: "SHORT" }), long, 95, "hedge")).toBe(false);
		expect(protectionCoverage(order({ symbol: long.symbol, positionSide: "SHORT" }), long, 95, "hedge")).toBe("none");
	});

	describe("durable order monitoring", () => {
		it("classifies an order that disappeared during restart and remembers acknowledgement", async () => {
			const store = createMemoryMonitoringStore();
			const pending = order();
			const closed = order({ status: "closed", filled: 1, remaining: 0, average: 90, cost: 90 });
			const first = setupMonitor({ openSnapshots: [[pending]], historyResults: [[]], store });
			await first.start();
			await first.stop();
			vi.setSystemTime(Date.now() + 5_000);
			const second = setupMonitor({ openSnapshots: [[]], historyResults: [[closed]], store });
			await second.start();
			expect(second.sendMessage).toHaveBeenCalledOnce();
			await second.stop();
			vi.setSystemTime(Date.now() + 5_000);
			const third = setupMonitor({ openSnapshots: [[]], historyResults: [[closed]], store });
			await third.start();
			expect(third.sendMessage).not.toHaveBeenCalled();
			expect(third.getOrderHistory).not.toHaveBeenCalled();
			await third.stop();
		});

		it("preserves guard grace and cooldown across restarts", async () => {
			const store = createMemoryMonitoringStore();
			const position: Position = { symbol: "BTC/USDT", asset: "BTC", amount: 1, quoteValue: 100 };
			const first = setupMonitor({
				openSnapshots: [[]],
				historyResults: [[]],
				positions: [position],
				guardPositions: true,
				store,
			});
			await first.start();
			await first.stop();
			vi.setSystemTime(Date.now() + 5_000);
			const second = setupMonitor({
				openSnapshots: [[]],
				historyResults: [[]],
				positions: [position],
				guardPositions: true,
				store,
			});
			await second.start();
			expect(second.sendMessage).toHaveBeenCalledOnce();
			const cooldown = store.read().scopes[0].orders.guards[0].lastAlertAt;
			await second.stop();
			vi.setSystemTime(Date.now() + 5_000);
			const third = setupMonitor({
				openSnapshots: [[]],
				historyResults: [[]],
				positions: [position],
				guardPositions: true,
				store,
			});
			await third.start();
			expect(third.sendMessage).not.toHaveBeenCalled();
			expect(store.read().scopes[0].orders.guards[0].lastAlertAt).toBe(cooldown);
			await third.stop();
		});

		it("never applies another account's baseline or cooldown", async () => {
			const store = createMemoryMonitoringStore();
			const first = setupMonitor({ openSnapshots: [[order()]], historyResults: [[]], store });
			await first.start();
			await first.stop();
			vi.setSystemTime(Date.now() + 5_000);
			const other = setupMonitor({
				openSnapshots: [[]],
				historyResults: [[order({ status: "closed", filled: 1 })]],
				scope: { ...TEST_SCOPE, accountId: "another-account" },
				store,
			});
			await other.start();
			expect(other.sendMessage).not.toHaveBeenCalled();
			expect(other.getOrderHistory).not.toHaveBeenCalled();
			expect(store.read().scopes[0].orders.known).toHaveLength(1);
			await other.stop();
		});

		it("merges two simultaneous monitors without duplicate fill delivery", async () => {
			const store = createMemoryMonitoringStore();
			const first = setupMonitor({
				openSnapshots: [[order()], [], []],
				historyResults: [[order({ status: "closed", filled: 1, remaining: 0 })]],
				store,
			});
			await first.start();
			const second = setupMonitor({ openSnapshots: [[]], historyResults: [[]], store });
			monitorState.runtime = first.runtime;
			await second.start();
			await vi.advanceTimersByTimeAsync(5_000);
			expect(first.sendMessage.mock.calls.length + second.sendMessage.mock.calls.length).toBe(1);
			expect(store.read().scopes[0].notifications).toHaveLength(1);
			await first.stop();
			await second.stop();
		});

		it("retries the persisted notification after delivery failure without waking a stale action", async () => {
			const store = createMemoryMonitoringStore();
			const first = setupMonitor({
				openSnapshots: [[order()], []],
				historyResults: [[order({ status: "closed", filled: 1, remaining: 0 })]],
				store,
			});
			await first.start();
			first.sendMessage.mockImplementationOnce(() => {
				throw new Error("delivery unavailable");
			});
			await vi.advanceTimersByTimeAsync(5_000);
			const id = store.read().scopes[0].notifications[0].id;
			await first.stop();
			vi.setSystemTime(Date.now() + 5_000);
			const restarted = setupMonitor({ openSnapshots: [[]], historyResults: [[]], store });
			restarted.getOpenOrders.mockRejectedValue(new Error("exchange offline"));
			await restarted.start();
			expect(restarted.sendMessage).toHaveBeenCalledWith(
				expect.objectContaining({ details: { monitoringEventId: id } }),
				{ triggerTurn: false },
			);
			expect(restarted.getOrderHistory).not.toHaveBeenCalled();
			await restarted.stop();
		});

		it("does not lose its baseline when recording a fill fails", async () => {
			const base = createMemoryMonitoringStore();
			let fail = false;
			const store: MonitoringStore = {
				read: () => base.read(),
				transact: (operation) => {
					if (fail) throw new Error("disk full");
					return base.transact(operation);
				},
			};
			const monitor = setupMonitor({
				openSnapshots: [[order()], []],
				historyResults: [[order({ status: "closed", filled: 1, remaining: 0 })]],
				store,
			});
			await monitor.start();
			fail = true;
			await vi.advanceTimersByTimeAsync(5_000);
			expect(monitor.sendMessage).not.toHaveBeenCalled();
			expect(base.read().scopes[0].orders.known).toHaveLength(1);
			fail = false;
			await vi.advanceTimersByTimeAsync(5_000);
			expect(monitor.sendMessage).toHaveBeenCalledOnce();
			await monitor.stop();
		});

		it("does not write or deliver an old-generation poll after shutdown", async () => {
			const store = createMemoryMonitoringStore();
			const monitor = setupMonitor({ openSnapshots: [[order()]], historyResults: [[]], store });
			let finish: ((orders: Order[]) => void) | undefined;
			monitor.getOpenOrders.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finish = resolve;
					}),
			);
			const start = monitor.start();
			await monitor.stop();
			finish?.([order()]);
			await start;
			expect(store.read().scopes).toHaveLength(0);
			expect(monitor.sendMessage).not.toHaveBeenCalled();
		});
	});

	it("treats a matching close-position stop as full protection when its amount is zero", () => {
		const closeAll = order({
			symbol: long.symbol,
			positionSide: "LONG",
			amount: 0,
			remaining: 0,
			closePosition: true,
		});

		expect(isProtection(closeAll, long, 95, "hedge")).toBe(true);
		expect(protectionCoverage(closeAll, long, 95, "hedge")).toBe("protected");
	});

	it("does not treat a zero-size position as protected", () => {
		const empty: Position = { ...long, amount: 0, quoteValue: 0 };
		const closeAll = order({
			symbol: empty.symbol,
			positionSide: "LONG",
			amount: 0,
			remaining: 0,
			closePosition: true,
		});
		expect(isProtection(closeAll, empty, 95, "hedge")).toBe(false);
		expect(protectionCoverage(closeAll, empty, 95, "hedge")).toBe("none");
	});

	it("treats an OCO order as having a stop component", () => {
		const oco = order({ symbol: long.symbol, type: "oco", positionSide: "LONG" });
		expect(isProtection(oco, long, 95, "hedge")).toBe(true);
		expect(protectionCoverage(oco, long, 95, "hedge")).toBe("protected");
	});

	it("renders an unvalued position in the unprotected alert without toFixed exceptions", async () => {
		const unvalued: Position = {
			symbol: "BTC/USDT",
			asset: "BTC",
			amount: 1,
			avgEntryPrice: 100,
			valuationStatus: "unavailable",
			valuationReason: "Ticker for BTC/USDT did not provide a finite positive last price",
		};
		const monitor = setupMonitor({
			openSnapshots: [[], [], []],
			historyResults: [[], []],
			positions: [unvalued],
			guardPositions: true,
		});
		await monitor.start();

		await expect(vi.advanceTimersByTimeAsync(10_000)).resolves.not.toThrow();
		// Unprotected alert fires after the grace interval; it must render the
		// unvalued marker instead of formatting an undefined quote value.
		expect(monitor.notify).toHaveBeenCalledWith(expect.stringContaining("quote valuation unavailable"), "warning");
		expect(monitor.notify).toHaveBeenCalledWith(expect.stringContaining("UNPROTECTED: BTC/USDT 1"), "warning");
		await monitor.stop();
	});

	it("clears drawdown cooldown when a position is closed and reopened", async () => {
		const drawdown: Position = {
			...long,
			unrealizedPnlPct: -10,
			unrealizedPnl: -10,
		};
		const protection = order({
			symbol: long.symbol,
			positionSide: "LONG",
			amount: 1,
			remaining: 1,
		});
		const monitor = setupMonitor({
			openSnapshots: [[protection], [protection], [protection]],
			historyResults: [[], []],
			positionSnapshots: [[drawdown], [], [drawdown]],
			guardPositions: true,
		});
		await monitor.start();

		await vi.advanceTimersByTimeAsync(10_000);

		expect(monitor.notify.mock.calls.filter((call) => String(call[0]).includes("DRAWDOWN:")).length).toBe(2);
		expect(monitor.sendMessage).toHaveBeenCalledTimes(2);
		await monitor.stop();
	});
});
