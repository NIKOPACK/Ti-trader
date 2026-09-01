import { describe, expect, it, vi } from "vitest";
import { PreparedPlanError, TradingEngine } from "./engine.ts";
import type { OrderIntent, PreparedOrder } from "./order-plan.ts";
import { OrderPreparationError } from "./order-plan.ts";
import type { TradingEngineConfig } from "./risk.ts";
import type { ExchangeClient, Order, PlaceOrderResult, Ticker } from "./types.ts";

const config: TradingEngineConfig = {
	mode: "paper",
	marketType: "spot",
	positionMode: "one-way",
	quoteCurrency: "USDT",
	risk: { maxOrderNotional: 500, maxDailyNotional: 1_000, allowedSymbols: [] },
};

const futuresConfig: TradingEngineConfig = {
	mode: "paper",
	marketType: "usdm-futures",
	positionMode: "one-way",
	quoteCurrency: "USDT",
	risk: { maxOrderNotional: 500_000, maxDailyNotional: 1_000_000, allowedSymbols: [] },
};

function stateStore() {
	let state = {
		paper: { date: "2026-01-01", usedDailyNotional: 0 },
		live: { date: "2026-01-01", usedDailyNotional: 0 },
	};
	return {
		load: () => state,
		save: (next: typeof state) => {
			state = structuredClone(next);
		},
		transact: <T>(mutator: (next: typeof state) => T): T => {
			const next = structuredClone(state);
			const result = mutator(next);
			state = next;
			return result;
		},
		state: () => state,
	};
}

function client(overrides: Partial<ExchangeClient> = {}): ExchangeClient {
	const ticker: Ticker = { symbol: "BTC/USDT", timestamp: 1, last: 100 };
	const order: Order = {
		id: "1",
		symbol: "BTC/USDT",
		side: "buy",
		type: "market",
		amount: 1,
		filled: 1,
		remaining: 0,
		cost: 100,
		status: "closed",
		timestamp: 1,
	};
	const result: PlaceOrderResult = { order };
	return {
		id: "binance",
		mode: "paper",
		quoteCurrency: "USDT",
		getTicker: async () => ticker,
		getOrderBook: async () => ({ symbol: "BTC/USDT", timestamp: 1, bids: [], asks: [], bidDepth: 0, askDepth: 0 }),
		getMarketInfo: async () => ({
			symbol: "BTC/USDT",
			base: "BTC",
			quote: "USDT",
			marketType: "spot",
			contract: false,
		}),
		getContractStats: async () => ({ symbol: "BTC/USDT" }),
		getKlines: async () => [],
		getBalances: async () => [],
		getPositions: async () => [],
		getOpenOrders: async () => [],
		getOrderHistory: async () => [],
		getOrder: async () => order,
		getOrderByClientId: async () => order,
		getOrderList: async () => ({ id: "1", listOrderStatus: "ALL_DONE", status: "closed", orders: [order] }),
		getOrderListByClientId: async () => ({ id: "1", listOrderStatus: "ALL_DONE", status: "closed", orders: [order] }),
		placeOrder: async () => result,
		placeOcoOrder: async () => ({ orders: [order] }),
		cancelOrder: async () => {},
		cancelOrderList: async () => {},
		getTopMarkets: async () => [],
		getFundingRate: async () => ({ symbol: "BTC/USDT", rate: 0 }),
		getFundingRateHistory: async () => [],
		setLeverage: async () => {},
		setMarginMode: async () => {},
		setMultiAssetsMode: async () => {},
		close: async () => {},
		...overrides,
	};
}

function makeEngine(overrides: Partial<ExchangeClient> = {}) {
	return new TradingEngine(config, client(overrides), stateStore());
}

function makeFuturesEngine(overrides: Partial<ExchangeClient> = {}) {
	return new TradingEngine(futuresConfig, client(overrides), stateStore());
}

const closeIntent: OrderIntent = {
	symbol: "BTC/USDT:USDT",
	type: "market",
	closePosition: true,
};

