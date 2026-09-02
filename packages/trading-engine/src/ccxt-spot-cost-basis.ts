import type { Trade as CcxtTrade, Exchange } from "ccxt";
import type { Position } from "./types.ts";

export async function getSpotCostBasis(
	exchange: Exchange,
	symbol: string,
	balance: number,
	quoteCurrency: string,
): Promise<
	Pick<Position, "avgEntryPrice" | "unrealizedPnl" | "unrealizedPnlPct" | "costBasisStatus" | "costBasisReason">
> {
	if (!exchange.has.fetchMyTrades || typeof exchange.fetchMyTrades !== "function")
		return { costBasisStatus: "unavailable", costBasisReason: "fetchMyTrades is unsupported" };
	let trades: CcxtTrade[];
	try {
		// A bounded request is deliberate: an unbounded account-history query can
		// stall position polling and still cannot prove coverage of transfers.
		trades = await exchange.fetchMyTrades(symbol, undefined, 1000);
	} catch {
		return { costBasisStatus: "unavailable", costBasisReason: "fetchMyTrades failed or is not permitted" };
	}
	if (!Number.isFinite(balance) || balance <= 0) {
		return { costBasisStatus: "unavailable", costBasisReason: "Balance is not a finite positive value" };
	}
	const seen = new Set<string>();
	const ordered = trades
		.filter((trade) => trade.side === "buy" || trade.side === "sell")
		.filter((trade) => {
			const fallback = `${trade.order ?? ""}:${trade.timestamp ?? 0}:${trade.price ?? 0}:${trade.amount}`;
			const key = trade.id || fallback;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
	let quantity = 0;
	let cost = 0;
	let incomplete = false;
	const baseAsset = symbol.split("/")[0];
	const tolerance = Math.max(1e-8, Math.abs(balance) * 1e-6);
	const saleTolerance = Math.max(1e-10, balance * 1e-8);
	if (!Number.isFinite(tolerance) || !Number.isFinite(saleTolerance)) {
		return { costBasisStatus: "partial", costBasisReason: "Cost basis reconciliation tolerance overflowed" };
	}
	for (const trade of ordered) {
		const amount = Number(trade.amount);
		const price = Number(trade.price);
		if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(price) || price < 0) {
			incomplete = true;
			continue;
		}
		const notional = Number(trade.cost ?? amount * price);
		if (!Number.isFinite(notional) || notional < 0) {
			incomplete = true;
			continue;
		}
		const fee = trade.fee;
		const feeCost = fee ? Number(fee.cost) : NaN;
		const feeCurrency = fee?.currency?.toUpperCase();
		if (
			!fee ||
			!Number.isFinite(feeCost) ||
			feeCost < 0 ||
			(feeCurrency !== quoteCurrency && feeCurrency !== symbol.split("/")[0])
		)
			incomplete = true;
		let nextQuantity: number;
		let nextCost: number;
		if (trade.side === "buy") {
			nextQuantity = quantity + amount;
			nextCost = cost + notional;
			if (feeCurrency === quoteCurrency && Number.isFinite(feeCost)) nextCost += feeCost;
			if (feeCurrency === baseAsset && Number.isFinite(feeCost)) nextQuantity -= feeCost;
		} else {
			const inventoryBeforeSale = quantity;
			if (amount > inventoryBeforeSale + saleTolerance) {
				incomplete = true;
				continue;
			}
			const ratio = inventoryBeforeSale > 0 ? amount / inventoryBeforeSale : 0;
			const removedCost = inventoryBeforeSale > 0 ? cost * ratio : 0;
			nextQuantity = quantity - amount;
			if (feeCurrency === baseAsset && Number.isFinite(feeCost)) nextQuantity -= feeCost;
			nextCost = cost - removedCost;
		}
		if (!Number.isFinite(nextQuantity) || !Number.isFinite(nextCost)) {
			return { costBasisStatus: "partial", costBasisReason: "Cost basis arithmetic overflowed" };
		}
		quantity = nextQuantity;
		cost = nextCost;
	}
	if (Math.abs(quantity - balance) > tolerance) incomplete = true;
	if (!Number.isFinite(quantity) || !Number.isFinite(cost) || incomplete || quantity <= tolerance || cost <= 0)
		return {
			costBasisStatus: incomplete ? "partial" : "unavailable",
			costBasisReason: incomplete ? "Trade history or fees do not reconcile balance" : "No cost basis available",
		};
	const avgEntryPrice = cost / quantity;
	if (!Number.isFinite(avgEntryPrice) || avgEntryPrice <= 0) {
		return { costBasisStatus: "partial", costBasisReason: "Average entry price is not finite" };
	}
	let last: number | undefined;
	try {
		const tickerLast = (await exchange.fetchTicker(symbol)).last;
		if (tickerLast !== undefined && Number.isFinite(tickerLast) && tickerLast > 0) last = tickerLast;
	} catch {
		// Cost basis remains useful even when the latest public mark is unavailable.
	}
	const unrealizedPnl = last === undefined ? undefined : (last - avgEntryPrice) * balance;
	const unrealizedPnlPct = unrealizedPnl === undefined ? undefined : (unrealizedPnl / cost) * 100;
	if (
		(unrealizedPnl !== undefined && !Number.isFinite(unrealizedPnl)) ||
		(unrealizedPnlPct !== undefined && !Number.isFinite(unrealizedPnlPct))
	) {
		return { costBasisStatus: "partial", costBasisReason: "Unrealized PnL arithmetic overflowed" };
	}
	return {
		avgEntryPrice,
		unrealizedPnl,
		unrealizedPnlPct,
		costBasisStatus: "complete",
	};
}
