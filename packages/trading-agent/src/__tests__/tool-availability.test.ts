import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
	Balance,
	ContractStats,
	ExchangeClient,
	FundingRateRecord,
	Kline,
	MarketInfo,
	Order,
	OrderBook,
	OrderList,
	PlaceOcoOrderInput,
	PlaceOcoOrderResult,
	PlaceOrderInput,
	PlaceOrderResult,
	Position,
	Ticker,
} from "@nikopack/ti-trading-engine";
import { TradingEngine } from "@nikopack/ti-trading-engine";
import { describe, expect, it, vi } from "vitest";
import { getTrading, type TradingRuntime } from "../context.ts";
import { DEFAULT_CONFIG, type TradingConfig } from "../state.ts";
import {
	createGetFundingRateTool,
	createGetFuturesPositionsTool,
	createGetOrderListStatusTool,
	createGetOrderStatusTool,
	createGetPriceTool,
	createTradingTools,
	NATIVE_TRADING_TOOL_NAMES,
	type TradingProvider,
} from "../tools/index.ts";

const REGISTERED_TOOL_NAMES = NATIVE_TRADING_TOOL_NAMES;

const context = {
	hasUI: false,
	ui: { confirm: vi.fn(), notify: vi.fn() },
} as unknown as ExtensionContext;

/**
 * Deterministic in-memory trading runtime. No process singleton is involved:
 * the factory seam receives this provider explicitly while getTrading() stays
 * uninitialized.
 */
function createSeamRuntime(): {
	runtime: TradingRuntime;
	getTicker: ReturnType<typeof vi.fn>;
	getOrder: ReturnType<typeof vi.fn>;
	getOrderList: ReturnType<typeof vi.fn>;
} {
	const getTicker = vi.fn(
		async (symbol: string): Promise<Ticker> => ({
			symbol,
			last: 100,
			bid: 99,
			ask: 101,
			timestamp: 1,
		}),
	);
	const getOrder = vi.fn(
		async (id: string, symbol: string): Promise<Order> => ({
			id,
			symbol,
			side: "sell",
			type: "limit",
			price: 98,
			amount: 1,
			filled: 0,
			remaining: 1,
			cost: 0,
			status: "open",
			timestamp: 1,
		}),
	);
	const getOrderList = vi.fn(
		async (orderListId: string): Promise<OrderList> => ({
			id: orderListId,
			listOrderStatus: "EXECUTING",
			status: "open",
			orders: [
				{
					id: "ol-leg-1",
					symbol: "BTC/USDT",
					side: "sell",
					type: "stop_market",
					stopPrice: 90,
					amount: 1,
					filled: 0,
					remaining: 1,
					cost: 0,
					status: "open",
					timestamp: 1,
				},
			],
		}),
	);
	const tradingEngine = { getTicker, getOrder, getOrderList } as unknown as TradingEngine;
	const runtime = {
		config: DEFAULT_CONFIG,
		mode: "paper" as const,
		tradingEngine,
	} as unknown as TradingRuntime;
	return { runtime, getTicker, getOrder, getOrderList };
}

const SPOT_SYMBOL = "BTC/USDT";
const FUTURES_SYMBOL = "BTC/USDT:USDT";
const FIXED_TIMESTAMP = Date.parse("2026-01-01T00:00:00.000Z");

function spotMarketInfo(symbol = SPOT_SYMBOL): MarketInfo {
	return {
		symbol,
		base: symbol.split("/")[0],
		quote: "USDT",
		marketType: "spot",
		contract: false,
		active: true,
		orderTypes: [
			"market",
			"limit",
			"stop",
			"stop_market",
			"take_profit",
			"take_profit_market",
			"trailing_stop_market",
			"oco",
		],
		minAmount: 0.0001,
		minNotional: 5,
		limits: { amount: { min: 0.0001, max: 100 }, cost: { min: 5, max: 100_000 } },
		amountUnit: "base",
	};
}

function futuresMarketInfo(symbol = FUTURES_SYMBOL): MarketInfo {
	return {
		symbol,
		base: symbol.split("/")[0],
		quote: "USDT",
		settle: "USDT",
		marketType: "swap",
		contract: true,
		linear: true,
		inverse: false,
		active: true,
		orderTypes: ["market", "limit", "stop_market", "take_profit_market", "trailing_stop_market"],
		amountUnit: "contracts",
		contractSize: 1,
		minAmount: 1,
		minNotional: 5,
		limits: { amount: { min: 1, max: 100_000 }, cost: { min: 5, max: 10_000_000 } },
	};
}

function openOrder(symbol: string = SPOT_SYMBOL): Order {
	return {
		id: "order-open",
		clientOrderId: "client-open",
		symbol,
		side: "sell",
		type: "limit",
		price: 110,
		amount: 0.1,
		filled: 0,
		remaining: 0.1,
		cost: 0,
		status: "open",
		timestamp: FIXED_TIMESTAMP,
	};
}

function closedOrder(symbol: string = SPOT_SYMBOL): Order {
	return {
		id: "order-closed",
		clientOrderId: "client-closed",
		symbol,
		side: "buy",
		type: "market",
		amount: 0.1,
		filled: 0.1,
		remaining: 0,
		average: 100,
		cost: 10,
		status: "closed",
		timestamp: FIXED_TIMESTAMP,
	};
}

