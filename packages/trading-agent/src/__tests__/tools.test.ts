import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
	Balance,
	ContractStats,
	ExchangeClient,
	MarketInfo,
	Order,
	PlaceOcoOrderInput,
	PlaceOrderInput,
	Position,
	Ticker,
	TradingRiskState,
} from "@earendil-works/ti-trading-engine";
import { TradingEngine } from "@earendil-works/ti-trading-engine";
import { describe, expect, it, vi } from "vitest";
import type { TradingRuntime } from "../context.ts";
import { DEFAULT_CONFIG, type TradingConfig } from "../state.ts";
import { formatOrder } from "../tools/format.ts";
import {
	createBuyTool,
	createCancelOrderListTool,
	createCancelOrderTool,
	createCheckOrderTool,
	createGetBalanceTool,
	createGetContractStatsTool,
	createGetFuturesPositionsTool,
	createGetPortfolioSnapshotTool,
	createGetPositionsTool,
	createGetRiskStatusTool,
	createGetTopMarketsTool,
	createGetTradingCapabilitiesTool,
	createPlaceOcoTool,
	createSellTool,
	createTradingTools,
} from "../tools/index.ts";

type SellToolParams = Parameters<ReturnType<typeof createSellTool>["execute"]>[1];

function filledOrder(input: PlaceOrderInput): Order {
	return {
		id: "filled-1",
		clientOrderId: input.clientOrderId,
		symbol: input.symbol,
		side: input.side,
		type: input.type,
		price: input.price,
		stopPrice: input.stopPrice,
		positionSide: input.positionSide,
		reduceOnly: input.reduceOnly,
		closePosition: input.closePosition,
		amount: input.amount,
		filled: input.amount,
		remaining: 0,
		average: 100,
		cost: input.amount * 100,
		status: "closed",
		timestamp: 1,
	};
}

function createRuntime(
	options: {
		config?: TradingConfig;
		positions?: Position[];
		balances?: Balance[];
		openOrders?: Order[];
		marketInfo?: MarketInfo;
		marketInfoError?: Error;
		balancesError?: Error;
		topMarkets?: Ticker[];
		contractStats?: ContractStats;
		contractStatsError?: Error;
		tickerLast?: number;
	} = {},
) {
	const config = options.config ?? DEFAULT_CONFIG;
	const placeOrder = vi.fn(async (input: PlaceOrderInput) => ({ order: filledOrder(input) }));
	const placeOcoOrder = vi.fn(
		async (input: PlaceOcoOrderInput): Promise<{ orders: Order[] }> => ({
			orders: [
				{
					id: "oco-stop",
					clientOrderId: input.belowClientOrderId,
					listClientOrderId: input.listClientOrderId,
					orderListId: "list-1",
					symbol: input.symbol,
					side: input.side,
					type: "stop_market",
					stopPrice: input.stopLossPrice,
					amount: input.amount,
					filled: 0,
					remaining: input.amount,
					cost: 0,
					status: "open",
					timestamp: 1,
				},
				{
					id: "oco-take",
					clientOrderId: input.aboveClientOrderId,
					listClientOrderId: input.listClientOrderId,
					orderListId: "list-1",
					symbol: input.symbol,
					side: input.side,
					type: "take_profit_market",
					stopPrice: input.takeProfitPrice,
					amount: input.amount,
					filled: 0,
					remaining: input.amount,
					cost: 0,
					status: "open",
					timestamp: 1,
				},
			],
		}),
	);
	const cancelOrder = vi.fn(async (_id: string, _symbol?: string) => {});
	const cancelOrderList = vi.fn(async (_orderListId: string, _symbol?: string) => {});
	const getPositions = vi.fn(async () => options.positions ?? []);
	const getBalances = vi.fn(async () => {
		if (options.balancesError) throw options.balancesError;
		return options.balances ?? [];
	});
	const getOpenOrders = vi.fn(async () => options.openOrders ?? []);
	const getMarketInfo = vi.fn(async (symbol: string): Promise<MarketInfo> => {
		if (options.marketInfoError) throw options.marketInfoError;
		const futures = symbol.endsWith(`/${config.quoteCurrency}:${config.quoteCurrency}`);
		return (
			options.marketInfo ?? {
				symbol,
				base: symbol.split("/")[0],
				quote: config.quoteCurrency,
				settle: futures ? config.quoteCurrency : undefined,
				marketType: futures ? "swap" : "spot",
				contract: futures,
				linear: futures ? true : undefined,
				contractSize: futures ? 1 : undefined,
				active: true,
			}
		);
	});
	const getTopMarkets = vi.fn(async () => options.topMarkets ?? []);
	const getContractStats = vi.fn(async (symbol: string): Promise<ContractStats> => {
		if (options.contractStatsError) throw options.contractStatsError;
		return options.contractStats ?? { symbol, lastPrice: 100, markPrice: 100, indexPrice: 100, fundingRate: 0.0001 };
	});
	const unsupportedRead = vi.fn(async () => {
		throw new Error("Not implemented in trading tool test");
	});
	const exchange = {
		id: config.exchange,
		mode: config.mode,
		quoteCurrency: config.quoteCurrency,
		getTicker: vi.fn(async (symbol: string) => {
			const last = options.tickerLast ?? 100;
			return {
				symbol,
				last,
				bid: last * 0.99,
				ask: last * 1.01,
				timestamp: 1,
			};
		}),
		getPositions,
		getBalances,
		getOpenOrders,
		getMarketInfo,
		getTopMarkets,
		getContractStats,
		getOrderBook: unsupportedRead,
		getKlines: unsupportedRead,
		getOrderHistory: unsupportedRead,
		getOrder: unsupportedRead,
		getOrderByClientId: unsupportedRead,
		getOrderList: unsupportedRead,
		getOrderListByClientId: unsupportedRead,
		getFundingRate: unsupportedRead,
		getFundingRateHistory: unsupportedRead,
		getEffectiveLeverage: () => config.leverage,
		placeOrder,
		placeOcoOrder,
		cancelOrder,
		cancelOrderList,
	} as unknown as ExchangeClient;
	const checkRisk = vi.fn(() => null as string | null);
	let riskState: TradingRiskState = {
		paper: { date: "2026-08-28", usedDailyNotional: 0 },
		live: { date: "2026-08-28", usedDailyNotional: 0 },
	};
	const stateStore = {
		load: () => structuredClone(riskState),
		save: (next: TradingRiskState) => {
			riskState = structuredClone(next);
		},
		transact: <T>(mutator: (next: TradingRiskState) => T): T => {
			const next = structuredClone(riskState);
			const result = mutator(next);
			riskState = structuredClone(next);
			return result;
		},
	};
	const engine = new TradingEngine(
		{
			mode: config.mode,
			marketType: config.marketType,
			positionMode: config.positionMode,
			quoteCurrency: config.quoteCurrency,
			risk: config.risk,
		},
		exchange,
		stateStore,
		undefined,
		{ accountId: "fixture-account", durability: "memory" },
	);
	vi.spyOn(engine.risk, "check").mockImplementation(checkRisk);
	const runtime = {
		config,
		mode: config.mode,
		tradingEngine: engine,
	} as unknown as TradingRuntime;
	return {
		getBalances,
		getContractStats,
		getMarketInfo,
		getOpenOrders,
		getPositions,
		getTopMarkets,
		placeOrder,
		placeOcoOrder,
		cancelOrder,
		cancelOrderList,
		checkRisk,
		runtime,
	};
}

const context = {
	hasUI: false,
	ui: { confirm: vi.fn(), notify: vi.fn() },
} as unknown as ExtensionContext;

/** The serialized text payload of a jsonResult tool response. */
function serializedText(result: { content: Array<{ type: string; text?: string }> }): string {
	const content = result.content[0];
	if (content?.type !== "text") throw new Error("expected text tool content");
	return content.text ?? "";
}

