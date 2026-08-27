import ccxt, { type Order as CcxtOrder, type Ticker as CcxtTicker, type Exchange } from "ccxt";
import type { ExchangeCredentials, FuturesMarginType, MarketType } from "../state.ts";
import type {
	Balance,
	ContractStats,
	ExchangeClient,
	Kline,
	MarketInfo,
	Order,
	OrderBook,
	PlaceOcoOrderInput,
	PlaceOcoOrderResult,
	PlaceOrderInput,
	PlaceOrderResult,
	Position,
	Ticker,
} from "./types.ts";

function toTicker(t: CcxtTicker): Ticker {
	return {
		symbol: t.symbol,
		last: t.last ?? 0,
		bid: t.bid ?? undefined,
		ask: t.ask ?? undefined,
		high24h: t.high,
		low24h: t.low,
		changePct24h: t.percentage,
		volume24h: t.baseVolume,
		quoteVolume24h: t.quoteVolume,
		timestamp: t.timestamp ?? Date.now(),
	};
}

function toOrder(o: CcxtOrder): Order {
	return {
		id: o.id,
		symbol: o.symbol,
		side: o.side as Order["side"],
		type: o.type as Order["type"],
		price: o.price,
		stopPrice: o.triggerPrice ?? o.stopPrice ?? o.stopLossPrice ?? o.takeProfitPrice,
		amount: o.amount ?? 0,
		filled: o.filled ?? 0,
		remaining: o.remaining ?? 0,
		average: o.average,
		cost: o.cost ?? 0,
		status: (o.status === "open" ? "open" : o.status === "canceled" ? "canceled" : "closed") as Order["status"],
		timestamp: o.timestamp ?? Date.now(),
	};
}

/** Live trading client backed by a ccxt exchange instance with API credentials. */
export class CcxtExchangeClient implements ExchangeClient {
	readonly mode = "live" as const;
	readonly id: string;
	readonly quoteCurrency: string;
	private readonly marketType: MarketType;

	private readonly exchange: Exchange;
	private marketsLoaded = false;

