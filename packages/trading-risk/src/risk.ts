import { randomUUID } from "node:crypto";

export type MarketType = "spot" | "usdm-futures" | "both";

export type TradingMode = "paper" | "live";

export interface RiskLimits {
	maxOrderNotional: number;
	maxDailyNotional: number;
	allowedSymbols: string[];
}

export interface RiskConfig {
	mode: TradingMode;
	marketType: MarketType;
	quoteCurrency: string;
	risk: RiskLimits;
}

/** Durable metadata for one in-flight, quota-counting order submission. */
export interface RiskReservationState {
	id: string;
	mode: TradingMode;
	symbol: string;
	notional: number;
	executionId?: string;
}

export interface TradingAuditEvent {
	id: string;
	at: string;
	kind: "risk-pause" | "risk-resume" | "risk-reset" | "risk-reconcile" | "config-change" | "execution";
	mode: TradingMode;
	executionId?: string;
	action?: string;
	evidenceReference?: string;
	settlement?: { outcome: "commit" | "release"; notional: number };
}

export interface TradingAuditState {
	version: 1;
	events: TradingAuditEvent[];
}

export const AUDIT_HISTORY_LIMIT = 500;

export function isTradingAuditState(value: unknown): value is TradingAuditState {
	return (
		isRecord(value) &&
		value.version === 1 &&
		Array.isArray(value.events) &&
		value.events.length <= AUDIT_HISTORY_LIMIT &&
		value.events.every(
			(event) =>
				isRecord(event) &&
				typeof event.id === "string" &&
				/^[a-zA-Z0-9_-]{1,80}$/.test(event.id) &&
				typeof event.at === "string" &&
				Number.isFinite(Date.parse(event.at)) &&
				new Date(event.at).toISOString() === event.at &&
				["risk-pause", "risk-resume", "risk-reset", "risk-reconcile", "config-change", "execution"].includes(
					String(event.kind),
				) &&
				(event.mode === "paper" || event.mode === "live") &&
				(event.executionId === undefined ||
					(typeof event.executionId === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(event.executionId))) &&
				(event.action === undefined || (typeof event.action === "string" && /^[a-z-]{1,80}$/.test(event.action))) &&
				(event.evidenceReference === undefined ||
					(typeof event.evidenceReference === "string" &&
						/^[a-zA-Z0-9_-]{1,80}$/.test(event.evidenceReference))) &&
				(event.settlement === undefined ||
					(isRecord(event.settlement) &&
						(event.settlement.outcome === "commit" || event.settlement.outcome === "release") &&
						typeof event.settlement.notional === "number" &&
						Number.isFinite(event.settlement.notional) &&
						event.settlement.notional >= 0 &&
						(event.settlement.outcome !== "release" || event.settlement.notional === 0) &&
						Object.keys(event.settlement).every((key) => key === "outcome" || key === "notional"))) &&
				Object.keys(event).every((key) =>
					["id", "at", "kind", "mode", "executionId", "action", "evidenceReference", "settlement"].includes(key),
				),
		)
	);
}

export function appendTradingAuditEvent(
	state: TradingRiskState,
	event: Omit<TradingAuditEvent, "id" | "at">,
	at = new Date().toISOString(),
): void {
	if (state.audit !== undefined && !isTradingAuditState(state.audit)) throw stateError("Invalid audit history");
	const audit: TradingAuditState = {
		version: 1,
		events: [...(state.audit?.events ?? []), { ...event, id: randomUUID(), at }].slice(-AUDIT_HISTORY_LIMIT),
	};
	if (!isTradingAuditState(audit)) throw stateError("Invalid audit event");
	state.audit = audit;
}

export interface RiskNewExposurePause {
	id: string;
	reason: string;
	pausedAt: string;
}

export interface RiskUsageState {
	date: string;
	usedDailyNotional: number;
	/** Notional claimed by reservations that have not been settled yet. */
	reservedDailyNotional?: number;
	/** Claims are keyed by their stable reservation id. */
	reservations?: Record<string, RiskReservationState>;
	newExposurePause?: RiskNewExposurePause;
	/** Execution journal records, including exits, that must be reconciled before new entries. */
	executionBlocks?: Record<string, true>;
}