describe("trading order tools", () => {
	it("shares the order plan between check_order and sell without reserving or submitting", async () => {
		const { placeOrder, runtime } = createRuntime({
			balances: [{ asset: "BTC", free: 2, used: 0, total: 2, quoteValue: 200 }],
		});
		const sell = createSellTool(() => runtime);
		const check = createCheckOrderTool(() => runtime);
		const params = { symbol: "BTC/USDT", type: "limit" as const, amount: 1, price: 98 };

		const previewResult = await check.execute("preview", { side: "sell", ...params }, undefined, undefined, context);
		const preview = previewResult.details as {
			status: string;
			input: PlaceOrderInput;
			resolution: { amount: number; estimatedNotional: number; referenceSource: string };
		};
		expect(preview.status).toBe("ok");
		expect(preview.input).toMatchObject({
			symbol: "BTC/USDT",
			side: "sell",
			type: "limit",
			amount: 1,
			price: 98,
		});
		expect(preview.resolution).toMatchObject({ amount: 1, estimatedNotional: 98, referenceSource: "limit_price" });
		expect(runtime.tradingEngine.listExecutions()).toEqual([]);
		expect(placeOrder).not.toHaveBeenCalled();

		await sell.execute("sell", params, undefined, undefined, context);
		expect(placeOrder).toHaveBeenCalledWith({ ...preview.input, clientOrderId: expect.stringMatching(/^ti/) });
	});

	it("exposes check_order as a single object schema without allOf", () => {
		const check = createCheckOrderTool(() => createRuntime().runtime);
		const schema = check.parameters as {
			type?: string;
			allOf?: unknown;
			required?: string[];
			properties?: Record<string, unknown>;
		};
		expect(schema.allOf).toBeUndefined();
		expect(schema.type).toBe("object");
		expect(schema.required).toEqual(expect.arrayContaining(["side", "symbol", "type"]));
		expect(schema.properties).toMatchObject({
			side: expect.anything(),
			symbol: expect.anything(),
			type: expect.anything(),
		});
	});

	it("returns a structured preflight rejection for invalid order intent", async () => {
		const { placeOrder, runtime } = createRuntime();
		const check = createCheckOrderTool(() => runtime);

		const result = await check.execute(
			"invalid",
			{ side: "buy", symbol: "BTC/USDT", type: "limit", quoteAmount: 100 },
			undefined,
			undefined,
			context,
		);
		const data = result.details as { status: string; reason: string };
		expect(data).toMatchObject({ status: "rejected", reason: "limit orders require a positive price" });
		expect(runtime.tradingEngine.listExecutions()).toEqual([]);
		expect(placeOrder).not.toHaveBeenCalled();
	});

	it("rejects fields that the selected order type would silently ignore", async () => {
		const { placeOrder, runtime } = createRuntime({
			balances: [{ asset: "USDT", free: 10_000, used: 0, total: 10_000, quoteValue: 10_000 }],
		});
		const check = createCheckOrderTool(() => runtime);

		const result = await check.execute(
			"ignored-price",
			{ side: "buy", symbol: "BTC/USDT", type: "market", amount: 1, price: 1 },
			undefined,
			undefined,
			context,
		);
		const data = result.details as { status: string; reason: string };
		expect(data).toMatchObject({
			status: "rejected",
			reason: "market orders do not accept price; use price only for limit execution",
		});
		expect(placeOrder).not.toHaveBeenCalled();
	});

	it("rejects a conditional order whose trigger is already on the firing side", async () => {
		const { runtime } = createRuntime();
		const check = createCheckOrderTool(() => runtime);

		const result = await check.execute(
			"immediate-stop",
			{ side: "sell", symbol: "BTC/USDT", type: "stop_market", amount: 1, stopPrice: 101 },
			undefined,
			undefined,
			context,
		);
		const data = result.details as { status: string; reason: string };
		expect(data.status).toBe("rejected");
		expect(data.reason).toMatch(/must be below the current last price/);
	});

	it("returns unknown instead of ok when market metadata cannot be read", async () => {
		const { runtime } = createRuntime({
			balances: [{ asset: "USDT", free: 10_000, used: 0, total: 10_000, quoteValue: 10_000 }],
			marketInfoError: new Error("exchange timeout"),
		});
		const check = createCheckOrderTool(() => runtime);

		const result = await check.execute(
			"metadata-timeout",
			{ side: "buy", symbol: "BTC/USDT", type: "market", amount: 1 },
			undefined,
			undefined,
			context,
		);
		const data = result.details as { status: string; unknownReasons: string[]; blockingReasons: string[] };
		expect(data.status).toBe("unknown");
		expect(data.unknownReasons.join(" ")).toMatch(/exchange timeout/);
		expect(data.blockingReasons.length).toBeGreaterThan(0);
	});

	it("returns unknown instead of ok when balances cannot be read", async () => {
		const { runtime } = createRuntime({
			marketInfo: {
				symbol: "BTC/USDT",
				base: "BTC",
				quote: "USDT",
				marketType: "spot",
				contract: false,
				active: true,
			},
			balancesError: new Error("account unavailable"),
		});
		const check = createCheckOrderTool(() => runtime);

		const result = await check.execute(
			"balance-timeout",
			{ side: "sell", symbol: "BTC/USDT", type: "market", amount: 1 },
			undefined,
			undefined,
			context,
		);
		const data = result.details as { status: string; unknownReasons: string[] };
		expect(data.status).toBe("unknown");
		expect(data.unknownReasons.join(" ")).toMatch(/account unavailable/);
	});

	it("allows live futures preflight with explicit fee and maintenance-margin warnings", async () => {
		const { runtime } = createRuntime({
			config: {
				...DEFAULT_CONFIG,
				mode: "live",
				exchange: "binance",
				marketType: "usdm-futures",
				leverage: 10,
				confirmLiveOrders: false,
			},
			balances: [{ asset: "USDT", free: 1_000, used: 0, total: 1_000, quoteValue: 1_000 }],
			marketInfo: {
				symbol: "BTC/USDT:USDT",
				base: "BTC",
				quote: "USDT",
				settle: "USDT",
				marketType: "swap",
				contract: true,
				linear: true,
				inverse: false,
				contractSize: 1,
				active: true,
			},
		});
		const check = createCheckOrderTool(() => runtime);

		const result = await check.execute(
			"live-futures-warning",
			{ side: "buy", symbol: "BTC/USDT:USDT", type: "market", amount: 1 },
			undefined,
			undefined,
			context,
		);
		const data = result.details as {
			status: string;
			margin: { sufficient: boolean | null; source: string };
			blockingReasons: string[];
			unknownReasons: string[];
			nonBlockingWarnings: string[];
			warnings: string[];
		};
		const warning = expect.stringMatching(/fee and maintenance-margin/);
		expect(data.status).toBe("ok_with_warnings");
		expect(data.margin).toMatchObject({ sufficient: null, source: "adapter-data-unavailable" });
		expect(data.blockingReasons).toEqual([]);
		expect(data.unknownReasons).toEqual(expect.arrayContaining([warning]));
		expect(data.nonBlockingWarnings).toEqual(expect.arrayContaining([warning]));
		expect(data.warnings).toEqual(expect.arrayContaining([warning]));
	});

	it("resolves futures preview amounts from base units to contract units", async () => {
		const { runtime } = createRuntime({
			config: { ...DEFAULT_CONFIG, exchange: "binance", marketType: "usdm-futures", leverage: 10 },
			balances: [{ asset: "USDT", free: 10_000, used: 0, total: 10_000, quoteValue: 10_000 }],
			marketInfo: {
				symbol: "BTC/USDT:USDT",
				base: "BTC",
				quote: "USDT",
				settle: "USDT",
				marketType: "swap",
				contract: true,
				linear: true,
				inverse: false,
				contractSize: 10,
				amountUnit: "contracts",
				limits: { amount: { min: 1, max: 3 } },
				active: true,
			},
		});
		const check = createCheckOrderTool(() => runtime);

		const result = await check.execute(
			"contract-size-preview",
			{ side: "buy", symbol: "BTC/USDT:USDT", type: "market", amount: 20 },
			undefined,
			undefined,
			context,
		);
		const data = result.details as {
			status: string;
			resolution: {
				amount: number;
				requestedAmount: number;
				exchangeAmount: number | null;
				exchangeAmountUnit: string;
				contractSize: number | null;
			};
			market: {
				amountUnit: string;
				contractSize: number | null;
				limits?: { amount?: { min?: number; max?: number } };
			};
		};
		expect(data.status).toBe("ok");
		expect(data.resolution).toMatchObject({
			amount: 20,
			requestedAmount: 20,
			exchangeAmount: 2,
			exchangeAmountUnit: "contracts",
			contractSize: 10,
		});
		expect(data.market).toMatchObject({ amountUnit: "contracts", contractSize: 10 });
	});

	it("snaps futures quoteAmount onto a contract lot before check_order returns ok", async () => {
		const { placeOrder, runtime } = createRuntime({
			config: { ...DEFAULT_CONFIG, exchange: "binance", marketType: "usdm-futures", leverage: 10 },
			tickerLast: 0.08224,
			balances: [{ asset: "USDT", free: 1_000, used: 0, total: 1_000, quoteValue: 1_000 }],
			marketInfo: {
				symbol: "DOGE/USDT:USDT",
				base: "DOGE",
				quote: "USDT",
				settle: "USDT",
				marketType: "swap",
				contract: true,
				linear: true,
				inverse: false,
				contractSize: 1,
				amountUnit: "contracts",
				amountPrecision: 0,
				minAmount: 1,
				minNotional: 5,
				active: true,
			},
		});
		const check = createCheckOrderTool(() => runtime);
		const buy = createBuyTool(() => runtime);
		const params = { symbol: "DOGE/USDT:USDT", type: "market" as const, quoteAmount: 5 };

		const preview = (await check.execute("quote-lot", { side: "buy", ...params }, undefined, undefined, context))
			.details as {
			status: string;
			input: PlaceOrderInput;
			resolution: { amount: number; estimatedNotional: number };
		};
		expect(preview.status).toBe("ok");
		expect(preview.input.amount).toBe(61);
		expect(preview.resolution.amount).toBe(61);
		expect(preview.resolution.estimatedNotional).toBeGreaterThanOrEqual(5);

		await buy.execute("buy", params, undefined, undefined, context);
		expect(placeOrder).toHaveBeenCalledWith(expect.objectContaining({ symbol: "DOGE/USDT:USDT", amount: 61 }));
	});

	it("snaps Binance TICK_SIZE amountPrecision 1 to whole contracts", async () => {
		const { placeOrder, runtime } = createRuntime({
			config: { ...DEFAULT_CONFIG, exchange: "binance", marketType: "usdm-futures", leverage: 10 },
			tickerLast: 0.08241,
			balances: [{ asset: "USDT", free: 1_000, used: 0, total: 1_000, quoteValue: 1_000 }],
			marketInfo: {
				symbol: "DOGE/USDT:USDT",
				base: "DOGE",
				quote: "USDT",
				settle: "USDT",
				marketType: "swap",
				contract: true,
				linear: true,
				inverse: false,
				contractSize: 1,
				amountUnit: "contracts",
				amountPrecision: 1,
				amountStep: 1,
				minAmount: 1,
				minNotional: 5,
				active: true,
			},
		});
		const check = createCheckOrderTool(() => runtime);
		const buy = createBuyTool(() => runtime);
		const params = { symbol: "DOGE/USDT:USDT", type: "market" as const, quoteAmount: 20 };
		const preview = (await check.execute("tick-size", { side: "buy", ...params }, undefined, undefined, context))
			.details as { status: string; input: PlaceOrderInput };
		expect(preview.status).toBe("ok");
		expect(preview.input.amount).toBe(241);
		await buy.execute("buy", params, undefined, undefined, context);
		expect(placeOrder).toHaveBeenCalledWith(expect.objectContaining({ symbol: "DOGE/USDT:USDT", amount: 241 }));
	});

	it("rejects an explicit futures amount that is not on the contract grid", async () => {
		const { placeOrder, runtime } = createRuntime({
			config: { ...DEFAULT_CONFIG, exchange: "binance", marketType: "usdm-futures", leverage: 10 },
			tickerLast: 0.08224,
			balances: [{ asset: "USDT", free: 1_000, used: 0, total: 1_000, quoteValue: 1_000 }],
			marketInfo: {
				symbol: "DOGE/USDT:USDT",
				base: "DOGE",
				quote: "USDT",
				settle: "USDT",
				marketType: "swap",
				contract: true,
				linear: true,
				inverse: false,
				contractSize: 1,
				amountUnit: "contracts",
				amountPrecision: 0,
				minAmount: 1,
				minNotional: 5,
				active: true,
			},
		});
		const check = createCheckOrderTool(() => runtime);
		const result = await check.execute(
			"off-grid",
			{ side: "buy", symbol: "DOGE/USDT:USDT", type: "market", amount: 60.79766536964981 },
			undefined,
			undefined,
			context,
		);
		const data = result.details as { status: string; reason: string };
		expect(data.status).toBe("rejected");
		expect(data.reason).toMatch(/cannot be represented exactly/);
		expect(placeOrder).not.toHaveBeenCalled();
	});

	it("checks the futures wallet in both mode and rejects insufficient margin", async () => {
		const { runtime } = createRuntime({
			config: { ...DEFAULT_CONFIG, exchange: "binance", marketType: "both", leverage: 10 },
			balances: [
				{ asset: "USDT", free: 10_000, used: 0, total: 10_000, quoteValue: 10_000 },
				{ asset: "futures:USDT", free: 1, used: 0, total: 1, quoteValue: 1 },
			],
			marketInfo: {
				symbol: "BTC/USDT:USDT",
				base: "BTC",
				quote: "USDT",
				settle: "USDT",
				marketType: "swap",
				contract: true,
				linear: true,
				inverse: false,
				contractSize: 1,
				active: true,
			},
		});
		const check = createCheckOrderTool(() => runtime);

		const result = await check.execute(
			"futures-margin",
			{ side: "buy", symbol: "BTC/USDT:USDT", type: "market", amount: 1 },
			undefined,
			undefined,
			context,
		);
		const data = result.details as {
			status: string;
			balance: { asset: string; free: number | null; sufficient: boolean | null };
			margin: { required: number | null; sufficient: boolean | null };
		};
		expect(data.status).toBe("rejected");
		expect(data.balance).toMatchObject({ asset: "futures:USDT", free: 1, sufficient: false });
		expect(data.margin.sufficient).toBe(false);
	});

	it("reports capability limitations instead of treating paper futures as spot", async () => {
		const { runtime } = createRuntime({
			config: { ...DEFAULT_CONFIG, exchange: "binance", marketType: "usdm-futures" },
			marketInfo: {
				symbol: "BTC/USDT:USDT",
				base: "BTC",
				quote: "USDT",
				settle: "USDT",
				marketType: "swap",
				contract: true,
				linear: true,
				inverse: false,
				active: true,
			},
		});
		const tool = createGetTradingCapabilitiesTool(() => runtime);
		const result = await tool.execute("capabilities", { symbol: "BTC/USDT:USDT" }, undefined, undefined, context);
		const data = result.details as {
			capabilities: {
				orderTypes: { market: { status: string }; limit: { status: string } };
				oco: { sell: { status: string } };
			};
		};
		expect(data.capabilities.orderTypes.market.status).toBe("supported");
		expect(data.capabilities.orderTypes.limit.status).toBe("unsupported");
		expect(data.capabilities.oco.sell.status).toBe("unsupported");
	});

	it("does not claim capabilities for a symbol disabled by configuration", async () => {
		const { runtime } = createRuntime({ config: { ...DEFAULT_CONFIG, marketType: "spot" } });
		const tool = createGetTradingCapabilitiesTool(() => runtime);
		const result = await tool.execute(
			"capabilities-disabled",
			{ symbol: "BTC/USDT:USDT" },
			undefined,
			undefined,
			context,
		);
		const data = result.details as {
			marketFamily: string;
			overallStatus: string;
			capabilities: { orderTypes: { market: { status: string } }; oco: { sell: { status: string } } };
		};
		expect(data.marketFamily).toBe("invalid");
		expect(data.overallStatus).toBe("unsupported");
		expect(data.capabilities.orderTypes.market.status).toBe("unsupported");
		expect(data.capabilities.oco.sell.status).toBe("unsupported");
	});

	it("does not use exchange fallbacks when symbol metadata is unavailable", async () => {
		const { runtime } = createRuntime({
			config: { ...DEFAULT_CONFIG, exchange: "binance" },
			marketInfoError: new Error("metadata timeout"),
		});
		const tool = createGetTradingCapabilitiesTool(() => runtime);
		const result = await tool.execute("capabilities-unknown", { symbol: "BTC/USDT" }, undefined, undefined, context);
		const data = result.details as {
			overallStatus: string;
			dataQuality: { capabilityConfidence: boolean };
			capabilities: { orderTypes: { market: { status: string }; limit: { status: string } } };
		};
		expect(data.overallStatus).toBe("unknown");
		expect(data.dataQuality.capabilityConfidence).toBe(false);
		expect(data.capabilities.orderTypes.market.status).toBe("unknown");
		expect(data.capabilities.orderTypes.limit.status).toBe("unknown");
	});

	it("keeps partial balance valuation explicit in the portfolio snapshot", async () => {
		const { runtime } = createRuntime({
			balances: [
				{ asset: "USDT", free: 100, used: 0, total: 100, quoteValue: 100 },
				{ asset: "UNKNOWN", free: 2, used: 0, total: 2 },
			],
		});
		const tool = createGetPortfolioSnapshotTool;
		const snapshot = await tool(() => runtime).execute("snapshot", {}, undefined, undefined, context);
		const data = snapshot.details as {
			account: { estimatedEquity: number | null; knownValuedBalance: number };
			dataQuality: { balances: string };
			warnings: string[];
		};
		expect(data.account.estimatedEquity).toBeNull();
		expect(data.account.knownValuedBalance).toBe(100);
		expect(data.dataQuality.balances).toBe("partial");
		expect(data.warnings.join(" ")).toMatch(/valuation/);
	});

	it("counts an OCO bracket once in the portfolio protection estimate", async () => {
		const ocoLegs: Order[] = [
			{
				id: "oco-stop",
				symbol: "BTC/USDT",
				side: "sell",
				type: "stop_market",
				stopPrice: 90,
				ocoGroup: "oco-1",
				amount: 1,
				filled: 0,
				remaining: 1,
				cost: 0,
				status: "open",
				timestamp: 1,
			},
			{
				id: "oco-take",
				symbol: "BTC/USDT",
				side: "sell",
				type: "take_profit_market",
				stopPrice: 120,
				ocoGroup: "oco-1",
				amount: 1,
				filled: 0,
				remaining: 1,
				cost: 0,
				status: "open",
				timestamp: 1,
			},
		];
		const { runtime } = createRuntime({ openOrders: ocoLegs });
		const result = await createGetPortfolioSnapshotTool(() => runtime).execute(
			"oco-snapshot",
			{},
			undefined,
			undefined,
			context,
		);
		const data = result.details as { account: { protectiveOpenOrderNotional: number } };
		expect(data.account.protectiveOpenOrderNotional).toBe(120);
	});

	it("uses the worst-case buy OCO leg for risk while reporting observed notional", async () => {
		const { placeOcoOrder, runtime } = createRuntime({
			balances: [{ asset: "USDT", free: 1_000, used: 0, total: 1_000, quoteValue: 1_000 }],
		});
		const tool = createPlaceOcoTool(() => runtime);

		const result = await tool.execute(
			"buy-oco-risk",
			{
				symbol: "BTC/USDT",
				side: "buy",
				amount: 1,
				stopLossPrice: 110,
				takeProfitPrice: 90,
			},
			undefined,
			undefined,
			context,
		);
		const data = result.details as {
			status: string;
			preflight: { estimatedNotional: number; observedNotional: number };
		};
		expect(data.status).toBe("ok");
		expect(data.preflight).toMatchObject({ estimatedNotional: 110, observedNotional: 100 });
		expect(runtime.tradingEngine.listExecutions()[0]).toMatchObject({
			notional: 110,
			reservationId: expect.any(String),
		});
		expect(placeOcoOrder).toHaveBeenCalledWith({
			symbol: "BTC/USDT",
			side: "buy",
			amount: 1,
			stopLossPrice: 110,
			takeProfitPrice: 90,
			listClientOrderId: expect.stringMatching(/^tl/),
			aboveClientOrderId: expect.stringMatching(/^ta/),
			belowClientOrderId: expect.stringMatching(/^tb/),
		});
		expect(runtime.tradingEngine.risk.usage()).toMatchObject({ used: 110, reserved: 0 });
	});

	it("marks an unknown OCO submission as non-retryable with a durable entry block", async () => {
		const { placeOcoOrder, runtime } = createRuntime({
			balances: [{ asset: "BTC", free: 2, used: 0, total: 2, quoteValue: 200 }],
		});
		const submissionError = new Error(
			"Submission status unknown [errorCategory=SUBMISSION_STATUS_UNKNOWN] listClientOrderId=oco-1",
		);
		placeOcoOrder.mockRejectedValueOnce(submissionError);
		const tool = createPlaceOcoTool(() => runtime);

		await expect(
			tool.execute(
				"unknown-oco",
				{ symbol: "BTC/USDT", side: "sell", amount: 1, stopLossPrice: 90, takeProfitPrice: 120 },
				undefined,
				undefined,
				context,
			),
		).rejects.toThrow(/submission status unknown.*Do not retry/);
		expect(runtime.tradingEngine.getExecutionStatus().unresolved).toHaveLength(1);
		expect(runtime.tradingEngine.risk.usage()).toMatchObject({ used: 0, reserved: 0 });
	});

	it("returns bounded top-market candidates from the exchange adapter", async () => {
		const topMarkets: Ticker[] = [
			{ symbol: "BTC/USDT", last: 100, quoteVolume24h: 1000, timestamp: 1 },
			{ symbol: "ETH/USDT", last: 50, quoteVolume24h: 500, timestamp: 1 },
		];
		const { getTopMarkets, runtime } = createRuntime({ topMarkets });
		const tool = createGetTopMarketsTool;
		const result = await tool(() => runtime).execute("markets", { limit: 2 }, undefined, undefined, context);
		const data = result.details as {
			count: number;
			markets: Array<{ rank: number; symbol: string }>;
		};
		expect(getTopMarkets).toHaveBeenCalledWith(2);
		expect(data.count).toBe(2);
		expect(data.markets[0]).toMatchObject({ rank: 1, symbol: "BTC/USDT" });
	});

	it("uses the real position amount and quote value for market closePosition", async () => {
		const position: Position = {
			symbol: "BTC/USDT:USDT",
			asset: "BTC",
			amount: 0.75,
			quoteValue: 75,
			positionSide: "BOTH",
		};
		const { placeOrder, runtime } = createRuntime({
			config: { ...DEFAULT_CONFIG, exchange: "binance", marketType: "usdm-futures" },
			positions: [position],
		});
		const tool = createSellTool(() => runtime);

		await tool.execute(
			"close-market",
			{ symbol: position.symbol, type: "market", closePosition: true },
			undefined,
			undefined,
			context,
		);

		expect(runtime.tradingEngine.listExecutions()[0]).toMatchObject({ notional: 75 });
		expect(runtime.tradingEngine.listExecutions()[0].reservationId).toBeUndefined();
		expect(placeOrder).toHaveBeenCalledWith({
			symbol: position.symbol,
			side: "sell",
			type: "market",
			amount: 0.75,
			clientOrderId: expect.stringMatching(/^ti/),
			price: undefined,
			reduceOnly: true,
			positionSide: undefined,
			stopPrice: undefined,
			trailingPercent: undefined,
			closePosition: true,
		});
		expect(runtime.tradingEngine.risk.usage()).toMatchObject({ used: 0, reserved: 0 });
	});

	it("labels closePosition previews as closing the entire matching position", async () => {
		const position: Position = {
			symbol: "BTC/USDT:USDT",
			asset: "BTC",
			amount: 0.75,
			quoteValue: 75,
			positionSide: "BOTH",
		};
		const { runtime } = createRuntime({
			config: {
				...DEFAULT_CONFIG,
				mode: "live",
				exchange: "binance",
				marketType: "usdm-futures",
				confirmLiveOrders: false,
			},
			positions: [position],
			balances: [{ asset: "USDT", free: 1_000, used: 0, total: 1_000, quoteValue: 1_000 }],
			marketInfo: {
				symbol: position.symbol,
				base: "BTC",
				quote: "USDT",
				settle: "USDT",
				marketType: "swap",
				contract: true,
				linear: true,
				inverse: false,
				contractSize: 1,
				active: true,
			},
		});
		const check = createCheckOrderTool(() => runtime);

		const result = await check.execute(
			"close-preview",
			{
				side: "sell",
				symbol: position.symbol,
				type: "stop_market",
				stopPrice: 90,
				closePosition: true,
			},
			undefined,
			undefined,
			context,
		);
		const data = result.details as {
			input: PlaceOrderInput;
			resolution: { amount: number; requestedAmount: number; amountSemantics: string };
		};
		expect(data.input).toMatchObject({ closePosition: true, amount: 0.75, reduceOnly: true });
		expect(data.resolution).toMatchObject({
			amount: 0.75,
			requestedAmount: 0.75,
			amountSemantics: "close_entire_matching_position",
		});
	});

	it("keeps a Binance close-all trigger preview non-blocking when the position is off contract grid", async () => {
		const position: Position = {
			symbol: "BTC/USDT:USDT",
			asset: "BTC",
			amount: 25,
			quoteValue: 100,
			positionSide: "BOTH",
		};
		const { runtime } = createRuntime({
			config: {
				...DEFAULT_CONFIG,
				mode: "live",
				exchange: "binance",
				marketType: "usdm-futures",
				confirmLiveOrders: false,
			},
			positions: [position],
			balances: [{ asset: "USDT", free: 1_000, used: 0, total: 1_000, quoteValue: 1_000 }],
			marketInfo: {
				symbol: position.symbol,
				base: "BTC",
				quote: "USDT",
				settle: "USDT",
				marketType: "swap",
				contract: true,
				linear: true,
				inverse: false,
				amountUnit: "contracts",
				contractSize: 10,
				limits: { amount: { min: 100, max: 100 } },
				active: true,
			},
		});
		const check = createCheckOrderTool(() => runtime);

		const result = await check.execute(
			"close-all-grid",
			{
				side: "sell",
				symbol: position.symbol,
				type: "stop_market",
				stopPrice: 90,
				closePosition: true,
			},
			undefined,
			undefined,
			context,
		);
		const data = result.details as {
			status: string;
			resolution: {
				exchangeAmount: number | null;
				exchangeQuantitySemantics: string;
			};
			executionConstraints: {
				reduceOnlyRequested: boolean;
				reduceOnlyApplied: boolean;
				exchangeConstraint: string | null;
			};
			blockingReasons: string[];
			warnings: string[];
		};
		expect(data.status).toBe("ok_with_warnings");
		expect(data.blockingReasons).toEqual([]);
		expect(data.resolution).toMatchObject({
			exchangeAmount: null,
			exchangeQuantitySemantics: "close_all_trigger_may_omit_quantity",
		});
		expect(data.executionConstraints).toMatchObject({
			reduceOnlyRequested: true,
			reduceOnlyApplied: false,
		});
		expect(data.executionConstraints.exchangeConstraint).toMatch(/close-all.*reduceOnly.*quantity/);
		expect(data.warnings.join(" ")).toMatch(/close-all trigger omits exchange quantity/);
	});

	it("reports Binance hedge directional reduction constraints explicitly", async () => {
		const position: Position = {
			symbol: "BTC/USDT:USDT",
			asset: "BTC",
			amount: 1,
			quoteValue: 100,
			positionSide: "LONG",
		};
		const { runtime } = createRuntime({
			config: {
				...DEFAULT_CONFIG,
				mode: "live",
				exchange: "binance",
				marketType: "usdm-futures",
				positionMode: "hedge",
				confirmLiveOrders: false,
			},
			positions: [position],
			balances: [{ asset: "USDT", free: 1_000, used: 0, total: 1_000, quoteValue: 1_000 }],
			marketInfo: {
				symbol: position.symbol,
				base: "BTC",
				quote: "USDT",
				settle: "USDT",
				marketType: "swap",
				contract: true,
				linear: true,
				inverse: false,
				contractSize: 1,
				active: true,
			},
		});
		const check = createCheckOrderTool(() => runtime);

		const result = await check.execute(
			"hedge-reduction-preview",
			{
				side: "sell",
				symbol: position.symbol,
				type: "market",
				amount: 0.5,
				reduceOnly: true,
				positionSide: "LONG",
			},
			undefined,
			undefined,
			context,
		);
		const data = result.details as {
			executionConstraints: {
				reduceOnlyRequested: boolean;
				reduceOnlyApplied: boolean;
				exchangeConstraint: string | null;
			};
		};
		expect(data.executionConstraints).toMatchObject({
			reduceOnlyRequested: true,
			reduceOnlyApplied: false,
		});
		expect(data.executionConstraints.exchangeConstraint).toMatch(/Binance.*reduceOnly/);
	});

	it("requires a matching position for reduceOnly orders", async () => {
		const { placeOrder, runtime } = createRuntime({
			config: { ...DEFAULT_CONFIG, exchange: "binance", marketType: "usdm-futures" },
			balances: [{ asset: "USDT", free: 10_000, used: 0, total: 10_000, quoteValue: 10_000 }],
			marketInfo: {
				symbol: "BTC/USDT:USDT",
				base: "BTC",
				quote: "USDT",
				settle: "USDT",
				marketType: "swap",
				contract: true,
				active: true,
			},
		});
		const check = createCheckOrderTool(() => runtime);

		const result = await check.execute(
			"reduce-flat",
			{
				side: "sell",
				symbol: "BTC/USDT:USDT",
				type: "market",
				amount: 1,
				reduceOnly: true,
				positionSide: "BOTH",
			},
			undefined,
			undefined,
			context,
		);
		const data = result.details as { status: string; reason: string };
		expect(data.status).toBe("rejected");
		expect(data.reason).toMatch(/No BOTH position/);
		expect(placeOrder).not.toHaveBeenCalled();
	});

	it("rejects the futures-position shortcut in spot mode", async () => {
		const { runtime } = createRuntime();
		const tool = createGetFuturesPositionsTool(() => runtime);
		await expect(tool.execute("spot-futures", {}, undefined, undefined, context)).rejects.toThrow(
			/unavailable in spot mode/,
		);
	});

	it.each([
		["market", "paper", undefined],
		["stop_market", "live", 90],
		["take_profit_market", "live", 120],
	] as const)("allows %s closePosition orders in %s mode", async (type, mode, stopPrice) => {
		const position: Position = {
			symbol: "BTC/USDT:USDT",
			asset: "BTC",
			amount: 1,
			quoteValue: 100,
			positionSide: "BOTH",
		};
		const { placeOrder, runtime } = createRuntime({
			config: {
				...DEFAULT_CONFIG,
				mode,
				exchange: "binance",
				marketType: "usdm-futures",
				confirmLiveOrders: false,
			},
			positions: [position],
		});
		const tool = createSellTool(() => runtime);
		const params: SellToolParams = {
			symbol: position.symbol,
			type,
			closePosition: true,
			...(stopPrice === undefined ? {} : { stopPrice }),
		};

		await tool.execute(`close-${type}`, params, undefined, undefined, context);

		expect(placeOrder).toHaveBeenCalledOnce();
	});

	it.each(["stop", "take_profit"] as const)("rejects closePosition with %s limit execution", async (type) => {
		const { getPositions, placeOrder, runtime } = createRuntime({
			config: {
				...DEFAULT_CONFIG,
				mode: "live",
				exchange: "binance",
				marketType: "usdm-futures",
				confirmLiveOrders: false,
			},
		});
		const tool = createSellTool(() => runtime);

		await expect(
			tool.execute(
				`close-${type}`,
				{ symbol: "BTC/USDT:USDT", type, price: 95, stopPrice: 90, closePosition: true },
				undefined,
				undefined,
				context,
			),
		).rejects.toThrow(`closePosition is supported only for market, stop_market or take_profit_market orders`);
		expect(getPositions).not.toHaveBeenCalled();
		expect(placeOrder).not.toHaveBeenCalled();
	});

	it("does not charge spot sell protection against the entry quota", async () => {
		const { runtime } = createRuntime({
			balances: [{ asset: "BTC", free: 1, used: 0, total: 1, quoteValue: 100 }],
		});
		const tool = createSellTool(() => runtime);

		await tool.execute(
			"protect-spot",
			{ symbol: "BTC/USDT", type: "stop_market", amount: 1, stopPrice: 90 },
			undefined,
			undefined,
			context,
		);

		expect(runtime.tradingEngine.listExecutions()[0]).toMatchObject({ notional: 90 });
		expect(runtime.tradingEngine.risk.usage()).toMatchObject({ used: 0, reserved: 0 });
	});

	it("cancels a live order when placeOrder policy confirm returns false", async () => {
		const { placeOrder, runtime } = createRuntime({
			config: { ...DEFAULT_CONFIG, mode: "live", confirmLiveOrders: true },
			balances: [{ asset: "USDT", free: 10_000, used: 0, total: 10_000, quoteValue: 10_000 }],
		});
		vi.spyOn(runtime.tradingEngine.risk, "reserve").mockRestore();
		const confirm = vi.fn(async () => {
			expect(runtime.tradingEngine.risk.usage().reserved).toBeGreaterThan(0);
			return false;
		});
		const notify = vi.fn();
		const liveContext = { hasUI: true, ui: { confirm, notify } } as unknown as ExtensionContext;
		const tool = createBuyTool(() => runtime);

		const result = await tool.execute(
			"live-reject",
			{ symbol: "BTC/USDT", type: "market", amount: 1 },
			undefined,
			undefined,
			liveContext,
		);

		expect(result.details).toMatchObject({
			status: "cancelled",
			reason: "user rejected confirmation",
		});
		expect(placeOrder).not.toHaveBeenCalled();
		expect(runtime.tradingEngine.risk.usage()).toMatchObject({ used: 0, reserved: 0 });
		expect(notify).toHaveBeenCalledWith("Order cancelled by user", "info");
	});

	it("confirms live order and order-list cancellations before submitting", async () => {
		const { cancelOrder, cancelOrderList, runtime } = createRuntime({
			config: { ...DEFAULT_CONFIG, mode: "live", confirmLiveOrders: true },
		});
		const confirm = vi.fn(async () => true);
		const liveContext = { hasUI: true, ui: { confirm, notify: vi.fn() } } as unknown as ExtensionContext;

		const orderResult = await createCancelOrderTool(() => runtime).execute(
			"live-cancel",
			{ id: "order-1", symbol: "BTC/USDT" },
			undefined,
			undefined,
			liveContext,
		);
		const listResult = await createCancelOrderListTool(() => runtime).execute(
			"live-cancel-list",
			{ orderListId: "list-1", symbol: "BTC/USDT" },
			undefined,
			undefined,
			liveContext,
		);

		expect(orderResult.details).toMatchObject({ status: "ok", cancelled: "order-1" });
		expect(listResult.details).toMatchObject({ status: "ok", cancelledOrderListId: "list-1" });
		expect(cancelOrder).toHaveBeenCalledWith("order-1", "BTC/USDT");
		expect(cancelOrderList).toHaveBeenCalledWith("list-1", "BTC/USDT");
		expect(confirm).toHaveBeenCalledTimes(2);
		expect(confirm).toHaveBeenNthCalledWith(1, expect.stringContaining("LIVE"), expect.stringContaining("order-1"));
	});

	it("does not cancel live orders when confirmation is rejected", async () => {
		const { cancelOrder, cancelOrderList, runtime } = createRuntime({
			config: { ...DEFAULT_CONFIG, mode: "live", confirmLiveOrders: true },
		});
		const confirm = vi.fn(async () => false);
		const notify = vi.fn();
		const liveContext = { hasUI: true, ui: { confirm, notify } } as unknown as ExtensionContext;

		const orderResult = await createCancelOrderTool(() => runtime).execute(
			"live-cancel-reject",
			{ id: "order-2", symbol: "BTC/USDT" },
			undefined,
			undefined,
			liveContext,
		);
		const listResult = await createCancelOrderListTool(() => runtime).execute(
			"live-cancel-list-reject",
			{ orderListId: "list-2", symbol: "BTC/USDT" },
			undefined,
			undefined,
			liveContext,
		);

		expect(orderResult.details).toMatchObject({ status: "cancelled", reason: "user rejected confirmation" });
		expect(listResult.details).toMatchObject({ status: "cancelled", reason: "user rejected confirmation" });
		expect(cancelOrder).not.toHaveBeenCalled();
		expect(cancelOrderList).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledTimes(2);
	});

	it("rejects headless live order cancellations when confirmation is enabled", async () => {
		const { cancelOrder, cancelOrderList, runtime } = createRuntime({
			config: { ...DEFAULT_CONFIG, mode: "live", confirmLiveOrders: true },
		});
		const orderTool = createCancelOrderTool(() => runtime);
		const listTool = createCancelOrderListTool(() => runtime);

		await expect(
			orderTool.execute("headless-cancel", { id: "order-3", symbol: "BTC/USDT" }, undefined, undefined, context),
		).rejects.toThrow(/no UI is available/);
		await expect(
			listTool.execute(
				"headless-cancel-list",
				{ orderListId: "list-3", symbol: "BTC/USDT" },
				undefined,
				undefined,
				context,
			),
		).rejects.toThrow(/no UI is available/);

		expect(cancelOrder).not.toHaveBeenCalled();
		expect(cancelOrderList).not.toHaveBeenCalled();
	});

	it("keeps paper cancellations confirmation-free", async () => {
		const { cancelOrder, cancelOrderList, runtime } = createRuntime({
			config: { ...DEFAULT_CONFIG, mode: "paper", confirmLiveOrders: true },
		});
		const confirm = vi.fn(async () => {
			throw new Error("paper cancellation should not prompt");
		});
		const paperContext = { hasUI: false, ui: { confirm, notify: vi.fn() } } as unknown as ExtensionContext;

		await createCancelOrderTool(() => runtime).execute(
			"paper-cancel",
			{ id: "order-4", symbol: "BTC/USDT" },
			undefined,
			undefined,
			paperContext,
		);
		await createCancelOrderListTool(() => runtime).execute(
			"paper-cancel-list",
			{ orderListId: "list-4", symbol: "BTC/USDT" },
			undefined,
			undefined,
			paperContext,
		);

		expect(confirm).not.toHaveBeenCalled();
		expect(cancelOrder).toHaveBeenCalledWith("order-4", "BTC/USDT");
		expect(cancelOrderList).toHaveBeenCalledWith("list-4", "BTC/USDT");
	});

	it("submits a live order when placeOrder policy confirm returns true", async () => {
		const { placeOrder, runtime } = createRuntime({
			config: { ...DEFAULT_CONFIG, mode: "live", confirmLiveOrders: true },
			balances: [{ asset: "USDT", free: 10_000, used: 0, total: 10_000, quoteValue: 10_000 }],
		});
		vi.spyOn(runtime.tradingEngine.risk, "reserve").mockRestore();
		const confirm = vi.fn().mockResolvedValue(true);
		const liveContext = {
			hasUI: true,
			ui: { confirm, notify: vi.fn() },
		} as unknown as ExtensionContext;
		const tool = createBuyTool(() => runtime);

		const result = await tool.execute(
			"live-accept",
			{ symbol: "BTC/USDT", type: "market", amount: 1 },
			undefined,
			undefined,
			liveContext,
		);

		expect(result.details).toMatchObject({ status: "ok", mode: "live" });
		expect(placeOrder).toHaveBeenCalledOnce();
		expect(confirm).toHaveBeenCalledOnce();
	});

	it("rejects headless live orders after reserving quota", async () => {
		const { placeOrder, runtime } = createRuntime({
			config: { ...DEFAULT_CONFIG, mode: "live", confirmLiveOrders: true },
			balances: [{ asset: "USDT", free: 10_000, used: 0, total: 10_000, quoteValue: 10_000 }],
		});
		vi.spyOn(runtime.tradingEngine.risk, "reserve").mockRestore();
		const tool = createBuyTool(() => runtime);

		await expect(
			tool.execute(
				"live-headless",
				{ symbol: "BTC/USDT", type: "market", amount: 1 },
				undefined,
				undefined,
				context,
			),
		).rejects.toThrow(/no UI is available/);

		expect(runtime.tradingEngine.listExecutions()[0]).toMatchObject({
			status: "definite-rejection",
			reservationId: expect.any(String),
		});
		expect(placeOrder).not.toHaveBeenCalled();
		expect(runtime.tradingEngine.risk.usage()).toMatchObject({ used: 0, reserved: 0 });
	});
});

