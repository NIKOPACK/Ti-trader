import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	evaluateOrderCapability,
	isBinanceCloseAllTrigger,
	isFuturesSymbol,
	type OrderIntent,
	OrderPreparationError,
	type PreparedOrder,
} from "@nikopack/ti-trading-engine";
import { getTrading } from "../context.ts";
import {
	cancelOrderListSchema,
	cancelOrderSchema,
	checkOrderSchema,
	confirmLiveRiskChange,
	estimatePaperFuturesMargin,
	executeOco,
	executeOrder,
	executionConstraints,
	formatOrder,
	getOrderListStatusSchema,
	getOrderStatusSchema,
	jsonResult,
	marketInfoMatchesPreflight,
	ocoSchema,
	orderHistorySchema,
	orderSchema,
	paperFuturesOrderUnsupported,
	resolveExchangeAmount,
	round,
	symbolFilterSchema,
	type TradingProvider,
	UNATTENDED_LIVE_CONFIG_HINT,
} from "./shared.ts";

function requireExactlyOne(left: string | undefined, right: string | undefined, names: string): void {
	if ((left === undefined) === (right === undefined)) throw new Error(`Provide exactly one of ${names}`);
}

export function createGetOpenOrdersTool(
	tradingProvider: TradingProvider = getTrading,
): ToolDefinition<typeof symbolFilterSchema> {
	return {
		name: "get_open_orders",
		label: "get_open_orders",
		description: "List open (unfilled) orders, optionally filtered by symbol.",
		parameters: symbolFilterSchema,
		async execute(_id, params) {
			const trading = tradingProvider();
			const orders = await trading.tradingEngine.getOpenOrders(params.symbol);
			return jsonResult({
				count: orders.length,
				orders: orders.map((order) => formatOrder(order)),
			});
		},
	};
}

export function createGetOrderStatusTool(
	tradingProvider: TradingProvider = getTrading,
): ToolDefinition<typeof getOrderStatusSchema> {
	return {
		name: "get_order_status",
		label: "get_order_status",
		description: "Query one order by symbol and id. Returns the exchange status or propagates the query error.",
		parameters: getOrderStatusSchema,
		async execute(_id, params) {
			requireExactlyOne(params.id, params.origClientOrderId, "id or origClientOrderId");
			const trading = tradingProvider();
			const engine = trading.tradingEngine;
			const order =
				params.id !== undefined
					? await engine.getOrder(params.id, params.symbol)
					: await engine.getOrderByClientId(params.origClientOrderId!, params.symbol);
			return jsonResult({ status: "ok", error: null, order: formatOrder(order) });
		},
	};
}

export function createGetOrderListStatusTool(
	tradingProvider: TradingProvider = getTrading,
): ToolDefinition<typeof getOrderListStatusSchema> {
	return {
		name: "get_order_list_status",
		label: "get_order_list_status",
		description: "Query a native OCO/order-list by orderListId.",
		parameters: getOrderListStatusSchema,
		async execute(_id, params) {
			requireExactlyOne(params.orderListId, params.listClientOrderId, "orderListId or listClientOrderId");
			const trading = tradingProvider();
			const engine = trading.tradingEngine;
			const list =
				params.orderListId !== undefined
					? await engine.getOrderList(params.orderListId)
					: await engine.getOrderListByClientId(params.listClientOrderId!);
			return jsonResult({
				status: "ok",
				error: null,
				orderList: { ...list, orders: list.orders.map((order) => formatOrder(order)) },
			});
		},
	};
}

export function createGetOrderHistoryTool(
	tradingProvider: TradingProvider = getTrading,
): ToolDefinition<typeof orderHistorySchema> {
	return {
		name: "get_order_history",
		label: "get_order_history",
		description:
			"List recent terminal orders (filled, canceled, rejected or expired), optionally filtered by symbol.",
		parameters: orderHistorySchema,
		async execute(_id, params) {
			const trading = tradingProvider();
			const limit = Math.min(Math.max(Math.floor(params.limit ?? 20), 1), 100);
			const orders = await trading.tradingEngine.getOrderHistory(params.symbol, limit);
			return jsonResult({
				count: orders.length,
				orders: orders.map((order) => formatOrder(order)),
			});
		},
	};
}