export interface TradingRiskState {
	paper: RiskUsageState;
	live: RiskUsageState;
	audit?: TradingAuditState;
}

export type RiskStateMutator<T> = (state: TradingRiskState) => T;

export interface RiskStateStore {
	load(): TradingRiskState;
	save(state: TradingRiskState): void;
	/**
	 * Mutate the latest state and commit the mutation atomically. RiskLedger
	 * requires this operation at runtime; a load/clone/save fallback cannot
	 * serialize concurrent writers safely.
	 */
	transact?<T>(mutator: RiskStateMutator<T>): T;
}

export interface RiskClock {
	now(): Date;
}

export interface RiskReservation {
	readonly id: string;
	/** Commit the observed filled notional when the exchange returned one. */
	commit(committedNotional?: number): void;
	release(): void;
}

export interface RiskReconciliationInfo {
	reservationId: string;
	mode: TradingMode;
	symbol: string;
	notional: number;
	action: "verify-exchange-order-and-settle-risk";
	reason: string;
}

/**
 * Indicates that a durable reservation could not be settled after an exchange
 * submission. Callers must verify the exchange and reconcile the risk state
 * before retrying; the claim may still be retained or may have disappeared.
 */
export class RiskCommitError extends Error {
	readonly submissionStatus = "unknown" as const;
	readonly retryable = false as const;
	readonly errorCategory = "RISK_SETTLEMENT_PERSISTENCE" as const;
	readonly reconciliation: RiskReconciliationInfo;
	readonly cause: unknown;

	constructor(reconciliation: RiskReconciliationInfo, cause: unknown) {
		super(
			`Risk accounting failed after exchange submission ` +
				`[errorCategory=RISK_SETTLEMENT_PERSISTENCE] reservationId=${reconciliation.reservationId}. ` +
				`Do not retry; verify the exchange order and reconcile risk for ${reconciliation.symbol}. ` +
				`${cause instanceof Error ? cause.message : String(cause)}`,
		);
		this.name = "RiskCommitError";
		this.reconciliation = reconciliation;
		this.cause = cause;
	}
}

/**
 * Indicates that the durable risk-state store could not complete an atomic
 * transaction. Callers must treat this as a persistence failure, not as a
 * rejected order: the exchange submission may already have happened and the
 * reservation must be reconciled before retrying.
 */
export class RiskStatePersistenceError extends Error {
	readonly errorCategory = "RISK_STATE_PERSISTENCE" as const;
	readonly cause: unknown;

	constructor(cause: unknown) {
		super(
			`Risk state persistence failed [errorCategory=RISK_STATE_PERSISTENCE]: ${
				cause instanceof Error ? cause.message : String(cause)
			}`,
		);
		this.name = "RiskStatePersistenceError";
		this.cause = cause;
	}
}

/** Internal marker used to keep caller/mutator failures distinct from store failures. */
class RiskMutationAbort extends Error {
	readonly cause: unknown;

	constructor(cause: unknown) {
		super("Risk mutation aborted");
		this.name = "RiskMutationAbort";
		this.cause = cause;
	}
}

/** A persisted reservation is missing or violates a risk-state invariant. */
export class RiskReservationStateError extends Error {
	readonly reservationId: string;
	readonly errorCategory = "RISK_RESERVATION_STATE" as const;

	constructor(reservationId: string, message: string) {
		super(`Risk reservation state error [reservationId=${reservationId}]: ${message}`);
		this.name = "RiskReservationStateError";
		this.reservationId = reservationId;
	}
}

const systemClock: RiskClock = { now: () => new Date() };
const STATE_ERROR_ID = "<state>";
const EPSILON_MULTIPLIER = 8;
const MARKET_TYPES: readonly MarketType[] = ["spot", "usdm-futures", "both"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isRiskNewExposurePause(value: unknown): value is RiskNewExposurePause {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		value.id.trim() !== "" &&
		typeof value.reason === "string" &&
		value.reason.trim() !== "" &&
		value.reason.length <= 500 &&
		typeof value.pausedAt === "string" &&
		Number.isFinite(Date.parse(value.pausedAt)) &&
		new Date(value.pausedAt).toISOString() === value.pausedAt
	);
}

