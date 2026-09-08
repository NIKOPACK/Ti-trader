import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { Balance, Order, Position } from "@nikopack/ti-trading-engine";
import type { TradingRuntime } from "../context.ts";

export type TradingProvider = () => TradingRuntime;

export function jsonResult(data: unknown): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
		details: data,
	};
}

/** Exchange adapters mark a failed request as ambiguous when it may have reached the venue. */
export const SUBMISSION_STATUS_UNKNOWN_MARKER = "[errorCategory=SUBMISSION_STATUS_UNKNOWN]";

/**
 * Walk AggregateError trees without getting stuck on a malformed cyclic error.
 * Adapters use AggregateError to retain both a submission failure and a lookup
 * or settlement failure, so checking only the outer message loses the marker
 * when the errors are nested.
 */
export function findNestedError<T>(error: unknown, match: (candidate: unknown) => T | undefined): T | undefined {
	const visited = new WeakSet<object>();
	const visit = (candidate: unknown): T | undefined => {
		const found = match(candidate);
		if (found !== undefined) return found;
		if (candidate === null || (typeof candidate !== "object" && typeof candidate !== "function")) return undefined;
		if (visited.has(candidate)) return undefined;
		visited.add(candidate);
		if (candidate instanceof AggregateError) {
			for (const nested of candidate.errors) {
				const nestedFound = visit(nested);
				if (nestedFound !== undefined) return nestedFound;
			}
		}
		if (typeof candidate === "object" && candidate !== null && "cause" in candidate) {
			const nestedFound = visit((candidate as { cause?: unknown }).cause);
			if (nestedFound !== undefined) return nestedFound;
		}
		return undefined;
	};
	return visit(error);
}

export function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	if (error !== null && typeof error === "object") {
		const message = (error as { message?: unknown }).message;
		if (typeof message === "string") return message;
	}
	return String(error);
}

/** Exchange adapters mark a failed request as ambiguous when it may have reached the venue. */
export function isSubmissionStatusUnknown(error: unknown): boolean {
	return (
		findNestedError(error, (candidate) =>
			errorMessage(candidate).includes(SUBMISSION_STATUS_UNKNOWN_MARKER) ? true : undefined,
		) ?? false
	);
}

export function round(n: number | undefined, decimals = 8): number | undefined {
	if (n === undefined || !Number.isFinite(n)) return undefined;
	const f = 10 ** decimals;
	return Math.round(n * f) / f;
}

/** Contract-stat metrics are serialized as a finite number or an explicit JSON null. */
export function finiteOrNull(value: number | undefined): number | null {
	return value !== undefined && Number.isFinite(value) ? value : null;
}

/** Treat undefined, NaN and infinities the same: the metric is not available. */
export function isUnavailableMetric(value: number | undefined): boolean {
	return value === undefined || !Number.isFinite(value);
}

export function hasFiniteQuoteValue<T extends { quoteValue?: number }>(item: T): item is T & { quoteValue: number } {
	return item.quoteValue !== undefined && Number.isFinite(item.quoteValue);
}

export function formatBalance(balance: Balance) {
	return {
		asset: balance.asset,
		free: round(balance.free),
		used: round(balance.used),
		total: round(balance.total),
		quoteValue: round(balance.quoteValue, 2) ?? null,
	};
}

export function formatPosition(position: Position) {
	const valued = hasFiniteQuoteValue(position);
	const valuationStatus = position.valuationStatus ?? (valued ? "complete" : "unavailable");
	return {
		symbol: position.symbol,
		asset: position.asset,
		amount: position.amount,
		quoteValue: valued ? round(position.quoteValue, 2) : null,
		positionSide: position.positionSide,
		leverage: position.leverage,
		marginType: position.marginType,
		markPrice: round(position.markPrice, 8) ?? null,
		liquidationPrice: round(position.liquidationPrice, 8) ?? null,
		margin: round(position.margin, 2) ?? null,
		costBasisStatus: position.costBasisStatus,
		costBasisReason: position.costBasisReason,
		avgEntryPrice: round(position.avgEntryPrice, 8) ?? null,
		unrealizedPnl: round(position.unrealizedPnl, 2) ?? null,
		unrealizedPnlPct: round(position.unrealizedPnlPct, 2) ?? null,
		valuationStatus,
		valuationReason:
			valuationStatus === "unavailable"
				? (position.valuationReason ?? "Quote valuation is unavailable")
				: (position.valuationReason ?? null),
	};
}

