import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Order } from "@nikopack/ti-trading-engine";
import { isFuturesSymbol } from "@nikopack/ti-trading-engine";
import { getTrading } from "../context.ts";
import {
	confirmLiveRiskChange,
	distinctOrderNotionals,
	emptySchema,
	errorMessage,
	finiteOrNull,
	fundingHistorySchema,
	futuresSymbolSchema,
	hasFiniteQuoteValue,
	isProtectiveOrder,
	jsonResult,
	leverageSchema,
	marginSchema,
	multiAssetsModeSchema,
	requireFuturesSymbol,
	type TradingProvider,
	venueFields,
} from "./shared.ts";

export function createGetFundingRateHistoryTool(
	tradingProvider: TradingProvider = getTrading,
): ToolDefinition<typeof fundingHistorySchema> {
	return {
		name: "get_funding_rate_history",
		label: "get_funding_rate_history",
		description: "Get historical USDⓈ-M futures funding rates. Read-only; unavailable in spot mode.",
		parameters: fundingHistorySchema,
		async execute(_id, params) {
			const trading = tradingProvider();
			requireFuturesSymbol(trading, params.symbol, "Funding rate history");
			const records = await trading.tradingEngine.getFundingRateHistory(params.symbol, params.limit ?? 20);
			const unavailableRates = records.filter(
				(record) => record.rate === undefined || !Number.isFinite(record.rate),
			);
			return jsonResult({
				...venueFields(trading),
				symbol: params.symbol,
				count: records.length,
				records: records.map((record) => ({
					...record,
					rate: finiteOrNull(record.rate),
				})),
				dataQuality: { available: records.length > 0 && unavailableRates.length === 0 },
				warnings:
					records.length === 0
						? [
								trading.mode === "paper"
									? "No funding history returned; paper mode does not simulate funding history."
									: "No funding history returned by the exchange.",
							]
						: unavailableRates.length > 0
							? [`${unavailableRates.length} funding rate record(s) unavailable`]
							: [],
			});
		},
	};
}