class DeterministicExchange implements ExchangeClient {
	readonly id: string;
	readonly mode: "paper" | "live";
	readonly quoteCurrency = "USDT";
	readonly historyQueries: Array<string | undefined> = [];
	readonly calls: string[] = [];
	fundingRateValue: number | undefined = 0.0001;
	fundingHistoryRate: number | undefined = 0.0001;
	private readonly marketType: TradingConfig["marketType"];

	constructor(config: TradingConfig) {
		this.id = config.exchange;
		this.mode = config.mode;
		this.marketType = config.marketType;
	}

	private isFutures(symbol: string): boolean {
		return symbol === FUTURES_SYMBOL || symbol.endsWith("/USDT:USDT");
	}

	private ensureEnabled(symbol: string): void {
		const futures = this.isFutures(symbol);
		if (this.marketType === "spot" && futures) throw new Error("Futures markets are disabled in spot mode");
		if (this.marketType === "usdm-futures" && !futures) throw new Error("Spot markets are disabled in futures mode");
		if (futures ? !symbol.endsWith("/USDT:USDT") : !symbol.endsWith("/USDT"))
			throw new Error(`Unsupported market: ${symbol}`);
	}

	private ensureFutures(symbol: string): void {
		this.ensureEnabled(symbol);
		if (!this.isFutures(symbol)) throw new Error(`Futures capability requires a futures symbol: ${symbol}`);
	}

	async getTicker(symbol: string): Promise<Ticker> {
		this.ensureEnabled(symbol);
		return {
			symbol,
			last: 100,
			bid: 99,
			ask: 101,
			high24h: 105,
			low24h: 95,
			quoteVolume24h: 10_000,
			timestamp: FIXED_TIMESTAMP,
		};
	}

	async getOrderBook(symbol: string, _limit?: number): Promise<OrderBook> {
		this.ensureEnabled(symbol);
		return {
			symbol,
			timestamp: FIXED_TIMESTAMP,
			bids: [{ price: 99, amount: 2 }],
			asks: [{ price: 101, amount: 2 }],
			spread: 2,
			spreadPct: 2.020202,
			bidDepth: 2,
			askDepth: 2,
		};
	}

	async getMarketInfo(symbol: string): Promise<MarketInfo> {
		this.ensureEnabled(symbol);
		return this.isFutures(symbol) ? futuresMarketInfo(symbol) : spotMarketInfo(symbol);
	}

	async getContractStats(symbol: string): Promise<ContractStats> {
		this.ensureFutures(symbol);
		return {
			symbol,
			lastPrice: 100,
			markPrice: 100.1,
			indexPrice: 100,
			fundingRate: 0.0001,
			openInterest: 1_000,
		};
	}

	async getKlines(symbol: string, _timeframe: string, _limit: number): Promise<Kline[]> {
		this.ensureEnabled(symbol);
		return [{ timestamp: FIXED_TIMESTAMP, closed: true, open: 99, high: 102, low: 98, close: 100, volume: 20 }];
	}

	async getBalances(): Promise<Balance[]> {
		const balances: Balance[] = [];
		if (this.marketType !== "usdm-futures") {
			balances.push(
				{ asset: "USDT", free: 10_000, used: 0, total: 10_000, quoteValue: 10_000 },
				{ asset: "BTC", free: 2, used: 0, total: 2, quoteValue: 200 },
			);
		}
		if (this.marketType !== "spot")
			balances.push({ asset: "USDT", free: 10_000, used: 0, total: 10_000, quoteValue: 10_000 });
		return balances;
	}

	async getPositions(): Promise<Position[]> {
		const positions: Position[] = [];
		if (this.marketType !== "usdm-futures")
			positions.push({
				symbol: SPOT_SYMBOL,
				asset: "BTC",
				amount: 2,
				quoteValue: 200,
				avgEntryPrice: 90,
				unrealizedPnl: 20,
			});
		if (this.marketType !== "spot")
			positions.push({
				symbol: FUTURES_SYMBOL,
				asset: "BTC",
				amount: 1,
				quoteValue: 100,
				positionSide: "BOTH",
				leverage: 5,
				marginType: "isolated",
				markPrice: 100,
				margin: 20,
				avgEntryPrice: 95,
				unrealizedPnl: 5,
			});
		return positions;
	}

	async getOpenOrders(symbol?: string): Promise<Order[]> {
		if (symbol !== undefined) this.ensureEnabled(symbol);
		const orders = [openOrder(SPOT_SYMBOL), openOrder(FUTURES_SYMBOL)];
		return orders
			.filter(
				(order) =>
					this.marketType === "both" ||
					(this.isFutures(order.symbol) ? this.marketType === "usdm-futures" : this.marketType === "spot"),
			)
			.filter((order) => symbol === undefined || order.symbol === symbol);
	}

	async getOrderHistory(symbol?: string, _limit?: number): Promise<Order[]> {
		this.historyQueries.push(symbol);
		if (symbol !== undefined) this.ensureEnabled(symbol);
		const orders = [closedOrder(SPOT_SYMBOL), closedOrder(FUTURES_SYMBOL)];
		return orders
			.filter(
				(order) =>
					this.marketType === "both" ||
					(this.isFutures(order.symbol) ? this.marketType === "usdm-futures" : this.marketType === "spot"),
			)
			.filter((order) => symbol === undefined || order.symbol === symbol);
	}

