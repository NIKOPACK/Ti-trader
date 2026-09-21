import { evaluateOrderCapability, getTradingCapabilities } from "./capabilities.ts";
import type { MarketType } from "./client-types.ts";
import { futuresAmountsEqual } from "./contract-size.ts";
import { errorMessage } from "./error-message.ts";

import { futuresAmountStep, isFuturesSymbol, type PreparedOco, type PreparedOrder } from "./order-plan.ts";
import { reduceSide } from "./protection.ts";
import type { Balance, MarketInfo, Position, Ticker } from "./types.ts";

export class OrderPreflightError extends Error {
	readonly code = "ORDER_PREFLIGHT_REJECTED" as const;
	readonly uncertain: boolean;

	constructor(message: string, uncertain = false) {
		super(message);
		this.name = "OrderPreflightError";
		this.uncertain = uncertain;
	}
}

export interface OrderConfirmationEvidence {
	referencePrice: number;
	amount: number;
	notional: number;
	riskNotional: number;
	priceStep: number;
}

export interface OrderPreflightResult {
	warnings: string[];
	evidence: OrderConfirmationEvidence;
}

export interface OcoPreflightResult extends OrderPreflightResult {
	market: MarketInfo;
	balance: Balance;
	balanceAsset: string;
	requiredBalance: number;
	estimatedFee?: number;
}

function reject(message: string, uncertain = false): never {
	throw new OrderPreflightError(message, uncertain);
}

function marketMatches(market: MarketInfo, symbol: string, quote: string, futures: boolean): boolean {
	return (
		market.symbol === symbol &&
		market.quote === quote &&
		(futures
			? market.marketType === "swap" &&
				market.contract === true &&
				market.linear === true &&
				market.inverse !== true &&
				(market.settle === undefined || market.settle === quote)
			: market.marketType === "spot" && market.contract === false)
	);
}

function exchangeAmount(
	plan: PreparedOrder,
	market: MarketInfo,
	futures: boolean,
): { amount: number; unit: "base" | "contracts" } {
	if (!futures) {
		const step = market.amountStep;
		if (step !== undefined && Number.isFinite(step) && step > 0) {
			const units = plan.amount / step;
			if (!Number.isFinite(units) || Math.abs(units - Math.round(units)) > 1e-9) {
				reject(`Spot order amount ${plan.amount} is not aligned to precision step ${step}`);
			}
		}
		return { amount: plan.amount, unit: "base" };
	}
	const contractSize = market.contractSize;
	if (contractSize === undefined || !Number.isFinite(contractSize) || contractSize <= 0) {
		reject("Futures contractSize is unavailable during order preflight", true);
	}
	const amount = plan.amount / contractSize;
	if (!Number.isFinite(amount) || amount <= 0) reject("Futures order amount cannot be converted to contracts", true);
	const step = futuresAmountStep(market);
	if (step !== undefined && Math.abs(amount / step - Math.round(amount / step)) > 1e-9) {
		reject(`Futures order amount ${amount} contracts is not aligned to precision step ${step}`);
	}
	return { amount, unit: "contracts" };
}

function checkMarketLimits(plan: PreparedOrder, market: MarketInfo, futures: boolean): void {
	if (market.active === false) reject(`Market ${plan.input.symbol} is inactive`);
	if (!marketMatches(market, plan.input.symbol, plan.input.symbol.split("/")[1]?.split(":")[0] ?? "", futures)) {
		reject("Returned market metadata does not match the requested symbol, quote currency or market family", true);
	}
	const orderCapability = evaluateOrderCapability({ ...plan.capabilityContext, marketInfo: market }, plan.input);
	if (orderCapability.capability.status === "unsupported") reject(orderCapability.capability.reason);
	if (orderCapability.omitExchangeQuantity) return;
	const amount = exchangeAmount(plan, market, futures);
	const [first] = marketLimitViolations(market, amount, plan.notional);
	if (first) reject(first);
}