function cloneReservation(reservation: RiskReservationState): RiskReservationState {
	return { ...reservation };
}

function cloneReservations(
	reservations: Record<string, RiskReservationState> | undefined,
): Record<string, RiskReservationState> | undefined {
	if (reservations === undefined) return undefined;
	return Object.fromEntries(
		Object.entries(reservations).map(([id, reservation]) => [id, cloneReservation(reservation)]),
	);
}

function cloneUsage(usage: RiskUsageState): RiskUsageState {
	return {
		...usage,
		reservations: cloneReservations(usage.reservations),
		...(usage.executionBlocks === undefined ? {} : { executionBlocks: { ...usage.executionBlocks } }),
		...(usage.newExposurePause === undefined ? {} : { newExposurePause: { ...usage.newExposurePause } }),
	};
}

function cloneState(state: TradingRiskState): TradingRiskState {
	return {
		paper: cloneUsage(state.paper),
		live: cloneUsage(state.live),
		...(state.audit === undefined ? {} : { audit: structuredClone(state.audit) }),
	};
}

function stateError(message: string, reservationId = STATE_ERROR_ID): RiskReservationStateError {
	return new RiskReservationStateError(reservationId, message);
}

function finiteNonNegative(value: unknown, label: string, reservationId = STATE_ERROR_ID): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw stateError(`${label} must be a finite non-negative number`, reservationId);
	}
	return value;
}

function finitePositive(value: unknown, label: string, reservationId = STATE_ERROR_ID): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw stateError(`${label} must be a finite positive number`, reservationId);
	}
	return value;
}

function addition(current: number, delta: number, label: string, reservationId = STATE_ERROR_ID): number {
	finiteNonNegative(current, label, reservationId);
	finiteNonNegative(delta, label, reservationId);
	const result = current + delta;
	if (!Number.isFinite(result) || result < 0) {
		throw stateError(`${label} overflowed its finite range`, reservationId);
	}
	return result;
}

function epsilon(current: number, delta: number): number {
	return Number.EPSILON * EPSILON_MULTIPLIER * Math.max(1, Math.abs(current), Math.abs(delta));
}

function subtraction(current: number, delta: number, label: string, reservationId: string): number {
	finiteNonNegative(current, label, reservationId);
	finitePositive(delta, label, reservationId);
	const result = current - delta;
	if (result < 0) {
		if (Math.abs(result) <= epsilon(current, delta)) return 0;
		throw stateError(`${label} is below the reservation notional`, reservationId);
	}
	return result <= epsilon(current, delta) ? 0 : result;
}

function approximatelyEqual(left: number, right: number): boolean {
	return Math.abs(left - right) <= epsilon(left, right);
}

function validateReservationState(reservation: unknown, key: string, mode: TradingMode): RiskReservationState {
	if (!isRecord(reservation)) throw stateError(`reservation ${key} must be an object`, key);
	if (typeof reservation.id !== "string" || reservation.id.length === 0 || reservation.id !== key) {
		throw stateError(`reservation key and id must match`, key);
	}
	if (reservation.mode !== mode) throw stateError(`reservation mode must be ${mode}`, key);
	if (typeof reservation.symbol !== "string" || reservation.symbol.trim() === "") {
		throw stateError(`reservation symbol must be a non-empty string`, key);
	}
	const notional = finitePositive(reservation.notional, "reservation notional", key);
	if (
		reservation.executionId !== undefined &&
		(typeof reservation.executionId !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(reservation.executionId))
	) {
		throw stateError("Invalid execution correlation", key);
	}
	return {
		id: reservation.id,
		mode,
		symbol: reservation.symbol,
		notional,
		...(reservation.executionId === undefined ? {} : { executionId: reservation.executionId }),
	};
}

