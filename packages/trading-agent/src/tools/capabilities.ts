import type { MarketInfo } from "@earendil-works/ti-trading-engine";
import { isFuturesSymbol } from "@earendil-works/ti-trading-engine";
import type { TradingRuntime } from "../context.ts";

export type CapabilityStatus = "supported" | "unsupported" | "unknown";
export type Capability = { status: CapabilityStatus; reason: string };
export type MarketFamily = "spot" | "futures" | "mixed" | "invalid";

export const ORDER_TYPE_ALIASES = {
	STOP_LOSS_LIMIT: "stop",
	STOP_LOSS: "stop_market",
	TAKE_PROFIT_LIMIT: "take_profit",
	TAKE_PROFIT: "take_profit_market",
} as const;

export function capability(status: CapabilityStatus, reason: string): Capability {
	return { status, reason };
}

export function normalizedOrderTypes(info: MarketInfo | undefined): string[] | undefined {
	return info?.orderTypes?.map((type) => {
		const normalized = type.trim().replaceAll("-", "_");
		// Binance Spot exposes these explicit aliases for the same conditional
		// order families used by the agent schema. Keep the mapping bounded and
		// exact; a broad substring check would make stop and take-profit claims
		// bleed into one another.
		return (
			ORDER_TYPE_ALIASES[normalized.toUpperCase() as keyof typeof ORDER_TYPE_ALIASES] ?? normalized.toLowerCase()
		);
	});
}

export function orderTypeFromMarketInfo(
	info: MarketInfo | undefined,
	names: readonly string[],
): CapabilityStatus | undefined {
	const types = normalizedOrderTypes(info);
	if (types === undefined) return undefined;
	const normalizedNames = names.map((name) => name.trim().toLowerCase().replaceAll("-", "_"));
	return normalizedNames.some((name) => types.includes(name)) ? "supported" : "unsupported";
}

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
	if (
		trading.mode === "paper" &&
		(trading.config.marketType === "usdm-futures" || trading.config.marketType === "both") &&
		isFuturesSymbol(symbol, trading.config.quoteCurrency) &&
		type !== "market"
	) {
		return `Paper futures currently accept market orders only; ${type} orders are unsupported for ${symbol}`;
	}
	return undefined;
}

export function unavailableMarketCapability(
	family: MarketFamily,
	metadataValid: boolean,
	marketInfo: MarketInfo | undefined = undefined,
): Capability | undefined {
	if (family === "invalid")
		return capability("unsupported", "The symbol is not enabled by the configured market type or quote currency");
	if (marketInfo?.active === false) return capability("unsupported", `Market ${marketInfo.symbol} is inactive`);
	if (!metadataValid)
		return capability("unknown", "Market metadata is unavailable or does not match the requested symbol");
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
	const unavailable = unavailableMarketCapability(family, metadataValid, info);
	if (unavailable) return unavailable;
	if (family === "mixed") return capability("unknown", "Specify a symbol to distinguish spot and futures support");
	if (family === "futures" && trading.mode === "paper")
		return capability("unsupported", "Paper futures currently accept market orders only");
	const fromInfo = orderTypeFromMarketInfo(info, [orderType]);
	if (fromInfo !== undefined) return capability(fromInfo, "Reported by the exchange market metadata");
	if (trading.mode === "live" && family === "futures" && trading.tradingEngine.id === "binance")
		return capability(
			"supported",
			orderType.startsWith("take_profit")
				? "Binance USDⓈ-M adapter supports take-profit orders"
				: "Binance USDⓈ-M adapter supports stop orders",
		);
	if (trading.mode === "paper" && family === "spot")
		return capability(
			"supported",
			orderType.startsWith("take_profit")
				? "Paper spot adapter simulates take-profit orders"
				: "Paper spot adapter simulates stop orders",
		);
	return capability(
		"unknown",
		orderType.startsWith("take_profit")
			? "The adapter did not expose an explicit take-profit capability"
			: "The adapter did not expose an explicit stop-order capability",
	);
}

export function trailingCapability(
	trading: TradingRuntime,
	family: MarketFamily,
	info: MarketInfo | undefined,
	metadataValid = true,
): Capability {
	const unavailable = unavailableMarketCapability(family, metadataValid, info);
	if (unavailable) return unavailable;
	if (family === "mixed") return capability("unknown", "Specify a symbol to distinguish spot and futures support");
	if (family === "futures" && trading.mode === "paper")
		return capability("unsupported", "Paper futures currently accept market orders only");
	const fromInfo = orderTypeFromMarketInfo(info, ["trailing", "trailing_stop", "trailing_stop_market"]);
	if (fromInfo !== undefined) return capability(fromInfo, "Reported by the exchange market metadata");
	if (trading.mode === "paper" && family === "spot")
		return capability("supported", "Paper spot adapter simulates trailing stops");
	if (trading.mode === "live" && trading.tradingEngine.id === "binance")
		return capability("supported", "Binance adapter maps trailing stops to its native order parameters");
	return capability("unknown", "Trailing-stop support varies by exchange and market");
}
