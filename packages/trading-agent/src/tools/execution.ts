import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MarketInfo } from "@earendil-works/ti-trading-engine";
import {
	futuresAmountStep,
	isBinanceCloseAllTrigger,
	OrderPreparationError,
	type PreparedOco,
	type PreparedOrder,
	RiskCommitError,
} from "@earendil-works/ti-trading-engine";
import type { TradingRuntime } from "../context.ts";
import { marketInfoMatchesFamily, paperFuturesOrderUnsupported } from "./capabilities.ts";
import {
	errorMessage,
	formatOrder,
	isSubmissionStatusUnknown,
	jsonResult,
	round,
	type TradingProvider,
} from "./format.ts";
import type { OcoToolParams, OrderToolParams } from "./schemas.ts";

export interface FuturesMarginEstimate {
	openingMargin: number;
	releasedMargin?: number;
	estimatedPnl?: number;
	netRequired?: number;
	availableAfterClose?: number;
	known: boolean;
	reason?: string;
}

/**
 * Paper futures can account for a reducing order without treating the
 * position's released margin and PnL as zero. Live adapters currently do not
 * expose enough fee/maintenance-margin data, so callers keep that result
 * explicitly unknown instead of making a false sufficiency claim.
 */
export function estimatePaperFuturesMargin(
	plan: PreparedOrder,
	leverage: number,
	fee: number,
	balanceFree: number | undefined,
): FuturesMarginEstimate {
	const openingMargin = plan.reducingPosition ? 0 : plan.notional / Math.max(leverage, 1);
	const position = plan.reducingPosition;
	if (!position) {
		const netRequired = openingMargin + fee;
		return {
			openingMargin,
			estimatedPnl: 0,
			netRequired,
			availableAfterClose: balanceFree,
			known: true,
		};
	}
	const positionAmount = Math.abs(position.amount);
	const margin = position.margin;
	const averageEntry = position.avgEntryPrice;
	const direction =
		position.positionSide === "SHORT" ? -1 : position.positionSide === "LONG" ? 1 : Math.sign(position.amount);
	if (
		!Number.isFinite(positionAmount) ||
		positionAmount <= 0 ||
		margin === undefined ||
		!Number.isFinite(margin) ||
		margin < 0 ||
		averageEntry === undefined ||
		!Number.isFinite(averageEntry) ||
		averageEntry <= 0 ||
		direction === 0
	) {
		return {
			openingMargin,
			known: false,
			reason: "Reducing-position margin, average entry price, or direction is unavailable",
		};
	}
	const closeRatio = Math.min(plan.amount / positionAmount, 1);
	const releasedMargin = margin * closeRatio;
	const estimatedPnl = plan.amount * (plan.referencePrice - averageEntry) * direction;
	const netRequired = openingMargin + fee - releasedMargin - estimatedPnl;
	return {
		openingMargin,
		releasedMargin,
		estimatedPnl,
		netRequired,
		availableAfterClose: balanceFree === undefined ? undefined : balanceFree + releasedMargin + estimatedPnl,
		known: true,
	};
}

export function executionConstraints(plan: PreparedOrder): {
	reduceOnlyRequested: boolean;
	reduceOnlyApplied: boolean;
	exchangeConstraint: string | null;
} {
	return {
		reduceOnlyRequested: plan.reduceOnlyRequested,
		reduceOnlyApplied: plan.reduceOnlyApplied,
		exchangeConstraint: plan.exchangeConstraint ?? null,
	};
}

export function resolveExchangeAmount(
	plan: PreparedOrder,
	marketInfo: MarketInfo | undefined,
	futures: boolean,
	closeAllTrigger = false,
): { amount?: number; unit: "base" | "contracts"; contractSize?: number; reason?: string; invalid?: boolean } {
	if (!futures) return { amount: plan.amount, unit: "base", contractSize: 1 };
	if (marketInfo === undefined) {
		return {
			unit: "contracts",
			reason: "Futures market metadata is unavailable; exchange amount cannot be derived",
		};
	}
	if (marketInfo.contract !== true || marketInfo.linear !== true || marketInfo.amountUnit === "base") {
		return {
			unit: "contracts",
			reason:
				"Futures market is not confirmed as a linear contract with contract-denominated amounts; refusing to guess the amount unit",
		};
	}
	const contractSize = marketInfo?.contractSize;
	if (contractSize === undefined || !Number.isFinite(contractSize) || contractSize <= 0) {
		return {
			unit: "contracts",
			reason: "Futures contractSize is unavailable; exchange amount limits cannot be checked safely",
		};
	}
	if (closeAllTrigger) {
		return {
			unit: "contracts",
			contractSize,
			reason:
				"Binance close-all trigger omits exchange quantity; the requested base amount identifies the matching position and exchange amount is informational only",
		};
	}
	const amount = plan.amount / contractSize;
	if (!Number.isFinite(amount) || amount <= 0) {
		return {
			unit: "contracts",
			contractSize,
			reason: "Order amount cannot be converted to futures contracts",
			invalid: true,
		};
	}
	const tolerance = Math.max(1e-12, Math.abs(plan.amount) * 1e-9);
	if (Math.abs(amount * contractSize - plan.amount) > tolerance) {
		return {
			amount,
			unit: "contracts",
			contractSize,
			reason: `Order amount ${plan.amount} base units is not exactly representable with contractSize ${contractSize}`,
			invalid: true,
		};
	}
	const step = futuresAmountStep(marketInfo);
	if (step !== undefined) {
		const units = amount / step;
		if (!Number.isFinite(units) || Math.abs(units - Math.round(units)) > 1e-9) {
			return {
				amount,
				unit: "contracts",
				contractSize,
				reason: `Exchange amount ${amount} contracts is not aligned to precision step ${step}`,
				invalid: true,
			};
		}
	}
	return { amount, unit: "contracts", contractSize };
}

