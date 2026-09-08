import ccxt from "ccxt";
import { describe, expect, it } from "vitest";
import { CcxtExchangeClient } from "./ccxt-client.ts";
import type { MarketType } from "./client-types.ts";

interface RawOrder {
	id: string;
	symbol: string;
	side: "buy" | "sell";
	type?: string;
	status?: string;
	amount?: number;
	filled?: number;
	remaining?: number;
	price?: number;
	average?: number;
	triggerPrice?: number;
	cost?: number;
	timestamp?: number;
	info?: Record<string, unknown>;
}

interface OrderQueryCall {
	symbol?: string;
	params: Record<string, unknown>;
}

interface CreateOrderCall {
	symbol: string;
	type: string;
	side: "buy" | "sell";
	amount: number | undefined;
	price: number | undefined;
	params: Record<string, unknown>;
}

interface CancelOrderCall {
	id: string;
	symbol: string;
	params: Record<string, unknown>;
}

class StubExchange {
	readonly events: string[] = [];
	readonly openCalls: OrderQueryCall[] = [];
	readonly balanceCalls: Array<Record<string, unknown>> = [];
	readonly positionCalls: Array<Record<string, unknown>> = [];
	readonly closedCalls: OrderQueryCall[] = [];
	readonly canceledCalls: OrderQueryCall[] = [];
	readonly orderCalls: OrderQueryCall[] = [];
	readonly createOrderCalls: CreateOrderCall[] = [];
	readonly cancelOrderCalls: CancelOrderCall[] = [];
	readonly rawCalls: Record<string, unknown>[] = [];
	readonly getOrderRawCalls: Record<string, unknown>[] = [];
	readonly futuresGetOrderRawCalls: Record<string, unknown>[] = [];
	readonly futuresGetAlgoOrderRawCalls: Record<string, unknown>[] = [];
	readonly getOrderListRawCalls: Record<string, unknown>[] = [];
	readonly clientOrderIdCalls: Array<{
		clientOrderId: string;
		symbol?: string;
		params: Record<string, unknown>;
	}> = [];
	trailingResponse: Record<string, unknown> = { orderId: 9, status: "NEW", executedQty: "0", transactTime: 1 };
	trailingError: Error | undefined;
	createOrderError: Error | undefined;
	createOrderOverrides: Partial<RawOrder> = {};
	fetchOrderResponse: RawOrder | undefined;
	readonly orderFetchCalls: Array<{ id: string; symbol: string; params: Record<string, unknown> }> = [];
	ocoError: Error | undefined;
	orderQueryError: Error | undefined;
	futuresOrderQueryError: Error | undefined;
	futuresAlgoQueryError: Error | undefined;
	cancelError: Error | undefined;
	orderListCancelError: Error | undefined;
	orderListQueryError: Error | undefined;
	positionsError: Error | undefined;
	orderQueryResponse: RawOrder = rawOrder("queried", "NEW");
	clientOrderIdResponse: RawOrder = rawOrder("client-id-queried", "NEW");
	clientOrderIdError: Error | undefined;
	orderListQueryResponse: Record<string, unknown> | undefined;
	ocoResponse: Record<string, unknown> = {
		orderListId: 42,
		listOrderStatus: "EXEC_STARTED",
		orderReports: [
			{ orderId: 10, type: "LIMIT_MAKER", price: "120", status: "NEW", executedQty: "0" },
			{ orderId: 11, type: "STOP_LOSS_LIMIT", price: "90", stopPrice: "90", status: "NEW", executedQty: "0" },
		],
	};
	privatePostOrder = async (params: Record<string, unknown>) => {
		this.rawCalls.push(params);
		if (this.trailingError) throw this.trailingError;
		return this.trailingResponse;
	};
	privatePostOrderListOco = async (params: Record<string, unknown>) => {
		this.rawCalls.push(params);
		if (this.ocoError) throw this.ocoError;
		return {
			...this.ocoResponse,
			listClientOrderId: params.listClientOrderId,
			orderReports: Array.isArray(this.ocoResponse.orderReports)
				? this.ocoResponse.orderReports.map((report, index) => ({
						...report,
						clientOrderId: index === 0 ? params.aboveClientOrderId : params.belowClientOrderId,
					}))
				: this.ocoResponse.orderReports,
		};
	};
	privateGetOrder = async (params: Record<string, unknown>) => {
		this.getOrderRawCalls.push(params);
		if (this.orderQueryError) throw this.orderQueryError;
		return this.orderQueryResponse;
	};
	fapiPrivateGetOrder = async (params: Record<string, unknown>) => {
		this.futuresGetOrderRawCalls.push(params);
		if (this.futuresOrderQueryError) throw this.futuresOrderQueryError;
		return this.orderQueryResponse;
	};
	fapiPrivateGetAlgoOrder = async (params: Record<string, unknown>) => {
		this.futuresGetAlgoOrderRawCalls.push(params);
		if (this.futuresAlgoQueryError) throw this.futuresAlgoQueryError;
		return this.orderQueryResponse;
	};
	privateGetOrderList = async (params: Record<string, unknown>) => {
		this.getOrderListRawCalls.push(params);
		if (this.orderListQueryError) throw this.orderListQueryError;
		return this.orderListQueryResponse ?? { orderListId: 42, listOrderStatus: "EXEC_STARTED", orderReports: [] };
	};
	fetchOrderWithClientOrderId = async (
		clientOrderId: string,
		symbol?: string,
		params: Record<string, unknown> = {},
	): Promise<RawOrder> => {
		this.clientOrderIdCalls.push({ clientOrderId, symbol, params });
		if (this.clientOrderIdError) throw this.clientOrderIdError;
		return this.clientOrderIdResponse;
	};
	privateDeleteOrderList = async (params: Record<string, unknown>) => {
		this.getOrderListRawCalls.push(params);
		if (this.orderListCancelError) throw this.orderListCancelError;
		return {};
	};
	readonly has: Record<string, boolean | "emulated" | undefined> = {
		fetchCanceledOrders: true,
		fetchMyTrades: true,
		fetchOrderWithClientOrderId: undefined,
	};
	/** Futures amount metadata is expressed in exchange contracts. */
	futuresContractSize: number | undefined = 1;
	futuresLinear = true;
	futuresAmountDigits: number | undefined;
	futuresAmountMin: number | undefined = 0.001;
	futuresAmountMax: number | undefined = undefined;
	futuresPositions: Array<Record<string, unknown>> = [];
	options: { defaultType?: string } = { defaultType: "spot" };
	balances: Record<string, number> = { BTC: 1, USDT: 1000 };
	freeBalances: Record<string, unknown> | undefined;
	usedBalances: Record<string, unknown> | undefined;
	trades: Array<Record<string, unknown>> = [];
	fundingRate: Record<string, unknown> = {
		fundingRate: 0.0001,
		nextFundingTimestamp: 3_600_001,
		info: {},
	};
	fundingHistory: Array<Record<string, unknown>> = [{ fundingRate: 0.0001, timestamp: 1, info: {} }];
	openInterest: Record<string, unknown> = {
		openInterestAmount: 2,
		openInterestValue: 200,
	};
	openBase: RawOrder[] = [];
	openConditional: RawOrder[] = [];
	openTrigger: RawOrder[] = [];
	openTrailing: RawOrder[] = [];
	openOco: RawOrder[] = [];
	closedBase: RawOrder[] = [];
	closedConditional: RawOrder[] = [];
	closedTrigger: RawOrder[] = [];
	closedTrailing: RawOrder[] = [];
	closedOco: RawOrder[] = [];
	canceledBase: RawOrder[] = [];
	canceledConditional: RawOrder[] = [];
	canceledTrigger: RawOrder[] = [];
	canceledTrailing: RawOrder[] = [];
	canceledOco: RawOrder[] = [];
	allOrders: RawOrder[] = [];
	ohlcv: number[][] = [];
	orderBook: {
		bids: Array<[number, number]>;
		asks: Array<[number, number]>;
		timestamp?: number;
	} = {
		bids: [[99, 2]],
		asks: [[101, 3]],
		timestamp: 1,
	};
	tickers: Record<string, Record<string, unknown>> = {};
	tickerOverrides: Record<string, unknown> = {};
	last: number | undefined = 100;
	markets = {
		"BTC/USDT": {
			id: "BTCUSDT",
			symbol: "BTC/USDT",
			base: "BTC",
			quote: "USDT",
			spot: true,
			swap: false,
			contract: false,
			limits: { amount: { min: 0.001 }, cost: {} },
			info: {
				filters: [
					{ filterType: "PRICE_FILTER", minPrice: "0.01", maxPrice: "100000", tickSize: "0.01" },
					{ filterType: "LOT_SIZE", minQty: "0.001", maxQty: "100", stepSize: "0.001" },
					{ filterType: "MARKET_LOT_SIZE", minQty: "0.01", maxQty: "100", stepSize: "0.01" },
					{
						filterType: "NOTIONAL",
						minNotional: "10",
						maxNotional: "1000000",
						applyMinToMarket: true,
						applyMaxToMarket: true,
					},
					{ filterType: "MIN_NOTIONAL", minNotional: "5", applyToMarket: false },
					{
						filterType: "TRAILING_DELTA",
						minTrailingAboveDelta: 100,
						maxTrailingAboveDelta: 5000,
						minTrailingBelowDelta: 10,
						maxTrailingBelowDelta: 1000,
					},
				],
			},
		},
		"BTC/USDT:USDT": {
			id: "BTCUSDT",
			symbol: "BTC/USDT:USDT",
			base: "BTC",
			quote: "USDT",
			settle: "USDT",
			spot: false,
			swap: true,
			contract: true,
			linear: this.futuresLinear,
			inverse: false,
			active: true,
			contractSize: this.futuresContractSize,
			limits: { amount: { min: this.futuresAmountMin, max: this.futuresAmountMax }, cost: {} },
		},
		"BTC/USDC:USDC": {
			id: "BTCUSDC",
			symbol: "BTC/USDC:USDC",
			base: "BTC",
			quote: "USDC",
			settle: "USDC",
			spot: false,
			swap: true,
			contract: true,
			linear: true,
			inverse: false,
			contractSize: 1,
			limits: { amount: { min: 0.001 }, cost: {} },
		},
		"BTC/USDT:USDC": {
			id: "BTCUSDT_USDC",
			symbol: "BTC/USDT:USDC",
			base: "BTC",
			quote: "USDT",
			settle: "USDC",
			spot: false,
			swap: true,
			contract: true,
			linear: true,
			inverse: false,
			contractSize: 1,
			limits: { amount: { min: 0.001 }, cost: {} },
		},
		"ETH/USDT:USDT:DELIVERY": {
			id: "ETHUSDT_240628",
			symbol: "ETH/USDT:USDT:DELIVERY",
			base: "ETH",
			quote: "USDT",
			settle: "USDT",
			spot: false,
			swap: false,
			contract: true,
			linear: true,
			inverse: false,
			contractSize: 1,
			limits: { amount: { min: 0.001 }, cost: {} },
		},
	};

