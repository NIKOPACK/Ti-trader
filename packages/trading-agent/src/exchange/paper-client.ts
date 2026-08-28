import { join } from "node:path";
import ccxt, { type Ticker as CcxtTicker, type Exchange } from "ccxt";
import { PAPER_DIR, readJsonFile, writeJsonFile } from "../config.ts";
import type { FuturesPositionMode } from "../state.ts";
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
	type OrderType,
	type PlaceOcoOrderInput,
	type PlaceOcoOrderResult,
	type PlaceOrderInput,
	type PlaceOrderResult,
	type Position,
	type Ticker,
	timeframeDurationMs,
} from "./types.ts";

interface PaperOrder {
	id: string;
	symbol: string;
	side: "buy" | "sell";
	type: OrderType;
	price?: number;
	/** Trigger price for stop / take-profit orders. */
	stopPrice?: number;
	/** Trailing distance in percent for trailing stops. */
	trailingPercent?: number;
	/** Peak (sell) or trough (buy) price observed since placement (trailing stops). */
	trailingExtreme?: number;
	/** Set once a stop/take_profit limit order's trigger has fired and it rests as a limit order. */
	triggered?: boolean;
	/** Unit price used to reserve quote funds for resting buy orders. */
	reservePrice?: number;
	/** Last time this order's trigger was evaluated against the market. */
	lastCheckedAt?: number;
	/** Orders sharing an ocoGroup form a one-cancels-the-other pair with a single shared reservation. */
	ocoGroup?: string;
	clientOrderId?: string;
	listClientOrderId?: string;
	positionSide?: "BOTH" | "LONG" | "SHORT";
	reduceOnly?: boolean;
	closePosition?: boolean;
	amount: number;
	filled: number;
	average?: number;
	cost: number;
	status: "open" | "closed" | "canceled";
	timestamp: number;
}

interface PaperAccount {
	quote: string;
	/** asset -> free amount */
	balances: Record<string, number>;
	/** asset -> { amount, cost } for average-entry PnL */
	entries: Record<string, { amount: number; cost: number }>;
	orders: PaperOrder[];
	trades: Array<{
		id: string;
		symbol: string;
		side: "buy" | "sell";
		price: number;
		amount: number;
		cost: number;
		fee: number;
		realizedPnl?: number;
		positionSide?: "BOTH" | "LONG" | "SHORT";
		timestamp: number;
	}>;
	realizedPnl: number;
	leverage?: number;
	marginType?: "isolated" | "cross";
	positionMode?: FuturesPositionMode;
	createdAt: number;
}

function baseAsset(symbol: string, quote: string): string {
	const suffix = `/${quote}`;
	if (!symbol.endsWith(suffix)) {
		throw new Error(`Symbol "${symbol}" is not a ${quote} market`);
	}
	return symbol.slice(0, -suffix.length);
}

const TRIGGER_TYPES = ["stop", "stop_market", "take_profit", "take_profit_market"] as const;
type TriggerType = (typeof TRIGGER_TYPES)[number];

function isTriggerType(type: OrderType): type is TriggerType {
	return (TRIGGER_TYPES as readonly string[]).includes(type);
}

/**
 * Whether a stop/take-profit trigger fires at the given price.
 * stop: fires when the price moves against the position (sell: fall to trigger,
 * buy: rise to trigger). take_profit: fires when the price moves favourably
 * (sell: rise to trigger, buy: fall to trigger).
 */
function triggerFires(type: TriggerType, side: "buy" | "sell", price: number, stopPrice: number): boolean {
	const fallTo = type.startsWith("stop") ? side === "sell" : side === "buy";
	return fallTo ? price <= stopPrice : price >= stopPrice;
}

/** Current stop level of a trailing stop given its extreme price. */
function trailingStopLevel(side: "buy" | "sell", extreme: number, trailingPercent: number): number {
	return side === "sell" ? extreme * (1 - trailingPercent / 100) : extreme * (1 + trailingPercent / 100);
}

/**
 * A price-range segment of the market path since an order was last checked:
 * one kline (high/low) or the final ticker reading (a single point).
 */
interface PathSegment {
	high: number;
	low: number;
	/** True for the final single-price ticker segment. */
	tick?: boolean;
}

/** Where along a path an order fired, and the price it fills at. */
interface PathFire {
	index: number;
	price: number;
}

/**
 * Simulated spot account backed by live public market data.
 * Market orders fill at the last trade price; resting limit, stop, take-profit
 * and trailing stop orders fill lazily (checked on every account read) once the
 * market price crosses their limit/trigger level.
 */
export class PaperExchangeClient implements ExchangeClient {
	readonly mode = "paper" as const;
	readonly id: string;
	readonly quoteCurrency: string;
	readonly feeRate: number;

	private readonly exchange: Exchange;
	private readonly futuresExchange: Exchange;
	private readonly marketType: "spot" | "usdm-futures" | "both";
	private readonly accountPath: string;
	private readonly futuresAccountPath: string;
	private account: PaperAccount;
	private futuresAccount: PaperAccount;
	private nextOrderId: number;
	private futuresLeverage = 1;
	private futuresMarginType: "isolated" | "cross" = "isolated";
	private readonly positionMode: FuturesPositionMode;

