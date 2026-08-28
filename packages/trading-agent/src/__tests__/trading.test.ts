import { beforeEach, describe, expect, it, vi } from "vitest";

const configFiles = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../config.ts", () => ({
	KEYS_PATH: "keys.json",
	PAPER_DIR: "paper",
	TRADING_CONFIG_PATH: "trading.json",
	TRADING_STATE_PATH: "trading-state.json",
	readJsonFile<T>(path: string): T | undefined {
		const value = configFiles.get(path);
		return value === undefined ? undefined : (structuredClone(value) as T);
	},
	writeJsonFile(path: string, data: unknown): void {
		configFiles.set(path, structuredClone(data));
	},
}));

import { parseTradingArgs } from "../args.ts";
import { TRADING_CONFIG_PATH, TRADING_STATE_PATH } from "../config.ts";
import { TradingRuntime } from "../context.ts";
import type { Order, Position } from "../exchange/types.ts";
import { isProtection, protectionCoverage, reduceSide } from "../monitor.ts";
import {
	DEFAULT_CONFIG,
	loadTradingState,
	saveTradingState,
	type TradingConfig,
	type TradingMode,
	type TradingState,
	validateTradingConfig,
} from "../state.ts";

const today = (): string => new Date().toISOString().slice(0, 10);

function runtimeWithState(config: TradingConfig, state: TradingState): TradingRuntime {
	const runtime = Object.create(TradingRuntime.prototype) as TradingRuntime;
	runtime.config = config;
	const internals = runtime as unknown as {
		state: TradingState;
		pendingNotional: Record<TradingMode, number>;
	};
	internals.state = structuredClone(state);
	internals.pendingNotional = { paper: 0, live: 0 };
	return runtime;
}

function runtimeWithUsage(usedDailyNotional: number, config: TradingConfig = DEFAULT_CONFIG): TradingRuntime {
	return runtimeWithState(config, {
		paper: { date: today(), usedDailyNotional },
		live: { date: today(), usedDailyNotional: 0 },
	});
}

