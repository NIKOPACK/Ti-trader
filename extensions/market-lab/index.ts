import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	type Candle,
	calculateIndicators,
	type IndicatorPeriods,
	type IndicatorPoint,
	resolveIndicatorPeriods,
} from "./indicators.ts";
import {
	evaluateStrategy,
	isStrategyPreset,
	resolveReplayHorizon,
	STRATEGY_PRESETS,
	type StrategyPreset,
	simulateRule,
} from "./strategies.ts";

const BINANCE_API = "https://api.binance.com";
/** Shared with `packages/trading-agent/src/market-lab-bridge.ts` via `Symbol.for`. */
export const MARKET_LAB_CANDLE_PROVIDER_KEY = Symbol.for("ti.marketLab.candleProvider");
const MAX_CANDLES = 200;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const TIMEFRAMES = new Set(["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d", "3d", "1w"]);

const periodSchema = Type.Optional(
	Type.Integer({ minimum: 2, maximum: MAX_CANDLES, description: "Indicator period. Integer 2-200." }),
);
const presetSchema = Type.Optional(
	Type.Union([Type.Literal("ema-cross"), Type.Literal("rsi-revert"), Type.Literal("macd-hist")], {
		description: `Named analysis preset. Default ema-cross. One of ${STRATEGY_PRESETS.join(", ")}.`,
	}),
);
const marketFields = {
	symbol: Type.String({ description: 'Session market symbol, e.g. "BTC/USDT" or "BTC/USDT:USDT".' }),
	timeframe: Type.Optional(Type.String({ description: "Binance interval, e.g. 1m, 15m, 1h, 4h, 1d. Default 1h." })),
	limit: Type.Optional(
		Type.Integer({ minimum: 20, maximum: MAX_CANDLES, description: "Closed candles to use. Default 100." }),
	),
};
const indicatorSchema = Type.Object({
	...marketFields,
	emaFast: periodSchema,
	emaSlow: periodSchema,
	rsiPeriod: periodSchema,
	atrPeriod: periodSchema,
});
const strategySchema = Type.Object({
	...marketFields,
	preset: presetSchema,
});
const MAX_SCREEN_SYMBOLS = 8;
const SAMPLE_TRADES = 10;
const screenSchema = Type.Object({
	symbols: Type.Array(Type.String({ description: 'Session market symbol, e.g. "BTC/USDT".' }), {
		minItems: 1,
		maxItems: MAX_SCREEN_SYMBOLS,
		description: "Session-market symbols to scan. 1-8 items.",
	}),
	timeframe: marketFields.timeframe,
	limit: marketFields.limit,
	preset: presetSchema,
});
const replaySchema = Type.Object({
	...marketFields,
	preset: presetSchema,
	horizon: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 20,
			description: "Closed candles after a signal used as the exit. Default 5.",
		}),
	),
});
type MarketParams = {
	symbol: string;
	timeframe?: string;
	limit?: number;
	preset?: StrategyPreset;
	emaFast?: number;
	emaSlow?: number;
	rsiPeriod?: number;
	atrPeriod?: number;
	horizon?: number;
};
type ScreenParams = {
	symbols: string[];
	timeframe?: string;
	limit?: number;
	preset?: StrategyPreset;
};

export type MarketLabSource = {
	venue: string;
	market: "spot" | "swap";
	kind: "session-klines" | "binance-public-klines";
	mode?: "paper" | "live";
};

export type MarketLabCandleProvider = (params: {
	symbol: string;
	timeframe: string;
	limit: number;
	signal?: AbortSignal;
}) => Promise<{ candles: Candle[]; source: MarketLabSource }>;

export function setMarketLabCandleProvider(provider: MarketLabCandleProvider | undefined): void {
	const holders = globalThis as Record<PropertyKey, unknown>;
	if (provider === undefined) delete holders[MARKET_LAB_CANDLE_PROVIDER_KEY];
	else holders[MARKET_LAB_CANDLE_PROVIDER_KEY] = provider;
}

function getMarketLabCandleProvider(): MarketLabCandleProvider | undefined {
	const value = (globalThis as Record<PropertyKey, unknown>)[MARKET_LAB_CANDLE_PROVIDER_KEY];
	return typeof value === "function" ? (value as MarketLabCandleProvider) : undefined;
}

