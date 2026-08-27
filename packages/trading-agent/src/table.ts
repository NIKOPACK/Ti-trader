import { Box, type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Minimal theme surface used by the trading table renderer. */
export interface TableTheme {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
}

export type TableTone = "up" | "down" | "warn" | "error" | "muted";
export type TableLine = string | { text: string; tone?: TableTone };

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
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}
		const theme = this.theme;
		const border = (s: string): string => theme.fg("borderMuted", s);
		const lines = this.data.lines.map((line) => (typeof line === "string" ? { text: line } : line));

		// inner = columns between "│ " and " │"; total box width = inner + 4.
		const rawTitle = ` ${this.data.title.toUpperCase()} `;
		let inner = Math.max(
			8,
			visibleWidth(rawTitle) + 2,
			...lines.map((line) => visibleWidth(line.text)),
			this.data.warning ? visibleWidth(this.data.warning) : 0,
		);
		inner = Math.min(inner, Math.max(1, width - 4));

		const titleColor = this.data.warning || this.data.title === "risk" ? "warning" : "accent";
		const title = truncateToWidth(rawTitle, inner);
		const top =
			border("╭─") + theme.fg(titleColor, title) + border(`${"─".repeat(inner + 1 - visibleWidth(title))}╮`);

		const row = (text: string, tone?: TableTone): string => {
			const clipped = padEndWidth(truncateToWidth(text, inner, "…"), inner);
			const effectiveTone = tone ?? fallbackTone(text);
			const color = effectiveTone ? TONE_COLOR[effectiveTone] : "text";
			return `${border("│ ")}${theme.fg(color, clipped)}${border(" │")}`;
		};

		const result = [top, ...lines.map((line) => row(line.text, line.tone))];
		if (this.data.warning) {
			result.push(row(this.data.warning, "warn"));
		}
		result.push(border(`╰${"─".repeat(inner + 2)}╯`));

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
