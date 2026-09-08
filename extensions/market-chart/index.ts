import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { getTrading } from "ti-trader";
import { type Static, Type } from "typebox";
import { MarketChartComponent } from "./chart-component.ts";
import {
	distanceFrom,
	type MarketViewData,
	type PriceZone,
	renderMarketChart,
	type ScenarioLevel,
} from "./renderer.ts";

const MAX_CANDLES = 120;
const TIMEFRAMES = new Set(["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d", "1w"]);
const zoneSchema = Type.Object({
	low: Type.Number({ exclusiveMinimum: 0 }),
	high: Type.Number({ exclusiveMinimum: 0 }),
});
const viewSchema = Type.Object({
	symbol: Type.String({ minLength: 3, description: "Market symbol, e.g. BTC/USDT or BTC/USDT:USDT." }),
	timeframe: Type.Optional(Type.String({ description: "Candle timeframe, e.g. 15m, 1h, 4h. Default 1h." })),
	bias: Type.Union([Type.Literal("long"), Type.Literal("short"), Type.Literal("neutral")]),
	entryZone: Type.Optional(zoneSchema),
	waitZone: Type.Optional(zoneSchema),
	invalidation: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
	targets: Type.Optional(Type.Array(Type.Number({ exclusiveMinimum: 0 }), { maxItems: 6 })),
	rationale: Type.Optional(Type.String({ maxLength: 240 })),
});
type ViewParams = Static<typeof viewSchema>;