function sourceWarning(source: MarketLabSource): string {
	if (source.kind === "session-klines") {
		return `Data source is this session's ${source.venue} ${source.market} klines (same as get_klines).`;
	}
	return "Data source is Binance public spot klines (no session market-data bridge).";
}

function jsonResult(data: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], details: data };
}

function periodsFromParams(params: MarketParams): IndicatorPeriods {
	return resolveIndicatorPeriods({
		emaFast: params.emaFast,
		emaSlow: params.emaSlow,
		rsi: params.rsiPeriod,
		atr: params.atrPeriod,
	});
}

export function parseLabArgs(args: string): {
	symbol?: string;
	timeframe?: string;
	preset?: StrategyPreset;
	error?: string;
} {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return {};
	const symbol = parts[0];
	let timeframe: string | undefined;
	let preset: StrategyPreset | undefined;
	for (const part of parts.slice(1)) {
		if (isStrategyPreset(part)) {
			if (preset) return { error: "Usage: /signal BTC/USDT [1h] [ema-cross|rsi-revert|macd-hist]" };
			preset = part;
			continue;
		}
		if (TIMEFRAMES.has(part)) {
			if (timeframe) return { error: "Usage: /signal BTC/USDT [1h] [ema-cross|rsi-revert|macd-hist]" };
			timeframe = part;
			continue;
		}
		return { error: `Unknown argument: ${part}` };
	}
	return { symbol, timeframe, preset };
}

export function parseScreenArgs(args: string): {
	symbols?: string[];
	timeframe?: string;
	preset?: StrategyPreset;
	error?: string;
} {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return {};
	const symbols: string[] = [];
	let timeframe: string | undefined;
	let preset: StrategyPreset | undefined;
	for (const part of parts) {
		if (isStrategyPreset(part)) {
			if (preset) return { error: "Usage: /screen BTC/USDT ETH/USDT [1h] [ema-cross|rsi-revert|macd-hist]" };
			preset = part;
			continue;
		}
		if (TIMEFRAMES.has(part)) {
			if (timeframe) return { error: "Usage: /screen BTC/USDT ETH/USDT [1h] [ema-cross|rsi-revert|macd-hist]" };
			timeframe = part;
			continue;
		}
		symbols.push(part);
	}
	if (symbols.length === 0) return { error: "Usage: /screen BTC/USDT ETH/USDT [1h] [ema-cross|rsi-revert|macd-hist]" };
	if (symbols.length > MAX_SCREEN_SYMBOLS) return { error: `Screen at most ${MAX_SCREEN_SYMBOLS} symbols` };
	return { symbols, timeframe, preset };
}

function uniqueSymbols(symbols: string[]): string[] {
	const seen = new Set<string>();
	const output: string[] = [];
	for (const raw of symbols) {
		const symbol = raw.trim().toUpperCase();
		if (!symbol) continue;
		if (seen.has(symbol)) continue;
		seen.add(symbol);
		output.push(symbol);
	}
	if (output.length === 0) throw new Error("At least one symbol is required");
	if (output.length > MAX_SCREEN_SYMBOLS) throw new Error(`Screen at most ${MAX_SCREEN_SYMBOLS} symbols`);
	return output;
}

function binanceSymbol(symbol: string): string {
	const parts = symbol.trim().toUpperCase().split("/");
	if (parts.length !== 2 || !/^[A-Z0-9]{2,20}$/.test(parts[0]) || !/^[A-Z0-9]{2,20}$/.test(parts[1])) {
		throw new Error("Only spot symbols in BASE/QUOTE format are supported, for example BTC/USDT");
	}
	if (parts[1] !== "USDT" && parts[1] !== "USDC" && parts[1] !== "BTC" && parts[1] !== "ETH") {
		throw new Error("This read-only data source supports quote currencies USDT, USDC, BTC, and ETH");
	}
	return parts.join("");
}

