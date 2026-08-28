import { describe, expect, it } from "vitest";
import { parseTradingArgs } from "../args.ts";
import { TradingRuntime } from "../context.ts";
import type { Order, Position } from "../exchange/types.ts";
import { isProtection, protectionCoverage, reduceSide } from "../monitor.ts";
import { DEFAULT_CONFIG, loadTradingState, saveTradingState, validateTradingConfig } from "../state.ts";

describe("trading configuration", () => {
	it("accepts the default configuration", () => expect(() => validateTradingConfig(DEFAULT_CONFIG)).not.toThrow());
	it("accepts Binance USDⓈ-M configuration", () => {
		expect(() =>
			validateTradingConfig({ ...DEFAULT_CONFIG, exchange: "binance", marketType: "usdm-futures", leverage: 10 }),
		).not.toThrow();
	});
	it("rejects futures on non-Binance", () => {
		expect(() => validateTradingConfig({ ...DEFAULT_CONFIG, marketType: "usdm-futures" })).toThrow(/Binance/);
		expect(() => validateTradingConfig({ ...DEFAULT_CONFIG, exchange: "binance", marketType: "both" })).not.toThrow();
	});
	it("rejects an invalid risk configuration", () => {
		expect(() =>
			validateTradingConfig({ ...DEFAULT_CONFIG, risk: { ...DEFAULT_CONFIG.risk, maxOrderNotional: 0 } }),
		).toThrow();
	});
	it("rejects invalid position-guard settings", () => {
		expect(() =>
			validateTradingConfig({ ...DEFAULT_CONFIG, monitor: { ...DEFAULT_CONFIG.monitor, alertLossPct: 0 } }),
		).toThrow(/alertLossPct/);
		expect(() =>
			validateTradingConfig({ ...DEFAULT_CONFIG, monitor: { ...DEFAULT_CONFIG.monitor, alertCooldownSec: 10 } }),
		).toThrow(/alertCooldownSec/);
	});
});

describe("position guard", () => {
	const position = (over: Partial<Position> = {}): Position => ({
		symbol: "BTC/USDT",
		asset: "BTC",
		amount: 0.5,
		quoteValue: 40000,
		...over,
	});
	const order = (over: Partial<Order>): Order => ({
		id: "1",
		symbol: "BTC/USDT",
		type: "stop_market",
		side: "sell",
		amount: 0.5,
		filled: 0,
		remaining: 0.5,
		cost: 0,
		status: "open",
		timestamp: Date.now(),
		...over,
	});

	it("closes a long with sell and a short with buy", () => {
		expect(reduceSide(position())).toBe("sell");
		expect(reduceSide(position({ positionSide: "SHORT", amount: -0.5 }))).toBe("buy");
	});
	it("recognizes stop-style reduce orders as protection", () => {
		expect(isProtection(order({ type: "stop_market" }), position())).toBe(true);
		expect(isProtection(order({ type: "stop_market", amount: 0.48 }), position())).toBe(true);
		expect(protectionCoverage(order({ type: "stop_market", amount: 0.48 }), position())).toBe("protected");
		expect(protectionCoverage(order({ type: "stop_market", amount: 0.4 }), position())).toBe("partial");
		expect(isProtection(order({ type: "trailing_stop_market" }), position())).toBe(true);
		expect(isProtection(order({ type: "stop" }), position())).toBe(true);
	});
	it("ignores non-protective orders", () => {
		expect(isProtection(order({ type: "stop_market", amount: 0.4 }), position())).toBe(false);
		expect(isProtection(order({ type: "limit" }), position())).toBe(false);
		expect(isProtection(order({ type: "take_profit_market" }), position())).toBe(false);
		expect(isProtection(order({ type: "stop_market", side: "buy" }), position())).toBe(false);
		expect(isProtection(order({ symbol: "ETH/USDT" }), position())).toBe(false);
	});
});

