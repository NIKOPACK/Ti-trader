import { validateTradingSymbol } from "@nikopack/ti-trading-risk";
import { evaluateOrderCapability, getTradingCapabilities, type TradingCapabilityContext } from "./capabilities.ts";
import type { FuturesPositionMode, MarketType } from "./client-types.ts";
import { futuresAmountsEqual } from "./contract-size.ts";
import { reduceSide } from "./protection.ts";
import type {
	MarketDataClient,
	MarketInfo,
	OrderSide,
	PlaceOcoOrderInput,
	PlaceOrderInput,
	PlaceOrderType,
	Position,
} from "./types.ts";

export interface OrderPlanningConfig {
	marketType: MarketType;
	quoteCurrency: string;
	positionMode: FuturesPositionMode;
}

export interface OrderPlanningContext {
	config: OrderPlanningConfig;
	mode: "paper" | "live";
	exchange: MarketDataClient;
}

export interface OrderIntent {
	symbol: string;
	type: PlaceOrderType;
	amount?: number;
	quoteAmount?: number;
	price?: number;
	reduceOnly?: boolean;
	positionSide?: "BOTH" | "LONG" | "SHORT";
	stopPrice?: number;
	trailingPercent?: number;
	closePosition?: boolean;
}

export type ReferencePriceSource = "limit_price" | "stop_price" | "ask" | "bid" | "last";

export interface PreparedOrder {
	/** Frozen snapshot; only the engine that prepared this value may submit it. */
	readonly input: Readonly<PlaceOrderInput>;
	readonly capabilityContext: Readonly<TradingCapabilityContext>;
	readonly side: OrderSide;
	readonly amount: number;
	readonly notional: number;
	readonly referencePrice: number;
	readonly referencePriceSource: ReferencePriceSource;
	readonly referenceTimestamp: number;
	readonly countTowardsDailyLimit: boolean;
	readonly closePosition?: Readonly<Position>;
	readonly reducingPosition?: Readonly<Position>;
	readonly reduceOnlyRequested: boolean;
	readonly reduceOnlyApplied: boolean;
	readonly exchangeConstraint?: string;
	readonly summary: string;
}

export interface OcoIntent {
	symbol: string;
	side: OrderSide;
	amount: number;
	stopLossPrice: number;
	takeProfitPrice: number;
}

export interface PreparedOco {
	/** Frozen snapshot; only the engine that prepared this value may submit it. */
	readonly input: Readonly<PlaceOcoOrderInput>;
	readonly capabilityContext: Readonly<TradingCapabilityContext>;
	readonly observedNotional: number;
	readonly riskNotional: number;
	readonly notional: number;
	readonly referencePrice: number;
	readonly referenceTimestamp: number;
	readonly countTowardsDailyLimit: boolean;
	readonly summary: string;
}

export function isBinanceCloseAllTrigger(trading: OrderPlanningContext, plan: PreparedOrder): boolean {
	return evaluateOrderCapability(
		{
			exchangeId: trading.exchange.id,
			mode: trading.mode,
			marketFamily: isFuturesSymbol(plan.input.symbol, trading.config.quoteCurrency) ? "futures" : "spot",
			positionMode: trading.config.positionMode,
		},
		plan.input,
	).omitExchangeQuantity;
}

export class OrderPreparationError extends Error {
	readonly code = "ORDER_PREPARATION_REJECTED" as const;
	/** True when missing external metadata makes the preflight indeterminate. */
	readonly uncertain: boolean;
	constructor(message: string, uncertain = false) {
		super(message);
		this.name = "OrderPreparationError";
		this.uncertain = uncertain;
	}
}
function rejectOrder(message: string, uncertain = false): never {
	throw new OrderPreparationError(message, uncertain);
}

function freezePosition(position: Position | undefined): Readonly<Position> | undefined {
	return position === undefined ? undefined : Object.freeze({ ...position });
}

function freezePreparedOrder(
	plan: Omit<PreparedOrder, "input" | "closePosition" | "reducingPosition"> & {
		input: PlaceOrderInput;
		closePosition?: Position;
		reducingPosition?: Position;
	},
): PreparedOrder {
	return Object.freeze({
		...plan,
		input: Object.freeze({ ...plan.input }),
		capabilityContext: Object.freeze({ ...plan.capabilityContext }),
		closePosition: freezePosition(plan.closePosition),
		reducingPosition: freezePosition(plan.reducingPosition),
	}) as PreparedOrder;
}