function sessionSymbol(symbol: string): string {
	const text = symbol.trim().toUpperCase();
	if (/^[A-Z0-9]{2,20}\/[A-Z0-9]{2,20}$/.test(text)) return text;
	if (/^[A-Z0-9]{2,20}\/[A-Z0-9]{2,20}:[A-Z0-9]{2,20}$/.test(text)) return text;
	throw new Error("Use a session market symbol such as BTC/USDT or BTC/USDT:USDT");
}

function candleFromValues(values: number[]): Candle {
	if (values.some((value) => !Number.isFinite(value))) throw new Error("Market data contained a non-finite value");
	if (
		values[0] <= 0 ||
		values[1] <= 0 ||
		values[2] < values[1] ||
		values[3] > values[1] ||
		values[3] <= 0 ||
		values[2] < values[3] ||
		values[4] < values[3] ||
		values[4] > values[2] ||
		values[5] < 0
	) {
		throw new Error("Market data candle had invalid OHLCV values");
	}
	return {
		timestamp: values[0],
		open: values[1],
		high: values[2],
		low: values[3],
		close: values[4],
		volume: values[5],
	};
}

function finalizeCandles(candles: Candle[], symbol: string, timeframe: string, source: MarketLabSource) {
	for (const candle of candles)
		candleFromValues([candle.timestamp, candle.open, candle.high, candle.low, candle.close, candle.volume]);
	for (let index = 1; index < candles.length; index++)
		if (candles[index].timestamp <= candles[index - 1].timestamp)
			throw new Error("Market data candles were not ordered");
	if (candles.length < 20) throw new Error("Not enough closed candles for analysis");
	return { symbol: symbol.toUpperCase(), timeframe, candles, source };
}

async function fetchCandles(
	params: MarketParams,
	signal?: AbortSignal,
): Promise<{ symbol: string; timeframe: string; candles: Candle[]; source: MarketLabSource }> {
	const timeframe = params.timeframe?.trim() || "1h";
	if (!TIMEFRAMES.has(timeframe)) throw new Error(`Unsupported timeframe: ${timeframe}`);
	const limit = Math.min(Math.max(Math.floor(params.limit ?? 100), 20), MAX_CANDLES);
	const provider = getMarketLabCandleProvider();
	if (provider) {
		const symbol = sessionSymbol(params.symbol);
		const result = await provider({ symbol, timeframe, limit, signal });
		return finalizeCandles(result.candles, params.symbol, timeframe, result.source);
	}
	const symbol = binanceSymbol(params.symbol);
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	const relay = (): void => controller.abort();
	if (signal) {
		if (signal.aborted) controller.abort();
		else signal.addEventListener("abort", relay, { once: true });
	}
	try {
		const response = await fetch(
			`${BINANCE_API}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(timeframe)}&limit=${limit + 1}`,
			{
				method: "GET",
				redirect: "error",
				signal: controller.signal,
			},
		);
		if (!response.ok) throw new Error(`Market data request failed with HTTP ${response.status}`);
		const declaredLength = Number(response.headers.get("content-length"));
		if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES)
			throw new Error("Market data response was too large");
		if (!response.body) throw new Error("Market data response had no body");
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let byteLength = 0;
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				byteLength += value.byteLength;
				if (byteLength > MAX_RESPONSE_BYTES) throw new Error("Market data response was too large");
				chunks.push(value);
			}
		} finally {
			reader.releaseLock();
		}
		const body = new Uint8Array(byteLength);
		let offset = 0;
		for (const chunk of chunks) {
			body.set(chunk, offset);
			offset += chunk.byteLength;
		}
		const payload: unknown = JSON.parse(new TextDecoder().decode(body));
		if (!Array.isArray(payload)) throw new Error("Market data response was invalid");
		const candles = payload.slice(0, -1).map((row): Candle => {
			if (!Array.isArray(row) || row.length < 6) throw new Error("Market data candle was invalid");
			return candleFromValues(row.slice(0, 6).map(Number));
		});
		return finalizeCandles(candles, params.symbol, timeframe, {
			venue: "binance",
			market: "spot",
			kind: "binance-public-klines",
		});
	} catch (error) {
		if (controller.signal.aborted) throw new Error("Market data request timed out or was cancelled");
		throw error;
	} finally {
		clearTimeout(timeout);
		if (signal) signal.removeEventListener("abort", relay);
	}
}