function assertFinitePositive(value: number, label: string): void {
	if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a finite positive number`);
}

function validateZone(zone: PriceZone | undefined, label: string): void {
	if (!zone) return;
	assertFinitePositive(zone.low, `${label}.low`);
	assertFinitePositive(zone.high, `${label}.high`);
	if (zone.low > zone.high) throw new Error(`${label}.low must not exceed ${label}.high`);
}

function validateScenario(params: ViewParams): void {
	validateZone(params.entryZone, "entryZone");
	validateZone(params.waitZone, "waitZone");
	if (params.invalidation !== undefined) assertFinitePositive(params.invalidation, "invalidation");
	for (const [index, target] of (params.targets ?? []).entries()) assertFinitePositive(target, `targets[${index}]`);
	const reference = params.entryZone ? (params.entryZone.low + params.entryZone.high) / 2 : undefined;
	if (reference === undefined || params.bias === "neutral") return;
	if (
		params.invalidation !== undefined &&
		((params.bias === "long" && params.invalidation >= reference) ||
			(params.bias === "short" && params.invalidation <= reference))
	) {
		throw new Error(`invalidation is on the wrong side of the ${params.bias} entry zone`);
	}
	for (const target of params.targets ?? []) {
		if ((params.bias === "long" && target <= reference) || (params.bias === "short" && target >= reference)) {
			throw new Error(`target ${target} is on the wrong side of the ${params.bias} entry zone`);
		}
	}
}

function timeframe(params: ViewParams): string {
	const value = params.timeframe?.trim() || "1h";
	if (!TIMEFRAMES.has(value)) throw new Error(`Unsupported timeframe: ${value}`);
	return value;
}

function levelsFrom(params: ViewParams): ScenarioLevel[] {
	const levels: ScenarioLevel[] = [];
	if (params.entryZone)
		levels.push(
			{ kind: "entry", price: params.entryZone.low, label: "Entry low" },
			{ kind: "entry", price: params.entryZone.high, label: "Entry high" },
		);
	if (params.waitZone)
		levels.push(
			{ kind: "wait", price: params.waitZone.low, label: "Wait low" },
			{ kind: "wait", price: params.waitZone.high, label: "Wait high" },
		);
	if (params.invalidation !== undefined)
		levels.push({ kind: "invalidation", price: params.invalidation, label: "Invalidation" });
	for (const [index, price] of (params.targets ?? []).entries()) {
		levels.push({ kind: "target", price, label: `Target ${index + 1}` });
	}
	return levels;
}

function jsonResult(data: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], details: data };
}

async function loadSnapshot(params: ViewParams, signal: AbortSignal | undefined): Promise<MarketViewData> {
	if (signal?.aborted) throw new Error("Market snapshot request was cancelled");
	validateScenario(params);
	const trading = getTrading();
	const tf = timeframe(params);
	const symbol = params.symbol.trim().toUpperCase();
	if (!symbol) throw new Error("symbol must not be empty");
	const [ticker, candles, positions, orders] = await Promise.all([
		trading.marketData.getTicker(symbol),
		trading.marketData.getKlines(symbol, tf, MAX_CANDLES),
		trading.marketData.getPositions(),
		trading.marketData.getOpenOrders(symbol),
	]);
	if (ticker.last === undefined || !Number.isFinite(ticker.last) || ticker.last <= 0)
		throw new Error(`No valid last price for ${symbol}`);
	if (candles.length === 0) throw new Error(`No candles returned for ${symbol} ${tf}`);
	for (const [index, candle] of candles.entries()) {
		if (![candle.timestamp, candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite))
			throw new Error(`Invalid candle at index ${index}`);
		if (candle.volume < 0) throw new Error(`Invalid volume at candle ${index}`);
		if (index > 0 && candle.timestamp <= candles[index - 1].timestamp)
			throw new Error(`Candle timestamps must be strictly increasing (index ${index})`);
		if (
			candle.high < Math.max(candle.open, candle.close) ||
			candle.low > Math.min(candle.open, candle.close) ||
			candle.low > candle.high
		)
			throw new Error(`Invalid OHLC range at candle ${index}`);
	}
	return {
		symbol,
		timeframe: tf,
		bias: params.bias,
		exchange: trading.tradingEngine.id,
		mode: trading.mode,
		ticker,
		candles,
		entryZone: params.entryZone,
		waitZone: params.waitZone,
		invalidation: params.invalidation,
		targets: [...(params.targets ?? [])],
		rationale: params.rationale?.trim() || undefined,
		levels: levelsFrom(params),
		positions,
		orders,
		createdAt: Date.now(),
	};
}

function summary(data: MarketViewData): Record<string, unknown> {
	const last = data.ticker.last as number;
	return {
		symbol: data.symbol,
		timeframe: data.timeframe,
		bias: data.bias,
		mode: data.mode,
		exchange: data.exchange,
		last,
		levels: data.levels.map((level) => ({
			...level,
			delta: distanceFrom(last, level.price).delta,
			pct: distanceFrom(last, level.price).pct,
		})),
		rationale: data.rationale,
		candleCount: data.candles.length,
		createdAt: data.createdAt,
	};
}

export default function marketChartExtension(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<MarketViewData>("market-view", (entry, options, theme) =>
		renderEntry(entry.data, options.expanded, theme),
	);
	pi.registerTool({
		name: "show_market_view",
		label: "show_market_view",
		description:
			"Render a read-only TUI market snapshot with agent-provided entry, wait, invalidation and target levels. Never places orders or generates levels.",
		promptSnippet: "Show a TUI chart explaining a market scenario without trading.",
		promptGuidelines: [
			"Use after explaining a concrete entry, pullback, breakout, invalidation, or target scenario.",
			"Always provide the price levels you actually discussed; this tool does not infer signals or choose prices.",
		],
		parameters: viewSchema,
		async execute(_id, params, signal, _onUpdate, ctx) {
			if (ctx.mode !== "tui")
				throw new Error("show_market_view requires Ti TUI mode; graphical rendering is unavailable here");
			const data = await loadSnapshot(params as ViewParams, signal);
			pi.appendEntry<MarketViewData>("market-view", data);
			return jsonResult(summary(data));
		},
	});
	pi.registerCommand("chart", {
		description: "Show a market scenario chart. Usage: /chart SYMBOL [TIMEFRAME]",
		handler: async (args, ctx) => {
			const [symbol, tf = "1h"] = args.trim().split(/\s+/);
			if (!symbol) return ctx.ui.notify("Usage: /chart BTC/USDT [1h]", "warning");
			try {
				const data = await loadSnapshot({ symbol, timeframe: tf, bias: "neutral" }, ctx.signal);
				await ctx.ui.custom(
					(tui, theme, _keys, done) => new MarketChartComponent(tui, theme, data, () => done(undefined)),
					{ overlay: true, overlayOptions: { width: "96%", maxHeight: "90%" } },
				);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}

function renderEntry(data: unknown, expanded: boolean, theme: Theme): Component {
	if (!isMarketViewData(data))
		return { render: () => [theme.fg("error", "Invalid market-view entry")], invalidate: () => {} };
	return { render: (width: number) => renderMarketChart(data, width, theme, expanded), invalidate: () => {} };
}

function isMarketViewData(value: unknown): value is MarketViewData {
	return typeof value === "object" && value !== null && "symbol" in value && "ticker" in value && "candles" in value;
}