function freezePreparedOco(plan: PreparedOco): PreparedOco {
	return Object.freeze({
		...plan,
		input: Object.freeze({ ...plan.input }),
		capabilityContext: Object.freeze({ ...plan.capabilityContext }),
	}) as PreparedOco;
}
export function isFuturesSymbol(symbol: string, quoteCurrency: string): boolean {
	return symbol.endsWith(`/${quoteCurrency}:${quoteCurrency}`);
}

/** Fallback when `amountStep` is absent: integer = DECIMAL_PLACES; (0, 1) = tick size. */
export function futuresContractLotStep(precision: number | undefined): number | undefined {
	if (precision === undefined || !Number.isFinite(precision) || precision < 0) return undefined;
	if (Number.isInteger(precision)) return 10 ** -precision;
	if (precision > 0 && precision < 1) return precision;
	return undefined;
}

/** Exchange contract lot step. `amountStep` wins because TICK_SIZE `1` is 1 contract, not 0.1. */
export function futuresAmountStep(market: Pick<MarketInfo, "amountStep" | "amountPrecision">): number | undefined {
	const step = market.amountStep;
	if (step !== undefined && Number.isFinite(step) && step > 0) return step;
	return futuresContractLotStep(market.amountPrecision);
}

function ceilToStep(value: number, step: number): number {
	return Math.ceil(value / step - 1e-12) * step;
}

function isMultipleOfStep(value: number, step: number): boolean {
	const units = value / step;
	return Number.isFinite(units) && Math.abs(units - Math.round(units)) <= 1e-9;
}

function requireFuturesContract(market: MarketInfo): number {
	if (
		market.contract !== true ||
		market.linear !== true ||
		(market.amountUnit !== undefined && market.amountUnit !== "contracts")
	) {
		rejectOrder(
			"Futures market is not confirmed as a linear contract with contract-denominated amounts; refusing to guess the amount unit",
			true,
		);
	}
	const contractSize = market.contractSize;
	if (contractSize === undefined || !Number.isFinite(contractSize) || contractSize <= 0) {
		rejectOrder("Futures contractSize is unavailable; refusing to guess the amount unit", true);
	}
	return contractSize;
}

function requireFuturesLot(market: MarketInfo): { contractSize: number; step: number } {
	const contractSize = requireFuturesContract(market);
	const step = futuresAmountStep(market);
	if (step === undefined || !Number.isFinite(step) || step <= 0) {
		rejectOrder("Futures amount precision is unavailable; refusing to guess a contract lot", true);
	}
	return { contractSize, step };
}

async function futuresMarketForQuoteAmount(trading: OrderPlanningContext, symbol: string): Promise<MarketInfo> {
	try {
		return await trading.exchange.getMarketInfo(symbol);
	} catch (error) {
		rejectOrder(
			`Futures market metadata unavailable: ${error instanceof Error ? error.message : String(error)}`,
			true,
		);
	}
}

function snapQuoteAmountToFuturesLot(amount: number, market: MarketInfo, referencePrice: number): number {
	const { contractSize, step } = requireFuturesLot(market);
	let contracts = amount / contractSize;
	if (!Number.isFinite(contracts) || contracts <= 0) rejectOrder("Order amount must be positive");
	contracts = ceilToStep(contracts, step);
	const minAmount = market.minAmount ?? market.limits?.amount?.min;
	if (minAmount !== undefined && Number.isFinite(minAmount) && contracts < minAmount) {
		contracts = ceilToStep(minAmount, step);
	}
	const minNotional = market.minNotional ?? market.limits?.cost?.min;
	if (minNotional !== undefined && Number.isFinite(minNotional) && minNotional > 0) {
		const minContracts = minNotional / (referencePrice * contractSize);
		if (Number.isFinite(minContracts) && contracts < minContracts) contracts = ceilToStep(minContracts, step);
	}
	const snapped = contracts * contractSize;
	if (!Number.isFinite(snapped) || snapped <= 0) rejectOrder("Order amount must be positive");
	return snapped;
}

