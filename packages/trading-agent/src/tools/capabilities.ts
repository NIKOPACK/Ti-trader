import {
	type Capability,
	getTradingCapabilities,
	isFuturesSymbol,
	type MarketFamily,
	type MarketInfo,
} from "@nikopack/ti-trading-engine";
import type { TradingRuntime } from "../context.ts";

export {
	type Capability,
	type CapabilityStatus,
	capability,
	type MarketFamily,
	normalizedOrderTypes,
	ORDER_TYPE_ALIASES,
	orderTypeFromMarketInfo,
	unavailableMarketCapability,
} from "@nikopack/ti-trading-engine";

export function marketFamily(trading: TradingRuntime, symbol: string | undefined): MarketFamily {
	if (symbol !== undefined) {
		const parts = symbol.split("/");
		if (parts.length !== 2 || !parts[0] || !parts[1]) return "invalid";
		const futures = isFuturesSymbol(symbol, trading.config.quoteCurrency);
		const expectedQuote = futures
			? `${trading.config.quoteCurrency}:${trading.config.quoteCurrency}`
			: trading.config.quoteCurrency;
		if (parts[1] !== expectedQuote) return "invalid";
		if (trading.config.marketType === "spot" && futures) return "invalid";
		if (trading.config.marketType === "usdm-futures" && !futures) return "invalid";
		return futures ? "futures" : "spot";
	}
	return trading.config.marketType === "spot"
		? "spot"
		: trading.config.marketType === "usdm-futures"
			? "futures"
			: "mixed";
}

export function marketInfoMatchesFamily(
	info: MarketInfo,
	symbol: string,
	family: MarketFamily,
	quoteCurrency: string,
	options: { allowOmittedOrientation?: boolean } = {},
): boolean {
	if (family !== "spot" && family !== "futures") return false;
	if (info.symbol !== symbol || info.active !== true || info.quote !== quoteCurrency) return false;
	if (family === "spot") return info.marketType === "spot" && info.contract === false;
	const orientationOmitted = info.linear === undefined && info.inverse === undefined;
	const orientationExplicit =
		(info.linear === true && info.inverse === false) || (info.linear === false && info.inverse === true);
	const orientationValid = options.allowOmittedOrientation
		? orientationOmitted || orientationExplicit
		: orientationExplicit;
	return info.marketType === "swap" && info.contract === true && info.settle === quoteCurrency && orientationValid;
}

/**
 * Preflight can consume adapters that omit optional orientation flags. An
 * explicitly contradictory flag is still rejected; only a wholly omitted
 * linear/inverse pair remains compatible and is reported through other
 * metadata/adapter checks.
 */
export function marketInfoMatchesPreflight(
	info: MarketInfo,
	symbol: string,
	family: MarketFamily,
	quoteCurrency: string,
): boolean {
	return marketInfoMatchesFamily(info, symbol, family, quoteCurrency, { allowOmittedOrientation: true });
}

export function requireFuturesSymbol(trading: TradingRuntime, symbol: string, capabilityName: string): void {
	if (trading.config.marketType === "spot") {
		throw new Error(`${capabilityName} is unavailable for spot markets; use a USDⓈ-M futures market`);
	}
	if (!isFuturesSymbol(symbol, trading.config.quoteCurrency)) {
		throw new Error(
			`${capabilityName} requires a futures symbol such as BTC/${trading.config.quoteCurrency}:${trading.config.quoteCurrency}`,
		);
	}
}

export function paperFuturesOrderUnsupported(
	trading: TradingRuntime,
	symbol: string,
	type: string,
): string | undefined {
	const matrix = getTradingCapabilities({
		exchangeId: trading.tradingEngine.id,
		mode: trading.mode,
		marketFamily: marketFamily(trading, symbol),
		positionMode: trading.config.positionMode,
	});
	if (trading.mode !== "paper" || matrix.profile !== "paper-futures") return undefined;
	const selected = Object.entries(matrix.orderTypes).find(([name]) => name === type)?.[1];
	if (selected?.status === "unsupported") return selected.reason;
	return undefined;
}

export function allCapabilities(capabilities: Record<string, Capability>): Capability[] {
	return Object.values(capabilities);
}

export function conditionalCapability(
	trading: TradingRuntime,
	family: MarketFamily,
	info: MarketInfo | undefined,
	orderType: "stop" | "stop_market" | "take_profit" | "take_profit_market",
	metadataValid = true,
): Capability {
	return getTradingCapabilities({
		exchangeId: trading.tradingEngine.id,
		mode: trading.mode,
		marketFamily: family,
		positionMode: trading.config.positionMode,
		marketInfo: info,
		metadataValid,
	}).orderTypes[orderType];
}

export function trailingCapability(
	trading: TradingRuntime,
	family: MarketFamily,
	info: MarketInfo | undefined,
	metadataValid = true,
): Capability {
	return getTradingCapabilities({
		exchangeId: trading.tradingEngine.id,
		mode: trading.mode,
		marketFamily: family,
		positionMode: trading.config.positionMode,
		marketInfo: info,
		metadataValid,
	}).orderTypes.trailing_stop_market;
}