describe("TradingEngine identity and reservations", () => {
	it("rejects a configuration whose identity differs from the attached client", () => {
		expect(() => new TradingEngine({ ...config, mode: "live" }, client(), stateStore())).toThrow(
			/mode.*does not match/,
		);
		expect(() => new TradingEngine({ ...config, quoteCurrency: "BTC" }, client(), stateStore())).toThrow(
			/quote currency.*does not match/,
		);
	});

	it("exposes only market-data methods through the planning context", () => {
		const trading = makeEngine();
		const view = trading.planningContext.exchange as Record<string, unknown>;
		expect(typeof view.getTicker).toBe("function");
		expect(view.placeOrder).toBeUndefined();
		expect(view.cancelOrder).toBeUndefined();
		expect(Object.isFrozen(view)).toBe(true);
	});

	it("rejects identity changes through setConfig", () => {
		const trading = makeEngine();
		expect(() => trading.setConfig({ ...config, mode: "live" })).toThrow(/cannot change/);
		expect(() => trading.setConfig({ ...config, quoteCurrency: "BTC" })).toThrow(/cannot change/);
		expect(() => trading.setConfig({ ...config, marketType: "both" })).toThrow(/market type.*cannot change/);
		expect(() => trading.setConfig({ ...config, positionMode: "hedge" })).toThrow(/position mode.*cannot change/);
		expect(() => trading.risk.setConfig({ ...config, mode: "live" })).toThrow(/Risk ledger identity cannot change/);
		expect(() => trading.risk.setConfig({ ...config, marketType: "both" })).toThrow(
			/Risk ledger identity cannot change/,
		);
	});

	it("releases a reservation when confirmation is cancelled", async () => {
		const store = stateStore();
		const trading = new TradingEngine(config, client(), store);
		const plan = await trading.prepareOrder("buy", { symbol: "BTC/USDT", type: "market", amount: 1 });
		await expect(trading.placeOrder(plan, { confirm: async () => false })).rejects.toThrow(/cancelled/);
		expect(trading.risk.usage()).toMatchObject({ used: 0, reserved: 0 });
	});

	it("commits unknown submission exactly once", async () => {
		const store = stateStore();
		const placeOrder = vi.fn(async () => {
			throw new Error("network timeout");
		});
		const trading = new TradingEngine(config, client({ placeOrder }), store);
		const plan = await trading.prepareOrder("buy", { symbol: "BTC/USDT", type: "market", amount: 1 });
		await expect(trading.placeOrder(plan, { submissionStatusUnknown: () => true })).rejects.toThrow(/network/);
		await expect(trading.placeOrder(plan, { submissionStatusUnknown: () => true })).rejects.toBeInstanceOf(
			PreparedPlanError,
		);
		expect(placeOrder).toHaveBeenCalledTimes(1);
		expect(trading.risk.usage()).toMatchObject({ used: 100, reserved: 0 });
	});

	it("rejects a plan that was not prepared by this engine", async () => {
		const trading = makeEngine();
		const forged = {
			input: { symbol: "BTC/USDT", side: "buy", type: "market", amount: 1 },
			notional: 100,
			countTowardsDailyLimit: true,
		} as PreparedOrder;
		await expect(trading.placeOrder(forged)).rejects.toThrow(/not prepared by this trading engine/);
	});

	it("keeps the submitted input bound to an immutable prepared snapshot", async () => {
		const placeOrder = vi.fn(async (input) => ({ order: { ...clientOrder(input) } }));
		const trading = makeEngine({ placeOrder });
		const plan = await trading.prepareOrder("buy", { symbol: "BTC/USDT", type: "market", amount: 1 });
		expect(Object.isFrozen(plan)).toBe(true);
		expect(Object.isFrozen(plan.input)).toBe(true);
		const mutable = plan as unknown as { input: { symbol: string; amount: number } };
		expect(() => {
			mutable.input.symbol = "ETH/USDT";
		}).toThrow(TypeError);
		await trading.placeOrder(plan);
		expect(placeOrder).toHaveBeenCalledWith({
			symbol: "BTC/USDT",
			side: "buy",
			type: "market",
			amount: 1,
			price: undefined,
			reduceOnly: undefined,
			positionSide: undefined,
			stopPrice: undefined,
			trailingPercent: undefined,
			closePosition: undefined,
		});
	});
});

function clientOrder(input: { symbol: string; side: "buy" | "sell"; type: "market"; amount: number }): Order {
	return {
		id: "1",
		symbol: input.symbol,
		side: input.side,
		type: input.type,
		amount: input.amount,
		filled: input.amount,
		remaining: 0,
		cost: input.amount * 100,
		status: "closed",
		timestamp: 1,
	};
}

describe("close-position planning with unavailable valuation", () => {
	it("derives a finite amount x reference-price notional when quoteValue is unavailable", async () => {
		const trading = makeFuturesEngine({
			getPositions: async () => [
				{
					symbol: "BTC/USDT:USDT",
					asset: "BTC",
					amount: 2,
					positionSide: "BOTH",
					valuationStatus: "unavailable",
					valuationReason: "mark data unavailable",
				},
			],
		});
		const plan = await trading.prepareOrder("sell", closeIntent);
		expect(plan.amount).toBe(2);
		expect(plan.referencePrice).toBe(100);
		expect(plan.referencePriceSource).toBe("last");
		expect(Number.isFinite(plan.notional)).toBe(true);
		expect(plan.notional).toBe(200);
		expect(plan.input).toMatchObject({ amount: 2, reduceOnly: true, closePosition: true });
		expect(plan.summary).toContain("200.00");
		expect(trading.risk.usage()).toMatchObject({ used: 0, reserved: 0 });
	});

	it("keeps a positive finite quote value as the preferred risk notional", async () => {
		const trading = makeFuturesEngine({
			getPositions: async () => [
				{
					symbol: "BTC/USDT:USDT",
					asset: "BTC",
					amount: 2,
					quoteValue: 640,
					positionSide: "BOTH",
					valuationStatus: "complete",
				},
			],
		});
		const plan = await trading.prepareOrder("sell", closeIntent);
		expect(plan.notional).toBe(640);
		expect(plan.amount).toBe(2);
		expect(plan.summary).toContain("640.00");
	});

	it("falls back to the execution estimate when quoteValue is invalid", async () => {
		const trading = makeFuturesEngine({
			getPositions: async () => [
				{
					symbol: "BTC/USDT:USDT",
					asset: "BTC",
					amount: 2,
					quoteValue: Number.NaN,
					positionSide: "BOTH",
					valuationStatus: "unavailable",
				},
			],
		});
		const plan = await trading.prepareOrder("sell", closeIntent);
		expect(plan.notional).toBe(200);
	});

	it("rejects an overflowing amount x reference-price estimate before any reservation", async () => {
		const trading = makeFuturesEngine({
			getPositions: async () => [
				{
					symbol: "BTC/USDT:USDT",
					asset: "BTC",
					amount: 1e308,
					positionSide: "BOTH",
					valuationStatus: "unavailable",
				},
			],
		});
		const planning = trading.prepareOrder("sell", closeIntent);
		await expect(planning).rejects.toThrow(/Order notional must be positive and finite/);
		await expect(planning).rejects.toBeInstanceOf(OrderPreparationError);
		expect(trading.risk.usage()).toMatchObject({ used: 0, reserved: 0 });
	});
});
