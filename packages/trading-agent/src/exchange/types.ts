export interface Ticker {
	symbol: string;
	/** Latest traded price. Undefined when the exchange did not provide one. */
	last?: number;
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

export type ContractType = "spot" | "perpetual" | "delivery" | "unknown";

export interface MarketInfo {
	symbol: string;
	base: string;
	quote: string;
	settle?: string;
	marketType: "spot" | "swap";
	contract: boolean;
	contractType?: ContractType;
	pair?: string;
	marginAsset?: string;
	status?: string;
	onboardDate?: number;
	deliveryDate?: number;
	orderTypes?: string[];
	timeInForce?: string[];
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
	nextFundingRate?: number;
	estimatedSettlePrice?: number;
	interestRate?: number;
	openInterest?: number;
	openInterestValue?: number;
	basis?: number;
	basisPct?: number;
}

export interface Kline {
	timestamp: number;
	/** False when the exchange returned the currently forming candle. */
	closed?: boolean;
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
	/** Average entry price when authenticated trade history fully reconciles the balance. */
	avgEntryPrice?: number;
	unrealizedPnl?: number;
	unrealizedPnlPct?: number;
	/** Confidence in the live Spot cost-basis reconstruction. */
	costBasisStatus?: "complete" | "partial" | "unavailable";
	costBasisReason?: string;
}

export type OrderSide = "buy" | "sell";
export type OrderType =
	| "market"
	| "limit"
	| "stop"
	| "stop_market"
	| "take_profit"
	| "take_profit_market"
	| "trailing_stop_market"
	| "oco"
	| "unknown";
export type PlaceOrderType = Exclude<OrderType, "oco" | "unknown">;
export type OrderStatus = "open" | "closed" | "canceled" | "rejected" | "expired" | "unknown";

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
	/** OCO group id linking a stop-loss and a take-profit leg. */
	ocoGroup?: string;
	/** Client-assigned id used to identify a submission safely. */
	clientOrderId?: string;
	/** Native exchange order-list id, when the order belongs to an OCO/order list. */
	orderListId?: string;
	/** Client-assigned id for the containing OCO/order list. */
	listClientOrderId?: string;
	/** Native exchange order-list status, when provided. */
	listOrderStatus?: string;
	/** Futures position side associated with the order. */
	positionSide?: "BOTH" | "LONG" | "SHORT";
	/** Whether the order may only reduce an existing futures position. */
	reduceOnly?: boolean;
	/** Whether the exchange should close the whole matching futures position. */
	closePosition?: boolean;
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
	type: PlaceOrderType;
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
	/** Client-assigned id. Binance Spot limits this to 36 alphanumeric, - and _. */
	clientOrderId?: string;
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
	/** Client-assigned id for the native order list. */
	listClientOrderId?: string;
	/** Optional stable ids for the two native legs. */
	aboveClientOrderId?: string;
	belowClientOrderId?: string;
}

export interface PlaceOcoOrderResult {
	/** Paper mode: both legs. Live mode: the single exchange OCO order. */
	orders: Order[];
}

export interface OrderList {
	id: string;
	/** Native exchange list status, e.g. EXECUTING or ALL_DONE. */
	listOrderStatus: string;
	status: OrderStatus;
	orders: Order[];
}

export interface FundingRateRecord {
	symbol: string;
	fundingTime: number;
	rate: number;
	markPrice?: number;
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
	getOrder(id: string, symbol: string): Promise<Order>;
	getOrderByClientId(clientOrderId: string, symbol: string): Promise<Order>;
	getOrderList(orderListId: string): Promise<OrderList>;
	getOrderListByClientId(listClientOrderId: string): Promise<OrderList>;
	placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult>;
	placeOcoOrder(input: PlaceOcoOrderInput): Promise<PlaceOcoOrderResult>;
	cancelOrder(id: string, symbol: string): Promise<void>;
	cancelOrderList(orderListId: string, symbol: string): Promise<void>;
	/** Top markets by 24h quote volume for the configured quote currency. */
	getTopMarkets(limit: number): Promise<Ticker[]>;
	getFundingRate(symbol: string): Promise<{ symbol: string; rate: number; nextFundingTime?: number }>;
	getFundingRateHistory(symbol: string, limit?: number): Promise<FundingRateRecord[]>;
	setLeverage(symbol: string, leverage: number): Promise<void>;
	setMarginMode(symbol: string, marginType: "isolated" | "cross"): Promise<void>;
	close(): Promise<void>;
}

/** Convert a ccxt-style timeframe into milliseconds. */
export function timeframeDurationMs(timeframe: string): number | undefined {
	const match = /^(\d+)([smhdw])$/.exec(timeframe);
	if (!match) return undefined;
	const units: Record<string, number> = {
		s: 1000,
		m: 60_000,
		h: 3_600_000,
		d: 86_400_000,
		w: 604_800_000,
	};
	const unit = units[match[2]];
	return unit === undefined ? undefined : Number(match[1]) * unit;
}