	async getOrder(id: string, symbol: string): Promise<Order> {
		this.ensureEnabled(symbol);
		return { ...closedOrder(symbol), id };
	}

	async getOrderByClientId(clientOrderId: string, symbol: string): Promise<Order> {
		this.ensureEnabled(symbol);
		return { ...closedOrder(symbol), id: "order-by-client", clientOrderId };
	}

	async getOrderList(orderListId: string): Promise<OrderList> {
		return {
			id: orderListId,
			listOrderStatus: "EXECUTING",
			status: "open",
			orders: [
				{
					...openOrder(SPOT_SYMBOL),
					id: "oco-stop",
					type: "stop_market",
					stopPrice: 90,
					ocoGroup: orderListId,
					orderListId,
				},
				{
					...openOrder(SPOT_SYMBOL),
					id: "oco-take",
					type: "take_profit_market",
					stopPrice: 110,
					ocoGroup: orderListId,
					orderListId,
				},
			],
		};
	}

	async getOrderListByClientId(listClientOrderId: string): Promise<OrderList> {
		const list = await this.getOrderList("list-by-client");
		return { ...list, orders: list.orders.map((order) => ({ ...order, listClientOrderId })) };
	}

	async placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
		this.ensureEnabled(input.symbol);
		if (this.mode === "paper" && this.isFutures(input.symbol) && input.type !== "market")
			throw new Error("Paper futures currently accept market orders only");
		const order: Order = {
			id: "placed-order",
			clientOrderId: input.clientOrderId,
			symbol: input.symbol,
			side: input.side,
			type: input.type,
			price: input.price,
			stopPrice: input.stopPrice,
			trailingPercent: input.trailingPercent,
			positionSide: input.positionSide,
			reduceOnly: input.reduceOnly,
			closePosition: input.closePosition,
			amount: input.amount,
			filled: input.type === "market" ? input.amount : 0,
			remaining: input.type === "market" ? 0 : input.amount,
			average: input.type === "market" ? 100 : undefined,
			cost: input.type === "market" ? input.amount * 100 : 0,
			status: input.type === "market" ? "closed" : "open",
			timestamp: FIXED_TIMESTAMP,
		};
		return { order, fee: input.amount * 0.001 };
	}

	async placeOcoOrder(input: PlaceOcoOrderInput): Promise<PlaceOcoOrderResult> {
		this.ensureEnabled(input.symbol);
		if (this.isFutures(input.symbol)) throw new Error("OCO orders are not available for futures markets");
		return {
			orders: [
				{
					...openOrder(input.symbol),
					id: "oco-stop",
					type: "stop_market",
					stopPrice: input.stopLossPrice,
					side: input.side,
					amount: input.amount,
					remaining: input.amount,
					clientOrderId: input.belowClientOrderId,
					listClientOrderId: input.listClientOrderId,
					orderListId: "list-1",
				},
				{
					...openOrder(input.symbol),
					id: "oco-take",
					type: "take_profit_market",
					stopPrice: input.takeProfitPrice,
					side: input.side,
					amount: input.amount,
					remaining: input.amount,
					clientOrderId: input.aboveClientOrderId,
					listClientOrderId: input.listClientOrderId,
					orderListId: "list-1",
				},
			],
		};
	}

	async cancelOrder(id: string, symbol: string): Promise<void> {
		this.ensureEnabled(symbol);
		this.calls.push(`cancel:${id}:${symbol}`);
	}

	async cancelOrderList(orderListId: string, symbol: string): Promise<void> {
		this.ensureEnabled(symbol);
		this.calls.push(`cancel-list:${orderListId}:${symbol}`);
	}

	async getTopMarkets(_limit: number): Promise<Ticker[]> {
		return [
			{ symbol: SPOT_SYMBOL, last: 100, quoteVolume24h: 10_000, timestamp: FIXED_TIMESTAMP },
			{ symbol: FUTURES_SYMBOL, last: 100, quoteVolume24h: 9_000, timestamp: FIXED_TIMESTAMP },
		].filter(
			(ticker) =>
				this.marketType === "both" ||
				(this.isFutures(ticker.symbol) ? this.marketType === "usdm-futures" : this.marketType === "spot"),
		);
	}

	async getFundingRate(symbol: string): Promise<{ symbol: string; rate?: number; nextFundingTime?: number }> {
		this.ensureFutures(symbol);
		return {
			symbol,
			...(this.fundingRateValue !== undefined ? { rate: this.fundingRateValue } : {}),
			nextFundingTime: FIXED_TIMESTAMP + 3_600_000,
		};
	}

	async getFundingRateHistory(symbol: string, _limit?: number): Promise<FundingRateRecord[]> {
		this.ensureFutures(symbol);
		return [
			{
				symbol,
				fundingTime: FIXED_TIMESTAMP,
				...(this.fundingHistoryRate !== undefined ? { rate: this.fundingHistoryRate } : {}),
				markPrice: 100,
			},
		];
	}

	async setLeverage(symbol: string, leverage: number): Promise<void> {
		this.ensureFutures(symbol);
		this.calls.push(`leverage:${symbol}:${leverage}`);
	}

	getEffectiveLeverage(_symbol: string): number {
		return 1;
	}

	async setMarginMode(symbol: string, marginType: "isolated" | "cross"): Promise<void> {
		this.ensureFutures(symbol);
		this.calls.push(`margin:${symbol}:${marginType}`);
	}

	async setMultiAssetsMode(enabled: boolean): Promise<void> {
		if (this.mode !== "live" || this.id !== "binance" || this.marketType !== "usdm-futures")
			throw new Error("Multi-Assets mode is available only for live Binance USDⓈ-M futures");
		this.calls.push(`multi-assets:${enabled}`);
	}

	async close(): Promise<void> {}
}