function assertFuturesAmountRepresentable(amount: number, market: MarketInfo): void {
	const contractSize = requireFuturesContract(market);
	const step = futuresAmountStep(market);
	// An explicit base amount can still be handed to the exchange adapter when
	// the venue omits lot precision; the adapter remains the final authority on
	// exchange rounding. Quote amounts cannot proceed without a step because
	// they must be snapped before risk sizing.
	if (step === undefined || !Number.isFinite(step) || step <= 0) return;
	const contracts = amount / contractSize;
	const tolerance = Math.max(1e-12, Math.abs(amount) * 1e-9);
	if (!isMultipleOfStep(contracts, step) || Math.abs(contracts * contractSize - amount) > tolerance) {
		const precise = Math.round(contracts / step) * step;
		rejectOrder(
			`Amount ${amount} base units cannot be represented exactly as ${precise} contracts for ${market.symbol} (contractSize ${contractSize})`,
		);
	}
}
function validateSymbol(symbol: string, quoteCurrency: string, marketType: MarketType): boolean {
	const validationError = validateTradingSymbol(symbol, marketType, quoteCurrency);
	if (validationError) rejectOrder(validationError);
	const futures = isFuturesSymbol(symbol, quoteCurrency);
	return futures;
}
export function countsTowardsDailyLimit(trading: OrderPlanningContext, side: OrderSide, params: OrderIntent): boolean {
	if (!isFuturesSymbol(params.symbol, trading.config.quoteCurrency)) return side === "buy";
	if (params.reduceOnly || params.closePosition) return false;
	if (trading.config.positionMode === "hedge") {
		if (params.positionSide === "LONG" && side === "sell") return false;
		if (params.positionSide === "SHORT" && side === "buy") return false;
	}
	return true;
}
async function findClosePosition(
	trading: OrderPlanningContext,
	side: OrderSide,
	params: OrderIntent,
): Promise<Position> {
	const positions = await trading.exchange.getPositions();
	const matches = positions.filter(
		(position) =>
			position.symbol === params.symbol &&
			Math.abs(position.amount) > 0 &&
			reduceSide(position) === side &&
			(trading.config.positionMode !== "hedge" || position.positionSide === params.positionSide),
	);
	if (matches.length === 0)
		rejectOrder(
			`No ${params.positionSide ? `${params.positionSide} ` : ""}position on ${params.symbol} can be closed with a ${side} order`,
		);
	if (matches.length > 1)
		rejectOrder(`Multiple matching positions found on ${params.symbol}; specify positionSide explicitly`);
	return matches[0];
}
function validateTriggerDirection(
	side: OrderSide,
	type: PlaceOrderType,
	currentPrice: number,
	stopPrice: number,
): void {
	if (!["stop", "stop_market", "take_profit", "take_profit_market"].includes(type)) return;
	const fallsToTrigger = type.startsWith("stop") ? side === "sell" : side === "buy";
	const valid = fallsToTrigger ? stopPrice < currentPrice : stopPrice > currentPrice;
	if (!valid)
		rejectOrder(
			`${type} ${side} stopPrice ${stopPrice} must be ${fallsToTrigger ? "below" : "above"} the current last price ${currentPrice}; otherwise it would trigger immediately`,
		);
}
function validateStopLimitDirection(side: OrderSide, type: PlaceOrderType, price: number, stopPrice: number): void {
	if (type !== "stop" && type !== "take_profit") return;
	const valid =
		type === "stop"
			? side === "sell"
				? price <= stopPrice
				: price >= stopPrice
			: side === "sell"
				? price >= stopPrice
				: price <= stopPrice;
	if (!valid) {
		const direction =
			type === "stop"
				? side === "sell"
					? "at or below"
					: "at or above"
				: side === "sell"
					? "at or above"
					: "at or below";
		rejectOrder(`${type} ${side} price ${price} must be ${direction} stopPrice ${stopPrice}`);
	}
}

