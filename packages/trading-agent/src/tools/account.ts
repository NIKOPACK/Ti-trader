import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Balance, Order, Position } from "@nikopack/ti-trading-engine";
import { getTrading } from "../context.ts";
import {
	distinctOrderNotionals,
	emptySchema,
	formatBalance,
	formatOrder,
	formatPosition,
	hasFiniteQuoteValue,
	isProtectiveOrder,
	jsonResult,
	round,
	type TradingProvider,
} from "./shared.ts";

export function createGetBalanceTool(
	tradingProvider: TradingProvider = getTrading,
): ToolDefinition<typeof emptySchema> {
	return {
		name: "get_balance",
		label: "get_balance",
		description:
			"Get account balances (non-zero assets) with estimated value in quote currency. " +
			"In paper mode this is the simulated account.",
		parameters: emptySchema,
		async execute() {
			const trading = tradingProvider();
			const balances = await trading.tradingEngine.getBalances();
			const valued = balances.filter(hasFiniteQuoteValue);
			const totalQuote = valued.reduce((sum, balance) => sum + balance.quoteValue, 0);
			return jsonResult({
				mode: trading.mode,
				exchange: trading.tradingEngine.id,
				quoteCurrency: trading.tradingEngine.quoteCurrency,
				totalQuoteValue: valued.length === balances.length ? round(totalQuote, 2) : null,
				knownValuedQuote: round(totalQuote, 2),
				balances: balances.map(formatBalance),
				dataQuality: {
					valuations: valued.length === balances.length ? "complete" : "partial",
				},
				warnings:
					valued.length === balances.length
						? []
						: [`${balances.length - valued.length} balance valuation(s) unavailable; totalQuoteValue is unknown`],
			});
		},
	};
}

export function createGetPositionsTool(
	tradingProvider: TradingProvider = getTrading,
): ToolDefinition<typeof emptySchema> {
	return {
		name: "get_positions",
		label: "get_positions",
		description:
			"Get current spot holdings or futures positions valued in quote currency, including side, leverage, " +
			"margin mode, average entry price and unrealized PnL when available.",
		parameters: emptySchema,
		async execute() {
			const trading = tradingProvider();
			const positions = await trading.tradingEngine.getPositions();
			const unavailable = positions.filter((position) => !hasFiniteQuoteValue(position));
			return jsonResult({
				mode: trading.mode,
				count: positions.length,
				positions: positions.map(formatPosition),
				dataQuality: {
					valuations: unavailable.length === 0 ? "complete" : "partial",
				},
				warnings: unavailable.map(
					(position) =>
						`${position.symbol} valuation unavailable: ${position.valuationReason ?? "mark price is unavailable"}`,
				),
			});
		},
	};
}
export function createGetPortfolioSnapshotTool(
	tradingProvider: TradingProvider = getTrading,
): ToolDefinition<typeof emptySchema> {
	return {
		name: "get_portfolio_snapshot",
		label: "get_portfolio_snapshot",
		description:
			"Aggregate balances, positions, open orders and risk usage into one point-in-time account snapshot. Missing valuations are reported as unknown.",
		parameters: emptySchema,
		async execute() {
			const trading = tradingProvider();
			let balances: Balance[];
			let positions: Position[];
			let openOrders: Order[];
			if (trading.mode === "paper") {
				// Paper account reads lazily settle resting orders and mutate local
				// state. Serialize them so two reads cannot fill the same order.
				balances = await trading.tradingEngine.getBalances();
				positions = await trading.tradingEngine.getPositions();
				openOrders = await trading.tradingEngine.getOpenOrders();
			} else {
				[balances, positions, openOrders] = await Promise.all([
					trading.tradingEngine.getBalances(),
					trading.tradingEngine.getPositions(),
					trading.tradingEngine.getOpenOrders(),
				]);
			}
			const usage = trading.tradingEngine.risk.usage();
			const valuedBalances = balances.filter(hasFiniteQuoteValue);
			const balanceValue = valuedBalances.reduce((sum, balance) => sum + balance.quoteValue, 0);
			const valuedPositions = positions.filter(hasFiniteQuoteValue).filter((position) => position.quoteValue >= 0);
			const grossExposure = valuedPositions.reduce((sum, position) => sum + Math.abs(position.quoteValue), 0);
			const pnlValues = positions
				.map((position) => position.unrealizedPnl)
				.filter((value): value is number => value !== undefined && Number.isFinite(value));
			const openOrderNotionals = distinctOrderNotionals(openOrders);
			const protectiveOrderNotionals = distinctOrderNotionals(openOrders.filter(isProtectiveOrder));
			const knownOpenOrderValues = openOrderNotionals.values;
			const warnings = [
				...(valuedBalances.length !== balances.length
					? [`${balances.length - valuedBalances.length} balance valuation(s) unavailable; equity is partial`]
					: []),
				...(valuedPositions.length !== positions.length
					? [`${positions.length - valuedPositions.length} position valuation(s) unavailable; exposure is partial`]
					: []),
				...positions
					.filter((position) => !hasFiniteQuoteValue(position))
					.map(
						(position) =>
							`${position.symbol} valuation unavailable: ${position.valuationReason ?? "mark price is unavailable"}`,
					),
				...(openOrderNotionals.unknownGroups > 0
					? [`${openOrderNotionals.unknownGroups} open-order notional group(s) unavailable`]
					: []),
				...(pnlValues.length !== positions.length
					? ["Unrealized PnL is partial because one or more positions do not expose PnL"]
					: []),
			];
			return jsonResult({
				asOf: new Date().toISOString(),
				exchange: trading.tradingEngine.id,
				mode: trading.mode,
				marketType: trading.config.marketType,
				quoteCurrency: trading.config.quoteCurrency,
				risk: {
					limits: {
						maxOrderNotional: trading.config.risk.maxOrderNotional,
						maxDailyNotional: trading.config.risk.maxDailyNotional,
						allowedSymbols: trading.config.risk.allowedSymbols,
					},
					usage,
					remainingDailyNotional: Math.max(0, usage.limit - usage.used - usage.reserved),
				},
				account: {
					estimatedEquity: valuedBalances.length === balances.length ? round(balanceValue, 2) : null,
					knownValuedBalance: round(balanceValue, 2),
					grossExposure: valuedPositions.length === positions.length ? round(grossExposure, 2) : null,
					knownValuedExposure: round(grossExposure, 2),
					unrealizedPnl:
						pnlValues.length === positions.length
							? round(
									pnlValues.reduce((a, b) => a + b, 0),
									2,
								)
							: null,
					openOrderNotional:
						openOrderNotionals.unknownGroups === 0
							? round(
									knownOpenOrderValues.reduce((a, b) => a + b, 0),
									2,
								)
							: null,
					protectiveOpenOrderNotional:
						protectiveOrderNotionals.unknownGroups === 0
							? round(
									protectiveOrderNotionals.values.reduce((a, b) => a + b, 0),
									2,
								)
							: null,
				},
				balances: balances.map(formatBalance),
				positions: positions.map(formatPosition),
				openOrders: openOrders.map((order) => formatOrder(order)),
				dataQuality: {
					balances: valuedBalances.length === balances.length ? "complete" : "partial",
					positions: valuedPositions.length === positions.length ? "complete" : "partial",
					openOrders: openOrderNotionals.unknownGroups === 0 ? "complete" : "partial",
					pnl: pnlValues.length === positions.length ? "complete" : "partial",
				},
				warnings,
			});
		},
	};
}