	constructor(
		id: string,
		quoteCurrency: string,
		startQuote: number,
		feeRate: number,
		accountDir: string = PAPER_DIR,
		marketType: "spot" | "usdm-futures" | "both" = "spot",
		leverage = 1,
		marginType: "isolated" | "cross" = "isolated",
		positionMode: FuturesPositionMode = "one-way",
	) {
		this.id = id;
		this.quoteCurrency = quoteCurrency;
		this.feeRate = feeRate;
		this.marketType = marketType;
		this.positionMode = positionMode;
		this.futuresLeverage = leverage;
		this.futuresMarginType = marginType;
		const ExchangeClass = (ccxt as unknown as Record<string, new (cfg: object) => Exchange>)[id];
		if (!ExchangeClass) {
			throw new Error(`Unknown exchange "${id}". Check https://docs.ccxt.com for supported ids.`);
		}
		this.exchange = new ExchangeClass({ enableRateLimit: true });
		this.futuresExchange = new ExchangeClass({ enableRateLimit: true, options: { defaultType: "swap" } });
		this.accountPath = join(accountDir, `${id}-${quoteCurrency}.json`);
		this.futuresAccountPath = join(accountDir, `${id}-${quoteCurrency}-futures.json`);
		const stored = readJsonFile<PaperAccount>(this.accountPath);
		if (stored && stored.quote === quoteCurrency) {
			this.account = stored;
		} else {
			this.account = {
				quote: quoteCurrency,
				balances: { [quoteCurrency]: startQuote },
				entries: {},
				orders: [],
				trades: [],
				realizedPnl: 0,
				createdAt: Date.now(),
			};
			this.persist();
		}
		this.futuresAccount = readJsonFile<PaperAccount>(this.futuresAccountPath) ?? {
			quote: quoteCurrency,
			balances: { [quoteCurrency]: startQuote },
			entries: {},
			orders: [],
			trades: [],
			realizedPnl: 0,
			leverage,
			marginType,
			positionMode,
			createdAt: Date.now(),
		};
		const storedPositionMode = this.futuresAccount.positionMode ?? "one-way";
		if (
			storedPositionMode !== positionMode &&
			Object.values(this.futuresAccount.entries).some((entry) => entry.amount !== 0)
		) {
			throw new Error(
				`Paper futures account contains ${storedPositionMode} positions; reset it before switching to ${positionMode} mode`,
			);
		}
		this.futuresLeverage = this.futuresAccount.leverage ?? leverage;
		this.futuresMarginType = this.futuresAccount.marginType ?? marginType;
		this.futuresAccount.leverage = this.futuresLeverage;
		this.futuresAccount.marginType = this.futuresMarginType;
		this.futuresAccount.positionMode = positionMode;
		this.nextOrderId =
			Math.max(
				this.account.orders.length + this.account.trades.length,
				this.futuresAccount.orders.length + this.futuresAccount.trades.length,
			) + 1;
	}

	private isFuturesSymbol(symbol: string): boolean {
		return symbol.endsWith(`/${this.quoteCurrency}:${this.quoteCurrency}`);
	}
	private exchangeFor(symbol: string): Exchange {
		const futures = this.isFuturesSymbol(symbol);
		if ((this.marketType === "spot" && futures) || (this.marketType === "usdm-futures" && !futures)) {
			throw new Error(`${futures ? "Futures" : "Spot"} markets are disabled in ${this.marketType} mode`);
		}
		return futures ? this.futuresExchange : this.exchange;
	}
	private persistAll(): void {
		this.persist();
		writeJsonFile(this.futuresAccountPath, this.futuresAccount);
	}

	private async normalizeOrderInput(input: PlaceOrderInput): Promise<PlaceOrderInput> {
		const exchange = this.exchangeFor(input.symbol);
		await exchange.loadMarkets();
		const market = exchange.markets[input.symbol];
		const futures = this.isFuturesSymbol(input.symbol);
		if (!market || market.quote !== this.quoteCurrency || (futures ? market.swap !== true : market.spot !== true)) {
			throw new Error(`Unsupported ${futures ? "futures" : "spot"} market: ${input.symbol}`);
		}
		const amount = Number(exchange.amountToPrecision(input.symbol, input.amount));
		if (!Number.isFinite(amount) || amount <= 0) {
			throw new Error(`Amount ${input.amount} rounds to zero for ${input.symbol}`);
		}
		const price =
			input.price === undefined ? undefined : Number(exchange.priceToPrecision(input.symbol, input.price));
		const stopPrice =
			input.stopPrice === undefined ? undefined : Number(exchange.priceToPrecision(input.symbol, input.stopPrice));
		const minAmount = market.limits?.amount?.min;
		const maxAmount = market.limits?.amount?.max;
		if (minAmount !== undefined && amount < minAmount) {
			throw new Error(`Amount ${amount} is below minimum ${minAmount} for ${input.symbol}`);
		}
		if (maxAmount !== undefined && amount > maxAmount) {
			throw new Error(`Amount ${amount} exceeds maximum ${maxAmount} for ${input.symbol}`);
		}
		const tickerPrice = (await exchange.fetchTicker(input.symbol)).last;
		const referencePrice = price ?? stopPrice ?? tickerPrice;
		if (referencePrice === undefined || !Number.isFinite(referencePrice) || referencePrice <= 0) {
			throw new Error(`No price available for ${input.symbol}`);
		}
		const cost = amount * referencePrice;
		const minCost = market.limits?.cost?.min;
		const maxCost = market.limits?.cost?.max;
		if (minCost !== undefined && cost < minCost) {
			throw new Error(`Order cost ${cost} is below minimum ${minCost} for ${input.symbol}`);
		}
		if (maxCost !== undefined && cost > maxCost) {
			throw new Error(`Order cost ${cost} exceeds maximum ${maxCost} for ${input.symbol}`);
		}
		return { ...input, amount, price, stopPrice };
	}

	async getTicker(symbol: string): Promise<Ticker> {
		if (this.marketType === "spot" && this.isFuturesSymbol(symbol))
			throw new Error("Futures markets are disabled in spot mode");
		if (this.marketType === "usdm-futures" && !this.isFuturesSymbol(symbol))
			throw new Error("Spot markets are disabled in futures mode");
		return toTicker(await this.exchangeFor(symbol).fetchTicker(symbol));
	}

