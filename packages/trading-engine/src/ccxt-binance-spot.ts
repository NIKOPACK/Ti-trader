import type { Exchange } from "ccxt";
import { optionalBoolean, positionSideFromInfo, toOrderStatus, validTimestamp } from "./ccxt-map.ts";
import type { Order } from "./types.ts";

export async function createBinanceSpotOco(
	exchange: Exchange,
	symbol: string,
	side: "buy" | "sell",
	amount: number,
	stopLossPrice: number,
	takeProfitPrice: number,
	listClientOrderId: string,
	aboveClientOrderId: string,
	belowClientOrderId: string,
): Promise<Record<string, unknown>> {
	const methods = exchange as unknown as Record<string, unknown>;
	// ccxt renamed the Spot endpoint from order/oco to orderList/oco.
	// Prefer the current method, but support older ccxt releases as well.
	const currentEndpoint = typeof methods.privatePostOrderListOco === "function";
	const endpoint = currentEndpoint ? methods.privatePostOrderListOco : methods.privatePostOrderOco;
	if (typeof endpoint !== "function")
		throw new Error("Binance ccxt adapter does not expose a Spot order-list OCO endpoint");
	const market = exchange.markets[symbol];
	const params: Record<string, string> = currentEndpoint
		? {
				symbol: market.id,
				side: side.toUpperCase(),
				quantity: exchange.amountToPrecision(symbol, amount),
				aboveType: "LIMIT_MAKER",
				abovePrice: exchange.priceToPrecision(symbol, takeProfitPrice),
				belowType: "STOP_LOSS_LIMIT",
				belowPrice: exchange.priceToPrecision(symbol, stopLossPrice),
				belowStopPrice: exchange.priceToPrecision(symbol, stopLossPrice),
				belowTimeInForce: "GTC",
				listClientOrderId,
				aboveClientOrderId,
				belowClientOrderId,
			}
		: {
				symbol: market.id,
				side: side.toUpperCase(),
				quantity: exchange.amountToPrecision(symbol, amount),
				price: exchange.priceToPrecision(symbol, takeProfitPrice),
				stopPrice: exchange.priceToPrecision(symbol, stopLossPrice),
				stopLimitPrice: exchange.priceToPrecision(symbol, stopLossPrice),
				stopLimitTimeInForce: "GTC",
				// The legacy /order/oco API uses listClientOrderId and
				// per-leg client ids; newClientOrderId is a single-order field.
				listClientOrderId,
				limitClientOrderId: aboveClientOrderId,
				stopClientOrderId: belowClientOrderId,
			};
	return (await (endpoint as (params: Record<string, string>) => Promise<unknown>).call(exchange, params)) as Record<
		string,
		unknown
	>;
}