function createAvailabilityRuntime(overrides: Partial<TradingConfig> = {}): {
	runtime: TradingRuntime;
	exchange: DeterministicExchange;
} {
	const config: TradingConfig = {
		...DEFAULT_CONFIG,
		...overrides,
		risk: { ...DEFAULT_CONFIG.risk, ...(overrides.risk ?? {}) },
		paper: { ...DEFAULT_CONFIG.paper, ...(overrides.paper ?? {}) },
		monitor: { ...DEFAULT_CONFIG.monitor, ...(overrides.monitor ?? {}) },
	};
	const exchange = new DeterministicExchange(config);
	let riskState = {
		paper: { date: "2026-01-01", usedDailyNotional: 0 },
		live: { date: "2026-01-01", usedDailyNotional: 0 },
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
		{
			load: () => structuredClone(riskState),
			save: (next) => {
				riskState = structuredClone(next);
			},
			transact: (mutator) => {
				const draft = structuredClone(riskState);
				const result = mutator(draft);
				riskState = structuredClone(draft);
				return result;
			},
		},
		undefined,
		{ accountId: "fixture-account", durability: "memory" },
	);
	return { runtime: { config, mode: config.mode, tradingEngine: engine } as unknown as TradingRuntime, exchange };
}

function registeredTool(name: string, runtime: TradingRuntime) {
	const tool = createTradingTools(() => runtime).find((candidate) => candidate.name === name);
	if (!tool) throw new Error(`Missing registered tool ${name}`);
	return tool;
}

async function executeWithDetails(tool: ReturnType<typeof registeredTool>, params: unknown, id: string) {
	const result = await tool.execute(id, params as never, undefined, undefined, context);
	expect(result.details).toBeDefined();
	expect(result.content[0]?.type).toBe("text");
	return result.details as Record<string, unknown>;
}

describe("provider injection seam", () => {
	it("proves the process singleton is uninitialized in this suite", () => {
		expect(() => getTrading()).toThrow("Trading runtime not initialized");
	});

	it("does not call an injected provider during factory construction", () => {
		const { runtime } = createSeamRuntime();
		const provider: TradingProvider = vi.fn(() => runtime);

		createGetPriceTool(provider);
		createGetOrderStatusTool(provider);
		expect(provider).not.toHaveBeenCalled();
	});

	it("builds the registry with an explicit provider and retains all 25 names", () => {
		const { runtime } = createSeamRuntime();
		const provider: TradingProvider = vi.fn(() => runtime);

		const names = createTradingTools(provider).map((tool) => tool.name);

		expect(provider).toHaveBeenCalledTimes(0);
		expect(names).toHaveLength(25);
		expect(new Set(names).size).toBe(25);
		expect(names).toEqual(REGISTERED_TOOL_NAMES);
		expect(names).not.toContain("get_funding_rate");
		expect(names).not.toContain("get_futures_positions");
	});

	it("executes a registered market read through the injected provider", async () => {
		const { runtime, getTicker } = createSeamRuntime();
		const provider: TradingProvider = vi.fn(() => runtime);

		const getPrice = createTradingTools(provider).find((tool) => tool.name === "get_price");
		expect(getPrice).toBeDefined();

		const result = await getPrice!.execute("price", { symbol: "BTC/USDT" }, undefined, undefined, context);
		const data = result.details as { symbol: string; last: number | null };

		expect(provider).toHaveBeenCalledTimes(1);
		expect(getTicker).toHaveBeenCalledTimes(1);
		expect(getTicker).toHaveBeenCalledWith("BTC/USDT");
		expect(data).toMatchObject({ symbol: "BTC/USDT", last: 100 });
	});

	it("executes the order-status handler through the injected engine exactly once", async () => {
		const { runtime, getOrder } = createSeamRuntime();
		const provider: TradingProvider = vi.fn(() => runtime);

		const tool = createGetOrderStatusTool(provider);
		const result = await tool.execute("status", { id: "o-1", symbol: "BTC/USDT" }, undefined, undefined, context);
		const data = result.details as { status: string; error: null; order: { id: string; symbol: string } };

		expect(provider).toHaveBeenCalledTimes(1);
		expect(getOrder).toHaveBeenCalledTimes(1);
		expect(getOrder).toHaveBeenCalledWith("o-1", "BTC/USDT");
		expect(data).toMatchObject({ status: "ok", error: null, order: { id: "o-1", symbol: "BTC/USDT" } });
	});

	it("executes the order-list-status handler through the injected engine exactly once", async () => {
		const { runtime, getOrderList } = createSeamRuntime();
		const provider: TradingProvider = vi.fn(() => runtime);

		const tool = createGetOrderListStatusTool(provider);
		const result = await tool.execute("list-status", { orderListId: "ol-1" }, undefined, undefined, context);
		const data = result.details as {
			status: string;
			error: null;
			orderList: { id: string; listOrderStatus: string };
		};

		expect(provider).toHaveBeenCalledTimes(1);
		expect(getOrderList).toHaveBeenCalledTimes(1);
		expect(getOrderList).toHaveBeenCalledWith("ol-1");
		expect(data).toMatchObject({
			status: "ok",
			error: null,
			orderList: { id: "ol-1", listOrderStatus: "EXECUTING" },
		});
	});

	it("constructs the factory-only tools with the same provider without calling it", () => {
		const { runtime } = createSeamRuntime();
		const provider: TradingProvider = vi.fn(() => runtime);

		const funding = createGetFundingRateTool(provider);
		const futuresPositions = createGetFuturesPositionsTool(provider);
		const names = createTradingTools(provider).map((tool) => tool.name);

		expect(provider).not.toHaveBeenCalled();
		expect(funding.name).toBe("get_funding_rate");
		expect(futuresPositions.name).toBe("get_futures_positions");
		expect(names).toHaveLength(25);
		expect(names).toEqual(REGISTERED_TOOL_NAMES);
	});
});