export function createCheckOrderTool(
	tradingProvider: TradingProvider = getTrading,
): ToolDefinition<typeof checkOrderSchema> {
	return {
		name: "check_order",
		label: "check_order",
		description:
			"Run a read-only order preflight. It resolves amount, reference price and risk without reserving quota or submitting an order; exchange filters are checked again at placement.",
		parameters: checkOrderSchema,
		async execute(_id, params) {
			const trading = tradingProvider();
			const unsupported = paperFuturesOrderUnsupported(trading, params.symbol, params.type);
			if (unsupported) {
				return jsonResult({
					status: "rejected",
					phase: "preflight",
					side: params.side,
					symbol: params.symbol,
					reason: unsupported,
					warnings: [],
				});
			}
			const intent: OrderIntent = {
				symbol: params.symbol,
				type: params.type,
				amount: params.amount,
				quoteAmount: params.quoteAmount,
				price: params.price,
				reduceOnly: params.reduceOnly,
				positionSide: params.positionSide,
				stopPrice: params.stopPrice,
				trailingPercent: params.trailingPercent,
				closePosition: params.closePosition,
			};
			let plan: PreparedOrder;
			try {
				plan = await trading.tradingEngine.prepareOrder(params.side, intent);
			} catch (error) {
				if (!(error instanceof OrderPreparationError)) throw error;
				if (error.uncertain) {
					return jsonResult({
						status: "unknown",
						phase: "preflight",
						side: params.side,
						symbol: params.symbol,
						reason: error.message,
						blockingReasons: [error.message],
						unknownReasons: [error.message],
						warnings: [error.message],
					});
				}
				return jsonResult({
					status: "rejected",
					phase: "preflight",
					side: params.side,
					symbol: params.symbol,
					reason: error.message,
					warnings: [],
				});
			}

			const [marketInfoResult, balancesResult] = await Promise.allSettled([
				trading.tradingEngine.getMarketInfo(plan.input.symbol),
				trading.tradingEngine.getBalances(),
			]);
			const marketInfo = marketInfoResult.status === "fulfilled" ? marketInfoResult.value : undefined;
			const balances = balancesResult.status === "fulfilled" ? balancesResult.value : undefined;
			const marketInfoError =
				marketInfoResult.status === "rejected"
					? marketInfoResult.reason instanceof Error
						? marketInfoResult.reason.message
						: String(marketInfoResult.reason)
					: undefined;
			const balancesError =
				balancesResult.status === "rejected"
					? balancesResult.reason instanceof Error
						? balancesResult.reason.message
						: String(balancesResult.reason)
					: undefined;
			const riskError = trading.tradingEngine.risk.check(plan.input.symbol, plan.notional, {
				countTowardsDailyLimit: plan.countTowardsDailyLimit,
			});
			const usage = trading.tradingEngine.risk.usage();
			const futures = isFuturesSymbol(plan.input.symbol, trading.config.quoteCurrency);
			const closeAllTrigger = isBinanceCloseAllTrigger(trading.tradingEngine.planningContext, plan);
			const exchangeAmount = resolveExchangeAmount(plan, marketInfo, futures, closeAllTrigger);
			const baseAsset = plan.input.symbol.split("/")[0];
			const balanceAsset = futures
				? trading.config.marketType === "both"
					? `futures:${trading.config.quoteCurrency}`
					: trading.config.quoteCurrency
				: params.side === "buy"
					? trading.config.quoteCurrency
					: baseAsset;
			const balance = balances?.find((candidate) => candidate.asset === balanceAsset);
			const estimatedFee = trading.mode === "paper" ? plan.notional * trading.config.paper.feeRate : undefined;
			const effectiveLeverage = futures
				? trading.tradingEngine.getEffectiveLeverage(plan.input.symbol)
				: trading.config.leverage;
			const marginEstimate =
				futures && trading.mode === "paper"
					? estimatePaperFuturesMargin(plan, effectiveLeverage, estimatedFee ?? 0, balance?.free)
					: undefined;
			const marginRequired =
				marginEstimate?.netRequired === undefined ? undefined : Math.max(0, marginEstimate.netRequired);
			const balanceSufficient =
				balance === undefined || !Number.isFinite(balance.free)
					? undefined
					: futures
						? trading.mode === "paper" &&
							marginEstimate?.known === true &&
							marginEstimate.netRequired !== undefined
							? balance.free + (marginEstimate.releasedMargin ?? 0) + (marginEstimate.estimatedPnl ?? 0) >=
								marginEstimate.openingMargin + (estimatedFee ?? 0)
							: undefined
						: params.side === "buy"
							? trading.mode === "paper"
								? balance.free >= plan.notional + (estimatedFee ?? 0)
								: undefined
							: balance.free >= plan.amount;
			const liveMinimumRequired =
				trading.mode !== "live"
					? undefined
					: futures
						? plan.reducingPosition
							? 0
							: plan.notional / Math.max(effectiveLeverage, 1)
						: params.side === "buy"
							? plan.notional
							: undefined;
			const marketFamily = futures ? "futures" : "spot";
			const marketMatches =
				marketInfo !== undefined &&
				marketInfoMatchesPreflight(marketInfo, plan.input.symbol, marketFamily, trading.config.quoteCurrency);
			const orderCapability = evaluateOrderCapability(
				{
					...plan.capabilityContext,
					marketInfo,
					metadataValid: marketMatches,
				},
				plan.input,
			);
			const hardReasons = [
				...(riskError ? [riskError] : []),
				...(balanceSufficient === false ? [`Insufficient available ${balanceAsset} for this estimate`] : []),
				...(balance !== undefined &&
				Number.isFinite(balance.free) &&
				liveMinimumRequired !== undefined &&
				balance.free < liveMinimumRequired
					? [`Available ${balanceAsset} is below the minimum initial requirement ${liveMinimumRequired}`]
					: []),
				...(marketInfo !== undefined && !marketMatches
					? ["Returned market metadata does not match the requested symbol, quote currency or market family"]
					: []),
				...(marketInfo?.active === false ? [`Market ${plan.input.symbol} is inactive`] : []),
				...(orderCapability.capability.status === "unsupported" ? [orderCapability.capability.reason] : []),
				...(!closeAllTrigger &&
				marketInfo?.minAmount !== undefined &&
				exchangeAmount.amount !== undefined &&
				exchangeAmount.amount < marketInfo.minAmount
					? [
							`Exchange amount ${exchangeAmount.amount} ${exchangeAmount.unit} is below market minimum ${marketInfo.minAmount}`,
						]
					: []),
				...(!closeAllTrigger &&
				marketInfo?.limits?.amount?.max !== undefined &&
				exchangeAmount.amount !== undefined &&
				exchangeAmount.amount > marketInfo.limits.amount.max
					? [
							`Exchange amount ${exchangeAmount.amount} ${exchangeAmount.unit} exceeds market maximum ${marketInfo.limits.amount.max}`,
						]
					: []),
				...(!closeAllTrigger && marketInfo?.minNotional !== undefined && plan.notional < marketInfo.minNotional
					? [`Estimated notional ${plan.notional} is below market minimum ${marketInfo.minNotional}`]
					: []),
				...(!closeAllTrigger &&
				marketInfo?.limits?.cost?.max !== undefined &&
				plan.notional > marketInfo.limits.cost.max
					? [`Estimated notional ${plan.notional} exceeds market maximum ${marketInfo.limits.cost.max}`]
					: []),
				...(exchangeAmount.invalid && exchangeAmount.reason ? [exchangeAmount.reason] : []),
			];
			const executionCaveats = [
				...(orderCapability.capability.status === "unknown" ? [orderCapability.capability.reason] : []),
				...(closeAllTrigger && exchangeAmount.reason ? [exchangeAmount.reason] : []),
				...(futures && trading.mode === "live"
					? [
							"Live futures fee and maintenance-margin data are not exposed by the adapter; margin sufficiency is unknown",
						]
					: []),
				...(params.side === "buy" && !futures && trading.mode === "live"
					? ["Live spot trading fee is not exposed by the adapter; buy-side balance sufficiency is unknown"]
					: []),
			];
			const unknownReasons = [
				...(marketInfoError ? [`Market filters unavailable during preflight: ${marketInfoError}`] : []),
				...(balancesError ? [`Balance unavailable during preflight: ${balancesError}`] : []),
				...(marketInfo === undefined && !marketInfoError
					? ["Market metadata was not returned during preflight"]
					: []),
				...(balances === undefined && !balancesError ? ["Balances were not returned during preflight"] : []),
				...(balance === undefined && balances !== undefined
					? [`No ${balanceAsset} free-balance record was returned; sufficiency is unknown`]
					: []),
				...(futures && trading.mode === "paper" && marginEstimate?.reason ? [marginEstimate.reason] : []),
				...(exchangeAmount.reason && !exchangeAmount.invalid && !closeAllTrigger ? [exchangeAmount.reason] : []),
				...executionCaveats,
			];
			const blockingUnknownReasons = unknownReasons.filter((reason) => !executionCaveats.includes(reason));
			const blockingReasons = [...hardReasons, ...blockingUnknownReasons];
			const warnings = [
				...unknownReasons,
				...(balanceSufficient === false ? [`Insufficient available ${balanceAsset} for this estimate`] : []),
				...(params.quoteAmount !== undefined
					? ["quoteAmount is converted at the reference price and does not guarantee a fixed final spend"]
					: []),
			];
			const status =
				hardReasons.length > 0
					? "rejected"
					: blockingUnknownReasons.length > 0
						? "unknown"
						: executionCaveats.length > 0
							? "ok_with_warnings"
							: "ok";
			return jsonResult({
				status,
				phase: "preflight",
				side: params.side,
				symbol: plan.input.symbol,
				input: plan.input,
				capability: orderCapability.capability,
				resolution: {
					amount: plan.amount,
					requestedAmount: plan.amount,
					amountSemantics: plan.closePosition ? "close_entire_matching_position" : "base_currency_amount",
					amountSource: plan.closePosition
						? "matching_position_snapshot"
						: params.amount !== undefined
							? "user_amount"
							: "quote_amount_at_reference_price",
					exchangeAmount: exchangeAmount.amount ?? null,
					exchangeAmountUnit: exchangeAmount.unit,
					contractSize: exchangeAmount.contractSize ?? null,
					exchangeQuantitySemantics: closeAllTrigger
						? "close_all_trigger_may_omit_quantity"
						: "explicit_exchange_quantity",
					estimatedNotional: round(plan.notional, 2),
					referencePrice: plan.referencePrice,
					referenceSource: plan.referencePriceSource,
					referenceTime: new Date(plan.referenceTimestamp).toISOString(),
					quoteCurrency: trading.config.quoteCurrency,
				},
				executionConstraints: executionConstraints(plan),
				market: marketInfo
					? {
							symbol: marketInfo.symbol,
							marketType: marketInfo.marketType,
							active: marketInfo.active,
							pricePrecision: marketInfo.pricePrecision,
							amountPrecision: marketInfo.amountPrecision,
							amountUnit: marketInfo.amountUnit ?? (futures ? "contracts" : "base"),
							contractSize: marketInfo.contractSize ?? null,
							minAmount: marketInfo.minAmount,
							minNotional: marketInfo.minNotional,
							limits: marketInfo.limits,
							orderTypes: marketInfo.orderTypes,
						}
					: null,
				balance: {
					asset: balanceAsset,
					free: balance?.free ?? null,
					used: balance?.used ?? null,
					sufficient: balanceSufficient ?? null,
				},
				margin: futures
					? {
							asset: trading.config.quoteCurrency,
							required: round(marginRequired, 8) ?? null,
							openingRequired: round(marginEstimate?.openingMargin, 8) ?? null,
							released: round(marginEstimate?.releasedMargin, 8) ?? null,
							estimatedPnl: round(marginEstimate?.estimatedPnl, 8) ?? null,
							availableAfterClose: round(marginEstimate?.availableAfterClose, 8) ?? null,
							available: balance?.free ?? null,
							sufficient: balanceSufficient ?? null,
							leverage: effectiveLeverage,
							source: trading.mode === "paper" ? "paper-ledger-estimate" : "adapter-data-unavailable",
						}
					: null,
				fees: {
					estimated: estimatedFee ?? null,
					source: trading.mode === "paper" ? "paper.feeRate" : "exchange-dependent; not exposed by adapter",
				},
				risk: {
					allowed: riskError === null,
					reason: riskError,
					countTowardsDailyLimit: plan.countTowardsDailyLimit,
					usage,
					remainingDailyNotional: Math.max(0, usage.limit - usage.used - usage.reserved),
				},
				requiresLiveConfirmation: trading.mode === "live" && trading.config.orderApproval === "confirm",
				validation: {
					orderFilters: "deferred_to_place",
					note: "A successful preflight is not an exchange acceptance or a reservation. ok_with_warnings still requires reviewing warnings and the live confirmation step.",
				},
				blockingReasons,
				dataQuality: {
					price: Number.isFinite(plan.referenceTimestamp) && plan.referencePrice > 0,
					market: marketInfo !== undefined && marketMatches,
					balance: balances !== undefined && balance !== undefined && balanceSufficient !== undefined,
					risk: true,
				},
				unknownReasons,
				nonBlockingWarnings: executionCaveats,
				warnings,
			});
		},
	};
}
export function createBuyTool(tradingProvider: TradingProvider = getTrading): ToolDefinition<typeof orderSchema> {
	return {
		name: "buy",
		label: "buy",
		description:
			"Place a buy order (spot or Binance USDⓈ-M futures). Use quoteAmount for an estimated quote value (converted at the reference price; not a fixed final spend), or amount for " +
			"base units. Paper spot and Paper futures simulate take-profit/stop-loss (stop, stop_market, take_profit, take_profit_market with stopPrice) and trailing stops (trailing_stop_market with trailingPercent); Paper futures OCO is not supported. " +
			"Live conditional and trailing support depends on the ccxt adapter and exchange capability. Futures additionally support reduceOnly, positionSide and closePosition.",
		parameters: orderSchema,
		async execute(_id, params, signal, _onUpdate, ctx) {
			return executeOrder("buy", params, ctx, tradingProvider(), signal);
		},
	};
}

