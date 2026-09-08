import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type ContractStats, getTradingCapabilities, type MarketInfo } from "@earendil-works/ti-trading-engine";
import { getTrading } from "../context.ts";
import {
	allCapabilities,
	capabilitySchema,
	depthSchema,
	errorMessage,
	finiteOrNull,
	futuresSymbolSchema,
	getKlinesSchema,
	getPriceSchema,
	isUnavailableMetric,
	jsonResult,
	marketFamily,
	marketInfoMatchesFamily,
	marketInfoSchema,
	requireFuturesSymbol,
	round,
	type TradingProvider,
	topMarketsSchema,
	unavailableMarketCapability,
} from "./shared.ts";

const CONTRACT_STAT_METRICS = [
	["lastPrice", "last price"],
	["markPrice", "mark price"],
	["indexPrice", "index price"],
	["fundingRate", "funding rate"],
	["nextFundingTime", "next funding time"],
	["nextFundingRate", "next funding rate"],
	["estimatedSettlePrice", "estimated settle price"],
	["interestRate", "interest rate"],
	["openInterest", "open interest"],
	["openInterestValue", "open interest value"],
	["basis", "basis"],
	["basisPct", "basis percent"],
] as const satisfies ReadonlyArray<readonly [Exclude<keyof ContractStats, "symbol">, string]>;

function serializeContractStats(stats: ContractStats) {
	const fields: Record<string, number | null> = {};
	const dataQuality: Record<string, boolean> = {};
	const warnings: string[] = [];
	for (const [key, label] of CONTRACT_STAT_METRICS) {
		fields[key] = finiteOrNull(stats[key]);
		const available = !isUnavailableMetric(stats[key]);
		dataQuality[key] = available;
		if (!available) warnings.push(`${label} unavailable`);
	}
	return { symbol: stats.symbol, ...fields, dataQuality, warnings };
}

export function createGetPriceTool(
	tradingProvider: TradingProvider = getTrading,
): ToolDefinition<typeof getPriceSchema> {
	return {
		name: "get_price",
		label: "get_price",
		description: "Get the latest ticker for a market: last price, bid/ask, 24h high/low, 24h change %, 24h volume.",
		parameters: getPriceSchema,
		async execute(_id, params) {
			const trading = tradingProvider();
			const t = await trading.tradingEngine.getTicker(params.symbol);
			return jsonResult({
				symbol: t.symbol,
				last: t.last ?? null,
				bid: t.bid ?? null,
				ask: t.ask ?? null,
				dataQuality: {
					last: t.last !== undefined && Number.isFinite(t.last),
					bid: t.bid !== undefined,
					ask: t.ask !== undefined,
				},
				warnings: [
					...(t.last === undefined ? ["last price unavailable"] : []),
					...(t.bid === undefined ? ["bid unavailable"] : []),
					...(t.ask === undefined ? ["ask unavailable"] : []),
				],
				high24h: t.high24h,
				low24h: t.low24h,
				changePct24h: round(t.changePct24h, 2),
				volume24h: round(t.volume24h, 2),
				quoteVolume24h: round(t.quoteVolume24h, 0),
				time: new Date(t.timestamp).toISOString(),
			});
		},
	};
}

export function createGetOrderBookTool(
	tradingProvider: TradingProvider = getTrading,
): ToolDefinition<typeof depthSchema> {
	return {
		name: "get_order_book",
		label: "get_order_book",
		description: "Get live bids and asks, spread, and aggregate depth. Empty sides are unavailable, not zero-priced.",
		parameters: depthSchema,
		async execute(_id, params) {
			const trading = tradingProvider();
			const book = await trading.tradingEngine.getOrderBook(params.symbol, params.limit ?? 20);
			return jsonResult({
				...book,
				time: new Date(book.timestamp).toISOString(),
				dataQuality: { bids: book.bids.length > 0, asks: book.asks.length > 0 },
				warnings: [
					...(book.bids.length === 0 ? ["bid order book unavailable"] : []),
					...(book.asks.length === 0 ? ["ask order book unavailable"] : []),
				],
			});
		},
	};
}

export function createGetMarketInfoTool(
	tradingProvider: TradingProvider = getTrading,
): ToolDefinition<typeof marketInfoSchema> {
	return {
		name: "get_market_info",
		label: "get_market_info",
		description: "Get exchange market rules: spot/swap type, settlement, precision, limits, and contract metadata.",
		parameters: marketInfoSchema,
		async execute(_id, params) {
			const trading = tradingProvider();
			const info = await trading.tradingEngine.getMarketInfo(params.symbol);
			return jsonResult({
				...info,
				dataQuality: {
					marketType: true,
					contractType: info.contractType !== undefined,
					pair: info.pair !== undefined,
					marginAsset: info.marginAsset !== undefined,
					status: info.status !== undefined,
					settlement: info.settle !== undefined,
					limits: info.minAmount !== undefined || info.minNotional !== undefined,
					amountUnit: !info.contract || info.amountUnit !== undefined,
				},
				warnings: [
					...(info.contract && info.contractType === "unknown"
						? ["Contract type was not identified by the exchange adapter"]
						: []),
					...(info.contract && info.marginAsset === undefined ? ["Margin asset unavailable"] : []),
					...(info.settle === undefined ? ["settlement asset unavailable"] : []),
					...(info.minAmount === undefined && info.minNotional === undefined ? ["order limits unavailable"] : []),
				],
			});
		},
	};
}