const USER_CANCELLED_ORDER = "Order cancelled by user";

function needsLiveConfirmation(trading: TradingRuntime): boolean {
	return trading.mode === "live" && trading.config.confirmLiveOrders;
}

function liveOrderConfirm(
	ctx: ExtensionContext,
	trading: TradingRuntime,
	title: string,
): ((summary: string) => Promise<boolean>) | undefined {
	if (!needsLiveConfirmation(trading)) return undefined;
	return async (summary) => {
		if (!ctx.hasUI) {
			throw new Error(
				"Live orders require interactive confirmation but no UI is available. " +
					"Set confirmLiveOrders=false in ~/.ti-trader/agent/trading.json to allow headless live trading.",
			);
		}
		const usage = trading.tradingEngine.risk.usage();
		return ctx.ui.confirm(
			title,
			`${summary}\n\nReserved/used notional after fill: ${(usage.used + usage.reserved).toFixed(2)} / ${usage.limit} ${trading.config.quoteCurrency}`,
		);
	};
}

export async function confirmLiveRiskChange(
	ctx: ExtensionContext,
	trading: TradingRuntime,
	options: {
		missingUiMessage: string;
		title: string;
		summary: string;
		cancelledMessage: string;
		cancelledResult: unknown;
	},
): Promise<AgentToolResult<unknown> | undefined> {
	if (!needsLiveConfirmation(trading)) return undefined;
	if (!ctx.hasUI) throw new Error(options.missingUiMessage);
	const confirmed = await ctx.ui.confirm(options.title, options.summary);
	if (confirmed) return undefined;
	ctx.ui.notify(options.cancelledMessage, "info");
	return jsonResult(options.cancelledResult);
}

function userRejectedConfirmation(ctx: ExtensionContext, summary: string): AgentToolResult<unknown> {
	ctx.ui.notify(USER_CANCELLED_ORDER, "info");
	return jsonResult({ status: "cancelled", reason: "user rejected confirmation", order: summary });
}

function handlePlacementFailure(
	ctx: ExtensionContext,
	error: unknown,
	planSummary: string,
	submitted: boolean,
	labels: { submitted: string; unknown: string },
): AgentToolResult<unknown> {
	if (error instanceof RiskCommitError) throw error;
	if (errorMessage(error) === USER_CANCELLED_ORDER) return userRejectedConfirmation(ctx, planSummary);
	const message = errorMessage(error);
	if (submitted) {
		throw new Error(`${labels.submitted} was submitted and the result could not be reported: ${message}`);
	}
	// A transport failure after submission is ambiguous: the exchange may
	// already own the order. Keep the quota reserved until reconciliation
	// confirms that no order exists; releasing it would allow a duplicate
	// live order on an immediate retry.
	if (isSubmissionStatusUnknown(error)) {
		throw new Error(
			`${labels.unknown} submission status is unknown; risk quota remains reserved until exchange reconciliation. Do not retry: ${message}`,
		);
	}
	throw error;
}

export async function executeOrder(
	side: "buy" | "sell",
	params: OrderToolParams,
	ctx: ExtensionContext,
	trading: TradingRuntime,
): Promise<AgentToolResult<unknown>> {
	const { config } = trading;
	const engine = trading.tradingEngine;
	const unsupported = paperFuturesOrderUnsupported(trading, params.symbol, params.type);
	if (unsupported) throw new Error(unsupported);
	const plan = await engine.prepareOrder(side, params);
	let submitted = false;
	try {
		const confirm = liveOrderConfirm(ctx, trading, `Confirm LIVE order on ${config.exchange}`);
		const result = await engine.placeOrder(plan, {
			...(confirm === undefined ? {} : { confirm }),
			submissionStatusUnknown: isSubmissionStatusUnknown,
		});
		submitted = true;

		return jsonResult({
			status: "ok",
			mode: trading.mode,
			summary: plan.summary,
			executionConstraints: executionConstraints(plan),
			fee: round(result.fee, 4),
			order: formatOrder(
				result.order,
				plan.closePosition
					? {
							requestedAmount: plan.amount,
							amountSource: isBinanceCloseAllTrigger(trading.tradingEngine.planningContext, plan)
								? "exchange_omitted_quantity_for_close_all"
								: "exchange_quantity_for_market_close",
							exchangeQuantitySemantics: isBinanceCloseAllTrigger(trading.tradingEngine.planningContext, plan)
								? "close_all_trigger_may_omit_quantity"
								: "explicit_exchange_quantity",
						}
					: undefined,
			),
		});
	} catch (error) {
		return handlePlacementFailure(ctx, error, plan.summary, submitted, {
			submitted: "Order",
			unknown: "Order",
		});
	}
}

