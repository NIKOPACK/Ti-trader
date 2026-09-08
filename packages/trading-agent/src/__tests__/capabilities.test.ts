import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type ExchangeClient,
	getTradingCapabilities,
	type MarketInfo,
	type Order,
	type PlaceOrderInput,
	type Position,
	TradingEngine,
	type TradingRiskState,
} from "@earendil-works/ti-trading-engine";
import { describe, expect, it, vi } from "vitest";
import type { TradingRuntime } from "../context.ts";
import { DEFAULT_CONFIG, type TradingConfig } from "../state.ts";
import { createGetTradingCapabilitiesTool } from "../tools/market.ts";
import { createCheckOrderTool, createSellTool } from "../tools/orders.ts";

const uiContext = { hasUI: false } as ExtensionContext;

function fixture(
	options: {
		mode?: "paper" | "live";
		exchange?: string;
		futures?: boolean;
		positionMode?: "one-way" | "hedge";
		orderTypes?: string[];
		metadataError?: boolean;
		positions?: Position[];
	} = {},
) {
	const symbol = options.futures ? "BTC/USDT:USDT" : "BTC/USDT";
	const config: TradingConfig = {
		...DEFAULT_CONFIG,
		mode: options.mode ?? "paper",
		exchange: options.exchange ?? "binance",
		marketType: options.futures ? "usdm-futures" : "spot",
		positionMode: options.positionMode ?? "one-way",
		confirmLiveOrders: false,
	};
	const marketInfo: MarketInfo = {
		symbol,
		base: "BTC",
		quote: "USDT",
		marketType: options.futures ? "swap" : "spot",
		contract: options.futures ?? false,
		active: true,
		...(options.futures
			? {
					settle: "USDT",
					linear: true,
					inverse: false,
					contractSize: 0.01,
					amountStep: 0.001,
					amountUnit: "contracts" as const,
				}
			: {}),
		orderTypes: options.orderTypes,
	};
	const order: Order = {
		id: "contract-order",
		symbol,
		side: "sell",
		type: "market",
		amount: 1,
		filled: 1,
		remaining: 0,
		cost: 100,
		average: 100,
		status: "closed",
		timestamp: 1,
	};
	const placeOrder = vi.fn(async (input: PlaceOrderInput) => ({ order: { ...order, ...input } }));
	const exchange: ExchangeClient = {
		id: config.exchange,
		mode: config.mode,
		quoteCurrency: "USDT",
		getMarketInfo: async () => {
			if (options.metadataError) throw new Error("offline metadata unavailable");
			return marketInfo;
		},
		getTicker: async () => ({ symbol, last: 100, timestamp: 1 }),
		getOrderBook: async () => ({ symbol, timestamp: 1, bids: [], asks: [], bidDepth: 0, askDepth: 0 }),
		getBalances: async () => [
			{ asset: "BTC", free: 10, total: 10, used: 0 },
			{ asset: "USDT", free: 10_000, total: 10_000, used: 0 },
		],
		getPositions: async () => options.positions ?? [],
		getOpenOrders: async () => [],
		getOrderHistory: async () => [],
		getOrder: async () => order,
		getOrderByClientId: async () => order,
		getOrderList: async () => ({ id: "list", listOrderStatus: "ALL_DONE", status: "closed", orders: [order] }),
		getOrderListByClientId: async () => ({
			id: "list",
			listOrderStatus: "ALL_DONE",
			status: "closed",
			orders: [order],
		}),
		getContractStats: async () => ({ symbol }),
		getKlines: async () => [],
		getTopMarkets: async () => [],
		getFundingRate: async () => ({ symbol }),
		getFundingRateHistory: async () => [],
		placeOrder,
		placeOcoOrder: async () => ({ orders: [order] }),
		cancelOrder: async () => {},
		cancelOrderList: async () => {},
		setLeverage: async () => {},
		setMarginMode: async () => {},
		setMultiAssetsMode: async () => {},
		getEffectiveLeverage: () => 1,
		close: async () => {},
	};
	let risk: TradingRiskState = {
		paper: { date: "2026-09-07", usedDailyNotional: 0 },
		live: { date: "2026-09-07", usedDailyNotional: 0 },
	};
	const engine = new TradingEngine(
		config,
		exchange,
		{
			load: () => structuredClone(risk),
			save: (state) => {
				risk = structuredClone(state);
			},
			transact: <T>(mutate: (state: TradingRiskState) => T) => {
				const next = structuredClone(risk);
				const result = mutate(next);
				risk = next;
				return result;
			},
		},
		undefined,
		{ durability: "memory", accountId: "capability-contract" },
	);
	const runtime = { config, mode: config.mode, tradingEngine: engine } as unknown as TradingRuntime;
	return { provider: () => runtime, engine, placeOrder, symbol, marketInfo, config };
}