function rounded(point: IndicatorPoint | undefined): Record<string, number | null> {
	const output: Record<string, number | null> = {};
	for (const [key, value] of Object.entries(point ?? {}))
		if (key !== "timestamp" && key !== "close") output[key] = value === undefined ? null : Number(value.toFixed(8));
	return output;
}

async function analyze(params: MarketParams, signal?: AbortSignal) {
	const preset: StrategyPreset = params.preset ?? "ema-cross";
	if (params.preset !== undefined && !isStrategyPreset(params.preset)) {
		throw new Error(`Unsupported strategy preset: ${params.preset}`);
	}
	const periods = periodsFromParams(params);
	const data = await fetchCandles(params, signal);
	const points = calculateIndicators(data.candles, periods);
	const latest = points.at(-1);
	if (!latest) throw new Error("Unable to calculate indicators");
	const evaluation = evaluateStrategy(points, data.candles, preset, periods);
	const reasons = [...evaluation.reasons];
	if (preset === "ema-cross") {
		const rsiValue = latest.rsi ?? latest.rsi14;
		if (rsiValue !== undefined) reasons.push(`RSI${periods.rsi} is ${rsiValue.toFixed(2)}`);
		if (latest.volumeRatio !== undefined) {
			reasons.push(`Latest volume is ${latest.volumeRatio.toFixed(2)}x its ${periods.volumeSma}-candle average`);
		}
	}
	const warnings = [sourceWarning(data.source), ...evaluation.warnings];
	if ((latest.emaSlow ?? latest.ema50) === undefined) {
		warnings.push(`Fewer than ${periods.emaSlow} candles were available; slow EMA is unavailable.`);
	}
	const confidence =
		evaluation.bias === "insufficient-data"
			? "low"
			: reasons.length >= 3 || evaluation.confidence === "medium"
				? "medium"
				: "low";
	return {
		source: data.source,
		symbol: data.symbol,
		timeframe: data.timeframe,
		candleCount: data.candles.length,
		closedThrough: new Date(data.candles.at(-1)?.timestamp ?? 0).toISOString(),
		preset: evaluation.preset,
		periods,
		latest: { close: latest.close, ...rounded(latest) },
		recentRange: {
			high: evaluation.invalidationCandidates.bearish,
			low: evaluation.invalidationCandidates.bullish,
		},
		bias: evaluation.bias,
		event: evaluation.event,
		confidence,
		reasons,
		invalidationCandidates: evaluation.invalidationCandidates,
		warnings,
	};
}

function screenRank(event: string | undefined, error?: string): number {
	if (error) return 100;
	if (event === "cross-up" || event === "cross-down") return 0;
	if (event === "oversold" || event === "overbought") return 1;
	if (event === "above" || event === "below") return 2;
	if (event === "equal" || event === "mid-range") return 3;
	return 4;
}