function normalizedUsage(usage: unknown, mode: TradingMode): RiskUsageState {
	if (!isRecord(usage)) throw stateError(`Invalid ${mode} risk usage state`);
	if (typeof usage.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(usage.date)) {
		throw stateError(`Invalid ${mode} risk usage date`);
	}
	let newExposurePause: RiskNewExposurePause | undefined;
	if (usage.newExposurePause !== undefined) {
		const pause = usage.newExposurePause;
		if (!isRiskNewExposurePause(pause)) {
			throw stateError(
				`${mode}.newExposurePause must contain an id, a 1 to 500 character reason and an ISO UTC timestamp`,
			);
		}
		newExposurePause = { id: pause.id, reason: pause.reason, pausedAt: pause.pausedAt };
	}
	const used = finiteNonNegative(usage.usedDailyNotional, `${mode}.usedDailyNotional`);
	if (
		usage.executionBlocks !== undefined &&
		(!isRecord(usage.executionBlocks) ||
			Object.entries(usage.executionBlocks).some(
				([id, blocked]) => !/^[a-zA-Z0-9_-]{1,80}$/.test(id) || blocked !== true,
			))
	) {
		throw stateError("Invalid execution entry blocks");
	}
	const reserved =
		usage.reservedDailyNotional === undefined
			? 0
			: finiteNonNegative(usage.reservedDailyNotional, `${mode}.reservedDailyNotional`);
	const rawReservations = usage.reservations;
	const reservations: Record<string, RiskReservationState> = {};
	if (rawReservations !== undefined) {
		if (!isRecord(rawReservations)) throw stateError(`${mode}.reservations must be an object`);
		for (const [key, value] of Object.entries(rawReservations)) {
			reservations[key] = validateReservationState(value, key, mode);
		}
	}
	let sum = 0;
	for (const reservation of Object.values(reservations)) {
		sum = addition(sum, reservation.notional, `${mode}.reservations total`, reservation.id);
	}
	// A state written by an older release may omit `reservations`, but it can
	// only be migrated safely when its aggregate is zero. A positive aggregate
	// without identities cannot be reconciled and must fail closed.
	if (rawReservations === undefined && reserved !== 0) {
		throw stateError(
			`${mode}.reservedDailyNotional is positive but reservation identities are missing; manual reconciliation is required`,
		);
	}
	if (!approximatelyEqual(sum, reserved)) {
		const firstId = Object.keys(reservations)[0] ?? STATE_ERROR_ID;
		throw stateError(`${mode}.reservedDailyNotional does not equal the sum of persisted reservations`, firstId);
	}
	return {
		date: usage.date,
		usedDailyNotional: used,
		reservedDailyNotional: sum,
		reservations,
		...(newExposurePause === undefined ? {} : { newExposurePause }),
		...(usage.executionBlocks === undefined
			? {}
			: { executionBlocks: { ...(usage.executionBlocks as Record<string, true>) } }),
	};
}

function normalizedState(state: unknown): TradingRiskState {
	if (!isRecord(state)) throw stateError("Invalid trading risk state");
	if (state.audit !== undefined && !isTradingAuditState(state.audit)) throw stateError("Invalid audit history");
	return {
		paper: normalizedUsage(state.paper, "paper"),
		live: normalizedUsage(state.live, "live"),
		...(state.audit === undefined ? {} : { audit: structuredClone(state.audit as TradingAuditState) }),
	};
}

function copyStateInto(target: TradingRiskState, source: TradingRiskState): void {
	target.paper = cloneUsage(source.paper);
	target.live = cloneUsage(source.live);
	if (source.audit !== undefined) target.audit = structuredClone(source.audit);
}

export function validateTradingSymbol(symbol: string, marketType: MarketType, quoteCurrency: string): string | null {
	if (typeof symbol !== "string") return "Order symbol must be a string";
	const parts = symbol.split("/");
	const valid =
		parts.length === 2 &&
		parts[0].length > 0 &&
		(marketType === "both"
			? parts[1] === quoteCurrency || parts[1] === `${quoteCurrency}:${quoteCurrency}`
			: parts[1] === (marketType === "usdm-futures" ? `${quoteCurrency}:${quoteCurrency}` : quoteCurrency));
	if (valid) return null;
	return `Symbol ${symbol} must use ${marketType === "both" ? `spot /${quoteCurrency} or futures /${quoteCurrency}:${quoteCurrency}` : marketType === "usdm-futures" ? `futures quote ${quoteCurrency} (for example BTC/${quoteCurrency}:${quoteCurrency})` : `quote currency ${quoteCurrency}`}`;
}

