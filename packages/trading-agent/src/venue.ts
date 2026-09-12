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
	paused?: boolean;
	orderApproval?: OrderApprovalMode;
}

function marketLabel(language: TradingLanguage, marketType: MarketType): string {
	if (marketType === "spot") return t(language, "marketSpot");
	if (marketType === "usdm-futures") return t(language, "marketFutures");
	return t(language, "marketBoth");
}

export function formatTradingVenue(input: TradingVenueInput): TradingVenueDisplay {
	const exchange = exchangeLabel(input.exchangeId, input.language);
	const paused = input.paused ? `  ${t(input.language, "riskEntriesPaused")}` : "";
	const approval =
		input.mode === "live" && input.orderApproval
			? `  ${orderApprovalLabel(input.language, input.orderApproval)}`
			: "";
	const identity = `${t(input.language, input.mode === "live" ? "venueLive" : "venuePaper")}  ${exchange}  ${marketLabel(input.language, input.marketType)}  ${input.quoteCurrency}${paused}${approval}`;
	const source = translate(input.language, input.mode === "live" ? "venueLiveSource" : "venuePaperSource", {
		exchange,
	});
	return { identity, source };
}

export function renderTradingVenue(
	input: TradingVenueInput,
	theme: Pick<Theme, "fg" | "bold">,
	width: number,
): string[] {
	if (width <= 0) return [];
	const mode = t(input.language, input.mode === "live" ? "venueLive" : "venuePaper");
	const badge = theme.bold(theme.fg(input.mode === "live" ? "error" : "accent", `[ ${mode} ]`));
	const pause = input.paused
		? `  ${theme.bold(theme.fg("warning", `[ ${t(input.language, "riskEntriesPaused")} ]`))}`
		: "";
	const separator = theme.fg("dim", "  |  ");
	const identity =
		badge +
		pause +
		separator +
		theme.fg("text", exchangeLabel(input.exchangeId, input.language)) +
		separator +
		theme.fg("muted", `${marketLabel(input.language, input.marketType)}  ${input.quoteCurrency}`) +
		(input.mode === "live" && input.orderApproval
			? separator +
				theme.fg(
					input.orderApproval === "unattended" ? "warning" : "muted",
					orderApprovalLabel(input.language, input.orderApproval),
				)
			: "");
	const source = theme.fg("muted", formatTradingVenue(input).source);
	const gap = width - 2 - visibleWidth(identity) - visibleWidth(source);
	const content = gap >= 4 ? `${identity}${" ".repeat(gap)}${source}` : `${identity}\n${source}`;
	return new Text(content, 1, 0).render(width).map((line) => truncateToWidth(line, width));
}