	async getOrderBook(symbol: string, limit = 20): Promise<OrderBook> {
		const book = await this.exchangeFor(symbol).fetchOrderBook(symbol, limit);
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
		const exchange = this.exchangeFor(symbol);
		await exchange.loadMarkets();
		const market = exchange.markets[symbol];
		const futures = this.isFuturesSymbol(symbol);
		if (
			(this.marketType === "spot" && futures) ||
			(this.marketType === "usdm-futures" && !futures) ||
			!market ||
			market.quote !== this.quoteCurrency ||
			(futures ? market.swap !== true : market.swap === true)
		)
			throw new Error(`Unsupported market: ${symbol}`);
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
		if (!this.isFuturesSymbol(symbol)) throw new Error("Contract stats require a futures symbol");
		const ticker = await this.futuresExchange.fetchTicker(symbol);
		const info = ticker.info as Record<string, unknown> | undefined;
		const markPrice = Number(info?.markPrice ?? NaN);
		const indexPrice = Number(info?.indexPrice ?? NaN);
		return {
			symbol,
			lastPrice: ticker.last ?? undefined,
			markPrice: Number.isFinite(markPrice) ? markPrice : undefined,
			indexPrice: Number.isFinite(indexPrice) ? indexPrice : undefined,
		};
	}

	async getKlines(symbol: string, timeframe: string, limit: number): Promise<Kline[]> {
		const ohlcv = await this.exchangeFor(symbol).fetchOHLCV(symbol, timeframe, undefined, limit);
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
		await this.settleOpenOrders();
		if (this.marketType === "usdm-futures") return this.futuresBalances();
		const result: Balance[] = [];
		for (const [asset, free] of Object.entries(this.account.balances)) {
			const used = this.reservedAmount(asset);
			if (free <= 0 && used <= 0) continue;
			result.push({
				asset,
				free,
				used,
				total: free + used,
				quoteValue: await this.estimateQuoteValue(asset, free + used),
			});
		}
		if (this.marketType === "both") {
			for (const balance of await this.futuresBalances()) {
				result.push({ ...balance, asset: `futures:${balance.asset}` });
			}
		}
		return result;
	}

	async getPositions(): Promise<Position[]> {
		await this.settleOpenOrders();
		if (this.marketType === "usdm-futures") return this.futuresPositions();
		const result: Position[] = [];
		for (const [asset, entry] of Object.entries(this.account.entries)) {
			const held = (this.account.balances[asset] ?? 0) + this.reservedAmount(asset);
			if (held <= 0) continue;
			const price = await this.tryPrice(asset);
			if (price === undefined) continue;
			const quoteValue = held * price;
			if (quoteValue <= 1) continue;
			const avgEntryPrice = entry.amount > 0 ? entry.cost / entry.amount : undefined;
			const unrealizedPnl = avgEntryPrice !== undefined ? (price - avgEntryPrice) * held : undefined;
			result.push({
				symbol: `${asset}/${this.quoteCurrency}`,
				asset,
				amount: held,
				quoteValue,
				avgEntryPrice,
				unrealizedPnl,
				unrealizedPnlPct:
					avgEntryPrice !== undefined && avgEntryPrice > 0 ? (price / avgEntryPrice - 1) * 100 : undefined,
			});
		}
		if (this.marketType === "both") result.push(...(await this.futuresPositions()));
		return result;
	}

	async getOpenOrders(symbol?: string): Promise<Order[]> {
		await this.settleOpenOrders();
		const accounts = symbol
			? [this.isFuturesSymbol(symbol) ? this.futuresAccount : this.account]
			: this.marketType === "spot"
				? [this.account]
				: this.marketType === "usdm-futures"
					? [this.futuresAccount]
					: [this.account, this.futuresAccount];
		return accounts
			.flatMap((account) => account.orders)
			.filter((order) => order.status === "open" && (!symbol || order.symbol === symbol))
			.map(toOrder);
	}

	async getOrderHistory(symbol?: string, limit = 50): Promise<Order[]> {
		await this.settleOpenOrders();
		const accounts = symbol
			? [this.isFuturesSymbol(symbol) ? this.futuresAccount : this.account]
			: this.marketType === "spot"
				? [this.account]
				: this.marketType === "usdm-futures"
					? [this.futuresAccount]
					: [this.account, this.futuresAccount];
		return accounts
			.flatMap((account) => account.orders)
			.filter((order) => order.status !== "open" && (!symbol || order.symbol === symbol))
			.sort((a, b) => b.timestamp - a.timestamp)
			.slice(0, limit)
			.map(toOrder);
	}

	async getOrderByClientId(clientOrderId: string, symbol: string): Promise<Order> {
		await this.settleOpenOrders();
		const account = this.isFuturesSymbol(symbol) ? this.futuresAccount : this.account;
		const order = account.orders.find(
			(candidate) => candidate.clientOrderId === clientOrderId && candidate.symbol === symbol,
		);
		if (!order) throw new Error(`Order client id ${clientOrderId} on ${symbol} not found`);
		return toOrder(order);
	}

	async getOrder(id: string, symbol: string): Promise<Order> {
		await this.settleOpenOrders();
		const account = this.isFuturesSymbol(symbol) ? this.futuresAccount : this.account;
		const order = account.orders.find((candidate) => candidate.id === id && candidate.symbol === symbol);
		if (!order) throw new Error(`Order ${id} on ${symbol} not found`);
		return toOrder(order);
	}

