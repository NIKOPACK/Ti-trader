import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { exchangeLabel } from "./exchanges.ts";
import { orderApprovalLabel, t, translate } from "./i18n.ts";
import type { MarketType, OrderApprovalMode, TradingLanguage, TradingMode } from "./state.ts";

export interface TradingVenueDisplay {
	/** Compact identity for the footer status line. */
	identity: string;
	/** Where prices and books come from; paper fills are local. */
	source: string;
}

export interface TradingVenueInput {
	language: TradingLanguage;
	mode: TradingMode;
	exchangeId: string;
	marketType: MarketType;
	quoteCurrency: string;
	orderApproval?: OrderApprovalMode;
}

export interface TradingVenueStatus {
	summary: string;
	tone: "muted" | "warning" | "error";
	entryBlocked: boolean;
	recoveryHint?: string;
}

function marketLabel(language: TradingLanguage, marketType: MarketType): string {
	if (marketType === "spot") return t(language, "marketSpot");
	if (marketType === "usdm-futures") return t(language, "marketFutures");
	return t(language, "marketBoth");
}

export function formatTradingVenue(input: TradingVenueInput): TradingVenueDisplay {
	const exchange = exchangeLabel(input.exchangeId, input.language);
	const approval =
		input.mode === "live" && input.orderApproval
			? `  ${orderApprovalLabel(input.language, input.orderApproval)}`
			: "";
	const identity = `${t(input.language, input.mode === "live" ? "venueLive" : "venuePaper")}  ${exchange}  ${marketLabel(input.language, input.marketType)}  ${input.quoteCurrency}${approval}`;
	const source = translate(input.language, input.mode === "live" ? "venueLiveSource" : "venuePaperSource", {
		exchange,
	});
	return { identity, source };
}

/** Live execution carries risk in its approval mode, not in the mode badge itself. */
function modeColor(input: TradingVenueInput): "error" | "text" | "accent" {
	if (input.mode === "paper") return "accent";
	return input.orderApproval === "unattended" ? "error" : "text";
}

type VenueTheme = Pick<Theme, "fg" | "bold" | "inverse">;

/** Paper fills are local, so the feed note carries information the identity row does not. */
function paperFeed(input: TradingVenueInput, theme: VenueTheme): string | undefined {
	return input.mode === "paper" ? theme.fg("muted", t(input.language, "venuePaperFeed")) : undefined;
}

function renderIdentity(input: TradingVenueInput, theme: VenueTheme): string {
	const mode = t(input.language, input.mode === "live" ? "venueLive" : "venuePaper");
	const separator = theme.fg("dim", " · ");
	const chip = theme.inverse(theme.fg(modeColor(input), ` ${mode} `));
	const segments = [
		`${chip} ${theme.bold(theme.fg("text", exchangeLabel(input.exchangeId, input.language)))}`,
		theme.fg("muted", marketLabel(input.language, input.marketType)),
		theme.fg("muted", input.quoteCurrency),
	];
	// Confirm is the default and safe; only unattended execution must stay visible.
	if (input.mode === "live" && input.orderApproval === "unattended") {
		segments.push(theme.fg("warning", orderApprovalLabel(input.language, input.orderApproval)));
	}
	return segments.join(separator);
}

/** Blocking state replaces the identity row content, so it needs its own single line. */
function renderAlert(status: TradingVenueStatus, theme: VenueTheme): string {
	let alert = theme.fg(status.tone, `⚠ ${status.summary}`);
	if (status.recoveryHint) alert += theme.fg("dim", `  ·  ${status.recoveryHint}`);
	return `${alert}${theme.fg("muted", "  ·  /show health")}`;
}

export function renderTradingVenue(
	input: TradingVenueInput,
	theme: VenueTheme,
	width: number,
	status?: TradingVenueStatus,
): string[] {
	if (width <= 0) return [];
	const identity = renderIdentity(input, theme);
	const source = paperFeed(input, theme);
	const lines: string[] = [];
	if (source) {
		const gap = width - 2 - visibleWidth(identity) - visibleWidth(source);
		if (gap >= 4) lines.push(`${identity}${" ".repeat(gap)}${source}`);
		else lines.push(identity, source);
	} else {
		lines.push(identity);
	}
	if (status && (status.entryBlocked || status.tone === "error")) {
		lines.unshift(renderAlert(status, theme));
	}
	return new Text(lines.join("\n"), 1, 0).render(width).map((line) => truncateToWidth(line, width));
}

export function formatTradingStatus(input: TradingVenueInput, status: TradingVenueStatus): string[] {
	const lines: string[] = [];
	if (status.entryBlocked || status.tone === "error") {
		const hint = status.recoveryHint ? `  ·  ${status.recoveryHint}` : "";
		lines.push(`⚠ ${status.summary}${hint}  ·  /show health`);
	}
	const mode = t(input.language, input.mode === "live" ? "venueLive" : "venuePaper");
	const segments = [
		`[ ${mode} ]`,
		exchangeLabel(input.exchangeId, input.language),
		`${marketLabel(input.language, input.marketType)}  ${input.quoteCurrency}`,
	];
	if (input.mode === "live" && input.orderApproval === "unattended") {
		segments.push(orderApprovalLabel(input.language, input.orderApproval));
	}
	const identity = segments.join("  ");
	const source = input.mode === "paper" ? t(input.language, "venuePaperFeed") : undefined;
	lines.push(source ? `${identity}  ${source}` : identity);
	return lines;
}
