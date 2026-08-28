import { afterEach, describe, expect, it, vi } from "vitest";
import { analyze, binanceSymbol, fetchCandles } from "../../../extensions/market-lab/index.ts";
import { type Candle, calculateIndicators } from "../../../extensions/market-lab/indicators.ts";

function candles(count: number): Candle[] {
	return Array.from({ length: count }, (_, index) => {
		const close = 100 + index;
		return { timestamp: index * 3_600_000, open: close - 1, high: close + 2, low: close - 2, close, volume: 10 };
	});
}

function flatCandles(count: number, volume = 10): Candle[] {
	return Array.from({ length: count }, (_, index) => ({
		timestamp: (index + 1) * 3_600_000,
		open: 100,
		high: 101,
		low: 99,
		close: 100,
		volume,
	}));
}

afterEach(() => vi.restoreAllMocks());

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

	it("classifies a flat market as neutral", async () => {
		const rows = flatCandles(61).map((candle) => [
			candle.timestamp,
			candle.open,
			candle.high,
			candle.low,
			candle.close,
			candle.volume,
		]);
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify(rows), { status: 200, headers: { "content-type": "application/json" } }),
		);
		const result = await analyze({ symbol: "BTC/USDT", timeframe: "1h", limit: 60 });
		expect(result.bias).toBe("neutral");
		expect(result.reasons).toContain("EMA20 equals EMA50");
	});

	it("keeps every calculated number finite when all volumes are zero", () => {
		const result = calculateIndicators(flatCandles(60, 0));
		for (const point of result) {
			const numbers = Object.values(point).filter((value): value is number => typeof value === "number");
			expect(numbers.every(Number.isFinite)).toBe(true);
		}
		expect(result.at(-1)?.volumeSma20).toBe(0);
		expect(result.at(-1)?.volumeRatio).toBeUndefined();
	});

	it.each([
		["below low", 97],
		["above high", 103],
	])("rejects a candle whose close is %s", async (_case, invalidClose) => {
		const rows = Array.from({ length: 21 }, (_, index) => [
			(index + 1) * 3_600_000,
			100,
			102,
			98,
			index === 10 ? invalidClose : 100,
			10,
		]);
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify(rows), { status: 200, headers: { "content-type": "application/json" } }),
		);
		await expect(fetchCandles({ symbol: "BTC/USDT", timeframe: "1h", limit: 20 })).rejects.toThrow(
			"Market data candle had invalid OHLCV values",
		);
	});
});