export function createGetFundingRateTool(
	tradingProvider: TradingProvider = getTrading,
): ToolDefinition<typeof futuresSymbolSchema> {
	return {
		name: "get_funding_rate",
		label: "get_funding_rate",
		description: "Get current futures funding rate.",
		parameters: futuresSymbolSchema,
		async execute(_id, params) {
			const trading = tradingProvider();
			requireFuturesSymbol(trading, params.symbol, "Funding rate");
			const funding = await trading.tradingEngine.getFundingRate(params.symbol);
			const hasRate = funding.rate !== undefined && Number.isFinite(funding.rate);
			const available = trading.mode === "live" ? hasRate : hasRate && funding.rate !== 0;
			return jsonResult({
				...venueFields(trading),
				...funding,
				rate: finiteOrNull(funding.rate),
				dataQuality: {
					available,
					observed: trading.mode === "live" && hasRate,
				},
				warnings:
					trading.mode === "paper"
						? ["Paper futures do not simulate funding; rate 0 is a placeholder, not an observed market rate"]
						: hasRate
							? []
							: ["Funding rate unavailable"],
			});
		},
	};
}
export function createSetLeverageTool(
	tradingProvider: TradingProvider = getTrading,
): ToolDefinition<typeof leverageSchema> {
	return {
		name: "set_leverage",
		label: "set_leverage",
		description:
			"Set futures leverage. This changes account/order risk; live mode requires the same explicit UI confirmation as a live order when confirmLiveOrders is enabled.",
		parameters: leverageSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const trading = tradingProvider();
			requireFuturesSymbol(trading, params.symbol, "Leverage");
			const cancelled = await confirmLiveRiskChange(ctx, trading, {
				missingUiMessage:
					"Changing live leverage requires interactive confirmation but no UI is available. Set confirmLiveOrders=false only for an explicitly headless workflow.",
				title: `Confirm LIVE leverage change on ${trading.tradingEngine.id}`,
				summary: `${params.symbol}: set leverage to ${params.leverage}x. This changes margin and liquidation risk for future orders.`,
				cancelledMessage: "Leverage change cancelled",
				cancelledResult: { status: "cancelled", symbol: params.symbol, leverage: params.leverage },
			});
			if (cancelled) return cancelled;
			await trading.tradingEngine.setLeverage(params.symbol, params.leverage);
			return jsonResult({ status: "ok", symbol: params.symbol, leverage: params.leverage });
		},
	};
}
export function createSetMarginModeTool(
	tradingProvider: TradingProvider = getTrading,
): ToolDefinition<typeof marginSchema> {
	return {
		name: "set_margin_mode",
		label: "set_margin_mode",
		description:
			"Set futures margin mode. This changes account/order risk; live mode requires the same explicit UI confirmation as a live order when confirmLiveOrders is enabled.",
		parameters: marginSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const trading = tradingProvider();
			requireFuturesSymbol(trading, params.symbol, "Margin mode");
			const cancelled = await confirmLiveRiskChange(ctx, trading, {
				missingUiMessage:
					"Changing live margin mode requires interactive confirmation but no UI is available. Set confirmLiveOrders=false only for an explicitly headless workflow.",
				title: `Confirm LIVE margin-mode change on ${trading.tradingEngine.id}`,
				summary: `${params.symbol}: switch to ${params.marginType} margin. Review liquidation and cross-account exposure before continuing.`,
				cancelledMessage: "Margin-mode change cancelled",
				cancelledResult: { status: "cancelled", symbol: params.symbol, marginType: params.marginType },
			});
			if (cancelled) return cancelled;
			await trading.tradingEngine.setMarginMode(params.symbol, params.marginType);
			return jsonResult({ status: "ok", symbol: params.symbol, marginType: params.marginType });
		},
	};
}
export function createSetMultiAssetsModeTool(
	tradingProvider: TradingProvider = getTrading,
): ToolDefinition<typeof multiAssetsModeSchema> {
	return {
		name: "set_multi_assets_mode",
		label: "set_multi_assets_mode",
		description:
			"Set Binance USDⓈ-M account Multi-Assets mode. Set enabled=false before using isolated margin. Account-level setting; requires no symbol.",
		parameters: multiAssetsModeSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const trading = tradingProvider();
			if (
				trading.mode !== "live" ||
				trading.config.exchange !== "binance" ||
				trading.config.marketType !== "usdm-futures"
			)
				throw new Error("Multi-Assets mode is available only for live Binance USDⓈ-M futures");
			const cancelled = await confirmLiveRiskChange(ctx, trading, {
				missingUiMessage:
					"Changing live Multi-Assets mode requires interactive confirmation but no UI is available",
				title: "Confirm LIVE Binance Multi-Assets mode change",
				summary: `Switch account Multi-Assets mode ${params.enabled ? "ON" : "OFF (required for isolated margin)"}. Existing positions/orders may prevent this change; review account-wide margin risk first.`,
				cancelledMessage: "Multi-Assets mode change cancelled",
				cancelledResult: { status: "cancelled", enabled: params.enabled },
			});
			if (cancelled) return cancelled;
			try {
				await trading.tradingEngine.setMultiAssetsMode(params.enabled);
			} catch (error) {
				throw new Error(
					`${errorMessage(error)}. ` +
						"If Binance reports open positions or orders, close/cancel them and retry; mode changes are account-level.",
				);
			}
			return jsonResult({
				status: "ok",
				enabled: params.enabled,
				marginType: params.enabled ? "cross-only" : "isolated-compatible",
			});
		},
	};
}
export function createGetFuturesPositionsTool(
	tradingProvider: TradingProvider = getTrading,
): ToolDefinition<typeof emptySchema> {
	return {
		name: "get_futures_positions",
		label: "get_futures_positions",
		description: "Get futures positions.",
		parameters: emptySchema,
		async execute() {
			const trading = tradingProvider();
			if (trading.config.marketType === "spot") {
				throw new Error("Futures positions are unavailable in spot mode; use get_positions for spot holdings");
			}
			const positions = (await trading.tradingEngine.getPositions()).filter((position) =>
				isFuturesSymbol(position.symbol, trading.config.quoteCurrency),
			);
			return jsonResult({ positions, marketType: trading.config.marketType });
		},
	};
}

