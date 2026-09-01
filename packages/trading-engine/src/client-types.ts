export type MarketType = "spot" | "usdm-futures" | "both";
export type FuturesMarginType = "isolated" | "cross";
export type FuturesPositionMode = "one-way" | "hedge";

export interface ExchangeCredentials {
	apiKey: string;
	secret: string;
	password?: string;
}