	async getOrderListByClientId(listClientOrderId: string): Promise<OrderList> {
		await this.settleOpenOrders();
		const orders = [...this.account.orders, ...this.futuresAccount.orders].filter(
			(order) => order.listClientOrderId === listClientOrderId,
		);
		if (orders.length === 0) throw new Error(`Order list ${listClientOrderId} not found`);
		return this.orderListFromOrders(listClientOrderId, orders);
	}

	async getOrderList(orderListId: string): Promise<OrderList> {
		await this.settleOpenOrders();
		const orders = [...this.account.orders, ...this.futuresAccount.orders].filter(
			(order) => order.ocoGroup === orderListId,
		);
		if (orders.length === 0) throw new Error(`Order list ${orderListId} not found`);
		return this.orderListFromOrders(orderListId, orders);
	}

	private orderListFromOrders(orderListId: string, orders: PaperOrder[]): OrderList {
		const mapped = orders.map(toOrder);
		const status = mapped.some((order) => order.status === "open")
			? "open"
			: mapped.some((order) => order.status === "closed")
				? "closed"
				: "canceled";
		return {
			id: orderListId,
			listOrderStatus: status === "open" ? "EXECUTING" : "ALL_DONE",
			status,
			orders: mapped,
		};
	}

	async placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
		if (this.isFuturesSymbol(input.symbol)) {
			if (this.marketType === "spot") throw new Error("Futures markets are disabled in spot mode");
			return this.placeFuturesMarketOrder(await this.normalizeOrderInput(input));
		}
		if (this.marketType === "usdm-futures") throw new Error("Spot markets are disabled in futures mode");
		input = await this.normalizeOrderInput(input);
		input = { ...input, clientOrderId: input.clientOrderId ?? `paper-${this.nextOrderId}` };
		await this.settleOpenOrders();
		baseAsset(input.symbol, this.quoteCurrency); // validates market
		if (input.amount <= 0) throw new Error("Amount must be positive");
		if (input.reduceOnly !== undefined || input.positionSide !== undefined || input.closePosition !== undefined) {
			throw new Error(
				"reduceOnly, positionSide and closePosition are futures-only parameters (live Binance USDⓈ-M)",
			);
		}

		if (input.type === "market") {
			const ticker = await this.exchange.fetchTicker(input.symbol);
			const price = ticker.last;
			if (price === undefined || price <= 0) throw new Error(`No price available for ${input.symbol}`);
			const fill = this.executeFill(input.symbol, input.side, input.amount, price);
			return {
				order: toOrder(fill.order),
				fee: fill.fee,
			};
		}

		const order: PaperOrder = {
			id: String(this.nextOrderId),
			clientOrderId: input.clientOrderId,
			symbol: input.symbol,
			side: input.side,
			type: input.type,
			amount: input.amount,
			filled: 0,
			cost: 0,
			status: "open",
			timestamp: Date.now(),
		};

		if (input.type === "limit") {
			if (input.price === undefined || input.price <= 0) {
				throw new Error("Limit orders require a positive price");
			}
			order.price = input.price;
			order.reservePrice = input.price;
		} else if (isTriggerType(input.type)) {
			if (input.stopPrice === undefined || input.stopPrice <= 0) {
				throw new Error(`${input.type} orders require a positive stopPrice`);
			}
			const isLimit = input.type === "stop" || input.type === "take_profit";
			if (isLimit && (input.price === undefined || input.price <= 0)) {
				throw new Error(`${input.type} orders require a positive limit price`);
			}
			const last = await this.lastPrice(input.symbol);
			if (triggerFires(input.type, input.side, last, input.stopPrice)) {
				throw new Error(
					`Order would trigger immediately: ${input.side} ${input.type} at trigger ${input.stopPrice} with last price ${last}`,
				);
			}
			order.stopPrice = input.stopPrice;
			if (isLimit) order.price = input.price;
			// Market-trigger fills happen at the trigger price; limit variants at the limit price.
			order.reservePrice = isLimit ? input.price : input.stopPrice;
		} else if (input.type === "trailing_stop_market") {
			const percent = input.trailingPercent;
			if (percent === undefined || !Number.isFinite(percent) || percent <= 0 || percent >= 100) {
				throw new Error("trailing_stop_market orders require trailingPercent in (0, 100)");
			}
			if (input.stopPrice !== undefined) {
				throw new Error(
					"Activation stopPrice for trailing stops is not supported in paper mode; use trailingPercent only",
				);
			}
			const last = await this.lastPrice(input.symbol);
			order.trailingPercent = percent;
			order.trailingExtreme = last;
			// A buy trailing stop level only falls as the trough falls, so the
			// level at placement is the maximum possible fill price.
			order.reservePrice = trailingStopLevel(input.side, last, percent);
		} else {
			throw new Error(`Unsupported order type: ${input.type}`);
		}

