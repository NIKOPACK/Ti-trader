import { afterEach, describe, expect, it, vi } from "vitest";
import {
	analyze,
	binanceSymbol,
	fetchCandles,
	parseLabArgs,
	parseScreenArgs,
	screenMarkets,
} from "../../../extensions/market-lab/index.ts";
import {
	type Candle,
	calculateIndicators,
	type IndicatorPoint,
	resolveIndicatorPeriods,
} from "../../../extensions/market-lab/indicators.ts";
import { evaluateStrategy, simulateRule } from "../../../extensions/market-lab/strategies.ts";

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

function fallingCandles(count: number): Candle[] {
	return Array.from({ length: count }, (_, index) => {
		const close = 200 - index;
		return {
			timestamp: (index + 1) * 3_600_000,
			open: close + 1,
			high: close + 2,
			low: close - 2,
			close,
			volume: 10,
		};
	});
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

	it("parameterizes EMA periods and does not alias mismatched names", () => {
		const latest = calculateIndicators(candles(30), { emaFast: 10, emaSlow: 50 }).at(-1);
		expect(latest?.emaFast).toBeDefined();
		expect(latest?.emaSlow).toBeUndefined();
		expect(latest?.ema20).toBeUndefined();
		expect(latest?.ema50).toBeUndefined();
	});

	it("rejects a non-integer indicator period", () => {
		expect(() => resolveIndicatorPeriods({ rsi: 14.5 })).toThrow("Invalid rsi period");
	});

	it("scores an uptrend as ema-cross bullish without placing an order", () => {
		const series = candles(60);
		const evaluation = evaluateStrategy(calculateIndicators(series), series, "ema-cross");
		expect(evaluation.bias).toBe("bullish");
		expect(evaluation.event).toBe("above");
		expect(evaluation.reasons.some((reason) => reason.includes("EMA20"))).toBe(true);
		expect(evaluation).not.toHaveProperty("order");
		expect(evaluation.warnings).toContain("This is analysis only; no order was created.");
	});

	it("scores a falling market as rsi-revert oversold", () => {
		const series = fallingCandles(40);
		const evaluation = evaluateStrategy(calculateIndicators(series), series, "rsi-revert");
		expect(evaluation.bias).toBe("bullish");
		expect(evaluation.event).toBe("oversold");
	});

	it("maps MACD histogram sign and zero-line crosses", () => {
		const series = candles(40);
		const points = calculateIndicators(series);
		const latest = points.at(-1);
		const previous = points.at(-2);
		expect(latest).toBeDefined();
		expect(previous).toBeDefined();
		if (!latest || !previous) throw new Error("expected indicator points");
		const bullish = evaluateStrategy(
			[...points.slice(0, -2), { ...previous, macdHistogram: 1.0 }, { ...latest, macdHistogram: 1.5 }],
			series,
			"macd-hist",
		);
		expect(bullish.bias).toBe("bullish");
		expect(bullish.event).toBe("above");
		const cross = evaluateStrategy(
			[...points.slice(0, -2), { ...previous, macdHistogram: -0.2 }, { ...latest, macdHistogram: 0.3 }],
			series,
			"macd-hist",
		);
		expect(cross.bias).toBe("bullish");
		expect(cross.event).toBe("cross-up");
	});

	it("keeps rsi-revert at insufficient-data when RSI cannot be formed", () => {
		const series = candles(10);
		const evaluation = evaluateStrategy(calculateIndicators(series), series, "rsi-revert");
		expect(evaluation.bias).toBe("insufficient-data");
		expect(evaluation.event).toBe("insufficient-data");
	});

	it("parses /signal arguments as timeframe or preset", () => {
		expect(parseLabArgs("BTC/USDT 1h rsi-revert")).toEqual({
			symbol: "BTC/USDT",
			timeframe: "1h",
			preset: "rsi-revert",
		});
		expect(parseLabArgs("BTC/USDT macd-hist")).toEqual({
			symbol: "BTC/USDT",
			timeframe: undefined,
			preset: "macd-hist",
		});
		expect(parseLabArgs("BTC/USDT 2h bogus").error).toMatch(/Unknown argument/);
	});

	it("passes the selected preset through analyze", async () => {
		const rows = fallingCandles(41).map((candle) => [
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
		const result = await analyze({ symbol: "BTC/USDT", timeframe: "1h", limit: 40, preset: "rsi-revert" });
		expect(result.preset).toBe("rsi-revert");
		expect(result.bias).toBe("bullish");
		expect(result.event).toBe("oversold");
	});

	it("parses /screen symbols, timeframe, and preset", () => {
		expect(parseScreenArgs("BTC/USDT ETH/USDT 1h rsi-revert")).toEqual({
			symbols: ["BTC/USDT", "ETH/USDT"],
			timeframe: "1h",
			preset: "rsi-revert",
		});
		expect(parseScreenArgs("1h").error).toMatch(/Usage: \/screen/);
	});

	it("screens multiple symbols and keeps per-symbol failures", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = String(input);
			if (url.includes("symbol=BADUSDT")) {
				return new Response("nope", { status: 400, headers: { "content-type": "application/json" } });
			}
			const series = url.includes("symbol=ETHUSDT") ? fallingCandles(41) : flatCandles(61);
			const rows = series.map((candle) => [
				candle.timestamp,
				candle.open,
				candle.high,
				candle.low,
				candle.close,
				candle.volume,
			]);
			return new Response(JSON.stringify(rows), { status: 200, headers: { "content-type": "application/json" } });
		});
		const result = await screenMarkets({
			symbols: ["eth/usdt", "BTC/USDT", "ETH/USDT", "BAD/USDT"],
			timeframe: "1h",
			limit: 40,
			preset: "rsi-revert",
		});
		expect(result.scanned).toBe(3);
		expect(result.failed).toBe(1);
		expect(result.rows.find((row) => row.symbol === "ETH/USDT")).toMatchObject({
			event: "oversold",
			bias: "bullish",
		});
		expect(result.rows.find((row) => row.symbol === "BTC/USDT")).toMatchObject({
			event: "mid-range",
			bias: "neutral",
		});
		expect(result.rows.at(-1)).toMatchObject({ symbol: "BAD/USDT" });
		expect(typeof result.rows.at(-1)?.error).toBe("string");
		expect(result.warnings).toContain("This is a read-only scan; no order was created.");
	});

	it("replays only discrete events and ignores persistent above/below states", () => {
		const series: Candle[] = Array.from({ length: 8 }, (_, index) => ({
			timestamp: (index + 1) * 3_600_000,
			open: 100,
			high: 101,
			low: 99,
			close: index === 4 ? 110 : 100,
			volume: 10,
		}));
		const points: IndicatorPoint[] = series.map((candle, index) => ({
			timestamp: candle.timestamp,
			close: candle.close,
			emaFast: index === 2 ? 3 : 1,
			emaSlow: 2,
		}));
		const replay = simulateRule(points, series, "ema-cross", undefined, 2);
		expect(replay.tradeCount).toBe(1);
		expect(replay.longs).toBe(1);
		expect(replay.trades[0]?.event).toBe("cross-up");
		expect(replay.trades[0]?.returnPct).toBe(0.1);
		expect(replay.winRate).toBe(1);
		expect(replay.warnings).toContain("Closed-candle rule replay only; not a backtest.");
		expect(replay).not.toHaveProperty("order");
	});

	it("takes a non-overlapping rsi-revert replay on a falling series", () => {
		const series = fallingCandles(40);
		const replay = simulateRule(calculateIndicators(series), series, "rsi-revert", undefined, 5);
		expect(replay.tradeCount).toBeGreaterThan(0);
		expect(replay.longs).toBe(replay.tradeCount);
		expect(replay.trades.every((trade) => trade.event === "oversold")).toBe(true);
		const opens = replay.trades.map((trade) => trade.index);
		for (let index = 1; index < opens.length; index++) {
			expect(opens[index] - opens[index - 1]).toBeGreaterThanOrEqual(5);
		}
	});
});
