import { exchangeLabel } from "./exchanges.ts";
import { t, translate } from "./i18n.ts";
import type { MarketType, TradingLanguage, TradingMode } from "./state.ts";

export interface TradingVenueDisplay {
	/** Compact identity for the footer status line. */
	identity: string;
	/** Where prices and books come from; paper fills are local. */
	source: string;
}

function marketLabel(language: TradingLanguage, marketType: MarketType): string {
	if (marketType === "spot") return t(language, "marketSpot");
	if (marketType === "usdm-futures") return t(language, "marketFutures");
	return t(language, "marketBoth");
}

export function formatTradingVenue(input: {
	language: TradingLanguage;
	mode: TradingMode;
	exchangeId: string;
	marketType: MarketType;
	quoteCurrency: string;
	paused?: boolean;
}): TradingVenueDisplay {
	const exchange = exchangeLabel(input.exchangeId, input.language);
	const paused = input.paused ? `  ${t(input.language, "riskEntriesPaused")}` : "";
	const identity = `${t(input.language, input.mode === "live" ? "venueLive" : "venuePaper")}  ${exchange}  ${marketLabel(input.language, input.marketType)}  ${input.quoteCurrency}${paused}`;
	const source = translate(input.language, input.mode === "live" ? "venueLiveSource" : "venuePaperSource", {
		exchange,
	});
	return { identity, source };
}