describe("shared capability output and preflight", () => {
	it.each([
		{ mode: "paper", futures: false },
		{ mode: "paper", futures: true },
		{ mode: "live", futures: false },
		{ mode: "live", futures: true, positionMode: "hedge" },
		{ mode: "live", futures: false, exchange: "okx" },
	] as const)("renders the engine source of truth for %j", async (options) => {
		const { provider, symbol, marketInfo, config } = fixture(options);
		const expected = getTradingCapabilities({
			exchangeId: config.exchange,
			mode: config.mode,
			marketFamily: options.futures ? "futures" : "spot",
			positionMode: config.positionMode,
			marketInfo,
			metadataValid: true,
		});
		const result = await createGetTradingCapabilitiesTool(provider).execute(
			"matrix",
			{ symbol },
			undefined,
			undefined,
			uiContext,
		);
		expect(result.details).toMatchObject({
			matrixProfile: expected.profile,
			positionMode: config.positionMode,
			capabilities: {
				orderTypes: expected.orderTypes,
				oco: expected.oco,
				quantity: expected.quantity,
				clientOrderIdLookup: expected.queryOrderByClientId,
				orderIdLookup: expected.queryOrderById,
				orderListLookup: expected.queryOrderListById,
				orderListClientIdLookup: expected.queryOrderListByClientId,
				cancelOrder: expected.cancelOrder,
				cancelOrderList: expected.cancelOrderList,
				positionModes: expected.positionModes,
				closePosition: expected.closePosition,
				reduceOnly: expected.reduceOnly,
			},
		});
	});

	it("rejects Paper futures conditional orders equally in preview and the engine planner", async () => {
		const { provider, symbol, engine, placeOrder } = fixture({ futures: true });
		const params = { symbol, type: "stop_market" as const, amount: 1, stopPrice: 90 };
		const check = await createCheckOrderTool(provider).execute(
			"preview",
			{ ...params, side: "sell" },
			undefined,
			undefined,
			uiContext,
		);
		expect(check.details).toMatchObject({ status: "rejected", reason: expect.stringMatching(/market orders only/) });
		await expect(engine.prepareOrder("sell", params)).rejects.toThrow(/market orders only/);
		await expect(createSellTool(provider).execute("sell", params, undefined, undefined, uiContext)).rejects.toThrow(
			/market orders only/,
		);
		expect(placeOrder).not.toHaveBeenCalled();
	});

	it("uses the same exact metadata denial at preview and final admission", async () => {
		const { provider, symbol, engine, placeOrder } = fixture({ mode: "live", orderTypes: ["MARKET", "STOP_LOSS"] });
		const params = { symbol, type: "stop" as const, amount: 1, price: 90, stopPrice: 90 };
		const advertised = await createGetTradingCapabilitiesTool(provider).execute(
			"matrix",
			{ symbol },
			undefined,
			undefined,
			uiContext,
		);
		expect(advertised.details).toMatchObject({
			capabilities: { orderTypes: { stop: { status: "unsupported" }, stop_market: { status: "supported" } } },
		});
		const checked = await createCheckOrderTool(provider).execute(
			"preview",
			{ ...params, side: "sell" },
			undefined,
			undefined,
			uiContext,
		);
		expect(checked.details).toMatchObject({
			status: "rejected",
			capability: { status: "unsupported", reason: "The exchange market metadata does not support stop orders" },
		});
		const plan = await engine.prepareOrder("sell", params);
		await expect(engine.placeOrder(plan, { allowUnconfirmedLive: true })).rejects.toThrow(
			/does not support stop orders/,
		);
		expect(placeOrder).not.toHaveBeenCalled();
	});

	it("preserves unknown experimental submissions but never advertises them as supported", async () => {
		const { provider, symbol, engine, placeOrder } = fixture({
			mode: "live",
			exchange: "okx",
			orderTypes: ["MARKET"],
		});
		const advertised = await createGetTradingCapabilitiesTool(provider).execute(
			"matrix",
			{ symbol },
			undefined,
			undefined,
			uiContext,
		);
		expect(advertised.details).toMatchObject({
			matrixProfile: "experimental",
			capabilities: {
				orderTypes: { market: { status: "unknown", evidence: { level: "experimental" } } },
				clientOrderIdLookup: { status: "unknown" },
			},
		});
		const params = { symbol, type: "market" as const, amount: 1 };
		const checked = await createCheckOrderTool(provider).execute(
			"preview",
			{ ...params, side: "sell" },
			undefined,
			undefined,
			uiContext,
		);
		expect(checked.details).toMatchObject({
			status: "ok_with_warnings",
			capability: { status: "unknown" },
			blockingReasons: [],
			unknownReasons: [expect.stringMatching(/experimental/)],
		});
		await engine.placeOrder(await engine.prepareOrder("sell", params), { allowUnconfirmedLive: true });
		expect(placeOrder).toHaveBeenCalledOnce();
	});

	it("keeps missing market metadata unknown and displays only offline live evidence", async () => {
		const { provider, symbol } = fixture({ mode: "live", metadataError: true });
		const result = await createGetTradingCapabilitiesTool(provider).execute(
			"matrix",
			{ symbol },
			undefined,
			undefined,
			uiContext,
		);
		expect(result.details).toMatchObject({
			overallStatus: "unknown",
			capabilities: {
				orderTypes: { market: { status: "unknown" } },
				clientOrderIdLookup: { evidence: { level: "offline-contract" } },
			},
			warnings: expect.arrayContaining([expect.stringMatching(/not live\/testnet certification/)]),
		});
		const checked = await createCheckOrderTool(provider).execute(
			"preview",
			{ symbol, side: "sell", type: "market", amount: 1 },
			undefined,
			undefined,
			uiContext,
		);
		expect(checked.details).toMatchObject({ status: "unknown", capability: { status: "unknown" } });
	});

	it("previews Binance hedge close-all without inventing an explicit exchange quantity", async () => {
		const symbol = "BTC/USDT:USDT";
		const { provider } = fixture({
			mode: "live",
			futures: true,
			positionMode: "hedge",
			positions: [{ symbol, asset: "BTC", amount: 0.015, positionSide: "LONG", quoteValue: 1.5 }],
		});
		const checked = await createCheckOrderTool(provider).execute(
			"preview",
			{
				symbol,
				side: "sell",
				type: "stop_market",
				stopPrice: 90,
				closePosition: true,
				positionSide: "LONG",
			},
			undefined,
			undefined,
			uiContext,
		);
		expect(checked.details).toMatchObject({
			status: "ok_with_warnings",
			capability: { status: "supported", evidence: { level: "offline-contract" } },
			resolution: {
				amount: 0.015,
				exchangeAmount: null,
				exchangeAmountUnit: "contracts",
				exchangeQuantitySemantics: "close_all_trigger_may_omit_quantity",
			},
			executionConstraints: { reduceOnlyRequested: true, reduceOnlyApplied: false },
		});
	});
});