		// Reserve funds/assets up-front so concurrent orders cannot overspend.
		this.reserve(input.side, input.symbol, input.amount, order.reservePrice ?? 0);
		order.lastCheckedAt = order.timestamp;
		this.nextOrderId++;
		this.account.orders.push(order);
		this.persist();
		return { order: toOrder(order) };
	}

	async placeOcoOrder(input: PlaceOcoOrderInput): Promise<PlaceOcoOrderResult> {
		if (this.isFuturesSymbol(input.symbol))
			throw new Error("Paper futures OCO orders are not supported; use market orders");
		await this.settleOpenOrders();
		baseAsset(input.symbol, this.quoteCurrency); // validates market
		if (input.amount <= 0) throw new Error("Amount must be positive");
		const normalized = await this.normalizeOrderInput({
			symbol: input.symbol,
			side: input.side,
			type: "market",
			amount: input.amount,
		});
		const amount = normalized.amount;
		const stopLossPrice = Number(this.exchange.priceToPrecision(input.symbol, input.stopLossPrice));
		const takeProfitPrice = Number(this.exchange.priceToPrecision(input.symbol, input.takeProfitPrice));
		if (!Number.isFinite(stopLossPrice) || stopLossPrice <= 0) throw new Error("stopLossPrice must be positive");
		if (!Number.isFinite(takeProfitPrice) || takeProfitPrice <= 0)
			throw new Error("takeProfitPrice must be positive");
		const last = await this.lastPrice(input.symbol);
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

		const group = `oco-${this.nextOrderId}`;
		const listClientOrderId = input.listClientOrderId ?? `paper-list-${this.nextOrderId}`;
		const now = Date.now();
		// Buys reserve quote at the worst-case (higher) trigger; sells reserve base once.
		const reservePrice = Math.max(stopLossPrice, takeProfitPrice);
		const makeLeg = (type: OrderType, stopPrice: number, clientOrderId?: string): PaperOrder => ({
			id: String(this.nextOrderId++),
			clientOrderId,
			listClientOrderId,
			symbol: input.symbol,
			side: input.side,
			type,
			stopPrice,
			reservePrice,
			ocoGroup: group,
			amount,
			filled: 0,
			cost: 0,
			status: "open",
			timestamp: now,
			lastCheckedAt: now,
		});
		// Stop-loss leg first: on a candle that crosses both triggers, the
		// conservative (loss) leg wins.
		const stopLeg = makeLeg("stop_market", stopLossPrice, input.belowClientOrderId);
		const profitLeg = makeLeg("take_profit_market", takeProfitPrice, input.aboveClientOrderId);
		this.reserve(input.side, input.symbol, amount, reservePrice);
		this.account.orders.push(stopLeg, profitLeg);
		this.persist();
		return { orders: [toOrder(stopLeg), toOrder(profitLeg)] };
	}

	private async placeFuturesMarketOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
		if (input.type !== "market") throw new Error("Paper futures currently support market orders only");
		if (input.amount <= 0) throw new Error("Amount must be positive");
		if (input.closePosition && input.reduceOnly === false) throw new Error("closePosition is always reduceOnly");
		const ticker = await this.futuresExchange.fetchTicker(input.symbol);
		const price = ticker.last;
		if (price === undefined || price <= 0) throw new Error(`No price available for ${input.symbol}`);
		const account = this.futuresAccount;
		const asset = baseAsset(input.symbol, `${this.quoteCurrency}:${this.quoteCurrency}`);
		const positionSide = this.resolveFuturesPositionSide(input.positionSide);
		const entryKey = this.futuresEntryKey(asset, positionSide);
		const current = account.entries[entryKey] ?? { amount: 0, cost: 0 };
		const currentQty = Math.abs(current.amount);
		const currentAvg = currentQty > 0 ? current.cost / currentQty : 0;
		const requested = input.closePosition ? currentQty : input.amount;
		const signed = input.side === "buy" ? requested : -requested;
		const reducing = currentQty > 0 && Math.sign(signed) !== Math.sign(current.amount);
		if (input.closePosition && (!reducing || currentQty === 0)) {
			throw new Error("closePosition requires an open position and the matching reduce side");
		}
		if (input.reduceOnly) {
			if (currentQty === 0) throw new Error("reduceOnly order requires an open futures position");
			if (!reducing) throw new Error("reduceOnly order cannot increase the position");
			if (requested > currentQty) throw new Error("reduceOnly order amount exceeds the open position");
		}
		if (this.positionMode === "hedge") {
			const openingSide = positionSide === "LONG" ? "buy" : "sell";
			if (currentQty === 0 && input.side !== openingSide) {
				throw new Error(`${input.side} cannot open a ${positionSide} position in hedge mode`);
			}
			if (reducing && requested > currentQty) {
				throw new Error(`Order amount exceeds the open ${positionSide} position`);
			}
		}
		const closing = reducing ? Math.min(currentQty, requested) : 0;
		const pnl = closing * (price - currentAvg) * Math.sign(current.amount);
		const notional = requested * price;
		const fee = notional * this.feeRate;
		const releasedMargin = (closing * currentAvg) / this.futuresLeverage;
		const remaining = current.amount + signed;
		const opening = requested - closing;
		const openingMargin = (opening * price) / this.futuresLeverage;
		const available = account.balances[this.quoteCurrency] ?? 0;
		if (available + releasedMargin + pnl < fee + openingMargin) throw new Error("Insufficient futures margin");
		account.balances[this.quoteCurrency] = available + releasedMargin + pnl - fee - openingMargin;
		if (remaining === 0) delete account.entries[entryKey];
		else {
			const sameDirection = currentQty === 0 || !reducing;
			account.entries[entryKey] = {
				amount: remaining,
				cost: sameDirection
					? current.cost + requested * price
					: Math.sign(remaining) === Math.sign(current.amount)
						? Math.abs(remaining) * currentAvg
						: Math.abs(remaining) * price,
			};
		}
		account.realizedPnl += pnl;
		const order: PaperOrder = {
			id: String(this.nextOrderId++),
			symbol: input.symbol,
			side: input.side,
			type: "market",
			positionSide,
			reduceOnly: input.reduceOnly,
			closePosition: input.closePosition,
			amount: requested,
			filled: requested,
			average: price,
			cost: notional,
			status: "closed",
			timestamp: Date.now(),
		};
		account.orders.push(order);
		account.trades.push({
			id: order.id,
			symbol: input.symbol,
			side: input.side,
			price,
			amount: requested,
			cost: notional,
			fee,
			realizedPnl: pnl,
			positionSide,
			timestamp: order.timestamp,
		});
		this.persistAll();
		return { order: toOrder(order), fee };
	}

	private resolveFuturesPositionSide(positionSide: PlaceOrderInput["positionSide"]): "BOTH" | "LONG" | "SHORT" {
		if (this.positionMode === "hedge") {
			if (positionSide !== "LONG" && positionSide !== "SHORT") {
				throw new Error("Hedge mode futures orders require positionSide LONG or SHORT");
			}
			return positionSide;
		}
		if (positionSide !== undefined && positionSide !== "BOTH") {
			throw new Error("One-way mode futures orders must use positionSide BOTH or omit it");
		}
		return "BOTH";
	}

	private futuresEntryKey(asset: string, positionSide: "BOTH" | "LONG" | "SHORT"): string {
		return this.positionMode === "hedge" ? `${asset}:${positionSide}` : asset;
	}

	async cancelOrder(id: string, symbol: string): Promise<void> {
		const account = this.isFuturesSymbol(symbol) ? this.futuresAccount : this.account;
		const order = account.orders.find((o) => o.id === id && o.symbol === symbol && o.status === "open");
		if (!order) throw new Error(`Open order ${id} on ${symbol} not found`);
		order.status = "canceled";
		this.releaseReservation(order);
		// Cancelling one OCO leg cancels the whole group; the shared
		// reservation was already released above.
		if (order.ocoGroup) {
			for (const sibling of account.orders) {
				if (sibling.ocoGroup === order.ocoGroup && sibling.status === "open") sibling.status = "canceled";
			}
		}
		this.persistAll();
	}

	async cancelOrderList(orderListId: string, symbol: string): Promise<void> {
		const account = this.isFuturesSymbol(symbol) ? this.futuresAccount : this.account;
		const orders = account.orders.filter(
			(order) => order.ocoGroup === orderListId && order.symbol === symbol && order.status === "open",
		);
		if (orders.length === 0) throw new Error(`Open order list ${orderListId} on ${symbol} not found`);
		this.releaseReservation(orders[0]);
		for (const order of orders) order.status = "canceled";
		this.persistAll();
	}

	async getFundingRateHistory(symbol: string, _limit = 20): Promise<FundingRateRecord[]> {
		if (!this.isFuturesSymbol(symbol) || this.marketType === "spot")
			throw new Error("Paper futures funding requires a futures symbol");
		return [];
	}

	async getFundingRate(symbol: string): Promise<{ symbol: string; rate: number; nextFundingTime?: number }> {
		if (!this.isFuturesSymbol(symbol) || this.marketType === "spot")
			throw new Error("Paper futures funding requires a futures symbol");
		return { symbol, rate: 0, nextFundingTime: undefined };
	}

	async setLeverage(symbol: string, leverage: number): Promise<void> {
		if (!this.isFuturesSymbol(symbol)) throw new Error("Leverage requires a futures symbol");
		if (!Number.isInteger(leverage) || leverage < 1 || leverage > 125) throw new Error("Invalid leverage");
		this.futuresLeverage = leverage;
		this.futuresAccount.leverage = leverage;
		this.persistAll();
	}

	async setMarginMode(symbol: string, marginType: "isolated" | "cross"): Promise<void> {
		if (!this.isFuturesSymbol(symbol)) throw new Error("Margin mode requires a futures symbol");
		this.futuresMarginType = marginType;
		this.futuresAccount.marginType = marginType;
		this.persistAll();
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

	async close(): Promise<void> {
		await this.exchange.close();
		if (this.futuresExchange !== this.exchange) await this.futuresExchange.close();
	}

	/** Wipe the simulated account and start over with the given quote balance. */
	resetAccount(startQuote: number): void {
		if (!Number.isFinite(startQuote) || startQuote <= 0) {
			throw new Error("startQuote must be a positive number");
		}
		this.account = {
			quote: this.quoteCurrency,
			balances: { [this.quoteCurrency]: startQuote },
			entries: {},
			orders: [],
			trades: [],
			realizedPnl: 0,
			createdAt: Date.now(),
		};
		this.futuresAccount = {
			quote: this.quoteCurrency,
			balances: { [this.quoteCurrency]: startQuote },
			entries: {},
			orders: [],
			trades: [],
			realizedPnl: 0,
			leverage: this.futuresLeverage,
			marginType: this.futuresMarginType,
			positionMode: this.positionMode,
			createdAt: Date.now(),
		};
		this.nextOrderId = 1;
		this.persistAll();
	}

	// --- internals -----------------------------------------------------------

	private futuresBalances(): Promise<Balance[]> {
		const free = this.futuresAccount.balances[this.quoteCurrency] ?? 0;
		return Promise.resolve([{ asset: this.quoteCurrency, free, used: 0, total: free, quoteValue: free }]);
	}

	private async futuresPositions(): Promise<Position[]> {
		const result: Position[] = [];
		for (const [entryKey, entry] of Object.entries(this.futuresAccount.entries)) {
			if (entry.amount === 0) continue;
			const separator = entryKey.lastIndexOf(":");
			const positionSide =
				this.positionMode === "hedge" && separator > 0
					? (entryKey.slice(separator + 1) as "LONG" | "SHORT")
					: entry.amount > 0
						? "LONG"
						: "SHORT";
			const asset = this.positionMode === "hedge" && separator > 0 ? entryKey.slice(0, separator) : entryKey;
			const symbol = `${asset}/${this.quoteCurrency}:${this.quoteCurrency}`;
			const ticker = await this.futuresExchange.fetchTicker(symbol);
			const mark = ticker.last;
			if (mark === undefined) continue;
			const avg = entry.cost / Math.abs(entry.amount);
			const pnl = (mark - avg) * entry.amount;
			result.push({
				symbol,
				asset,
				amount: Math.abs(entry.amount),
				quoteValue: Math.abs(entry.amount) * mark,
				positionSide,
				leverage: this.futuresLeverage,
				marginType: this.futuresMarginType,
				markPrice: mark,
				margin: (Math.abs(entry.amount) * avg) / this.futuresLeverage,
				avgEntryPrice: avg,
				unrealizedPnl: pnl,
				unrealizedPnlPct:
					Math.abs(entry.amount) * avg > 0 ? (pnl / (Math.abs(entry.amount) * avg)) * 100 : undefined,
			});
		}
		return result;
	}

	private reservedAmount(asset: string): number {
		let used = 0;
		const seenGroups = new Set<string>();
		for (const o of this.account.orders) {
			if (o.status !== "open") continue;
			// OCO legs share one reservation; count each group once.
			if (o.ocoGroup) {
				if (seenGroups.has(o.ocoGroup)) continue;
				seenGroups.add(o.ocoGroup);
			}
			const unitPrice = o.reservePrice ?? o.price;
			if (o.side === "buy" && asset === this.quoteCurrency && unitPrice !== undefined) {
				used += (o.amount - o.filled) * unitPrice * (1 + this.feeRate);
			} else if (o.side === "sell" && baseAsset(o.symbol, this.quoteCurrency) === asset) {
				used += o.amount - o.filled;
			}
		}
		return used;
	}

	private reserve(side: "buy" | "sell", symbol: string, amount: number, unitPrice: number): void {
		if (side === "buy") {
			if (unitPrice <= 0) throw new Error("Cannot reserve quote funds without a positive reserve price");
			const cost = amount * unitPrice * (1 + this.feeRate);
			const free = this.account.balances[this.quoteCurrency] ?? 0;
			if (free < cost) {
				throw new Error(
					`Insufficient ${this.quoteCurrency}: need ${cost.toFixed(2)}, have ${free.toFixed(2)} (paper account)`,
				);
			}
			this.account.balances[this.quoteCurrency] = free - cost;
		} else {
			const asset = baseAsset(symbol, this.quoteCurrency);
			const free = this.account.balances[asset] ?? 0;
			if (free < amount) {
				throw new Error(`Insufficient ${asset}: need ${amount}, have ${free} (paper account)`);
			}
			this.account.balances[asset] = free - amount;
		}
	}

	private releaseReservation(order: PaperOrder): void {
		const remaining = order.amount - order.filled;
		if (order.side === "buy") {
			const unitPrice = order.reservePrice ?? order.price;
			if (unitPrice === undefined) return;
			this.credit(this.quoteCurrency, remaining * unitPrice * (1 + this.feeRate));
		} else {
			this.credit(baseAsset(order.symbol, this.quoteCurrency), remaining);
		}
	}

	private credit(asset: string, amount: number): void {
		this.account.balances[asset] = (this.account.balances[asset] ?? 0) + amount;
	}

	/** Fill a (market) order immediately at the given price. */
	private executeFill(symbol: string, side: "buy" | "sell", amount: number, price: number) {
		const asset = baseAsset(symbol, this.quoteCurrency);
		const notional = amount * price;
		const fee = notional * this.feeRate;
		let realizedPnl: number | undefined;

		if (side === "buy") {
			const totalCost = notional + fee;
			const free = this.account.balances[this.quoteCurrency] ?? 0;
			if (free < totalCost) {
				throw new Error(
					`Insufficient ${this.quoteCurrency}: need ${totalCost.toFixed(2)} (incl. fee), have ${free.toFixed(2)} (paper account)`,
				);
			}
			this.account.balances[this.quoteCurrency] = free - totalCost;
			this.credit(asset, amount);
			const entry = this.account.entries[asset] ?? { amount: 0, cost: 0 };
			entry.amount += amount;
			entry.cost += totalCost;
			this.account.entries[asset] = entry;
		} else {
			const free = this.account.balances[asset] ?? 0;
			if (free < amount) {
				throw new Error(`Insufficient ${asset}: need ${amount}, have ${free} (paper account)`);
			}
			this.account.balances[asset] = free - amount;
			this.credit(this.quoteCurrency, notional - fee);
			const entry = this.account.entries[asset];
			if (entry && entry.amount > 0) {
				const entryPrice = entry.cost / entry.amount;
				const closing = Math.min(amount, entry.amount);
				realizedPnl = (price - entryPrice) * closing - fee;
				this.account.realizedPnl += realizedPnl;
				entry.amount -= closing;
				entry.cost -= entryPrice * closing;
				if (entry.amount <= 1e-12) delete this.account.entries[asset];
			}
		}

		const order: PaperOrder = {
			id: String(this.nextOrderId++),
			symbol,
			side,
			type: "market",
			amount,
			filled: amount,
			average: price,
			cost: notional,
			status: "closed",
			timestamp: Date.now(),
		};
		this.account.orders.push(order);
		this.account.trades.push({
			id: order.id,
			symbol,
			side,
			price,
			amount,
			cost: notional,
			fee,
			realizedPnl,
			timestamp: order.timestamp,
		});
		this.persist();
		return { order, fee };
	}

	/**
	 * Lazily settle resting orders: fill limit orders whose price has been
	 * crossed, fire stop/take-profit triggers, and advance trailing stops.
	 * Between account reads the market path is reconstructed from klines, so
	 * spikes that fall inside the gap still count for every resting order.
	 */
	private async settleOpenOrders(): Promise<void> {
		const open = this.account.orders.filter((o) => o.status === "open");
		if (open.length === 0) return;
		const now = Date.now();
		const tickers = new Map<string, CcxtTicker>();
		const candleCache = new Map<string, Kline[]>();
		// One kline fetch per symbol covers all its orders: use the earliest gap.
		const minSince = new Map<string, number>();
		for (const o of open) {
			const since = o.lastCheckedAt ?? o.timestamp;
			minSince.set(o.symbol, Math.min(minSince.get(o.symbol) ?? since, since));
		}
		let dirty = false;
		for (const order of open) {
			if (order.status !== "open") continue; // cancelled as an OCO sibling earlier in this pass
			try {
				let ticker = tickers.get(order.symbol);
				if (!ticker) {
					ticker = await this.exchange.fetchTicker(order.symbol);
					tickers.set(order.symbol, ticker);
				}
				const last = ticker.last;
				if (last === undefined) continue;
				const path = await this.marketPath(order, last, now, minSince, candleCache);

				if (order.ocoGroup) {
					// Evaluate all legs of the group against the same path and fill
					// the leg that fired earliest (ties go to the stop-loss leg,
					// which is placed first).
					const legs = open.filter((o) => o.ocoGroup === order.ocoGroup && o.status === "open");
					let winner: { leg: PaperOrder; fire: PathFire } | undefined;
					for (const leg of legs) {
						const fire = this.evaluatePath(leg, path);
						leg.lastCheckedAt = now;
						if (fire && (!winner || fire.index < winner.fire.index)) winner = { leg, fire };
					}
					dirty = true;
					if (winner) this.fillRestingOrder(winner.leg, winner.fire.price);
					continue;
				}

				const fire = this.evaluatePath(order, path);
				order.lastCheckedAt = now;
				dirty = true;
				if (fire) this.fillRestingOrder(order, fire.price);
			} catch (error) {
				if (dirty) this.persist();
				throw new Error(
					`Failed to settle paper order ${order.id} on ${order.symbol}: ${error instanceof Error ? error.message : String(error)}`,
					{ cause: error },
				);
			}
		}
		if (dirty) this.persist();
	}

	/**
	 * Build the market path since the order was last checked: gap klines
	 * (when the gap exceeds two minutes) followed by the current ticker price.
	 */
	private async marketPath(
		order: PaperOrder,
		last: number,
		now: number,
		minSince: Map<string, number>,
		candleCache: Map<string, Kline[]>,
	): Promise<PathSegment[]> {
		const since = order.lastCheckedAt ?? order.timestamp;
		const path: PathSegment[] = [];
		if ((now - since) / 60_000 > 2) {
			let candles = candleCache.get(order.symbol);
			if (!candles) {
				const fetchSince = minSince.get(order.symbol) ?? since;
				const gapMinutes = (now - fetchSince) / 60_000;
				const timeframe = gapMinutes <= 400 ? "1m" : gapMinutes <= 6000 ? "15m" : "1h";
				const minutesPerCandle = timeframe === "1m" ? 1 : timeframe === "15m" ? 15 : 60;
				const limit = Math.min(Math.ceil(gapMinutes / minutesPerCandle) + 2, 500);
				const ohlcv = await this.exchange.fetchOHLCV(order.symbol, timeframe, fetchSince, limit);
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
			for (const k of candles) {
				if (k.timestamp < since) continue; // candle predates this order's window
				if (k.high <= 0 || k.low <= 0) continue;
				path.push({ high: k.high, low: k.low });
			}
		}
		path.push({ high: last, low: last, tick: true });
		return path;
	}

	/**
	 * Walk an order along the market path and return where it fills.
	 * Mutates trigger/trailing state (`triggered`, `trailingExtreme`) so
	 * partial progress survives even when the order does not fill.
	 */
	private evaluatePath(order: PaperOrder, path: PathSegment[]): PathFire | undefined {
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

	/** Fill an open resting order at the given price, keeping its original id in history. */
	private fillRestingOrder(order: PaperOrder, fillPrice: number): void {
		this.releaseReservation(order);
		// One-cancels-the-other: the sibling leg dies with this fill. Its share
		// of the group reservation was released above (legs share one).
		if (order.ocoGroup) {
			for (const sibling of this.account.orders) {
				if (sibling.ocoGroup === order.ocoGroup && sibling.id !== order.id && sibling.status === "open") {
					sibling.status = "canceled";
				}
			}
		}
		const fill = this.executeFill(order.symbol, order.side, order.amount - order.filled, fillPrice);
		// executeFill creates the canonical trade and a temporary closed order;
		// retain the original order id in order history instead.
		this.account.orders = this.account.orders.filter((o) => o.id !== fill.order.id);
		order.filled = order.amount;
		order.average = fill.order.average;
		order.cost = fill.order.cost;
		order.status = "closed";
		this.account.orders = this.account.orders.filter((o) => o.id !== order.id);
		this.account.orders.push(order);
		this.persist();
	}

	private async lastPrice(symbol: string): Promise<number> {
		const ticker = await this.exchange.fetchTicker(symbol);
		if (ticker.last === undefined || ticker.last <= 0) throw new Error(`No price available for ${symbol}`);
		return ticker.last;
	}

	private async tryPrice(asset: string): Promise<number | undefined> {
		if (asset === this.quoteCurrency) return 1;
		try {
			const ticker = await this.exchange.fetchTicker(`${asset}/${this.quoteCurrency}`);
			return ticker.last;
		} catch {
			return undefined;
		}
	}

	private async estimateQuoteValue(asset: string, amount: number): Promise<number | undefined> {
		const price = await this.tryPrice(asset);
		return price === undefined ? undefined : amount * price;
	}

	private persist(): void {
		writeJsonFile(this.accountPath, this.account);
	}
}

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
		timestamp: t.timestamp ?? Date.now(),
	};
}

function toOrder(o: PaperOrder): Order {
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
