import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { calculateIndicators, latestIndicators, type Candle, type IndicatorPoint } from "./indicators.ts";

const BINANCE_API = "https://api.binance.com";
const MAX_CANDLES = 200;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const TIMEFRAMES = new Set(["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d", "3d", "1w"]);

const marketSchema = Type.Object({
	symbol: Type.String({ description: 'Spot symbol, e.g. "BTC/USDT".' }),
	timeframe: Type.Optional(Type.String({ description: "Binance interval, e.g. 1m, 15m, 1h, 4h, 1d. Default 1h." })),
	limit: Type.Optional(Type.Integer({ minimum: 20, maximum: MAX_CANDLES, description: "Closed candles to use. Default 100." })),
});
type MarketParams = { symbol: string; timeframe?: string; limit?: number };

function jsonResult(data: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], details: data };
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

async function fetchCandles(params: MarketParams, signal?: AbortSignal): Promise<{ symbol: string; timeframe: string; candles: Candle[] }> {
	const symbol = binanceSymbol(params.symbol);
	const timeframe = params.timeframe?.trim() || "1h";
	if (!TIMEFRAMES.has(timeframe)) throw new Error(`Unsupported timeframe: ${timeframe}`);
	const limit = Math.min(Math.max(Math.floor(params.limit ?? 100), 20), MAX_CANDLES);
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	const relay = (): void => controller.abort();
	if (signal) {
		if (signal.aborted) controller.abort();
		else signal.addEventListener("abort", relay, { once: true });
	}
	try {
		const response = await fetch(`${BINANCE_API}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(timeframe)}&limit=${limit + 1}`, {
			method: "GET", redirect: "error", signal: controller.signal,
		});
		if (!response.ok) throw new Error(`Market data request failed with HTTP ${response.status}`);
		const declaredLength = Number(response.headers.get("content-length"));
		if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) throw new Error("Market data response was too large");
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
		for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
		const payload: unknown = JSON.parse(new TextDecoder().decode(body));
		if (!Array.isArray(payload)) throw new Error("Market data response was invalid");
		const candles = payload.slice(0, -1).map((row): Candle => {
			if (!Array.isArray(row) || row.length < 6) throw new Error("Market data candle was invalid");
			const values = row.slice(0, 6).map(Number);
			if (values.some((value) => !Number.isFinite(value))) throw new Error("Market data contained a non-finite value");
			if (values[0] <= 0 || values[1] <= 0 || values[2] < values[1] || values[3] > values[1] || values[3] <= 0 || values[2] < values[3] || values[4] <= 0 || values[5] < 0) throw new Error("Market data candle had invalid OHLCV values");
			return { timestamp: values[0], open: values[1], high: values[2], low: values[3], close: values[4], volume: values[5] };
		});
		for (let index = 1; index < candles.length; index++) if (candles[index].timestamp <= candles[index - 1].timestamp) throw new Error("Market data candles were not ordered");
		if (candles.length < 20) throw new Error("Not enough closed candles for analysis");
		return { symbol: params.symbol.toUpperCase(), timeframe, candles };
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
	for (const [key, value] of Object.entries(point ?? {})) if (key !== "timestamp" && key !== "close") output[key] = value === undefined ? null : Number(value.toFixed(8));
	return output;
}

async function analyze(params: MarketParams, signal?: AbortSignal) {
	const data = await fetchCandles(params, signal);
	const latest = latestIndicators(data.candles);
	if (!latest) throw new Error("Unable to calculate indicators");
	const closes = data.candles.map((candle) => candle.close);
	const high = Math.max(...data.candles.slice(-20).map((candle) => candle.high));
	const low = Math.min(...data.candles.slice(-20).map((candle) => candle.low));
	const warnings = ["Data source is Binance public spot market data, not account data.", "This is analysis only; no order was created.", "The last currently forming candle was excluded."];
	if (data.candles.length < 50) warnings.push("Fewer than 50 candles were available; EMA50 is unavailable.");
	const bias = latest.ema20 !== undefined && latest.ema50 !== undefined ? latest.ema20 > latest.ema50 ? "bullish" : "bearish" : "insufficient-data";
	const reasons: string[] = [];
	if (latest.ema20 !== undefined && latest.ema50 !== undefined) reasons.push(latest.ema20 > latest.ema50 ? "EMA20 is above EMA50" : "EMA20 is below EMA50");
	if (latest.rsi14 !== undefined) reasons.push(`RSI14 is ${latest.rsi14.toFixed(2)}`);
	if (latest.volumeRatio !== undefined) reasons.push(`Latest volume is ${latest.volumeRatio.toFixed(2)}x its 20-candle average`);
	const confidence = bias === "insufficient-data" ? "low" : reasons.length >= 3 ? "medium" : "low";
	return { symbol: data.symbol, timeframe: data.timeframe, candleCount: data.candles.length, closedThrough: new Date(data.candles.at(-1)?.timestamp ?? 0).toISOString(), latest: { close: latest.close, ...rounded(latest) }, recentRange: { high, low }, bias, confidence, reasons, invalidationCandidates: { bullish: low, bearish: high }, warnings };
}

export default function marketLabExtension(pi: ExtensionAPI): void {
	const register = (name: string, description: string, handler: (params: MarketParams, signal?: AbortSignal) => Promise<unknown>): void => {
		pi.registerTool({ name, label: name, description, parameters: marketSchema, async execute(_id, params, signal) { return jsonResult(await handler(params, signal)); } });
	};
	register("calculate_indicators", "Read-only technical indicators from closed public Binance spot candles. Does not execute trades.", async (params, signal) => {
		const data = await fetchCandles(params, signal);
		const points = calculateIndicators(data.candles);
		return { symbol: data.symbol, timeframe: data.timeframe, candleCount: points.length, closedThrough: new Date(points.at(-1)?.timestamp ?? 0).toISOString(), latest: { close: points.at(-1)?.close, ...rounded(points.at(-1)) }, warnings: ["Public Binance spot data only; no account or order access.", "The currently forming candle was excluded."] };
	});
	register("analyze_market_structure", "Analyze recent range, EMA trend, RSI, MACD, and ATR using closed public candles. Read-only.", analyze);
	register("generate_trade_signal", "Generate a non-binding, read-only market bias and invalidation candidates. Never places an order.", analyze);
	pi.registerCommand("indicators", { description: "Show read-only technical indicators: /indicators SYMBOL [TIMEFRAME]", handler: async (args, ctx) => { const [symbol, timeframe] = args.trim().split(/\s+/); if (!symbol) return ctx.ui.notify("Usage: /indicators BTC/USDT [1h]", "warning"); ctx.ui.notify(JSON.stringify(await analyze({ symbol, timeframe }), null, 2), "info"); } });
	pi.registerCommand("signal", { description: "Show a read-only market signal: /signal SYMBOL [TIMEFRAME]", handler: async (args, ctx) => { const [symbol, timeframe] = args.trim().split(/\s+/); if (!symbol) return ctx.ui.notify("Usage: /signal BTC/USDT [1h]", "warning"); ctx.ui.notify(JSON.stringify(await analyze({ symbol, timeframe }), null, 2), "info"); } });
}

export { analyze, binanceSymbol, fetchCandles };
