import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	capability,
	evaluateOrderCapability,
	getTradingCapabilities,
	normalizedOrderTypes,
	ORDER_TYPES,
	orderTypeFromMarketInfo,
	supportsCorrelatedLookup,
	TRADING_CAPABILITY_MATRIX,
	type TradingCapabilityContext,
} from "./capabilities.ts";
import { CcxtExchangeClient } from "./ccxt-client.ts";
import type { FuturesPositionMode } from "./client-types.ts";
import { type OrderIntent, type OrderPlanningContext, prepareOcoOrder, prepareOrder } from "./order-plan.ts";
import { preflightOco, preflightOrder } from "./order-preflight.ts";
import { PaperExchangeClient } from "./paper-client.ts";
import { createMarketDataView, type ExchangeClient, type MarketInfo, type PlaceOrderType } from "./types.ts";

const spot = "BTC/USDT";
const futures = "BTC/USDT:USDT";
const directories: string[] = [];
const clients: ExchangeClient[] = [];

class ContractExchange {
	readonly calls: { method: string; params: Record<string, unknown> }[] = [];
	readonly has = { fetchOrder: true };
	readonly markets = {
		[spot]: {
			id: "BTCUSDT",
			symbol: spot,
			base: "BTC",
			quote: "USDT",
			spot: true,
			swap: false,
			contract: false,
			active: true,
			precision: { amount: 0.001, price: 0.01 },
			limits: {},
			info: {
				filters: [
					{
						filterType: "TRAILING_DELTA",
						minTrailingAboveDelta: 10,
						maxTrailingAboveDelta: 1000,
						minTrailingBelowDelta: 10,
						maxTrailingBelowDelta: 1000,
					},
				],
			},
		},
		[futures]: {
			id: "BTCUSDT",
			symbol: futures,
			base: "BTC",
			quote: "USDT",
			settle: "USDT",
			spot: false,
			swap: true,
			contract: true,
			linear: true,
			inverse: false,
			contractSize: 0.01,
			active: true,
			precision: { amount: 0.001, price: 0.01 },
			limits: {},
			info: {},
		},
	};
	order: Record<string, unknown> = {};