export function marketLimitViolations(
	market: MarketInfo,
	amount: { amount: number; unit: "base" | "contracts" } | undefined,
	notional: number,
): string[] {
	const violations: string[] = [];
	const minAmount = market.minAmount ?? market.limits?.amount?.min;
	const maxAmount = market.limits?.amount?.max;
	if (amount !== undefined && minAmount !== undefined && amount.amount < minAmount) {
		violations.push(`Exchange amount ${amount.amount} ${amount.unit} is below market minimum ${minAmount}`);
	}
	if (amount !== undefined && maxAmount !== undefined && amount.amount > maxAmount) {
		violations.push(`Exchange amount ${amount.amount} ${amount.unit} exceeds market maximum ${maxAmount}`);
	}
	if (market.minNotional !== undefined && notional < market.minNotional) {
		violations.push(`Estimated notional ${notional} is below market minimum ${market.minNotional}`);
	}
	if (market.limits?.cost?.max !== undefined && notional > market.limits.cost.max) {
		violations.push(`Estimated notional ${notional} exceeds market maximum ${market.limits.cost.max}`);
	}
	return violations;
}

function requiredBalance(
	plan: PreparedOrder,
	quote: string,
	futures: boolean,
	marketType: MarketType,
): string | undefined {
	if (plan.reducingPosition) return undefined;
	if (futures) return marketType === "both" ? `futures:${quote}` : quote;
	if (plan.side === "buy") return quote;
	return plan.input.symbol.split("/")[0];
}

function checkBalance(
	plan: PreparedOrder,
	balances: Balance[],
	quote: string,
	futures: boolean,
	marketType: MarketType,
	getEffectiveLeverage: (symbol: string) => number,
	feeRate?: number,
): void {
	const asset = requiredBalance(plan, quote, futures, marketType);
	if (asset === undefined) return;
	const balance = balances.find((candidate) => candidate.asset === asset);
	if (balance === undefined || !Number.isFinite(balance.free)) {
		reject(`No finite free ${asset} balance was returned during order preflight`, true);
	}
	let required = plan.side === "sell" && !futures ? plan.amount : plan.notional;
	if (futures) {
		const leverage = getEffectiveLeverage(plan.input.symbol);
		if (!Number.isFinite(leverage) || leverage < 1) {
			reject("Effective futures leverage is unavailable during order preflight", true);
		}
		required = plan.notional / leverage;
		if (feeRate !== undefined) {
			if (!Number.isFinite(feeRate) || feeRate < 0 || feeRate >= 1) {
				reject("Taker fee rate is unavailable during order preflight", true);
			}
			required += plan.notional * feeRate;
		}
	}
	if (required - balance.free > Number.EPSILON * Math.max(1, required, Math.abs(balance.free)) * 8)
		reject(`Insufficient available ${asset}: need ${required}, have ${balance.free}`);
}

async function loadTicker(symbol: string, getTicker: (symbol: string) => Promise<Ticker>): Promise<Ticker> {
	let ticker: Ticker;
	try {
		ticker = await getTicker(symbol);
	} catch (error) {
		reject(`Ticker unavailable during order preflight: ${errorMessage(error)}`, true);
	}
	if (ticker.symbol !== symbol) reject(`Ticker returned ${ticker.symbol} while revalidating ${symbol}`, true);
	return ticker;
}

function finitePrice(value: number | undefined, name: string): number {
	if (value === undefined || !Number.isFinite(value) || value <= 0) {
		reject(`${name} is unavailable during order preflight`, true);
	}
	return value;
}

const MAX_CONFIRMED_PRICE_DRIFT_RATIO = 0.01;

function priceStep(market: MarketInfo): number {
	const precision = market.pricePrecision;
	if (precision === undefined || !Number.isFinite(precision) || precision < 0) return 0;
	if (Number.isInteger(precision)) return 10 ** -precision;
	return precision;
}

