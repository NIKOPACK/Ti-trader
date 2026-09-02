import type { Exchange } from "ccxt";
import type { PaperOrder } from "./paper-account.ts";
import type { Kline, Order, OrderType } from "./types.ts";

export function baseAsset(symbol: string, quote: string): string {
	const suffix = `/${quote}`;
	if (!symbol.endsWith(suffix)) {
		throw new Error(`Symbol "${symbol}" is not a ${quote} market`);
	}
	return symbol.slice(0, -suffix.length);
}

const TRIGGER_TYPES = ["stop", "stop_market", "take_profit", "take_profit_market"] as const;
type TriggerType = (typeof TRIGGER_TYPES)[number];

export function isTriggerType(type: OrderType): type is TriggerType {
	return (TRIGGER_TYPES as readonly string[]).includes(type);
}

/**
 * Whether a stop/take-profit trigger fires at the given price.
 * stop: fires when the price moves against the position (sell: fall to trigger,
 * buy: rise to trigger). take_profit: fires when the price moves favourably
 * (sell: rise to trigger, buy: fall to trigger).
 */
export function triggerFires(type: TriggerType, side: "buy" | "sell", price: number, stopPrice: number): boolean {
	const fallTo = type.startsWith("stop") ? side === "sell" : side === "buy";
	return fallTo ? price <= stopPrice : price >= stopPrice;
}

/** Current stop level of a trailing stop given its extreme price. */
export function trailingStopLevel(side: "buy" | "sell", extreme: number, trailingPercent: number): number {
	return side === "sell" ? extreme * (1 - trailingPercent / 100) : extreme * (1 + trailingPercent / 100);
}

/**
 * A price-range segment of the market path since an order was last checked:
 * one kline (high/low) or the final ticker reading (a single point).
 */
export interface PathSegment {
	high: number;
	low: number;
	/** True for the final single-price ticker segment. */
	tick?: boolean;
}

export interface MarketPath {
	segments: PathSegment[];
	/** Latest timestamp through which the returned path is known to cover. */
	checkedAt: number;
}

/** Where along a path an order fired, and the price it fills at. */
export interface PathFire {
	index: number;
	price: number;
}

export type PriceLookup = { price: number } | { reason: string };

export function isFinitePositive(value: number | undefined): value is number {
	return value !== undefined && Number.isFinite(value) && value > 0;
}

/**
 * Build the market path since the order was last checked: gap klines
 * (when the gap exceeds two minutes) followed by the current ticker price.
 */
export async function buildMarketPath(
	exchange: Pick<Exchange, "fetchOHLCV">,
	order: PaperOrder,
	last: number,
	now: number,
	minSince: Map<string, number>,
	candleCache: Map<string, Kline[]>,
): Promise<MarketPath> {
	const since = order.lastCheckedAt ?? order.timestamp;
	const path: PathSegment[] = [];
	let checkedAt = now;
	if ((now - since) / 60_000 > 2) {
		const fetchSince = minSince.get(order.symbol) ?? since;
		const gapMinutes = (now - fetchSince) / 60_000;
		const timeframe = gapMinutes <= 400 ? "1m" : gapMinutes <= 6000 ? "15m" : "1h";
		const minutesPerCandle = timeframe === "1m" ? 1 : timeframe === "15m" ? 15 : 60;
		const candleDurationMs = minutesPerCandle * 60_000;
		checkedAt = since;
		let candles = candleCache.get(order.symbol);
		if (!candles) {
			const limit = Math.min(Math.ceil(gapMinutes / minutesPerCandle) + 2, 500);
			const ohlcv = await exchange.fetchOHLCV(order.symbol, timeframe, fetchSince, limit);
			candles = ohlcv.map((k) => ({
				timestamp: k[0] ?? 0,
				open: k[1] ?? 0,
				high: k[2] ?? 0,
				low: k[3] ?? 0,
				close: k[4] ?? 0,
				volume: k[5] ?? 0,
			}));
			candleCache.set(order.symbol, candles);
		}
		const validCandles = candles
			.filter(
				(k) =>
					Number.isFinite(k.timestamp) &&
					k.timestamp >= since &&
					k.timestamp <= now &&
					Number.isFinite(k.high) &&
					Number.isFinite(k.low) &&
					k.high > 0 &&
					k.low > 0,
			)
			.sort((a, b) => a.timestamp - b.timestamp);
		let previousTimestamp: number | undefined;
		for (const k of validCandles) {
			// The first exchange candle may begin up to one timeframe after an
			// arbitrary order timestamp. Once a candle is accepted, every later
			// candle must start no later than the end of the preceding one. A
			// sparse response therefore contributes only its continuous prefix;
			// candles after a gap are retried on a later read instead of being
			// evaluated out of chronological order.
			const latestAllowedStart =
				previousTimestamp === undefined ? since + candleDurationMs : previousTimestamp + candleDurationMs;
			if (k.timestamp > latestAllowedStart) break;
			if (previousTimestamp === k.timestamp) continue;
			path.push({ high: k.high, low: k.low });
			previousTimestamp = k.timestamp;
			checkedAt = Math.min(now, k.timestamp + candleDurationMs);
		}
		checkedAt = Math.max(since, checkedAt);
	}
	path.push({ high: last, low: last, tick: true });
	return { segments: path, checkedAt };
}

