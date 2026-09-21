import { randomBytes } from "node:crypto";
import ccxt, { type Order as CcxtOrder, type Ticker as CcxtTicker, type Exchange } from "ccxt";
import { errorMessage } from "./error-message.ts";
import {
	type Order,
	type OrderFeeObservation,
	type OrderStatus,
	type OrderType,
	SubmissionStatusUnknownError,
	type Ticker,
} from "./types.ts";

export function requireCcxtString(value: string | undefined, label: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is missing`);
	return value;
}

export function requireCcxtMarkets(exchange: Exchange): NonNullable<Exchange["markets"]> {
	if (exchange.markets === undefined) throw new Error("Exchange markets are not loaded");
	return exchange.markets;
}

export function requireCcxtMarket(exchange: Exchange, symbol: string): NonNullable<Exchange["markets"]>[string] {
	const market = requireCcxtMarkets(exchange)[symbol];
	if (!market) throw new Error(`Unknown market: ${symbol}`);
	return market;
}

export function toTicker(t: CcxtTicker): Ticker {
	const timestamp = validTimestamp(t.timestamp);
	return {
		symbol: requireCcxtString(t.symbol, "ticker symbol"),
		last: t.last ?? undefined,
		bid: t.bid ?? undefined,
		ask: t.ask ?? undefined,
		high24h: t.high,
		low24h: t.low,
		changePct24h: t.percentage,
		volume24h: t.baseVolume,
		quoteVolume24h: t.quoteVolume,
		timestamp,
		sourceTimestampKnown: t.timestamp === timestamp,
	};
}

export function optionalBoolean(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (value === "true" || value === "1" || value === 1) return true;
	if (value === "false" || value === "0" || value === 0) return false;
	return undefined;
}

export function toOrderStatus(status: unknown): OrderStatus {
	const normalized = String(status ?? "").toLowerCase();
	if (normalized === "open" || normalized === "new" || normalized === "partially_filled") return "open";
	if (normalized === "closed" || normalized === "filled") return "closed";
	if (normalized === "canceled" || normalized === "cancelled") return "canceled";
	if (normalized === "rejected" || normalized === "reject") return "rejected";
	if (normalized === "expired" || normalized === "expired_in_match") return "expired";
	return "unknown";
}

export function toOrderType(o: CcxtOrder): OrderType {
	const info = (o.info ?? {}) as Record<string, unknown>;
	const normalize = (value: unknown): string =>
		String(value ?? "")
			.toLowerCase()
			.replaceAll("-", "_");
	const unifiedType = normalize(o.type);
	const known = new Set<OrderType>([
		"market",
		"limit",
		"stop",
		"stop_market",
		"take_profit",
		"take_profit_market",
		"trailing_stop_market",
		"oco",
	]);
	if (known.has(unifiedType as OrderType) && unifiedType !== "market" && unifiedType !== "limit") {
		return unifiedType as OrderType;
	}

	// CCXT collapses Binance trigger orders to their execution type (market or
	// limit), while retaining the actual order type only in the raw response.
	const rawTypes = [info.ordType, info.strategyType, info.orderType, info.type].map(normalize).filter(Boolean);
	const types = [...rawTypes, unifiedType];
	const limitExecution =
		unifiedType === "limit" ||
		types.some((type) => type.includes("limit")) ||
		[info.ordPx, info.slOrdPx, info.tpOrdPx].some((value) => {
			const price = Number(value);
			return Number.isFinite(price) && price > 0;
		});
	if (types.some((type) => type.includes("trailing") || type === "move_order_stop")) {
		return "trailing_stop_market";
	}
	if (types.includes("oco")) return "oco";
	if (types.some((type) => type.includes("take_profit"))) {
		return limitExecution ? "take_profit" : "take_profit_market";
	}
	if (types.some((type) => type === "stop" || type.startsWith("stop_") || type.includes("stop_loss"))) {
		return limitExecution ? "stop" : "stop_market";
	}
	if (types.some((type) => type === "conditional" || type === "trigger")) {
		if (o.takeProfitPrice !== undefined && o.stopLossPrice === undefined) {
			return limitExecution ? "take_profit" : "take_profit_market";
		}
		return limitExecution ? "stop" : "stop_market";
	}
	if (known.has(unifiedType as OrderType)) return unifiedType as OrderType;
	return "unknown";
}

export function positionSideFromInfo(info: Record<string, unknown>): Order["positionSide"] {
	const value = String(info.positionSide ?? info.posSide ?? "").toUpperCase();
	if (value === "LONG") return "LONG";
	if (value === "SHORT") return "SHORT";
	if (value === "BOTH" || value === "NET") return "BOTH";
	return undefined;
}

export function validTimestamp(timestamp: number | undefined): number {
	return timestamp !== undefined && Number.isSafeInteger(timestamp) && timestamp > 0 && timestamp <= 8.64e15
		? timestamp
		: Date.now();
}

export function validateBinanceClientOrderId(value: string, label: string): void {
	if (!/^[A-Za-z0-9_-]{1,36}$/.test(value))
		throw new Error(`${label} must contain only letters, numbers, '-' or '_' and be at most 36 characters`);
}

export function generateClientOrderId(): string {
	return `ti-${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`.slice(0, 36);
}

function errorCode(error: unknown): string | undefined {
	if (error !== null && typeof error === "object" && "code" in error) {
		const code = (error as { code?: unknown }).code;
		if (typeof code === "number" || typeof code === "string") return String(code);
	}
	const message = errorMessage(error);
	return message.match(/-\d{3,5}\b/)?.[0];
}

// Single classifier for submission failures. A definite rejection proves the
// order was never accepted: the exchange (or ccxt locally) returned an
// explicit business error before acceptance. Transport failures, unrecognized
// error shapes and replies that imply the order may already exist stay
// uncertain, so callers run the client-order-id recovery lookup instead of
// reporting a rejection. When in doubt, prefer uncertainty.
export function isDefiniteSubmissionRejection(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	// A duplicate-order reply means the exchange already holds this order from
	// an earlier submission; classify it as uncertain so the client-id recovery
	// lookup can return the existing order instead of reporting a rejection.
	if (/duplicate/i.test(error.message) || error instanceof ccxt.DuplicateOrderId) return false;
	if (
		error instanceof ccxt.InsufficientFunds ||
		error instanceof ccxt.InvalidOrder ||
		error instanceof ccxt.AuthenticationError || // PermissionDenied subclasses this
		error instanceof ccxt.BadRequest ||
		error instanceof ccxt.ArgumentsRequired ||
		error instanceof ccxt.OperationRejected ||
		error instanceof ccxt.NotSupported
	) {
		return true;
	}
	// NetworkError, RateLimitExceeded, DDoSProtection, BadResponse, RequestTimeout.
	if (error instanceof ccxt.OperationFailed) return false;
	// An explicit HTTP 400 response rejected the request before acceptance;
	// ccxt usually raises it as BadRequest, but unparsed venues surface the raw
	// status line in the message.
	if (/^HTTP 400\b/.test(error.message)) return true;
	const code = errorCode(error);
	const message = `${error.name} ${error.message}`;
	const text = `${code ?? ""} ${message}`;
	return (
		/-2010\b|-1013\b|-2021\b|-2014\b|-2015\b/.test(text) ||
		/insufficient|not enough balance|balance is insufficient/i.test(text) ||
		/filter failure|order would immediately trigger/i.test(text) ||
		/invalid api[- ]?key|signature for this request is not valid/i.test(text)
	);
}

/** True when the venue may already have accepted the request. Default is yes. */
export function isUncertainSubmission(error: unknown): boolean {
	return !isDefiniteSubmissionRejection(error);
}

export function isOrderNotFound(error: unknown): boolean {
	const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
	return /-2013\b|-2011\b|order not found|unknown order/i.test(message);
}

export function errorDescription(error: unknown): string {
	return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export function submissionStatusUnknownError(
	exchangeId: string,
	symbol: string,
	identifierName: "clientOrderId" | "listClientOrderId",
	identifier: string,
	operation: string,
	submissionError: unknown,
	lookupError: unknown,
): AggregateError {
	return new SubmissionStatusUnknownError(
		[submissionError, lookupError],
		`Submission status unknown [errorCategory=SUBMISSION_STATUS_UNKNOWN] exchange=${exchangeId} symbol=${symbol} ${identifierName}=${identifier}. Submission error: ${errorDescription(submissionError)}. Lookup error: ${errorDescription(lookupError)}. Do not retry; manually verify ${operation} on ${exchangeId}`,
	);
}

export type ExchangeErrorCategory =
	| "INVALID_ORDER"
	| "INSUFFICIENT_FUNDS"
	| "AUTHENTICATION"
	| "RATE_LIMIT"
	| "NETWORK"
	| "ORDER_NOT_FOUND"
	| "EXCHANGE_ERROR";

export function normalizeExchangeError(error: unknown, operation: string): Error {
	const value = error as { code?: unknown; response?: unknown };
	const response =
		value !== null && typeof value === "object" && value.response && typeof value.response === "object"
			? (value.response as { code?: unknown; msg?: unknown; message?: unknown; body?: unknown })
			: undefined;
	const responseBody =
		response?.body && typeof response.body === "object" ? (response.body as Record<string, unknown>) : undefined;
	const message = errorMessage(error);
	const codeValue = value?.code ?? response?.code ?? responseBody?.code;
	const code =
		typeof codeValue === "number" || typeof codeValue === "string"
			? String(codeValue)
			: message.match(/-\d{3,5}\b/)?.[0];
	const text = `${code ?? ""} ${message}`.toLowerCase();
	let category: ExchangeErrorCategory;
	if (error instanceof ccxt.OrderNotFound || /-2013\b|-2011\b|order not found|unknown order/i.test(text)) {
		category = "ORDER_NOT_FOUND";
	} else if (
		error instanceof ccxt.InsufficientFunds ||
		/-2010\b|insufficient|not enough balance|balance is insufficient/i.test(text)
	) {
		category = "INSUFFICIENT_FUNDS";
	} else if (
		error instanceof ccxt.AuthenticationError ||
		/-2015\b|-2014\b|authentication|api[- ]?key|signature/i.test(text)
	) {
		category = "AUTHENTICATION";
	} else if (error instanceof ccxt.RateLimitExceeded || /-1003\b|rate limit|too many requests/i.test(text)) {
		category = "RATE_LIMIT";
	} else if (
		error instanceof ccxt.InvalidOrder ||
		/-1013\b|invalid order|filter failure|precision|quantity|price/i.test(text)
	) {
		category = "INVALID_ORDER";
	} else if (error instanceof ccxt.NetworkError || /network|timeout|connection|fetch failed|\b5\d\d\b/i.test(text)) {
		category = "NETWORK";
	} else {
		category = "EXCHANGE_ERROR";
	}
	return new Error(`${operation} failed [errorCategory=${category}]${code ? ` [code=${code}]` : ""}: ${message}`);
}

export function orderKey(order: { id?: string; symbol?: string }): string {
	return `${requireCcxtString(order.symbol, "order symbol")}:${requireCcxtString(order.id, "order id")}`;
}

export function finiteNumber(value: unknown): number | undefined {
	if (typeof value !== "number" && typeof value !== "string") return undefined;
	if (typeof value === "string" && value.trim() === "") return undefined;
	const number = Number(value);
	return Number.isFinite(number) ? number : undefined;
}

export function finiteFundingRate(value: unknown): number | undefined {
	return finiteNumber(value);
}

export function finiteNonNegative(value: unknown): number | undefined {
	const number = finiteNumber(value);
	return number !== undefined && number >= 0 ? number : undefined;
}

export function finitePositive(value: unknown): number | undefined {
	const number = finiteNumber(value);
	return number !== undefined && number > 0 ? number : undefined;
}

/**
 * Prefer a positive normalized metric, but fall back to raw exchange fields
 * when a parser uses zero as a placeholder (common for trigger orders).
 * A real zero is retained only when no positive source is available.
 */
export function orderMetric(normalized: unknown, rawValues: unknown[]): number {
	const normalizedValue = finiteNonNegative(normalized);
	if (normalizedValue !== undefined && normalizedValue > 0) return normalizedValue;
	for (const raw of rawValues) {
		const value = finiteNonNegative(raw);
		if (value !== undefined && value > 0) return value;
	}
	return normalizedValue ?? rawValues.map(finiteNonNegative).find((value) => value !== undefined) ?? 0;
}

function observedCharges(value: unknown): OrderFeeObservation["charges"] {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
	const fee = value as Record<string, unknown>;
	if (
		typeof fee.currency !== "string" ||
		!/^[A-Z0-9_-]{1,80}$/.test(fee.currency) ||
		typeof fee.cost !== "number" ||
		!Number.isFinite(fee.cost)
	)
		return [];
	return [{ currency: fee.currency, cost: fee.cost }];
}

function feeComponents(value: { fee?: unknown; fees?: unknown }): {
	charges: OrderFeeObservation["charges"];
	complete: boolean;
} {
	// CCXT exposes `fees` at runtime but omits it from the installed Order/Trade interfaces.
	// `fee` aliases an element/aggregate of `fees`; never sum both representations.
	const fees = Array.isArray(value.fees) && value.fees.length > 0 ? value.fees : [value.fee];
	const charges = fees.flatMap(observedCharges);
	return { charges, complete: charges.length === fees.length };
}

function orderFeeObservation(o: CcxtOrder): OrderFeeObservation | undefined {
	const trades = Array.isArray(o.trades) ? o.trades : [];
	let charges: OrderFeeObservation["charges"];
	let complete: boolean;
	if (trades.length > 0) {
		// safeOrder() synthesizes order.fee from whatever trades it received, even a
		// truncated page. Verify quantity coverage and each trade's fee independently.
		charges = [];
		complete = true;
		let filled = 0;
		const ids = new Set<string>();
		for (const trade of trades) {
			if (
				(trade.order !== undefined && trade.order !== o.id) ||
				(trade.symbol !== undefined && trade.symbol !== o.symbol) ||
				(trade.side !== undefined && trade.side !== o.side) ||
				(trade.id !== undefined && ids.has(trade.id))
			)
				return undefined;
			if (trade.id !== undefined) ids.add(trade.id);
			const fee = feeComponents(trade);
			charges.push(...fee.charges);
			if (typeof trade.amount !== "number" || !Number.isFinite(trade.amount) || trade.amount <= 0) complete = false;
			else filled += trade.amount;
			complete &&= fee.complete;
		}
		const filledQty = o.filled;
		complete &&=
			filledQty !== undefined &&
			Number.isFinite(filledQty) &&
			filledQty > 0 &&
			Number.isFinite(filled) &&
			Math.abs(filled - filledQty) <= Math.max(Number.MIN_VALUE, Math.abs(filledQty) * 1e-8);
	} else {
		const fee = feeComponents(o);
		charges = fee.charges;
		complete = fee.complete;
	}
	if (charges.length === 0) return undefined;
	// Bounded currency totals preserve original denominations without retaining raw trade responses.
	const totals = new Map<string, number>();
	for (const charge of charges) totals.set(charge.currency, (totals.get(charge.currency) ?? 0) + charge.cost);
	if (totals.size > 32 || [...totals.values()].some((cost) => !Number.isFinite(cost))) return undefined;
	return {
		source: "exchange",
		completeness: complete ? "complete" : "partial",
		charges: [...totals].map(([currency, cost]) => ({ currency, cost })),
	};
}

export function toOrder(o: CcxtOrder, contractSize: number, contractMarket: boolean): Order {
	const info = (o.info ?? {}) as Record<string, unknown>;
	const trailingDelta = finitePositive(info.trailingDelta);
	const callbackRatio = finitePositive(info.callbackRatio);
	const callbackRate =
		finitePositive(info.callbackRate) ??
		finitePositive(info.priceRate) ??
		(callbackRatio !== undefined ? finitePositive(callbackRatio * 100) : undefined);
	const trailingPercent =
		callbackRate ??
		finitePositive(info.trailingPercent) ??
		(trailingDelta !== undefined ? trailingDelta / 100 : undefined);
	const type = toOrderType(o);
	const rawGroup = info.orderListId ?? (type === "oco" ? (info.algoId ?? info.algoClOrdId) : undefined);
	if (!Number.isFinite(contractSize) || contractSize <= 0) {
		throw new Error(`Invalid contractSize ${contractSize} while mapping order ${o.id}`);
	}
	// CCXT's normalized amount for contract markets is already a number of
	// contracts. Binance Spot's raw order parser can leave `amount` at zero,
	// while the original quantity is still available in `info.origQty`.
	// Select the source according to the market family so a futures raw
	// quantity is never multiplied by contractSize twice.
	const originalAmount = contractMarket
		? orderMetric(o.amount, [info.contracts, info.amount, info.origQty, info.quantity])
		: orderMetric(info.origQty ?? info.quantity, [o.amount]);
	const filled = orderMetric(o.filled, [info.executedQty, info.filled]);
	const remaining = orderMetric(o.remaining, [info.remainingQty, info.remaining]);
	const normalizedRemaining =
		finiteNonNegative(o.remaining) === undefined &&
		finiteNonNegative(info.remainingQty ?? info.remaining) === undefined
			? Math.max(0, originalAmount - filled)
			: remaining;
	const scale = contractMarket ? contractSize : 1;
	const filledBase = filled * scale;
	const averageHint = finitePositive(o.average) ?? finitePositive(info.avgPrice) ?? finitePositive(info.averagePrice);
	const derivedCost = averageHint !== undefined && filledBase > 0 ? filledBase * averageHint : undefined;
	const cost = orderMetric(o.cost, [info.cumQuote, info.cummulativeQuoteQty, info.cumulativeQuoteQty, derivedCost]);
	const average = averageHint ?? (cost > 0 && filledBase > 0 ? cost / filledBase : undefined);
	const clientOrderId = [o.clientOrderId, info.clientOrderId, info.clientAlgoId, info.clOrdId, info.algoClOrdId].find(
		(value): value is string => typeof value === "string" && value.length > 0,
	);
	return {
		id: requireCcxtString(o.id, "order id"),
		clientOrderId,
		listClientOrderId: typeof info.listClientOrderId === "string" ? info.listClientOrderId : undefined,
		symbol: requireCcxtString(o.symbol, "order symbol"),
		side: o.side as Order["side"],
		type,
		price: finitePositive(o.price),
		stopPrice:
			finitePositive(o.triggerPrice) ??
			finitePositive(o.stopPrice) ??
			finitePositive(o.stopLossPrice) ??
			finitePositive(o.takeProfitPrice),
		trailingPercent,
		activationPrice:
			finitePositive(info.activatePrice) ?? finitePositive(info.activationPrice) ?? finitePositive(info.activePx),
		callbackRate,
		ocoGroup: rawGroup !== undefined && String(rawGroup) !== "-1" ? String(rawGroup) : undefined,
		orderListId: rawGroup !== undefined && String(rawGroup) !== "-1" ? String(rawGroup) : undefined,
		listOrderStatus: typeof info.listOrderStatus === "string" ? info.listOrderStatus : undefined,
		positionSide: positionSideFromInfo(info),
		reduceOnly: o.reduceOnly ?? optionalBoolean(info.reduceOnly),
		closePosition: optionalBoolean(info.closePosition),
		amount: originalAmount * scale,
		filled: filledBase,
		remaining: normalizedRemaining * scale,
		average,
		cost,
		feeObservation: orderFeeObservation(o),
		status: toOrderStatus(o.status ?? info.status ?? info.state),
		timestamp: validTimestamp(o.timestamp),
	};
}