	async loadMarkets(): Promise<typeof this.markets> {
		this.events.push("loadMarkets");
		return this.markets;
	}

	amountToPrecision(_symbol: string, amount: number): string {
		if (_symbol.includes(":") && this.futuresAmountDigits !== undefined) {
			return amount.toFixed(this.futuresAmountDigits);
		}
		return String(amount);
	}

	priceToPrecision(_symbol: string, price: number): string {
		return String(price);
	}

	async fetchTicker(symbol: string) {
		return {
			symbol,
			last: this.last,
			bid: this.last === undefined ? undefined : this.last - 1,
			ask: this.last === undefined ? undefined : this.last + 1,
			timestamp: 1,
			...this.tickerOverrides,
		};
	}

	async fetchBalance(params: Record<string, unknown> = {}) {
		this.balanceCalls.push(params);
		return {
			total: this.balances,
			free: this.freeBalances ?? this.balances,
			used: this.usedBalances ?? Object.fromEntries(Object.keys(this.balances).map((asset) => [asset, 0])),
		};
	}

	async fetchOrderBook() {
		return this.orderBook;
	}

	async fetchTickers() {
		return this.tickers;
	}

	async fetchMyTrades(_symbol?: string, _since?: number, _limit?: number): Promise<Array<Record<string, unknown>>> {
		return this.trades;
	}

	async fetchPositions(
		_symbols?: string[],
		params: Record<string, unknown> = {},
	): Promise<Array<Record<string, unknown>>> {
		this.positionCalls.push(params);
		if (this.positionsError) throw this.positionsError;
		return this.futuresPositions;
	}

	async fetchFundingRate(_symbol: string): Promise<Record<string, unknown>> {
		return this.fundingRate;
	}

	async fetchOpenInterest(_symbol: string): Promise<Record<string, unknown>> {
		return this.openInterest;
	}

	async fetchFundingRateHistory(
		_symbol: string,
		_since?: number,
		_limit?: number,
	): Promise<Array<Record<string, unknown>>> {
		return this.fundingHistory;
	}

	async fetchOHLCV(_symbol: string, _timeframe: string, _since?: number, _limit?: number) {
		return this.ohlcv;
	}

	async fetchOpenOrders(
		symbol?: string,
		_since?: number,
		_limit?: number,
		params: Record<string, unknown> = {},
	): Promise<RawOrder[]> {
		this.openCalls.push({ symbol, params });
		return this.ordersFor(params, "open");
	}

	async fetchClosedOrders(
		symbol?: string,
		_since?: number,
		_limit?: number,
		params: Record<string, unknown> = {},
	): Promise<RawOrder[]> {
		this.closedCalls.push({ symbol, params });
		return this.ordersFor(params, "closed");
	}

	async fetchCanceledOrders(
		symbol?: string,
		_since?: number,
		_limit?: number,
		params: Record<string, unknown> = {},
	): Promise<RawOrder[]> {
		this.canceledCalls.push({ symbol, params });
		return this.ordersFor(params, "canceled");
	}

	async fetchOrders(symbol?: string, _since?: number, _limit?: number): Promise<RawOrder[]> {
		this.orderCalls.push({ symbol, params: {} });
		return this.allOrders;
	}

	async createOrder(
		symbol: string,
		type: string,
		side: "buy" | "sell",
		amount: number | undefined,
		price: number | undefined,
		params: Record<string, unknown>,
	): Promise<RawOrder> {
		this.events.push("createOrder");
		this.createOrderCalls.push({ symbol, type, side, amount, price, params });
		if (this.createOrderError) throw this.createOrderError;
		return {
			id: `created-${this.createOrderCalls.length}`,
			symbol,
			side,
			type,
			status: "NEW",
			amount: amount ?? 0,
			filled: 0,
			remaining: amount ?? 0,
			cost: 0,
			timestamp: 1,
			info: params,
			...this.createOrderOverrides,
		};
	}

	async fetchOrder(id: string, symbol: string, params: Record<string, unknown> = {}): Promise<RawOrder> {
		this.orderFetchCalls.push({ id, symbol, params });
		return this.fetchOrderResponse ?? this.orderQueryResponse;
	}

	async setPositionMode(hedged: boolean): Promise<void> {
		this.events.push(`setPositionMode:${hedged}`);
	}

	async setMarginMode(marginType: string, symbol: string): Promise<void> {
		this.events.push(`setMarginMode:${marginType}:${symbol}`);
	}

	async setLeverage(leverage: number, symbol: string): Promise<void> {
		this.events.push(`setLeverage:${leverage}:${symbol}`);
	}

	async cancelOrder(id: string, symbol: string, params: Record<string, unknown> = {}): Promise<void> {
		this.cancelOrderCalls.push({ id, symbol, params });
		if (this.cancelError) throw this.cancelError;
		if (params.ordType !== "conditional") throw new Error("regular-order cancel failed");
	}

	parseOrder(raw: RawOrder): RawOrder {
		return raw;
	}

	safeSymbol(symbol: string): string {
		return symbol === "BTCUSDT" ? "BTC/USDT" : symbol;
	}

	async close(): Promise<void> {}

	private ordersFor(params: Record<string, unknown>, kind: "open" | "closed" | "canceled"): RawOrder[] {
		if (params.ordType === "conditional") {
			if (kind === "open") return this.openConditional;
			return kind === "closed" ? this.closedConditional : this.canceledConditional;
		}
		if (params.ordType === "oco") {
			if (kind === "open") return this.openOco;
			return kind === "closed" ? this.closedOco : this.canceledOco;
		}
		if (params.trailing === true) {
			if (kind === "open") return this.openTrailing;
			return kind === "closed" ? this.closedTrailing : this.canceledTrailing;
		}
		if (params.trigger === true) {
			if (kind === "open") return this.openTrigger;
			return kind === "closed" ? this.closedTrigger : this.canceledTrigger;
		}
		if (kind === "open") return this.openBase;
		return kind === "closed" ? this.closedBase : this.canceledBase;
	}
}

function rawOrder(id: string, status: string, overrides: Partial<RawOrder> = {}): RawOrder {
	return {
		id,
		symbol: "BTC/USDT",
		side: "buy",
		type: "market",
		status,
		amount: 1,
		filled: 0,
		remaining: 1,
		cost: 0,
		timestamp: 1,
		info: {},
		...overrides,
	};
}

function newClient(
	id: "binance" | "okx",
	stub: StubExchange,
	marketType: MarketType = "spot",
	options: { leverage?: number; marginType?: "isolated" | "cross"; positionMode?: "one-way" | "hedge" } = {},
): CcxtExchangeClient {
	stub.options = { defaultType: marketType === "usdm-futures" ? "swap" : "spot" };
	const client = new CcxtExchangeClient(
		id,
		"USDT",
		{ apiKey: "test", secret: "test" },
		marketType,
		options.leverage ?? 1,
		options.marginType ?? "isolated",
		options.positionMode ?? "one-way",
	);
	(client as unknown as { exchange: StubExchange }).exchange = stub;
	return client;
}

function configureFuturesMarket(
	stub: StubExchange,
	options: {
		contractSize?: number | null;
		linear?: boolean;
		inverse?: boolean;
		minContracts?: number;
		maxContracts?: number;
	},
): void {
	const market = stub.markets["BTC/USDT:USDT"];
	if ("contractSize" in options) market.contractSize = options.contractSize ?? undefined;
	if (options.linear !== undefined) market.linear = options.linear;
	if (options.inverse !== undefined) market.inverse = options.inverse;
	if (options.minContracts !== undefined || options.maxContracts !== undefined) {
		market.limits.amount = {
			min: options.minContracts ?? market.limits.amount?.min,
			max: options.maxContracts,
		};
	}
}

describe("Binance account exposure inspection", () => {
	it("finds a matching futures position from a spot client", async () => {
		const stub = new StubExchange();
		stub.balances = { USDT: 1_000 };
		stub.futuresPositions = [
			{ symbol: "BTC/USDT:USDT", contracts: 1, info: { positionAmt: "1" } },
			{ symbol: "BTC/USDT:USDC", contracts: 2, info: { positionAmt: "2" } },
		];

		const client = newClient("binance", stub, "spot");

		expect(await client.hasAnyAccountExposure()).toBe(true);
		expect(stub.openCalls).toContainEqual({ symbol: undefined, params: { type: "swap" } });
		expect(stub.positionCalls).toContainEqual({ type: "swap" });
	});

	it("finds spot holdings from a futures client", async () => {
		const stub = new StubExchange();
		stub.balances = { BTC: 1, USDT: 1_000 };
		const client = newClient("binance", stub, "usdm-futures");

		expect(await client.hasAnyAccountExposure()).toBe(true);
		expect(stub.balanceCalls).toContainEqual({ type: "spot" });
	});

	it("returns false for a futures client with only the spot quote balance", async () => {
		const stub = new StubExchange();
		stub.balances = { USDT: 1_000 };
		const client = newClient("binance", stub, "usdm-futures");

		expect(await client.hasAnyAccountExposure()).toBe(false);
	});

	it("allows an empty opposite wallet and filters non-USDT futures", async () => {
		const stub = new StubExchange();
		stub.balances = { USDT: 1_000 };
		stub.futuresPositions = [{ symbol: "BTC/USDT:USDC", contracts: 2, info: { positionAmt: "2" } }];
		const client = newClient("binance", stub, "spot");

		expect(await client.hasAnyAccountExposure()).toBe(false);
	});

	it("fails closed when the opposite futures wallet cannot be inspected", async () => {
		const stub = new StubExchange();
		stub.balances = { USDT: 1_000 };
		stub.positionsError = new Error("futures permission denied");
		const client = newClient("binance", stub, "spot");

		expect(await client.hasAnyAccountExposure()).toBe(true);
	});

	it("fails closed for non-Binance account families that cannot be probed together", async () => {
		const stub = new StubExchange();
		stub.balances = { USDT: 1_000 };
		const client = newClient("okx", stub, "spot");

		expect(await client.hasAnyAccountExposure()).toBe(true);
	});
});

