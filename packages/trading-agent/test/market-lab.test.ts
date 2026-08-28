import { describe, expect, it } from "vitest";
import { binanceSymbol } from "../../../extensions/market-lab/index.ts";
import { type Candle, calculateIndicators } from "../../../extensions/market-lab/indicators.ts";

function candles(count: number): Candle[] {
	return Array.from({ length: count }, (_, index) => {
		const close = 100 + index;
		return { timestamp: index * 3_600_000, open: close - 1, high: close + 2, low: close - 2, close, volume: 10 };
	});
}

describe("market-lab", () => {
	it("normalizes only supported spot symbols", () => {
		expect(binanceSymbol("btc/usdt")).toBe("BTCUSDT");
		expect(() => binanceSymbol("BTC/USDT:USDT")).toThrow();
		expect(() => binanceSymbol("BTC/JPY")).toThrow();
	});

	it("calculates stable indicators after enough candles", () => {
		const result = calculateIndicators(candles(60));
		const latest = result.at(-1);
		expect(latest?.ema20).toBeDefined();
		expect(latest?.ema50).toBeDefined();
		expect(latest?.rsi14).toBe(100);
		expect(latest?.atr14).toBeDefined();
		expect(latest?.volumeRatio).toBeDefined();
		expect(latest?.bbUpper).toBeGreaterThan(latest?.bbMiddle ?? Infinity);
	});

	it("does not fabricate long-period indicators", () => {
		const latest = calculateIndicators(candles(20)).at(-1);
		expect(latest?.ema50).toBeUndefined();
		expect(latest?.rsi14).toBeDefined();
	});
});