export function createGetTradingCapabilitiesTool(
	tradingProvider: TradingProvider = getTrading,
): ToolDefinition<typeof capabilitySchema> {
	return {
		name: "get_trading_capabilities",
		label: "get_trading_capabilities",
		description:
			"Report exchange and mode-specific trading capabilities. Supported, unsupported and unknown are distinct; unknown must not be guessed.",
		parameters: capabilitySchema,
		async execute(_id, params) {
			const trading = tradingProvider();
			const family = marketFamily(trading, params.symbol);
			let marketInfo: MarketInfo | undefined;
			let marketInfoError: string | undefined;
			if (params.symbol !== undefined && family !== "invalid") {
				try {
					marketInfo = await trading.tradingEngine.getMarketInfo(params.symbol);
				} catch (error) {
					marketInfoError = errorMessage(error);
				}
			}

			const metadataValid =
				params.symbol === undefined ||
				(family !== "invalid" &&
					marketInfo !== undefined &&
					marketInfoMatchesFamily(marketInfo, params.symbol, family, trading.config.quoteCurrency));
			const unavailable = unavailableMarketCapability(family, metadataValid, marketInfo);
			const matrix = getTradingCapabilities({
				exchangeId: trading.tradingEngine.id,
				mode: trading.mode,
				marketFamily: family,
				positionMode: trading.config.positionMode,
				marketInfo,
				metadataValid,
			});

			const warnings = [
				...(params.symbol === undefined && family === "mixed"
					? ["Both mode contains spot and futures markets; pass a symbol for an actionable capability result"]
					: []),
				...(params.symbol !== undefined && family === "invalid"
					? [`Symbol ${params.symbol} is not enabled by configured market type ${trading.config.marketType}`]
					: []),
				...(marketInfoError ? [`Market metadata unavailable: ${marketInfoError}`] : []),
				...(marketInfo === undefined && params.symbol !== undefined && family !== "invalid"
					? ["Market-specific order types are unknown because metadata could not be read"]
					: []),
				...(params.symbol !== undefined && marketInfo !== undefined && !metadataValid
					? ["Returned market metadata does not match the requested symbol or configured market family"]
					: []),
				...matrix.limitations,
			];
			const capabilitySet = {
				...matrix.orderTypes,
				oco_sell: matrix.oco.sell,
				oco_buy: matrix.oco.buy,
				clientOrderIdLookup: matrix.queryOrderByClientId,
				orderListLookup: matrix.queryOrderListById,
				orderListClientIdLookup: matrix.queryOrderListByClientId,
				orderIdLookup: matrix.queryOrderById,
				cancelOrder: matrix.cancelOrder,
				cancelOrderList: matrix.cancelOrderList,
				futuresPositionControls: matrix.reduceOnly,
				fundingRates: matrix.fundingRates,
			};
			const unknownCapabilities = allCapabilities(capabilitySet).filter((item) => item.status === "unknown");
			return jsonResult({
				exchange: trading.tradingEngine.id,
				mode: trading.mode,
				configuredMarketType: trading.config.marketType,
				quoteCurrency: trading.config.quoteCurrency,
				symbol: params.symbol ?? null,
				marketFamily: family,
				positionMode: trading.config.positionMode,
				matrixProfile: matrix.profile,
				marketInfo: marketInfo
					? {
							symbol: marketInfo.symbol,
							marketType: marketInfo.marketType,
							contract: marketInfo.contract,
							amountUnit: marketInfo.amountUnit ?? (family === "futures" ? "contracts" : "base"),
							contractSize: marketInfo.contractSize ?? null,
							active: marketInfo.active,
							orderTypes: marketInfo.orderTypes,
							timeInForce: marketInfo.timeInForce,
						}
					: null,
				capabilities: {
					orderTypes: {
						market: capabilitySet.market,
						limit: capabilitySet.limit,
						stop: capabilitySet.stop,
						stop_market: capabilitySet.stop_market,
						take_profit: capabilitySet.take_profit,
						take_profit_market: capabilitySet.take_profit_market,
						trailing_stop_market: capabilitySet.trailing_stop_market,
					},
					oco: { sell: capabilitySet.oco_sell, buy: capabilitySet.oco_buy },
					clientOrderIdLookup: capabilitySet.clientOrderIdLookup,
					orderIdLookup: capabilitySet.orderIdLookup,
					orderListLookup: capabilitySet.orderListLookup,
					orderListClientIdLookup: capabilitySet.orderListClientIdLookup,
					cancelOrder: capabilitySet.cancelOrder,
					cancelOrderList: capabilitySet.cancelOrderList,
					futuresPositionControls: capabilitySet.futuresPositionControls,
					positionModes: matrix.positionModes,
					reduceOnly: matrix.reduceOnly,
					closePosition: matrix.closePosition,
					quantity: matrix.quantity,
					fundingRates: capabilitySet.fundingRates,
				},
				overallStatus:
					family === "invalid" || unavailable?.status === "unsupported"
						? "unsupported"
						: unknownCapabilities.length > 0
							? "unknown"
							: "ready",
				unknownCapabilities: unknownCapabilities.length,
				validation: {
					orderFilters: "deferred_to_place",
					note: "Precision, balance filters and exchange-specific restrictions are finally validated by place_order.",
				},
				dataQuality: {
					marketMetadata: marketInfo !== undefined || params.symbol === undefined,
					capabilityConfidence: metadataValid && unknownCapabilities.length === 0,
				},
				warnings,
			});
		},
	};
}

