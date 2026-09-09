import {
	type ExchangeCredentials,
	type ExecutionJournalState,
	type FuturesMarginType,
	type FuturesPositionMode,
	isRiskNewExposurePause,
	isTradingAuditState,
	type MarketType,
	type RiskLimits,
	type RiskNewExposurePause,
	type TradingAuditState,
	type TradingMode,
	validateExecutionRiskState,
	validateTradingSymbol,
	withFileLockSync,
} from "@nikopack/ti-trading-engine";
import { KEYS_PATH, readJsonFile, TRADING_CONFIG_PATH, TRADING_STATE_PATH, writeJsonFile } from "./config.ts";
import { syncTradingStateFile } from "./state-durability.ts";

export type { ExchangeCredentials, FuturesMarginType, FuturesPositionMode, MarketType, RiskLimits, TradingMode };

export type TradingLanguage = "zh-CN" | "en-US";

export const ORDER_APPROVAL_MODES = ["confirm", "unattended"] as const;
export type OrderApprovalMode = (typeof ORDER_APPROVAL_MODES)[number];

export function isOrderApprovalMode(value: unknown): value is OrderApprovalMode {
	return value === "confirm" || value === "unattended";
}

export function liveOrdersRequireConfirmation(mode: TradingMode, orderApproval: OrderApprovalMode): boolean {
	return mode === "live" && orderApproval === "confirm";
}

type StoredTradingConfig = Partial<TradingConfig> & { confirmLiveOrders?: unknown };

export function defaultOrderApproval(mode: TradingMode): OrderApprovalMode {
	return mode === "live" ? "confirm" : "unattended";
}