beforeEach(() => {
	configFiles.clear();
});

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
	it("accepts spot and futures symbols together in a both-mode allowlist", () => {
		const config: TradingConfig = {
			...DEFAULT_CONFIG,
			exchange: "binance",
			marketType: "both",
			risk: {
				...DEFAULT_CONFIG.risk,
				allowedSymbols: ["BTC/USDT", "ETH/USDT:USDT"],
			},
		};
		expect(() => validateTradingConfig(config)).not.toThrow();
		const runtime = runtimeWithUsage(0, config);
		expect(runtime.checkRisk("BTC/USDT", 100)).toBeNull();
		expect(runtime.checkRisk("ETH/USDT:USDT", 100)).toBeNull();
		expect(runtime.checkRisk("SOL/USDT", 100)).toMatch(/allowedSymbols/);
	});
	it("revalidates command-line overrides before creating an exchange client", async () => {
		configFiles.set(TRADING_CONFIG_PATH, {
			...DEFAULT_CONFIG,
			exchange: "binance",
			marketType: "usdm-futures",
		});

		await expect(TradingRuntime.init({ exchange: "okx" })).rejects.toThrow(/supported only on Binance/);
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
	it("requires position-side matches for hedge-mode protection", () => {
		const long = position({ positionSide: "LONG" });
		expect(isProtection(order({ positionSide: "LONG" }), long, 95, "hedge")).toBe(true);
		expect(isProtection(order({ positionSide: "SHORT" }), long, 95, "hedge")).toBe(false);
		expect(protectionCoverage(order({ positionSide: "SHORT" }), long, 95, "hedge")).toBe("none");
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
	it("allows protective sell orders when the entry quota is exhausted", () => {
		const runtime = runtimeWithUsage(DEFAULT_CONFIG.risk.maxDailyNotional);
		expect(runtime.checkRisk("BTC/USDT", 500, { countTowardsDailyLimit: false })).toBeNull();
	});

	it("still enforces the per-order limit for protective orders", () => {
		const runtime = runtimeWithUsage(DEFAULT_CONFIG.risk.maxDailyNotional);
		expect(runtime.checkRisk("BTC/USDT", 500.01, { countTowardsDailyLimit: false })).toMatch(/maxOrderNotional/);
	});

	it("keeps paper and live usage isolated", () => {
		const runtime = runtimeWithUsage(0);
		runtime.recordFill(125);
		expect(runtime.dailyUsage().used).toBe(125);

		runtime.config = { ...runtime.config, mode: "live" };
		runtime.recordFill(250);
		expect(runtime.dailyUsage().used).toBe(250);

		runtime.config = { ...runtime.config, mode: "paper" };
		expect(runtime.dailyUsage().used).toBe(125);
	});

	it("blocks a concurrent reservation that would exceed the daily limit", () => {
		const config: TradingConfig = {
			...DEFAULT_CONFIG,
			risk: { ...DEFAULT_CONFIG.risk, maxOrderNotional: 500, maxDailyNotional: 1000 },
		};
		const runtime = runtimeWithUsage(500, config);
		const first = runtime.reserveRisk("BTC/USDT", 400);

		expect(runtime.dailyUsage().reserved).toBe(400);
		expect(() => runtime.reserveRisk("BTC/USDT", 200)).toThrow(/reserved by in-flight orders/);

		first.release();
		const second = runtime.reserveRisk("BTC/USDT", 200);
		second.commit();
		expect(runtime.dailyUsage()).toMatchObject({ used: 700, reserved: 0 });
	});
});

describe("risk symbol validation", () => {
	it("accepts Binance USDⓈ-M symbols with the settlement suffix", () => {
		const runtime = runtimeWithUsage(0, {
			...DEFAULT_CONFIG,
			exchange: "binance",
			marketType: "usdm-futures",
		});
		expect(runtime.checkRisk("BTC/USDT:USDT", 100)).toBeNull();
	});

	it("rejects spot symbols while configured for USDⓈ-M futures", () => {
		const runtime = runtimeWithUsage(0, {
			...DEFAULT_CONFIG,
			exchange: "binance",
			marketType: "usdm-futures",
		});
		expect(runtime.checkRisk("BTC/USDT", 100)).toMatch(/futures quote/);
	});
});

describe("risk state", () => {
	it("rejects invalid counters instead of allowing a daily-limit bypass", () => {
		expect(() =>
			saveTradingState({
				paper: { date: "2026-01-01", usedDailyNotional: Number.NaN },
				live: { date: "2026-01-01", usedDailyNotional: 0 },
			}),
		).toThrow();
	});
	it("accepts and persists a valid current-day state", () => {
		const state: TradingState = {
			paper: { date: today(), usedDailyNotional: 10 },
			live: { date: today(), usedDailyNotional: 20 },
		};
		expect(() => saveTradingState(state)).not.toThrow();
		expect(configFiles.get(TRADING_STATE_PATH)).toEqual(state);
	});
	it("creates valid independent counters when no state exists", () => {
		const state = loadTradingState();
		expect(state).toEqual({
			paper: { date: today(), usedDailyNotional: 0 },
			live: { date: today(), usedDailyNotional: 0 },
		});
		expect(state.paper).not.toBe(state.live);
	});
	it("migrates a legacy shared counter conservatively into both modes", () => {
		configFiles.set(TRADING_STATE_PATH, { date: "2020-01-01", usedDailyNotional: 123 });

		const migrated = loadTradingState();

		expect(migrated).toEqual({
			paper: { date: "2020-01-01", usedDailyNotional: 123 },
			live: { date: "2020-01-01", usedDailyNotional: 123 },
		});
		expect(migrated.paper).not.toBe(migrated.live);
		expect(configFiles.get(TRADING_STATE_PATH)).toEqual(migrated);
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