	constructor(id: string, quoteCurrency: string, credentials: ExchangeCredentials, marketType: MarketType = "spot") {
		this.id = id;
		this.quoteCurrency = quoteCurrency;
		this.marketType = marketType;
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
		return {
			symbol: market.symbol,
			base: market.base,
			quote: market.quote,
			settle: market.settle,
			marketType: market.swap ? "swap" : "spot",
			contract: market.contract,
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
		const markPrice = Number(info?.markPrice ?? NaN);
		const indexPrice = Number(info?.indexPrice ?? NaN);
		const stats: ContractStats = {
			symbol,
			lastPrice: ticker.last ?? undefined,
			markPrice: Number.isFinite(markPrice) ? markPrice : undefined,
			indexPrice: Number.isFinite(indexPrice) ? indexPrice : undefined,
			fundingRate: funding.fundingRate ?? undefined,
			nextFundingTime: funding.nextFundingTimestamp,
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
		return ohlcv.map((k) => ({
			timestamp: k[0] ?? 0,
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
				.map((p) => ({
					symbol: p.symbol,
					asset: p.symbol.split("/")[0],
					amount: Number(p.contracts ?? p.info?.positionAmt ?? 0),
					quoteValue:
						Math.abs(Number(p.contracts ?? p.info?.positionAmt ?? 0)) * Number(p.markPrice ?? p.entryPrice ?? 0),
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
				}));
		}
		const balances = await this.getBalances();
		return balances
			.filter((b) => b.asset !== this.quoteCurrency && b.quoteValue !== undefined && b.quoteValue > 1)
			.map((b) => ({
				symbol: `${b.asset}/${this.quoteCurrency}`,
				asset: b.asset,
				amount: b.total,
				quoteValue: b.quoteValue ?? 0,
			}));
	}

	async getOpenOrders(symbol?: string): Promise<Order[]> {
		// Some exchanges (e.g. okx) keep trigger/trailing "algo" orders in a
		// separate endpoint; fetch them best-effort and merge by order id.
		const merged = new Map<string, Order>();
		const orders = await this.exchange.fetchOpenOrders(symbol);
		for (const o of orders) merged.set(o.id, toOrder(o));
		for (const params of [{ trigger: true }, { trailing: true }]) {
			try {
				const algoOrders = await this.exchange.fetchOpenOrders(symbol, undefined, undefined, params);
				for (const o of algoOrders) if (!merged.has(o.id)) merged.set(o.id, toOrder(o));
			} catch {
				// Exchange has no separate algo-order endpoint or does not support the filter.
			}
		}
		return [...merged.values()];
	}

	async getOrderHistory(symbol?: string, limit = 50): Promise<Order[]> {
		const orders = await this.exchange.fetchClosedOrders(symbol, undefined, limit);
		return orders.map(toOrder);
	}

	async placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
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
			(input.trailingPercent === undefined || input.trailingPercent <= 0)
		) {
			throw new Error("trailing_stop_market orders require a positive trailingPercent");
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
		const minAmount = market.limits?.amount?.min;
		const minCost = market.limits?.cost?.min;
		if (minAmount !== undefined && numericAmount < minAmount)
			throw new Error(`Amount ${numericAmount} is below minimum ${minAmount} for ${input.symbol}`);
		if (
			minCost !== undefined &&
			numericAmount * (numericPrice ?? stopPrice ?? (await this.getTicker(input.symbol)).last) < minCost
		) {
			throw new Error(`Order cost is below minimum ${minCost} for ${input.symbol}`);
		}
		// Map order types onto ccxt's exchange-agnostic createOrder contract:
		// execution type market/limit plus unified trigger/trailing params.
		const execType = isLimitExec ? "limit" : "market";
		const isStop = input.type === "stop" || input.type === "stop_market";
		const params = {
			...(input.reduceOnly !== undefined ? { reduceOnly: input.reduceOnly } : {}),
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
			...(input.closePosition !== undefined ? { closePosition: input.closePosition } : {}),
		};
		const order = await this.exchange.createOrder(
			input.symbol,
			execType,
			input.side,
			numericAmount,
			numericPrice,
			params,
		);
		return { order: toOrder(order) };
	}

	async placeOcoOrder(input: PlaceOcoOrderInput): Promise<PlaceOcoOrderResult> {
		const market = await this.ensureMarket(input.symbol);
		if (!Number.isFinite(input.stopLossPrice) || input.stopLossPrice <= 0)
			throw new Error("stopLossPrice must be positive");
		if (!Number.isFinite(input.takeProfitPrice) || input.takeProfitPrice <= 0)
			throw new Error("takeProfitPrice must be positive");
		const amount = Number(this.exchange.amountToPrecision(input.symbol, input.amount));
		const stopLossPrice = Number(this.exchange.priceToPrecision(input.symbol, input.stopLossPrice));
		const takeProfitPrice = Number(this.exchange.priceToPrecision(input.symbol, input.takeProfitPrice));
		const last = (await this.getTicker(input.symbol)).last;
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
		try {
			// ccxt folds both trigger prices into a single one-cancels-the-other
			// order on exchanges that support it (e.g. okx ordType "oco").
			const order = await this.exchange.createOrder(input.symbol, "market", input.side, amount, undefined, {
				stopLossPrice,
				takeProfitPrice,
			});
			return { orders: [toOrder(order)] };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(
				`OCO order failed on ${this.id}: ${message}. Not every exchange supports one-order OCO via ccxt ` +
					`(okx does). Fall back to a separate stop_market and take_profit_market order and cancel the ` +
					`survivor manually after one fills.`,
			);
		}
	}

	async cancelOrder(id: string, symbol: string): Promise<void> {
		await this.ensureMarket(symbol);
		try {
			await this.exchange.cancelOrder(id, symbol);
		} catch (error) {
			// Trigger/trailing "algo" orders need dedicated cancel params on some
			// exchanges (e.g. okx); retry before giving up.
			for (const params of [{ trigger: true }, { trailing: true }]) {
				try {
					await this.exchange.cancelOrder(id, symbol, params);
					return;
				} catch {
					// Fall through to the original error.
				}
			}
			throw error;
		}
	}

	async getTopMarkets(limit: number): Promise<Ticker[]> {
		const tickers = await this.exchange.fetchTickers();
		const suffix = `/${this.quoteCurrency}`;
		return Object.values(tickers)
			.filter((t) => t.symbol.endsWith(suffix) && !t.symbol.includes(":"))
			.sort((a, b) => (b.quoteVolume ?? 0) - (a.quoteVolume ?? 0))
			.slice(0, limit)
			.map(toTicker);
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
		await this.exchange.setLeverage(leverage, symbol);
	}

	async setMarginMode(symbol: string, marginType: FuturesMarginType): Promise<void> {
		if (this.marketType !== "usdm-futures") throw new Error("Margin mode is available only in USDⓈ-M futures mode");
		await this.ensureMarket(symbol);
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
			throw new Error(`Unsupported spot market or quote currency: ${symbol}`);
		}
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
