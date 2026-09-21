import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import marketLabExtension, {
	analyze,
	binanceSymbol,
	fetchCandles,
	type MarketLabCandleProvider,
	parseLabArgs,
	parseReplayArgs,
	parseScreenArgs,
	screenMarkets,
	sessionSymbol,
	setMarketLabCandleProvider,
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

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	setMarketLabCandleProvider(undefined);
});

describe("market-lab", () => {
	it("registers remaining lab tools and not the removed duplicates", () => {
		const tools: string[] = [];
		const commands: string[] = [];
		marketLabExtension({
			registerTool: (tool: { name: string }) => {
				tools.push(tool.name);
			},
			registerCommand: (name: string) => {
				commands.push(name);
			},
			registerEntryRenderer: () => {},
			appendEntry: () => {},
		} as unknown as ExtensionAPI);
		expect(tools).toEqual([
			"calculate_indicators",
			"evaluate_strategy",
			"screen_markets",
			"simulate_rule",
			"show_market_view",
		]);
		expect(commands).toEqual(["lab"]);
		expect(tools).not.toContain("analyze_market_structure");
		expect(tools).not.toContain("generate_trade_signal");
	});

	it("normalizes only supported spot symbols", () => {
		expect(binanceSymbol("btc/usdt")).toBe("BTCUSDT");
		expect(() => binanceSymbol("BTC/USDT:USDT")).toThrow();
		expect(() => binanceSymbol("BTC/JPY")).toThrow();
	});

	it("accepts session futures symbols only through the session path", () => {
		expect(sessionSymbol("btc/usdt:usdt")).toBe("BTC/USDT:USDT");
		expect(() => sessionSymbol("BTC/JPY")).not.toThrow();
		expect(() => sessionSymbol("BTCUSDT")).toThrow(/session market symbol/);
	});

	it("uses a session candle provider instead of Binance public klines", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		setMarketLabCandleProvider(async () => ({
			candles: Array.from({ length: 20 }, (_, index) => ({
				timestamp: (index + 1) * 3_600_000,
				open: 100,
				high: 101,
				low: 99,
				close: 100,
				volume: 10,
			})),
			source: { venue: "okx", market: "spot", kind: "session-klines", mode: "paper" },
		}));
		const result = await analyze({ symbol: "BTC/USDT", timeframe: "1h", limit: 20 });
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(result.source).toEqual({ venue: "okx", market: "spot", kind: "session-klines", mode: "paper" });
		expect(result.warnings[0]).toContain("okx");
	});

	it("rejects invalid direct limits instead of clamping before fetching", async () => {
		const provider = vi.fn(async () => ({
			candles: flatCandles(20),
			source: { venue: "okx", market: "spot" as const, kind: "session-klines" as const },
		}));
		setMarketLabCandleProvider(provider);
		await expect(fetchCandles({ symbol: "BTC/USDT", timeframe: "1h", limit: 19 })).rejects.toThrow(
			"Invalid limit: integer 20-200 required",
		);
		await expect(fetchCandles({ symbol: "BTC/USDT", timeframe: "1h", limit: 201 })).rejects.toThrow(
			"Invalid limit: integer 20-200 required",
		);
		expect(provider).not.toHaveBeenCalled();
	});

	it("propagates cancellation and enforces provider candle limits", async () => {
		const provider = vi.fn(async () => ({
			candles: flatCandles(21),
			source: { venue: "okx", market: "spot" as const, kind: "session-klines" as const },
		}));
		setMarketLabCandleProvider(provider);
		const controller = new AbortController();
		controller.abort();
		await expect(fetchCandles({ symbol: "BTC/USDT", timeframe: "1h", limit: 20 }, controller.signal)).rejects.toThrow(
			"Market data request timed out or was cancelled",
		);
		expect(provider).not.toHaveBeenCalled();

		await expect(fetchCandles({ symbol: "BTC/USDT", timeframe: "1h", limit: 20 })).rejects.toThrow(
			"Market data provider returned 21 candles; requested limit 20",
		);
		expect(provider).toHaveBeenCalledTimes(1);
	});

	it("stops waiting for a provider that cannot cancel its underlying request", async () => {
		let resolveProvider: ((value: Awaited<ReturnType<MarketLabCandleProvider>>) => void) | undefined;
		const provider = vi.fn(
			() =>
				new Promise<Awaited<ReturnType<MarketLabCandleProvider>>>((resolve) => {
					resolveProvider = resolve;
				}),
		);
		setMarketLabCandleProvider(provider);
		const controller = new AbortController();
		const pending = fetchCandles({ symbol: "BTC/USDT", timeframe: "1h", limit: 20 }, controller.signal);
		await Promise.resolve();
		controller.abort();
		await expect(pending).rejects.toThrow("Market data request timed out or was cancelled");
		expect(provider).toHaveBeenCalledTimes(1);
		resolveProvider?.({
			candles: flatCandles(20),
			source: { venue: "okx", market: "spot", kind: "session-klines" },
		});
	});

	it("times out a provider without leaving the caller waiting indefinitely", async () => {
		vi.useFakeTimers();
		setMarketLabCandleProvider(() => new Promise(() => {}));
		const pending = fetchCandles({ symbol: "BTC/USDT", limit: 20 });
		const rejected = expect(pending).rejects.toThrow("timed out");
		await vi.advanceTimersByTimeAsync(10_000);
		await rejected;
	});

	it("limits public data and reports the actual closed sample interval", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(22 * 3_600_000);
		const rows = flatCandles(21).map((candle) => [
			candle.timestamp,
			candle.open,
			candle.high,
			candle.low,
			candle.close,
			candle.volume,
		]);
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(JSON.stringify(rows), { status: 200 }));
		const result = await fetchCandles({ symbol: "BTC/USDT", limit: 20, timeframe: "1h" });
		expect(result.candles).toHaveLength(20);
		expect(result.startedAt).toBe(new Date(2 * 3_600_000).toISOString());
		expect(result.closedThrough).toBe(new Date(22 * 3_600_000).toISOString());
		fetchSpy.mockResolvedValue(new Response(JSON.stringify([...rows, rows[0]]), { status: 200 }));
		await expect(fetchCandles({ symbol: "BTC/USDT", limit: 20 })).rejects.toThrow("exceeded");
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
		expect(result.source).toEqual({ venue: "binance", market: "spot", kind: "binance-public-klines" });
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
			preset: "macd-hist",
		});
		expect(parseLabArgs("BTC/USDT limit=80")).toEqual({
			symbol: "BTC/USDT",
			limit: 80,
		});
		expect(parseLabArgs("BTC/USDT horizon=3").error).toMatch(/only supported by \/lab replay/);
		expect(parseLabArgs("BTC/USDT 2h bogus").error).toMatch(/Unknown argument/);
	});

	it("parses /replay limit and horizon arguments", () => {
		expect(parseReplayArgs("BTC/USDT 1h rsi-revert limit=80 horizon=3")).toEqual({
			symbol: "BTC/USDT",
			timeframe: "1h",
			preset: "rsi-revert",
			limit: 80,
			horizon: 3,
		});
		expect(parseReplayArgs("BTC/USDT horizon=0").error).toBe("Invalid horizon: integer 1-20 required");
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
		expect(parseScreenArgs("BTC/USDT ETH/USDT limit=50")).toEqual({
			symbols: ["BTC/USDT", "ETH/USDT"],
			limit: 50,
		});
		expect(parseScreenArgs("1h").error).toMatch(/Usage: \/lab screen/);
	});

	it("screens multiple symbols and keeps per-symbol failures", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = String(input);
			if (url.includes("symbol=BADUSDT")) {
				return new Response("nope", { status: 400, headers: { "content-type": "application/json" } });
			}
			const series = url.includes("symbol=ETHUSDT") ? fallingCandles(41) : flatCandles(41);
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
		expect(result.status).toBe("partial-failure");
		expect(result.requested).toBe(4);
		expect(result.scanned).toBe(3);
		expect(result.failed).toBe(1);
		expect(result.duplicates).toEqual(["ETH/USDT"]);
		expect(result.rows.find((row) => row.symbol === "ETH/USDT")).toMatchObject({
			event: "oversold",
			bias: "bullish",
			candleCount: 40,
			closedThrough: new Date(42 * 3_600_000).toISOString(),
		});
		expect(result.rows.find((row) => row.symbol === "BTC/USDT")).toMatchObject({
			event: "mid-range",
			bias: "neutral",
		});
		expect(result.rows.at(-1)).toMatchObject({ symbol: "BAD/USDT" });
		expect(typeof result.rows.at(-1)?.error).toBe("string");
		expect(result.warnings).toContain("This is a read-only scan; no order was created.");
		expect(result.warnings).toContain("Duplicate symbols skipped after normalization: ETH/USDT");
	});

	it("reports all screen failures without fabricating a source", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("nope", { status: 400, headers: { "content-type": "application/json" } }),
		);
		const result = await screenMarkets({
			symbols: ["BAD/USDT", "NOPE/USDT"],
			timeframe: "1h",
			limit: 20,
			preset: "ema-cross",
		});
		expect(result.status).toBe("failed");
		expect(result.source).toBeNull();
		expect(result.failed).toBe(2);
		expect(result.warnings[0]).toBe("Every symbol failed; no market data source was confirmed.");
	});

	it("does not stamp a mixed spot and futures scan with the first row's market", async () => {
		setMarketLabCandleProvider(async ({ symbol }) => ({
			candles: flatCandles(60),
			source: { venue: "binance", market: symbol.includes(":") ? "swap" : "spot", kind: "session-klines" },
		}));
		const result = await screenMarkets({ symbols: ["BTC/USDT", "BTC/USDT:USDT"], limit: 60 });
		expect(result.source).toBeNull();
		expect(result.rows.map((row) => row.source?.market).sort()).toEqual(["spot", "swap"]);
		expect(result.warnings[0]).toContain("different market data sources");
	});

	it("passes command options and cancellation to replay and screen without trading", async () => {
		const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
		const api = {
			registerTool: vi.fn(),
			registerCommand: (name: string, options: Parameters<ExtensionAPI["registerCommand"]>[1]) => {
				commands.set(name, options);
			},
			registerEntryRenderer: vi.fn(),
			appendEntry: vi.fn(),
		};
		marketLabExtension(api as unknown as ExtensionAPI);
		const notify = vi.fn();
		const controller = new AbortController();
		const ctx = { signal: controller.signal, ui: { notify } } as unknown as ExtensionCommandContext;
		const provider = vi.fn<MarketLabCandleProvider>(async ({ limit }) => ({
			candles: flatCandles(limit),
			source: { venue: "okx", market: "spot", kind: "session-klines" },
		}));
		setMarketLabCandleProvider(provider);
		await commands.get("lab")!.handler("replay BTC/USDT 1h limit=60 horizon=3", ctx);
		expect(JSON.parse(notify.mock.calls[0][0])).toMatchObject({ horizon: 3, candleCount: 60 });
		controller.abort();
		await expect(commands.get("lab")!.handler("screen BTC/USDT 1h limit=60", ctx)).rejects.toThrow("cancelled");
		expect(provider).toHaveBeenCalledTimes(1);
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
		expect(replay.trades[0]).toMatchObject({ signalIndex: 2, entryIndex: 3, exitIndex: 4 });
		expect(replay.trades[0]?.entry).toBe(100);
		expect(replay.trades[0]?.exit).toBe(110);
		expect(replay.trades[0]?.returnPct).toBe(10);
		expect(replay.avgReturnPct).toBe(10);
		expect(replay.sumReturnPct).toBe(10);
		expect(replay.winRate).toBe(1);
		expect(replay.warnings).toContain("Closed-candle rule replay only; not a backtest.");
		expect(replay).not.toHaveProperty("order");
	});

	it("does not invent an RSI transition when the first available RSI is already oversold", () => {
		const series = fallingCandles(40);
		const replay = simulateRule(calculateIndicators(series), series, "rsi-revert", undefined, 5);
		expect(replay.tradeCount).toBe(0);
		expect(replay.winRate).toBeNull();
	});

	it("reopens RSI only after a known non-extreme state and keeps trades non-overlapping", () => {
		const series = flatCandles(20);
		const points = series.map((candle, index) => ({
			timestamp: candle.timestamp,
			close: candle.close,
			rsi: index === 0 || index === 9 ? 50 : 20,
		}));
		const replay = simulateRule(points, series, "rsi-revert", undefined, 5);
		expect(replay.trades.map((trade) => trade.signalIndex)).toEqual([1, 10]);
		expect(replay.longs).toBe(2);
		expect(replay.warnings).toContain(
			"RSI replay opens only on transitions into oversold or overbought states; continuous extremes are not reopened until the state resets.",
		);
		const opens = replay.trades.map((trade) => trade.index);
		for (let index = 1; index < opens.length; index++) {
			expect(opens[index] - opens[index - 1]).toBeGreaterThanOrEqual(5);
		}
	});

	it("does not change a completed replay trade when only later candles change", () => {
		const series = flatCandles(8);
		const points = series.map((candle, index) => ({
			timestamp: candle.timestamp,
			close: candle.close,
			emaFast: index === 2 ? 3 : 1,
			emaSlow: 2,
		}));
		const original = simulateRule(points, series, "ema-cross", undefined, 2);
		const later = series.map((candle, index) =>
			index > 4 ? { ...candle, open: 150, high: 200, close: 170 } : candle,
		);
		expect(simulateRule(points, later, "ema-cross", undefined, 2).trades[0]).toEqual(original.trades[0]);
	});

	it("reports insufficient replay samples and keeps zero-trade stats null", () => {
		const series = candles(20);
		const replay = simulateRule(calculateIndicators(series), series, "ema-cross", undefined, 5);
		expect(replay.tradeCount).toBe(0);
		expect(replay.winRate).toBeNull();
		expect(replay.avgReturnPct).toBeNull();
		expect(replay.bestReturnPct).toBeNull();
		expect(replay.worstReturnPct).toBeNull();
		expect(replay.sumReturnPct).toBe(0);
		expect(replay.warnings.some((warning) => warning.includes("Not enough closed candles"))).toBe(true);
		expect(replay.warnings).toContain(
			"No replay trades opened; winRate, avgReturnPct, bestReturnPct, and worstReturnPct are null.",
		);
	});
});
