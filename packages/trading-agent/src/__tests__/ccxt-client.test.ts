import ccxt from "ccxt";
import { describe, expect, it } from "vitest";
import { CcxtExchangeClient } from "../exchange/ccxt-client.ts";
import { isProtection } from "../monitor.ts";
import type { MarketType } from "../state.ts";

interface RawOrder {
	id: string;
	symbol: string;
	side: "buy" | "sell";
	type?: string;
	status?: string;
	amount?: number;
	filled?: number;
	remaining?: number;
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
	readonly closedCalls: OrderQueryCall[] = [];
	readonly canceledCalls: OrderQueryCall[] = [];
	readonly orderCalls: OrderQueryCall[] = [];
	readonly createOrderCalls: CreateOrderCall[] = [];
	readonly cancelOrderCalls: CancelOrderCall[] = [];
	readonly rawCalls: Record<string, unknown>[] = [];
	readonly getOrderRawCalls: Record<string, unknown>[] = [];
	readonly getOrderListRawCalls: Record<string, unknown>[] = [];
	trailingResponse: Record<string, unknown> = { orderId: 9, status: "NEW", executedQty: "0", transactTime: 1 };
	trailingError: Error | undefined;
	createOrderError: Error | undefined;
	ocoError: Error | undefined;
	orderQueryError: Error | undefined;
	cancelError: Error | undefined;
	orderListCancelError: Error | undefined;
	orderListQueryError: Error | undefined;
	orderQueryResponse: RawOrder = rawOrder("queried", "NEW");
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
		return this.ocoResponse;
	};
	privateGetOrder = async (params: Record<string, unknown>) => {
		this.getOrderRawCalls.push(params);
		if (this.orderQueryError) throw this.orderQueryError;
		return this.orderQueryResponse;
	};
	privateGetOrderList = async (params: Record<string, unknown>) => {
		this.getOrderListRawCalls.push(params);
		if (this.orderListQueryError) throw this.orderListQueryError;
		return this.orderListQueryResponse ?? { orderListId: 42, listOrderStatus: "EXEC_STARTED", orderReports: [] };
	};
	privateDeleteOrderList = async (params: Record<string, unknown>) => {
		this.getOrderListRawCalls.push(params);
		if (this.orderListCancelError) throw this.orderListCancelError;
		return {};
	};
	readonly has = { fetchCanceledOrders: true, fetchMyTrades: true };
	balances: Record<string, number> = { BTC: 1, USDT: 1000 };
	trades: Array<Record<string, unknown>> = [];
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
	last = 100;
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
			limits: { amount: { min: 0.001 }, cost: {} },
		},
	};

	async loadMarkets(): Promise<typeof this.markets> {
		this.events.push("loadMarkets");
		return this.markets;
	}

	amountToPrecision(_symbol: string, amount: number): string {
		return String(amount);
	}

	priceToPrecision(_symbol: string, price: number): string {
		return String(price);
	}

	async fetchTicker(symbol: string) {
		return { symbol, last: this.last, bid: this.last - 1, ask: this.last + 1, timestamp: 1 };
	}

	async fetchBalance() {
		return {
			total: this.balances,
			free: this.balances,
			used: Object.fromEntries(Object.keys(this.balances).map((asset) => [asset, 0])),
		};
	}

	async fetchMyTrades(_symbol?: string, _since?: number, _limit?: number): Promise<Array<Record<string, unknown>>> {
		return this.trades;
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
		};
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

describe("Binance Spot submission reconciliation", () => {
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

	it("normalizes typed authentication and rate-limit rejections", async () => {
		const authStub = new StubExchange();
		authStub.createOrderError = new ccxt.AuthenticationError("invalid API-key, IP, or permissions");
		await expect(
			newClient("binance", authStub).placeOrder({ symbol: "BTC/USDT", side: "buy", type: "market", amount: 1 }),
		).rejects.toThrow(/errorCategory=AUTHENTICATION/);
		expect(authStub.getOrderRawCalls).toHaveLength(0);

		const rateStub = new StubExchange();
		rateStub.createOrderError = new ccxt.RateLimitExceeded("Too many requests; -1003");
		await expect(
			newClient("binance", rateStub).placeOrder({ symbol: "BTC/USDT", side: "buy", type: "market", amount: 1 }),
		).rejects.toThrow(/errorCategory=RATE_LIMIT.*code=-1003/);
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
			listOrderStatus: "EXEC_STARTED",
			orderReports: [
				{ symbol: "BTCUSDT", orderId: 10 },
				{ symbol: "BTCUSDT", orderId: 11 },
			],
		};
		stub.orderQueryResponse = rawOrder("leg", "NEW");
		const client = newClient("binance", stub);
		const result = await client.placeOcoOrder({
			symbol: "BTC/USDT",
			side: "sell",
			amount: 1,
			stopLossPrice: 90,
			takeProfitPrice: 120,
			listClientOrderId: "list-id",
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
		expect(stub.rawCalls[0]).toMatchObject({ type: "STOP_LOSS", trailingDelta: "200", stopPrice: "110" });
	});

	it("uses above trailing bounds for buy take-profit orders even when activation is below market", async () => {
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

	it("rejects trailing deltas outside the symbol-specific filter range", async () => {
		const stub = new StubExchange();
		const client = newClient("binance", stub);
		await expect(
			client.placeOrder({
				symbol: "BTC/USDT",
				side: "sell",
				type: "trailing_stop_market",
				amount: 1,
				trailingPercent: 0.05,
			}),
		).rejects.toThrow(/outside below range 10-1000/);
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
});

describe("ccxt constructor options", () => {
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

describe("live Spot cost basis", () => {
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
});

describe("ccxt market data", () => {
	it("leaves candle completion unknown for unsupported timeframes", async () => {
		const stub = new StubExchange();
		stub.ohlcv = [[1, 90, 105, 85, 100, 10]];
		const client = newClient("okx", stub);

		const candles = await client.getKlines("BTC/USDT", "custom", 1);

		expect(candles[0]?.closed).toBeUndefined();
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
		expect(isProtection(orders[0], { symbol: "BTC/USDT", asset: "BTC", amount: 0.5, quoteValue: 50 })).toBe(true);
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
});

describe("Binance futures adapter", () => {
	const symbol = "BTC/USDT:USDT";

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
