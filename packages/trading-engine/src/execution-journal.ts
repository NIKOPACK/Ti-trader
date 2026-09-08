import { randomUUID } from "node:crypto";
import {
	appendTradingAuditEvent,
	type RiskClock,
	type RiskConfig,
	RiskLedger,
	type RiskStateStore,
	type TradingAuditEvent,
	type TradingRiskState,
} from "@nikopack/ti-trading-risk";
import { ORDER_TYPES } from "./capabilities.ts";
import type { Order, PlaceOcoOrderInput, PlaceOrderInput } from "./types.ts";

export type ExecutionStatus =
	| "prepared"
	| "submission-started"
	| "acknowledged"
	| "definite-rejection"
	| "unknown"
	| "reconciled";
export type ExecutionIssue =
	| "submission-unknown"
	| "lookup-unavailable"
	| "lookup-unsupported"
	| "evidence-conflict"
	| "account-mismatch"
	| "attempts-exhausted";
export interface ExecutionScope {
	accountId: string;
	exchange: string;
	mode: "paper" | "live";
	marketType: "spot" | "usdm-futures" | "both";
	quoteCurrency: string;
	positionMode: "one-way" | "hedge";
}
export interface ExecutionEvidence {
	source: "submission" | "client-id-lookup" | "operator";
	observedAt: string;
	orders: Array<
		Pick<
			Order,
			| "id"
			| "clientOrderId"
			| "symbol"
			| "side"
			| "amount"
			| "filled"
			| "remaining"
			| "cost"
			| "status"
			| "orderListId"
			| "listClientOrderId"
		>
	>;
	/** Operator evidence is a reference, never raw responses, free-form errors or credentials. */
	reference?: string;
}
export interface ExecutionRecord {
	id: string;
	admissionGeneration?: number;
	scope: ExecutionScope;
	intent: { kind: "order"; input: PlaceOrderInput } | { kind: "oco"; input: PlaceOcoOrderInput };
	notional: number;
	reservationId?: string;
	status: ExecutionStatus;
	revision: number;
	createdAt: string;
	updatedAt: string;
	attempts: number;
	nextAttemptAt?: string;
	issue?: ExecutionIssue;
	evidence?: ExecutionEvidence;
	settlement?: { outcome: "commit" | "release"; notional: number };
}
export interface ExecutionJournalState {
	version: 1;
	records: ExecutionRecord[];
	admissionGeneration?: number;
	maintenance?: ExecutionMaintenance;
}
export interface ExecutionMaintenance {
	id: string;
	scope: ExecutionScope;
	action: "paper-reset" | "runtime-replacement";
	createdAt: string;
	nextGeneration: number;
}
export interface ExecutionRiskState extends TradingRiskState {
	executions?: ExecutionJournalState;
}
/** Durable callers capture admissionGeneration before loading configuration or constructing the client. */
export type ExecutionJournalOptions = {
	accountId: string;
} & ({ durability: "durable"; admissionGeneration: number } | { durability: "memory"; admissionGeneration?: number });
export const EXECUTION_HISTORY_LIMIT = 200;
export const UNRESOLVED_EXECUTION_LIMIT = 100;
export const MAX_RECOVERY_ATTEMPTS = 9;
const states: ExecutionStatus[] = [
	"prepared",
	"submission-started",
	"acknowledged",
	"definite-rejection",
	"unknown",
	"reconciled",
];
const issues: ExecutionIssue[] = [
	"submission-unknown",
	"lookup-unavailable",
	"lookup-unsupported",
	"evidence-conflict",
	"account-mismatch",
	"attempts-exhausted",
];
export class ExecutionRecoveryError extends Error {
	readonly submissionStatus = "unknown" as const;
	readonly retryable = false as const;
	readonly errorCategory = "EXECUTION_RECOVERY_REQUIRED" as const;
	readonly executionId: string;
	constructor(id: string, phase: string) {
		super(
			`Execution ${id}: ${phase}. Do not retry; inspect /recovery. New entries remain blocked until reconciliation.`,
		);
		this.name = "ExecutionRecoveryError";
		this.executionId = id;
	}
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function identifier(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value);
}
function iso(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function nonnegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function keys(value: Record<string, unknown>, allowed: string[]): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}
function scopeValid(value: unknown): value is ExecutionScope {
	return (
		record(value) &&
		identifier(value.accountId) &&
		identifier(value.exchange) &&
		(value.mode === "paper" || value.mode === "live") &&
		["spot", "usdm-futures", "both"].includes(String(value.marketType)) &&
		["one-way", "hedge"].includes(String(value.positionMode)) &&
		typeof value.quoteCurrency === "string" &&
		/^[A-Z0-9_-]+$/.test(value.quoteCurrency) &&
		keys(value, ["accountId", "exchange", "mode", "marketType", "quoteCurrency", "positionMode"])
	);
}
function intentValid(value: unknown): value is ExecutionRecord["intent"] {
	if (!record(value) || !keys(value, ["kind", "input"]) || !record(value.input)) return false;
	const input = value.input;
	if (
		typeof input.symbol !== "string" ||
		!/^[A-Z0-9_-]+\/[A-Z0-9_-]+(?::[A-Z0-9_-]+)?$/.test(input.symbol) ||
		(input.side !== "buy" && input.side !== "sell") ||
		!nonnegative(input.amount) ||
		input.amount === 0
	)
		return false;
	if (value.kind === "oco") {
		return (
			nonnegative(input.stopLossPrice) &&
			input.stopLossPrice > 0 &&
			nonnegative(input.takeProfitPrice) &&
			input.takeProfitPrice > 0 &&
			identifier(input.listClientOrderId) &&
			identifier(input.aboveClientOrderId) &&
			identifier(input.belowClientOrderId) &&
			new Set([input.listClientOrderId, input.aboveClientOrderId, input.belowClientOrderId]).size === 3 &&
			keys(input, [
				"symbol",
				"side",
				"amount",
				"stopLossPrice",
				"takeProfitPrice",
				"listClientOrderId",
				"aboveClientOrderId",
				"belowClientOrderId",
			])
		);
	}
	return (
		value.kind === "order" &&
		ORDER_TYPES.some((type) => type === input.type) &&
		identifier(input.clientOrderId) &&
		["price", "stopPrice", "trailingPercent"].every(
			(key) => input[key] === undefined || (nonnegative(input[key]) && input[key] > 0),
		) &&
		["reduceOnly", "closePosition"].every((key) => input[key] === undefined || typeof input[key] === "boolean") &&
		(input.positionSide === undefined || ["BOTH", "LONG", "SHORT"].includes(String(input.positionSide))) &&
		keys(input, [
			"symbol",
			"side",
			"amount",
			"type",
			"clientOrderId",
			"price",
			"stopPrice",
			"trailingPercent",
			"reduceOnly",
			"closePosition",
			"positionSide",
		])
	);
}
function evidenceValid(value: unknown): value is ExecutionEvidence {
	return (
		record(value) &&
		["submission", "client-id-lookup", "operator"].includes(String(value.source)) &&
		iso(value.observedAt) &&
		(value.reference === undefined || identifier(value.reference)) &&
		keys(value, ["source", "observedAt", "orders", "reference"]) &&
		Array.isArray(value.orders) &&
		value.orders.length <= 2 &&
		value.orders.every(
			(order) =>
				record(order) &&
				identifier(order.id) &&
				typeof order.symbol === "string" &&
				(order.side === "buy" || order.side === "sell") &&
				["amount", "filled", "remaining", "cost"].every((key) => nonnegative(order[key])) &&
				["open", "closed", "canceled", "rejected", "expired"].includes(String(order.status)) &&
				["clientOrderId", "orderListId", "listClientOrderId"].every(
					(key) => order[key] === undefined || identifier(order[key]),
				) &&
				keys(order, [
					"id",
					"clientOrderId",
					"symbol",
					"side",
					"amount",
					"filled",
					"remaining",
					"cost",
					"status",
					"orderListId",
					"listClientOrderId",
				]),
		)
	);
}
export function isUnresolvedExecution(value: ExecutionRecord): boolean {
	return value.status === "prepared" || value.status === "submission-started" || value.status === "unknown";
}
export function isExecutionJournalState(value: unknown): value is ExecutionJournalState {
	if (
		!record(value) ||
		value.version !== 1 ||
		!keys(value, ["version", "records", "maintenance", "admissionGeneration"]) ||
		(value.admissionGeneration !== undefined &&
			(!Number.isSafeInteger(value.admissionGeneration) || Number(value.admissionGeneration) < 0)) ||
		!Array.isArray(value.records)
	)
		return false;
	if (
		value.maintenance !== undefined &&
		(!record(value.maintenance) ||
			!identifier(value.maintenance.id) ||
			!scopeValid(value.maintenance.scope) ||
			!iso(value.maintenance.createdAt) ||
			!["paper-reset", "runtime-replacement"].includes(String(value.maintenance.action)) ||
			(value.maintenance.nextGeneration !== undefined &&
				(!Number.isSafeInteger(value.maintenance.nextGeneration) ||
					Number(value.maintenance.nextGeneration) < 1)) ||
			!keys(value.maintenance, ["id", "scope", "action", "createdAt", "nextGeneration"]))
	)
		return false;
	const ids = new Set<string>();
	return (
		value.records.length <= EXECUTION_HISTORY_LIMIT + UNRESOLVED_EXECUTION_LIMIT &&
		value.records.every((entry) => {
			if (!record(entry) || !identifier(entry.id) || ids.has(entry.id)) return false;
			ids.add(entry.id);
			return (
				scopeValid(entry.scope) &&
				(entry.admissionGeneration === undefined ||
					(Number.isSafeInteger(entry.admissionGeneration) && Number(entry.admissionGeneration) >= 0)) &&
				intentValid(entry.intent) &&
				nonnegative(entry.notional) &&
				entry.notional > 0 &&
				(entry.reservationId === undefined || identifier(entry.reservationId)) &&
				states.includes(entry.status as ExecutionStatus) &&
				Number.isSafeInteger(entry.revision) &&
				Number(entry.revision) >= 0 &&
				iso(entry.createdAt) &&
				iso(entry.updatedAt) &&
				entry.updatedAt >= entry.createdAt &&
				Number.isSafeInteger(entry.attempts) &&
				Number(entry.attempts) >= 0 &&
				Number(entry.attempts) <= MAX_RECOVERY_ATTEMPTS &&
				(entry.nextAttemptAt === undefined || iso(entry.nextAttemptAt)) &&
				(entry.issue === undefined || issues.includes(entry.issue as ExecutionIssue)) &&
				(entry.evidence === undefined || evidenceValid(entry.evidence)) &&
				(entry.settlement === undefined ||
					(record(entry.settlement) &&
						["commit", "release"].includes(String(entry.settlement.outcome)) &&
						nonnegative(entry.settlement.notional) &&
						keys(entry.settlement, ["outcome", "notional"]))) &&
				keys(entry, [
					"id",
					"admissionGeneration",
					"scope",
					"intent",
					"notional",
					"reservationId",
					"status",
					"revision",
					"createdAt",
					"updatedAt",
					"attempts",
					"nextAttemptAt",
					"issue",
					"evidence",
					"settlement",
				])
			);
		})
	);
}
export function validateExecutionRiskState(state: ExecutionRiskState): void {
	if (state.executions !== undefined && !isExecutionJournalState(state.executions))
		throw new Error("Invalid execution journal; refusing untrusted state");
	const records = state.executions?.records ?? [];
	if (
		state.executions?.maintenance?.nextGeneration !== undefined &&
		state.executions.maintenance.nextGeneration !== (state.executions.admissionGeneration ?? 0) + 1
	)
		throw new Error("Invalid maintenance admission generation");
	const pending = records.filter(isUnresolvedExecution).length;
	if (pending > UNRESOLVED_EXECUTION_LIMIT || records.length - pending > EXECUTION_HISTORY_LIMIT)
		throw new Error("Execution history exceeds its bounded retention limits");
	if (
		state.executions?.maintenance &&
		(pending > 0 ||
			[state.paper, state.live].some(
				(usage) => Object.keys(usage.reservations ?? {}).length > 0 || (usage.reservedDailyNotional ?? 0) > 0,
			))
	)
		throw new Error("Account maintenance conflicts with in-flight execution state");
	for (const mode of ["paper", "live"] as const) {
		for (const id of Object.keys(state[mode].executionBlocks ?? {})) {
			if (!records.some((entry) => entry.id === id && entry.scope.mode === mode && isUnresolvedExecution(entry)))
				throw new Error("Execution block has no unresolved journal record");
		}
		for (const claim of Object.values(state[mode].reservations ?? {})) {
			if (
				claim.executionId !== undefined &&
				!records.some(
					(entry) =>
						entry.id === claim.executionId &&
						entry.reservationId === claim.id &&
						entry.scope.mode === mode &&
						isUnresolvedExecution(entry),
				)
			)
				throw new Error("Risk claim has no correlated unresolved execution");
		}
	}
	for (const entry of records) {
		const unresolved = isUnresolvedExecution(entry);
		if (
			unresolved !== (state[entry.scope.mode].executionBlocks?.[entry.id] === true) ||
			unresolved === (entry.settlement !== undefined)
		)
			throw new Error("Execution settlement/block invariant failed");
		if (
			entry.intent.input.symbol.split("/")[1]?.split(":")[0] !== entry.scope.quoteCurrency ||
			(entry.scope.marketType === "spot" && entry.intent.input.symbol.includes(":")) ||
			(entry.scope.marketType === "usdm-futures" &&
				!entry.intent.input.symbol.endsWith(`:${entry.scope.quoteCurrency}`)) ||
			(entry.settlement?.outcome === "release" && entry.settlement.notional !== 0) ||
			(entry.status === "definite-rejection" && entry.settlement?.outcome !== "release") ||
			(entry.status === "acknowledged" && entry.evidence?.source !== "submission") ||
			(entry.status === "reconciled" &&
				entry.evidence === undefined &&
				(entry.settlement?.outcome !== "release" || entry.revision !== 1 || entry.attempts !== 0)) ||
			(entry.evidence?.source === "operator" && (!entry.evidence.reference || entry.evidence.orders.length !== 0)) ||
			(unresolved && entry.evidence !== undefined)
		)
			throw new Error("Execution scope/outcome invariant failed");
		if (entry.reservationId && unresolved) {
			const claim = state[entry.scope.mode].reservations?.[entry.reservationId];
			if (
				!claim ||
				claim.executionId !== entry.id ||
				claim.symbol !== entry.intent.input.symbol ||
				claim.notional !== entry.notional
			)
				throw new Error("Execution reservation correlation failed");
		}
	}
}