export function createGetRiskStatusTool(
	tradingProvider: TradingProvider = getTrading,
): ToolDefinition<typeof emptySchema> {
	return {
		name: "get_risk_status",
		label: "get_risk_status",
		description:
			"Get current risk limits, entry pause, used notional quota, and unsettled reservations. New exposure pauses persist until the user confirms /risk resume; never switch modes or accounts to bypass a pause. In paper mode the quota is cumulative and only the user can reset it (/risk reset); in live mode it resets daily. Unsettled reservations must be reconciled after verifying the exchange order; do not retry the submission.",
		parameters: emptySchema,
		async execute() {
			const trading = tradingProvider();
			const usage = trading.tradingEngine.risk.usage();
			const pendingReservations = trading.tradingEngine.risk.listPendingReservations();
			const [openOrders, positions] = await Promise.all([
				trading.tradingEngine.getOpenOrders(),
				trading.tradingEngine.getPositions(),
			]);
			const history = new Map<string, Order>();
			const historyErrors: string[] = [];
			const historySymbols = [
				...new Set([
					...openOrders.map((order) => order.symbol),
					...positions.map((position) => position.symbol),
					...trading.config.risk.allowedSymbols,
				]),
			];
			// Paper mode reads the local account history across all symbols in one
			// query; only live Binance requires per-symbol closed-order history
			// queries because its adapter cannot enumerate all symbols.
			const binanceSymbolHistory = trading.mode === "live" && trading.tradingEngine.id === "binance";
			const queries = binanceSymbolHistory ? historySymbols : [undefined];
			if (binanceSymbolHistory && queries.length === 0) {
				historyErrors.push("Binance requires a symbol for closed-order history and no account symbol is known yet");
			}
			for (const symbol of queries) {
				try {
					for (const order of await trading.tradingEngine.getOrderHistory(symbol, 100)) {
						history.set(`${order.symbol}:${order.id}`, order);
					}
				} catch (error) {
					historyErrors.push(`${symbol ?? "all symbols"}: ${errorMessage(error)}`);
				}
			}
			const historicalOrders = [...history.values()];
			const openProtective = openOrders.filter(isProtectiveOrder);
			const openEntries = openOrders.filter((order) => !isProtectiveOrder(order));
			const protectiveNotionals = distinctOrderNotionals(openProtective);
			const entryNotionals = distinctOrderNotionals(openEntries);
			const sumNotional = (notionals: { values: number[] }): number =>
				notionals.values.reduce((sum, value) => sum + value, 0);
			const openOrderUnknownGroups = protectiveNotionals.unknownGroups + entryNotionals.unknownGroups;
			const valuedPositions = positions.filter(hasFiniteQuoteValue);
			const positionNotional = valuedPositions.reduce((sum, position) => sum + Math.abs(position.quoteValue), 0);
			const unknownPositionCount = positions.length - valuedPositions.length;
			return jsonResult({
				mode: trading.mode,
				limits: {
					maxOrderNotional: trading.config.risk.maxOrderNotional,
					maxDailyNotional: trading.config.risk.maxDailyNotional,
					allowedSymbols: trading.config.risk.allowedSymbols,
				},
				quoteCurrency: trading.config.quoteCurrency,
				usage,
				newExposurePaused: usage.newExposurePause !== undefined,
				pendingReservations,
				breakdown: {
					// `usage.used` is the authoritative persisted quota. The other
					// fields are current-account observations and are not added to it.
					entries: usage.used,
					protectiveOpenOrders: protectiveNotionals.unknownGroups === 0 ? sumNotional(protectiveNotionals) : null,
					entryOpenOrders: entryNotionals.unknownGroups === 0 ? sumNotional(entryNotionals) : null,
					positions: unknownPositionCount === 0 ? positionNotional : null,
					closedHistory: historicalOrders.reduce((sum, order) => sum + order.cost, 0),
					closedHistoryAvailable: historyErrors.length === 0,
				},
				warnings: [
					...(usage.newExposurePause
						? [
								`New exposure is paused: ${usage.newExposurePause.reason}. Only the user can confirm /risk resume.`,
							]
						: []),
					...historyErrors.map((error) => `Closed-order history unavailable: ${error}`),
					...(openOrderUnknownGroups === 0
						? []
						: ["One or more open-order notionals are unavailable and excluded from the breakdown"]),
					...(unknownPositionCount === 0
						? []
						: [`${unknownPositionCount} position valuation(s) unavailable; positions breakdown is unknown`]),
					...(pendingReservations.length === 0
						? []
						: [
								`${pendingReservations.length} unsettled reservation(s); verify the exchange order then /risk reconcile <id> commit|release. Do not retry the submission.`,
							]),
				],
				breakdownSemantics:
					"entries is the persisted quota used (paper cumulative, live daily); protectiveOpenOrders, entryOpenOrders, positions, and closedHistory are current observations and are not interchangeable with entries or added to usage.used.",
			});
		},
	};
}