function validateConfig(config: RiskConfig): RiskConfig {
	if (!isRecord(config)) throw new Error("Invalid risk config");
	if (config.mode !== "paper" && config.mode !== "live") throw new Error("mode must be paper or live");
	if (!MARKET_TYPES.includes(config.marketType)) {
		throw new Error("marketType must be spot, usdm-futures, or both");
	}
	if (typeof config.quoteCurrency !== "string" || !/^[A-Z0-9_-]+$/.test(config.quoteCurrency)) {
		throw new Error("quoteCurrency must contain only uppercase letters, numbers, '_' or '-'");
	}
	if (!isRecord(config.risk)) throw new Error("risk must be an object");
	const maxOrderNotional = config.risk.maxOrderNotional;
	const maxDailyNotional = config.risk.maxDailyNotional;
	if (typeof maxOrderNotional !== "number" || !Number.isFinite(maxOrderNotional) || maxOrderNotional <= 0) {
		throw new Error("risk.maxOrderNotional must be positive and finite");
	}
	if (typeof maxDailyNotional !== "number" || !Number.isFinite(maxDailyNotional) || maxDailyNotional <= 0) {
		throw new Error("risk.maxDailyNotional must be positive and finite");
	}
	if (maxDailyNotional < maxOrderNotional) {
		throw new Error("risk.maxDailyNotional must be at least maxOrderNotional");
	}
	if (
		!Array.isArray(config.risk.allowedSymbols) ||
		config.risk.allowedSymbols.some((symbol) => typeof symbol !== "string")
	) {
		throw new Error("risk.allowedSymbols must be an array of strings");
	}
	if (
		config.risk.allowedSymbols.some(
			(symbol) => validateTradingSymbol(symbol, config.marketType, config.quoteCurrency) !== null,
		)
	) {
		throw new Error(`risk.allowedSymbols must contain ${config.quoteCurrency} symbols`);
	}
	return {
		mode: config.mode,
		marketType: config.marketType,
		quoteCurrency: config.quoteCurrency,
		risk: { ...config.risk, allowedSymbols: [...config.risk.allowedSymbols] },
	};
}

function validateRecordNotional(notional: number): void {
	if (!Number.isFinite(notional) || notional < 0) {
		throw new Error("Recorded notional must be a non-negative finite number");
	}
}

function dailyNotionalExceededMessage(
	usage: RiskUsageState,
	mode: TradingMode,
	quoteCurrency: string,
	maxDailyNotional: number,
): string {
	const reserved = usage.reservedDailyNotional ?? 0;
	const pending = reserved > 0 ? ` plus ${reserved.toFixed(2)} reserved by in-flight orders` : "";
	return (
		`Order would exceed maxDailyNotional ${maxDailyNotional} ${quoteCurrency} ` +
		(mode === "paper"
			? `(already used ${usage.usedDailyNotional.toFixed(2)} cumulatively${pending}; paper quota only resets via reset())`
			: `(already used ${usage.usedDailyNotional.toFixed(2)} today${pending})`)
	);
}

/** Risk quota and in-flight reservation accounting, independent of UI and persistence format. */
export class RiskLedger {
	private config: RiskConfig;
	private state: TradingRiskState;
	private readonly clock: RiskClock;
	private readonly store: RiskStateStore;

	constructor(config: RiskConfig, store: RiskStateStore, clock: RiskClock = systemClock) {
		this.config = validateConfig(config);
		if (typeof store.transact !== "function") {
			throw new Error("RiskStateStore must implement transact() for atomic risk accounting");
		}
		this.store = store;
		this.state = normalizedState(store.load());
		this.clock = clock;
	}

	setConfig(config: RiskConfig): void {
		const next = validateConfig(config);
		if (
			next.mode !== this.config.mode ||
			next.marketType !== this.config.marketType ||
			next.quoteCurrency !== this.config.quoteCurrency
		) {
			throw new Error("Risk ledger identity cannot change; create a new ledger");
		}
		this.config = next;
	}