export function observedOrderNotional(order: Order): number | undefined {
	if (Number.isFinite(order.cost) && order.cost > 0) return order.cost;
	const referencePrice = order.price ?? order.stopPrice;
	if (referencePrice === undefined || !Number.isFinite(referencePrice) || referencePrice <= 0) return undefined;
	const notional = order.amount * referencePrice;
	return Number.isFinite(notional) && notional > 0 ? notional : undefined;
}

/**
 * OCO legs share one reservation. Treat a group as one exposure and use the
 * largest leg estimate, which is the conservative quote-side reservation.
 */
export function distinctOrderNotionals(orders: Order[]): { values: number[]; unknownGroups: number } {
	const grouped = new Map<string, number | undefined>();
	for (const order of orders) {
		const key = order.ocoGroup ?? order.orderListId ?? `order:${order.id}`;
		const value = observedOrderNotional(order);
		const previous = grouped.get(key);
		if (!grouped.has(key) || (value !== undefined && (previous === undefined || value > previous))) {
			grouped.set(key, value);
		}
	}
	const values: number[] = [];
	let unknownGroups = 0;
	for (const value of grouped.values()) {
		if (value === undefined) unknownGroups++;
		else values.push(value);
	}
	return { values, unknownGroups };
}

export function isProtectiveOrder(order: Order): boolean {
	return order.type === "oco" || order.type.includes("stop") || order.type.includes("take_profit");
}

export function formatOrder(
	o: {
		id: string;
		symbol: string;
		side: string;
		type: string;
		price?: number;
		stopPrice?: number;
		trailingPercent?: number;
		ocoGroup?: string;
		orderListId?: string;
		listOrderStatus?: string;
		clientOrderId?: string;
		listClientOrderId?: string;
		positionSide?: "BOTH" | "LONG" | "SHORT";
		reduceOnly?: boolean;
		closePosition?: boolean;
		amount: number;
		filled: number;
		remaining: number;
		average?: number;
		cost: number;
		status: string;
		timestamp: number;
	},
	options: {
		requestedAmount?: number;
		amountSource?: string;
		exchangeQuantitySemantics?: string;
		amountSemantics?: string;
	} = {},
) {
	const closePosition = o.closePosition === true || options.requestedAmount !== undefined;
	return {
		id: o.id,
		symbol: o.symbol,
		side: o.side,
		type: o.type,
		price: o.price,
		stopPrice: o.stopPrice,
		trailingPercent: o.trailingPercent,
		ocoGroup: o.ocoGroup,
		orderListId: o.orderListId,
		listOrderStatus: o.listOrderStatus,
		clientOrderId: o.clientOrderId,
		listClientOrderId: o.listClientOrderId,
		positionSide: o.positionSide,
		reduceOnly: o.reduceOnly,
		closePosition: closePosition ? true : o.closePosition,
		amount: o.amount,
		requestedAmount: closePosition ? (options.requestedAmount ?? null) : undefined,
		amountSemantics: closePosition
			? (options.amountSemantics ?? "close_entire_matching_position")
			: "base_currency_amount",
		exchangeQuantitySemantics: closePosition ? options.exchangeQuantitySemantics : undefined,
		amountSource:
			options.amountSource ??
			(closePosition && o.amount === 0
				? "exchange_omitted_quantity_for_close_all"
				: closePosition
					? "exchange_quantity_for_market_close"
					: "exchange_order_amount"),
		filled: o.filled,
		remaining: o.remaining,
		average:
			o.filled > 0 && !(o.average !== undefined && Number.isFinite(o.average) && o.average > 0) ? null : o.average,
		cost: o.filled > 0 && !(Number.isFinite(o.cost) && o.cost > 0) ? null : round(o.cost, 2),
		status: o.status,
		time: new Date(o.timestamp).toISOString(),
	};
}