export async function executeOco(
	params: OcoToolParams,
	ctx: ExtensionContext,
	tradingProvider: TradingProvider,
): Promise<AgentToolResult<unknown>> {
	const trading = tradingProvider();
	const { config } = trading;
	let plan: PreparedOco;
	try {
		plan = await trading.tradingEngine.prepareOcoOrder(params);
	} catch (error) {
		if (error instanceof OrderPreparationError) throw new Error(error.message);
		throw error;
	}

	const [marketInfo, balances] = await Promise.all([
		trading.tradingEngine.getMarketInfo(plan.input.symbol),
		trading.tradingEngine.getBalances(),
	]);
	if (marketInfo.active === false) throw new Error(`Market ${plan.input.symbol} is inactive`);
	if (!marketInfoMatchesFamily(marketInfo, plan.input.symbol, "spot", config.quoteCurrency)) {
		throw new Error("Returned market metadata does not match the requested spot symbol or quote currency");
	}
	const minAmount = marketInfo.minAmount ?? marketInfo.limits?.amount?.min;
	const maxAmount = marketInfo.limits?.amount?.max;
	if (minAmount !== undefined && plan.input.amount < minAmount)
		throw new Error(`OCO amount ${plan.input.amount} is below market minimum ${minAmount}`);
	if (maxAmount !== undefined && plan.input.amount > maxAmount)
		throw new Error(`OCO amount ${plan.input.amount} exceeds market maximum ${maxAmount}`);
	if (marketInfo.minNotional !== undefined && plan.riskNotional < marketInfo.minNotional)
		throw new Error(`OCO risk notional ${plan.riskNotional} is below market minimum ${marketInfo.minNotional}`);
	if (marketInfo.limits?.cost?.max !== undefined && plan.riskNotional > marketInfo.limits.cost.max)
		throw new Error(`OCO risk notional ${plan.riskNotional} exceeds market maximum ${marketInfo.limits.cost.max}`);

	const baseAsset = plan.input.symbol.split("/")[0];
	const balanceAsset = plan.input.side === "sell" ? baseAsset : config.quoteCurrency;
	const balance = balances.find((candidate) => candidate.asset === balanceAsset);
	if (balance === undefined || !Number.isFinite(balance.free)) {
		throw new Error(`No finite free ${balanceAsset} balance is available for this OCO order`);
	}
	const estimatedFee = trading.mode === "paper" ? plan.riskNotional * config.paper.feeRate : undefined;
	const worstCaseQuote = plan.input.amount * Math.max(plan.input.stopLossPrice, plan.input.takeProfitPrice);
	const requiredBalance = plan.input.side === "sell" ? plan.input.amount : worstCaseQuote + (estimatedFee ?? 0);
	if (balance.free < requiredBalance) {
		throw new Error(
			`Insufficient free ${balanceAsset} for OCO: need ${requiredBalance.toFixed(8)}, have ${balance.free.toFixed(8)}`,
		);
	}
	const engine = trading.tradingEngine;
	const riskError = engine.risk.check(plan.input.symbol, plan.riskNotional, {
		countTowardsDailyLimit: plan.countTowardsDailyLimit,
	});
	if (riskError) throw new Error(`Risk limit: ${riskError}`);
	const warnings = [
		...(plan.input.side === "buy"
			? [
					"OCO buy balance is checked against the higher trigger price; final spend depends on exchange execution semantics",
				]
			: []),
		...(trading.mode === "live" && plan.input.side === "buy"
			? ["Live OCO fee rates are not exposed by the adapter; exchange balance checks remain authoritative"]
			: []),
	];

	let submitted = false;
	try {
		const confirm = liveOrderConfirm(ctx, trading, `Confirm LIVE OCO order on ${config.exchange}`);
		const result = await engine.placeOco(plan, {
			...(confirm === undefined ? {} : { confirm }),
			submissionStatusUnknown: isSubmissionStatusUnknown,
		});
		submitted = true;

		return jsonResult({
			status: "ok",
			mode: trading.mode,
			summary: plan.summary,
			preflight: {
				referencePrice: plan.referencePrice,
				referenceTime: new Date(plan.referenceTimestamp).toISOString(),
				estimatedNotional: round(plan.riskNotional, 2),
				observedNotional: round(plan.observedNotional, 2),
				balance: { asset: balanceAsset, free: balance.free, required: requiredBalance },
				fees: { estimated: estimatedFee ?? null },
				warnings,
			},
			orders: result.orders.map((order) => formatOrder(order)),
		});
	} catch (error) {
		return handlePlacementFailure(ctx, error, plan.summary, submitted, {
			submitted: "OCO order",
			unknown: "OCO",
		});
	}
}