export function createSellTool(tradingProvider: TradingProvider = getTrading): ToolDefinition<typeof orderSchema> {
	return {
		name: "sell",
		label: "sell",
		description:
			"Place a sell order (spot or Binance USDⓈ-M futures). Use get_positions first to check holdings; quoteAmount is converted at a reference price and is not a fixed final value. " +
			"In Paper, protect positions with stop_market (stop-loss, triggers when price falls to stopPrice), " +
			"take_profit_market (triggers when price rises to stopPrice) or trailing_stop_market (trailingPercent pullback from the peak); futures protection must be reduceOnly, and OCO is spot-only. " +
			"Live conditional and trailing support depends on the ccxt adapter and exchange capability.",
		parameters: orderSchema,
		async execute(_id, params, signal, _onUpdate, ctx) {
			return executeOrder("sell", params, ctx, tradingProvider(), signal);
		},
	};
}

export function createCancelOrderTool(
	tradingProvider: TradingProvider = getTrading,
): ToolDefinition<typeof cancelOrderSchema> {
	return {
		name: "cancel_order",
		label: "cancel_order",
		description:
			"Cancel an open order by id. Use get_open_orders to list order ids. " +
			"Cancelling one leg of an OCO bracket cancels the whole bracket.",
		parameters: cancelOrderSchema,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const trading = tradingProvider();
			const cancelled = await confirmLiveRiskChange(ctx, trading, {
				missingUiMessage: `Cancelling live orders requires interactive confirmation but no UI is available. ${UNATTENDED_LIVE_CONFIG_HINT}`,
				title: `Confirm LIVE order cancellation on ${trading.tradingEngine.id}`,
				summary: `Cancel order ${params.id} on ${params.symbol}. This may remove a protective stop-loss or OCO leg.`,
				cancelledMessage: "Live order cancellation cancelled",
				cancelledResult: {
					status: "cancelled",
					reason: "user rejected confirmation",
					cancelled: params.id,
					symbol: params.symbol,
				},
			});
			if (cancelled) return cancelled;
			await trading.tradingEngine.cancelOrder(params.id, params.symbol, signal);
			return jsonResult({ status: "ok", cancelled: params.id, symbol: params.symbol });
		},
	};
}

