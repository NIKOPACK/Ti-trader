import { isFuturesSymbol } from "@nikopack/ti-trading-engine";
import { getTrading } from "./context.ts";

/** Must match `MARKET_LAB_CANDLE_PROVIDER_KEY` in extensions/market-lab/index.ts. */
const MARKET_LAB_CANDLE_PROVIDER_KEY = Symbol.for("ti.marketLab.candleProvider");

type SessionCandle = {
	timestamp: number;
	open: number;
	high: number;
	low: number;
	close: number;
	volume: number;
};

/**
 * Point market-lab at this session's read-only klines so indicators match get_klines.
 * Does not expose order or account methods.
 */
export function installMarketLabSessionBridge(): void {
	const holders = globalThis as Record<PropertyKey, unknown>;
	holders[MARKET_LAB_CANDLE_PROVIDER_KEY] = fetchSessionCandles;
}

export function uninstallMarketLabSessionBridge(): void {
	const holders = globalThis as Record<PropertyKey, unknown>;
	delete holders[MARKET_LAB_CANDLE_PROVIDER_KEY];
}

async function fetchSessionCandles(params: { symbol: string; timeframe: string; limit: number }): Promise<{
	candles: SessionCandle[];
	source: { venue: string; market: "spot" | "swap"; kind: "session-klines"; mode: "paper" | "live" };
}> {
	const trading = getTrading();
	const klines = await trading.marketData.getKlines(params.symbol, params.timeframe, params.limit + 1);
	const selected = klines.some((kline) => kline.closed === true)
		? klines.filter((kline) => kline.closed === true)
		: klines.slice(0, -1);
	return {
		candles: selected.map((kline) => ({
			timestamp: kline.timestamp,
			open: kline.open,
			high: kline.high,
			low: kline.low,
			close: kline.close,
			volume: kline.volume,
		})),
		source: {
			venue: trading.tradingEngine.id,
			market: isFuturesSymbol(params.symbol, trading.config.quoteCurrency) ? "swap" : "spot",
			kind: "session-klines",
			mode: trading.mode,
		},
	};
}