describe("Binance Spot submission reconciliation", () => {
	it("rejects oversized client-ID OCO lists before starting unbounded leg queries", async () => {
		const stub = new StubExchange();
		stub.orderListQueryResponse = {
			orderListId: 42,
			listClientOrderId: "bounded-list",
			listOrderStatus: "EXECUTING",
			orders: Array.from({ length: 3 }, (_, id) => ({ orderId: id, symbol: "BTCUSDT" })),
		};
		await expect(newClient("binance", stub).getOrderListByClientId("bounded-list")).rejects.toThrow(/exactly two/);
		expect(stub.orderFetchCalls).toEqual([]);
	});

	it("does not overwrite conflicting accepted client identity and cannot release it on a lookup miss", async () => {
		const stub = new StubExchange();
		stub.createOrderOverrides = { info: { clientOrderId: "other-client" } };
		stub.orderQueryError = new Error("not found");
		await expect(
			newClient("binance", stub).placeOrder({
				symbol: "BTC/USDT",
				side: "buy",
				type: "market",
				amount: 1,
				clientOrderId: "expected-client",
			}),
		).rejects.toThrow(/SUBMISSION_STATUS_UNKNOWN/);
		expect(stub.createOrderCalls).toHaveLength(1);
		expect(stub.getOrderRawCalls).toEqual([{ symbol: "BTCUSDT", origClientOrderId: "expected-client" }]);
	});

	it.each(["list", "leg", "symbol", "side", "amount"] as const)(
		"keeps malformed accepted OCO %s evidence unknown",
		async (field) => {
			const stub = new StubExchange();
			const submit = stub.privatePostOrderListOco;
			stub.privatePostOrderListOco = async (params) => {
				const response = await submit(params);
				const reports = response.orderReports as Array<Record<string, unknown>>;
				if (field === "list") response.listClientOrderId = "other-list";
				if (field === "leg") reports[0].clientOrderId = reports[1].clientOrderId;
				if (field === "symbol") reports[0].symbol = "ETHUSDT";
				if (field === "side") reports[0].side = "BUY";
				if (field === "amount") reports[0].origQty = "2";
				return response;
			};
			stub.orderListQueryError = new Error("not found");
			await expect(
				newClient("binance", stub).placeOcoOrder({
					symbol: "BTC/USDT",
					side: "sell",
					amount: 1,
					stopLossPrice: 90,
					takeProfitPrice: 120,
					listClientOrderId: "expected-list",
					aboveClientOrderId: "expected-above",
					belowClientOrderId: "expected-below",
				}),
			).rejects.toThrow(/SUBMISSION_STATUS_UNKNOWN/);
			expect(stub.rawCalls).toHaveLength(1);
		},
	);

	it("reconciles a normal order timeout by client id", async () => {
		const stub = new StubExchange();
		stub.createOrderError = new Error("request timeout");
		stub.orderQueryResponse = rawOrder("recovered", "FILLED", { info: { clientOrderId: "stable-id" } });
		const client = newClient("binance", stub);
		const result = await client.placeOrder({
			symbol: "BTC/USDT",
			side: "buy",
			type: "market",
			amount: 1,
			clientOrderId: "stable-id",
		});
		expect(result.order.id).toBe("recovered");
		expect(stub.createOrderCalls).toHaveLength(1);
		expect(stub.getOrderRawCalls).toEqual([{ symbol: "BTCUSDT", origClientOrderId: "stable-id" }]);
	});

	it("does not query after an explicit rejection", async () => {
		const stub = new StubExchange();
		stub.createOrderError = new Error("HTTP 400 insufficient balance");
		const client = newClient("binance", stub);
		await expect(client.placeOrder({ symbol: "BTC/USDT", side: "buy", type: "market", amount: 1 })).rejects.toThrow(
			"HTTP 400",
		);
		expect(stub.getOrderRawCalls).toHaveLength(0);
	});

	it("normalizes typed authentication rejections without querying", async () => {
		const authStub = new StubExchange();
		authStub.createOrderError = new ccxt.AuthenticationError("invalid API-key, IP, or permissions");
		await expect(
			newClient("binance", authStub).placeOrder({ symbol: "BTC/USDT", side: "buy", type: "market", amount: 1 }),
		).rejects.toThrow(/errorCategory=AUTHENTICATION/);
		expect(authStub.getOrderRawCalls).toHaveLength(0);
	});

	it("reconciles transport-class failures by client id instead of releasing them as rejections", async () => {
		const cases: Error[] = [
			new Error("socket hang up"),
			Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
			new ccxt.BadResponse("binance GET https://api.binance.com/api/v3/order 200 <html>"),
			new ccxt.DDoSProtection("binance 418"),
			new ccxt.RateLimitExceeded("Too many requests; -1003"),
		];
		for (const createOrderError of cases) {
			const stub = new StubExchange();
			stub.createOrderError = createOrderError;
			stub.orderQueryError = new Error("HTTP 404 order not found");
			await expect(
				newClient("binance", stub).placeOrder({
					symbol: "BTC/USDT",
					side: "buy",
					type: "market",
					amount: 1,
					clientOrderId: "cid",
				}),
			).rejects.toThrow(/SUBMISSION_STATUS_UNKNOWN/);
			expect(stub.getOrderRawCalls).toEqual([{ symbol: "BTCUSDT", origClientOrderId: "cid" }]);
		}
	});

	it("normalizes Binance numeric order rejection codes", async () => {
		const fundsStub = new StubExchange();
		fundsStub.ocoError = Object.assign(new Error("Account has insufficient balance"), { code: -2010 });
		await expect(
			newClient("binance", fundsStub).placeOcoOrder({
				symbol: "BTC/USDT",
				side: "sell",
				amount: 1,
				stopLossPrice: 90,
				takeProfitPrice: 120,
			}),
		).rejects.toThrow(/errorCategory=INSUFFICIENT_FUNDS.*code=-2010/);
		expect(fundsStub.getOrderListRawCalls).toHaveLength(0);

		const invalidStub = new StubExchange();
		invalidStub.ocoError = Object.assign(new Error("Filter failure: PRICE_FILTER"), { code: -1013 });
		await expect(
			newClient("binance", invalidStub).placeOcoOrder({
				symbol: "BTC/USDT",
				side: "sell",
				amount: 1,
				stopLossPrice: 90,
				takeProfitPrice: 120,
			}),
		).rejects.toThrow(/errorCategory=INVALID_ORDER.*code=-1013/);
	});

	it("reports unknown status after a timeout miss without reposting", async () => {
		const stub = new StubExchange();
		stub.createOrderError = new Error("request timeout");
		stub.orderQueryError = new Error("HTTP 404 order not found");
		const client = newClient("binance", stub);
		await expect(
			client.placeOrder({ symbol: "BTC/USDT", side: "buy", type: "market", amount: 1, clientOrderId: "missing" }),
		).rejects.toThrow(/SUBMISSION_STATUS_UNKNOWN/);
		expect(stub.createOrderCalls).toHaveLength(1);
		expect(stub.getOrderRawCalls).toHaveLength(1);
	});

	it("reconciles a trailing order timeout without a second POST", async () => {
		const stub = new StubExchange();
		stub.trailingError = new Error("network timeout");
		stub.orderQueryResponse = rawOrder("trailing-recovered", "NEW", {
			info: { clientOrderId: "trail-id", type: "STOP_LOSS" },
		});
		const client = newClient("binance", stub);
		const result = await client.placeOrder({
			symbol: "BTC/USDT",
			side: "sell",
			type: "trailing_stop_market",
			amount: 1,
			trailingPercent: 2,
			clientOrderId: "trail-id",
		});
		expect(result.order.id).toBe("trailing-recovered");
		expect(stub.rawCalls).toHaveLength(1);
		expect(stub.getOrderRawCalls).toEqual([{ symbol: "BTCUSDT", origClientOrderId: "trail-id" }]);
	});

	it("reports unknown OCO status after a timeout miss", async () => {
		const stub = new StubExchange();
		stub.ocoError = new Error("request timeout");
		stub.orderListQueryError = new Error("HTTP 404 list not found");
		const client = newClient("binance", stub);
		await expect(
			client.placeOcoOrder({
				symbol: "BTC/USDT",
				side: "sell",
				amount: 1,
				stopLossPrice: 90,
				takeProfitPrice: 120,
				listClientOrderId: "missing-list",
			}),
		).rejects.toThrow(/SUBMISSION_STATUS_UNKNOWN/);
		expect(stub.rawCalls).toHaveLength(1);
		expect(stub.getOrderListRawCalls).toHaveLength(1);
	});

	it("does not treat an empty OCO list lookup as a recovered submission", async () => {
		const stub = new StubExchange();
		stub.ocoError = new Error("request timeout");
		stub.orderListQueryResponse = {
			orderListId: 42,
			listClientOrderId: "empty-list",
			listOrderStatus: "EXEC_STARTED",
			orderReports: [],
		};
		const client = newClient("binance", stub);

		await expect(
			client.placeOcoOrder({
				symbol: "BTC/USDT",
				side: "sell",
				amount: 1,
				stopLossPrice: 90,
				takeProfitPrice: 120,
				listClientOrderId: "empty-list",
			}),
		).rejects.toThrow(/SUBMISSION_STATUS_UNKNOWN.*Correlated OCO lookup requires exactly two order legs/);
		expect(stub.rawCalls).toHaveLength(1);
		expect(stub.getOrderListRawCalls).toHaveLength(1);
	});

	it("calls Spot order and order-list query/cancel endpoints with their parameters", async () => {
		const stub = new StubExchange();
		const client = newClient("binance", stub);
		await client.getOrder("order-1", "BTC/USDT");
		await client.getOrderList("42");
		await client.cancelOrderList("42", "BTC/USDT");
		expect(stub.getOrderRawCalls[0]).toEqual({ symbol: "BTCUSDT", orderId: "order-1" });
		expect(stub.getOrderListRawCalls).toEqual([{ orderListId: "42" }, { symbol: "BTCUSDT", orderListId: "42" }]);
	});

	it("normalizes cancellation and order-list not-found errors", async () => {
		const cancelStub = new StubExchange();
		cancelStub.cancelError = Object.assign(new Error("Unknown order sent."), { code: -2013 });
		await expect(newClient("binance", cancelStub).cancelOrder("missing", "BTC/USDT")).rejects.toThrow(
			/errorCategory=ORDER_NOT_FOUND.*code=-2013/,
		);
		const listStub = new StubExchange();
		listStub.orderListCancelError = Object.assign(new Error("Order list does not exist"), { code: -2013 });
		await expect(newClient("binance", listStub).cancelOrderList("missing", "BTC/USDT")).rejects.toThrow(
			/errorCategory=ORDER_NOT_FOUND.*code=-2013/,
		);
	});

	it("reconciles a native OCO timeout by list client id", async () => {
		const stub = new StubExchange();
		stub.ocoError = new Error("request timeout");
		stub.orderListQueryResponse = {
			orderListId: 42,
			listClientOrderId: "list-id",
			listOrderStatus: "EXEC_STARTED",
			orderReports: [
				{ symbol: "BTCUSDT", orderId: 10 },
				{ symbol: "BTCUSDT", orderId: 11 },
			],
		};
		stub.privateGetOrder = async (params) =>
			rawOrder(String(params.orderId), "NEW", {
				side: "sell",
				info: { clientOrderId: params.orderId === "10" ? "above-id" : "below-id" },
			});
		const client = newClient("binance", stub);
		const result = await client.placeOcoOrder({
			symbol: "BTC/USDT",
			side: "sell",
			amount: 1,
			stopLossPrice: 90,
			takeProfitPrice: 120,
			listClientOrderId: "list-id",
			aboveClientOrderId: "above-id",
			belowClientOrderId: "below-id",
		});
		expect(result.orders).toHaveLength(2);
		expect(stub.rawCalls).toHaveLength(1);
		expect(stub.getOrderListRawCalls[0]).toEqual({ origClientOrderId: "list-id" });
	});
});