	pauseNewExposure(reason: string): RiskNewExposurePause {
		if (typeof reason !== "string" || reason.trim() === "" || reason.trim().length > 500) {
			throw new Error("New exposure pause reason must contain 1 to 500 characters");
		}
		return this.transact((state) => {
			const now = this.clock.now();
			if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
				throw new Error("Risk clock returned an invalid date");
			}
			const pause = { id: randomUUID(), reason: reason.trim(), pausedAt: now.toISOString() };
			state[this.config.mode].newExposurePause = pause;
			appendTradingAuditEvent(state, { kind: "risk-pause", mode: this.config.mode }, now.toISOString());
			return { ...pause };
		});
	}

	resumeNewExposure(pauseId: string): void {
		if (typeof pauseId !== "string" || pauseId.trim() === "") {
			throw new Error("New exposure pause id must be a non-empty string");
		}
		this.transact((state) => {
			const usage = state[this.config.mode];
			const pause = usage.newExposurePause;
			if (pause === undefined) throw new Error("New exposure is not paused");
			if (pause.id !== pauseId) throw new Error("New exposure pause id does not match the current pause");
			if (Object.keys(usage.executionBlocks ?? {}).length > 0)
				throw new Error("Cannot resume with unresolved executions; use /recovery");
			if (Object.keys(usage.reservations ?? {}).length > 0 || (usage.reservedDailyNotional ?? 0) > 0) {
				throw new Error("Cannot resume new exposure while reservations are in flight; reconcile them first");
			}
			delete usage.newExposurePause;
			appendTradingAuditEvent(state, { kind: "risk-resume", mode: this.config.mode });
		});
	}

	assertNewExposureAllowed(exceptExecutionId?: string): void {
		const state = this.loadLatest();
		const usage = state[this.config.mode];
		if (
			[state.paper, state.live].some((entry) =>
				Object.keys(entry.executionBlocks ?? {}).some((id) => id !== exceptExecutionId),
			)
		)
			throw new Error("New exposure is blocked by unresolved executions; use /recovery");
		const pause = usage.newExposurePause;
		if (pause !== undefined) throw new Error(`New exposure is paused: ${pause.reason}`);
	}

	check(symbol: string, notional: number, options: { countTowardsDailyLimit?: boolean } = {}): string | null {
		const count = options.countTowardsDailyLimit ?? true;
		const inputError = this.validateOrder(symbol, notional);
		if (inputError) return inputError;
		if (!count) return null;

		const { mode, risk, quoteCurrency } = this.config;
		this.refresh(mode);
		const state = this.loadLatest();
		const usage = state[mode];
		if ([state.paper, state.live].some((entry) => Object.keys(entry.executionBlocks ?? {}).length > 0))
			return "New exposure is blocked by unresolved executions; use /recovery";
		if (usage.newExposurePause !== undefined) return `New exposure is paused: ${usage.newExposurePause.reason}`;
		const total = addition(
			addition(usage.usedDailyNotional, usage.reservedDailyNotional ?? 0, "risk daily usage"),
			notional,
			"risk daily usage",
		);
		if (total > risk.maxDailyNotional) {
			return dailyNotionalExceededMessage(usage, mode, quoteCurrency, risk.maxDailyNotional);
		}
		return null;
	}

	reserve(
		symbol: string,
		notional: number,
		options: { countTowardsDailyLimit?: boolean; executionId?: string } = {},
	): RiskReservation {
		const count = options.countTowardsDailyLimit ?? true;
		const inputError = this.validateOrder(symbol, notional);
		if (inputError) throw new Error(`Risk limit: ${inputError}`);
		const { mode, risk, quoteCurrency } = this.config;
		const id = randomUUID();

		if (count) {
			this.transact((state) => {
				this.refreshDraft(state, mode);
				const usage = state[mode];
				if ([state.paper, state.live].some((entry) => Object.keys(entry.executionBlocks ?? {}).length > 0))
					throw new Error("New exposure is blocked by unresolved executions; use /recovery");
				if (usage.newExposurePause !== undefined) {
					throw new Error(`Risk limit: New exposure is paused: ${usage.newExposurePause.reason}`);
				}
				const reserved = usage.reservedDailyNotional ?? 0;
				const total = addition(
					addition(usage.usedDailyNotional, reserved, "risk daily usage"),
					notional,
					"risk daily usage",
				);
				if (total > risk.maxDailyNotional) {
					throw new Error(
						`Risk limit: ${dailyNotionalExceededMessage(usage, mode, quoteCurrency, risk.maxDailyNotional)}`,
					);
				}
				const reservations = usage.reservations ?? {};
				if (Object.hasOwn(reservations, id)) {
					throw stateError("generated reservation id already exists", id);
				}
				reservations[id] = {
					id,
					mode,
					symbol,
					notional,
					...(options.executionId ? { executionId: options.executionId } : {}),
				};
				usage.reservations = reservations;
				usage.reservedDailyNotional = addition(reserved, notional, "reserved daily notional", id);
			});
		}

		return this.createReservation(id, mode, symbol, notional, count);
	}

	/** Settle or release an existing durable claim by id, without trusting caller-supplied notional. */
	reconcileReservation(
		id: string,
		outcome: "commit" | "release",
		committedNotional?: number,
		executionId?: string,
	): void {
		if (typeof id !== "string" || id.length === 0) throw stateError("reservation id must be a non-empty string", id);
		if (outcome !== "commit" && outcome !== "release") throw stateError("invalid reconciliation outcome", id);
		this.transact((state) => {
			this.refreshDraft(state, "live");
			let found: { mode: TradingMode; claim: RiskReservationState } | undefined;
			for (const mode of ["paper", "live"] as const) {
				const claim = state[mode].reservations?.[id];
				if (claim !== undefined) {
					if (found !== undefined) throw stateError("reservation id appears in both modes", id);
					found = { mode, claim };
				}
			}
			if (found === undefined) throw stateError("reservation does not exist or has already been settled", id);
			if (found.claim.executionId !== executionId)
				throw stateError("Execution-linked reservations must be settled atomically through /recovery", id);
			const usage = state[found.mode];
			const reservations = usage.reservations;
			if (reservations === undefined || reservations[id] === undefined)
				throw stateError("reservation disappeared", id);
			usage.reservedDailyNotional = subtraction(
				usage.reservedDailyNotional ?? 0,
				found.claim.notional,
				"reserved daily notional",
				id,
			);
			if (outcome === "commit") {
				const settledNotional = committedNotional ?? found.claim.notional;
				validateRecordNotional(settledNotional);
				usage.usedDailyNotional = addition(usage.usedDailyNotional, settledNotional, "used daily notional", id);
			}
			delete reservations[id];
			appendTradingAuditEvent(state, { kind: "risk-reconcile", mode: found.mode, action: outcome, executionId });
		});
	}

	/** Return copies of every unresolved durable claim. */
	listPendingReservations(): RiskReservationState[] {
		this.refresh("live");
		const state = this.loadLatest();
		return (
			[
				...Object.values(state.paper.reservations ?? {}),
				...Object.values(state.live.reservations ?? {}),
			] as RiskReservationState[]
		)
			.map(cloneReservation)
			.sort((left, right) => left.id.localeCompare(right.id));
	}

	record(notional: number, options: { countTowardsDailyLimit?: boolean } = {}): void {
		validateRecordNotional(notional);
		if (options.countTowardsDailyLimit === false) return;
		const mode = this.config.mode;
		this.transact((state) => {
			this.refreshDraft(state, mode);
			state[mode].usedDailyNotional = addition(state[mode].usedDailyNotional, notional, "used daily notional");
		});
	}

	reset(): void {
		const mode = this.config.mode;
		this.transact((state) => {
			this.refreshDraft(state, mode);
			const usage = state[mode];
			if (Object.keys(usage.executionBlocks ?? {}).length > 0)
				throw new Error("Cannot reset with unresolved executions; use /recovery");
			if (Object.keys(usage.reservations ?? {}).length > 0 || (usage.reservedDailyNotional ?? 0) > 0) {
				throw new Error("Cannot reset risk usage while reservations are in flight");
			}
			state[mode] = {
				...usage,
				date: this.today(),
				usedDailyNotional: 0,
				reservedDailyNotional: 0,
				reservations: {},
			};
			appendTradingAuditEvent(state, { kind: "risk-reset", mode });
		});
	}

	usage(): {
		date: string;
		used: number;
		reserved: number;
		limit: number;
		resetPolicy: "daily-auto" | "manual";
		newExposurePause?: RiskNewExposurePause;
	} {
		const mode = this.config.mode;
		this.refresh(mode);
		const usage = this.loadLatest()[mode];
		return {
			date: usage.date,
			used: usage.usedDailyNotional,
			reserved: usage.reservedDailyNotional ?? 0,
			limit: this.config.risk.maxDailyNotional,
			resetPolicy: mode === "paper" ? "manual" : "daily-auto",
			newExposurePause: usage.newExposurePause === undefined ? undefined : { ...usage.newExposurePause },
		};
	}

	private validateOrder(symbol: string, notional: number): string | null {
		const { risk, quoteCurrency, marketType } = this.config;
		const symbolError = validateTradingSymbol(symbol, marketType, quoteCurrency);
		if (symbolError) return symbolError;
		if (!Number.isFinite(notional) || notional <= 0) return "Order notional must be a positive finite number";
		if (risk.allowedSymbols.length > 0 && !risk.allowedSymbols.includes(symbol)) {
			return `Symbol ${symbol} is not in risk.allowedSymbols (${risk.allowedSymbols.join(", ")})`;
		}
		if (notional > risk.maxOrderNotional) {
			return `Order notional ${notional.toFixed(2)} ${quoteCurrency} exceeds maxOrderNotional ${risk.maxOrderNotional}`;
		}
		return null;
	}

	private createReservation(
		id: string,
		mode: TradingMode,
		symbol: string,
		notional: number,
		count: boolean,
	): RiskReservation {
		let finalized = false;
		return {
			id,
			commit: (committedNotional?: number) => {
				if (finalized) return;
				if (!count) {
					finalized = true;
					return;
				}
				try {
					this.reconcileReservation(id, "commit", committedNotional);
				} catch (error) {
					throw new RiskCommitError(
						{
							reservationId: id,
							mode,
							symbol,
							notional,
							action: "verify-exchange-order-and-settle-risk",
							reason: "Risk-state persistence failed after exchange submission",
						},
						error,
					);
				}
				finalized = true;
			},
			release: () => {
				if (finalized) return;
				if (count) this.reconcileReservation(id, "release");
				finalized = true;
			},
		};
	}

	private loadLatest(): TradingRiskState {
		this.state = normalizedState(this.store.load());
		return cloneState(this.state);
	}

	private transact<T>(mutator: RiskStateMutator<T>): T {
		if (typeof this.store.transact !== "function") {
			throw new Error("RiskStateStore must implement transact() for atomic risk accounting");
		}
		let next: TradingRiskState | undefined;
		const apply = (raw: TradingRiskState): T => {
			const draft = normalizedState(raw);
			let result: T;
			try {
				result = mutator(draft);
			} catch (error) {
				throw new RiskMutationAbort(error);
			}
			const normalized = normalizedState(draft);
			copyStateInto(raw, normalized);
			next = normalized;
			return result;
		};
		let result: T;
		try {
			result = this.store.transact(apply);
		} catch (error) {
			if (error instanceof RiskMutationAbort) throw error.cause;
			if (error instanceof RiskStatePersistenceError) throw error;
			// The store owns the transaction boundary. Any error that escapes the
			// callback is therefore a persistence/atomicity failure and must not be
			// mistaken for an order validation rejection.
			throw new RiskStatePersistenceError(error);
		}
		if (next === undefined) throw new Error("Risk state transaction did not produce a state");
		this.state = cloneState(next);
		return result;
	}

	private refresh(mode: TradingMode): void {
		if (mode !== "live") return;
		const today = this.today();
		const current = this.loadLatest().live;
		if (current.date === today) return;
		this.transact((state) => this.refreshDraft(state, mode));
	}

	private refreshDraft(state: TradingRiskState, mode: TradingMode): void {
		if (mode !== "live") return;
		const today = this.today();
		const current = state.live;
		if (current.date === today) return;
		// Carry in-flight claims into the new day until exchange settlement.
		state.live = {
			...current,
			date: today,
			usedDailyNotional: 0,
			reservedDailyNotional: current.reservedDailyNotional ?? 0,
			reservations: current.reservations ?? {},
		};
	}

	private today(): string {
		const now = this.clock.now();
		if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error("Risk clock returned an invalid date");
		return now.toISOString().slice(0, 10);
	}
}
