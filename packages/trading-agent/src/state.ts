import { KEYS_PATH, readJsonFile, TRADING_CONFIG_PATH, TRADING_STATE_PATH, writeJsonFile } from "./config.ts";

export type TradingMode = "paper" | "live";
export type TradingLanguage = "zh-CN" | "en-US";
export type MarketType = "spot" | "usdm-futures" | "both";
export type FuturesMarginType = "isolated" | "cross";
export type FuturesPositionMode = "one-way" | "hedge";

export interface RiskLimits {
	/** Max notional (quote currency) per single order. */
	maxOrderNotional: number;
	/** Max cumulative notional (quote currency) per UTC day. */
	maxDailyNotional: number;
	/** Empty = all symbols allowed. Otherwise exact ccxt symbols, e.g. ["BTC/USDT"]. */
	allowedSymbols: string[];
}

export interface TradingConfig {
	/** Language used by Ti's trading TUI and prompt. */
	language: TradingLanguage;
	mode: TradingMode;
	/** Market family. USDⓈ-M futures are supported on Binance; "both" is Paper-only. */
	marketType: MarketType;
	/** Initial leverage for USDⓈ-M futures. */
	leverage: number;
	marginType: FuturesMarginType;
	positionMode: FuturesPositionMode;
	/** ccxt exchange id, e.g. "binance", "okx". */
	exchange: string;
	/** Quote currency used for valuation and risk limits. */
	quoteCurrency: string;
	/** When true, every live order requires interactive confirmation. */
	confirmLiveOrders: boolean;
	risk: RiskLimits;
	paper: {
		/** Initial quote balance of a fresh paper account. */
		startQuote: number;
		/** Taker/maker fee fraction applied to paper fills, e.g. 0.001 = 0.1%. */
		feeRate: number;
	};
	/** Background order-fill monitor (interactive sessions). */
	monitor: {
		enabled: boolean;
		/** Poll interval in seconds. */
		intervalSec: number;
		/** When true, a detected fill triggers an agent turn so it can react. */
		wakeAgent: boolean;
		/** Watch open positions: alert on missing stop-loss protection and on drawdown. */
		guardPositions: boolean;
		/** Wake the agent when a position's unrealized loss reaches this percentage. */
		alertLossPct: number;
		/** Minimum seconds between repeated guard alerts for the same position. */
		alertCooldownSec: number;
		/** Fraction of a position that a stop order must cover to count as protected. */
		protectionCoveragePct: number;
	};
}

export const DEFAULT_CONFIG: TradingConfig = {
	language: "zh-CN",
	mode: "paper",
	marketType: "spot",
	leverage: 1,
	marginType: "isolated",
	positionMode: "one-way",
	// okx: broadly accessible (binance geo-blocks some regions with HTTP 451).
	exchange: "okx",
	quoteCurrency: "USDT",
	confirmLiveOrders: true,
	risk: {
		maxOrderNotional: 500,
		maxDailyNotional: 2000,
		allowedSymbols: [],
	},
	paper: {
		startQuote: 10000,
		feeRate: 0.001,
	},
	monitor: {
		enabled: true,
		intervalSec: 30,
		wakeAgent: true,
		guardPositions: true,
		alertLossPct: 5,
		alertCooldownSec: 900,
		protectionCoveragePct: 95,
	},
};

export function loadTradingConfig(): TradingConfig {
	const stored = readJsonFile<Partial<TradingConfig>>(TRADING_CONFIG_PATH) ?? {};
	const config: TradingConfig = {
		...DEFAULT_CONFIG,
		...stored,
		risk: { ...DEFAULT_CONFIG.risk, ...stored.risk },
		paper: { ...DEFAULT_CONFIG.paper, ...stored.paper },
		monitor: { ...DEFAULT_CONFIG.monitor, ...stored.monitor },
	};
	validateTradingConfig(config);
	return config;
}

