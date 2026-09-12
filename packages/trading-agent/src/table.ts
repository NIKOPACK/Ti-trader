import { Box, type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/** Minimal theme surface used by the trading table renderer. */
export interface TableTheme {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
}

export type TableTone = "up" | "down" | "warn" | "error" | "muted";
export interface TableField {
	label: string;
	value: string;
}

export type TableLine = string | { text: string; tone?: TableTone } | { fields: TableField[]; tone?: TableTone };

export interface TableData {
	title: string;
	lines: TableLine[];
	warning?: string;
}

const TONE_COLOR: Record<TableTone, string> = {
	up: "success",
	down: "error",
	warn: "warning",
	error: "error",
	muted: "borderMuted",
};

/** Heuristic color for legacy persisted entries that carry plain strings only. */
function fallbackTone(text: string): TableTone | undefined {
	if (text.includes("LIVE") || text.includes("error")) return "error";
	if (text.includes("PnL +")) return "up";
	if (text.includes("PnL -")) return "down";
	return undefined;
}

/** Pad on the right to a visible column width (CJK/emoji aware). */
export function padEndWidth(text: string, width: number): string {
	const gap = width - visibleWidth(text);
	return gap > 0 ? text + " ".repeat(gap) : text;
}

/** Pad on the left to a visible column width (CJK/emoji aware). */
export function padStartWidth(text: string, width: number): string {
	const gap = width - visibleWidth(text);
	return gap > 0 ? " ".repeat(gap) + text : text;
}

/**
 * Bordered transcript box for trading command output. Layout is computed in
 * render() so the box adapts to the terminal width and all borders align.
 */
class TradingTableBox implements Component {
	private cachedWidth?: number;
	private cachedLines?: string[];
	private readonly data: TableData;
	private readonly theme: TableTheme;

	constructor(data: TableData, theme: TableTheme) {
		this.data = data;
		this.theme = theme;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}
		const theme = this.theme;
		const border = (s: string): string => theme.fg("borderMuted", s);
		const lines = this.data.lines.map((line) => {
			if (typeof line === "string") return { parts: [line], tone: fallbackTone(line) };
			if ("text" in line) return { parts: [line.text], tone: line.tone ?? fallbackTone(line.text) };
			return {
				parts: line.fields.map((field) => (field.label ? `${field.label}: ${field.value}` : field.value)),
				tone: line.tone,
			};
		});
		if (this.data.warning) lines.push({ parts: [this.data.warning], tone: "warn" });

		// inner = columns between "│ " and " │"; total box width = inner + 4.
		const rawTitle = ` ${this.data.title.toUpperCase()} `;
		let inner = Math.max(
			8,
			visibleWidth(rawTitle) + 2,
			...lines.map((line) => visibleWidth(line.parts.join("  "))),
			this.data.warning ? visibleWidth(this.data.warning) : 0,
		);
		const framed = width >= 8;
		inner = Math.min(inner, framed ? width - 4 : width);

		const titleColor = this.data.warning || this.data.title === "risk" ? "warning" : "accent";
		const title = truncateToWidth(rawTitle, inner);
		const top =
			border("╭─") + theme.fg(titleColor, title) + border(`${"─".repeat(inner + 1 - visibleWidth(title))}╮`);

		const rows = (parts: string[], tone?: TableTone): string[] => {
			const content: string[] = [];
			let current = "";
			for (const part of parts) {
				const candidate = current ? `${current}  ${part}` : part;
				if (current && visibleWidth(candidate) > inner) {
					content.push(current);
					current = part;
				} else {
					current = candidate;
				}
			}
			content.push(current);
			return content
				.flatMap((part) => wrapTextWithAnsi(part, inner))
				.map((line) => {
					const text = theme.fg(tone ? TONE_COLOR[tone] : "text", padEndWidth(line, inner));
					return framed ? `${border("│ ")}${text}${border(" │")}` : text;
				});
		};

		const result = [
			...(framed ? [top] : wrapTextWithAnsi(this.data.title, inner)),
			...lines.flatMap((line, index) => {
				const rendered = rows(line.parts, line.tone);
				return line.parts.length > 1 && rendered.length > 1 && index < lines.length - 1
					? [...rendered, ...rows([""])]
					: rendered;
			}),
			...(framed ? [border(`╰${"─".repeat(inner + 2)}╯`)] : []),
		];

		this.cachedWidth = width;
		this.cachedLines = result;
		return result;
	}
}

export function renderTradingTable(data: TableData, theme: TableTheme): Component {
	const box = new Box(1, 0, (value) => theme.bg("customMessageBg", value));
	box.addChild(new TradingTableBox(data, theme));
	return box;
}