export async function prepareOrder(
	side: OrderSide,
	params: OrderIntent,
	trading: OrderPlanningContext,
): Promise<PreparedOrder> {
	const { config } = trading;
	const futuresOrder = validateSymbol(params.symbol, config.quoteCurrency, config.marketType);
	const capabilityContext: TradingCapabilityContext = {
		exchangeId: trading.exchange.id,
		mode: trading.mode,
		marketFamily: futuresOrder ? "futures" : "spot",
		positionMode: config.positionMode,
	};
	const orderCapability = evaluateOrderCapability(capabilityContext, { ...params, side });
	if (orderCapability.capability.status === "unsupported") rejectOrder(orderCapability.capability.reason);
	const priceRequired = params.type === "limit" || params.type === "stop" || params.type === "take_profit";
	if (!priceRequired && params.price !== undefined)
		rejectOrder(`${params.type} orders do not accept price; use price only for limit execution`);
	if (priceRequired && (params.price === undefined || !Number.isFinite(params.price) || params.price <= 0))
		rejectOrder(`${params.type} orders require a positive price`);
	const stopType = ["stop", "stop_market", "take_profit", "take_profit_market"].includes(params.type);
	if (stopType && (params.stopPrice === undefined || !Number.isFinite(params.stopPrice) || params.stopPrice <= 0))
		rejectOrder(`${params.type} orders require a positive stopPrice`);
	if (!stopType && params.type !== "trailing_stop_market" && params.stopPrice !== undefined)
		rejectOrder(`${params.type} orders do not accept stopPrice`);
	if (params.type === "trailing_stop_market") {
		if (
			params.trailingPercent === undefined ||
			!Number.isFinite(params.trailingPercent) ||
			params.trailingPercent <= 0 ||
			params.trailingPercent >= 100
		)
			rejectOrder("trailing_stop_market orders require trailingPercent in (0, 100)");
		if (params.stopPrice !== undefined && trading.mode === "paper")
			rejectOrder("Paper trailing_stop_market orders do not accept stopPrice; use trailingPercent only");
	} else if (params.trailingPercent !== undefined)
		rejectOrder("trailingPercent is only valid for trailing_stop_market orders");
	if (params.closePosition && (params.amount !== undefined || params.quoteAmount !== undefined))
		rejectOrder("closePosition orders must omit amount and quoteAmount");
	if (!params.closePosition && (params.amount === undefined) === (params.quoteAmount === undefined))
		rejectOrder("Provide exactly one of amount (base currency) or quoteAmount (quote currency)");
	if (!params.closePosition && params.amount !== undefined && (!Number.isFinite(params.amount) || params.amount <= 0))
		rejectOrder("amount must be a positive finite number");
	if (
		!params.closePosition &&
		params.quoteAmount !== undefined &&
		(!Number.isFinite(params.quoteAmount) || params.quoteAmount <= 0)
	)
		rejectOrder("quoteAmount must be a positive finite number");
	const ticker = await trading.exchange.getTicker(params.symbol);
	const currentPrice = ticker.last;
	if (
		(stopType || (params.type === "trailing_stop_market" && params.stopPrice !== undefined)) &&
		(currentPrice === undefined || !Number.isFinite(currentPrice) || currentPrice <= 0)
	)
		rejectOrder(`No current last price available to validate ${params.type} trigger for ${params.symbol}`);
	if (stopType) validateTriggerDirection(side, params.type, currentPrice!, params.stopPrice!);
	if (params.type === "stop" || params.type === "take_profit")
		validateStopLimitDirection(side, params.type, params.price!, params.stopPrice!);
	if (
		params.type === "trailing_stop_market" &&
		params.stopPrice !== undefined &&
		!(side === "sell" ? params.stopPrice > currentPrice! : params.stopPrice < currentPrice!)
	)
		rejectOrder(
			`trailing_stop_market ${side} stopPrice ${params.stopPrice} must be ${side === "sell" ? "above" : "below"} the current last price ${currentPrice}`,
		);
	const countTowardsDailyLimit = countsTowardsDailyLimit(trading, side, params);
	const reducingPosition =
		futuresOrder && !countTowardsDailyLimit ? await findClosePosition(trading, side, params) : undefined;
	const closePosition = params.closePosition ? reducingPosition : undefined;
	let referencePrice: number | undefined;
	let referencePriceSource: ReferencePriceSource;
	if (params.price !== undefined) {
		referencePrice = params.price;
		referencePriceSource = "limit_price";
	} else if (params.stopPrice !== undefined) {
		referencePrice = params.stopPrice;
		referencePriceSource = "stop_price";
	} else if (side === "buy" && ticker.ask !== undefined) {
		referencePrice = ticker.ask;
		referencePriceSource = "ask";
	} else if (side === "sell" && ticker.bid !== undefined) {
		referencePrice = ticker.bid;
		referencePriceSource = "bid";
	} else {
		referencePrice = ticker.last;
		referencePriceSource = "last";
	}
	if (referencePrice === undefined || !Number.isFinite(referencePrice) || referencePrice <= 0)
		rejectOrder(`No reference price for ${params.symbol}`);
	let amount: number;
	if (closePosition) {
		amount = Math.abs(closePosition.amount);
	} else if (params.amount !== undefined) {
		amount = params.amount;
	} else if (params.quoteAmount !== undefined) {
		amount = params.quoteAmount / referencePrice;
	} else {
		rejectOrder("Provide exactly one of amount (base currency) or quoteAmount (quote currency)");
	}
	if (!Number.isFinite(amount) || amount <= 0) rejectOrder("Order amount must be positive");
	if (futuresOrder && !closePosition) {
		// Fetch one metadata snapshot for the sizing path. A second request could
		// observe different contract metadata or fail after the first succeeded,
		// making the prepared plan internally inconsistent.
		let market: MarketInfo;
		try {
			market =
				params.quoteAmount !== undefined
					? await futuresMarketForQuoteAmount(trading, params.symbol)
					: await trading.exchange.getMarketInfo(params.symbol);
		} catch (error) {
			if (error instanceof OrderPreparationError) throw error;
			rejectOrder(
				`Futures market metadata unavailable: ${error instanceof Error ? error.message : String(error)}`,
				true,
			);
		}
		if (params.quoteAmount !== undefined) amount = snapQuoteAmountToFuturesLot(amount, market, referencePrice);
		else assertFuturesAmountRepresentable(amount, market);
	}
	// Preserve the exchange-representable amount; only the paper adapter clamps
	// ledger rounding tails when it settles the reduction.
	if (
		reducingPosition &&
		amount > Math.abs(reducingPosition.amount) &&
		!futuresAmountsEqual(amount, Math.abs(reducingPosition.amount))
	)
		rejectOrder(
			`${params.reduceOnly ? "reduceOnly" : "Reducing"} order amount ${amount} exceeds the open ${params.positionSide ? `${params.positionSide} ` : ""}position amount ${Math.abs(reducingPosition.amount)}`,
		);
	let notional: number;
	if (closePosition) {
		const quoteValue = closePosition.quoteValue;
		if (quoteValue !== undefined && Number.isFinite(quoteValue) && quoteValue > 0) {
			notional = quoteValue;
		} else {
			notional = amount * referencePrice;
		}
	} else {
		notional = params.quoteAmount !== undefined && !futuresOrder ? params.quoteAmount : amount * referencePrice;
	}
	if (!Number.isFinite(notional) || notional <= 0) rejectOrder("Order notional must be positive and finite");
	const reduceOnlyRequested = params.reduceOnly === true || params.closePosition === true;
	const binanceCloseAllTrigger = orderCapability.omitExchangeQuantity;
	const exchangeConstraints = orderCapability.constraints;
	const exchangeConstraint = exchangeConstraints.length > 0 ? exchangeConstraints.join("; ") : undefined;
	const input: PlaceOrderInput = {
		symbol: params.symbol,
		side,
		type: params.type,
		amount,
		price: priceRequired ? params.price : undefined,
		reduceOnly: params.closePosition ? true : params.reduceOnly,
		positionSide: params.positionSide,
		stopPrice: params.stopPrice,
		trailingPercent: params.trailingPercent,
		closePosition: params.closePosition,
	};
	const summary = `${side.toUpperCase()} ${amount} ${params.symbol} (${params.type})${params.price !== undefined ? ` @ ${params.price}` : ""}${params.stopPrice !== undefined ? ` trigger ${params.stopPrice}` : ""}${params.trailingPercent !== undefined ? ` trail ${params.trailingPercent}%` : ""}${params.closePosition ? " (close entire matching position)" : ""}${binanceCloseAllTrigger ? " (Binance close-all; exchange may omit quantity)" : ""} ≈ ${notional.toFixed(2)} ${config.quoteCurrency}`;
	return freezePreparedOrder({
		input,
		capabilityContext,
		side,
		amount,
		notional,
		referencePrice,
		referencePriceSource,
		referenceTimestamp: ticker.timestamp,
		countTowardsDailyLimit,
		closePosition,
		reducingPosition,
		reduceOnlyRequested,
		reduceOnlyApplied: reduceOnlyRequested && exchangeConstraints.length === 0,
		exchangeConstraint,
		summary,
	});
}