export function validateTradingConfig(config: TradingConfig): void {
	if (config.language !== "zh-CN" && config.language !== "en-US")
		throw new Error(`Invalid language: ${String(config.language)}`);
	if (config.mode !== "paper" && config.mode !== "live")
		throw new Error(`Invalid trading mode: ${String(config.mode)}`);
	if (!(["spot", "usdm-futures", "both"] as const).includes(config.marketType))
		throw new Error("marketType must be spot, usdm-futures, or both");
	if ((config.marketType === "usdm-futures" || config.marketType === "both") && config.exchange !== "binance")
		throw new Error("usdm-futures is supported only on Binance");
	if (!Number.isInteger(config.leverage) || config.leverage < 1 || config.leverage > 125)
		throw new Error("leverage must be an integer from 1 to 125");
	if (!(["isolated", "cross"] as const).includes(config.marginType))
		throw new Error("marginType must be isolated or cross");
	if (!(["one-way", "hedge"] as const).includes(config.positionMode))
		throw new Error("positionMode must be one-way or hedge");
	if (typeof config.exchange !== "string" || config.exchange.trim() === "")
		throw new Error("exchange must be a non-empty string");
	if (typeof config.quoteCurrency !== "string" || !/^[A-Z0-9_-]+$/.test(config.quoteCurrency)) {
		throw new Error("quoteCurrency must contain only uppercase letters, numbers, '_' or '-'");
	}
	const { maxOrderNotional, maxDailyNotional, allowedSymbols } = config.risk;
	if (!Number.isFinite(maxOrderNotional) || maxOrderNotional <= 0)
		throw new Error("risk.maxOrderNotional must be positive");
	if (!Number.isFinite(maxDailyNotional) || maxDailyNotional < maxOrderNotional) {
		throw new Error("risk.maxDailyNotional must be at least maxOrderNotional");
	}
	if (
		!Array.isArray(allowedSymbols) ||
		allowedSymbols.some(
			(symbol) =>
				typeof symbol !== "string" ||
				!symbol.endsWith(
					config.marketType === "usdm-futures"
						? `/${config.quoteCurrency}:${config.quoteCurrency}`
						: `/${config.quoteCurrency}`,
				),
		)
	) {
		throw new Error(`risk.allowedSymbols must contain ${config.quoteCurrency} symbols`);
	}
	if (!Number.isFinite(config.paper.startQuote) || config.paper.startQuote <= 0)
		throw new Error("paper.startQuote must be positive");
	if (!Number.isFinite(config.paper.feeRate) || config.paper.feeRate < 0 || config.paper.feeRate >= 1)
		throw new Error("paper.feeRate must be in [0, 1)");
	if (typeof config.monitor.enabled !== "boolean") throw new Error("monitor.enabled must be a boolean");
	if (!Number.isFinite(config.monitor.intervalSec) || config.monitor.intervalSec < 5)
		throw new Error("monitor.intervalSec must be at least 5 seconds");
	if (typeof config.monitor.wakeAgent !== "boolean") throw new Error("monitor.wakeAgent must be a boolean");
	if (typeof config.monitor.guardPositions !== "boolean") throw new Error("monitor.guardPositions must be a boolean");
	if (!Number.isFinite(config.monitor.alertLossPct) || config.monitor.alertLossPct <= 0)
		throw new Error("monitor.alertLossPct must be a positive percentage");
	if (!Number.isFinite(config.monitor.alertCooldownSec) || config.monitor.alertCooldownSec < 60)
		throw new Error("monitor.alertCooldownSec must be at least 60 seconds");
	if (
		!Number.isFinite(config.monitor.protectionCoveragePct) ||
		config.monitor.protectionCoveragePct <= 0 ||
		config.monitor.protectionCoveragePct > 100
	)
		throw new Error("monitor.protectionCoveragePct must be in (0, 100]");
}

export function saveTradingConfig(config: TradingConfig): void {
	validateTradingConfig(config);
	writeJsonFile(TRADING_CONFIG_PATH, config);
}

export interface ExchangeCredentials {
	apiKey: string;
	secret: string;
	password?: string;
}

export function loadExchangeKeys(): Record<string, ExchangeCredentials> {
	const keys = readJsonFile<unknown>(KEYS_PATH) ?? {};
	if (typeof keys !== "object" || keys === null || Array.isArray(keys))
		throw new Error(`Invalid exchange keys in ${KEYS_PATH}`);
	for (const [exchange, credentials] of Object.entries(keys)) {
		if (typeof credentials !== "object" || credentials === null)
			throw new Error(`Invalid credentials for ${exchange}`);
		const candidate = credentials as Record<string, unknown>;
		if (
			typeof candidate.apiKey !== "string" ||
			candidate.apiKey.trim() === "" ||
			typeof candidate.secret !== "string" ||
			candidate.secret.trim() === ""
		) {
			throw new Error(`Credentials for ${exchange} must include non-empty apiKey and secret`);
		}
		if (candidate.password !== undefined && typeof candidate.password !== "string")
			throw new Error(`Invalid password for ${exchange}`);
	}
	return keys as Record<string, ExchangeCredentials>;
}

export function saveExchangeKeys(keys: Record<string, ExchangeCredentials>): void {
	for (const [exchange, credentials] of Object.entries(keys)) {
		if (!credentials.apiKey.trim() || !credentials.secret.trim())
			throw new Error(`Credentials for ${exchange} must include apiKey and secret`);
	}
	writeJsonFile(KEYS_PATH, keys, 0o600);
}

/** Mutable daily counters, persisted so restarts do not reset risk accounting. */
export interface TradingState {
	/** UTC date (YYYY-MM-DD) the counters belong to. */
	date: string;
	usedDailyNotional: number;
}

/**
 * Load the persisted risk counter as-is. Date rollover handling is the
 * runtime's responsibility: live mode resets daily, paper mode accumulates
 * until manually reset (/risk reset or /paper reset).
 */
export function loadTradingState(): TradingState {
	const today = new Date().toISOString().slice(0, 10);
	const stored = readJsonFile<unknown>(TRADING_STATE_PATH);
	if (stored === undefined) return { date: today, usedDailyNotional: 0 };
	if (!isTradingState(stored)) {
		throw new Error(
			`Invalid trading risk state in ${TRADING_STATE_PATH}; refusing to start with an untrusted daily counter`,
		);
	}
	return stored;
}

export function saveTradingState(state: TradingState): void {
	if (!isTradingState(state)) throw new Error("Cannot persist invalid trading risk state");
	writeJsonFile(TRADING_STATE_PATH, state);
}

function isTradingState(value: unknown): value is TradingState {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.date === "string" &&
		/^\d{4}-\d{2}-\d{2}$/.test(candidate.date) &&
		typeof candidate.usedDailyNotional === "number" &&
		Number.isFinite(candidate.usedDailyNotional) &&
		candidate.usedDailyNotional >= 0
	);
}