describe("Binance Spot deterministic filter validation", () => {
	it.each([
		["below minimum", 0.0001],
		["above maximum", 101],
		["off step", 1.0005],
	])("rejects amount %s before submission", async (_name, amount) => {
		const stub = new StubExchange();
		const client = newClient("binance", stub);
		await expect(client.placeOrder({ symbol: "BTC/USDT", side: "buy", type: "market", amount })).rejects.toThrow(
			/Amount/,
		);
		expect(stub.createOrderCalls).toHaveLength(0);
	});

	it("uses MARKET_LOT_SIZE only for ordinary market orders", async () => {
		const stub = new StubExchange();
		const client = newClient("binance", stub);
		await expect(
			client.placeOrder({ symbol: "BTC/USDT", side: "buy", type: "market", amount: 1.001 }),
		).rejects.toThrow(/step|grid/);
		await client.placeOrder({
			symbol: "BTC/USDT",
			side: "sell",
			type: "trailing_stop_market",
			amount: 1.001,
			trailingPercent: 2,
		});
		expect(stub.rawCalls).toHaveLength(1);
	});

	it("rejects an off-grid limit price before submission", async () => {
		const stub = new StubExchange();
		const client = newClient("binance", stub);
		await expect(
			client.placeOrder({ symbol: "BTC/USDT", side: "buy", type: "limit", amount: 1, price: 100.001 }),
		).rejects.toThrow(/not.*grid/);
		expect(stub.createOrderCalls).toHaveLength(0);
	});

	it("rejects an off-grid OCO leg before submission", async () => {
		const stub = new StubExchange();
		const client = newClient("binance", stub);
		await expect(
			client.placeOcoOrder({
				symbol: "BTC/USDT",
				side: "sell",
				amount: 1,
				stopLossPrice: 90.001,
				takeProfitPrice: 120,
			}),
		).rejects.toThrow(/not.*grid/);
		expect(stub.rawCalls).toHaveLength(0);
	});
});

describe("Binance Spot conditional orders", () => {
	it("sends trailingDelta in BIPS and uses the order-type filter range", async () => {
		const stub = new StubExchange();
		const client = newClient("binance", stub);
		await client.placeOrder({
			symbol: "BTC/USDT",
			side: "sell",
			type: "trailing_stop_market",
			amount: 1,
			trailingPercent: 2,
			stopPrice: 110,
		});
		expect(stub.rawCalls[0]).toMatchObject({ type: "TAKE_PROFIT", trailingDelta: "200", stopPrice: "110" });
	});

	it("uses take-profit activation below market for buy trailing orders", async () => {
		const stub = new StubExchange();
		const client = newClient("binance", stub);
		await client.placeOrder({
			symbol: "BTC/USDT",
			side: "buy",
			type: "trailing_stop_market",
			amount: 1,
			trailingPercent: 2,
			stopPrice: 90,
		});
		expect(stub.rawCalls[0]).toMatchObject({ type: "TAKE_PROFIT", trailingDelta: "200", stopPrice: "90" });
	});

	it("rejects fractional trailing BIPS instead of rounding", async () => {
		const stub = new StubExchange();
		const client = newClient("binance", stub);
		await expect(
			client.placeOrder({
				symbol: "BTC/USDT",
				side: "sell",
				type: "trailing_stop_market",
				amount: 1,
				trailingPercent: 0.015,
			}),
		).rejects.toThrow(/whole number of BIPS/);
		expect(stub.rawCalls).toHaveLength(0);
	});

	it.each([
		["buy", 0.5, 90],
		["sell", 20, 110],
	] as const)("accepts the %s take-profit trailing range", async (side, trailingPercent, stopPrice) => {
		const stub = new StubExchange();
		const client = newClient("binance", stub);
		await client.placeOrder({
			symbol: "BTC/USDT",
			side,
			type: "trailing_stop_market",
			amount: 1,
			trailingPercent,
			stopPrice,
		});
		expect(stub.rawCalls[0]).toMatchObject({
			type: "TAKE_PROFIT",
			side: side.toUpperCase(),
			trailingDelta: String(trailingPercent * 100),
		});
	});

	it.each([
		["buy", 20, "below range 10-1000"],
		["sell", 0.5, "above range 100-5000"],
	] as const)("rejects deltas outside the %s take-profit trailing range", async (side, trailingPercent, error) => {
		const stub = new StubExchange();
		const client = newClient("binance", stub);
		await expect(
			client.placeOrder({
				symbol: "BTC/USDT",
				side,
				type: "trailing_stop_market",
				amount: 1,
				trailingPercent,
			}),
		).rejects.toThrow(error);
		expect(stub.rawCalls).toHaveLength(0);
	});

	it("maps native OCO order reports and orderListId", async () => {
		const stub = new StubExchange();
		const client = newClient("binance", stub);
		const result = await client.placeOcoOrder({
			symbol: "BTC/USDT",
			side: "sell",
			amount: 1,
			stopLossPrice: 90,
			takeProfitPrice: 120,
		});
		expect(stub.rawCalls[0]).toMatchObject({ aboveType: "LIMIT_MAKER", belowType: "STOP_LOSS_LIMIT" });
		expect(result.orders).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "10", type: "limit", ocoGroup: "42" }),
				expect.objectContaining({ id: "11", type: "stop", stopPrice: 90, ocoGroup: "42" }),
			]),
		);
	});

	it("rejects an empty native OCO response", async () => {
		const stub = new StubExchange();
		stub.ocoResponse = { orderListId: 42, orderReports: [] };
		const client = newClient("binance", stub);
		await expect(
			client.placeOcoOrder({ symbol: "BTC/USDT", side: "sell", amount: 1, stopLossPrice: 90, takeProfitPrice: 120 }),
		).rejects.toThrow(/exactly two orderReports/);
	});

	it.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -1])("rejects a non-positive OCO amount (%s)", async (amount) => {
		const stub = new StubExchange();
		const client = newClient("binance", stub);

		await expect(
			client.placeOcoOrder({ symbol: "BTC/USDT", side: "sell", amount, stopLossPrice: 90, takeProfitPrice: 120 }),
		).rejects.toThrow(/amount must be positive/);
		expect(stub.rawCalls).toHaveLength(0);
	});
});

describe("ccxt constructor options", () => {
	it("rejects the paper-only both market type", () => {
		expect(() => new CcxtExchangeClient("binance", "USDT", { apiKey: "test", secret: "test" }, "both")).toThrow(
			/does not support marketType "both"/,
		);
	});

	it("enables Binance server-time adjustment with an explicit receive window", () => {
		const client = new CcxtExchangeClient("binance", "USDT", { apiKey: "test", secret: "test" });
		const exchange = (client as unknown as { exchange: { options: Record<string, unknown> } }).exchange;

		expect(exchange.options).toMatchObject({
			adjustForTimeDifference: true,
			recvWindow: 10_000,
			warnOnFetchOpenOrdersWithoutSymbol: false,
		});
	});

	it("does not add Binance time options to other exchanges", () => {
		const client = new CcxtExchangeClient("okx", "USDT", { apiKey: "test", secret: "test" });
		const exchange = (client as unknown as { exchange: { options: Record<string, unknown> } }).exchange;

		expect(exchange.options).toMatchObject({ warnOnFetchOpenOrdersWithoutSymbol: false });
		expect(exchange.options.adjustForTimeDifference).toBe(false);
		expect(exchange.options.recvWindow).toBeUndefined();
	});
});

describe("live order input validation", () => {
	it("rejects invalid side and order type before loading markets", async () => {
		const stub = new StubExchange();
		const client = newClient("binance", stub);

		await expect(
			client.placeOrder({
				symbol: "BTC/USDT",
				side: "hold" as "buy",
				type: "market",
				amount: 1,
			}),
		).rejects.toThrow("Order side must be buy or sell");
		await expect(
			client.placeOrder({
				symbol: "BTC/USDT",
				side: "buy",
				type: "unknown" as "market",
				amount: 1,
			}),
		).rejects.toThrow("Unsupported order type: unknown");
		expect(stub.events).not.toContain("loadMarkets");
	});

	it.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -1])(
		"rejects an invalid amount before loading markets (%s)",
		async (amount) => {
			const stub = new StubExchange();
			const client = newClient("binance", stub);

			await expect(client.placeOrder({ symbol: "BTC/USDT", side: "buy", type: "market", amount })).rejects.toThrow(
				/Amount must be finite and positive/,
			);
			expect(stub.events).not.toContain("loadMarkets");
		},
	);

	it.each([
		["limit price", { type: "limit" as const, amount: 1, price: Number.NaN }],
		["trigger price", { type: "stop_market" as const, amount: 1, stopPrice: Number.POSITIVE_INFINITY }],
	])("rejects a non-finite %s before loading markets", async (_label, input) => {
		const stub = new StubExchange();
		const client = newClient("binance", stub);

		await expect(client.placeOrder({ symbol: "BTC/USDT", side: "buy", ...input })).rejects.toThrow(/finite positive/);
		expect(stub.events).not.toContain("loadMarkets");
	});

	it("rejects malformed OCO input before loading markets", async () => {
		const stub = new StubExchange();
		const client = newClient("binance", stub);

		await expect(
			client.placeOcoOrder({
				symbol: "BTC/USDT",
				side: "buy",
				amount: Number.NaN,
				stopLossPrice: 90,
				takeProfitPrice: 110,
			}),
		).rejects.toThrow("amount must be positive");
		expect(stub.events).not.toContain("loadMarkets");
	});
});