export function createGetContractStatsTool(
	tradingProvider: TradingProvider = getTrading,
): ToolDefinition<typeof futuresSymbolSchema> {
	return {
		name: "get_contract_stats",
		label: "get_contract_stats",
		description:
			"Get futures mark price, index price, funding, open interest, and basis. Unavailable fields stay null.",
		parameters: futuresSymbolSchema,
		async execute(_id, params) {
			const trading = tradingProvider();
			requireFuturesSymbol(trading, params.symbol, "Contract stats");
			const stats = await trading.tradingEngine.getContractStats(params.symbol);
			return jsonResult(serializeContractStats(stats));
		},
	};
}

export function createGetKlinesTool(
	tradingProvider: TradingProvider = getTrading,
): ToolDefinition<typeof getKlinesSchema> {
	return {
		name: "get_klines",
		label: "get_klines",
		description:
			"Get OHLCV candlesticks for a market, oldest first. Use for trend/momentum analysis. " +
			"Timeframes: 1m, 5m, 15m, 1h, 4h, 1d, ...",
		parameters: getKlinesSchema,
		async execute(_id, params) {
			const trading = tradingProvider();
			const limit = Math.min(Math.max(Math.floor(params.limit ?? 100), 1), 200);
			const klines = await trading.tradingEngine.getKlines(params.symbol, params.timeframe ?? "1h", limit);
			return jsonResult({
				symbol: params.symbol,
				timeframe: params.timeframe ?? "1h",
				count: klines.length,
				dataQuality: {
					count: klines.length > 0,
					oldest: klines[0]?.timestamp !== undefined,
					newest: klines.at(-1)?.timestamp !== undefined,
				},
				warnings: [
					...(klines.length === 0 ? ["No candles returned"] : []),
					...(klines.length > 0 && klines.at(-1)!.timestamp > Date.now()
						? ["Latest candle timestamp is in the future"]
						: []),
				],
				candles: klines.map((k) => ({
					time: new Date(k.timestamp).toISOString(),
					closed: k.closed ?? null,
					open: k.open,
					high: k.high,
					low: k.low,
					close: k.close,
					volume: round(k.volume, 4),
				})),
			});
		},
	};
}

export function createGetTopMarketsTool(
	tradingProvider: TradingProvider = getTrading,
): ToolDefinition<typeof topMarketsSchema> {
	return {
		name: "get_top_markets",
		label: "get_top_markets",
		description:
			"Rank a bounded set of candidate markets by 24h quote volume. This is market discovery only, not a trading signal.",
		parameters: topMarketsSchema,
		async execute(_id, params) {
			const trading = tradingProvider();
			const limit = Math.min(Math.max(Math.floor(params.limit ?? 15), 1), 50);
			const markets = await trading.tradingEngine.getTopMarkets(limit);
			const warnings = [
				...(markets.length === 0 ? ["No markets returned"] : []),
				...(markets.some((ticker) => ticker.quoteVolume24h === undefined)
					? ["Some candidates have no quote-volume value; their rank is less reliable"]
					: []),
				...(trading.config.marketType === "both"
					? [
							"The exchange adapter may return only one market family in both mode; verify each symbol before trading",
						]
					: []),
			];
			return jsonResult({
				exchange: trading.tradingEngine.id,
				mode: trading.mode,
				marketType: trading.config.marketType,
				quoteCurrency: trading.config.quoteCurrency,
				limit,
				count: markets.length,
				markets: markets.map((ticker, index) => ({
					rank: index + 1,
					symbol: ticker.symbol,
					last: ticker.last,
					bid: ticker.bid,
					ask: ticker.ask,
					changePct24h: round(ticker.changePct24h, 2),
					quoteVolume24h: round(ticker.quoteVolume24h, 2),
					volume24h: round(ticker.volume24h, 4),
					time: new Date(ticker.timestamp).toISOString(),
				})),
				dataQuality: {
					ranking: markets.length > 0 && markets.every((ticker) => ticker.quoteVolume24h !== undefined),
					prices: markets.every((ticker) => ticker.last !== undefined && Number.isFinite(ticker.last)),
					timestamps: markets.every((ticker) => Number.isFinite(ticker.timestamp)),
				},
				warnings,
			});
		},
	};
}