/** The supplied risk store is the ONLY commit boundary: never pair separate journal and quota writes. */
export class ExecutionJournal {
	private readonly store: RiskStateStore;
	private config: RiskConfig;
	private readonly clock: RiskClock;
	private readonly admissionGeneration: number;
	private readonly ownedMaintenance = new Set<string>();
	readonly scope: ExecutionScope;
	constructor(
		store: RiskStateStore,
		config: RiskConfig,
		scope: ExecutionScope,
		clock: RiskClock = { now: () => new Date() },
		admissionGeneration?: number,
	) {
		if (!scopeValid(scope) || typeof store.transact !== "function")
			throw new Error("Execution journal requires an atomic store and non-secret account identity");
		this.store = store;
		this.config = config;
		this.scope = structuredClone(scope);
		this.clock = clock;
		const state: ExecutionRiskState = store.load();
		validateExecutionRiskState(state);
		this.admissionGeneration = admissionGeneration ?? state.executions?.admissionGeneration ?? 0;
		if (!Number.isSafeInteger(this.admissionGeneration) || this.admissionGeneration < 0)
			throw new Error("A valid captured admission generation is required");
	}
	private transact<T>(operation: (state: ExecutionRiskState, risk: RiskLedger) => T): T {
		if (!this.store.transact) throw new Error("Atomic execution store unavailable");
		return this.store.transact((state: ExecutionRiskState) => {
			validateExecutionRiskState(state);
			const localStore: RiskStateStore = {
				load: () => state,
				save: () => {
					throw new Error("Nested save prohibited");
				},
				transact: (mutate) => mutate(state),
			};
			const result = operation(state, new RiskLedger(this.config, localStore, this.clock));
			validateExecutionRiskState(state);
			return structuredClone(result);
		});
	}
	list(): ExecutionRecord[] {
		const state: ExecutionRiskState = this.store.load();
		validateExecutionRiskState(state);
		return structuredClone(state.executions?.records ?? []);
	}
	getMaintenance(): ExecutionMaintenance | undefined {
		const state: ExecutionRiskState = this.store.load();
		validateExecutionRiskState(state);
		const maintenance = state.executions?.maintenance;
		return maintenance
			? structuredClone({
					...maintenance,
					nextGeneration: maintenance.nextGeneration ?? (state.executions?.admissionGeneration ?? 0) + 1,
				})
			: undefined;
	}
	getAdmissionStatus() {
		const state: ExecutionRiskState = this.store.load();
		validateExecutionRiskState(state);
		const currentGeneration = state.executions?.admissionGeneration ?? 0;
		return {
			generation: this.admissionGeneration,
			currentGeneration,
			stale: currentGeneration !== this.admissionGeneration,
		};
	}
	private assertAdmission(state: ExecutionRiskState): void {
		if (state.executions?.maintenance)
			throw new Error("Account maintenance blocks all submissions; inspect /recovery");
		if ((state.executions?.admissionGeneration ?? 0) !== this.admissionGeneration)
			throw new Error("Trading admission generation changed; reinitialize this runtime");
	}
	beginMaintenance(action: ExecutionMaintenance["action"]): ExecutionMaintenance {
		const maintenance = this.transact((state) => {
			if (state.executions?.maintenance) throw new Error("Account maintenance is already active; inspect /recovery");
			this.assertAdmission(state);
			const nextGeneration = this.admissionGeneration + 1;
			if (!Number.isSafeInteger(nextGeneration)) throw new Error("Trading admission generation exhausted");
			if (
				(state.executions?.records ?? []).some(isUnresolvedExecution) ||
				[state.paper, state.live].some(
					(usage) => Object.keys(usage.reservations ?? {}).length > 0 || (usage.reservedDailyNotional ?? 0) > 0,
				)
			)
				throw new Error("Cannot start account maintenance with unresolved executions or risk reservations");
			const maintenance: ExecutionMaintenance = {
				id: randomUUID(),
				scope: structuredClone(this.scope),
				action,
				createdAt: this.clock.now().toISOString(),
				nextGeneration,
			};
			state.executions ??= { version: 1, records: [], admissionGeneration: this.admissionGeneration };
			state.executions.maintenance = maintenance;
			appendTradingAuditEvent(state, { kind: "config-change", mode: this.scope.mode, action: `${action}-started` });
			return maintenance;
		});
		this.ownedMaintenance.add(maintenance.id);
		return maintenance;
	}
	/** Only the original owner may cancel a read-only inspection; no account/config mutation may have started. */
	cancelMaintenance(id: string): void {
		if (!this.ownedMaintenance.has(id)) throw new Error("Only the maintenance owner can cancel inspection");
		this.transact((state) => {
			const journal = state.executions;
			if (!journal?.maintenance || journal.maintenance.id !== id) throw new Error("Account maintenance changed");
			appendTradingAuditEvent(state, {
				kind: "config-change",
				mode: journal.maintenance.scope.mode,
				action: `${journal.maintenance.action}-cancelled`,
				executionId: id,
			});
			delete journal.maintenance;
		});
		this.ownedMaintenance.delete(id);
	}
	completeMaintenance(id: string, evidenceReference?: string): void {
		this.transact((state) => {
			const journal = state.executions;
			if (!journal?.maintenance || journal.maintenance.id !== id) throw new Error("Account maintenance changed");
			if (evidenceReference !== undefined && !identifier(evidenceReference))
				throw new Error("A safe verified evidence reference is required");
			if (
				!evidenceReference &&
				!this.ownedMaintenance.has(id) &&
				this.admissionGeneration !== (journal.maintenance.nextGeneration ?? (journal.admissionGeneration ?? 0) + 1)
			)
				throw new Error("Only the maintenance owner or its installed successor can complete maintenance");
			appendTradingAuditEvent(state, {
				kind: "config-change",
				mode: journal.maintenance.scope.mode,
				action: evidenceReference ? "maintenance-manually-released" : `${journal.maintenance.action}-completed`,
				executionId: id,
				...(evidenceReference ? { evidenceReference } : {}),
			});
			journal.admissionGeneration = journal.maintenance.nextGeneration ?? (journal.admissionGeneration ?? 0) + 1;
			delete journal.maintenance;
		});
		this.ownedMaintenance.delete(id);
	}
	setConfig(config: RiskConfig): void {
		this.config = config;
	}
	listAuditEvents(): TradingAuditEvent[] {
		return structuredClone(this.store.load().audit?.events ?? []);
	}
	recordConfigurationChange(action: string): void {
		this.transact((state) =>
			appendTradingAuditEvent(state, { kind: "config-change", mode: this.scope.mode, action }),
		);
	}
	prepare(intent: ExecutionRecord["intent"], notional: number, count: boolean): ExecutionRecord {
		return this.transact((state, risk) => {
			this.assertAdmission(state);
			const journal = state.executions ?? { version: 1, records: [], admissionGeneration: this.admissionGeneration };
			if (journal.records.filter(isUnresolvedExecution).length >= UNRESOLVED_EXECUTION_LIMIT)
				throw new Error("Unresolved execution limit reached; reconciliation required");
			const id = randomUUID();
			const now = this.clock.now().toISOString();
			const reservation = risk.reserve(intent.input.symbol, notional, {
				countTowardsDailyLimit: count,
				executionId: id,
			});
			const entry: ExecutionRecord = {
				id,
				admissionGeneration: this.admissionGeneration,
				scope: structuredClone(this.scope),
				intent: structuredClone(intent),
				notional,
				...(count ? { reservationId: reservation.id } : {}),
				status: "prepared",
				revision: 0,
				createdAt: now,
				updatedAt: now,
				attempts: 0,
			};
			journal.records.push(entry);
			state.executions = journal;
			state[this.scope.mode].executionBlocks = { ...state[this.scope.mode].executionBlocks, [id]: true };
			this.audit(state, entry);
			return entry;
		});
	}
	begin(id: string): ExecutionRecord {
		return this.transact((state, risk) => {
			this.assertAdmission(state);
			const entry = this.find(state, id);
			if (entry.status !== "prepared") throw new ExecutionRecoveryError(id, "stale preparation");
			if ((entry.admissionGeneration ?? 0) !== this.admissionGeneration)
				throw new Error("Execution admission generation changed; reinitialize this runtime");
			if (entry.reservationId) risk.assertNewExposureAllowed(id);
			this.transition(state, entry, "submission-started");
			return entry;
		});
	}
	unknown(id: string, issue: ExecutionIssue, revision?: number): void {
		this.transact((state) => {
			const entry = this.find(state, id);
			if (!isUnresolvedExecution(entry) || (revision !== undefined && entry.revision !== revision)) return;
			entry.issue = issue;
			this.transition(state, entry, "unknown");
		});
	}
	claimAttempt(id: string, nextAttemptAt: string): ExecutionRecord | undefined {
		return this.transact((state) => {
			const entry = this.find(state, id);
			if (!isUnresolvedExecution(entry) || entry.status === "prepared") return;
			if (entry.attempts >= MAX_RECOVERY_ATTEMPTS) {
				if (entry.issue !== "attempts-exhausted") {
					entry.issue = "attempts-exhausted";
					this.transition(state, entry, "unknown");
				}
				return;
			}
			if (entry.nextAttemptAt && entry.nextAttemptAt > this.clock.now().toISOString()) return;
			entry.attempts++;
			entry.nextAttemptAt = nextAttemptAt;
			entry.revision++;
			entry.updatedAt = this.clock.now().toISOString();
			return entry;
		});
	}
	settle(
		id: string,
		outcome: "commit" | "release",
		notional: number,
		status: "acknowledged" | "definite-rejection" | "reconciled",
		evidence?: ExecutionEvidence,
		revision?: number,
	): boolean {
		return this.transact((state, risk) => {
			const entry = this.find(state, id);
			if (!isUnresolvedExecution(entry)) return false;
			if (revision !== undefined && entry.revision !== revision) return false;
			if (status === "reconciled" && !evidence && entry.status !== "prepared")
				throw new Error("Started executions require correlated or verified operator evidence");
			if (entry.reservationId) risk.reconcileReservation(entry.reservationId, outcome, notional, entry.id);
			entry.settlement = { outcome, notional: outcome === "commit" ? notional : 0 };
			if (evidence) entry.evidence = structuredClone(evidence);
			delete entry.issue;
			delete entry.nextAttemptAt;
			delete state[entry.scope.mode].executionBlocks?.[entry.id];
			this.transition(state, entry, status);
			const journal = state.executions;
			if (journal) {
				// Persist settlement order, including deterministic ties when clocks return the same timestamp.
				journal.records = [...journal.records.filter((item) => item.id !== entry.id), entry];
				const closed = journal.records
					.filter((item) => !isUnresolvedExecution(item))
					.slice(-EXECUTION_HISTORY_LIMIT);
				const keep = new Set(closed.map((item) => item.id));
				journal.records = journal.records.filter((item) => isUnresolvedExecution(item) || keep.has(item.id));
			}
			return true;
		});
	}
	private find(state: ExecutionRiskState, id: string): ExecutionRecord {
		const entry = state.executions?.records.find((item) => item.id === id);
		if (!entry) throw new ExecutionRecoveryError(id, "record missing");
		return entry;
	}
	private transition(state: ExecutionRiskState, entry: ExecutionRecord, status: ExecutionStatus): void {
		entry.status = status;
		entry.revision++;
		entry.updatedAt = this.clock.now().toISOString();
		this.audit(state, entry);
	}
	private audit(state: ExecutionRiskState, entry: ExecutionRecord): void {
		appendTradingAuditEvent(
			state,
			{
				kind: "execution",
				mode: entry.scope.mode,
				executionId: entry.id,
				action: entry.status,
				...(entry.evidence?.source === "operator"
					? { evidenceReference: entry.evidence.reference, settlement: entry.settlement }
					: {}),
			},
			entry.updatedAt,
		);
	}
}

export function executionClientIds(): {
	clientOrderId: string;
	listClientOrderId: string;
	aboveClientOrderId: string;
	belowClientOrderId: string;
} {
	const id = randomUUID().replaceAll("-", "").slice(0, 30);
	return {
		clientOrderId: `ti${id}`,
		listClientOrderId: `tl${id}`,
		aboveClientOrderId: `ta${id}`,
		belowClientOrderId: `tb${id}`,
	};
}