describe("unavailable position valuation propagation", () => {
	const unvaluedPosition: Position = {
		symbol: "BTC/USDT",
		asset: "BTC",
		amount: 1,
		avgEntryPrice: 100,
		valuationStatus: "unavailable",
		valuationReason: "Ticker for BTC/USDT did not provide a finite positive last price",
	};

	it("reports an unvalued position in get_positions with JSON null fields and a warning", async () => {
		const { runtime } = createRuntime({ positions: [unvaluedPosition] });
		const tool = createGetPositionsTool(() => runtime);

		const result = await tool.execute("positions-unavailable", {}, undefined, undefined, context);
		const data = result.details as {
			count: number;
			positions: Array<{
				symbol: string;
				amount: number;
				quoteValue: number | null;
				unrealizedPnl: number | null;
				valuationStatus: string;
				valuationReason: string;
			}>;
			dataQuality: { valuations: string };
			warnings: string[];
		};
		expect(data.count).toBe(1);
		expect(data.positions[0]).toMatchObject({
			symbol: "BTC/USDT",
			amount: 1,
			quoteValue: null,
			unrealizedPnl: null,
			unrealizedPnlPct: null,
			markPrice: null,
			valuationStatus: "unavailable",
		});
		expect(data.positions[0].valuationReason).toMatch(/finite positive last price/);
		expect(data.dataQuality.valuations).toBe("partial");
		expect(data.warnings.join(" ")).toMatch(/BTC\/USDT valuation unavailable/);
		expect(serializedText(result)).toContain('"quoteValue": null');
	});

	it("keeps portfolio aggregates unknown instead of partially summing unvalued positions", async () => {
		const { runtime } = createRuntime({
			balances: [{ asset: "USDT", free: 100, used: 0, total: 100, quoteValue: 100 }],
			positions: [unvaluedPosition],
		});

		const result = await createGetPortfolioSnapshotTool(() => runtime).execute(
			"portfolio-unavailable",
			{},
			undefined,
			undefined,
			context,
		);
		const data = result.details as {
			account: {
				grossExposure: number | null;
				knownValuedExposure: number;
				unrealizedPnl: number | null;
			};
			dataQuality: { positions: string; pnl: string };
			warnings: string[];
		};
		expect(data.account.grossExposure).toBeNull();
		expect(data.account.knownValuedExposure).toBe(0);
		expect(data.account.unrealizedPnl).toBeNull();
		expect(data.dataQuality.positions).toBe("partial");
		expect(data.dataQuality.pnl).toBe("partial");
		expect(data.warnings.join(" ")).toMatch(/position valuation\(s\) unavailable/);
		expect(serializedText(result)).toContain('"grossExposure": null');
	});

	it("marks the risk positions breakdown unknown when a position is unvalued", async () => {
		const { runtime } = createRuntime({ positions: [unvaluedPosition] });
		const tool = createGetRiskStatusTool(() => runtime);

		const result = await tool.execute("risk-unavailable", {}, undefined, undefined, context);
		const data = result.details as {
			breakdown: { positions: number | null };
			warnings: string[];
		};
		expect(data.breakdown.positions).toBeNull();
		expect(data.warnings.join(" ")).toMatch(/positions breakdown is unknown/);
		expect(serializedText(result)).toContain('"positions": null');
	});

	it("still prices a healthy position and leaves aggregates numeric", async () => {
		const valued: Position = {
			symbol: "BTC/USDT",
			asset: "BTC",
			amount: 1,
			quoteValue: 100,
			avgEntryPrice: 100,
			unrealizedPnl: 0,
			unrealizedPnlPct: 0,
			valuationStatus: "complete",
		};
		const { runtime } = createRuntime({ positions: [valued] });
		const tool = createGetPositionsTool(() => runtime);

		const result = await tool.execute("positions-valued", {}, undefined, undefined, context);
		const data = result.details as {
			count: number;
			positions: Array<{ quoteValue: number | null; valuationStatus: string }>;
			dataQuality: { valuations: string };
			warnings: string[];
		};
		expect(data.count).toBe(1);
		expect(data.positions[0]).toMatchObject({ quoteValue: 100, valuationStatus: "complete" });
		expect(data.dataQuality.valuations).toBe("complete");
		expect(data.warnings).toEqual([]);
	});

	it("normalizes an unvalued balance quoteValue to JSON null in get_balance", async () => {
		const { runtime } = createRuntime({
			balances: [
				{ asset: "BTC", free: 2, used: 0, total: 2 },
				{ asset: "USDT", free: 100, used: 0, total: 100, quoteValue: 100 },
			],
		});
		const tool = createGetBalanceTool(() => runtime);

		const result = await tool.execute("balance-unavailable", {}, undefined, undefined, context);
		const parsed: unknown = JSON.parse(serializedText(result));
		expect(parsed).toMatchObject({
			balances: [
				{ asset: "BTC", free: 2, used: 0, total: 2, quoteValue: null },
				{ asset: "USDT", free: 100, used: 0, total: 100, quoteValue: 100 },
			],
			totalQuoteValue: null,
			knownValuedQuote: 100,
		});
		expect(serializedText(result)).toContain('"quoteValue": null');
	});

	it("normalizes an unvalued balance quoteValue to JSON null in get_portfolio_snapshot", async () => {
		const { runtime } = createRuntime({
			balances: [{ asset: "BTC", free: 2, used: 0, total: 2 }],
		});
		const tool = createGetPortfolioSnapshotTool(() => runtime);

		const result = await tool.execute("portfolio-balance-unavailable", {}, undefined, undefined, context);
		const parsed: unknown = JSON.parse(serializedText(result));
		expect(parsed).toMatchObject({
			balances: [{ asset: "BTC", free: 2, used: 0, total: 2, quoteValue: null }],
			account: { estimatedEquity: null, knownValuedBalance: 0 },
			dataQuality: { balances: "partial" },
		});
		expect(serializedText(result)).toContain('"quoteValue": null');
	});
});

