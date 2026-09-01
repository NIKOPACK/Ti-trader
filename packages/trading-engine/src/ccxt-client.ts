import { randomBytes } from "node:crypto";
import ccxt, { type Order as CcxtOrder, type Ticker as CcxtTicker, type Trade as CcxtTrade, type Exchange } from "ccxt";
import { validateBinanceSpotFilters } from "./binance-spot-filters.ts";
import type { ExchangeCredentials, FuturesMarginType, FuturesPositionMode, MarketType } from "./client-types.ts";
import {
	type Balance,
	type ContractStats,
	type ExchangeClient,
	type FundingRateRecord,
	type Kline,
	type MarketInfo,
	type Order,
	type OrderBook,
	type OrderList,
	type OrderStatus,
	type OrderType,
	type PlaceOcoOrderInput,
	type PlaceOcoOrderResult,
	type PlaceOrderInput,
	type PlaceOrderResult,
	type Position,
	type Ticker,
	timeframeDurationMs,
} from "./types.ts";

function toTicker(t: CcxtTicker): Ticker {
	return {
		symbol: t.symbol,
		last: t.last ?? undefined,
		bid: t.bid ?? undefined,
		ask: t.ask ?? undefined,
		high24h: t.high,
		low24h: t.low,
		changePct24h: t.percentage,
		volume24h: t.baseVolume,
		quoteVolume24h: t.quoteVolume,
		timestamp: validTimestamp(t.timestamp),
	};
}

function optionalBoolean(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (value === "true" || value === "1" || value === 1) return true;
	if (value === "false" || value === "0" || value === 0) return false;
	return undefined;
}

function toOrderStatus(status: unknown): OrderStatus {
	const normalized = String(status ?? "").toLowerCase();
	if (normalized === "open" || normalized === "new" || normalized === "partially_filled") return "open";
	if (normalized === "closed" || normalized === "filled") return "closed";
	if (normalized === "canceled" || normalized === "cancelled") return "canceled";
	if (normalized === "rejected" || normalized === "reject") return "rejected";
	if (normalized === "expired" || normalized === "expired_in_match") return "expired";
	return "unknown";
}