export async function createBinanceSpotTrailingOrder(
	exchange: Exchange,
	symbol: string,
	side: "buy" | "sell",
	amount: number,
	trailingPercent: number,
	stopPrice?: number,
	clientOrderId?: string,
): Promise<Record<string, unknown>> {
	const endpoint = (exchange as unknown as Record<string, unknown>).privatePostOrder;
	if (typeof endpoint !== "function") throw new Error("Binance ccxt adapter does not expose the spot order endpoint");
	const exchangeMarket = exchange.markets[symbol];
	const trailingDelta = trailingPercent * 100;
	if (!Number.isInteger(trailingDelta))
		throw new Error("Binance Spot trailingPercent must convert to a whole number of BIPS");
	if (trailingDelta < 1 || trailingDelta > 10_000)
		throw new Error("Binance Spot trailingPercent must convert to trailingDelta between 1 and 10000 BIPS");
	const filters = Array.isArray((exchangeMarket.info as Record<string, unknown> | undefined)?.filters)
		? ((exchangeMarket.info as Record<string, unknown>).filters as unknown[])
		: [];
	const filter = filters.find((item) => (item as Record<string, unknown>).filterType === "TRAILING_DELTA") as
		| Record<string, unknown>
		| undefined;
	if (!filter) throw new Error(`Binance Spot ${symbol} market has no TRAILING_DELTA filter`);
	// Binance selects the TRAILING_DELTA range from the submitted order
	// type, not from the optional activation price's relation to the market:
	// STOP_LOSS uses the below range and TAKE_PROFIT uses the above range.
	const above = side === "buy";
	const boundary = above ? "Above" : "Below";
	const min = Number(filter[`minTrailing${boundary}Delta`]);
	const max = Number(filter[`maxTrailing${boundary}Delta`]);
	if (!Number.isFinite(min) || !Number.isFinite(max))
		throw new Error(`Binance Spot TRAILING_DELTA filter has invalid ${above ? "above" : "below"} bounds`);
	if (trailingDelta < min || trailingDelta > max)
		throw new Error(
			`Binance Spot trailingDelta ${trailingDelta} is outside ${above ? "above" : "below"} range ${min}-${max}`,
		);
	const params: Record<string, string> = {
		symbol: exchangeMarket.id,
		side: side.toUpperCase(),
		type: side === "sell" ? "STOP_LOSS" : "TAKE_PROFIT",
		quantity: exchange.amountToPrecision(symbol, amount),
		trailingDelta: String(trailingDelta),
		...(clientOrderId ? { newClientOrderId: clientOrderId } : {}),
	};
	if (stopPrice !== undefined) params.stopPrice = exchange.priceToPrecision(symbol, stopPrice);
	return (await (endpoint as (params: Record<string, string>) => Promise<unknown>).call(exchange, params)) as Record<
		string,
		unknown
	>;
}

export function binanceRawOrderToOrder(
	raw: unknown,
	symbol: string,
	side: "buy" | "sell",
	amount: number,
	trailingPercent: number,
	clientOrderId?: string,
): Order {
	const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const filled = Number(r.executedQty) || 0;
	return {
		id: String(r.orderId ?? r.clientOrderId ?? "unknown"),
		clientOrderId: typeof r.clientOrderId === "string" ? r.clientOrderId : clientOrderId,
		symbol,
		side,
		type: "trailing_stop_market",
		stopPrice: Number(r.stopPrice) || undefined,
		trailingPercent,
		positionSide: positionSideFromInfo(r),
		reduceOnly: optionalBoolean(r.reduceOnly),
		closePosition: optionalBoolean(r.closePosition),
		amount,
		filled,
		remaining: Math.max(0, amount - filled),
		cost: Number(r.cummulativeQuoteQty) || 0,
		status: toOrderStatus(r.status),
		timestamp: validTimestamp(Number(r.transactTime ?? Date.now())),
	};
}

export function binanceReportToOrder(
	report: unknown,
	symbol: string,
	side: "buy" | "sell",
	amount: number,
	ocoGroup?: string,
	listStatus?: string,
): Order {
	const r = (report && typeof report === "object" ? report : {}) as Record<string, unknown>;
	const rawType = String(r.type ?? "").toUpperCase();
	const filled = Number(r.executedQty) || 0;
	return {
		id: String(r.orderId ?? r.clientOrderId ?? "unknown"),
		symbol,
		side,
		type: rawType.includes("STOP") ? (rawType.includes("LIMIT") ? "stop" : "stop_market") : "limit",
		price: Number(r.price) || undefined,
		stopPrice: Number(r.stopPrice) || undefined,
		ocoGroup:
			ocoGroup ??
			(r.orderListId !== undefined && String(r.orderListId) !== "-1" ? String(r.orderListId) : undefined),
		orderListId:
			ocoGroup ??
			(r.orderListId !== undefined && String(r.orderListId) !== "-1" ? String(r.orderListId) : undefined),
		listOrderStatus: listStatus,
		amount,
		filled,
		remaining: Math.max(0, amount - filled),
		cost: Number(r.cummulativeQuoteQty) || 0,
		status: toOrderStatus(r.status ?? listStatus),
		timestamp: validTimestamp(Number(r.transactTime ?? Date.now())),
	};
}
