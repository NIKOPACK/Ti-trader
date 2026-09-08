import { evaluateOrderCapability, getTradingCapabilities } from "./capabilities.ts";
import type { MarketType } from "./client-types.ts";
import { futuresAmountStep, isFuturesSymbol, type PreparedOco, type PreparedOrder } from "./order-plan.ts";
import type { Balance, MarketInfo } from "./types.ts";

export class OrderPreflightError extends Error {
	readonly code = "ORDER_PREFLIGHT_REJECTED" as const;
	readonly uncertain: boolean;

	constructor(message: string, uncertain = false) {
		super(message);
		this.name = "OrderPreflightError";
		this.uncertain = uncertain;
	}
}

export interface OrderPreflightResult {
	warnings: string[];
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
	if (!futures) return { amount: plan.amount, unit: "base" };
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
	const minAmount = market.minAmount ?? market.limits?.amount?.min;
	const maxAmount = market.limits?.amount?.max;
	if (minAmount !== undefined && amount.amount < minAmount) {
		reject(`Exchange amount ${amount.amount} ${amount.unit} is below market minimum ${minAmount}`);
	}
	if (maxAmount !== undefined && amount.amount > maxAmount) {
		reject(`Exchange amount ${amount.amount} ${amount.unit} exceeds market maximum ${maxAmount}`);
	}
	if (market.minNotional !== undefined && plan.notional < market.minNotional) {
		reject(`Estimated notional ${plan.notional} is below market minimum ${market.minNotional}`);
	}
	if (market.limits?.cost?.max !== undefined && plan.notional > market.limits.cost.max) {
		reject(`Estimated notional ${plan.notional} exceeds market maximum ${market.limits.cost.max}`);
	}
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
	}
	if (balance.free < required) reject(`Insufficient available ${asset}: need ${required}, have ${balance.free}`);
}

export async function preflightOrder(
	plan: PreparedOrder,
	dependencies: {
		getMarketInfo(symbol: string): Promise<MarketInfo>;
		getBalances(): Promise<Balance[]>;
		quoteCurrency: string;
		marketType: MarketType;
		getEffectiveLeverage(symbol: string): number;
	},
): Promise<OrderPreflightResult> {
	const futures = isFuturesSymbol(plan.input.symbol, dependencies.quoteCurrency);
	let market: MarketInfo;
	try {
		market = await dependencies.getMarketInfo(plan.input.symbol);
	} catch (error) {
		reject(
			`Market metadata unavailable during order preflight: ${error instanceof Error ? error.message : String(error)}`,
			true,
		);
	}
	checkMarketLimits(plan, market, futures);
	let balances: Balance[];
	try {
		balances = await dependencies.getBalances();
	} catch (error) {
		reject(
			`Balances unavailable during order preflight: ${error instanceof Error ? error.message : String(error)}`,
			true,
		);
	}
	checkBalance(
		plan,
		balances,
		dependencies.quoteCurrency,
		futures,
		dependencies.marketType,
		dependencies.getEffectiveLeverage,
	);
	const evaluated = evaluateOrderCapability({ ...plan.capabilityContext, marketInfo: market }, plan.input);
	return { warnings: evaluated.capability.status === "unknown" ? [evaluated.capability.reason] : [] };
}

export async function preflightOco(
	plan: PreparedOco,
	dependencies: {
		getMarketInfo(symbol: string): Promise<MarketInfo>;
		getBalances(): Promise<Balance[]>;
		quoteCurrency: string;
		feeRate?: number;
	},
): Promise<OcoPreflightResult> {
	let market: MarketInfo;
	try {
		market = await dependencies.getMarketInfo(plan.input.symbol);
	} catch (error) {
		reject(
			`Market metadata unavailable during OCO preflight: ${error instanceof Error ? error.message : String(error)}`,
			true,
		);
	}
	if (market.active === false) reject(`Market ${plan.input.symbol} is inactive`);
	if (!marketMatches(market, plan.input.symbol, dependencies.quoteCurrency, false)) {
		reject("Returned market metadata does not match the requested OCO spot symbol or quote currency", true);
	}
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
		reject(
			`Balances unavailable during OCO preflight: ${error instanceof Error ? error.message : String(error)}`,
			true,
		);
	}
	const asset = plan.input.side === "sell" ? plan.input.symbol.split("/")[0] : dependencies.quoteCurrency;
	const balance = balances.find((candidate) => candidate.asset === asset);
	if (balance === undefined || !Number.isFinite(balance.free))
		reject(`No finite free ${asset} balance was returned during OCO preflight`, true);
	const estimatedFee = dependencies.feeRate === undefined ? undefined : plan.riskNotional * dependencies.feeRate;
	const worstCaseQuote = plan.input.amount * Math.max(plan.input.stopLossPrice, plan.input.takeProfitPrice);
	const required = plan.input.side === "sell" ? plan.input.amount : worstCaseQuote + (estimatedFee ?? 0);
	if (balance.free < required) reject(`Insufficient available ${asset}: need ${required}, have ${balance.free}`);
	return {
		warnings: ocoCapability.status === "unknown" ? [ocoCapability.reason] : [],
		market,
		balance,
		balanceAsset: asset,
		requiredBalance: required,
		estimatedFee,
	};
}