function toOrderType(o: CcxtOrder): OrderType {
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

function positionSideFromInfo(info: Record<string, unknown>): Order["positionSide"] {
	const value = String(info.positionSide ?? info.posSide ?? "").toUpperCase();
	if (value === "LONG") return "LONG";
	if (value === "SHORT") return "SHORT";
	if (value === "BOTH" || value === "NET") return "BOTH";
	return undefined;
}

function validTimestamp(timestamp: number | undefined): number {
	return timestamp !== undefined && Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : Date.now();
}

function generateClientOrderId(): string {
	return `ti-${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`.slice(0, 36);
}

function isUncertainSubmission(error: unknown): boolean {
	const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
	return /timeout|network|5\d\d|temporarily unavailable|connection reset|fetch failed/i.test(message);
}

function isOrderNotFound(error: unknown): boolean {
	const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
	return /-2013\b|-2011\b|order not found|unknown order/i.test(message);
}

function errorDescription(error: unknown): string {
	return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function submissionStatusUnknownError(
	exchangeId: string,
	symbol: string,
	identifierName: "clientOrderId" | "listClientOrderId",
	identifier: string,
	operation: string,
	submissionError: unknown,
	lookupError: unknown,
): AggregateError {
	return new AggregateError(
		[submissionError, lookupError],
		`Submission status unknown [errorCategory=SUBMISSION_STATUS_UNKNOWN] exchange=${exchangeId} symbol=${symbol} ${identifierName}=${identifier}. Submission error: ${errorDescription(submissionError)}. Lookup error: ${errorDescription(lookupError)}. Do not retry; manually verify ${operation} on ${exchangeId}`,
	);
}

type ExchangeErrorCategory =
	| "INVALID_ORDER"
	| "INSUFFICIENT_FUNDS"
	| "AUTHENTICATION"
	| "RATE_LIMIT"
	| "NETWORK"
	| "ORDER_NOT_FOUND"
	| "EXCHANGE_ERROR";

function normalizeExchangeError(error: unknown, operation: string): Error {
	const value = error as { code?: unknown; response?: unknown };
	const response =
		value !== null && typeof value === "object" && value.response && typeof value.response === "object"
			? (value.response as { code?: unknown; msg?: unknown; message?: unknown; body?: unknown })
			: undefined;
	const responseBody =
		response?.body && typeof response.body === "object" ? (response.body as Record<string, unknown>) : undefined;
	const message = error instanceof Error ? error.message : String(error);
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

function orderKey(order: { id: string; symbol: string }): string {
	return `${order.symbol}:${order.id}`;
}

function finiteNumber(value: unknown): number | undefined {
	if (typeof value !== "number" && typeof value !== "string") return undefined;
	if (typeof value === "string" && value.trim() === "") return undefined;
	const number = Number(value);
	return Number.isFinite(number) ? number : undefined;
}

function finiteFundingRate(value: unknown): number | undefined {
	return finiteNumber(value);
}

function finiteNonNegative(value: unknown): number | undefined {
	const number = finiteNumber(value);
	return number !== undefined && number >= 0 ? number : undefined;
}

function finitePositive(value: unknown): number | undefined {
	const number = finiteNumber(value);
	return number !== undefined && number > 0 ? number : undefined;
}

/**
 * Prefer a positive normalized metric, but fall back to raw exchange fields
 * when a parser uses zero as a placeholder (common for trigger orders).
 * A real zero is retained only when no positive source is available.
 */
function orderMetric(normalized: unknown, rawValues: unknown[]): number {
	const normalizedValue = finiteNonNegative(normalized);
	if (normalizedValue !== undefined && normalizedValue > 0) return normalizedValue;
	for (const raw of rawValues) {
		const value = finiteNonNegative(raw);
		if (value !== undefined && value > 0) return value;
	}
	return normalizedValue ?? rawValues.map(finiteNonNegative).find((value) => value !== undefined) ?? 0;
}

function toOrder(o: CcxtOrder, contractSize: number, contractMarket: boolean): Order {
	const info = (o.info ?? {}) as Record<string, unknown>;
	const trailingDelta = Number(info.trailingDelta);
	const callbackRate = Number(info.callbackRate ?? info.trailingPercent);
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
	const clientOrderId = [o.clientOrderId, info.clientOrderId, info.clientAlgoId, info.clOrdId, info.algoClOrdId].find(
		(value): value is string => typeof value === "string" && value.length > 0,
	);
	return {
		id: o.id,
		clientOrderId,
		listClientOrderId: typeof info.listClientOrderId === "string" ? info.listClientOrderId : undefined,
		symbol: o.symbol,
		side: o.side as Order["side"],
		type,
		price: o.price,
		stopPrice: o.triggerPrice ?? o.stopPrice ?? o.stopLossPrice ?? o.takeProfitPrice,
		trailingPercent: Number.isFinite(callbackRate)
			? callbackRate
			: Number.isFinite(trailingDelta)
				? trailingDelta / 100
				: undefined,
		ocoGroup: rawGroup !== undefined && String(rawGroup) !== "-1" ? String(rawGroup) : undefined,
		orderListId: rawGroup !== undefined && String(rawGroup) !== "-1" ? String(rawGroup) : undefined,
		listOrderStatus: typeof info.listOrderStatus === "string" ? info.listOrderStatus : undefined,
		positionSide: positionSideFromInfo(info),
		reduceOnly: o.reduceOnly ?? optionalBoolean(info.reduceOnly),
		closePosition: optionalBoolean(info.closePosition),
		amount: originalAmount * scale,
		filled: filled * scale,
		remaining: normalizedRemaining * scale,
		average: o.average,
		cost: o.cost ?? 0,
		status: toOrderStatus(o.status ?? info.status ?? info.state),
		timestamp: validTimestamp(o.timestamp),
	};
}

/** Live trading client backed by a ccxt exchange instance with API credentials. */
export class CcxtExchangeClient implements ExchangeClient {
	readonly mode = "live" as const;
	readonly id: string;
	readonly quoteCurrency: string;
	private readonly marketType: MarketType;
	private readonly defaultLeverage: number;
	private readonly defaultMarginType: FuturesMarginType;
	private readonly positionMode: FuturesPositionMode;

	private readonly exchange: Exchange;
	private marketsLoaded = false;
	private positionModeConfigured = false;
	private readonly configuredFuturesSymbols = new Set<string>();
	private readonly leverageBySymbol = new Map<string, number>();
	private readonly marginTypeBySymbol = new Map<string, FuturesMarginType>();
	private readonly knownSymbols = new Set<string>();
	private readonly knownOrderListIds = new Set<string>();

	private contractSizeForMarket(
		market: { contract?: boolean; linear?: boolean; inverse?: boolean; contractSize?: number } | undefined,
	): number {
		if (!market) throw new Error("Exchange market metadata is unavailable; refusing to guess the amount unit");
		if (!market.contract) return 1;
		if (market.linear !== true || market.inverse === true) {
			throw new Error("Only linear USDⓈ-M contracts are supported; inverse or unidentified contracts are rejected");
		}
		const contractSize = market.contractSize;
		if (contractSize === undefined || !Number.isFinite(contractSize) || contractSize <= 0) {
			throw new Error("Futures market contractSize is unavailable; refusing to guess the amount unit");
		}
		return contractSize;
	}

	private contractSizeForSymbol(symbol: string): number {
		if (!this.marketsLoaded) throw new Error("Exchange markets are not loaded; cannot resolve contractSize");
		return this.contractSizeForMarket(
			this.exchange.markets[symbol] as {
				contract?: boolean;
				linear?: boolean;
				inverse?: boolean;
				contractSize?: number;
			},
		);
	}

	private toDomainOrder(order: CcxtOrder): Order {
		const market = this.exchange.markets[order.symbol] as
			| { contract?: boolean; linear?: boolean; inverse?: boolean; contractSize?: number }
			| undefined;
		return toOrder(order, this.contractSizeForSymbol(order.symbol), market?.contract === true);
	}

	private baseAmountToContracts(
		symbol: string,
		amount: number,
		market: { contract?: boolean; linear?: boolean; contractSize?: number },
	): number {
		const contractSize = this.contractSizeForMarket(market);
		if (!market.contract) return amount;
		const contracts = amount / contractSize;
		if (!Number.isFinite(contracts) || contracts <= 0) {
			throw new Error(`Amount ${amount} cannot be represented for ${symbol}`);
		}
		const precise = Number(this.exchange.amountToPrecision(symbol, contracts));
		if (!Number.isFinite(precise) || precise <= 0) {
			throw new Error(`Amount ${amount} rounds to zero contracts for ${symbol}`);
		}
		const represented = precise * contractSize;
		const tolerance = Math.max(1e-12, Math.abs(amount) * 1e-9);
		if (Math.abs(represented - amount) > tolerance) {
			throw new Error(
				`Amount ${amount} base units cannot be represented exactly as ${precise} contracts for ${symbol} (contractSize ${contractSize})`,
			);
		}
		return precise;
	}

	/**
	 * Binance close-all trigger orders do not send a quantity. CCXT still
	 * requires a positive amount argument while building the request, so use a
	 * precision-safe placeholder. A representable requested amount is retained
	 * for compatibility; when it is off-grid, the placeholder is explicitly
	 * informational because Binance ignores it with closePosition=true.
	 */
	private closeAllTriggerAmount(
		symbol: string,
		amount: number,
		market: { contract?: boolean; linear?: boolean; contractSize?: number; limits?: { amount?: { min?: number } } },
	): number {
		const contractSize = this.contractSizeForMarket(market);
		const requestedContracts = market.contract ? amount / contractSize : amount;
		if (!Number.isFinite(requestedContracts) || requestedContracts <= 0) {
			throw new Error(`Amount ${amount} cannot produce a positive close-all placeholder for ${symbol}`);
		}
		const requestedPrecision = Number(this.exchange.amountToPrecision(symbol, requestedContracts));
		if (Number.isFinite(requestedPrecision) && requestedPrecision > 0) return requestedPrecision;
		const candidates = [market.limits?.amount?.min, 1];
		for (const candidate of candidates) {
			if (candidate === undefined || !Number.isFinite(candidate) || candidate <= 0) continue;
			const precise = Number(this.exchange.amountToPrecision(symbol, candidate));
			if (Number.isFinite(precise) && precise > 0) return precise;
		}
		throw new Error(`No positive exchange amount placeholder is available for Binance close-all trigger ${symbol}`);
	}

	private async ensureMarketsLoaded(): Promise<void> {
		if (this.marketsLoaded) return;
		await this.exchange.loadMarkets();
		this.marketsLoaded = true;
	}

	private async getSpotCostBasis(
		symbol: string,
		balance: number,
	): Promise<
		Pick<Position, "avgEntryPrice" | "unrealizedPnl" | "unrealizedPnlPct" | "costBasisStatus" | "costBasisReason">
	> {
		if (!this.exchange.has.fetchMyTrades || typeof this.exchange.fetchMyTrades !== "function")
			return { costBasisStatus: "unavailable", costBasisReason: "fetchMyTrades is unsupported" };
		let trades: CcxtTrade[];
		try {
			// A bounded request is deliberate: an unbounded account-history query can
			// stall position polling and still cannot prove coverage of transfers.
			trades = await this.exchange.fetchMyTrades(symbol, undefined, 1000);
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
				(feeCurrency !== this.quoteCurrency && feeCurrency !== symbol.split("/")[0])
			)
				incomplete = true;
			let nextQuantity: number;
			let nextCost: number;
			if (trade.side === "buy") {
				nextQuantity = quantity + amount;
				nextCost = cost + notional;
				if (feeCurrency === this.quoteCurrency && Number.isFinite(feeCost)) nextCost += feeCost;
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
			const tickerLast = (await this.exchange.fetchTicker(symbol)).last;
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

	constructor(
		id: string,
		quoteCurrency: string,
		credentials: ExchangeCredentials,
		marketType: MarketType = "spot",
		leverage = 1,
		marginType: FuturesMarginType = "isolated",
		positionMode: FuturesPositionMode = "one-way",
	) {
		this.id = id;
		this.quoteCurrency = quoteCurrency;
		this.marketType = marketType;
		this.defaultLeverage = leverage;
		this.defaultMarginType = marginType;
		this.positionMode = positionMode;
		const ExchangeClass = (ccxt as unknown as Record<string, new (cfg: object) => Exchange>)[id];
		if (!ExchangeClass) {
			throw new Error(`Unknown exchange "${id}". Check https://docs.ccxt.com for supported ids.`);
		}
		this.exchange = new ExchangeClass({
			apiKey: credentials.apiKey,
			options: {
				// Monitor and tools poll open orders across all symbols; acknowledge
				// binance's stricter-rate-limit warning instead of throwing.
				warnOnFetchOpenOrdersWithoutSymbol: false,
				...(id === "binance" ? { adjustForTimeDifference: true, recvWindow: 10_000 } : {}),
				...(marketType === "usdm-futures" ? { defaultType: "swap" } : {}),
			},
			secret: credentials.secret,
			password: credentials.password,
			enableRateLimit: true,
		});
	}

	async getTicker(symbol: string): Promise<Ticker> {
		await this.ensureMarket(symbol);
		return toTicker(await this.exchange.fetchTicker(symbol));
	}

	async getOrderBook(symbol: string, limit = 20): Promise<OrderBook> {
		await this.ensureMarket(symbol);
		const book = await this.exchange.fetchOrderBook(symbol, limit);
		const bids = book.bids.flatMap(([price, amount]) =>
			price !== undefined && amount !== undefined ? [{ price, amount }] : [],
		);
		const asks = book.asks.flatMap(([price, amount]) =>
			price !== undefined && amount !== undefined ? [{ price, amount }] : [],
		);
		const bestBid = bids[0]?.price;
		const bestAsk = asks[0]?.price;
		const spread = bestBid !== undefined && bestAsk !== undefined ? bestAsk - bestBid : undefined;
		return {
			symbol,
			timestamp: book.timestamp ?? Date.now(),
			bids,
			asks,
			spread,
			spreadPct: spread !== undefined && bestBid ? (spread / bestBid) * 100 : undefined,
			bidDepth: bids.reduce((sum, level) => sum + level.amount, 0),
			askDepth: asks.reduce((sum, level) => sum + level.amount, 0),
		};
	}

	async getMarketInfo(symbol: string): Promise<MarketInfo> {
		const market = await this.ensureMarket(symbol);
		const info = market.info as Record<string, unknown> | undefined;
		const rawContractType = String(info?.contractType ?? "").toUpperCase();
		const contractType = !market.contract
			? "spot"
			: rawContractType.includes("PERPETUAL")
				? "perpetual"
				: rawContractType.includes("DELIVERY") ||
						rawContractType.includes("CURRENT_QUARTER") ||
						rawContractType.includes("NEXT_QUARTER")
					? "delivery"
					: "unknown";
		const stringArray = (value: unknown): string[] | undefined =>
			Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
		return {
			symbol: market.symbol,
			base: market.base,
			quote: market.quote,
			settle: market.settle,
			marketType: market.swap ? "swap" : "spot",
			contract: market.contract,
			contractType,
			pair: typeof info?.pair === "string" ? info.pair : undefined,
			marginAsset: typeof info?.marginAsset === "string" ? info.marginAsset : undefined,
			status: typeof info?.status === "string" ? info.status : undefined,
			onboardDate: typeof info?.onboardDate === "number" ? info.onboardDate : undefined,
			deliveryDate: typeof info?.deliveryDate === "number" ? info.deliveryDate : undefined,
			orderTypes: stringArray(market.orderTypes),
			timeInForce: stringArray(market.timeInForce),
			linear: market.linear,
			inverse: market.inverse,
			active: market.active,
			amountUnit: market.contract ? "contracts" : "base",
			contractSize: market.contractSize,
			pricePrecision: market.precision?.price,
			amountPrecision: market.precision?.amount,
			minAmount: market.limits?.amount?.min,
			minNotional: market.limits?.cost?.min,
			limits: market.limits,
		};
	}

	async getContractStats(symbol: string): Promise<ContractStats> {
		if (this.marketType !== "usdm-futures")
			throw new Error("Contract stats are available only in USDⓈ-M futures mode");
		await this.ensureMarket(symbol);
		const [ticker, funding] = await Promise.all([
			this.exchange.fetchTicker(symbol),
			this.exchange.fetchFundingRate(symbol),
		]);
		let openInterest: number | undefined;
		let openInterestValue: number | undefined;
		try {
			const interest = await this.exchange.fetchOpenInterest(symbol);
			// CCXT exposes amount (contracts/base units) and quote value as
			// separate fields. Preserve that distinction: falling back from one
			// to the other silently changes the unit and makes downstream sizing
			// and valuation unsafe.
			openInterest = finiteNonNegative(interest.openInterestAmount);
			openInterestValue = finiteNonNegative(interest.openInterestValue);
		} catch {
			// Binance may reject open-interest requests for unsupported symbols.
		}
		const info = ticker.info as Record<string, unknown> | undefined;
		const markPrice = Number(info?.markPrice ?? funding.markPrice ?? NaN);
		const indexPrice = Number(info?.indexPrice ?? funding.indexPrice ?? NaN);
		const fundingInfo = funding.info as Record<string, unknown> | undefined;
		const numberOrUndefined = (value: unknown): number | undefined => {
			const number = Number(value);
			return Number.isFinite(number) ? number : undefined;
		};
		const stats: ContractStats = {
			symbol,
			lastPrice: ticker.last ?? undefined,
			markPrice: Number.isFinite(markPrice) ? markPrice : undefined,
			indexPrice: Number.isFinite(indexPrice) ? indexPrice : undefined,
			fundingRate: funding.fundingRate ?? undefined,
			nextFundingTime: funding.nextFundingTimestamp,
			nextFundingRate: numberOrUndefined(fundingInfo?.nextFundingRate),
			estimatedSettlePrice: numberOrUndefined(fundingInfo?.estimatedSettlePrice),
			interestRate: numberOrUndefined(fundingInfo?.interestRate),
			openInterest,
			openInterestValue,
		};
		if (stats.markPrice !== undefined && stats.indexPrice !== undefined) {
			stats.basis = stats.markPrice - stats.indexPrice;
			stats.basisPct = stats.indexPrice ? (stats.basis / stats.indexPrice) * 100 : undefined;
		}
		return stats;
	}

	async getKlines(symbol: string, timeframe: string, limit: number): Promise<Kline[]> {
		await this.ensureMarket(symbol);
		const ohlcv = await this.exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
		const duration = timeframeDurationMs(timeframe);
		return ohlcv.map((k) => ({
			timestamp: k[0] ?? 0,
			closed: k[0] !== undefined && duration !== undefined ? k[0] + duration <= Date.now() : undefined,
			open: k[1] ?? 0,
			high: k[2] ?? 0,
			low: k[3] ?? 0,
			close: k[4] ?? 0,
			volume: k[5] ?? 0,
		}));
	}

	async getBalances(): Promise<Balance[]> {
		const balance = await this.exchange.fetchBalance();
		// ccxt types Balances as Dictionary<Balance>; at runtime .free/.used/.total
		// are per-currency dictionaries, so cast them back.
		const totals = (balance.total ?? {}) as unknown as Record<string, number | undefined>;
		const frees = (balance.free ?? {}) as unknown as Record<string, number | undefined>;
		const useds = (balance.used ?? {}) as unknown as Record<string, number | undefined>;
		const assets = Object.keys(totals).filter((a) => (totals[a] ?? 0) > 0);
		const result: Balance[] = [];
		for (const asset of assets) {
			const total = totals[asset] ?? 0;
			const b: Balance = {
				asset,
				free: frees[asset] ?? 0,
				used: useds[asset] ?? 0,
				total,
			};
			b.quoteValue = await this.estimateQuoteValue(asset, total);
			result.push(b);
		}
		return result;
	}

	async getPositions(): Promise<Position[]> {
		if (this.marketType === "usdm-futures") {
			await this.ensureMarketsLoaded();
			const positions = await this.exchange.fetchPositions();
			return positions.flatMap((p) => {
				if (typeof p.symbol !== "string") return [];
				const market = this.exchange.markets[p.symbol];
				// fetchPositions() may return every derivative family even when the
				// exchange client is configured for USDⓈ-M. Keep only the configured
				// quote/settle linear swaps; in particular, never mix USDC-M or
				// inverse/delivery positions into a USDT account. CCXT's `active`
				// flag is optional; unknown activity is retained for reconciliation,
				// while an explicit inactive flag is rejected (matching ensureMarket).
				if (
					!market ||
					market.quote !== this.quoteCurrency ||
					market.settle !== this.quoteCurrency ||
					market.swap !== true ||
					market.contract !== true ||
					market.linear !== true ||
					market.inverse === true ||
					market.active === false
				)
					return [];
				const contractSize = finitePositive(market.contractSize);
				if (contractSize === undefined) return [];
				const info = (p.info ?? {}) as Record<string, unknown>;
				const normalizedContracts = finiteNumber(p.contracts);
				const rawContracts = finiteNumber(info.positionAmt ?? info.contracts);
				const contracts =
					normalizedContracts !== undefined && normalizedContracts !== 0
						? normalizedContracts
						: (rawContracts ?? normalizedContracts ?? 0);
				if (!Number.isFinite(contracts) || contracts === 0) return [];
				const magnitude = Math.abs(contracts);
				const amount = magnitude * contractSize;
				// Position.amount is a required domain number. An overflowing
				// contracts-to-base conversion cannot be represented safely, so omit
				// that malformed exchange row instead of emitting Infinity.
				if (!Number.isFinite(amount) || amount <= 0) return [];
				this.knownSymbols.add(p.symbol);
				const markPriceCandidates = [finitePositive(p.markPrice), finitePositive(info.markPrice)];
				const markPrice = markPriceCandidates.find((value) => value !== undefined);
				const notionalCandidates = [finiteNumber(p.notional), finiteNumber(info.notional)];
				const notional =
					notionalCandidates.find((value) => value !== undefined && value !== 0) ??
					notionalCandidates.find((value) => value !== undefined);
				// A zero/invalid notional is commonly used as a placeholder by
				// exchange adapters. Do not turn a missing mark into a fabricated
				// zero valuation: callers need to distinguish an open position from
				// one whose quote valuation is unavailable.
				const quoteValue =
					notional !== undefined && notional !== 0
						? Math.abs(notional)
						: markPrice !== undefined
							? amount * markPrice
							: undefined;
				const valuation =
					quoteValue !== undefined && Number.isFinite(quoteValue)
						? { valuationStatus: "complete" as const }
						: {
								valuationStatus: "unavailable" as const,
								valuationReason:
									markPrice === undefined && (notional === undefined || notional === 0)
										? "Exchange notional and mark price are unavailable"
										: `Quote valuation for ${p.symbol} is not finite`,
							};
				const infoSide = positionSideFromInfo(info);
				const signedContracts =
					p.side === "short"
						? -magnitude
						: p.side === "long"
							? magnitude
							: infoSide === "SHORT"
								? -magnitude
								: infoSide === "LONG"
									? magnitude
									: rawContracts !== undefined
										? rawContracts
										: contracts;
				const positionSide =
					p.side === "long"
						? "LONG"
						: p.side === "short"
							? "SHORT"
							: infoSide !== undefined && infoSide !== "BOTH"
								? infoSide
								: signedContracts < 0
									? "SHORT"
									: "LONG";
				const leverage = finitePositive(p.leverage) ?? finitePositive(info.leverage);
				const marginType = p.marginMode === "isolated" ? "isolated" : "cross";
				const liquidationPrice = finitePositive(p.liquidationPrice) ?? finitePositive(info.liquidationPrice);
				const margin = finiteNonNegative(p.initialMargin) ?? finiteNonNegative(info.initialMargin);
				const avgEntryPrice = finitePositive(p.entryPrice) ?? finitePositive(info.entryPrice);
				const unrealizedPnl =
					finiteNumber(p.unrealizedPnl) ?? finiteNumber(info.unrealizedPnl ?? info.unRealizedProfit);
				const unrealizedPnlPct = finiteNumber(p.percentage) ?? finiteNumber(info.percentage);
				return [
					{
						symbol: p.symbol,
						asset: p.symbol.split("/")[0],
						amount,
						...(quoteValue !== undefined && Number.isFinite(quoteValue) ? { quoteValue } : {}),
						...valuation,
						positionSide: positionSide as Position["positionSide"],
						...(leverage !== undefined ? { leverage } : {}),
						marginType,
						...(markPrice !== undefined ? { markPrice } : {}),
						...(liquidationPrice !== undefined ? { liquidationPrice } : {}),
						...(margin !== undefined ? { margin } : {}),
						...(avgEntryPrice !== undefined ? { avgEntryPrice } : {}),
						...(unrealizedPnl !== undefined ? { unrealizedPnl } : {}),
						...(unrealizedPnlPct !== undefined ? { unrealizedPnlPct } : {}),
					},
				];
			});
		}
		const balances = await this.getBalances();
		const positions: Position[] = [];
		for (const b of balances) {
			if (b.asset === this.quoteCurrency || (b.quoteValue !== undefined && b.quoteValue <= 1)) continue;
			const symbol = `${b.asset}/${this.quoteCurrency}`;
			this.knownSymbols.add(symbol);
			const basis = await this.getSpotCostBasis(symbol, b.total);
			const valuation =
				b.quoteValue !== undefined && Number.isFinite(b.quoteValue)
					? { valuationStatus: "complete" as const }
					: {
							valuationStatus: "unavailable" as const,
							valuationReason: `Quote valuation for ${symbol} is unavailable`,
						};
			positions.push({ symbol, asset: b.asset, amount: b.total, quoteValue: b.quoteValue, ...basis, ...valuation });
		}
		return positions;
	}

	async getOpenOrders(symbol?: string): Promise<Order[]> {
		const merged = new Map<string, Order>();
		if (symbol) await this.ensureMarket(symbol);
		else await this.ensureMarketsLoaded();
		const orders = await this.exchange.fetchOpenOrders(symbol);
		for (const o of orders) {
			this.knownSymbols.add(o.symbol);
			merged.set(orderKey(o), this.toDomainOrder(o));
		}
		if (this.id === "binance" && this.marketType === "usdm-futures") {
			// Binance USD-M conditional orders are stored in the Algo Order API,
			// not the ordinary order endpoint. CCXT selects that endpoint when
			// trigger=true is passed.
			for (const o of await this.exchange.fetchOpenOrders(symbol, undefined, undefined, { trigger: true })) {
				this.knownSymbols.add(o.symbol);
				const key = orderKey(o);
				if (!merged.has(key)) merged.set(key, this.toDomainOrder(o));
			}
		}
		if (this.id === "okx") {
			for (const params of [{ ordType: "conditional" }, { trigger: true }, { trailing: true }, { ordType: "oco" }]) {
				const algoOrders = await this.exchange.fetchOpenOrders(symbol, undefined, undefined, params);
				for (const o of algoOrders) {
					this.knownSymbols.add(o.symbol);
					const key = orderKey(o);
					if (!merged.has(key)) merged.set(key, this.toDomainOrder(o));
				}
			}
		}
		return [...merged.values()];
	}

	async getOrderHistory(symbol?: string, limit = 50): Promise<Order[]> {
		if (symbol) await this.ensureMarket(symbol);
		else await this.ensureMarketsLoaded();
		if (symbol) this.knownSymbols.add(symbol);
		if (this.id === "binance") {
			const symbols = symbol ? [symbol] : [...this.knownSymbols];
			if (symbols.length === 0)
				throw new Error("Binance order history requires a symbol; query a market or pass symbol explicitly");
			const merged = new Map<string, Order>();
			for (const knownSymbol of symbols) {
				for (const rawOrder of await this.exchange.fetchOrders(knownSymbol, undefined, limit)) {
					const order = this.toDomainOrder(rawOrder);
					if (order.status !== "open") merged.set(orderKey(order), order);
				}
				// Conditional futures orders have a separate Binance history. Keep
				// it in the same domain result so reconciliation cannot report a
				// real Algo order as missing.
				if (this.marketType === "usdm-futures") {
					for (const rawOrder of await this.exchange.fetchOrders(knownSymbol, undefined, limit, {
						trigger: true,
					})) {
						const order = this.toDomainOrder(rawOrder);
						if (order.status !== "open") merged.set(orderKey(order), order);
					}
				}
			}
			return [...merged.values()].sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
		}
		const merged = new Map<string, Order>();
		for (const order of await this.exchange.fetchClosedOrders(symbol, undefined, limit)) {
			merged.set(orderKey(order), this.toDomainOrder(order));
		}
		if (this.exchange.has.fetchCanceledOrders) {
			for (const order of await this.exchange.fetchCanceledOrders(symbol, undefined, limit)) {
				merged.set(orderKey(order), this.toDomainOrder(order));
			}
		}
		if (this.id === "okx") {
			// CCXT needs trigger=true to request the effective algo-history state;
			// ordType=oco alone incorrectly builds a normal filled-order query.
			for (const params of [
				{ ordType: "conditional", trigger: true },
				{ trigger: true },
				{ trailing: true },
				{ ordType: "oco", trigger: true },
			]) {
				for (const order of await this.exchange.fetchClosedOrders(symbol, undefined, limit, params)) {
					const key = orderKey(order);
					if (!merged.has(key)) merged.set(key, this.toDomainOrder(order));
				}
			}
			if (this.exchange.has.fetchCanceledOrders) {
				for (const params of [
					{ ordType: "conditional", trigger: true },
					{ ordType: "trigger", trigger: true },
					{ trailing: true },
					{ ordType: "oco", trigger: true },
				]) {
					for (const order of await this.exchange.fetchCanceledOrders(symbol, undefined, limit, params)) {
						const key = orderKey(order);
						if (!merged.has(key)) merged.set(key, this.toDomainOrder(order));
					}
				}
			}
		}
		return [...merged.values()].sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
	}

	async getOrder(id: string, symbol: string): Promise<Order> {
		await this.ensureMarket(symbol);
		if (this.id === "binance" && this.marketType === "spot") {
			const endpoint = (this.exchange as unknown as Record<string, unknown>).privateGetOrder;
			if (typeof endpoint !== "function")
				throw new Error("Binance ccxt adapter does not expose the Spot order query endpoint");
			const raw = await (endpoint as (params: Record<string, string>) => Promise<unknown>).call(this.exchange, {
				symbol: this.exchange.markets[symbol].id,
				orderId: id,
			});
			return this.toDomainOrder(
				this.exchange.parseOrder(raw as Record<string, unknown>, this.exchange.markets[symbol]),
			);
		}
		if (!this.exchange.has.fetchOrder) throw new Error(`Order lookup is unsupported on ${this.id}`);
		try {
			return this.toDomainOrder(await this.exchange.fetchOrder(id, symbol));
		} catch (error) {
			if (this.id !== "binance" || this.marketType !== "usdm-futures" || !isOrderNotFound(error)) throw error;
			// Binance USDⓈ-M conditional orders live in the Algo Order API. A
			// regular lookup is still attempted first because ordinary market/limit
			// orders use the standard endpoint; only a definitive not-found result
			// permits the alternate query.
			return this.toDomainOrder(await this.exchange.fetchOrder(id, symbol, { trigger: true }));
		}
	}

	async getOrderByClientId(clientOrderId: string, symbol: string, conditional?: boolean): Promise<Order> {
		await this.ensureMarket(symbol);
		if (this.id !== "binance") {
			const capability = this.exchange.has.fetchOrderWithClientOrderId;
			if (capability !== true && capability !== "emulated") {
				throw new Error(`Client id lookup is unsupported on ${this.id}`);
			}
			if (typeof this.exchange.fetchOrderWithClientOrderId !== "function") {
				throw new Error(`Client id lookup method is unavailable on ${this.id}`);
			}
			const order = await this.exchange.fetchOrderWithClientOrderId(clientOrderId, symbol);
			const normalized = this.toDomainOrder(order);
			if (normalized.symbol !== symbol) {
				throw new Error(
					`Client id lookup on ${this.id} returned ${normalized.symbol} while ${symbol} was requested`,
				);
			}
			if (normalized.clientOrderId !== undefined && normalized.clientOrderId !== clientOrderId) {
				throw new Error(
					`Client id lookup on ${this.id} returned clientOrderId=${normalized.clientOrderId} while ${clientOrderId} was requested`,
				);
			}
			return { ...normalized, clientOrderId };
		}
		const isFutures = this.marketType === "usdm-futures";
		const lookup = async (isConditional: boolean): Promise<Order> => {
			const endpointName = isFutures
				? isConditional
					? "fapiPrivateGetAlgoOrder"
					: "fapiPrivateGetOrder"
				: "privateGetOrder";
			const endpoint = (this.exchange as unknown as Record<string, unknown>)[endpointName];
			if (typeof endpoint !== "function")
				throw new Error(
					`Binance ${isFutures ? (isConditional ? "futures Algo" : "futures") : "Spot"} order query endpoint unavailable`,
				);
			const raw = await (endpoint as (params: Record<string, string>) => Promise<unknown>).call(this.exchange, {
				symbol: this.exchange.markets[symbol].id,
				...(isFutures
					? isConditional
						? { clientAlgoId: clientOrderId }
						: { origClientOrderId: clientOrderId }
					: { origClientOrderId: clientOrderId }),
			});
			return this.toDomainOrder(
				this.exchange.parseOrder(raw as Record<string, unknown>, this.exchange.markets[symbol]),
			);
		};
		if (!isFutures || conditional === true) return lookup(conditional === true);
		try {
			return await lookup(false);
		} catch (error) {
			if (!isOrderNotFound(error)) throw error;
			return lookup(true);
		}
	}

	async getOrderListByClientId(listClientOrderId: string): Promise<OrderList> {
		return this.fetchOrderList({ origClientOrderId: listClientOrderId });
	}

	async getOrderList(orderListId: string): Promise<OrderList> {
		return this.fetchOrderList({ orderListId });
	}

	private async recoverOcoSubmission(listClientOrderId: string, symbol: string): Promise<PlaceOcoOrderResult> {
		if (this.id === "binance" && this.marketType === "spot") {
			const recovered = await this.getOrderListByClientId(listClientOrderId);
			if (recovered.orders.length === 0) {
				throw new Error(`OCO order-list lookup returned no orders for ${listClientOrderId}`);
			}
			return { orders: recovered.orders };
		}
		// Non-native OCO adapters expose the bracket as one CCXT order. Only use
		// an explicitly advertised client-id lookup; guessing by scanning open or
		// historical orders can return a different order and is not safe after a
		// transport failure.
		return { orders: [await this.getOrderByClientId(listClientOrderId, symbol)] };
	}

	private async fetchOrderList(query: Record<string, string>): Promise<OrderList> {
		if (this.id !== "binance" || this.marketType !== "spot")
			throw new Error(`Order-list lookup is unsupported on ${this.id}`);
		if (!this.marketsLoaded) {
			await this.exchange.loadMarkets();
			this.marketsLoaded = true;
		}
		const endpoint = (this.exchange as unknown as Record<string, unknown>).privateGetOrderList;
		if (typeof endpoint !== "function")
			throw new Error("Binance ccxt adapter does not expose the Spot order-list query endpoint");
		const raw = (await (endpoint as (params: Record<string, string>) => Promise<unknown>).call(this.exchange, {
			...query,
		})) as Record<string, unknown>;
		const id = String(raw.orderListId ?? query.orderListId ?? query.origClientOrderId);
		const listOrderStatus = String(raw.listOrderStatus ?? raw.listStatusType ?? "UNKNOWN");
		const rawOrders = Array.isArray(raw.orderReports)
			? raw.orderReports
			: Array.isArray(raw.orders)
				? raw.orders
				: [];
		this.knownOrderListIds.add(id);
		const orders = await Promise.all(
			rawOrders.map(async (rawOrder) => {
				const report = rawOrder as Record<string, unknown>;
				const symbol = this.exchange.safeSymbol(String(report.symbol ?? ""));
				const orderId = String(report.orderId ?? "");
				if (!symbol || !orderId)
					throw new Error("Binance Spot order-list response contains an invalid order reference");
				const order = await this.getOrder(orderId, symbol);
				return { ...order, ocoGroup: id, orderListId: id, listOrderStatus };
			}),
		);
		const normalizedListStatus = listOrderStatus.toUpperCase();
		return {
			id,
			listOrderStatus,
			status:
				normalizedListStatus === "EXECUTING" || normalizedListStatus === "EXEC_STARTED"
					? "open"
					: normalizedListStatus === "ALL_DONE"
						? "closed"
						: toOrderStatus(listOrderStatus),
			orders,
		};
	}

	async placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
		const clientOrderId = input.clientOrderId ?? generateClientOrderId();
		input = { ...input, clientOrderId };
		const market = await this.ensureMarket(input.symbol);
		const isLimitExec = input.type === "limit" || input.type === "stop" || input.type === "take_profit";
		const isTrigger =
			input.type === "stop" ||
			input.type === "stop_market" ||
			input.type === "take_profit" ||
			input.type === "take_profit_market";
		const binanceCloseAllTrigger =
			this.id === "binance" &&
			this.marketType === "usdm-futures" &&
			input.closePosition === true &&
			(input.type === "stop_market" || input.type === "take_profit_market");
		const hedgeClosePosition = input.closePosition === true;
		// A market closePosition order is converted to an exact quantity before
		// submission, so it must carry the same reducing invariant as an explicit
		// reduceOnly order. Trigger close-all orders use the exchange's native
		// closePosition flag instead (and Binance omits reduceOnly on the wire).
		const effectiveReduceOnly = input.closePosition === true ? true : input.reduceOnly;
		const hedgeReductionDirection =
			(input.positionSide === "LONG" && input.side === "sell") ||
			(input.positionSide === "SHORT" && input.side === "buy");
		if (market.contract && input.closePosition && input.reduceOnly === false) {
			throw new Error("closePosition is always reduceOnly");
		}
		if (
			market.contract &&
			input.closePosition &&
			input.type !== "market" &&
			input.type !== "stop_market" &&
			input.type !== "take_profit_market"
		) {
			throw new Error("closePosition is supported only for market or trigger-market orders");
		}
		if (
			!market.contract &&
			(input.reduceOnly !== undefined || input.positionSide !== undefined || input.closePosition !== undefined)
		) {
			throw new Error("reduceOnly, positionSide and closePosition are futures-only parameters");
		}
		if (
			market.contract &&
			this.positionMode === "hedge" &&
			input.positionSide !== "LONG" &&
			input.positionSide !== "SHORT"
		) {
			throw new Error("Hedge mode futures orders require positionSide LONG or SHORT");
		}
		if (
			market.contract &&
			this.positionMode === "one-way" &&
			input.positionSide !== undefined &&
			input.positionSide !== "BOTH"
		) {
			throw new Error("One-way mode futures orders must use positionSide BOTH or omit it");
		}
		// A hedge reduction must identify the position side and use the opposing
		// order side. This invariant is enforced for every adapter; Binance has an
		// additional wire constraint below because it rejects reduceOnly in hedge
		// mode, while other exchanges and Paper retain the explicit flag.
		if (
			market.contract &&
			this.positionMode === "hedge" &&
			(effectiveReduceOnly === true || hedgeClosePosition) &&
			!hedgeReductionDirection
		) {
			throw new Error(
				`Hedge-mode reducing orders on ${this.id} require the opposing side with positionSide LONG or SHORT; reduceOnly cannot be used to override an ambiguous direction`,
			);
		}
		if (isLimitExec && (input.price === undefined || input.price <= 0)) {
			throw new Error(`${input.type} orders require a positive price`);
		}
		if (isTrigger && (input.stopPrice === undefined || input.stopPrice <= 0)) {
			throw new Error(`${input.type} orders require a positive stopPrice`);
		}
		if (
			input.type === "trailing_stop_market" &&
			(input.trailingPercent === undefined ||
				!Number.isFinite(input.trailingPercent) ||
				input.trailingPercent <= 0 ||
				input.trailingPercent >= 100)
		) {
			throw new Error("trailing_stop_market orders require a finite trailingPercent between 0 and 100");
		}
		if (this.id === "binance" && this.marketType === "spot") {
			// Trailing stops execute as market orders, but Binance validates their
			// quantity against LOT_SIZE (MARKET_LOT_SIZE is for ordinary market).
			const ordinaryMarket = input.type === "market";
			let marketReference: number | undefined;
			if (ordinaryMarket) {
				try {
					marketReference = (await this.getTicker(input.symbol)).last;
				} catch {
					// Notional validation is best effort for market orders; Binance
					// remains the authoritative check when no reference is available.
				}
			}
			validateBinanceSpotFilters(
				market.info,
				input.amount,
				ordinaryMarket ? "market" : "lot",
				[
					...(isLimitExec && input.price !== undefined
						? [{ label: "Price", value: input.price, notionalReference: true }]
						: []),
					...(input.stopPrice !== undefined ? [{ label: "stopPrice", value: input.stopPrice }] : []),
				],
				{ marketOrder: ordinaryMarket, marketReference },
			);
		}
		const numericAmount = binanceCloseAllTrigger
			? this.closeAllTriggerAmount(input.symbol, input.amount, market)
			: market.contract
				? this.baseAmountToContracts(input.symbol, input.amount, market)
				: Number(this.exchange.amountToPrecision(input.symbol, input.amount));
		if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
			throw new Error(`Amount ${input.amount} rounds to zero for ${input.symbol}`);
		}
		const contractSize = this.contractSizeForMarket(market);
		const representedBaseAmount = numericAmount * contractSize;
		const price =
			isLimitExec && input.price !== undefined
				? this.exchange.priceToPrecision(input.symbol, input.price)
				: undefined;
		const stopPrice =
			input.stopPrice !== undefined
				? Number(this.exchange.priceToPrecision(input.symbol, input.stopPrice))
				: undefined;
		const numericPrice = price === undefined ? undefined : Number(price);
		// Binance Spot filters were validated above against the raw filter set.
		// Do not re-apply ccxt's coarse cost limit: it loses per-filter market
		// applicability and can use a trigger price as an execution reference.
		if (!binanceCloseAllTrigger && !(this.id === "binance" && this.marketType === "spot")) {
			const minAmount = market.limits?.amount?.min;
			const maxAmount = market.limits?.amount?.max;
			const minCost = market.limits?.cost?.min;
			const maxCost = market.limits?.cost?.max;
			if (minAmount !== undefined && numericAmount < minAmount)
				throw new Error(
					`${market.contract ? "Contract amount" : "Amount"} ${numericAmount} is below minimum ${minAmount} for ${input.symbol}`,
				);
			if (maxAmount !== undefined && numericAmount > maxAmount)
				throw new Error(
					`${market.contract ? "Contract amount" : "Amount"} ${numericAmount} exceeds maximum ${maxAmount} for ${input.symbol}`,
				);
			if (minCost !== undefined || maxCost !== undefined) {
				const referencePrice = numericPrice ?? (await this.getTicker(input.symbol)).last;
				if (referencePrice === undefined || referencePrice <= 0)
					throw new Error(`No reference price for ${input.symbol}`);
				const cost = representedBaseAmount * referencePrice;
				if (minCost !== undefined && cost < minCost)
					throw new Error(`Order cost is below minimum ${minCost} for ${input.symbol}`);
				if (maxCost !== undefined && cost > maxCost)
					throw new Error(`Order cost exceeds maximum ${maxCost} for ${input.symbol}`);
			}
		}
		await this.ensureFuturesTradingSettings(input.symbol);
		// Binance Spot exposes trailing stops through its native `trailingDelta`
		// parameter (integer BIPS), not the futures TRAILING_STOP_MARKET type.
		// Use the native endpoint because ccxt does not reliably map the unified
		// trailingPercent parameter to Spot orders.
		if (this.id === "binance" && this.marketType === "spot" && input.type === "trailing_stop_market") {
			try {
				const raw = await this.createBinanceSpotTrailingOrder(
					input.symbol,
					input.side,
					numericAmount,
					input.trailingPercent as number,
					stopPrice,
					clientOrderId,
				);
				return {
					order: this.binanceRawOrderToOrder(
						raw,
						input.symbol,
						input.side,
						numericAmount,
						input.trailingPercent as number,
						clientOrderId,
					),
				};
			} catch (error) {
				if (!isUncertainSubmission(error)) throw normalizeExchangeError(error, "Trailing order submission");
				try {
					return {
						order: await this.getOrderByClientId(
							clientOrderId,
							input.symbol,
							isTrigger || input.type === "trailing_stop_market",
						),
					};
				} catch (lookupError) {
					throw submissionStatusUnknownError(
						this.id,
						input.symbol,
						"clientOrderId",
						clientOrderId,
						"trailing order",
						error,
						lookupError,
					);
				}
			}
		}
		// Map order types onto ccxt's exchange-agnostic createOrder contract:
		// execution type market/limit plus unified trigger/trailing params.
		const execType = isLimitExec ? "limit" : "market";
		const isStop = input.type === "stop" || input.type === "stop_market";
		const binanceHedgeReduction =
			this.id === "binance" &&
			this.marketType === "usdm-futures" &&
			this.positionMode === "hedge" &&
			effectiveReduceOnly === true;
		// Binance rejects reduceOnly in hedge mode and on close-all triggers.
		const params = {
			...(this.id === "binance" && this.marketType === "spot"
				? { newClientOrderId: clientOrderId }
				: { clientOrderId }),
			...(effectiveReduceOnly !== undefined && !binanceHedgeReduction && !binanceCloseAllTrigger
				? { reduceOnly: effectiveReduceOnly }
				: {}),
			...(input.positionSide ? { positionSide: input.positionSide } : {}),
			...(isTrigger && stopPrice !== undefined
				? isStop
					? { stopLossPrice: stopPrice }
					: { takeProfitPrice: stopPrice }
				: {}),
			...(input.type === "trailing_stop_market"
				? {
						trailingPercent: input.trailingPercent,
						...(stopPrice !== undefined ? { trailingTriggerPrice: stopPrice } : {}),
					}
				: {}),
			...(input.closePosition && isTrigger ? { closePosition: true } : {}),
		};
		try {
			const order = await this.exchange.createOrder(
				input.symbol,
				execType,
				input.side,
				numericAmount,
				numericPrice,
				params,
			);
			return { order: { ...this.toDomainOrder(order), clientOrderId } };
		} catch (error) {
			if (!isUncertainSubmission(error)) throw normalizeExchangeError(error, "Order submission");
			try {
				return {
					order: await this.getOrderByClientId(
						clientOrderId,
						input.symbol,
						isTrigger || input.type === "trailing_stop_market",
					),
				};
			} catch (lookupError) {
				throw submissionStatusUnknownError(
					this.id,
					input.symbol,
					"clientOrderId",
					clientOrderId,
					"order",
					error,
					lookupError,
				);
			}
		}
	}

	async placeOcoOrder(input: PlaceOcoOrderInput): Promise<PlaceOcoOrderResult> {
		if (this.marketType !== "spot") {
			throw new Error("Futures OCO orders are not supported; use one reduce-only protective order instead");
		}
		const market = await this.ensureMarket(input.symbol);
		if (!Number.isFinite(input.amount) || input.amount <= 0) throw new Error("amount must be positive");
		if (!Number.isFinite(input.stopLossPrice) || input.stopLossPrice <= 0)
			throw new Error("stopLossPrice must be positive");
		if (!Number.isFinite(input.takeProfitPrice) || input.takeProfitPrice <= 0)
			throw new Error("takeProfitPrice must be positive");
		if (this.id === "binance" && this.marketType === "spot") {
			validateBinanceSpotFilters(market.info, input.amount, "lot", [
				{ label: "stopLossPrice", value: input.stopLossPrice, notionalReference: true },
				{ label: "takeProfitPrice", value: input.takeProfitPrice, notionalReference: true },
			]);
		}
		const amount = Number(this.exchange.amountToPrecision(input.symbol, input.amount));
		if (!Number.isFinite(amount) || amount <= 0)
			throw new Error(`Amount ${input.amount} rounds to zero for ${input.symbol}`);
		const listClientOrderId = input.listClientOrderId ?? generateClientOrderId();
		const aboveClientOrderId = input.aboveClientOrderId ?? generateClientOrderId();
		const belowClientOrderId = input.belowClientOrderId ?? generateClientOrderId();
		const stopLossPrice = Number(this.exchange.priceToPrecision(input.symbol, input.stopLossPrice));
		const takeProfitPrice = Number(this.exchange.priceToPrecision(input.symbol, input.takeProfitPrice));
		const last = (await this.getTicker(input.symbol)).last;
		if (last === undefined || !Number.isFinite(last) || last <= 0) {
			throw new Error(`No valid last price for ${input.symbol}`);
		}
		if (input.side === "sell") {
			if (stopLossPrice >= last)
				throw new Error(`Sell OCO stopLossPrice ${stopLossPrice} must be below the last price ${last}`);
			if (takeProfitPrice <= last)
				throw new Error(`Sell OCO takeProfitPrice ${takeProfitPrice} must be above the last price ${last}`);
		} else {
			if (stopLossPrice <= last)
				throw new Error(`Buy OCO stopLossPrice ${stopLossPrice} must be above the last price ${last}`);
			if (takeProfitPrice >= last)
				throw new Error(`Buy OCO takeProfitPrice ${takeProfitPrice} must be below the last price ${last}`);
		}
		const minAmount = market.limits?.amount?.min;
		if (minAmount !== undefined && amount < minAmount)
			throw new Error(`Amount ${amount} is below minimum ${minAmount} for ${input.symbol}`);
		if (this.id === "binance" && this.marketType === "spot" && input.side !== "sell")
			throw new Error(
				"Binance spot native OCO buy brackets are not supported safely [errorCategory=UNSUPPORTED_ORDER_TYPE]",
			);
		try {
			if (this.id === "binance" && this.marketType === "spot") {
				// Binance spot has one balance reservation for both legs. Use its
				// atomic order-list endpoint; submitting two independent sells is not safe.
				const raw = await this.createBinanceSpotOco(
					input.symbol,
					input.side,
					amount,
					stopLossPrice,
					takeProfitPrice,
					listClientOrderId,
					aboveClientOrderId,
					belowClientOrderId,
				);
				const reports = Array.isArray(raw?.orderReports) ? raw.orderReports : [];
				if (reports.length !== 2 || reports.some((report) => !report || typeof report !== "object")) {
					throw new Error("Binance Spot OCO response must contain exactly two orderReports");
				}
				const orderListId = raw?.orderListId;
				if (orderListId === undefined || String(orderListId) === "-1") {
					throw new Error("Binance Spot OCO response is missing a valid orderListId");
				}
				const ocoGroup = String(orderListId);
				this.knownOrderListIds.add(ocoGroup);
				const listStatus = typeof raw?.listOrderStatus === "string" ? raw.listOrderStatus : undefined;
				return {
					orders: reports.map((report) =>
						this.binanceReportToOrder(report, input.symbol, input.side, amount, ocoGroup, listStatus),
					),
				};
			}
			// ccxt folds both trigger prices into a single one-cancels-the-other
			// order on exchanges that support it (e.g. okx ordType "oco").
			const order = await this.exchange.createOrder(input.symbol, "oco", input.side, amount, undefined, {
				stopLossPrice,
				takeProfitPrice,
				clientOrderId: listClientOrderId,
			});
			return { orders: [this.toDomainOrder(order)] };
		} catch (error) {
			if (isUncertainSubmission(error)) {
				try {
					return await this.recoverOcoSubmission(listClientOrderId, input.symbol);
				} catch (lookupError) {
					throw submissionStatusUnknownError(
						this.id,
						input.symbol,
						"listClientOrderId",
						listClientOrderId,
						"OCO order",
						error,
						lookupError,
					);
				}
			}
			throw normalizeExchangeError(error, "OCO order");
		}
	}

	private async createBinanceSpotOco(
		symbol: string,
		side: "buy" | "sell",
		amount: number,
		stopLossPrice: number,
		takeProfitPrice: number,
		listClientOrderId: string,
		aboveClientOrderId: string,
		belowClientOrderId: string,
	): Promise<Record<string, unknown>> {
		const methods = this.exchange as unknown as Record<string, unknown>;
		// ccxt renamed the Spot endpoint from order/oco to orderList/oco.
		// Prefer the current method, but support older ccxt releases as well.
		const currentEndpoint = typeof methods.privatePostOrderListOco === "function";
		const endpoint = currentEndpoint ? methods.privatePostOrderListOco : methods.privatePostOrderOco;
		if (typeof endpoint !== "function")
			throw new Error("Binance ccxt adapter does not expose a Spot order-list OCO endpoint");
		const market = this.exchange.markets[symbol];
		const params: Record<string, string> = currentEndpoint
			? {
					symbol: market.id,
					side: side.toUpperCase(),
					quantity: this.exchange.amountToPrecision(symbol, amount),
					aboveType: "LIMIT_MAKER",
					abovePrice: this.exchange.priceToPrecision(symbol, takeProfitPrice),
					belowType: "STOP_LOSS_LIMIT",
					belowPrice: this.exchange.priceToPrecision(symbol, stopLossPrice),
					belowStopPrice: this.exchange.priceToPrecision(symbol, stopLossPrice),
					belowTimeInForce: "GTC",
					listClientOrderId,
					aboveClientOrderId,
					belowClientOrderId,
				}
			: {
					symbol: market.id,
					side: side.toUpperCase(),
					quantity: this.exchange.amountToPrecision(symbol, amount),
					price: this.exchange.priceToPrecision(symbol, takeProfitPrice),
					stopPrice: this.exchange.priceToPrecision(symbol, stopLossPrice),
					stopLimitPrice: this.exchange.priceToPrecision(symbol, stopLossPrice),
					stopLimitTimeInForce: "GTC",
					// The legacy /order/oco API uses listClientOrderId and
					// per-leg client ids; newClientOrderId is a single-order field.
					listClientOrderId,
					limitClientOrderId: aboveClientOrderId,
					stopClientOrderId: belowClientOrderId,
				};
		return (await (endpoint as (params: Record<string, string>) => Promise<unknown>).call(
			this.exchange,
			params,
		)) as Record<string, unknown>;
	}

	private async createBinanceSpotTrailingOrder(
		symbol: string,
		side: "buy" | "sell",
		amount: number,
		trailingPercent: number,
		stopPrice?: number,
		clientOrderId?: string,
	): Promise<Record<string, unknown>> {
		const endpoint = (this.exchange as unknown as Record<string, unknown>).privatePostOrder;
		if (typeof endpoint !== "function")
			throw new Error("Binance ccxt adapter does not expose the spot order endpoint");
		const exchangeMarket = this.exchange.markets[symbol];
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
			quantity: this.exchange.amountToPrecision(symbol, amount),
			trailingDelta: String(trailingDelta),
			...(clientOrderId ? { newClientOrderId: clientOrderId } : {}),
		};
		if (stopPrice !== undefined) params.stopPrice = this.exchange.priceToPrecision(symbol, stopPrice);
		return (await (endpoint as (params: Record<string, string>) => Promise<unknown>).call(
			this.exchange,
			params,
		)) as Record<string, unknown>;
	}

	private binanceRawOrderToOrder(
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

	private binanceReportToOrder(
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

	async cancelOrder(id: string, symbol: string): Promise<void> {
		await this.ensureMarket(symbol);
		if (this.id === "binance" && this.marketType === "spot" && this.knownOrderListIds.has(id)) {
			throw new Error(`Id ${id} is an orderListId; use cancel_order_list instead of cancel_order`);
		}
		try {
			await this.exchange.cancelOrder(id, symbol);
		} catch (error) {
			// Trigger/trailing "algo" orders need dedicated cancel params on some
			// exchanges (e.g. okx); retry before giving up.
			for (const params of [{ ordType: "conditional" }, { trigger: true }, { trailing: true }, { ordType: "oco" }]) {
				try {
					await this.exchange.cancelOrder(id, symbol, params);
					return;
				} catch {
					// Fall through to the original error.
				}
			}
			throw normalizeExchangeError(error, "Order cancellation");
		}
	}

	async cancelOrderList(orderListId: string, symbol: string): Promise<void> {
		await this.ensureMarket(symbol);
		if (this.id !== "binance" || this.marketType !== "spot") {
			throw new Error(`Order-list cancellation is unsupported on ${this.id}`);
		}
		const methods = this.exchange as unknown as Record<string, unknown>;
		const endpoint = methods.privateDeleteOrderList ?? methods.privateDeleteOrderOco;
		if (typeof endpoint !== "function")
			throw new Error("Binance ccxt adapter does not expose a Spot order-list cancellation endpoint");
		try {
			await (endpoint as (params: Record<string, string>) => Promise<unknown>).call(this.exchange, {
				symbol: this.exchange.markets[symbol].id,
				orderListId,
			});
		} catch (error) {
			throw normalizeExchangeError(error, "Order-list cancellation");
		}
	}

	async getTopMarkets(limit: number): Promise<Ticker[]> {
		const tickers = await this.exchange.fetchTickers();
		const suffix =
			this.marketType === "usdm-futures" ? `/${this.quoteCurrency}:${this.quoteCurrency}` : `/${this.quoteCurrency}`;
		return Object.values(tickers)
			.filter((t) => t.symbol.endsWith(suffix))
			.sort((a, b) => (b.quoteVolume ?? 0) - (a.quoteVolume ?? 0))
			.slice(0, limit)
			.map(toTicker);
	}

	async getFundingRateHistory(symbol: string, limit = 20): Promise<FundingRateRecord[]> {
		if (this.marketType !== "usdm-futures")
			throw new Error("Funding rates are available only in USDⓈ-M futures mode");
		await this.ensureMarket(symbol);
		const records = await this.exchange.fetchFundingRateHistory(
			symbol,
			undefined,
			Math.min(Math.max(Math.floor(limit), 1), 100),
		);
		return records.map((record) => {
			const info = record.info as Record<string, unknown> | undefined;
			const rate =
				finiteFundingRate(record.fundingRate) ??
				finiteFundingRate(info?.fundingRate) ??
				finiteFundingRate(info?.lastFundingRate);
			const markPrice = finitePositive(info?.markPrice);
			return {
				symbol,
				fundingTime: finiteNonNegative(record.timestamp) ?? 0,
				...(rate !== undefined ? { rate } : {}),
				...(markPrice !== undefined ? { markPrice } : {}),
			};
		});
	}

	async getFundingRate(symbol: string): Promise<{ symbol: string; rate?: number; nextFundingTime?: number }> {
		if (this.marketType !== "usdm-futures")
			throw new Error("Funding rates are available only in USDⓈ-M futures mode");
		await this.ensureMarket(symbol);
		const funding = await this.exchange.fetchFundingRate(symbol);
		const info = funding.info as Record<string, unknown> | undefined;
		const rate =
			finiteFundingRate(funding.fundingRate) ??
			finiteFundingRate(info?.fundingRate) ??
			finiteFundingRate(info?.lastFundingRate);
		const nextFundingTime = finiteNonNegative(funding.nextFundingTimestamp);
		return {
			symbol,
			...(rate !== undefined && Number.isFinite(rate) ? { rate } : {}),
			...(nextFundingTime !== undefined ? { nextFundingTime } : {}),
		};
	}

	async setLeverage(symbol: string, leverage: number): Promise<void> {
		if (this.marketType !== "usdm-futures") throw new Error("Leverage is available only in USDⓈ-M futures mode");
		await this.ensureMarket(symbol);
		await this.ensurePositionMode();
		await this.exchange.setLeverage(leverage, symbol);
		this.leverageBySymbol.set(symbol, leverage);
		this.configuredFuturesSymbols.delete(symbol);
	}

	async setMultiAssetsMode(enabled: boolean): Promise<void> {
		if (this.marketType !== "usdm-futures" || this.id !== "binance" || this.mode !== "live") {
			throw new Error("Multi-Assets mode is available only for live Binance USDⓈ-M futures");
		}
		await this.ensureMarketsLoaded();
		await this.ensurePositionMode();
		try {
			const binancePrivate = this.exchange as Exchange & {
				fapiPrivatePostMultiAssetsMargin(params: { multiAssetsMargin: "true" | "false" }): Promise<unknown>;
			};
			await binancePrivate.fapiPrivatePostMultiAssetsMargin({ multiAssetsMargin: enabled ? "true" : "false" });
		} catch (error) {
			throw normalizeExchangeError(error, `Set Binance Multi-Assets mode ${enabled ? "on" : "off"}`);
		}
	}

	async setMarginMode(symbol: string, marginType: FuturesMarginType): Promise<void> {
		if (this.marketType !== "usdm-futures") throw new Error("Margin mode is available only in USDⓈ-M futures mode");
		await this.ensureMarket(symbol);
		await this.ensurePositionMode();
		await this.applyMarginMode(symbol, marginType);
		this.marginTypeBySymbol.set(symbol, marginType);
		this.configuredFuturesSymbols.delete(symbol);
	}

	private async ensureFuturesTradingSettings(symbol: string): Promise<void> {
		if (this.marketType !== "usdm-futures") return;
		await this.ensurePositionMode();
		if (this.configuredFuturesSymbols.has(symbol)) return;
		const marginType = this.marginTypeBySymbol.get(symbol) ?? this.defaultMarginType;
		const leverage = this.leverageBySymbol.get(symbol) ?? this.defaultLeverage;
		await this.applyMarginMode(symbol, marginType);
		await this.exchange.setLeverage(leverage, symbol);
		this.configuredFuturesSymbols.add(symbol);
	}

	private async ensurePositionMode(): Promise<void> {
		if (this.positionModeConfigured) return;
		try {
			await this.exchange.setPositionMode(this.positionMode === "hedge", undefined, { subType: "linear" });
		} catch (error) {
			if (!String(error).toLowerCase().includes("no need to change position side")) throw error;
		}
		this.positionModeConfigured = true;
	}

	private async applyMarginMode(symbol: string, marginType: FuturesMarginType): Promise<void> {
		try {
			await this.exchange.setMarginMode(marginType, symbol);
		} catch (error) {
			if (!String(error).toLowerCase().includes("no need to change margin type")) throw error;
		}
	}

	async close(): Promise<void> {
		await this.exchange.close();
	}

	private async ensureMarket(symbol: string) {
		await this.ensureMarketsLoaded();
		const market = this.exchange.markets[symbol];
		const validMarket =
			this.marketType === "usdm-futures"
				? market?.swap === true &&
					market?.settle === this.quoteCurrency &&
					market?.contract === true &&
					market?.linear === true &&
					market?.inverse !== true
				: market?.spot === true;
		if (!market || market.quote !== this.quoteCurrency || !validMarket || market.active === false) {
			throw new Error(`Unsupported ${this.marketType} market or quote currency: ${symbol}`);
		}
		if (this.marketType === "usdm-futures") this.contractSizeForMarket(market);
		this.knownSymbols.add(symbol);
		return market;
	}

	private async estimateQuoteValue(asset: string, amount: number): Promise<number | undefined> {
		if (asset === this.quoteCurrency) return amount;
		try {
			const ticker = await this.exchange.fetchTicker(`${asset}/${this.quoteCurrency}`);
			if (ticker.last === undefined || !Number.isFinite(ticker.last) || ticker.last <= 0) return undefined;
			const quoteValue = amount * ticker.last;
			return Number.isFinite(quoteValue) ? quoteValue : undefined;
		} catch {
			return undefined;
		}
	}
}