export function createCancelOrderListTool(
	tradingProvider: TradingProvider = getTrading,
): ToolDefinition<typeof cancelOrderListSchema> {
	return {
		name: "cancel_order_list",
		label: "cancel_order_list",
		description: "Cancel every open leg in an OCO/order-list by orderListId.",
		parameters: cancelOrderListSchema,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const trading = tradingProvider();
			const cancelled = await confirmLiveRiskChange(ctx, trading, {
				missingUiMessage: `Cancelling live order lists requires interactive confirmation but no UI is available. ${UNATTENDED_LIVE_CONFIG_HINT}`,
				title: `Confirm LIVE order-list cancellation on ${trading.tradingEngine.id}`,
				summary: `Cancel every open order in list ${params.orderListId} on ${params.symbol}. This may remove protective OCO legs.`,
				cancelledMessage: "Live order-list cancellation cancelled",
				cancelledResult: {
					status: "cancelled",
					reason: "user rejected confirmation",
					cancelledOrderListId: params.orderListId,
					symbol: params.symbol,
				},
			});
			if (cancelled) return cancelled;
			await trading.tradingEngine.cancelOrderList(params.orderListId, params.symbol, signal);
			return jsonResult({
				status: "ok",
				error: null,
				cancelledOrderListId: params.orderListId,
				symbol: params.symbol,
			});
		},
	};
}

export function createPlaceOcoTool(tradingProvider: TradingProvider = getTrading): ToolDefinition<typeof ocoSchema> {
	return {
		name: "place_oco",
		label: "place_oco",
		description:
			"Place a spot-only one-cancels-the-other bracket: a stop-loss AND a take-profit exit for the same amount. " +
			"When one leg fills the other is cancelled automatically, so one holding is protected in both " +
			"directions without double-reserving funds. Preferred way to protect a spot position after an entry fills. " +
			"Paper spot simulates the bracket; Paper futures reject OCO. Live spot support depends on the exchange's OCO capability. Binance spot uses native OCO when available; do not place separate " +
			"conditional sell orders because each order reserves the same asset balance.",
		parameters: ocoSchema,
		async execute(_id, params, signal, _onUpdate, ctx) {
			return executeOco(params, ctx, tradingProvider, signal);
		},
	};
}