function materiallyChangedPrice(prepared: number, current: number, step: number): boolean {
	const tolerance = Math.max(prepared * MAX_CONFIRMED_PRICE_DRIFT_RATIO, step);
	return Math.abs(current - prepared) > tolerance;
}

function materiallyChangedNotional(prepared: number, current: number): boolean {
	return Math.abs(current - prepared) > prepared * MAX_CONFIRMED_PRICE_DRIFT_RATIO;
}

export function marketEvidenceChanged(
	previous: Pick<OrderConfirmationEvidence, "referencePrice" | "amount" | "notional" | "riskNotional">,
	next: OrderPreflightResult,
): boolean {
	const { evidence } = next;
	if (materiallyChangedPrice(previous.referencePrice, evidence.referencePrice, evidence.priceStep)) return true;
	if (materiallyChangedNotional(previous.notional, evidence.notional)) return true;
	if (materiallyChangedNotional(previous.riskNotional, evidence.riskNotional)) return true;
	return !futuresAmountsEqual(previous.amount, evidence.amount);
}

export function confirmationSnapshotChanged(
	previous: Pick<OrderConfirmationEvidence, "referencePrice" | "amount" | "notional" | "riskNotional"> & {
		warnings: readonly string[];
	},
	next: OrderPreflightResult,
): boolean {
	if (
		previous.warnings.length !== next.warnings.length ||
		previous.warnings.some((warning, index) => warning !== next.warnings[index])
	) {
		return true;
	}
	return marketEvidenceChanged(previous, next);
}

function confirmationEvidence(
	market: MarketInfo,
	referencePrice: number,
	amount: number,
	notional: number,
	riskNotional: number,
): OrderConfirmationEvidence {
	return { referencePrice, amount, notional, riskNotional, priceStep: priceStep(market) };
}

function currentReferencePrice(plan: PreparedOrder, ticker: Ticker): number | undefined {
	switch (plan.referencePriceSource) {
		case "ask":
			return ticker.ask;
		case "bid":
			return ticker.bid;
		case "last":
			return ticker.last;
		default:
			return undefined;
	}
}

function validateTrigger(plan: PreparedOrder, ticker: Ticker): void {
	const type = plan.input.type;
	if (!["stop", "stop_market", "take_profit", "take_profit_market"].includes(type)) {
		if (type !== "trailing_stop_market" || plan.input.stopPrice === undefined) return;
	}
	const currentPrice = finitePrice(ticker.last, "Current last price");
	const stopPrice = plan.input.stopPrice;
	if (stopPrice === undefined) reject(`${type} stop price is unavailable during order preflight`, true);
	if (type === "trailing_stop_market") {
		const valid = plan.side === "sell" ? stopPrice > currentPrice : stopPrice < currentPrice;
		if (!valid) reject(`Current price ${currentPrice} invalidates the confirmed trailing stop ${stopPrice}`);
		return;
	}
	const fallsToTrigger = type.startsWith("stop") ? plan.side === "sell" : plan.side === "buy";
	const valid = fallsToTrigger ? stopPrice < currentPrice : stopPrice > currentPrice;
	if (!valid) reject(`Current price ${currentPrice} invalidates the confirmed ${type} trigger ${stopPrice}`);
}

async function revalidateOrderPrice(
	plan: PreparedOrder,
	getTicker: (symbol: string) => Promise<Ticker>,
): Promise<number> {
	const dynamicReference = ["ask", "bid", "last"].includes(plan.referencePriceSource);
	const triggerOrder =
		["stop", "stop_market", "take_profit", "take_profit_market"].includes(plan.input.type) ||
		(plan.input.type === "trailing_stop_market" && plan.input.stopPrice !== undefined);
	if (!dynamicReference && !triggerOrder) return plan.referencePrice;

	const ticker = await loadTicker(plan.input.symbol, getTicker);
	validateTrigger(plan, ticker);
	if (!dynamicReference) return plan.referencePrice;
	return finitePrice(currentReferencePrice(plan, ticker), `Current ${plan.referencePriceSource} price`);
}