async function screenMarkets(params: ScreenParams, signal?: AbortSignal) {
	const symbols = uniqueSymbols(params.symbols);
	const preset: StrategyPreset = params.preset ?? "ema-cross";
	if (params.preset !== undefined && !isStrategyPreset(params.preset)) {
		throw new Error(`Unsupported strategy preset: ${params.preset}`);
	}
	const rows: Array<Record<string, unknown>> = [];
	for (const symbol of symbols) {
		if (signal?.aborted) throw new Error("Market data request timed out or was cancelled");
		try {
			const result = await analyze({ symbol, timeframe: params.timeframe, limit: params.limit, preset }, signal);
			rows.push({
				source: result.source,
				symbol: result.symbol,
				timeframe: result.timeframe,
				close: result.latest.close,
				bias: result.bias,
				event: result.event,
				confidence: result.confidence,
				reasons: result.reasons,
			});
		} catch (error) {
			if (signal?.aborted) throw new Error("Market data request timed out or was cancelled");
			rows.push({
				symbol,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	rows.sort((left, right) => {
		const rank =
			screenRank(left.event as string | undefined, left.error as string | undefined) -
			screenRank(right.event as string | undefined, right.error as string | undefined);
		if (rank !== 0) return rank;
		return String(left.symbol).localeCompare(String(right.symbol));
	});
	const source = (rows.find((row) => row.source !== undefined)?.source ?? {
		venue: getMarketLabCandleProvider() ? "session" : "binance",
		market: "spot",
		kind: getMarketLabCandleProvider() ? "session-klines" : "binance-public-klines",
	}) as MarketLabSource;
	return {
		source,
		timeframe: params.timeframe?.trim() || "1h",
		preset,
		scanned: symbols.length,
		failed: rows.filter((row) => row.error !== undefined).length,
		rows,
		warnings: [
			sourceWarning(source),
			"This is a read-only scan; no order was created.",
			"Volume ranking from get_top_markets is not a signal.",
		],
	};
}

function roundedNumber(value: number | null): number | null {
	return value === null ? null : Number(value.toFixed(8));
}

async function replayRule(params: MarketParams, signal?: AbortSignal) {
	const preset: StrategyPreset = params.preset ?? "ema-cross";
	if (params.preset !== undefined && !isStrategyPreset(params.preset)) {
		throw new Error(`Unsupported strategy preset: ${params.preset}`);
	}
	const horizon = resolveReplayHorizon(params.horizon);
	const periods = periodsFromParams(params);
	const data = await fetchCandles(params, signal);
	const points = calculateIndicators(data.candles, periods);
	const replay = simulateRule(points, data.candles, preset, periods, horizon);
	return {
		source: data.source,
		symbol: data.symbol,
		timeframe: data.timeframe,
		closedThrough: new Date(data.candles.at(-1)?.timestamp ?? 0).toISOString(),
		periods,
		preset: replay.preset,
		horizon: replay.horizon,
		candleCount: replay.candleCount,
		tradeCount: replay.tradeCount,
		longs: replay.longs,
		shorts: replay.shorts,
		wins: replay.wins,
		losses: replay.losses,
		flats: replay.flats,
		winRate: roundedNumber(replay.winRate),
		avgReturnPct: roundedNumber(replay.avgReturnPct),
		sumReturnPct: Number(replay.sumReturnPct.toFixed(8)),
		bestReturnPct: roundedNumber(replay.bestReturnPct),
		worstReturnPct: roundedNumber(replay.worstReturnPct),
		sampleTrades: replay.trades.slice(-SAMPLE_TRADES).map((trade) => ({
			...trade,
			entry: Number(trade.entry.toFixed(8)),
			exit: Number(trade.exit.toFixed(8)),
			returnPct: Number(trade.returnPct.toFixed(8)),
			at: new Date(trade.timestamp).toISOString(),
		})),
		warnings: [sourceWarning(data.source), ...replay.warnings],
	};
}

export default function marketLabExtension(pi: ExtensionAPI): void {
	const register = (
		name: string,
		description: string,
		parameters: typeof indicatorSchema | typeof strategySchema,
		handler: (params: MarketParams, signal?: AbortSignal) => Promise<unknown>,
	): void => {
		pi.registerTool({
			name,
			label: name,
			description,
			parameters,
			async execute(_id, params, signal) {
				return jsonResult(await handler(params as MarketParams, signal));
			},
		});
	};
	register(
		"calculate_indicators",
		"Read-only technical indicators from this session's closed klines (same source as get_klines). Does not execute trades.",
		indicatorSchema,
		async (params, signal) => {
			const periods = periodsFromParams(params);
			const data = await fetchCandles(params, signal);
			const points = calculateIndicators(data.candles, periods);
			return {
				source: data.source,
				symbol: data.symbol,
				timeframe: data.timeframe,
				candleCount: points.length,
				closedThrough: new Date(points.at(-1)?.timestamp ?? 0).toISOString(),
				periods,
				latest: { close: points.at(-1)?.close, ...rounded(points.at(-1)) },
				warnings: [
					sourceWarning(data.source),
					"The currently forming candle was excluded.",
					"This is analysis only; no order was created.",
				],
			};
		},
	);
	register(
		"evaluate_strategy",
		"Evaluate a named read-only preset (ema-cross, rsi-revert, macd-hist). Never places an order.",
		strategySchema,
		analyze,
	);
	pi.registerTool({
		name: "screen_markets",
		label: "screen_markets",
		description: "Read-only scan of up to 8 session-market symbols with a named preset. Does not execute trades.",
		parameters: screenSchema,
		async execute(_id, params, signal) {
			return jsonResult(await screenMarkets(params as ScreenParams, signal));
		},
	});
	pi.registerTool({
		name: "simulate_rule",
		label: "simulate_rule",
		description:
			"Replay a named preset on this session's closed klines (same source as get_klines). Not a backtest and never places an order.",
		parameters: replaySchema,
		async execute(_id, params, signal) {
			return jsonResult(await replayRule(params as MarketParams, signal));
		},
	});
	pi.registerCommand("indicators", {
		description: "Show read-only technical indicators: /indicators SYMBOL [TIMEFRAME]",
		handler: async (args, ctx) => {
			const parsed = parseLabArgs(args);
			if (parsed.error) return ctx.ui.notify(parsed.error, "warning");
			if (!parsed.symbol) return ctx.ui.notify("Usage: /indicators BTC/USDT [1h]", "warning");
			ctx.ui.notify(
				JSON.stringify(await analyze({ symbol: parsed.symbol, timeframe: parsed.timeframe }), null, 2),
				"info",
			);
		},
	});
	pi.registerCommand("signal", {
		description: "Show a read-only market signal: /signal SYMBOL [TIMEFRAME] [ema-cross|rsi-revert|macd-hist]",
		handler: async (args, ctx) => {
			const parsed = parseLabArgs(args);
			if (parsed.error) return ctx.ui.notify(parsed.error, "warning");
			if (!parsed.symbol) {
				return ctx.ui.notify("Usage: /signal BTC/USDT [1h] [ema-cross|rsi-revert|macd-hist]", "warning");
			}
			ctx.ui.notify(
				JSON.stringify(
					await analyze({ symbol: parsed.symbol, timeframe: parsed.timeframe, preset: parsed.preset }),
					null,
					2,
				),
				"info",
			);
		},
	});
	pi.registerCommand("screen", {
		description: "Read-only multi-symbol scan: /screen BTC/USDT ETH/USDT [1h] [ema-cross|rsi-revert|macd-hist]",
		handler: async (args, ctx) => {
			const parsed = parseScreenArgs(args);
			if (parsed.error) return ctx.ui.notify(parsed.error, "warning");
			if (!parsed.symbols || parsed.symbols.length === 0) {
				return ctx.ui.notify("Usage: /screen BTC/USDT ETH/USDT [1h] [ema-cross|rsi-revert|macd-hist]", "warning");
			}
			ctx.ui.notify(
				JSON.stringify(
					await screenMarkets({
						symbols: parsed.symbols,
						timeframe: parsed.timeframe,
						preset: parsed.preset,
					}),
					null,
					2,
				),
				"info",
			);
		},
	});
	pi.registerCommand("replay", {
		description: "Read-only closed-candle replay: /replay SYMBOL [TIMEFRAME] [ema-cross|rsi-revert|macd-hist]",
		handler: async (args, ctx) => {
			const parsed = parseLabArgs(args);
			if (parsed.error) return ctx.ui.notify(parsed.error, "warning");
			if (!parsed.symbol) {
				return ctx.ui.notify("Usage: /replay BTC/USDT [1h] [ema-cross|rsi-revert|macd-hist]", "warning");
			}
			ctx.ui.notify(
				JSON.stringify(
					await replayRule({ symbol: parsed.symbol, timeframe: parsed.timeframe, preset: parsed.preset }),
					null,
					2,
				),
				"info",
			);
		},
	});
}

export {
	calculateIndicators,
	DEFAULT_INDICATOR_PERIODS,
	resolveIndicatorPeriods,
} from "./indicators.ts";
export {
	evaluateStrategy,
	isStrategyPreset,
	STRATEGY_PRESETS,
	simulateRule,
} from "./strategies.ts";
export { analyze, binanceSymbol, fetchCandles, replayRule, screenMarkets, sessionSymbol };
