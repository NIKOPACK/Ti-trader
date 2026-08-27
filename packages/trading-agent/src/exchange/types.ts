export interface Ticker {
	symbol: string;
	last: number;
	bid?: number;
	ask?: number;
	high24h?: number;
	low24h?: number;
	/** 24h change in percent, e.g. -2.35. */
	changePct24h?: number;
	/** 24h volume in base currency. */
	volume24h?: number;
	/** 24h volume in quote currency. */
	quoteVolume24h?: number;
	timestamp: number;
}

export interface OrderBookLevel {
	price: number;
	amount: number;
}

export interface OrderBook {
	symbol: string;
	timestamp: number;
	bids: OrderBookLevel[];
	asks: OrderBookLevel[];
	spread?: number;
	spreadPct?: number;
	bidDepth: number;
	askDepth: number;
}

export interface MarketInfo {
	symbol: string;
	base: string;
	quote: string;
	settle?: string;
	marketType: "spot" | "swap";
	contract: boolean;
	linear?: boolean;
	inverse?: boolean;
	active?: boolean;
	contractSize?: number;
	pricePrecision?: number;
	amountPrecision?: number;
	minAmount?: number;
	minNotional?: number;
	limits?: { amount?: { min?: number; max?: number }; cost?: { min?: number; max?: number } };
}

export interface ContractStats {
	symbol: string;
	lastPrice?: number;
	markPrice?: number;
	indexPrice?: number;
	fundingRate?: number;
	nextFundingTime?: number;
	openInterest?: number;
	openInterestValue?: number;
	basis?: number;
	basisPct?: number;
}

export interface Kline {
	timestamp: number;
	open: number;
	high: number;
	low: number;
	close: number;
	volume: number;
}

export interface Balance {
	asset: string;
	free: number;
	used: number;
	total: number;
	/** Estimated value in quote currency. Undefined when no price is available. */
	quoteValue?: number;
}

export interface Position {
	symbol: string;
	asset: string;
	amount: number;
	quoteValue: number;
	/** Futures position side; absent for spot. */
	positionSide?: "BOTH" | "LONG" | "SHORT";
	leverage?: number;
	marginType?: "isolated" | "cross";
	markPrice?: number;
	liquidationPrice?: number;
	margin?: number;
	/** Average entry price (paper trading only). */
	avgEntryPrice?: number;
	unrealizedPnl?: number;
	unrealizedPnlPct?: number;
}

export type OrderSide = "buy" | "sell";
export type OrderType =
	| "market"
	| "limit"
	| "stop"
	| "stop_market"
	| "take_profit"
	| "take_profit_market"
	| "trailing_stop_market";
export type OrderStatus = "open" | "closed" | "canceled";

export interface Order {
	id: string;
	symbol: string;
	side: OrderSide;
	type: OrderType;
	/** Limit price; undefined for market orders. */
	price?: number;
	/** Trigger price for stop / take-profit orders. */
	stopPrice?: number;
	/** Trailing distance in percent for trailing stop orders. */
	trailingPercent?: number;
	/** OCO group id linking a stop-loss and a take-profit leg (paper mode). */
	ocoGroup?: string;
	/** Amount in base currency. */
	amount: number;
	filled: number;
	remaining: number;
	/** Average fill price. */
	average?: number;
	/** Filled notional in quote currency. */
	cost: number;
	status: OrderStatus;
	timestamp: number;
}

export interface PlaceOrderInput {
	symbol: string;
	side: OrderSide;
	type: OrderType;
	/** Amount in base currency. */
	amount: number;
	/** Required for limit and stop-limit orders. */
	price?: number;
	reduceOnly?: boolean;
	positionSide?: "BOTH" | "LONG" | "SHORT";
	/** Trigger price for stop / take-profit orders; activation price for trailing stops (live only). */
	stopPrice?: number;
	/** Trailing distance in percent (required for trailing_stop_market). */
	trailingPercent?: number;
	closePosition?: boolean;
}

export interface PlaceOrderResult {
	order: Order;
	/** Estimated fee in quote currency (paper trading). */
	fee?: number;
}

/**
 * One-cancels-the-other bracket: a stop-loss and a take-profit exit for the
 * same amount. When one leg fills the other is cancelled, so a single holding
 * can be protected in both directions without double-reserving funds.
 */
export interface PlaceOcoOrderInput {
	symbol: string;
	side: OrderSide;
	/** Amount in base currency. */
	amount: number;
	/** Stop-loss trigger price (the adverse side of the current price). */
	stopLossPrice: number;
	/** Take-profit trigger price (the favourable side of the current price). */
	takeProfitPrice: number;
}

export interface PlaceOcoOrderResult {
	/** Paper mode: both legs. Live mode: the single exchange OCO order. */
	orders: Order[];
}

export interface ExchangeClient {
	readonly id: string;
	readonly mode: "paper" | "live";
	readonly quoteCurrency: string;
	getTicker(symbol: string): Promise<Ticker>;
	getOrderBook(symbol: string, limit?: number): Promise<OrderBook>;
	getMarketInfo(symbol: string): Promise<MarketInfo>;
	getContractStats(symbol: string): Promise<ContractStats>;
	getKlines(symbol: string, timeframe: string, limit: number): Promise<Kline[]>;
	getBalances(): Promise<Balance[]>;
	getPositions(): Promise<Position[]>;
	getOpenOrders(symbol?: string): Promise<Order[]>;
	getOrderHistory(symbol?: string, limit?: number): Promise<Order[]>;
	placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult>;
	placeOcoOrder(input: PlaceOcoOrderInput): Promise<PlaceOcoOrderResult>;
	cancelOrder(id: string, symbol: string): Promise<void>;
	/** Top markets by 24h quote volume for the configured quote currency. */
	getTopMarkets(limit: number): Promise<Ticker[]>;
	getFundingRate(symbol: string): Promise<{ symbol: string; rate: number; nextFundingTime?: number }>;
	setLeverage(symbol: string, leverage: number): Promise<void>;
	setMarginMode(symbol: string, marginType: "isolated" | "cross"): Promise<void>;
	close(): Promise<void>;
}