export function resolveOrderApproval(
	stored: {
		orderApproval?: unknown;
		confirmLiveOrders?: unknown;
	},
	mode: TradingMode = "paper",
): OrderApprovalMode {
	if (stored.orderApproval !== undefined) {
		if (stored.orderApproval === "every-order") return "confirm";
		if (stored.orderApproval === "none") return "unattended";
		if (!isOrderApprovalMode(stored.orderApproval)) throw new Error("orderApproval must be confirm or unattended");
		return stored.orderApproval;
	}
	if (stored.confirmLiveOrders !== undefined) {
		if (typeof stored.confirmLiveOrders !== "boolean") throw new Error("confirmLiveOrders must be a boolean");
		return stored.confirmLiveOrders ? "confirm" : "unattended";
	}
	return defaultOrderApproval(mode);
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
	/** Live submission approval. `unattended` skips per-order confirmation. */
	orderApproval: OrderApprovalMode;
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
	orderApproval: "unattended",
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

export function normalizeTradingConfig(config: TradingConfig): TradingConfig {
	const next: TradingConfig = {
		...config,
		risk: { ...config.risk, allowedSymbols: [...config.risk.allowedSymbols] },
		paper: { ...config.paper },
		monitor: { ...config.monitor },
	};

	const previousMarketType = next.marketType;
	if (next.exchange !== "binance" && (next.marketType === "usdm-futures" || next.marketType === "both")) {
		next.marketType = "spot";
	}
	if (next.mode !== "paper" && next.marketType === "both") {
		next.marketType = "spot";
	}
	if (next.marketType === previousMarketType) return next;

	const original = next.risk.allowedSymbols;
	const aligned = alignAllowedSymbolsToSpot(next.quoteCurrency, original);
	if (original.length > 0 && aligned.length === 0) {
		throw new Error(
			`marketType was coerced to ${next.marketType}; risk.allowedSymbols has no ${next.quoteCurrency} symbols compatible with that family (${original.join(", ")})`,
		);
	}
	next.risk.allowedSymbols = aligned;
	return next;
}

function alignAllowedSymbolsToSpot(quoteCurrency: string, symbols: string[]): string[] {
	const futuresSuffix = `/${quoteCurrency}:${quoteCurrency}`;
	const settlementSuffix = `:${quoteCurrency}`;
	const spotSuffix = `/${quoteCurrency}`;
	const seen = new Set<string>();
	const aligned: string[] = [];
	for (const symbol of symbols) {
		const next = symbol.endsWith(futuresSuffix) ? symbol.slice(0, -settlementSuffix.length) : symbol;
		if (!next.endsWith(spotSuffix) || next.endsWith(futuresSuffix) || seen.has(next)) continue;
		seen.add(next);
		aligned.push(next);
	}
	return aligned;
}

export function loadTradingConfig(modeOverride?: TradingMode): TradingConfig {
	const stored = readJsonFile<StoredTradingConfig>(TRADING_CONFIG_PATH) ?? {};
	const rest: Partial<TradingConfig> = { ...stored };
	delete (rest as { confirmLiveOrders?: unknown }).confirmLiveOrders;
	const storedMode = stored.mode === "paper" || stored.mode === "live" ? stored.mode : DEFAULT_CONFIG.mode;
	const mode = modeOverride ?? storedMode;
	const orderApproval =
		modeOverride !== undefined && modeOverride !== storedMode
			? defaultOrderApproval(modeOverride)
			: resolveOrderApproval(stored, mode);
	const config: TradingConfig = {
		...DEFAULT_CONFIG,
		...rest,
		mode,
		orderApproval,
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
	if (!isOrderApprovalMode(config.orderApproval)) throw new Error("orderApproval must be confirm or unattended");
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
				validateTradingSymbol(symbol, config.marketType, config.quoteCurrency) !== null,
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
	withFileLockSync(
		`${TRADING_CONFIG_PATH}.lock`,
		() => {
			writeJsonFile(TRADING_CONFIG_PATH, config);
			syncTradingStateFile(TRADING_CONFIG_PATH);
		},
		{
			staleMs: Number.POSITIVE_INFINITY,
			timeoutMessage: (path) => `Timed out waiting for trading configuration lock ${path}`,
		},
	);
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
	withFileLockSync(`${KEYS_PATH}.lock`, () => writeJsonFile(KEYS_PATH, keys, 0o600), {
		timeoutMessage: (path) => `Timed out waiting for exchange keys lock ${path}`,
	});
}

export interface RiskReservationRecord {
	id: string;
	mode: TradingMode;
	symbol: string;
	notional: number;
	executionId?: string;
}

export interface RiskUsageState {
	/** UTC date (YYYY-MM-DD) the counters belong to. */
	date: string;
	usedDailyNotional: number;
	/** Notional reserved by submissions that have not been settled yet. */
	reservedDailyNotional?: number;
	/** In-flight claims keyed by reservation id. Must round-trip with the risk ledger. */
	reservations?: Record<string, RiskReservationRecord>;
	/** Shared by every same-mode runtime using this state file. */
	newExposurePause?: RiskNewExposurePause;
	executionBlocks?: Record<string, true>;
}

/** Paper and live counters are isolated so mode switches cannot transfer quota. */
export interface TradingState {
	paper: RiskUsageState;
	live: RiskUsageState;
	executions?: ExecutionJournalState;
	audit?: TradingAuditState;
}

export type TradingStateMutator<T> = (state: TradingState) => T;

/**
 * Serialize a read/modify/write of the persisted risk state across Ti
 * processes. The lock is deliberately scoped to the state file; configuration
 * and paper-ledger writes have independent lifecycles and must not block risk
 * accounting. A failed mutator or write leaves the previously loaded draft
 * unpublished.
 */
export function transactTradingState<T>(mutator: TradingStateMutator<T>): T {
	const lockPath = `${TRADING_STATE_PATH}.lock`;
	return withStateLock(lockPath, () => {
		// Decode directly while holding the lock. `loadTradingState()` also writes
		// legacy migrations, which would publish a partial update before the
		// caller's mutator has succeeded.
		const draft = structuredClone(decodeTradingState(readJsonFile<unknown>(TRADING_STATE_PATH)).state);
		const result = mutator(draft);
		saveTradingState(draft);
		return result;
	});
}

/** Run one state-file operation while owning the lock for its complete read/write lifecycle. */
function withStateLock<T>(lockPath: string, operation: () => T): T {
	return withFileLockSync(lockPath, operation, {
		// A suspended writer is not dead. Abandoned locks require verified operator removal, never a TTL takeover.
		staleMs: Number.POSITIVE_INFINITY,
		timeoutMessage: (path) => `Timed out waiting for trading state lock ${path}`,
	});
}

/**
 * Load the persisted risk counter as-is. Date rollover handling is the
 * runtime's responsibility: live mode resets daily, paper mode accumulates
 * until manually reset (/risk reset or /paper reset).
 */
export function loadTradingState(): TradingState {
	// Migration is a read/modify/write operation too. Re-read under the lock so
	// a concurrent risk transaction cannot be overwritten by a stale legacy copy.
	return withStateLock(`${TRADING_STATE_PATH}.lock`, () => {
		const decoded = decodeTradingState(readJsonFile<unknown>(TRADING_STATE_PATH));
		if (decoded.migrated) {
			// Legacy releases shared one counter. Preserve it in both modes during
			// migration so an upgrade cannot silently restore trading capacity.
			saveTradingState(decoded.state);
		}
		return decoded.state;
	});
}

function decodeTradingState(stored: unknown): { state: TradingState; migrated: boolean } {
	if (stored === undefined) {
		const today = new Date().toISOString().slice(0, 10);
		return {
			state: {
				paper: { date: today, usedDailyNotional: 0 },
				live: { date: today, usedDailyNotional: 0 },
			},
			migrated: false,
		};
	}
	if (isRiskUsageState(stored)) {
		return {
			state: { paper: { ...stored }, live: { ...stored } },
			migrated: true,
		};
	}
	if (!isTradingState(stored)) {
		throw new Error(
			`Invalid trading risk state in ${TRADING_STATE_PATH}; refusing to start with an untrusted daily counter`,
		);
	}
	return { state: structuredClone(stored), migrated: false };
}

export function saveTradingState(state: TradingState): void {
	if (!isTradingState(state)) throw new Error("Cannot persist invalid trading risk state");
	writeJsonFile(TRADING_STATE_PATH, state);
	syncTradingStateFile(TRADING_STATE_PATH);
}

function isTradingState(value: unknown): value is TradingState {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	if (
		!isRiskUsageState(candidate.paper) ||
		!isRiskUsageState(candidate.live) ||
		(candidate.audit !== undefined && !isTradingAuditState(candidate.audit))
	)
		return false;
	try {
		validateExecutionRiskState(value as TradingState);
	} catch {
		return false;
	}
	return true;
}

function isRiskUsageState(value: unknown): value is RiskUsageState {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.date === "string" &&
		/^\d{4}-\d{2}-\d{2}$/.test(candidate.date) &&
		typeof candidate.usedDailyNotional === "number" &&
		Number.isFinite(candidate.usedDailyNotional) &&
		candidate.usedDailyNotional >= 0 &&
		(candidate.reservedDailyNotional === undefined ||
			(typeof candidate.reservedDailyNotional === "number" &&
				Number.isFinite(candidate.reservedDailyNotional) &&
				candidate.reservedDailyNotional >= 0)) &&
		isReservationMap(candidate.reservations) &&
		(candidate.executionBlocks === undefined ||
			(typeof candidate.executionBlocks === "object" &&
				candidate.executionBlocks !== null &&
				!Array.isArray(candidate.executionBlocks) &&
				Object.entries(candidate.executionBlocks).every(
					([id, blocked]) => /^[A-Za-z0-9_-]{1,80}$/.test(id) && blocked === true,
				))) &&
		(candidate.newExposurePause === undefined || isRiskNewExposurePause(candidate.newExposurePause))
	);
}

function isReservationMap(value: unknown): boolean {
	if (value === undefined) return true;
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	for (const [id, reservation] of Object.entries(value)) {
		if (typeof reservation !== "object" || reservation === null || Array.isArray(reservation)) return false;
		const candidate = reservation as Record<string, unknown>;
		if (
			candidate.id !== id ||
			(candidate.mode !== "paper" && candidate.mode !== "live") ||
			typeof candidate.symbol !== "string" ||
			candidate.symbol.trim() === "" ||
			typeof candidate.notional !== "number" ||
			!Number.isFinite(candidate.notional) ||
			candidate.notional <= 0 ||
			(candidate.executionId !== undefined &&
				(typeof candidate.executionId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(candidate.executionId)))
		) {
			return false;
		}
	}
	return true;
}