describe("contract stats normalization", () => {
	const FUTURES_SYMBOL = "BTC/USDT:USDT";
	const CONTRACT_STAT_METRICS = [
		"lastPrice",
		"markPrice",
		"indexPrice",
		"fundingRate",
		"nextFundingTime",
		"nextFundingRate",
		"estimatedSettlePrice",
		"interestRate",
		"openInterest",
		"openInterestValue",
		"basis",
		"basisPct",
	];

	it("emits every omitted contract metric as explicit JSON null with field warnings", async () => {
		const { getContractStats, runtime } = createRuntime({
			config: { ...DEFAULT_CONFIG, exchange: "binance", marketType: "usdm-futures" },
			contractStats: { symbol: FUTURES_SYMBOL, lastPrice: 100, markPrice: 100.5 },
		});
		const tool = createGetContractStatsTool(() => runtime);

		const result = await tool.execute(
			"contract-stats-partial",
			{ symbol: FUTURES_SYMBOL },
			undefined,
			undefined,
			context,
		);
		const parsed: unknown = JSON.parse(serializedText(result));

		expect(parsed).toMatchObject({ symbol: FUTURES_SYMBOL, lastPrice: 100, markPrice: 100.5 });
		for (const field of CONTRACT_STAT_METRICS) expect(parsed).toHaveProperty(field);
		expect(parsed).toMatchObject({
			indexPrice: null,
			fundingRate: null,
			nextFundingTime: null,
			nextFundingRate: null,
			estimatedSettlePrice: null,
			interestRate: null,
			openInterest: null,
			openInterestValue: null,
			basis: null,
			basisPct: null,
		});
		expect(parsed).toMatchObject({
			dataQuality: {
				lastPrice: true,
				markPrice: true,
				indexPrice: false,
				fundingRate: false,
				nextFundingTime: false,
				nextFundingRate: false,
				estimatedSettlePrice: false,
				interestRate: false,
				openInterest: false,
				openInterestValue: false,
				basis: false,
				basisPct: false,
			},
		});
		expect(parsed).toMatchObject({
			warnings: [
				"index price unavailable",
				"funding rate unavailable",
				"next funding time unavailable",
				"next funding rate unavailable",
				"estimated settle price unavailable",
				"interest rate unavailable",
				"open interest unavailable",
				"open interest value unavailable",
				"basis unavailable",
				"basis percent unavailable",
			],
		});
		expect(getContractStats).toHaveBeenCalledWith(FUTURES_SYMBOL);
		expect(serializedText(result)).toContain('"indexPrice": null');
	});

	it("preserves finite contract metrics without alteration", async () => {
		const full: ContractStats = {
			symbol: FUTURES_SYMBOL,
			lastPrice: 100,
			markPrice: 100.1,
			indexPrice: 100,
			fundingRate: 0.0001,
			nextFundingTime: 1_752_494_400_000,
			nextFundingRate: 0.0002,
			estimatedSettlePrice: 100.2,
			interestRate: 0.01,
			openInterest: 1_000,
			openInterestValue: 100_000,
			basis: 0.2,
			basisPct: 0.002,
		};
		const { runtime } = createRuntime({
			config: { ...DEFAULT_CONFIG, exchange: "binance", marketType: "usdm-futures" },
			contractStats: full,
		});
		const tool = createGetContractStatsTool(() => runtime);

		const result = await tool.execute(
			"contract-stats-full",
			{ symbol: FUTURES_SYMBOL },
			undefined,
			undefined,
			context,
		);
		const parsed: unknown = JSON.parse(serializedText(result));

		expect(parsed).toMatchObject(full);
		expect(parsed).toMatchObject({ warnings: [] });
		expect(parsed).toMatchObject({
			dataQuality: {
				lastPrice: true,
				markPrice: true,
				indexPrice: true,
				fundingRate: true,
				nextFundingTime: true,
				nextFundingRate: true,
				estimatedSettlePrice: true,
				interestRate: true,
				openInterest: true,
				openInterestValue: true,
				basis: true,
				basisPct: true,
			},
		});
	});

	it("normalizes NaN and infinities to null with matching warnings", async () => {
		const { runtime } = createRuntime({
			config: { ...DEFAULT_CONFIG, exchange: "binance", marketType: "usdm-futures" },
			contractStats: {
				symbol: FUTURES_SYMBOL,
				lastPrice: NaN,
				markPrice: Infinity,
				indexPrice: 100,
				fundingRate: -Infinity,
				openInterest: Number.POSITIVE_INFINITY,
			},
		});
		const tool = createGetContractStatsTool(() => runtime);

		const result = await tool.execute(
			"contract-stats-non-finite",
			{ symbol: FUTURES_SYMBOL },
			undefined,
			undefined,
			context,
		);

		expect(result.details).toMatchObject({
			lastPrice: null,
			markPrice: null,
			fundingRate: null,
			openInterest: null,
			indexPrice: 100,
			warnings: expect.arrayContaining(["last price unavailable", "mark price unavailable"]),
			dataQuality: {
				lastPrice: false,
				markPrice: false,
				fundingRate: false,
				openInterest: false,
				indexPrice: true,
			},
		});
		expect(serializedText(result)).toContain('"markPrice": null');
	});

	it("propagates a whole-call contract-stats adapter rejection unchanged", async () => {
		const adapterError = new Error("contract stats adapter explosion");
		const { getContractStats, runtime } = createRuntime({
			config: { ...DEFAULT_CONFIG, exchange: "binance", marketType: "usdm-futures" },
			contractStatsError: adapterError,
		});
		const tool = createGetContractStatsTool(() => runtime);

		await expect(
			tool.execute("contract-stats-reject", { symbol: FUTURES_SYMBOL }, undefined, undefined, context),
		).rejects.toBe(adapterError);
		expect(getContractStats).toHaveBeenCalledWith(FUTURES_SYMBOL);
	});
});