describe("live Spot cost basis", () => {
	it("keeps negative and used balances visible for debt and locked funds", async () => {
		const stub = new StubExchange();
		stub.balances = { USDT: -25, BTC: 0 };
		stub.freeBalances = { USDT: -30, BTC: 0 };
		stub.usedBalances = { USDT: 5, BTC: 0 };

		await expect(newClient("binance", stub).getBalances()).resolves.toEqual([
			expect.objectContaining({ asset: "USDT", free: -30, used: 5, total: -25, quoteValue: -25 }),
		]);
	});

	it("derives total from free and used when an adapter omits total balances", async () => {
		const stub = new StubExchange();
		stub.balances = {};
		stub.freeBalances = { BTC: 1, USDT: 1_000 };
		stub.usedBalances = { BTC: 0, USDT: 0 };

		await expect(newClient("binance", stub).getPositions()).resolves.toEqual([
			expect.objectContaining({ symbol: "BTC/USDT", asset: "BTC", amount: 1, quoteValue: 100 }),
		]);
	});

	it("keeps a non-dust position when its quote valuation is unavailable", async () => {
		const stub = new StubExchange();
		stub.balances = { BTC: 1, USDT: 1000 };
		stub.last = undefined;

		const positions = await newClient("binance", stub).getPositions();

		expect(positions).toEqual([
			expect.objectContaining({
				symbol: "BTC/USDT",
				asset: "BTC",
				amount: 1,
				quoteValue: undefined,
				costBasisStatus: "partial",
				valuationStatus: "unavailable",
				valuationReason: "Quote valuation for BTC/USDT is unavailable",
			}),
		]);
	});

	it("reconstructs a quote-fee buy and current unrealized PnL", async () => {
		const stub = new StubExchange();
		stub.balances = { BTC: 1, USDT: 1000 };
		stub.trades = [
			{
				id: "buy-1",
				side: "buy",
				amount: 1,
				price: 100,
				cost: 100,
				timestamp: 1,
				fee: { cost: 1, currency: "USDT" },
			},
		];
		const position = (await newClient("binance", stub).getPositions())[0];
		expect(position).toMatchObject({ amount: 1, avgEntryPrice: 101, costBasisStatus: "complete", unrealizedPnl: -1 });
	});

	it("keeps weighted average cost through multiple buys and a partial sell", async () => {
		const stub = new StubExchange();
		stub.balances = { BTC: 1.5, USDT: 1000 };
		stub.trades = [
			{
				id: "buy-1",
				side: "buy",
				amount: 1,
				price: 100,
				cost: 100,
				timestamp: 1,
				fee: { cost: 0, currency: "USDT" },
			},
			{
				id: "buy-2",
				side: "buy",
				amount: 1,
				price: 200,
				cost: 200,
				timestamp: 2,
				fee: { cost: 0, currency: "USDT" },
			},
			{
				id: "sell-1",
				side: "sell",
				amount: 0.5,
				price: 250,
				cost: 125,
				timestamp: 3,
				fee: { cost: 0, currency: "USDT" },
			},
		];
		const position = (await newClient("binance", stub).getPositions())[0];
		expect(position).toMatchObject({ amount: 1.5, avgEntryPrice: 150, costBasisStatus: "complete" });
	});

	it("marks missing history as partial without inventing an entry price", async () => {
		const stub = new StubExchange();
		stub.balances = { BTC: 1, USDT: 1000 };
		stub.trades = [
			{
				id: "buy-1",
				side: "buy",
				amount: 1,
				price: 100,
				cost: 100,
				timestamp: 1,
				fee: { cost: 1, currency: "BNB" },
			},
		];
		const position = (await newClient("binance", stub).getPositions())[0];
		expect(position.costBasisStatus).toBe("partial");
		expect(position.avgEntryPrice).toBeUndefined();
	});

	it("reports unavailable when trade history is unsupported", async () => {
		const stub = new StubExchange();
		stub.has.fetchMyTrades = false;
		const position = (await newClient("binance", stub).getPositions())[0];
		expect(position).toMatchObject({ costBasisStatus: "unavailable" });
		expect(position.avgEntryPrice).toBeUndefined();
	});

	it("marks cost basis partial when trade notional accumulation overflows", async () => {
		const stub = new StubExchange();
		stub.balances = { BTC: 1, USDT: 1000 };
		stub.trades = [
			{
				id: "buy-1",
				side: "buy",
				amount: 0.5,
				price: 1,
				cost: Number.MAX_VALUE,
				timestamp: 1,
				fee: { cost: 0, currency: "USDT" },
			},
			{
				id: "buy-2",
				side: "buy",
				amount: 0.5,
				price: 1,
				cost: Number.MAX_VALUE,
				timestamp: 2,
				fee: { cost: 0, currency: "USDT" },
			},
		];

		const position = (await newClient("binance", stub).getPositions())[0];

		expect(position).toMatchObject({ costBasisStatus: "partial" });
		expect(position.avgEntryPrice).toBeUndefined();
	});

	it("marks cost basis partial when unrealized PnL arithmetic overflows", async () => {
		const balance = 1e300;
		const stub = new StubExchange();
		stub.balances = { BTC: balance, USDT: 1000 };
		stub.last = 1e300;
		stub.trades = [
			{
				id: "buy-huge",
				side: "buy",
				amount: balance,
				price: 1e-300,
				cost: 1,
				timestamp: 1,
				fee: { cost: 0, currency: "USDT" },
			},
		];

		const position = (await newClient("binance", stub).getPositions())[0];

		expect(position).toMatchObject({ costBasisStatus: "partial" });
		expect(position.avgEntryPrice).toBeUndefined();
	});
});

describe("ccxt market data", () => {
	it("leaves candle completion unknown for unsupported timeframes", async () => {
		const stub = new StubExchange();
		stub.ohlcv = [[1, 90, 105, 85, 100, 10]];
		const client = newClient("okx", stub);

		const candles = await client.getKlines("BTC/USDT", "custom", 1);

		expect(candles[0]?.closed).toBeUndefined();
	});

	it("does not fabricate a zero current funding rate when the exchange omits it", async () => {
		const stub = new StubExchange();
		stub.fundingRate = { fundingRate: undefined, nextFundingTimestamp: 123, info: {} };

		const funding = await newClient("binance", stub, "usdm-futures").getFundingRate("BTC/USDT:USDT");

		expect(funding).toMatchObject({ symbol: "BTC/USDT:USDT", nextFundingTime: 123 });
		expect(funding.rate).toBeUndefined();
	});

	it("does not fabricate zero historical funding rates when records are incomplete", async () => {
		const stub = new StubExchange();
		stub.fundingHistory = [
			{ fundingRate: undefined, timestamp: 1, info: {} },
			{ fundingRate: Number.NaN, timestamp: 2, info: {} },
		];

		const history = await newClient("binance", stub, "usdm-futures").getFundingRateHistory("BTC/USDT:USDT");

		expect(history).toHaveLength(2);
		expect(history.map((record) => record.rate)).toEqual([undefined, undefined]);
	});

	it("falls back to finite raw funding-rate fields", async () => {
		const stub = new StubExchange();
		stub.fundingRate = {
			fundingRate: Number.NaN,
			nextFundingTimestamp: 123,
			info: { fundingRate: Number.NaN, lastFundingRate: "0.001" },
		};
		stub.fundingHistory = [
			{ fundingRate: Number.NaN, timestamp: 1, info: { fundingRate: Number.NaN, lastFundingRate: "0.002" } },
		];
		const client = newClient("binance", stub, "usdm-futures");

		expect((await client.getFundingRate("BTC/USDT:USDT")).rate).toBe(0.001);
		expect((await client.getFundingRateHistory("BTC/USDT:USDT"))[0]?.rate).toBe(0.002);
	});

	it("keeps open-interest amount and quote value as separate finite fields", async () => {
		const stub = new StubExchange();
		stub.openInterest = { openInterestAmount: 10, openInterestValue: 1_000 };

		const stats = await newClient("binance", stub, "usdm-futures").getContractStats("BTC/USDT:USDT");

		expect(stats).toMatchObject({ openInterest: 10, openInterestValue: 1_000 });
	});

	it("omits non-finite open-interest fields without moving value into amount", async () => {
		const stub = new StubExchange();
		stub.openInterest = { openInterestAmount: Number.NaN, openInterestValue: Number.POSITIVE_INFINITY };

		const stats = await newClient("binance", stub, "usdm-futures").getContractStats("BTC/USDT:USDT");

		expect(stats.openInterest).toBeUndefined();
		expect(stats.openInterestValue).toBeUndefined();
	});

	it("does not reinterpret quote-valued open interest as an amount", async () => {
		const stub = new StubExchange();
		stub.openInterest = { openInterestAmount: undefined, openInterestValue: 1_000 };

		const stats = await newClient("binance", stub, "usdm-futures").getContractStats("BTC/USDT:USDT");

		expect(stats.openInterest).toBeUndefined();
		expect(stats.openInterestValue).toBe(1_000);
	});
});