	async loadMarkets() {
		return this.markets;
	}
	async fetchTicker(symbol: string) {
		return { symbol, last: 100, timestamp: Date.now() };
	}
	async fetchOHLCV() {
		return [];
	}
	amountToPrecision(_symbol: string, value: number) {
		return value.toFixed(3);
	}
	priceToPrecision(_symbol: string, value: number) {
		return value.toFixed(2);
	}
	safeSymbol() {
		return spot;
	}
	parseOrder(order: Record<string, unknown>) {
		return order;
	}
	async setPositionMode() {}
	async setMarginMode() {}
	async setLeverage() {}
	async close() {}
	async createOrder(
		symbol: string,
		type: string,
		side: string,
		amount: number,
		price: number | undefined,
		params: Record<string, unknown>,
	) {
		this.calls.push({ method: "createOrder", params: { symbol, type, side, amount, price, ...params } });
		this.order = {
			id: "1",
			symbol,
			type,
			side,
			amount,
			price,
			clientOrderId: params.clientOrderId ?? params.newClientOrderId,
			filled: 0,
			remaining: amount,
			cost: 0,
			status: "open",
			timestamp: 1,
		};
		return this.order;
	}
	async privatePostOrder(params: Record<string, unknown>) {
		this.calls.push({ method: "privatePostOrder", params });
		this.order = {
			id: "1",
			symbol: spot,
			type: "market",
			side: "sell",
			amount: 1,
			clientOrderId: params.newClientOrderId,
			filled: 0,
			remaining: 1,
			cost: 0,
			status: "open",
			timestamp: 1,
		};
		return { orderId: "1", clientOrderId: params.newClientOrderId, status: "NEW", executedQty: "0", transactTime: 1 };
	}
	async privateGetOrder(params: Record<string, unknown>) {
		this.calls.push({ method: "privateGetOrder", params });
		return params.orderId === "2" ? { ...this.order, id: "2", clientOrderId: "leg-below" } : this.order;
	}
	async fapiPrivateGetOrder(params: Record<string, unknown>) {
		this.calls.push({ method: "fapiPrivateGetOrder", params });
		return this.order;
	}
	async fapiPrivateGetAlgoOrder(params: Record<string, unknown>) {
		this.calls.push({ method: "fapiPrivateGetAlgoOrder", params });
		return this.order;
	}
	async fetchOrder(id: string, symbol: string) {
		this.calls.push({ method: "fetchOrder", params: { id, symbol } });
		return this.order;
	}
	async cancelOrder(id: string, symbol: string) {
		this.calls.push({ method: "cancelOrder", params: { id, symbol } });
	}
	async privatePostOrderListOco(params: Record<string, unknown>) {
		this.calls.push({ method: "privatePostOrderListOco", params });
		this.order = {
			id: "1",
			symbol: spot,
			side: "sell",
			type: "limit",
			amount: 1,
			clientOrderId: params.aboveClientOrderId,
			filled: 0,
			remaining: 1,
			cost: 0,
			status: "open",
			timestamp: 1,
		};
		return {
			orderListId: "list-1",
			listOrderStatus: "EXEC_STARTED",
			orderReports: [
				{ orderId: "1", type: "LIMIT_MAKER", price: "110", status: "NEW", executedQty: "0" },
				{ orderId: "2", type: "STOP_LOSS_LIMIT", price: "90", stopPrice: "90", status: "NEW", executedQty: "0" },
			],
		};
	}
	async privateGetOrderList(params: Record<string, unknown>) {
		this.calls.push({ method: "privateGetOrderList", params });
		return {
			orderListId: "list-1",
			listClientOrderId: "list-client",
			listOrderStatus: "EXECUTING",
			orders: [
				{ symbol: "BTCUSDT", orderId: "1" },
				{ symbol: "BTCUSDT", orderId: "2" },
			],
		};
	}
	async privateDeleteOrderList(params: Record<string, unknown>) {
		this.calls.push({ method: "privateDeleteOrderList", params });
		return {};
	}
}

function fixture(
	mode: "paper" | "live",
	family: "spot" | "futures",
	positionMode: FuturesPositionMode = "one-way",
	exchangeId = "binance",
) {
	const wire = new ContractExchange();
	const marketType = family === "spot" ? "spot" : "usdm-futures";
	let client: ExchangeClient;
	if (mode === "paper") {
		const directory = join(process.cwd(), `.capability-contract-${randomUUID()}`);
		mkdirSync(directory);
		directories.push(directory);
		client = new PaperExchangeClient(
			exchangeId,
			"USDT",
			100_000,
			0,
			directory,
			marketType,
			1,
			"isolated",
			positionMode,
		);
		(client as unknown as { futuresExchange: ContractExchange }).futuresExchange = wire;
	} else {
		client = new CcxtExchangeClient(
			exchangeId,
			"USDT",
			{ apiKey: "", secret: "" },
			marketType,
			1,
			"isolated",
			positionMode,
		);
	}
	(client as unknown as { exchange: ContractExchange }).exchange = wire;
	clients.push(client);
	const context: TradingCapabilityContext = { exchangeId, mode, marketFamily: family, positionMode };
	const planning: OrderPlanningContext = {
		mode,
		config: { marketType, quoteCurrency: "USDT", positionMode },
		exchange: createMarketDataView(client),
	};
	const symbol = family === "futures" ? futures : spot;
	return { client, wire, context, planning, symbol };
}