const REGISTERED_TOOL_NAMES = [
	"get_price",
	"get_order_book",
	"get_market_info",
	"get_contract_stats",
	"get_klines",
	"get_top_markets",
	"get_trading_capabilities",
	"get_balance",
	"get_positions",
	"get_portfolio_snapshot",
	"get_open_orders",
	"get_order_history",
	"get_order_status",
	"get_order_list_status",
	"check_order",
	"buy",
	"sell",
	"place_oco",
	"cancel_order",
	"cancel_order_list",
	"get_risk_status",
	"get_funding_rate_history",
	"set_leverage",
	"set_margin_mode",
	"set_multi_assets_mode",
] as const;

describe("trading tool registration", () => {
	it("registers the focused default trading tool set without redundant aliases", () => {
		const names = createTradingTools().map((tool) => tool.name);

		expect(names).toHaveLength(25);
		expect(names).toEqual(REGISTERED_TOOL_NAMES);
		expect(names).toContain("get_contract_stats");
		expect(names).not.toContain("get_funding_rate");
		expect(names).not.toContain("get_futures_positions");
	});

	it("threads one injected provider through the registry without touching the singleton", () => {
		const { runtime } = createRuntime();
		const provider = vi.fn(() => runtime);

		const names = createTradingTools(provider).map((tool) => tool.name);

		expect(provider).not.toHaveBeenCalled();
		expect(names).toHaveLength(25);
		expect(names).toEqual(REGISTERED_TOOL_NAMES);
	});
});

describe("formatOrder fill economics", () => {
	const base = {
		id: "101970248810",
		symbol: "DOGE/USDT:USDT",
		side: "buy",
		type: "market",
		amount: 63,
		filled: 63,
		remaining: 0,
		status: "closed",
		timestamp: 1,
	};

	it("does not present a filled order with placeholder cost 0 as a reliable notional", () => {
		expect(formatOrder({ ...base, cost: 0 })).toMatchObject({ cost: null, average: null });
	});

	it("keeps a real zero cost on unfilled orders", () => {
		expect(
			formatOrder({
				...base,
				filled: 0,
				remaining: 63,
				cost: 0,
				status: "open",
			}),
		).toMatchObject({ cost: 0, average: undefined });
	});
});