export function advanceCheckedAt(order: PaperOrder, checkedAt: number): void {
	const current = order.lastCheckedAt ?? order.timestamp;
	if (Number.isFinite(checkedAt) && checkedAt > current) order.lastCheckedAt = checkedAt;
}

/**
 * Walk an order along the market path and return where it fills.
 * Mutates trigger/trailing state (`triggered`, `trailingExtreme`) so
 * partial progress survives even when the order does not fill.
 */
export function evaluatePath(order: PaperOrder, path: PathSegment[]): PathFire | undefined {
	for (let index = 0; index < path.length; index++) {
		const seg = path[index];

		if (order.type === "trailing_stop_market") {
			const percent = order.trailingPercent;
			if (percent === undefined) return undefined;
			const extreme = order.trailingExtreme ?? seg.low;
			// Check against the extreme from previous segments first: a
			// candle's own high must not tighten the stop for its own low.
			const level = trailingStopLevel(order.side, extreme, percent);
			if ((order.side === "sell" && seg.low <= level) || (order.side === "buy" && seg.high >= level)) {
				return { index, price: level };
			}
			order.trailingExtreme = order.side === "sell" ? Math.max(extreme, seg.high) : Math.min(extreme, seg.low);
			continue;
		}

		if (isTriggerType(order.type) && !order.triggered && order.stopPrice !== undefined) {
			const fallTo = order.type.startsWith("stop") ? order.side === "sell" : order.side === "buy";
			const fires = fallTo ? seg.low <= order.stopPrice : seg.high >= order.stopPrice;
			if (!fires) continue;
			if (order.type === "stop_market" || order.type === "take_profit_market") {
				return { index, price: order.stopPrice };
			}
			// stop / take_profit: rest as a limit order. Within one candle the
			// trigger-then-cross sequence is ambiguous, so the limit check
			// starts at the next segment; a tick is a single price and may
			// satisfy both at once.
			order.triggered = true;
			if (!seg.tick) continue;
		}

		if (order.price === undefined) continue;
		if (isTriggerType(order.type) && !order.triggered) continue;
		const crossed = order.side === "buy" ? seg.low <= order.price : seg.high >= order.price;
		if (crossed) return { index, price: order.price };
	}
	return undefined;
}

export function toOrder(o: PaperOrder): Order {
	return {
		id: o.id,
		clientOrderId: o.clientOrderId,
		listClientOrderId: o.listClientOrderId,
		symbol: o.symbol,
		side: o.side,
		type: o.type,
		price: o.price,
		stopPrice: o.stopPrice,
		trailingPercent: o.trailingPercent,
		ocoGroup: o.ocoGroup,
		orderListId: o.ocoGroup,
		listOrderStatus: o.ocoGroup ? (o.status === "open" ? "EXECUTING" : "ALL_DONE") : undefined,
		positionSide: o.positionSide,
		reduceOnly: o.reduceOnly,
		closePosition: o.closePosition,
		amount: o.amount,
		filled: o.filled,
		remaining: o.amount - o.filled,
		average: o.average,
		cost: o.cost,
		status: o.status,
		timestamp: o.timestamp,
	};
}