describe("deterministic default-tool availability", () => {
	type AvailabilityCase = {
		name: (typeof REGISTERED_TOOL_NAMES)[number];
		config?: Partial<TradingConfig>;
		params: Record<string, unknown>;
		assert: (details: Record<string, unknown>) => void;
	};

	const cases: AvailabilityCase[] = [
		{
			name: "get_price",
			params: { symbol: SPOT_SYMBOL },
			assert: (details) => expect(details).toMatchObject({ symbol: SPOT_SYMBOL, last: 100 }),
		},
		{
			name: "get_order_book",
			params: { symbol: SPOT_SYMBOL },
			assert: (details) => expect(details).toMatchObject({ symbol: SPOT_SYMBOL, bidDepth: 2, askDepth: 2 }),
		},
		{
			name: "get_market_info",
			params: { symbol: SPOT_SYMBOL },
			assert: (details) =>
				expect(details).toMatchObject({ symbol: SPOT_SYMBOL, marketType: "spot", contract: false }),
		},
		{
			name: "get_contract_stats",
			config: { exchange: "binance", marketType: "usdm-futures" },
			params: { symbol: FUTURES_SYMBOL },
			assert: (details) => {
				expect(details).toMatchObject({ symbol: FUTURES_SYMBOL, markPrice: 100.1 });
				// The deterministic adapter omits seven optional metrics; every one
				// must still appear in the response as an explicit finite value or null.
				const metrics = [
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
				for (const field of metrics) {
					expect(details[field]).not.toBeUndefined();
					expect(details[field] === null || typeof details[field] === "number").toBe(true);
				}
				expect(details.dataQuality).toMatchObject({ markPrice: true, openInterest: true, basis: false });
				expect(details.warnings).toEqual(expect.arrayContaining(["basis unavailable"]));
				expect(details.warnings).not.toContain("mark price unavailable");
			},
		},
		{
			name: "get_klines",
			params: { symbol: SPOT_SYMBOL, timeframe: "1h", limit: 1 },
			assert: (details) => expect(details).toMatchObject({ symbol: SPOT_SYMBOL, count: 1 }),
		},
		{
			name: "get_top_markets",
			params: { limit: 1 },
			assert: (details) => expect(details).toMatchObject({ count: 1, limit: 1 }),
		},
		{
			name: "get_trading_capabilities",
			config: { exchange: "binance", marketType: "spot" },
			params: { symbol: SPOT_SYMBOL },
			assert: (details) => expect(details).toMatchObject({ marketFamily: "spot", overallStatus: "ready" }),
		},
		{
			name: "get_balance",
			params: {},
			assert: (details) => expect(details).toMatchObject({ totalQuoteValue: 10_200 }),
		},
		{
			name: "get_positions",
			params: {},
			assert: (details) => expect(details).toMatchObject({ count: 1 }),
		},
		{
			name: "get_portfolio_snapshot",
			params: {},
			assert: (details) => expect(details).toHaveProperty("account"),
		},
		{
			name: "get_open_orders",
			params: { symbol: SPOT_SYMBOL },
			assert: (details) => expect(details).toMatchObject({ count: 1 }),
		},
		{
			name: "get_order_history",
			params: { symbol: SPOT_SYMBOL, limit: 5 },
			assert: (details) => expect(details).toMatchObject({ count: 1 }),
		},
		{
			name: "get_order_status",
			params: { symbol: SPOT_SYMBOL, id: "order-1" },
			assert: (details) => expect(details).toMatchObject({ status: "ok", order: { id: "order-1" } }),
		},
		{
			name: "get_order_list_status",
			params: { orderListId: "list-1" },
			assert: (details) => expect(details).toMatchObject({ status: "ok", orderList: { id: "list-1" } }),
		},
		{
			name: "check_order",
			params: { side: "buy", symbol: SPOT_SYMBOL, type: "market", amount: 0.1 },
			assert: (details) => expect(details).toMatchObject({ status: "ok", phase: "preflight" }),
		},
		{
			name: "buy",
			params: { symbol: SPOT_SYMBOL, type: "market", amount: 0.1 },
			assert: (details) => expect(details).toMatchObject({ status: "ok", order: { symbol: SPOT_SYMBOL } }),
		},
		{
			name: "sell",
			params: { symbol: SPOT_SYMBOL, type: "market", amount: 0.1 },
			assert: (details) => expect(details).toMatchObject({ status: "ok", order: { symbol: SPOT_SYMBOL } }),
		},
		{
			name: "place_oco",
			params: { symbol: SPOT_SYMBOL, side: "sell", amount: 0.1, stopLossPrice: 90, takeProfitPrice: 110 },
			assert: (details) => expect(details).toMatchObject({ status: "ok", orders: expect.any(Array) }),
		},
		{
			name: "cancel_order",
			params: { id: "order-open", symbol: SPOT_SYMBOL },
			assert: (details) => expect(details).toMatchObject({ status: "ok", cancelled: "order-open" }),
		},
		{
			name: "cancel_order_list",
			params: { orderListId: "list-1", symbol: SPOT_SYMBOL },
			assert: (details) => expect(details).toMatchObject({ status: "ok", cancelledOrderListId: "list-1" }),
		},
		{
			name: "get_risk_status",
			config: { exchange: "binance", marketType: "spot" },
			params: {},
			assert: (details) => expect(details).toHaveProperty("breakdown"),
		},
		{
			name: "get_funding_rate_history",
			config: { mode: "live", exchange: "binance", marketType: "usdm-futures", orderApproval: "unattended" },
			params: { symbol: FUTURES_SYMBOL, limit: 1 },
			assert: (details) => expect(details).toMatchObject({ symbol: FUTURES_SYMBOL, count: 1 }),
		},
		{
			name: "set_leverage",
			config: { exchange: "binance", marketType: "usdm-futures" },
			params: { symbol: FUTURES_SYMBOL, leverage: 5 },
			assert: (details) => expect(details).toMatchObject({ status: "ok", leverage: 5 }),
		},
		{
			name: "set_margin_mode",
			config: { exchange: "binance", marketType: "usdm-futures" },
			params: { symbol: FUTURES_SYMBOL, marginType: "isolated" },
			assert: (details) => expect(details).toMatchObject({ status: "ok", marginType: "isolated" }),
		},
		{
			name: "set_multi_assets_mode",
			config: { mode: "live", exchange: "binance", marketType: "usdm-futures", orderApproval: "unattended" },
			params: { enabled: false },
			assert: (details) => expect(details).toMatchObject({ status: "ok", enabled: false }),
		},
	];

	it.each(cases)("executes $name with a fresh deterministic runtime", async ({ name, config, params, assert }) => {
		const { runtime } = createAvailabilityRuntime(config);
		const details = await executeWithDetails(registeredTool(name, runtime), params, name);
		expect(Object.keys(details).length).toBeGreaterThan(1);
		assert(details);
	});

	it("executes both factory-only tools in a supported futures runtime", async () => {
		const { runtime } = createAvailabilityRuntime({ exchange: "binance", marketType: "usdm-futures" });
		const funding = createGetFundingRateTool(() => runtime);
		const positions = createGetFuturesPositionsTool(() => runtime);
		const fundingDetails = await executeWithDetails(funding, { symbol: FUTURES_SYMBOL }, "funding");
		const positionDetails = await executeWithDetails(positions, {}, "futures-positions");
		expect(fundingDetails).toMatchObject({ symbol: FUTURES_SYMBOL, rate: 0.0001 });
		expect(positionDetails).toMatchObject({ marketType: "usdm-futures", positions: expect.any(Array) });
	});

	it("reports a missing live funding rate as unavailable instead of zero", async () => {
		const { runtime, exchange } = createAvailabilityRuntime({
			mode: "live",
			exchange: "binance",
			marketType: "usdm-futures",
			orderApproval: "unattended",
		});
		exchange.fundingRateValue = undefined;

		const details = await executeWithDetails(
			createGetFundingRateTool(() => runtime),
			{ symbol: FUTURES_SYMBOL },
			"funding-missing",
		);

		expect(details).toMatchObject({
			symbol: FUTURES_SYMBOL,
			rate: null,
			dataQuality: { available: false, observed: false },
			warnings: ["Funding rate unavailable"],
		});
	});

	it("marks incomplete funding history records as unavailable", async () => {
		const { runtime, exchange } = createAvailabilityRuntime({
			mode: "live",
			exchange: "binance",
			marketType: "usdm-futures",
			orderApproval: "unattended",
		});
		exchange.fundingHistoryRate = undefined;

		const details = await executeWithDetails(
			registeredTool("get_funding_rate_history", runtime),
			{ symbol: FUTURES_SYMBOL, limit: 1 },
			"funding-history-missing",
		);

		expect(details).toMatchObject({
			count: 1,
			records: [{ rate: null }],
			dataQuality: { available: false },
			warnings: ["1 funding rate record(s) unavailable"],
		});
	});

	it("routes Paper Binance risk history account-wide without a symbol warning", async () => {
		const { runtime, exchange } = createAvailabilityRuntime({ exchange: "binance", marketType: "spot" });
		const details = await executeWithDetails(registeredTool("get_risk_status", runtime), {}, "risk-paper-binance");
		expect(exchange.historyQueries).toEqual([undefined]);
		expect(details).toMatchObject({ breakdown: { closedHistoryAvailable: true }, warnings: [] });
	});

	it.each([
		["get_contract_stats", { symbol: FUTURES_SYMBOL }, /Contract stats.*spot markets/],
		["get_funding_rate_history", { symbol: SPOT_SYMBOL }, /Funding rate history.*spot markets/],
		["set_leverage", { symbol: FUTURES_SYMBOL, leverage: 5 }, /Leverage.*spot markets/],
		["set_margin_mode", { symbol: FUTURES_SYMBOL, marginType: "isolated" }, /Margin mode.*spot markets/],
		["get_futures_positions", {}, /unavailable in spot mode/],
	] as const)("rejects %s explicitly in Paper spot", async (name, params, expected) => {
		const { runtime } = createAvailabilityRuntime({ exchange: "binance", marketType: "spot" });
		const tool =
			name === "get_futures_positions"
				? createGetFuturesPositionsTool(() => runtime)
				: registeredTool(name, runtime);
		await expect(tool.execute(`unsupported-${name}`, params, undefined, undefined, context)).rejects.toThrow(
			expected,
		);
	});

	it("rejects Paper spot current funding-rate factory explicitly", async () => {
		const { runtime } = createAvailabilityRuntime({ exchange: "binance", marketType: "spot" });
		await expect(
			createGetFundingRateTool(() => runtime).execute(
				"unsupported-funding",
				{ symbol: SPOT_SYMBOL },
				undefined,
				undefined,
				context,
			),
		).rejects.toThrow(/Funding rate.*spot markets/);
	});

	it("rejects Paper spot Multi-Assets mode explicitly", async () => {
		const { runtime } = createAvailabilityRuntime({ exchange: "binance", marketType: "spot" });
		await expect(
			registeredTool("set_multi_assets_mode", runtime).execute(
				"unsupported-multi-assets",
				{ enabled: false },
				undefined,
				undefined,
				context,
			),
		).rejects.toThrow(/Multi-Assets mode.*live Binance USDⓈ-M futures/);
	});

	it.each([
		["buy", { symbol: FUTURES_SYMBOL, type: "limit", amount: 1, price: 100 }],
		["sell", { symbol: FUTURES_SYMBOL, type: "stop_market", amount: 1, stopPrice: 90 }],
	] as const)("rejects Paper futures %s non-market orders at the tool boundary", async (name, params) => {
		const { runtime } = createAvailabilityRuntime({ exchange: "binance", marketType: "usdm-futures" });
		await expect(
			registeredTool(name, runtime).execute(`unsupported-${name}`, params, undefined, undefined, context),
		).rejects.toThrow(/Paper futures currently accept market orders only/);
	});

	it("reports Paper futures non-market preflight as rejected with a capability reason", async () => {
		const { runtime } = createAvailabilityRuntime({ exchange: "binance", marketType: "usdm-futures" });
		const details = await executeWithDetails(
			registeredTool("check_order", runtime),
			{ side: "buy", symbol: FUTURES_SYMBOL, type: "limit", amount: 1, price: 100 },
			"unsupported-check",
		);
		expect(details).toMatchObject({ status: "rejected", phase: "preflight" });
		expect(details.reason).toMatch(/Paper futures currently accept market orders only/);
	});

	it("executes a Paper futures market order through the injected runtime", async () => {
		const { runtime, exchange } = createAvailabilityRuntime({ marketType: "usdm-futures" });
		const details = await executeWithDetails(
			registeredTool("buy", runtime),
			{ symbol: FUTURES_SYMBOL, type: "market", amount: 1 },
			"paper-futures-market",
		);
		expect(details).toMatchObject({ status: "ok", mode: "paper", order: { symbol: FUTURES_SYMBOL, type: "market" } });
		expect(exchange.calls).toEqual([]);
	});

	it("rejects Paper futures OCO and Multi-Assets operations explicitly", async () => {
		const { runtime } = createAvailabilityRuntime({ exchange: "binance", marketType: "usdm-futures" });
		await expect(
			registeredTool("place_oco", runtime).execute(
				"unsupported-oco",
				{ symbol: FUTURES_SYMBOL, side: "sell", amount: 1, stopLossPrice: 90, takeProfitPrice: 110 },
				undefined,
				undefined,
				context,
			),
		).rejects.toThrow(/OCO orders are supported only for spot markets/);
		await expect(
			registeredTool("set_multi_assets_mode", runtime).execute(
				"unsupported-multi-assets",
				{ enabled: false },
				undefined,
				undefined,
				context,
			),
		).rejects.toThrow(/Multi-Assets mode.*live Binance USDⓈ-M futures/);
	});

	it("keeps stop and take-profit capability families distinct", async () => {
		const { runtime, exchange } = createAvailabilityRuntime({ exchange: "binance", marketType: "spot" });
		vi.spyOn(exchange, "getMarketInfo").mockResolvedValue({ ...spotMarketInfo(), orderTypes: ["stop_market"] });
		const details = await executeWithDetails(
			registeredTool("get_trading_capabilities", runtime),
			{ symbol: SPOT_SYMBOL },
			"capability-distinct",
		);
		const capabilities = details.capabilities as {
			orderTypes: {
				stop: { status: string };
				stop_market: { status: string };
				take_profit: { status: string };
				take_profit_market: { status: string };
			};
		};
		expect(capabilities.orderTypes.stop.status).toBe("unsupported");
		expect(capabilities.orderTypes.stop_market.status).toBe("supported");
		expect(capabilities.orderTypes.take_profit.status).toBe("unsupported");
		expect(capabilities.orderTypes.take_profit_market.status).toBe("unsupported");
	});

	it("reports Binance USDⓈ-M client-order-id lookup as supported in live futures capabilities", async () => {
		const { runtime } = createAvailabilityRuntime({
			mode: "live",
			exchange: "binance",
			marketType: "usdm-futures",
			orderApproval: "unattended",
		});
		const details = await executeWithDetails(
			registeredTool("get_trading_capabilities", runtime),
			{ symbol: FUTURES_SYMBOL },
			"capability-client-order-id",
		);
		const capabilities = details.capabilities as { clientOrderIdLookup: { status: string; reason: string } };
		expect(capabilities.clientOrderIdLookup.status).toBe("supported");
		expect(capabilities.clientOrderIdLookup.reason).toMatch(
			/Binance USDⓈ-M futures.*offline correlated adapter contract coverage/,
		);
	});

	it("requires explicit futures orientation for capability certainty but accepts omitted orientation in preflight", async () => {
		const { runtime, exchange } = createAvailabilityRuntime({ exchange: "binance", marketType: "usdm-futures" });
		vi.spyOn(exchange, "getMarketInfo").mockResolvedValue({
			...futuresMarketInfo(),
			linear: undefined,
			inverse: undefined,
		});
		const capabilityDetails = await executeWithDetails(
			registeredTool("get_trading_capabilities", runtime),
			{ symbol: FUTURES_SYMBOL },
			"capability-orientation-unknown",
		);
		expect(capabilityDetails.overallStatus).toBe("unknown");
		const preflightDetails = await executeWithDetails(
			registeredTool("check_order", runtime),
			{ side: "buy", symbol: FUTURES_SYMBOL, type: "market", amount: 1 },
			"preflight-orientation-omitted",
		);
		expect(preflightDetails.status).toBe("unknown");
		expect((preflightDetails.unknownReasons as string[]).join(" ")).toMatch(/not confirmed as a linear contract/);
	});

	it("reports inactive markets as unsupported across the capability set", async () => {
		const { runtime, exchange } = createAvailabilityRuntime({ exchange: "binance", marketType: "spot" });
		vi.spyOn(exchange, "getMarketInfo").mockResolvedValue({ ...spotMarketInfo(), active: false });
		const details = await executeWithDetails(
			registeredTool("get_trading_capabilities", runtime),
			{ symbol: SPOT_SYMBOL },
			"capability-inactive",
		);
		expect(details.overallStatus).toBe("unsupported");
		expect((details.capabilities as { orderTypes: { market: { status: string } } }).orderTypes.market.status).toBe(
			"unsupported",
		);
	});

	it("does not accept contradictory futures orientation metadata", async () => {
		const { runtime, exchange } = createAvailabilityRuntime({ exchange: "binance", marketType: "usdm-futures" });
		vi.spyOn(exchange, "getMarketInfo").mockResolvedValue({ ...futuresMarketInfo(), linear: true, inverse: true });
		const details = await executeWithDetails(
			registeredTool("get_trading_capabilities", runtime),
			{ symbol: FUTURES_SYMBOL },
			"capability-orientation-contradictory",
		);
		expect(details.overallStatus).toBe("unknown");
	});

	it("maps explicit Binance Spot conditional aliases without substring matching", async () => {
		const { runtime, exchange } = createAvailabilityRuntime({ exchange: "binance", marketType: "spot" });
		vi.spyOn(exchange, "getMarketInfo").mockResolvedValue({
			...spotMarketInfo(),
			orderTypes: ["STOP_LOSS", "STOP_LOSS_LIMIT", "TAKE_PROFIT", "TAKE_PROFIT_LIMIT"],
		});
		const details = await executeWithDetails(
			registeredTool("get_trading_capabilities", runtime),
			{ symbol: SPOT_SYMBOL },
			"capability-aliases",
		);
		const capabilities = details.capabilities as {
			orderTypes: {
				stop: { status: string };
				take_profit: { status: string };
			};
		};
		expect(capabilities.orderTypes.stop.status).toBe("supported");
		expect(capabilities.orderTypes.take_profit.status).toBe("supported");
	});

	it("keeps explicitly empty Binance Spot order types unsupported", async () => {
		const { runtime, exchange } = createAvailabilityRuntime({ exchange: "binance", marketType: "spot" });
		vi.spyOn(exchange, "getMarketInfo").mockResolvedValue({
			...spotMarketInfo(),
			orderTypes: [],
		});
		const details = await executeWithDetails(
			registeredTool("get_trading_capabilities", runtime),
			{ symbol: SPOT_SYMBOL },
			"capability-empty-order-types",
		);
		const capabilities = details.capabilities as {
			orderTypes: {
				market: { status: string };
				stop: { status: string };
			};
		};
		expect(capabilities.orderTypes.market.status).toBe("unsupported");
		expect(capabilities.orderTypes.stop.status).toBe("unsupported");
	});
});