async function revalidateReducingPosition(
	plan: PreparedOrder,
	getPositions: () => Promise<Position[]>,
): Promise<number | undefined> {
	const prepared = plan.reducingPosition;
	if (!prepared) return undefined;

	let positions: Position[];
	try {
		positions = await getPositions();
	} catch (error) {
		reject(`Positions unavailable during order preflight: ${errorMessage(error)}`, true);
	}
	const matches = positions.filter(
		(position) =>
			position.symbol === prepared.symbol &&
			Math.abs(position.amount) > 0 &&
			position.positionSide === prepared.positionSide &&
			reduceSide(position) === plan.side,
	);
	if (matches.length !== 1) {
		reject(`The confirmed reducing position on ${plan.input.symbol} is no longer uniquely available`);
	}
	const current = matches[0];
	const currentAmount = Math.abs(current.amount);
	if (currentAmount < plan.amount && !futuresAmountsEqual(currentAmount, plan.amount)) {
		reject(`The current position amount ${currentAmount} no longer covers the confirmed reduction ${plan.amount}`);
	}
	if (!plan.closePosition) return undefined;
	if (!futuresAmountsEqual(currentAmount, plan.amount)) {
		reject(
			`The close-position amount changed from ${plan.amount} to ${currentAmount}; prepare and confirm a new order`,
		);
	}
	const currentNotional =
		current.quoteValue !== undefined && Number.isFinite(current.quoteValue) && current.quoteValue > 0
			? current.quoteValue
			: currentAmount * plan.referencePrice;
	return currentNotional;
}

async function revalidateOcoPrice(plan: PreparedOco, getTicker: (symbol: string) => Promise<Ticker>): Promise<number> {
	const ticker = await loadTicker(plan.input.symbol, getTicker);
	const currentPrice = finitePrice(ticker.last, "Current last price");
	const valid =
		plan.input.side === "sell"
			? plan.input.stopLossPrice < currentPrice && currentPrice < plan.input.takeProfitPrice
			: plan.input.takeProfitPrice < currentPrice && currentPrice < plan.input.stopLossPrice;
	if (!valid) reject(`Current price ${currentPrice} invalidates the confirmed OCO price range`);
	return currentPrice;
}

export async function preflightOrder(
	plan: PreparedOrder,
	dependencies: {
		getMarketInfo(symbol: string): Promise<MarketInfo>;
		getBalances(): Promise<Balance[]>;
		getTicker(symbol: string): Promise<Ticker>;
		getPositions(): Promise<Position[]>;
		quoteCurrency: string;
		marketType: MarketType;
		getEffectiveLeverage(symbol: string): number;
		feeRate?: number;
	},
): Promise<OrderPreflightResult> {
	const futures = isFuturesSymbol(plan.input.symbol, dependencies.quoteCurrency);
	let market: MarketInfo;
	try {
		market = await dependencies.getMarketInfo(plan.input.symbol);
	} catch (error) {
		reject(`Market metadata unavailable during order preflight: ${errorMessage(error)}`, true);
	}
	checkMarketLimits(plan, market, futures);
	const referencePrice = await revalidateOrderPrice(plan, dependencies.getTicker);
	const closeNotional = await revalidateReducingPosition(plan, dependencies.getPositions);
	let balances: Balance[];
	try {
		balances = await dependencies.getBalances();
	} catch (error) {
		reject(`Balances unavailable during order preflight: ${errorMessage(error)}`, true);
	}
	checkBalance(
		plan,
		balances,
		dependencies.quoteCurrency,
		futures,
		dependencies.marketType,
		dependencies.getEffectiveLeverage,
		dependencies.feeRate,
	);
	const evaluated = evaluateOrderCapability({ ...plan.capabilityContext, marketInfo: market }, plan.input);
	const notional =
		closeNotional ??
		(["ask", "bid", "last"].includes(plan.referencePriceSource) ? plan.amount * referencePrice : plan.notional);
	return {
		warnings: evaluated.capability.status === "unknown" ? [evaluated.capability.reason] : [],
		evidence: confirmationEvidence(market, referencePrice, plan.amount, notional, notional),
	};
}