describe("ccxt order mapping", () => {
	it.each([
		["STOP_LOSS", "stop_market"],
		["STOP_LOSS_LIMIT", "stop"],
	])("normalizes Binance Spot %s and original quantity", async (rawType, expectedType) => {
		const stub = new StubExchange();
		stub.openBase = [
			rawOrder("spot-stop", "NEW", {
				side: "sell",
				amount: 0,
				info: { type: rawType, origQty: "0.5", stopPrice: "90" },
			}),
		];
		const orders = await newClient("binance", stub).getOpenOrders("BTC/USDT");
		expect(orders[0]).toMatchObject({ type: expectedType, amount: 0.5, side: "sell", symbol: "BTC/USDT" });
	});

	it("preserves Binance trigger semantics when ccxt reports the execution type", async () => {
		const stub = new StubExchange();
		stub.openBase = [
			rawOrder("protective-stop", "NEW", {
				type: "market",
				info: { type: "STOP_MARKET", reduceOnly: true, positionSide: "LONG" },
			}),
		];
		const client = newClient("binance", stub, "usdm-futures");

		const orders = await client.getOpenOrders("BTC/USDT:USDT");

		expect(orders).toEqual([
			expect.objectContaining({
				id: "protective-stop",
				type: "stop_market",
				reduceOnly: true,
				positionSide: "LONG",
			}),
		]);
	});

	it("preserves rejected, expired, and unknown terminal states", async () => {
		const stub = new StubExchange();
		stub.closedBase = [
			rawOrder("rejected", "REJECTED"),
			rawOrder("expired", "EXPIRED_IN_MATCH"),
			rawOrder("unknown", "PENDING_CANCEL"),
		];
		const client = newClient("okx", stub);

		const history = await client.getOrderHistory("BTC/USDT");

		expect(Object.fromEntries(history.map((order) => [order.id, order.status]))).toEqual({
			rejected: "rejected",
			expired: "expired",
			unknown: "unknown",
		});
	});

	it("preserves OKX ordType=oco and requests effective OCO history", async () => {
		const stub = new StubExchange();
		stub.openOco = [
			rawOrder("oco-open", "open", { type: undefined, info: { ordType: "oco", algoId: "group-open" } }),
		];
		stub.closedOco = [
			rawOrder("oco-closed", "closed", { type: undefined, info: { ordType: "oco", algoId: "group-closed" } }),
		];
		stub.canceledOco = [
			rawOrder("oco-canceled", "canceled", {
				type: undefined,
				info: { ordType: "oco", algoId: "group-canceled" },
			}),
		];
		const client = newClient("okx", stub);

		const open = await client.getOpenOrders("BTC/USDT");
		const history = await client.getOrderHistory("BTC/USDT");

		expect(open).toEqual([expect.objectContaining({ id: "oco-open", type: "oco", ocoGroup: "group-open" })]);
		expect(history).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "oco-closed", type: "oco", ocoGroup: "group-closed" }),
				expect.objectContaining({
					id: "oco-canceled",
					type: "oco",
					status: "canceled",
					ocoGroup: "group-canceled",
				}),
			]),
		);
		expect(stub.openCalls).toContainEqual({ symbol: "BTC/USDT", params: { ordType: "oco" } });
		expect(stub.closedCalls).toContainEqual({
			symbol: "BTC/USDT",
			params: { ordType: "oco", trigger: true },
		});
		expect(stub.canceledCalls).toEqual(
			expect.arrayContaining([
				{ symbol: "BTC/USDT", params: {} },
				{ symbol: "BTC/USDT", params: { ordType: "trigger", trigger: true } },
				{ symbol: "BTC/USDT", params: { trailing: true } },
				{ symbol: "BTC/USDT", params: { ordType: "oco", trigger: true } },
			]),
		);
	});

	it("queries and cancels OKX conditional algo orders with ordType=conditional", async () => {
		const stub = new StubExchange();
		stub.openConditional = [
			rawOrder("conditional-open", "open", {
				type: "stop_market",
				info: { ordType: "conditional", algoId: "algo-conditional" },
			}),
		];
		stub.closedConditional = [
			rawOrder("conditional-closed", "closed", {
				type: "take_profit_market",
				info: { ordType: "conditional" },
			}),
		];
		stub.canceledConditional = [
			rawOrder("conditional-canceled", "canceled", {
				type: "stop_market",
				info: { ordType: "conditional" },
			}),
		];
		const client = newClient("okx", stub);

		const open = await client.getOpenOrders("BTC/USDT");
		const history = await client.getOrderHistory("BTC/USDT");
		await client.cancelOrder("conditional-open", "BTC/USDT");

		expect(open).toContainEqual(expect.objectContaining({ id: "conditional-open", type: "stop_market" }));
		expect(open[0]?.ocoGroup).toBeUndefined();
		expect(open[0]?.orderListId).toBeUndefined();
		expect(history).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "conditional-closed", type: "take_profit_market", status: "closed" }),
				expect.objectContaining({ id: "conditional-canceled", type: "stop_market", status: "canceled" }),
			]),
		);
		expect(stub.openCalls).toContainEqual({ symbol: "BTC/USDT", params: { ordType: "conditional" } });
		expect(stub.closedCalls).toContainEqual({
			symbol: "BTC/USDT",
			params: { ordType: "conditional", trigger: true },
		});
		expect(stub.canceledCalls).toContainEqual({
			symbol: "BTC/USDT",
			params: { ordType: "conditional", trigger: true },
		});
		expect(stub.cancelOrderCalls).toEqual([
			{ id: "conditional-open", symbol: "BTC/USDT", params: {} },
			{ id: "conditional-open", symbol: "BTC/USDT", params: { ordType: "conditional" } },
		]);
	});
});

describe("OKX adapter", () => {
	it("passes OCO as the ccxt order type so ccxt selects the algo endpoint", async () => {
		const stub = new StubExchange();
		const client = newClient("okx", stub);

		const result = await client.placeOcoOrder({
			symbol: "BTC/USDT",
			side: "sell",
			amount: 1,
			stopLossPrice: 90,
			takeProfitPrice: 120,
		});

		expect(stub.createOrderCalls).toEqual([
			expect.objectContaining({
				type: "oco",
				params: expect.objectContaining({ stopLossPrice: 90, takeProfitPrice: 120 }),
			}),
		]);
		expect(result.orders[0]).toMatchObject({ type: "oco", status: "open" });
	});

	it("reconciles an OCO timeout through the exchange client-id lookup", async () => {
		const stub = new StubExchange();
		stub.has.fetchOrderWithClientOrderId = true;
		stub.createOrderError = new Error("request timeout");
		stub.clientOrderIdResponse = rawOrder("oco-recovered", "open", {
			info: { clientOrderId: "oco-list-id", ordType: "oco", algoId: "oco-group" },
		});
		const client = newClient("okx", stub);

		const result = await client.placeOcoOrder({
			symbol: "BTC/USDT",
			side: "sell",
			amount: 1,
			stopLossPrice: 90,
			takeProfitPrice: 120,
			listClientOrderId: "oco-list-id",
		});

		expect(result.orders[0]).toMatchObject({ id: "oco-recovered", type: "oco", clientOrderId: "oco-list-id" });
		expect(stub.createOrderCalls).toHaveLength(1);
		expect(stub.clientOrderIdCalls).toEqual([{ clientOrderId: "oco-list-id", symbol: "BTC/USDT", params: {} }]);
	});

	it("keeps an OCO timeout status unknown when client-id lookup is unavailable", async () => {
		const stub = new StubExchange();
		stub.createOrderError = new Error("request timeout");
		const client = newClient("okx", stub);

		await expect(
			client.placeOcoOrder({
				symbol: "BTC/USDT",
				side: "sell",
				amount: 1,
				stopLossPrice: 90,
				takeProfitPrice: 120,
				listClientOrderId: "oco-unavailable",
			}),
		).rejects.toThrow(
			/\[errorCategory=SUBMISSION_STATUS_UNKNOWN\].*exchange=okx.*symbol=BTC\/USDT.*listClientOrderId=oco-unavailable.*unsupported.*Do not retry/,
		);
		expect(stub.createOrderCalls).toHaveLength(1);
		expect(stub.clientOrderIdCalls).toHaveLength(0);
	});

	it("retains both submission and lookup failures for an OCO timeout", async () => {
		const stub = new StubExchange();
		stub.has.fetchOrderWithClientOrderId = true;
		stub.createOrderError = new Error("request timeout");
		stub.clientOrderIdError = new Error("lookup gateway unavailable");
		const client = newClient("okx", stub);

		await expect(
			client.placeOcoOrder({
				symbol: "BTC/USDT",
				side: "sell",
				amount: 1,
				stopLossPrice: 90,
				takeProfitPrice: 120,
				listClientOrderId: "oco-lookup-failed",
			}),
		).rejects.toThrow(
			/\[errorCategory=SUBMISSION_STATUS_UNKNOWN\].*request timeout.*lookup gateway unavailable.*Do not retry/,
		);
		expect(stub.createOrderCalls).toHaveLength(1);
		expect(stub.clientOrderIdCalls).toHaveLength(1);
	});
});

