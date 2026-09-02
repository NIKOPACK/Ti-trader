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
import { DEFAULT_CONFIG } from "../state.ts";

type EventHandler = (event: { type: string }, ctx: ExtensionContext) => Promise<void> | void;

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
	guardPositions?: boolean;
	enabled?: boolean;
}) {
	let openIndex = 0;
	let historyIndex = 0;
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
	monitorState.runtime = {
		config: {
			...DEFAULT_CONFIG,
			monitor: {
				...DEFAULT_CONFIG.monitor,
				intervalSec: 5,
				guardPositions: options.guardPositions ?? false,
				enabled: options.enabled ?? true,
			},
		},
		tradingEngine: {
			getOpenOrders,
			getOrderHistory,
			getPositions: vi.fn(async () => options.positions ?? []),
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
	createOrderMonitorExtension()(api);

	const notify = vi.fn();
	const context = { hasUI: true, ui: { notify } } as unknown as ExtensionContext;
	return {
		getOpenOrders,
		getOrderHistory,
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

	it("alerts once and stops retrying after three consecutive history misses", async () => {
		const pending = order();
		const lateClosed = order({ status: "closed", filled: 1, remaining: 0, average: 90, cost: 90 });
		const monitor = setupMonitor({
			openSnapshots: [[pending], [], [], [], []],
			historyResults: [[], [], [], [lateClosed]],
		});
		await monitor.start();

		await vi.advanceTimersByTimeAsync(15_000);
		expect(monitor.getOrderHistory).toHaveBeenCalledTimes(3);
		expect(monitor.notify).toHaveBeenCalledWith(
			expect.stringContaining("status unresolved after 3 history checks"),
			"warning",
		);
		expect(monitor.sendMessage).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(10_000);
		expect(monitor.getOrderHistory).toHaveBeenCalledTimes(3);
		expect(monitor.notify).toHaveBeenCalledOnce();
		expect(monitor.sendMessage).not.toHaveBeenCalled();
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
});