export async function preflightOco(
	plan: PreparedOco,
	dependencies: {
		getMarketInfo(symbol: string): Promise<MarketInfo>;
		getBalances(): Promise<Balance[]>;
		getTicker?(symbol: string): Promise<Ticker>;
		quoteCurrency: string;
		feeRate?: number;
	},
): Promise<OcoPreflightResult> {
	let market: MarketInfo;
	try {
		market = await dependencies.getMarketInfo(plan.input.symbol);
	} catch (error) {
		reject(`Market metadata unavailable during OCO preflight: ${errorMessage(error)}`, true);
	}
	if (market.active === false) reject(`Market ${plan.input.symbol} is inactive`);
	if (!marketMatches(market, plan.input.symbol, dependencies.quoteCurrency, false)) {
		reject("Returned market metadata does not match the requested OCO spot symbol or quote currency", true);
	}
	const referencePrice = dependencies.getTicker
		? await revalidateOcoPrice(plan, dependencies.getTicker)
		: plan.referencePrice;
	const ocoCapability = getTradingCapabilities({ ...plan.capabilityContext, marketInfo: market }).oco[plan.input.side];
	if (ocoCapability.status === "unsupported") reject(ocoCapability.reason);
	const minAmount = market.minAmount ?? market.limits?.amount?.min;
	const maxAmount = market.limits?.amount?.max;
	if (minAmount !== undefined && plan.input.amount < minAmount)
		reject(`OCO amount ${plan.input.amount} is below market minimum ${minAmount}`);
	if (maxAmount !== undefined && plan.input.amount > maxAmount)
		reject(`OCO amount ${plan.input.amount} exceeds market maximum ${maxAmount}`);
	if (market.minNotional !== undefined && plan.riskNotional < market.minNotional)
		reject(`OCO risk notional ${plan.riskNotional} is below market minimum ${market.minNotional}`);
	if (market.limits?.cost?.max !== undefined && plan.riskNotional > market.limits.cost.max)
		reject(`OCO risk notional ${plan.riskNotional} exceeds market maximum ${market.limits.cost.max}`);
	let balances: Balance[];
	try {
		balances = await dependencies.getBalances();
	} catch (error) {
		reject(`Balances unavailable during OCO preflight: ${errorMessage(error)}`, true);
	}
	const asset = plan.input.side === "sell" ? plan.input.symbol.split("/")[0] : dependencies.quoteCurrency;
	const balance = balances.find((candidate) => candidate.asset === asset);
	if (balance === undefined || !Number.isFinite(balance.free))
		reject(`No finite free ${asset} balance was returned during OCO preflight`, true);
	const estimatedFee = dependencies.feeRate === undefined ? undefined : plan.riskNotional * dependencies.feeRate;
	const worstCaseQuote = plan.input.amount * Math.max(plan.input.stopLossPrice, plan.input.takeProfitPrice);
	const required = plan.input.side === "sell" ? plan.input.amount : worstCaseQuote + (estimatedFee ?? 0);
	if (balance.free < required) reject(`Insufficient available ${asset}: need ${required}, have ${balance.free}`);
	const observedNotional = plan.input.amount * referencePrice;
	const riskNotional = plan.input.side === "buy" ? plan.riskNotional : observedNotional;
	return {
		warnings: ocoCapability.status === "unknown" ? [ocoCapability.reason] : [],
		evidence: confirmationEvidence(market, referencePrice, plan.input.amount, observedNotional, riskNotional),
		market,
		balance,
		balanceAsset: asset,
		requiredBalance: required,
		estimatedFee,
	};
}
