import type { TradingLanguage } from "./state.ts";

export const SUPPORTED_EXCHANGES = [
	{ id: "binance", zh: "Binance（币安）", en: "Binance" },
	{ id: "okx", zh: "OKX", en: "OKX" },
	{ id: "bybit", zh: "Bybit", en: "Bybit" },
] as const;

export type SupportedExchangeId = (typeof SUPPORTED_EXCHANGES)[number]["id"];

export function isSupportedExchangeId(id: string): id is SupportedExchangeId {
	return SUPPORTED_EXCHANGES.some((exchange) => exchange.id === id);
}

export function exchangeLabel(id: string, language: TradingLanguage): string {
	const found = SUPPORTED_EXCHANGES.find((exchange) => exchange.id === id);
	if (!found) return id;
	return language === "zh-CN" ? found.zh : found.en;
}
