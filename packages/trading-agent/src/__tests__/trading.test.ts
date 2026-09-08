import { closeSync, existsSync, openSync, renameSync, rmSync, unlinkSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type ExchangeClient, TradingEngine, type TradingEngineConfig } from "@nikopack/ti-trading-engine";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const configFiles = vi.hoisted(() => new Map<string, unknown>());
const testStatePath = vi.hoisted(
	() => `${process.cwd()}/.ti-trading-state-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
);
const stateWriteHooks = vi.hoisted(() => ({ beforeWrite: undefined as (() => void) | undefined }));
vi.mock("../state-durability.ts", () => ({ syncTradingStateFile: vi.fn() }));

vi.mock("../config.ts", () => ({
	KEYS_PATH: "keys.json",
	PAPER_DIR: "paper",
	TRADING_CONFIG_PATH: "trading.json",
	TRADING_STATE_PATH: testStatePath,
	readJsonFile<T>(path: string): T | undefined {
		const value = configFiles.get(path);
		return value === undefined ? undefined : (structuredClone(value) as T);
	},
	writeJsonFile(path: string, data: unknown): void {
		configFiles.set(path, structuredClone(data));
		if (path === testStatePath) stateWriteHooks.beforeWrite?.();
	},
}));

import type { Order, Position } from "@nikopack/ti-trading-engine";
import { parseTradingArgs } from "../args.ts";
import { TRADING_CONFIG_PATH, TRADING_STATE_PATH } from "../config.ts";
import { TradingRuntime } from "../context.ts";
import { isProtection, protectionCoverage, reduceSide } from "../monitor.ts";
import {
	DEFAULT_CONFIG,
	loadTradingConfig,
	loadTradingState,
	normalizeTradingConfig,
	saveTradingConfig,
	saveTradingState,
	type TradingConfig,
	type TradingState,
	transactTradingState,
	validateTradingConfig,
} from "../state.ts";
import { createCheckOrderTool, createGetRiskStatusTool, createTradingTools } from "../tools/index.ts";

const today = (): string => new Date().toISOString().slice(0, 10);

function testExchangeClient(config: TradingConfig): ExchangeClient {
	const unsupported = async (): Promise<never> => {
		throw new Error("Not implemented in trading runtime test");
	};
	return {
		id: config.exchange,
		mode: config.mode,
		quoteCurrency: config.quoteCurrency,
		getTicker: unsupported,
		getOrderBook: unsupported,
		getMarketInfo: unsupported,
		getContractStats: unsupported,
		getKlines: unsupported,
		getBalances: unsupported,
		getPositions: unsupported,
		getOpenOrders: unsupported,
		getOrderHistory: unsupported,
		getOrder: unsupported,
		getOrderByClientId: unsupported,
		getOrderList: unsupported,
		getOrderListByClientId: unsupported,
		placeOrder: unsupported,
		placeOcoOrder: unsupported,
		cancelOrder: unsupported,
		cancelOrderList: unsupported,
		getTopMarkets: unsupported,
		getFundingRate: unsupported,
		getFundingRateHistory: unsupported,
		getEffectiveLeverage: () => config.leverage,
		setLeverage: unsupported,
		setMarginMode: unsupported,
		setMultiAssetsMode: unsupported,
		close: async () => {},
	};
}

function runtimeWithState(
	config: TradingConfig,
	state: TradingState,
	exchangeOverrides: Partial<ExchangeClient> = {},
): TradingRuntime {
	const runtime = Object.create(TradingRuntime.prototype) as TradingRuntime;
	Object.defineProperty(runtime, "currentConfig", { value: config, writable: true, configurable: true });
	const current = structuredClone(state);
	const engineConfig: TradingEngineConfig = {
		mode: config.mode,
		marketType: config.marketType,
		positionMode: config.positionMode,
		quoteCurrency: config.quoteCurrency,
		risk: config.risk,
	};
	const tradingEngine = new TradingEngine(
		engineConfig,
		{ ...testExchangeClient(config), ...exchangeOverrides },
		{
			load: () => current,
			save: (next) => Object.assign(current, structuredClone(next)),
			transact: <T>(mutator: (next: TradingState) => T): T => {
				const draft = structuredClone(current);
				const result = mutator(draft);
				Object.assign(current, draft);
				return result;
			},
		},
		undefined,
		{ durability: "memory", accountId: "fixture-account" },
	);
	Object.defineProperty(runtime, "tradingEngine", { value: tradingEngine });
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
	stateWriteHooks.beforeWrite = undefined;
	for (const path of [`${testStatePath}.lock`, `${testStatePath}.lock.replaced`]) {
		if (existsSync(path)) unlinkSync(path);
	}
});

afterAll(() => {
	rmSync(testStatePath, { force: true });
	rmSync(`${testStatePath}.lock`, { force: true });
	rmSync(`${testStatePath}.lock.replaced`, { force: true });
});

describe("trading configuration", () => {
	it("accepts the default configuration", () => expect(() => validateTradingConfig(DEFAULT_CONFIG)).not.toThrow());
	it.each([null, 0, "false", undefined])("rejects non-boolean confirmLiveOrders (%s)", (confirmLiveOrders) => {
		configFiles.set(TRADING_CONFIG_PATH, { ...DEFAULT_CONFIG, confirmLiveOrders });

		expect(() => loadTradingConfig()).toThrow(/confirmLiveOrders must be a boolean/);
	});
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
		expect(runtime.tradingEngine.risk.check("BTC/USDT", 100)).toBeNull();
		expect(runtime.tradingEngine.risk.check("ETH/USDT:USDT", 100)).toBeNull();
		expect(runtime.tradingEngine.risk.check("SOL/USDT", 100)).toMatch(/allowedSymbols/);
	});
	it.each(["/USDT", "BTC/USDT:USDT:USDT", "BTC//USDT"])("rejects malformed allowlist symbol %s", (symbol) => {
		expect(() =>
			validateTradingConfig({
				...DEFAULT_CONFIG,
				risk: { ...DEFAULT_CONFIG.risk, allowedSymbols: [symbol] },
			}),
		).toThrow(/risk.allowedSymbols/);
	});
	it("revalidates command-line overrides before creating an exchange client", async () => {
		configFiles.set(TRADING_CONFIG_PATH, {
			...DEFAULT_CONFIG,
			exchange: "binance",
			marketType: "usdm-futures",
		});

		const runtime = await TradingRuntime.init({ exchange: "okx" });
		expect(runtime.config).toMatchObject({ marketType: "spot", exchange: "okx" });
		expect(configFiles.get(TRADING_CONFIG_PATH)).toMatchObject({
			exchange: "binance",
			marketType: "usdm-futures",
		});
		await runtime.close();
	});
	it("normalizes market type when a live Binance config is switched to paper OKX", async () => {
		configFiles.set(TRADING_CONFIG_PATH, {
			...DEFAULT_CONFIG,
			mode: "live",
			exchange: "binance",
			marketType: "usdm-futures",
		});

		const runtime = await TradingRuntime.init({ mode: "paper", exchange: "okx" });
		expect(runtime.config.marketType).toBe("spot");
		expect(runtime.tradingEngine.risk.check("BTC/USDT", 100)).toBeNull();
		expect(configFiles.get(TRADING_CONFIG_PATH)).toMatchObject({
			mode: "live",
			exchange: "binance",
			marketType: "usdm-futures",
		});
		await runtime.close();
	});
	it("rewrites a futures allowlist when CLI overrides coerce to spot", async () => {
		configFiles.set(TRADING_CONFIG_PATH, {
			...DEFAULT_CONFIG,
			exchange: "binance",
			marketType: "usdm-futures",
			risk: { ...DEFAULT_CONFIG.risk, allowedSymbols: ["BTC/USDT:USDT", "ETH/USDT:USDT"] },
		});

		const runtime = await TradingRuntime.init({ exchange: "okx" });
		expect(runtime.config.marketType).toBe("spot");
		expect(runtime.config.risk.allowedSymbols).toEqual(["BTC/USDT", "ETH/USDT"]);
		expect(runtime.tradingEngine.risk.check("BTC/USDT", 100)).toBeNull();
		expect(runtime.tradingEngine.risk.check("ETH/USDT:USDT", 100)).toMatch(/quote currency/);
		expect(configFiles.get(TRADING_CONFIG_PATH)).toMatchObject({
			exchange: "binance",
			marketType: "usdm-futures",
			risk: expect.objectContaining({ allowedSymbols: ["BTC/USDT:USDT", "ETH/USDT:USDT"] }),
		});
		await runtime.close();
	});
	it("rejects a coerced allowlist that has no compatible spot symbols", () => {
		expect(() =>
			normalizeTradingConfig({
				...DEFAULT_CONFIG,
				exchange: "okx",
				marketType: "usdm-futures",
				risk: { ...DEFAULT_CONFIG.risk, allowedSymbols: ["BTC/USDC:USDC"] },
			}),
		).toThrow(/coerced to spot.*BTC\/USDC:USDC/);
	});
	it("rejects a stored non-Binance futures config instead of rewriting it", () => {
		configFiles.set(TRADING_CONFIG_PATH, {
			...DEFAULT_CONFIG,
			exchange: "okx",
			marketType: "usdm-futures",
		});
		expect(() => loadTradingConfig()).toThrow(/Binance/);
	});
	it("does not coerce when persisting an incompatible market type", () => {
		expect(() => saveTradingConfig({ ...DEFAULT_CONFIG, marketType: "usdm-futures" })).toThrow(/Binance/);
		expect(configFiles.get(TRADING_CONFIG_PATH)).toBeUndefined();
	});
	it("does not persist a coerced market type when switching exchange", async () => {
		configFiles.set(TRADING_CONFIG_PATH, {
			...DEFAULT_CONFIG,
			exchange: "binance",
			marketType: "usdm-futures",
		});
		const runtime = await TradingRuntime.init();
		await expect(runtime.setExchange("okx")).rejects.toThrow(/Binance/);
		expect(runtime.config).toMatchObject({ exchange: "binance", marketType: "usdm-futures" });
		expect(configFiles.get(TRADING_CONFIG_PATH)).toMatchObject({
			exchange: "binance",
			marketType: "usdm-futures",
		});
		await runtime.close();
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
		expect(protectionCoverage(order({ amount: 0.5, filled: 0.1 }), position())).toBe("partial");
		expect(isProtection(order({ amount: 0.5, filled: 0.5 }), position())).toBe(false);
		expect(isProtection(order({ symbol: "ETH/USDT" }), position())).toBe(false);
	});
	it("requires position-side matches for hedge-mode protection", () => {
		const long = position({ positionSide: "LONG" });
		expect(isProtection(order({ positionSide: "LONG" }), long, 95, "hedge")).toBe(true);
		expect(isProtection(order({ positionSide: "SHORT" }), long, 95, "hedge")).toBe(false);
		expect(protectionCoverage(order({ positionSide: "SHORT" }), long, 95, "hedge")).toBe("none");
	});
	it("matches protection for an unvalued position without quote data", () => {
		const unvalued = position({
			quoteValue: undefined,
			valuationStatus: "unavailable",
			valuationReason: "Ticker for BTC/USDT did not provide a finite positive last price",
		});
		expect(reduceSide(unvalued)).toBe("sell");
		expect(isProtection(order({ type: "stop_market" }), unvalued)).toBe(true);
		expect(isProtection(order({ type: "limit" }), unvalued)).toBe(false);
	});
});

describe("market data tool registration", () => {
	it("exposes market integrity tools", () => {
		const names = createTradingTools().map((tool) => tool.name);
		expect(names).toEqual(expect.arrayContaining(["get_order_book", "get_market_info", "get_contract_stats"]));
	});
});

describe("risk accounting", () => {
	it("reports a persisted pause through the risk-status tool", async () => {
		const runtime = runtimeWithState(
			DEFAULT_CONFIG,
			{
				paper: { date: today(), usedDailyNotional: 100 },
				live: { date: today(), usedDailyNotional: 0 },
			},
			{
				getOpenOrders: async () => [],
				getPositions: async () => [],
				getOrderHistory: async () => [],
			},
		);
		const pause = runtime.tradingEngine.risk.pauseNewExposure("Investigate exchange orders");
		const tool = createGetRiskStatusTool(() => runtime);
		const result = await tool.execute("risk-status", {}, undefined, undefined, { hasUI: false } as ExtensionContext);
		expect(result.details).toMatchObject({
			newExposurePaused: true,
			usage: { used: 100, newExposurePause: pause },
			warnings: expect.arrayContaining([
				expect.stringContaining("New exposure is paused: Investigate exchange orders"),
			]),
		});
	});

	it("rejects paused entry previews without reserving quota but still previews spot exits", async () => {
		const runtime = runtimeWithState(
			DEFAULT_CONFIG,
			{
				paper: { date: today(), usedDailyNotional: 0 },
				live: { date: today(), usedDailyNotional: 0 },
			},
			{
				getTicker: async () => ({ symbol: "BTC/USDT", last: 100, timestamp: Date.now() }),
				getMarketInfo: async () => ({
					symbol: "BTC/USDT",
					base: "BTC",
					quote: "USDT",
					contract: false,
					marketType: "spot",
					active: true,
					orderTypes: ["MARKET"],
				}),
				getBalances: async () => [
					{ asset: "USDT", free: 1000, used: 0, total: 1000 },
					{ asset: "BTC", free: 10, used: 0, total: 10 },
				],
			},
		);
		runtime.tradingEngine.risk.pauseNewExposure("Investigate exchange orders");
		const tool = createCheckOrderTool(() => runtime);
		const ctx = { hasUI: false } as ExtensionContext;
		const buy = await tool.execute(
			"entry",
			{ side: "buy", symbol: "BTC/USDT", type: "market", amount: 1 },
			undefined,
			undefined,
			ctx,
		);
		expect(buy.details).toMatchObject({
			status: "rejected",
			risk: { allowed: false, reason: expect.stringContaining("New exposure is paused"), usage: { reserved: 0 } },
		});
		const sell = await tool.execute(
			"exit",
			{ side: "sell", symbol: "BTC/USDT", type: "market", amount: 1 },
			undefined,
			undefined,
			ctx,
		);
		expect(sell.details).toMatchObject({ risk: { allowed: true, countTowardsDailyLimit: false } });
		expect(runtime.tradingEngine.risk.usage()).toMatchObject({ used: 0, reserved: 0 });
	});

	it("allows protective sell orders when the entry quota is exhausted", () => {
		const runtime = runtimeWithUsage(DEFAULT_CONFIG.risk.maxDailyNotional);
		expect(runtime.tradingEngine.risk.check("BTC/USDT", 500, { countTowardsDailyLimit: false })).toBeNull();
	});

	it("still enforces the per-order limit for protective orders", () => {
		const runtime = runtimeWithUsage(DEFAULT_CONFIG.risk.maxDailyNotional);
		expect(runtime.tradingEngine.risk.check("BTC/USDT", 500.01, { countTowardsDailyLimit: false })).toMatch(
			/maxOrderNotional/,
		);
	});

	it("keeps paper and live usage isolated", () => {
		const runtime = runtimeWithUsage(0);
		runtime.tradingEngine.risk.record(125);
		expect(runtime.tradingEngine.risk.usage().used).toBe(125);

		const liveRuntime = runtimeWithUsage(0, {
			...DEFAULT_CONFIG,
			mode: "live",
			risk: { ...DEFAULT_CONFIG.risk, allowedSymbols: [...DEFAULT_CONFIG.risk.allowedSymbols] },
		});
		liveRuntime.tradingEngine.risk.record(250);
		expect(liveRuntime.tradingEngine.risk.usage().used).toBe(250);
		expect(runtime.tradingEngine.risk.usage().used).toBe(125);
	});

	it("blocks a concurrent reservation that would exceed the daily limit", () => {
		const config: TradingConfig = {
			...DEFAULT_CONFIG,
			risk: { ...DEFAULT_CONFIG.risk, maxOrderNotional: 500, maxDailyNotional: 1000 },
		};
		const runtime = runtimeWithUsage(500, config);
		const first = runtime.tradingEngine.risk.reserve("BTC/USDT", 400);

		expect(runtime.tradingEngine.risk.usage().reserved).toBe(400);
		expect(() => runtime.tradingEngine.risk.reserve("BTC/USDT", 200)).toThrow(/reserved by in-flight orders/);

		first.release();
		const second = runtime.tradingEngine.risk.reserve("BTC/USDT", 200);
		second.commit();
		expect(runtime.tradingEngine.risk.usage()).toMatchObject({ used: 700, reserved: 0 });
	});
});

describe("risk symbol validation", () => {
	it("accepts Binance USDⓈ-M symbols with the settlement suffix", () => {
		const runtime = runtimeWithUsage(0, {
			...DEFAULT_CONFIG,
			exchange: "binance",
			marketType: "usdm-futures",
		});
		expect(runtime.tradingEngine.risk.check("BTC/USDT:USDT", 100)).toBeNull();
	});

	it("rejects spot symbols while configured for USDⓈ-M futures", () => {
		const runtime = runtimeWithUsage(0, {
			...DEFAULT_CONFIG,
			exchange: "binance",
			marketType: "usdm-futures",
		});
		expect(runtime.tradingEngine.risk.check("BTC/USDT", 100)).toMatch(/futures quote/);
	});
});

describe("risk state", () => {
	it("persists pauses through runtime reconstruction, quota reset and exchange changes", () => {
		const createEngine = (exchange: string) =>
			new TradingEngine(
				{
					...DEFAULT_CONFIG,
					risk: { ...DEFAULT_CONFIG.risk, allowedSymbols: [...DEFAULT_CONFIG.risk.allowedSymbols] },
				},
				testExchangeClient({ ...DEFAULT_CONFIG, exchange }),
				{
					load: loadTradingState,
					save: saveTradingState,
					transact: transactTradingState,
				},
			);
		const first = createEngine("okx");
		first.risk.record(100);
		const pause = first.risk.pauseNewExposure("Investigate exchange orders");
		expect(loadTradingState().paper.newExposurePause).toEqual(pause);
		const second = createEngine("binance");
		expect(second.risk.check("BTC/USDT", 100)).toContain("New exposure is paused");
		second.risk.reset();
		const restarted = createEngine("okx");
		expect(restarted.risk.usage()).toMatchObject({ used: 0, newExposurePause: pause });
		restarted.risk.resumeNewExposure(pause.id);
		expect(loadTradingState().paper.newExposurePause).toBeUndefined();
		expect(first.risk.check("BTC/USDT", 100)).toBeNull();
	});

	it.each([
		null,
		[],
		{},
		{ id: "", reason: "Investigate", pausedAt: "2026-01-01T00:00:00.000Z" },
		{ id: "pause-1", reason: " ", pausedAt: "2026-01-01T00:00:00.000Z" },
		{ id: "pause-1", reason: "Investigate", pausedAt: "2026-01-01" },
		{ id: "pause-1", reason: "Investigate", pausedAt: "invalid" },
	])("rejects malformed pause metadata without replacing stored state: %j", (pause) => {
		const stored = {
			paper: { date: today(), usedDailyNotional: 0, newExposurePause: pause },
			live: { date: today(), usedDailyNotional: 0 },
		};
		configFiles.set(TRADING_STATE_PATH, stored);
		expect(() => loadTradingState()).toThrow(/Invalid trading risk state/);
		expect(() =>
			transactTradingState((draft) => {
				draft.paper.usedDailyNotional = 0;
			}),
		).toThrow(/Invalid trading risk state/);
		expect(configFiles.get(TRADING_STATE_PATH)).toEqual(stored);
	});

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
	it("round-trips in-flight reservations instead of dropping them", () => {
		const state: TradingState = {
			paper: {
				date: today(),
				usedDailyNotional: 10,
				reservedDailyNotional: 100,
				reservations: {
					"res-1": { id: "res-1", mode: "paper", symbol: "BTC/USDT", notional: 100 },
				},
			},
			live: { date: today(), usedDailyNotional: 0 },
		};
		saveTradingState(state);
		expect(loadTradingState()).toEqual(state);
	});
	it("rejects malformed reservations", () => {
		expect(() =>
			saveTradingState({
				paper: {
					date: today(),
					usedDailyNotional: 0,
					reservations: { "res-1": { id: "other", mode: "paper", symbol: "BTC/USDT", notional: 100 } },
				},
				live: { date: today(), usedDailyNotional: 0 },
			}),
		).toThrow();
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
	it("releases the state lock when a mutator throws undefined", () => {
		const initial: TradingState = {
			paper: { date: today(), usedDailyNotional: 10 },
			live: { date: today(), usedDailyNotional: 20 },
		};
		configFiles.set(TRADING_STATE_PATH, initial);

		let didThrow = false;
		let thrown: unknown;
		try {
			transactTradingState(() => {
				throw undefined;
			});
		} catch (error) {
			didThrow = true;
			thrown = error;
		}

		expect(didThrow).toBe(true);
		expect(thrown).toBeUndefined();
		expect(configFiles.get(TRADING_STATE_PATH)).toEqual(initial);
		expect(existsSync(`${testStatePath}.lock`)).toBe(false);
	});

	it("does not remove a successor lock while cleaning up its own transaction", () => {
		configFiles.set(TRADING_STATE_PATH, {
			paper: { date: today(), usedDailyNotional: 0 },
			live: { date: today(), usedDailyNotional: 0 },
		});
		stateWriteHooks.beforeWrite = () => {
			stateWriteHooks.beforeWrite = undefined;
			const successorFd = openSync(`${testStatePath}.lock.replaced`, "wx", 0o600);
			closeSync(successorFd);
			renameSync(`${testStatePath}.lock.replaced`, `${testStatePath}.lock`);
		};

		transactTradingState((state) => {
			state.paper.usedDailyNotional = 25;
		});

		expect(existsSync(`${testStatePath}.lock`)).toBe(true);
		unlinkSync(`${testStatePath}.lock`);
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
