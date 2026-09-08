import type { Kline, Order, Position, Ticker } from "@earendil-works/ti-trading-engine";

export type Bias = "long" | "short" | "neutral";
export type PriceZone = { low: number; high: number };
export type ScenarioLevel = { kind: "entry" | "wait" | "invalidation" | "target"; price: number; label: string };

export interface MarketViewData {
	symbol: string;
	timeframe: string;
	bias: Bias;
	exchange: string;
	mode: "paper" | "live";
	ticker: Ticker;
	candles: Kline[];
	entryZone?: PriceZone;
	waitZone?: PriceZone;
	invalidation?: number;
	targets: number[];
	rationale?: string;
	levels: ScenarioLevel[];
	positions: Position[];
	orders: Order[];
	createdAt: number;
}

export interface PriceDistance {
	price: number;
	delta: number;
	pct: number;
}

export function distanceFrom(last: number, price: number): PriceDistance {
	return { price, delta: price - last, pct: ((price - last) / last) * 100 };
}

export function formatPrice(value: number): string {
	if (value >= 1000) return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
	if (value >= 1) return value.toLocaleString("en-US", { maximumFractionDigits: 4 });
	return value.toLocaleString("en-US", { maximumFractionDigits: 8 });
}

export function formatDistance(last: number, price: number): string {
	const distance = distanceFrom(last, price);
	const sign = distance.delta >= 0 ? "+" : "";
	return `${formatPrice(price)} (${sign}${distance.delta.toFixed(2)}, ${sign}${distance.pct.toFixed(2)}%)`;
}

function riskReward(data: MarketViewData): string | undefined {
	if (!data.entryZone || data.invalidation === undefined || data.targets.length === 0) return undefined;
	const entry = (data.entryZone.low + data.entryZone.high) / 2;
	const reward = Math.abs(data.targets[0] - entry);
	const risk = Math.abs(entry - data.invalidation);
	if (!(risk > 0) || !Number.isFinite(reward)) return undefined;
	return `R:R 1:${(reward / risk).toFixed(2)}`;
}

function levelColor(kind: ScenarioLevel["kind"]): string {
	return kind === "entry" ? "accent" : kind === "wait" ? "warning" : kind === "invalidation" ? "error" : "success";
}

export function renderMarketChart(
	data: MarketViewData,
	width: number,
	theme: { fg(color: string, text: string): string },
	expanded: boolean,
): string[] {
	const last = data.ticker.last;
	if (last === undefined || !Number.isFinite(last))
		return [theme.fg("error", "Market snapshot has no valid last price")];
	const clip = (text: string, maxWidth: number): string =>
		text.length > maxWidth ? `${text.slice(0, Math.max(0, maxWidth - 1))}…` : text;
	const title = clip(
		`${data.symbol} · ${data.timeframe} · ${data.mode.toUpperCase()} · ${data.exchange}`,
		Math.max(12, width - 5),
	);
	const lines: string[] = [
		theme.fg(data.mode === "live" ? "error" : "accent", clip(`┌─ ${title} ─`, width)),
		clip(
			`│ Bias: ${data.bias.toUpperCase()}   Last: ${formatPrice(last)}   24h: ${data.ticker.changePct24h === undefined ? "-" : `${data.ticker.changePct24h >= 0 ? "+" : ""}${data.ticker.changePct24h.toFixed(2)}%`}`,
			width,
		),
	];
	const rr = riskReward(data);
	if (rr) lines.push(clip(`│ ${rr}`, width));
	if (!expanded) {
		for (const level of data.levels)
			lines.push(clip(`│ ${level.label}: ${formatDistance(last, level.price)}`, width));
		if (data.rationale) lines.push(clip(`│ Why: ${data.rationale}`, width));
		lines.push(theme.fg("borderMuted", clip("└─ press expand to view candles and scenario map ─", width)));
		return lines;
	}

	const plotWidth = Math.max(20, Math.min(72, width - 42));
	const visible = data.candles.slice(-plotWidth);
	const values = visible.flatMap((candle) => [candle.low, candle.high]);
	for (const level of data.levels) values.push(level.price);
	values.push(last);
	const min = Math.min(...values);
	const max = Math.max(...values);
	const span = Math.max(max - min, Math.abs(max) * 0.0001, 1e-12);
	const rows = 10;
	const grid = Array.from({ length: rows }, () => Array.from({ length: plotWidth }, () => " "));
	const rowFor = (price: number): number =>
		Math.max(0, Math.min(rows - 1, Math.round(((max - price) / span) * (rows - 1))));
	visible.forEach((candle, index) => {
		const high = rowFor(candle.high);
		const low = rowFor(candle.low);
		const bodyTop = rowFor(Math.max(candle.open, candle.close));
		const bodyBottom = rowFor(Math.min(candle.open, candle.close));
		for (let row = high; row <= low; row++) grid[row][index] = "│";
		for (let row = bodyTop; row <= Math.max(bodyTop, bodyBottom); row++)
			grid[row][index] = candle.close >= candle.open ? "█" : "▓";
	});
	const levelByRow = new Map<number, ScenarioLevel[]>();
	for (const level of data.levels) {
		const row = rowFor(level.price);
		const current = levelByRow.get(row) ?? [];
		current.push(level);
		levelByRow.set(row, current);
	}
	for (let row = 0; row < rows; row++) {
		const levels = levelByRow.get(row) ?? [];
		const suffix =
			levels.length > 0
				? `  ${levels.map((level) => theme.fg(levelColor(level.kind), `${level.label} ${formatPrice(level.price)}`)).join(" · ")}`
				: "";
		lines.push(clip(`│ ${grid[row].join("")}${suffix}`, width));
	}
	lines.push(clip(`│ range ${formatPrice(min)} — ${formatPrice(max)}   candles ${visible.length}`, width));
	for (const level of data.levels) lines.push(clip(`│ ${level.label}: ${formatDistance(last, level.price)}`, width));
	if (data.rationale) lines.push(clip(`│ Why: ${data.rationale}`, width));
	const positionText =
		data.positions.length === 0 ? "none" : data.positions.map((p) => `${p.symbol} ${p.amount}`).join(", ");
	lines.push(clip(`│ Positions: ${positionText}   Orders: ${data.orders.length}`, width));
	lines.push(
		theme.fg(
			"borderMuted",
			clip("└─ ↑↓ timeframe hint: call show_market_view again · Esc closes manual view ─", width),
		),
	);
	return lines;
}