export async function prepareOcoOrder(params: OcoIntent, trading: OrderPlanningContext): Promise<PreparedOco> {
	const futuresOrder = validateSymbol(params.symbol, trading.config.quoteCurrency, trading.config.marketType);
	const capabilityContext: TradingCapabilityContext = {
		exchangeId: trading.exchange.id,
		mode: trading.mode,
		marketFamily: futuresOrder ? "futures" : "spot",
		positionMode: trading.config.positionMode,
	};
	const ocoCapability = getTradingCapabilities(capabilityContext).oco[params.side];
	if (ocoCapability.status === "unsupported") rejectOrder(ocoCapability.reason);
	if (!Number.isFinite(params.amount) || params.amount <= 0) rejectOrder("amount must be a positive finite number");
	if (!Number.isFinite(params.stopLossPrice) || params.stopLossPrice <= 0)
		rejectOrder("stopLossPrice must be a positive finite number");
	if (!Number.isFinite(params.takeProfitPrice) || params.takeProfitPrice <= 0)
		rejectOrder("takeProfitPrice must be a positive finite number");
	if (params.stopLossPrice === params.takeProfitPrice) rejectOrder("stopLossPrice and takeProfitPrice must differ");
	const ticker = await trading.exchange.getTicker(params.symbol);
	const referencePrice = ticker.last;
	if (referencePrice === undefined || !Number.isFinite(referencePrice) || referencePrice <= 0)
		rejectOrder(`No reference price for ${params.symbol}`);
	if (params.side === "sell") {
		if (params.stopLossPrice >= referencePrice)
			rejectOrder(
				`Sell OCO stopLossPrice ${params.stopLossPrice} must be below the current last price ${referencePrice}`,
			);
		if (params.takeProfitPrice <= referencePrice)
			rejectOrder(
				`Sell OCO takeProfitPrice ${params.takeProfitPrice} must be above the current last price ${referencePrice}`,
			);
	} else {
		if (params.stopLossPrice <= referencePrice)
			rejectOrder(
				`Buy OCO stopLossPrice ${params.stopLossPrice} must be above the current last price ${referencePrice}`,
			);
		if (params.takeProfitPrice >= referencePrice)
			rejectOrder(
				`Buy OCO takeProfitPrice ${params.takeProfitPrice} must be below the current last price ${referencePrice}`,
			);
	}
	const observedNotional = params.amount * referencePrice;
	const riskPrice = params.side === "buy" ? Math.max(params.stopLossPrice, params.takeProfitPrice) : referencePrice;
	const riskNotional = params.amount * riskPrice;
	if (!Number.isFinite(observedNotional) || observedNotional <= 0)
		rejectOrder("OCO notional must be positive and finite");
	if (!Number.isFinite(riskNotional) || riskNotional <= 0)
		rejectOrder("OCO risk notional must be positive and finite");
	return freezePreparedOco({
		capabilityContext,
		input: {
			symbol: params.symbol,
			side: params.side,
			amount: params.amount,
			stopLossPrice: params.stopLossPrice,
			takeProfitPrice: params.takeProfitPrice,
		},
		observedNotional,
		riskNotional,
		notional: observedNotional,
		referencePrice,
		referenceTimestamp: ticker.timestamp,
		countTowardsDailyLimit: params.side === "buy",
		summary: `OCO ${params.side.toUpperCase()} ${params.amount} ${params.symbol} SL ${params.stopLossPrice} / TP ${params.takeProfitPrice} ≈ ${observedNotional.toFixed(2)} ${trading.config.quoteCurrency}${params.side === "buy" ? ` (risk ≤ ${riskNotional.toFixed(2)} ${trading.config.quoteCurrency})` : ""}`,
	});
}