describe("market data tool registration", () => {
	it("exposes market integrity tools", async () => {
		const { createTradingTools } = await import("../tools/index.ts");
		const names = createTradingTools().map((tool) => tool.name);
		expect(names).toEqual(expect.arrayContaining(["get_order_book", "get_market_info", "get_contract_stats"]));
	});
});

describe("risk accounting", () => {
	function runtimeWithUsage(usedDailyNotional: number): TradingRuntime {
		const runtime = Object.create(TradingRuntime.prototype) as TradingRuntime;
		runtime.config = DEFAULT_CONFIG;
		(runtime as unknown as { state: { date: string; usedDailyNotional: number } }).state = {
			date: new Date().toISOString().slice(0, 10),
			usedDailyNotional,
		};
		return runtime;
	}

	it("allows protective sell orders when the entry quota is exhausted", () => {
		const runtime = runtimeWithUsage(DEFAULT_CONFIG.risk.maxDailyNotional);
		expect(runtime.checkRisk("BTC/USDT", 500, { countTowardsDailyLimit: false })).toBeNull();
	});

	it("still enforces the per-order limit for protective orders", () => {
		const runtime = runtimeWithUsage(DEFAULT_CONFIG.risk.maxDailyNotional);
		expect(runtime.checkRisk("BTC/USDT", 500.01, { countTowardsDailyLimit: false })).toMatch(/maxOrderNotional/);
	});
});

describe("risk symbol validation", () => {
	it("accepts Binance USDⓈ-M symbols with the settlement suffix", () => {
		const runtime = Object.create(TradingRuntime.prototype) as TradingRuntime;
		runtime.config = { ...DEFAULT_CONFIG, exchange: "binance", marketType: "usdm-futures" };
		(runtime as unknown as { state: { date: string; usedDailyNotional: number } }).state = {
			date: new Date().toISOString().slice(0, 10),
			usedDailyNotional: 0,
		};
		expect(runtime.checkRisk("BTC/USDT:USDT", 100)).toBeNull();
	});

	it("rejects spot symbols while configured for USDⓈ-M futures", () => {
		const runtime = Object.create(TradingRuntime.prototype) as TradingRuntime;
		runtime.config = { ...DEFAULT_CONFIG, exchange: "binance", marketType: "usdm-futures" };
		(runtime as unknown as { state: { date: string; usedDailyNotional: number } }).state = {
			date: new Date().toISOString().slice(0, 10),
			usedDailyNotional: 0,
		};
		expect(runtime.checkRisk("BTC/USDT", 100)).toMatch(/futures quote/);
	});
});

describe("risk state", () => {
	it("rejects invalid counters instead of allowing a daily-limit bypass", () => {
		expect(() => saveTradingState({ date: "2026-01-01", usedDailyNotional: Number.NaN })).toThrow();
	});
	it("accepts and persists a valid current-day state", () => {
		const today = new Date().toISOString().slice(0, 10);
		expect(() => saveTradingState({ date: today, usedDailyNotional: 0 })).not.toThrow();
	});
	it("creates a valid current-day state", () => {
		const state = loadTradingState();
		expect(state.usedDailyNotional).toBeGreaterThanOrEqual(0);
		expect(state.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});
	it("does not auto-reset a stale counter on load (manual reset only)", () => {
		const original = loadTradingState();
		try {
			saveTradingState({ date: "2020-01-01", usedDailyNotional: 123 });
			expect(loadTradingState()).toEqual({ date: "2020-01-01", usedDailyNotional: 123 });
		} finally {
			saveTradingState(original);
		}
	});
});

describe("CLI arguments", () => {
	it("parses mode, exchange, print and message", () => {
		expect(parseTradingArgs(["--mode=paper", "--exchange", "OKX", "-p", "analyze", "BTC"])).toEqual({
			help: false,
			version: false,
			print: true,
			mode: "paper",
			exchange: "okx",
			noExtensions: false,
			extensions: [],
			verbose: false,
			message: "analyze BTC",
		});
	});
});