describe("Binance futures adapter", () => {
	const symbol = "BTC/USDT:USDT";

	it("converts base amounts to contracts on submission and back on the domain order", async () => {
		const stub = new StubExchange();
		configureFuturesMarket(stub, { contractSize: 10, minContracts: 1, maxContracts: 3 });
		const client = newClient("binance", stub, "usdm-futures");

		const result = await client.placeOrder({ symbol, side: "buy", type: "market", amount: 20 });

		expect(stub.createOrderCalls[0]).toMatchObject({ symbol, amount: 2, side: "buy" });
		expect(result.order).toMatchObject({ symbol, amount: 20, filled: 0, remaining: 20 });
	});

	it("maps fill cost from submission raw fields without a follow-up lookup", async () => {
		const stub = new StubExchange();
		configureFuturesMarket(stub, { contractSize: 10, minContracts: 1, maxContracts: 3 });
		stub.has.fetchOrder = true;
		stub.createOrderOverrides = {
			status: "closed",
			amount: 2,
			filled: 2,
			remaining: 0,
			cost: 0,
			info: { executedQty: "2", cumQuote: "1000", avgPrice: "50" },
		};
		const client = newClient("binance", stub, "usdm-futures");

		const result = await client.placeOrder({ symbol, side: "buy", type: "market", amount: 20 });

		expect(result.order).toMatchObject({ filled: 20, cost: 1000, average: 50, status: "closed" });
		expect(stub.orderFetchCalls).toHaveLength(0);
	});

	it("re-fetches a filled order when submission cost is still zero", async () => {
		const stub = new StubExchange();
		configureFuturesMarket(stub, { contractSize: 10, minContracts: 1, maxContracts: 3 });
		stub.has.fetchOrder = true;
		stub.createOrderOverrides = { status: "closed", amount: 2, filled: 2, remaining: 0, cost: 0 };
		stub.fetchOrderResponse = rawOrder("created-1", "closed", {
			symbol,
			amount: 2,
			filled: 2,
			remaining: 0,
			cost: 1000,
			average: 50,
		});
		const client = newClient("binance", stub, "usdm-futures");

		const result = await client.placeOrder({ symbol, side: "buy", type: "market", amount: 20 });

		expect(result.order).toMatchObject({ filled: 20, cost: 1000, average: 50, status: "closed" });
		expect(stub.orderFetchCalls).toEqual([{ id: "created-1", symbol, params: {} }]);
	});

	it("applies futures amount limits in contracts, not user-facing base units", async () => {
		const stub = new StubExchange();
		configureFuturesMarket(stub, { contractSize: 10, minContracts: 3, maxContracts: 4 });
		const client = newClient("binance", stub, "usdm-futures");

		await expect(client.placeOrder({ symbol, side: "buy", type: "market", amount: 20 })).rejects.toThrow(
			/Contract amount 2 is below minimum 3/,
		);
		await expect(client.placeOrder({ symbol, side: "buy", type: "market", amount: 50 })).rejects.toThrow(
			/Contract amount 5 exceeds maximum 4/,
		);
		expect(stub.createOrderCalls).toHaveLength(0);
	});

	it("rejects a base amount that exchange precision cannot represent as contracts", async () => {
		const stub = new StubExchange();
		stub.futuresAmountDigits = 0;
		configureFuturesMarket(stub, { contractSize: 10 });
		const client = newClient("binance", stub, "usdm-futures");

		await expect(client.placeOrder({ symbol, side: "buy", type: "market", amount: 25 })).rejects.toThrow(
			/cannot be represented exactly.*contractSize 10/,
		);
		expect(stub.createOrderCalls).toHaveLength(0);
	});

	it.each([
		["missing contractSize", { contractSize: null }],
		["inverse contract", { contractSize: 10, linear: false }],
	])(
		"rejects futures metadata that is unsafe for amount conversion (%s)",
		async (_name, options: { contractSize: number | null; linear?: boolean }) => {
			const stub = new StubExchange();
			configureFuturesMarket(stub, options);
			const client = newClient("binance", stub, "usdm-futures");

			await expect(client.placeOrder({ symbol, side: "buy", type: "market", amount: 20 })).rejects.toThrow(
				options.linear === false ? /Unsupported usdm-futures market/ : /contractSize is unavailable/,
			);
			expect(stub.createOrderCalls).toHaveLength(0);
		},
	);

	it("maps futures positions and order reports from contracts to base units", async () => {
		const stub = new StubExchange();
		configureFuturesMarket(stub, { contractSize: 10 });
		stub.futuresPositions = [
			{
				symbol,
				contracts: 2,
				side: "long",
				markPrice: 100,
				notional: 200,
				entryPrice: 90,
			},
			{
				symbol,
				contracts: undefined,
				side: undefined,
				markPrice: 100,
				info: { positionAmt: "-3", positionSide: "BOTH", notional: "-300" },
			},
		];
		stub.openBase = [
			rawOrder("futures-open", "NEW", {
				symbol,
				amount: 2,
				filled: 0.5,
				remaining: 1.5,
				info: { positionSide: "LONG" },
			}),
		];
		stub.allOrders = [
			rawOrder("futures-history", "FILLED", {
				symbol,
				amount: 3,
				filled: 3,
				remaining: 0,
				info: { positionSide: "SHORT" },
			}),
		];
		const client = newClient("binance", stub, "usdm-futures");

		const positions = await client.getPositions();
		expect(positions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ amount: 20, quoteValue: 200, positionSide: "LONG", valuationStatus: "complete" }),
				expect.objectContaining({
					amount: 30,
					quoteValue: 300,
					positionSide: "SHORT",
					valuationStatus: "complete",
				}),
			]),
		);
		const open = await client.getOpenOrders(symbol);
		expect(open[0]).toMatchObject({ amount: 20, filled: 5, remaining: 15, positionSide: "LONG" });
		const history = await client.getOrderHistory(symbol);
		expect(history[0]).toMatchObject({ amount: 30, filled: 30, remaining: 0, positionSide: "SHORT" });
	});

	it("does not use entry price as futures quote valuation when mark and notional are missing", async () => {
		const stub = new StubExchange();
		configureFuturesMarket(stub, { contractSize: 10 });
		stub.futuresPositions = [
			{
				symbol,
				contracts: 2,
				side: "long",
				markPrice: undefined,
				notional: undefined,
				entryPrice: 90,
				info: {},
			},
		];

		const positions = await newClient("binance", stub, "usdm-futures").getPositions();

		expect(positions).toHaveLength(1);
		expect(positions[0]).toMatchObject({
			symbol,
			amount: 20,
			valuationStatus: "unavailable",
			valuationReason: "Exchange notional and mark price are unavailable",
		});
		expect(positions[0]?.quoteValue).toBeUndefined();
	});

	it("falls back to valid raw futures valuation fields when normalized fields are placeholders", async () => {
		const stub = new StubExchange();
		configureFuturesMarket(stub, { contractSize: 10 });
		stub.futuresPositions = [
			{
				symbol,
				contracts: 2,
				side: "long",
				markPrice: 0,
				notional: 0,
				info: { markPrice: "100", notional: "200" },
			},
		];

		const positions = await newClient("binance", stub, "usdm-futures").getPositions();

		expect(positions[0]).toMatchObject({
			amount: 20,
			quoteValue: 200,
			markPrice: 100,
			valuationStatus: "complete",
		});
	});

	it("keeps only configured USDⓈ-M linear swap positions", async () => {
		const stub = new StubExchange();
		stub.futuresPositions = [
			{
				symbol,
				contracts: 1,
				side: "long",
				markPrice: 100,
				notional: 100,
			},
			{
				symbol: "BTC/USDC:USDC",
				contracts: 2,
				side: "long",
				markPrice: 100,
				notional: 200,
			},
			{
				symbol: "BTC/USDT:USDC",
				contracts: 2,
				side: "long",
				markPrice: 100,
				notional: 200,
			},
			{
				symbol: "ETH/USDT:USDT:DELIVERY",
				contracts: 1,
				side: "long",
				markPrice: 100,
				notional: 100,
			},
			{
				symbol: "UNKNOWN/USDT:USDT",
				contracts: 1,
				side: "long",
				markPrice: 100,
				notional: 100,
			},
		];

		const positions = await newClient("binance", stub, "usdm-futures").getPositions();

		expect(positions).toHaveLength(1);
		expect(positions[0]?.symbol).toBe(symbol);
	});

	it("rejects futures symbols with the wrong settlement currency or non-contract metadata", async () => {
		const settlementStub = new StubExchange();
		const settlementClient = newClient("binance", settlementStub, "usdm-futures");
		await expect(settlementClient.getTicker("BTC/USDT:USDC")).rejects.toThrow(/Unsupported usdm-futures market/);

		const nonContractStub = new StubExchange();
		nonContractStub.markets[symbol].contract = false;
		const nonContractClient = newClient("binance", nonContractStub, "usdm-futures");
		await expect(nonContractClient.getTicker(symbol)).rejects.toThrow(/Unsupported usdm-futures market/);
	});

	it.each([
		["non-linear", { linear: false }],
		["inverse", { inverse: true }],
	] as const)("rejects %s futures markets before market data access", async (_name, options) => {
		const stub = new StubExchange();
		configureFuturesMarket(stub, options);
		const client = newClient("binance", stub, "usdm-futures");

		await expect(client.getTicker(symbol)).rejects.toThrow(/Unsupported usdm-futures market/);
	});

	it("filters inactive futures markets from positions", async () => {
		const stub = new StubExchange();
		stub.markets[symbol].active = false;
		stub.futuresPositions = [{ symbol, contracts: 1, side: "long", markPrice: 100, notional: 100 }];

		const positions = await newClient("binance", stub, "usdm-futures").getPositions();

		expect(positions).toEqual([]);
	});

	it("omits a position whose contracts-to-base conversion overflows", async () => {
		const stub = new StubExchange();
		configureFuturesMarket(stub, { contractSize: Number.MAX_VALUE });
		stub.futuresPositions = [
			{
				symbol,
				contracts: 2,
				side: "long",
				markPrice: 100,
				notional: 200,
			},
		];

		const positions = await newClient("binance", stub, "usdm-futures").getPositions();

		expect(positions).toEqual([]);
	});

	it("does not leak non-finite futures metrics into the domain position", async () => {
		const stub = new StubExchange();
		stub.futuresPositions = [
			{
				symbol,
				contracts: 1,
				side: "long",
				markPrice: 100,
				notional: 100,
				leverage: Number.POSITIVE_INFINITY,
				liquidationPrice: Number.NaN,
				initialMargin: Number.POSITIVE_INFINITY,
				entryPrice: Number.NaN,
				unrealizedPnl: Number.POSITIVE_INFINITY,
				percentage: Number.NEGATIVE_INFINITY,
			},
		];

		const position = (await newClient("binance", stub, "usdm-futures").getPositions())[0];

		expect(position).toMatchObject({ amount: 1, quoteValue: 100, valuationStatus: "complete" });
		expect(position).not.toHaveProperty("leverage");
		expect(position).not.toHaveProperty("liquidationPrice");
		expect(position).not.toHaveProperty("margin");
		expect(position).not.toHaveProperty("avgEntryPrice");
		expect(position).not.toHaveProperty("unrealizedPnl");
		expect(position).not.toHaveProperty("marginType");
		expect(position).not.toHaveProperty("unrealizedPnlPct");
	});

	it("uses a recognized margin mode from raw exchange info", async () => {
		const stub = new StubExchange();
		stub.futuresPositions = [
			{ symbol, contracts: 1, side: "long", markPrice: 100, notional: 100, info: { marginType: "cross" } },
		];

		const position = (await newClient("binance", stub, "usdm-futures").getPositions())[0];

		expect(position).toMatchObject({ marginType: "cross" });
	});

	it("uses the standard Binance futures endpoint for ordinary client-id lookups", async () => {
		const stub = new StubExchange();
		configureFuturesMarket(stub, { contractSize: 10 });
		stub.orderQueryResponse = rawOrder("ordinary", "FILLED", {
			symbol,
			amount: 2,
			filled: 2,
			remaining: 0,
			info: { clientOrderId: "ordinary-id", positionSide: "BOTH" },
		});
		const client = newClient("binance", stub, "usdm-futures");

		const order = await client.getOrderByClientId("ordinary-id", symbol);

		expect(order).toMatchObject({ id: "ordinary", amount: 20, filled: 20, remaining: 0 });
		expect(stub.futuresGetOrderRawCalls).toEqual([{ symbol: "BTCUSDT", origClientOrderId: "ordinary-id" }]);
		expect(stub.futuresGetAlgoOrderRawCalls).toHaveLength(0);
	});

	it("rejects an emulated client-id lookup that does not echo the requested id", async () => {
		const stub = new StubExchange();
		stub.has.fetchOrderWithClientOrderId = "emulated";
		const client = newClient("okx", stub);

		await expect(client.getOrderByClientId("expected-id", "BTC/USDT")).rejects.toThrow(
			/did not prove clientOrderId=expected-id/,
		);
	});

	it("uses the Binance futures Algo endpoint for conditional client-id lookups", async () => {
		const stub = new StubExchange();
		configureFuturesMarket(stub, { contractSize: 10 });
		stub.orderQueryResponse = rawOrder("conditional", "NEW", {
			symbol,
			amount: 2,
			remaining: 2,
			info: { clientAlgoId: "conditional-id", ordType: "STOP_MARKET" },
		});
		const client = newClient("binance", stub, "usdm-futures");

		const order = await client.getOrderByClientId("conditional-id", symbol, true);

		expect(order).toMatchObject({ id: "conditional", amount: 20, remaining: 20, type: "stop_market" });
		expect(stub.futuresGetAlgoOrderRawCalls).toEqual([{ symbol: "BTCUSDT", clientAlgoId: "conditional-id" }]);
		expect(stub.futuresGetOrderRawCalls).toHaveLength(0);
	});

	it("rejects a mismatched Binance conditional client id", async () => {
		const stub = new StubExchange();
		configureFuturesMarket(stub, { contractSize: 10 });
		stub.orderQueryResponse = rawOrder("conditional", "NEW", {
			symbol,
			amount: 1,
			remaining: 1,
			info: { clientAlgoId: "different-id", ordType: "STOP_MARKET" },
		});
		const client = newClient("binance", stub, "usdm-futures");

		await expect(client.getOrderByClientId("expected-id", symbol, true)).rejects.toThrow(
			/clientOrderId=different-id.*expected-id/,
		);
	});

	it("falls back to the Binance futures Algo endpoint only after a definitive not-found", async () => {
		const stub = new StubExchange();
		configureFuturesMarket(stub, { contractSize: 10 });
		stub.futuresOrderQueryError = new Error("-2013 unknown order");
		stub.orderQueryResponse = rawOrder("conditional-fallback", "NEW", {
			symbol,
			amount: 1,
			remaining: 1,
			info: { clientAlgoId: "fallback-id", ordType: "STOP_MARKET" },
		});
		const client = newClient("binance", stub, "usdm-futures");

		const order = await client.getOrderByClientId("fallback-id", symbol);

		expect(order).toMatchObject({ id: "conditional-fallback", amount: 10, type: "stop_market" });
		expect(stub.futuresGetOrderRawCalls).toEqual([{ symbol: "BTCUSDT", origClientOrderId: "fallback-id" }]);
		expect(stub.futuresGetAlgoOrderRawCalls).toEqual([{ symbol: "BTCUSDT", clientAlgoId: "fallback-id" }]);
	});

	it("falls back to raw futures quantity fields when ccxt normalizes them to zero", async () => {
		const stub = new StubExchange();
		configureFuturesMarket(stub, { contractSize: 10 });
		stub.openBase = [
			rawOrder("futures-raw-quantity", "NEW", {
				symbol,
				amount: 0,
				filled: 0,
				remaining: 0,
				info: {
					contracts: "2",
					executedQty: "0.5",
					remainingQty: "1.5",
					positionSide: "LONG",
				},
			}),
		];
		const client = newClient("binance", stub, "usdm-futures");

		const orders = await client.getOpenOrders(symbol);

		expect(orders[0]).toMatchObject({ amount: 20, filled: 5, remaining: 15, positionSide: "LONG" });
	});

	it("retains reduceOnly for non-Binance hedge adapters", async () => {
		const stub = new StubExchange();
		configureFuturesMarket(stub, { contractSize: 10 });
		const client = newClient("okx", stub, "usdm-futures", { positionMode: "hedge" });

		await client.placeOrder({
			symbol,
			side: "sell",
			type: "market",
			amount: 20,
			reduceOnly: true,
			positionSide: "LONG",
		});

		expect(stub.createOrderCalls[0]).toMatchObject({ amount: 2, params: { positionSide: "LONG", reduceOnly: true } });
	});

	it("configures position mode, margin mode, and leverage before the first order only", async () => {
		const stub = new StubExchange();
		const client = newClient("binance", stub, "usdm-futures", {
			leverage: 7,
			marginType: "cross",
			positionMode: "hedge",
		});

		await client.placeOrder({ symbol, side: "buy", type: "market", amount: 1, positionSide: "LONG" });
		expect(stub.events).toEqual([
			"loadMarkets",
			"setPositionMode:true",
			`setMarginMode:cross:${symbol}`,
			`setLeverage:7:${symbol}`,
			"createOrder",
		]);

		await client.placeOrder({ symbol, side: "buy", type: "market", amount: 1, positionSide: "LONG" });
		expect(stub.events.slice(5)).toEqual(["createOrder"]);
	});

	it.each([
		["stop_market", "stopLossPrice", 90],
		["take_profit_market", "takeProfitPrice", 120],
	] as const)("omits reduceOnly for %s close-all triggers", async (type, triggerKey, stopPrice) => {
		const stub = new StubExchange();
		const client = newClient("binance", stub, "usdm-futures");

		await client.placeOrder({
			symbol,
			side: "sell",
			type,
			amount: 2,
			stopPrice,
			reduceOnly: true,
			closePosition: true,
			positionSide: "BOTH",
		});

		expect(stub.createOrderCalls).toEqual([
			expect.objectContaining({
				symbol,
				type: "market",
				side: "sell",
				amount: 2,
				price: undefined,
				params: expect.objectContaining({
					positionSide: "BOTH",
					[triggerKey]: stopPrice,
					closePosition: true,
				}),
			}),
		]);
		expect(stub.createOrderCalls[0]?.params).not.toHaveProperty("reduceOnly");
	});

	it("allows a hedge-mode reducing order with the opposing direction and omits reduceOnly", async () => {
		const stub = new StubExchange();
		const client = newClient("binance", stub, "usdm-futures", { positionMode: "hedge" });

		const result = await client.placeOrder({
			symbol,
			side: "sell",
			type: "market",
			amount: 2,
			reduceOnly: true,
			positionSide: "LONG",
		});

		expect(result.order).toMatchObject({ amount: 2, side: "sell", positionSide: "LONG" });
		expect(stub.createOrderCalls).toEqual([
			expect.objectContaining({
				side: "sell",
				amount: 2,
				params: expect.objectContaining({ positionSide: "LONG" }),
			}),
		]);
		expect(stub.createOrderCalls[0]?.params).not.toHaveProperty("reduceOnly");
	});

	it.each([
		["LONG", "buy"],
		["SHORT", "sell"],
	] as const)("rejects a hedge-mode reducing order with the wrong %s direction", async (positionSide, side) => {
		const stub = new StubExchange();
		const client = newClient("binance", stub, "usdm-futures", { positionMode: "hedge" });

		await expect(
			client.placeOrder({
				symbol,
				side,
				type: "market",
				amount: 2,
				reduceOnly: true,
				positionSide,
			}),
		).rejects.toThrow(/opposing side.*positionSide/);
		expect(stub.createOrderCalls).toHaveLength(0);
	});

	it("rejects a hedge-mode reducing order without an explicit position side", async () => {
		const stub = new StubExchange();
		const client = newClient("binance", stub, "usdm-futures", { positionMode: "hedge" });

		await expect(
			client.placeOrder({ symbol, side: "sell", type: "market", amount: 2, reduceOnly: true }),
		).rejects.toThrow(/require positionSide LONG or SHORT/);
		expect(stub.createOrderCalls).toHaveLength(0);
	});

	it("allows hedge-mode close-all triggers to omit reduceOnly", async () => {
		const stub = new StubExchange();
		const client = newClient("binance", stub, "usdm-futures", { positionMode: "hedge" });

		await client.placeOrder({
			symbol,
			side: "sell",
			type: "stop_market",
			amount: 2,
			stopPrice: 90,
			reduceOnly: true,
			closePosition: true,
			positionSide: "LONG",
		});

		expect(stub.createOrderCalls[0]?.params).toEqual(
			expect.objectContaining({ positionSide: "LONG", stopLossPrice: 90, closePosition: true }),
		);
		expect(stub.createOrderCalls[0]?.params).not.toHaveProperty("reduceOnly");
	});

	it("does not require a representable contract amount for Binance close-all triggers", async () => {
		const stub = new StubExchange();
		stub.futuresAmountDigits = 0;
		configureFuturesMarket(stub, { contractSize: 10, minContracts: 100, maxContracts: 100 });
		const client = newClient("binance", stub, "usdm-futures");

		await client.placeOrder({
			symbol,
			side: "sell",
			type: "stop_market",
			amount: 25,
			stopPrice: 90,
			closePosition: true,
			positionSide: "BOTH",
		});

		expect(stub.createOrderCalls[0]).toMatchObject({ amount: 3, params: { closePosition: true } });
		expect(stub.createOrderCalls[0]?.params).not.toHaveProperty("reduceOnly");
	});

	it("rejects closePosition on a futures limit-trigger order", async () => {
		const stub = new StubExchange();
		const client = newClient("binance", stub, "usdm-futures");

		await expect(
			client.placeOrder({
				symbol,
				side: "sell",
				type: "stop",
				amount: 2,
				price: 89,
				stopPrice: 90,
				closePosition: true,
				positionSide: "BOTH",
			}),
		).rejects.toThrow(/closePosition is supported only for market or trigger-market orders/);
		expect(stub.createOrderCalls).toHaveLength(0);
	});

	it("lets ccxt omit quantity from the final Binance close-all request", () => {
		type BinanceRequestBuilder = {
			markets: Record<string, unknown>;
			createOrderRequest(
				symbol: string,
				type: string,
				side: string,
				amount: number,
				price: number | undefined,
				params: Record<string, unknown>,
			): Record<string, unknown>;
		};
		const exchange = new ccxt.binance({ options: { defaultType: "swap" } }) as unknown as BinanceRequestBuilder;
		exchange.markets = {
			[symbol]: {
				id: "BTCUSDT",
				symbol,
				base: "BTC",
				quote: "USDT",
				settle: "USDT",
				type: "swap",
				contract: true,
				linear: true,
				swap: true,
				spot: false,
				info: { orderTypes: ["STOP_MARKET"] },
				precision: { amount: 0.001, price: 0.1 },
			},
		};

		const request = exchange.createOrderRequest(symbol, "market", "sell", 2, undefined, {
			stopLossPrice: 90,
			closePosition: true,
		});

		expect(request).toMatchObject({ type: "STOP_MARKET", closePosition: true });
		expect(request).not.toHaveProperty("quantity");
		expect(request).not.toHaveProperty("reduceOnly");
	});

	it("converts market closePosition into a real amount plus reduceOnly", async () => {
		const stub = new StubExchange();
		const client = newClient("binance", stub, "usdm-futures");

		await client.placeOrder({
			symbol,
			side: "sell",
			type: "market",
			amount: 2,
			reduceOnly: true,
			closePosition: true,
			positionSide: "BOTH",
		});

		expect(stub.createOrderCalls).toEqual([
			expect.objectContaining({
				amount: 2,
				params: expect.objectContaining({ reduceOnly: true, positionSide: "BOTH" }),
			}),
		]);
		expect(stub.createOrderCalls[0]?.params).not.toHaveProperty("closePosition");
	});

	it("aggregates no-symbol history over known symbols and rejects when none are known", async () => {
		const stub = new StubExchange();
		stub.allOrders = [rawOrder("closed", "closed"), rawOrder("canceled", "canceled"), rawOrder("still-open", "open")];
		const client = newClient("binance", stub);

		await expect(client.getOrderHistory()).rejects.toThrow(/requires a symbol/);
		await client.getTicker("BTC/USDT");
		const history = await client.getOrderHistory();
		expect(history).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "closed", status: "closed" }),
				expect.objectContaining({ id: "canceled", status: "canceled" }),
			]),
		);
		expect(history.some((order) => order.id === "still-open")).toBe(false);
		expect(stub.orderCalls).toContainEqual({ symbol: "BTC/USDT", params: {} });
	});

	it("rejects futures OCO without submitting an exchange order", async () => {
		const stub = new StubExchange();
		const client = newClient("binance", stub, "usdm-futures");

		await expect(
			client.placeOcoOrder({ symbol, side: "sell", amount: 1, stopLossPrice: 90, takeProfitPrice: 120 }),
		).rejects.toThrow(/Futures OCO orders are not supported/);
		expect(stub.createOrderCalls).toHaveLength(0);
	});
});
