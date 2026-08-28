import { randomBytes } from "node:crypto";
import ccxt, { type Order as CcxtOrder, type Ticker as CcxtTicker, type Trade as CcxtTrade, type Exchange } from "ccxt";
import type { ExchangeCredentials, FuturesMarginType, FuturesPositionMode, MarketType } from "../state.ts";
import { validateBinanceSpotFilters } from "./binance-spot-filters.ts";
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

function toOrder(o: CcxtOrder): Order {
	const info = (o.info ?? {}) as Record<string, unknown>;
	const trailingDelta = Number(info.trailingDelta);
	const callbackRate = Number(info.callbackRate ?? info.trailingPercent);
	const type = toOrderType(o);
	const rawGroup = info.orderListId ?? (type === "oco" ? (info.algoId ?? info.algoClOrdId) : undefined);
	return {
		id: o.id,
		clientOrderId: typeof info.clientOrderId === "string" ? info.clientOrderId : undefined,
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
		amount: (() => {
			const original = Number(info.origQty ?? info.quantity);
			return Number.isFinite(original) && original > 0 ? original : (o.amount ?? 0);
		})(),
		filled: o.filled ?? 0,
		remaining: o.remaining ?? 0,
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
		for (const trade of ordered) {
			const amount = Number(trade.amount);
			const price = Number(trade.price);
			if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(price) || price < 0) {
				incomplete = true;
				continue;
			}
			const notional = Number(trade.cost ?? amount * price);
			if (!Number.isFinite(notional)) {
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
			if (trade.side === "buy") {
				quantity += amount;
				cost += notional;
				if (feeCurrency === this.quoteCurrency) cost += feeCost;
				if (feeCurrency === symbol.split("/")[0]) quantity -= feeCost;
			} else {
				const inventoryBeforeSale = quantity;
				if (amount > inventoryBeforeSale + Math.max(1e-10, balance * 1e-8)) {
					incomplete = true;
					continue;
				}
				const removedCost = inventoryBeforeSale > 0 ? cost * (amount / inventoryBeforeSale) : 0;
				quantity -= amount;
				if (feeCurrency === symbol.split("/")[0]) quantity -= feeCost;
				cost -= removedCost;
			}
		}
		const tolerance = Math.max(1e-8, Math.abs(balance) * 1e-6);
		if (Math.abs(quantity - balance) > tolerance) incomplete = true;
		if (incomplete || quantity <= tolerance || cost <= 0)
			return {
				costBasisStatus: incomplete ? "partial" : "unavailable",
				costBasisReason: incomplete ? "Trade history or fees do not reconcile balance" : "No cost basis available",
			};
		const avgEntryPrice = cost / quantity;
		const last = (await this.exchange.fetchTicker(symbol)).last;
		const unrealizedPnl = last === undefined ? undefined : (last - avgEntryPrice) * balance;
		return {
			avgEntryPrice,
			unrealizedPnl,
			unrealizedPnlPct: unrealizedPnl === undefined ? undefined : (unrealizedPnl / cost) * 100,
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
		try {
			const interest = await this.exchange.fetchOpenInterest(symbol);
			openInterest = interest.openInterestAmount ?? interest.openInterestValue;
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
		if (this.exchange.options?.defaultType === "swap") {
			const positions = await this.exchange.fetchPositions();
			return positions
				.filter((p) => Number(p.contracts ?? p.info?.positionAmt ?? 0) !== 0)
				.map((p) => {
					this.knownSymbols.add(p.symbol);
					const amount = Math.abs(Number(p.contracts ?? p.info?.positionAmt ?? 0));
					return {
						symbol: p.symbol,
						asset: p.symbol.split("/")[0],
						amount,
						quoteValue: amount * Number(p.markPrice ?? p.entryPrice ?? 0),
						positionSide: (p.side === "long"
							? "LONG"
							: p.side === "short"
								? "SHORT"
								: "BOTH") as Position["positionSide"],
						leverage: Number(p.leverage ?? 0) || undefined,
						marginType: p.marginMode === "isolated" ? "isolated" : "cross",
						markPrice: p.markPrice ?? undefined,
						liquidationPrice: p.liquidationPrice ?? undefined,
						margin: p.initialMargin ?? undefined,
						avgEntryPrice: p.entryPrice ?? undefined,
						unrealizedPnl: p.unrealizedPnl ?? undefined,
						unrealizedPnlPct: p.percentage ?? undefined,
					};
				});
		}
		const balances = await this.getBalances();
		const positions: Position[] = [];
		for (const b of balances) {
			if (b.asset === this.quoteCurrency || b.quoteValue === undefined || b.quoteValue <= 1) continue;
			const symbol = `${b.asset}/${this.quoteCurrency}`;
			this.knownSymbols.add(symbol);
			const basis = await this.getSpotCostBasis(symbol, b.total);
			positions.push({ symbol, asset: b.asset, amount: b.total, quoteValue: b.quoteValue, ...basis });
		}
		return positions;
	}

	async getOpenOrders(symbol?: string): Promise<Order[]> {
		const merged = new Map<string, Order>();
		const orders = await this.exchange.fetchOpenOrders(symbol);
		for (const o of orders) {
			this.knownSymbols.add(o.symbol);
			merged.set(orderKey(o), toOrder(o));
		}
		if (this.id === "okx") {
			for (const params of [{ ordType: "conditional" }, { trigger: true }, { trailing: true }, { ordType: "oco" }]) {
				const algoOrders = await this.exchange.fetchOpenOrders(symbol, undefined, undefined, params);
				for (const o of algoOrders) {
					this.knownSymbols.add(o.symbol);
					const key = orderKey(o);
					if (!merged.has(key)) merged.set(key, toOrder(o));
				}
			}
		}
		return [...merged.values()];
	}

	async getOrderHistory(symbol?: string, limit = 50): Promise<Order[]> {
		if (symbol) this.knownSymbols.add(symbol);
		if (this.id === "binance") {
			const symbols = symbol ? [symbol] : [...this.knownSymbols];
			if (symbols.length === 0)
				throw new Error("Binance order history requires a symbol; query a market or pass symbol explicitly");
			const merged = new Map<string, Order>();
			for (const knownSymbol of symbols) {
				for (const rawOrder of await this.exchange.fetchOrders(knownSymbol, undefined, limit)) {
					const order = toOrder(rawOrder);
					if (order.status !== "open") merged.set(orderKey(order), order);
				}
			}
			return [...merged.values()].sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
		}
		const merged = new Map<string, Order>();
		for (const order of await this.exchange.fetchClosedOrders(symbol, undefined, limit)) {
			merged.set(orderKey(order), toOrder(order));
		}
		if (this.exchange.has.fetchCanceledOrders) {
			for (const order of await this.exchange.fetchCanceledOrders(symbol, undefined, limit)) {
				merged.set(orderKey(order), toOrder(order));
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
					if (!merged.has(key)) merged.set(key, toOrder(order));
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
						if (!merged.has(key)) merged.set(key, toOrder(order));
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
			return toOrder(this.exchange.parseOrder(raw as Record<string, unknown>, this.exchange.markets[symbol]));
		}
		if (!this.exchange.has.fetchOrder) throw new Error(`Order lookup is unsupported on ${this.id}`);
		return toOrder(await this.exchange.fetchOrder(id, symbol));
	}

	async getOrderByClientId(clientOrderId: string, symbol: string): Promise<Order> {
		await this.ensureMarket(symbol);
		if (this.id !== "binance" || this.marketType !== "spot")
			throw new Error(`Client id lookup is unsupported on ${this.id}`);
		const endpoint = (this.exchange as unknown as Record<string, unknown>).privateGetOrder;
		if (typeof endpoint !== "function") throw new Error("Binance Spot order query endpoint unavailable");
		const raw = await (endpoint as (params: Record<string, string>) => Promise<unknown>).call(this.exchange, {
			symbol: this.exchange.markets[symbol].id,
			origClientOrderId: clientOrderId,
		});
		return toOrder(this.exchange.parseOrder(raw as Record<string, unknown>, this.exchange.markets[symbol]));
	}

	async getOrderListByClientId(listClientOrderId: string): Promise<OrderList> {
		return this.fetchOrderList({ origClientOrderId: listClientOrderId });
	}

	async getOrderList(orderListId: string): Promise<OrderList> {
		return this.fetchOrderList({ orderListId });
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
		const amount = this.exchange.amountToPrecision(input.symbol, input.amount);
		const price =
			isLimitExec && input.price !== undefined
				? this.exchange.priceToPrecision(input.symbol, input.price)
				: undefined;
		const stopPrice =
			input.stopPrice !== undefined
				? Number(this.exchange.priceToPrecision(input.symbol, input.stopPrice))
				: undefined;
		const numericAmount = Number(amount);
		const numericPrice = price === undefined ? undefined : Number(price);
		// Binance Spot filters were validated above against the raw filter set.
		// Do not re-apply ccxt's coarse cost limit: it loses per-filter market
		// applicability and can use a trigger price as an execution reference.
		if (!(this.id === "binance" && this.marketType === "spot")) {
			const minAmount = market.limits?.amount?.min;
			const minCost = market.limits?.cost?.min;
			if (minAmount !== undefined && numericAmount < minAmount)
				throw new Error(`Amount ${numericAmount} is below minimum ${minAmount} for ${input.symbol}`);
			if (minCost !== undefined) {
				const referencePrice = numericPrice ?? (await this.getTicker(input.symbol)).last;
				if (referencePrice === undefined || referencePrice <= 0)
					throw new Error(`No reference price for ${input.symbol}`);
				if (numericAmount * referencePrice < minCost)
					throw new Error(`Order cost is below minimum ${minCost} for ${input.symbol}`);
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
					return { order: await this.getOrderByClientId(clientOrderId, input.symbol) };
				} catch (lookupError) {
					throw new Error(
						`Submission status unknown [errorCategory=SUBMISSION_STATUS_UNKNOWN] clientOrderId=${clientOrderId}. Do not retry; manually verify Binance order status. ${lookupError instanceof Error ? lookupError.message : String(lookupError)}`,
					);
				}
			}
		}
		// Map order types onto ccxt's exchange-agnostic createOrder contract:
		// execution type market/limit plus unified trigger/trailing params.
		const execType = isLimitExec ? "limit" : "market";
		const isStop = input.type === "stop" || input.type === "stop_market";
		// Binance rejects reduceOnly in hedge mode and on close-all triggers.
		const params = {
			...(this.id === "binance" && this.marketType === "spot"
				? { newClientOrderId: clientOrderId }
				: { clientOrderId }),
			...(input.reduceOnly !== undefined && this.positionMode !== "hedge" && !(input.closePosition && isTrigger)
				? { reduceOnly: input.reduceOnly }
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
			return { order: { ...toOrder(order), clientOrderId } };
		} catch (error) {
			if (!isUncertainSubmission(error)) throw normalizeExchangeError(error, "Order submission");
			try {
				return { order: await this.getOrderByClientId(clientOrderId, input.symbol) };
			} catch (lookupError) {
				throw new Error(
					`Submission status unknown [errorCategory=SUBMISSION_STATUS_UNKNOWN] clientOrderId=${clientOrderId}. Do not retry; manually verify Binance order status. ${lookupError instanceof Error ? lookupError.message : String(lookupError)}`,
				);
			}
		}
	}

	async placeOcoOrder(input: PlaceOcoOrderInput): Promise<PlaceOcoOrderResult> {
		if (this.marketType !== "spot") {
			throw new Error("Futures OCO orders are not supported; use one reduce-only protective order instead");
		}
		const market = await this.ensureMarket(input.symbol);
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
			return { orders: [toOrder(order)] };
		} catch (error) {
			if (this.id === "binance" && this.marketType === "spot" && isUncertainSubmission(error)) {
				try {
					const recovered = await this.getOrderListByClientId(listClientOrderId);
					return { orders: recovered.orders };
				} catch (lookupError) {
					throw new Error(
						`Submission status unknown [errorCategory=SUBMISSION_STATUS_UNKNOWN] listClientOrderId=${listClientOrderId}. Do not retry; manually verify Binance order list. ${lookupError instanceof Error ? lookupError.message : String(lookupError)}`,
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
		return records.map((record) => ({
			symbol,
			fundingTime: record.timestamp ?? 0,
			rate: record.fundingRate ?? 0,
			markPrice: Number.isFinite(Number((record.info as Record<string, unknown> | undefined)?.markPrice))
				? Number((record.info as Record<string, unknown>).markPrice)
				: undefined,
		}));
	}

	async getFundingRate(symbol: string): Promise<{ symbol: string; rate: number; nextFundingTime?: number }> {
		if (this.marketType !== "usdm-futures")
			throw new Error("Funding rates are available only in USDⓈ-M futures mode");
		await this.ensureMarket(symbol);
		const funding = await this.exchange.fetchFundingRate(symbol);
		return { symbol, rate: funding.fundingRate ?? 0, nextFundingTime: funding.nextFundingTimestamp };
	}

	async setLeverage(symbol: string, leverage: number): Promise<void> {
		if (this.marketType !== "usdm-futures") throw new Error("Leverage is available only in USDⓈ-M futures mode");
		await this.ensureMarket(symbol);
		await this.ensurePositionMode();
		await this.exchange.setLeverage(leverage, symbol);
		this.leverageBySymbol.set(symbol, leverage);
		this.configuredFuturesSymbols.delete(symbol);
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
		if (!this.marketsLoaded) {
			await this.exchange.loadMarkets();
			this.marketsLoaded = true;
		}
		const market = this.exchange.markets[symbol];
		const validMarket = this.marketType === "usdm-futures" ? market?.swap === true : market?.spot === true;
		if (!market || market.quote !== this.quoteCurrency || !validMarket) {
			throw new Error(`Unsupported ${this.marketType} market or quote currency: ${symbol}`);
		}
		this.knownSymbols.add(symbol);
		return market;
	}

	private async estimateQuoteValue(asset: string, amount: number): Promise<number | undefined> {
		if (asset === this.quoteCurrency) return amount;
		try {
			const ticker = await this.exchange.fetchTicker(`${asset}/${this.quoteCurrency}`);
			return ticker.last !== undefined ? amount * ticker.last : undefined;
		} catch {
			return undefined;
		}
	}
}