afterEach(async () => {
	for (const client of clients.splice(0)) await client.close();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function intent(type: PlaceOrderType, symbol = spot): OrderIntent {
	return {
		symbol,
		type,
		amount: 1,
		...(type === "limit" ? { price: 110 } : {}),
		...(type === "stop" ? { price: 90, stopPrice: 90 } : {}),
		...(type === "stop_market" ? { stopPrice: 90 } : {}),
		...(type === "take_profit" ? { price: 110, stopPrice: 110 } : {}),
		...(type === "take_profit_market" ? { stopPrice: 110 } : {}),
		...(type === "trailing_stop_market" ? { trailingPercent: 1 } : {}),
	};
}

describe("executable capability contracts", () => {
	const cases = TRADING_CAPABILITY_MATRIX.flatMap((row) =>
		(row.marketFamily === "futures" ? (["one-way", "hedge"] as const) : (["one-way"] as const)).flatMap(
			(positionMode) =>
				row.orderTypes.map((type) => ({
					profile: row.id,
					mode: row.mode,
					family: row.marketFamily,
					positionMode,
					type,
					exchangeId: row.exchangeId === "*" ? "binance" : row.exchangeId,
				})),
		),
	);

	it.each(cases)(
		"$profile $positionMode $type uses the advertised submission, lookup and cancellation contract",
		async ({ mode, family, positionMode, type, exchangeId }) => {
			const { client, wire, context, planning, symbol } = fixture(mode, family, positionMode, exchangeId);
			const matrix = getTradingCapabilities({ ...context, orderType: type });
			const conditional = type !== "market" && type !== "limit";
			const nativeIdProven = !(mode === "live" && family === "futures" && conditional);
			expect(matrix.orderTypes[type]).toMatchObject({
				status: "supported",
				evidence: { level: "offline-contract" },
			});
			expect(supportsCorrelatedLookup(matrix.queryOrderById)).toBe(nativeIdProven);
			expect(supportsCorrelatedLookup(matrix.queryOrderByClientId)).toBe(true);
			if (mode === "paper" && family === "spot")
				await client.placeOrder({ symbol, type: "market", side: "buy", amount: 10 });
			const params = {
				...intent(type, symbol),
				...(positionMode === "hedge" ? { positionSide: "SHORT" as const } : {}),
			};
			const plan = await prepareOrder("sell", params, planning);
			expect(Object.isFrozen(plan.capabilityContext)).toBe(true);
			if (mode === "paper") {
				await expect(
					preflightOrder(plan, {
						getMarketInfo: (value) => client.getMarketInfo(value),
						getBalances: () => client.getBalances(),
						quoteCurrency: "USDT",
						marketType: planning.config.marketType,
						getEffectiveLeverage: () => 1,
					}),
				).resolves.toEqual({ warnings: [] });
			}
			const result = await client.placeOrder({ ...plan.input, clientOrderId: "matrix-client" });
			expect(result.order.clientOrderId).toBe("matrix-client");
			const byClient =
				client instanceof CcxtExchangeClient
					? await client.getOrderByClientId("matrix-client", symbol, conditional)
					: await client.getOrderByClientId("matrix-client", symbol);
			expect(byClient.id).toBe(result.order.id);
			expect((await client.getOrder(result.order.id, symbol)).id).toBe(result.order.id);
			expect(matrix.cancelOrder.status).toBe(nativeIdProven ? "supported" : "unknown");
			if (mode === "paper" && type === "market") {
				await expect(client.cancelOrder(result.order.id, symbol)).rejects.toThrow(/Open order.*not found/);
			} else {
				await client.cancelOrder(result.order.id, symbol);
			}
			if (mode === "live" && exchangeId === "binance") {
				if (family === "spot" && type === "trailing_stop_market") {
					expect(wire.calls).toContainEqual({
						method: "privatePostOrder",
						params: {
							symbol: "BTCUSDT",
							side: "SELL",
							type: "TAKE_PROFIT",
							quantity: "1.000",
							trailingDelta: "100",
							newClientOrderId: "matrix-client",
						},
					});
				} else {
					const submit = wire.calls.find((call) => call.method === "createOrder")!;
					const limit = type === "limit" || type === "stop" || type === "take_profit";
					expect(submit.params).toMatchObject({
						symbol,
						type: limit ? "limit" : "market",
						side: "sell",
						amount: family === "futures" ? 100 : 1,
						...(family === "spot" ? { newClientOrderId: "matrix-client" } : { clientOrderId: "matrix-client" }),
						...(positionMode === "hedge" ? { positionSide: "SHORT" } : {}),
					});
					if (type === "stop" || type === "stop_market") expect(submit.params.stopLossPrice).toBe(90);
					if (type === "take_profit" || type === "take_profit_market")
						expect(submit.params.takeProfitPrice).toBe(110);
					if (type === "trailing_stop_market") expect(submit.params.trailingPercent).toBe(1);
				}
				const lookupMethod =
					family === "spot" ? "privateGetOrder" : conditional ? "fapiPrivateGetAlgoOrder" : "fapiPrivateGetOrder";
				expect(wire.calls).toContainEqual({
					method: lookupMethod,
					params: {
						symbol: "BTCUSDT",
						...(family === "futures" && conditional
							? { clientAlgoId: "matrix-client" }
							: { origClientOrderId: "matrix-client" }),
					},
				});
				expect(wire.calls).toContainEqual({ method: "cancelOrder", params: { id: result.order.id, symbol } });
			}
		},
	);

	it.each(
		TRADING_CAPABILITY_MATRIX.flatMap((row) =>
			row.ocoSides.map((side) => ({
				mode: row.mode,
				side,
				exchangeId: row.exchangeId === "*" ? "binance" : row.exchangeId,
			})),
		),
	)(
		"$mode OCO $side submits one bracket and uses native/client list lookup and cancellation",
		async ({ mode, side, exchangeId }) => {
			const { client, wire, context, planning } = fixture(mode, "spot", "one-way", exchangeId);
			expect(getTradingCapabilities(context).oco[side].status).toBe("supported");
			if (mode === "paper") await client.placeOrder({ symbol: spot, type: "market", side: "buy", amount: 10 });
			const plan = await prepareOcoOrder(
				{
					symbol: spot,
					side,
					amount: 1,
					stopLossPrice: side === "sell" ? 90 : 110,
					takeProfitPrice: side === "sell" ? 110 : 90,
				},
				planning,
			);
			const result = await client.placeOcoOrder({
				...plan.input,
				listClientOrderId: "list-client",
				aboveClientOrderId: "leg-above",
				belowClientOrderId: "leg-below",
			});
			expect(result.orders).toHaveLength(2);
			const listId = result.orders[0].orderListId ?? result.orders[0].ocoGroup!;
			expect((await client.getOrderListByClientId("list-client")).orders).toHaveLength(2);
			expect((await client.getOrderList(listId)).orders).toHaveLength(2);
			await client.cancelOrderList(listId, spot);
			if (mode === "live" && exchangeId === "binance") {
				expect(wire.calls.find((call) => call.method === "privatePostOrderListOco")?.params).toMatchObject({
					symbol: "BTCUSDT",
					side: "SELL",
					quantity: "1.000",
					aboveType: "LIMIT_MAKER",
					belowType: "STOP_LOSS_LIMIT",
					listClientOrderId: "list-client",
					aboveClientOrderId: "leg-above",
					belowClientOrderId: "leg-below",
				});
				expect(wire.calls).toContainEqual({
					method: "privateGetOrderList",
					params: { origClientOrderId: "list-client" },
				});
				expect(wire.calls).toContainEqual({
					method: "privateDeleteOrderList",
					params: { symbol: "BTCUSDT", orderListId: listId },
				});
			}
		},
	);

	it.each(ORDER_TYPES.filter((type) => type !== "market"))(
		"keeps Paper futures %s unknown without market metadata and still prepares it because Paper does not require live order-type metadata",
		async (type) => {
			const { context, planning } = fixture("paper", "futures");
			expect(getTradingCapabilities({ ...context, metadataValid: false }).orderTypes[type].status).toBe("unknown");
			expect(getTradingCapabilities(context).orderTypes[type].status).toBe("supported");
			await expect(prepareOrder("sell", intent(type, futures), planning)).resolves.toMatchObject({
				input: { type, symbol: futures },
			});
		},
	);

	it("rejects unsupported OCO and futures-control combinations at planning", async () => {
		const { planning } = fixture("live", "spot");
		await expect(
			prepareOcoOrder({ symbol: spot, side: "buy", amount: 1, stopLossPrice: 110, takeProfitPrice: 90 }, planning),
		).rejects.toThrow(/native OCO buy/);
		await expect(prepareOrder("sell", { ...intent("market"), reduceOnly: true }, planning)).rejects.toThrow(
			/futures-only/,
		);
		const hedge = fixture("live", "futures", "hedge");
		await expect(prepareOrder("sell", intent("market", futures), hedge.planning)).rejects.toThrow(
			/positionSide LONG or SHORT/,
		);
		await expect(
			prepareOrder("buy", { ...intent("market", futures), reduceOnly: true, positionSide: "LONG" }, hedge.planning),
		).rejects.toThrow(/opposing side/);
	});

	it.each(["one-way", "hedge"] as const)(
		"shares %s close/reduce quantity semantics with the Binance wire contract",
		async (positionMode) => {
			const { client, wire, context } = fixture("live", "futures", positionMode);
			for (const type of ["market", "stop_market", "take_profit_market"] as const) {
				const input = {
					...intent(type, futures),
					amount: 1,
					side: "sell" as const,
					closePosition: true,
					reduceOnly: true,
					positionSide: positionMode === "hedge" ? ("LONG" as const) : ("BOTH" as const),
				};
				const evaluated = evaluateOrderCapability(context, input);
				expect(evaluated.omitExchangeQuantity).toBe(type !== "market");
				expect(evaluated.omitReduceOnly).toBe(type !== "market" || positionMode === "hedge");
				await client.placeOrder(input);
				const params = wire.calls.filter((call) => call.method === "createOrder").at(-1)!.params;
				expect(params.reduceOnly).toBe(evaluated.omitReduceOnly ? undefined : true);
				expect(params.closePosition).toBe(type === "market" ? undefined : true);
			}
		},
	);

	it.each([
		{ rawType: "STOP", type: "stop", executionType: "limit" },
		{ rawType: "STOP_MARKET", type: "stop_market", executionType: "market" },
		{ rawType: "TAKE_PROFIT", type: "take_profit", executionType: "limit" },
		{ rawType: "TAKE_PROFIT_MARKET", type: "take_profit_market", executionType: "market" },
		{ rawType: "TRAILING_STOP_MARKET", type: "trailing_stop_market", executionType: "market" },
	] as const)(
		"maps correlated $rawType parent lookup evidence without certifying terminal child fills",
		async ({ rawType, type, executionType }) => {
			const { client, wire, context } = fixture("live", "futures");
			if (!(client instanceof CcxtExchangeClient)) throw new Error("Expected a CCXT contract fixture");
			wire.order = {
				id: "algo-parent",
				symbol: futures,
				type: executionType,
				side: "sell",
				amount: 2,
				filled: 0,
				remaining: 2,
				cost: 0,
				status: "open",
				timestamp: 1,
				info: { orderType: rawType, clientAlgoId: "parent-client", positionSide: "LONG" },
			};
			const matrix = getTradingCapabilities({ ...context, orderType: type });
			expect(supportsCorrelatedLookup(matrix.queryOrderByClientId)).toBe(true);
			expect(matrix.queryOrderByClientId.constraints).toContain(
				"Offline Algo lookup contracts cover correlated parent orders, not terminal child fills; missing fill evidence must remain unresolved",
			);
			await expect(client.getOrderByClientId("parent-client", futures, true)).resolves.toMatchObject({
				id: "algo-parent",
				clientOrderId: "parent-client",
				symbol: futures,
				type,
				positionSide: "LONG",
				amount: 0.02,
				filled: 0,
				remaining: 0.02,
				cost: 0,
				status: "open",
			});
			expect(wire.calls).toEqual([
				{ method: "fapiPrivateGetAlgoOrder", params: { symbol: "BTCUSDT", clientAlgoId: "parent-client" } },
			]);
			wire.order = {
				...wire.order,
				status: undefined,
				info: { orderType: rawType, clientAlgoId: "parent-client", algoStatus: "FINISHED" },
			};
			await expect(client.getOrderByClientId("parent-client", futures, true)).resolves.toMatchObject({
				status: "unknown",
				filled: 0,
				cost: 0,
			});
			wire.order = { ...wire.order, info: { orderType: rawType, clientAlgoId: "different-client" } };
			await expect(client.getOrderByClientId("parent-client", futures, true)).rejects.toThrow(
				/different-client.*parent-client/,
			);
			wire.order = { ...wire.order, symbol: spot, info: { orderType: rawType, clientAlgoId: "parent-client" } };
			await expect(client.getOrderByClientId("parent-client", futures, true)).rejects.toThrow(
				/returned BTC\/USDT while BTC\/USDT:USDT was requested/,
			);
		},
	);
});

describe("capability evidence and metadata", () => {
	const info: MarketInfo = {
		symbol: spot,
		base: "BTC",
		quote: "USDT",
		marketType: "spot",
		contract: false,
		active: true,
	};
	it("normalizes bounded aliases exactly and separates Spot/Futures TAKE_PROFIT", () => {
		expect(
			normalizedOrderTypes({
				...info,
				orderTypes: [
					" stop-loss-limit ",
					"STOP_LOSS",
					"TAKE_PROFIT_LIMIT",
					"TAKE_PROFIT",
					"TRAILING_STOP",
					"NOT_STOP_LOSS",
				],
			}),
		).toEqual(["stop", "stop_market", "take_profit", "take_profit_market", "trailing_stop_market", "not_stop_loss"]);
		expect(orderTypeFromMarketInfo({ ...info, orderTypes: ["STOP_LOSS"] }, ["stop"])).toBe("unsupported");
		expect(orderTypeFromMarketInfo({ ...info, orderTypes: ["NOT_STOP_LOSS"] }, ["stop_market"])).toBe("unsupported");
		expect(
			normalizedOrderTypes({ ...info, marketType: "swap", orderTypes: ["TAKE_PROFIT", "TAKE_PROFIT_MARKET"] }),
		).toEqual(["take_profit", "take_profit_market"]);
		expect(orderTypeFromMarketInfo({ ...info, orderTypes: ["TRAILING_STOP_MARKET"] }, ["trailing"])).toBe(
			"supported",
		);
		expect(orderTypeFromMarketInfo(info, ["market"])).toBeUndefined();
	});

	it("requires proven routing before advertising native futures lookup or cancellation", () => {
		const context: TradingCapabilityContext = { exchangeId: "binance", mode: "live", marketFamily: "futures" };
		for (const orderType of [
			undefined,
			"stop",
			"stop_market",
			"take_profit",
			"take_profit_market",
			"trailing_stop_market",
		] as const) {
			const matrix = getTradingCapabilities({ ...context, orderType });
			expect(matrix.queryOrderById.status).toBe("unknown");
			expect(matrix.cancelOrder.status).toBe("unknown");
			expect(supportsCorrelatedLookup(matrix.queryOrderById)).toBe(false);
			expect(supportsCorrelatedLookup(matrix.queryOrderByClientId)).toBe(true);
		}
		for (const orderType of ["market", "limit"] as const) {
			const matrix = getTradingCapabilities({ ...context, orderType });
			expect(matrix.cancelOrder.status).toBe("supported");
			expect(supportsCorrelatedLookup(matrix.queryOrderById)).toBe(true);
		}
		expect(getTradingCapabilities({ ...context, marketFamily: "invalid" }).cancelOrder.status).toBe("unsupported");
	});

	it("distinguishes every close-position type from ordinary order submission support", () => {
		const context: TradingCapabilityContext = {
			exchangeId: "binance",
			mode: "live",
			marketFamily: "futures",
			positionMode: "one-way",
		};
		for (const type of ORDER_TYPES) {
			const result = getTradingCapabilities(context).closePosition[type];
			const supported = type === "market" || type === "stop_market" || type === "take_profit_market";
			expect(result.status).toBe(supported ? "supported" : "unsupported");
			expect(evaluateOrderCapability(context, { type, side: "sell", closePosition: true }).capability.status).toBe(
				result.status,
			);
		}
	});

	it("keeps missing metadata and experimental adapters unknown without banning existing submissions", async () => {
		const { planning } = fixture("live", "spot");
		const experimental = { ...planning, exchange: { ...planning.exchange, id: "okx" } };
		const plan = await prepareOrder("sell", intent("market"), experimental);
		const matrix = getTradingCapabilities({
			...plan.capabilityContext,
			marketInfo: { ...info, orderTypes: ["MARKET"] },
		});
		expect(matrix.orderTypes.market).toMatchObject({ status: "unknown", evidence: { level: "experimental" } });
		expect(supportsCorrelatedLookup(matrix.queryOrderByClientId)).toBe(false);
		expect(supportsCorrelatedLookup(matrix.queryOrderById)).toBe(false);
		expect(matrix.queryOrderListByClientId.status).toBe("unsupported");
		const preflight = await preflightOrder(plan, {
			getMarketInfo: async () => info,
			getBalances: async () => [{ asset: "BTC", free: 10, used: 0, total: 10 }],
			quoteCurrency: "USDT",
			marketType: "spot",
			getEffectiveLeverage: () => 1,
		});
		expect(preflight.warnings).toEqual([matrix.orderTypes.market.reason]);
		const unavailable = getTradingCapabilities({
			...plan.capabilityContext,
			exchangeId: "binance",
			metadataValid: false,
		});
		expect(unavailable.orderTypes.market.status).toBe("unknown");
		expect(supportsCorrelatedLookup(unavailable.queryOrderByClientId)).toBe(true);
		expect(supportsCorrelatedLookup(capability("supported", "metadata says yes"))).toBe(false);
	});

	it("uses exact metadata aliases in preflight and does not confuse native OCO/trailing with individual order types", async () => {
		const { planning } = fixture("live", "spot");
		const dependencies = {
			getMarketInfo: async () => ({ ...info, orderTypes: ["MARKET", "LIMIT", "STOP_LOSS", "TAKE_PROFIT"] }),
			getBalances: async () => [{ asset: "BTC", free: 10, used: 0, total: 10 }],
			quoteCurrency: "USDT",
			marketType: "spot" as const,
			getEffectiveLeverage: () => 1,
		};
		await expect(preflightOrder(await prepareOrder("sell", intent("stop"), planning), dependencies)).rejects.toThrow(
			/does not support stop orders/,
		);
		await expect(
			preflightOrder(await prepareOrder("sell", intent("stop_market"), planning), dependencies),
		).resolves.toEqual({ warnings: [] });
		await expect(
			preflightOrder(await prepareOrder("sell", intent("trailing_stop_market"), planning), dependencies),
		).resolves.toEqual({ warnings: [] });
		const oco = await prepareOcoOrder(
			{ symbol: spot, side: "sell", amount: 1, stopLossPrice: 90, takeProfitPrice: 110 },
			planning,
		);
		await expect(preflightOco(oco, dependencies)).resolves.toMatchObject({ warnings: [] });
	});
});
