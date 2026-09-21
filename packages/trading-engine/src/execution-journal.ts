import { createHash, randomUUID } from "node:crypto";
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
import { isOrderFeeObservation, type Order, type PlaceOcoOrderInput, type PlaceOrderInput } from "./types.ts";

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

export function accountRiskKey(scope: ExecutionScope): string {
	return createHash("sha256")
		.update(JSON.stringify([scope.mode, scope.exchange, scope.accountId, scope.marketType, scope.quoteCurrency]))
		.digest("hex");
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
			| "feeObservation"
			| "status"
			| "orderListId"
			| "listClientOrderId"
		> &
			Partial<
				Pick<
					Order,
					| "type"
					| "price"
					| "stopPrice"
					| "reduceOnly"
					| "positionSide"
					| "closePosition"
					| "trailingPercent"
					| "activationPrice"
					| "callbackRate"
				>
			>
	>;
	/** Operator evidence is a reference, never raw responses, free-form errors or credentials. */
	reference?: string;
	/** Terminal quote fee total. Legacy records may lack provenance; verify orders' feeObservation before use. */
	fee?: number;
}
export interface ExecutionReference {
	kind: string;
	id: string;
	version: number;
}
export interface ExecutionRecord {
	id: string;
	intentId?: string;
	reference?: ExecutionReference;
	archiveAcknowledgedRevision?: number;
	admissionGeneration?: number;
	scope: ExecutionScope;
	intent:
		| { kind: "order"; input: PlaceOrderInput; replacementIds?: string[] }
		| { kind: "oco"; input: PlaceOcoOrderInput };
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

/** Terminal observed quote-denominated trading fees only; legacy totals, funding and slippage are not evidence. */
export function observedExecutionFee(entry: Pick<ExecutionRecord, "scope" | "evidence">): number | undefined {
	const orders = entry.evidence?.orders;
	const source = entry.scope.mode === "paper" ? "paper-ledger" : "exchange";
	if (
		!orders?.length ||
		entry.evidence?.source === "operator" ||
		new Set(orders.map((order) => order.id)).size !== orders.length ||
		!orders.every(
			(order) =>
				["closed", "canceled", "rejected", "expired"].includes(order.status) &&
				isOrderFeeObservation(order.feeObservation) &&
				order.feeObservation.source === source &&
				order.feeObservation.completeness === "complete" &&
				order.feeObservation.charges.every((charge) => charge.currency === entry.scope.quoteCurrency),
		)
	)
		return undefined;
	const fee = orders.reduce(
		(sum, order) => sum + order.feeObservation!.charges.reduce((subtotal, charge) => subtotal + charge.cost, 0),
		0,
	);
	return Number.isFinite(fee) ? fee : undefined;
}

export interface ExecutionJournalState {
	version: 1;
	records: ExecutionRecord[];
	admissionGeneration?: number;
	maintenance?: ExecutionMaintenance;
	/** Stable intent tombstones survive bounded execution-detail retention. */
	intentKeys?: Record<string, { executionId: string; fingerprint: string }>;
	protections?: ProtectionTarget[];
}
export interface ProtectionTarget {
	id: string;
	scope: ExecutionScope;
	executionId: string;
	symbol: string;
	positionSide?: "BOTH" | "LONG" | "SHORT";
	side: "buy" | "sell";
	stopPrice: number;
	/** Each repair receives a new stable logical identity; unknown repairs never advance it. */
	generation: number;
	failures?: number;
	lastRepairIntentId?: string;
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
export const REFERENCED_EXECUTION_LIMIT = 1000;
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
function referenceValid(value: unknown): value is ExecutionReference {
	return (
		record(value) &&
		identifier(value.kind) &&
		identifier(value.id) &&
		Number.isSafeInteger(value.version) &&
		Number(value.version) > 0 &&
		keys(value, ["kind", "id", "version"])
	);
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
	if (!record(value) || !keys(value, ["kind", "input", "replacementIds"]) || !record(value.input)) return false;
	if (
		value.replacementIds !== undefined &&
		(value.kind !== "order" ||
			!Array.isArray(value.replacementIds) ||
			!value.replacementIds.length ||
			!value.replacementIds.every(identifier) ||
			new Set(value.replacementIds).size !== value.replacementIds.length)
	)
		return false;
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
		(value.fee === undefined || (typeof value.fee === "number" && Number.isFinite(value.fee))) &&
		keys(value, ["source", "observedAt", "orders", "reference", "fee"]) &&
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
				(order.feeObservation === undefined || isOrderFeeObservation(order.feeObservation)) &&
				(order.type === undefined || [...ORDER_TYPES, "oco", "unknown"].some((type) => type === order.type)) &&
				["price", "stopPrice", "trailingPercent", "activationPrice", "callbackRate"].every(
					(key) => order[key] === undefined || (nonnegative(order[key]) && order[key] > 0),
				) &&
				["reduceOnly", "closePosition"].every(
					(key) => order[key] === undefined || typeof order[key] === "boolean",
				) &&
				(order.positionSide === undefined || ["BOTH", "LONG", "SHORT"].includes(String(order.positionSide))) &&
				keys(order, [
					"id",
					"clientOrderId",
					"symbol",
					"side",
					"amount",
					"filled",
					"remaining",
					"cost",
					"feeObservation",
					"status",
					"orderListId",
					"listClientOrderId",
					"type",
					"price",
					"stopPrice",
					"reduceOnly",
					"positionSide",
					"closePosition",
					"trailingPercent",
					"activationPrice",
					"callbackRate",
				]),
		)
	);
}
export function isUnresolvedExecution(value: ExecutionRecord): boolean {
	return value.status === "prepared" || value.status === "submission-started" || value.status === "unknown";
}
function retainReference(value: ExecutionRecord): boolean {
	return (
		value.reference !== undefined &&
		(value.archiveAcknowledgedRevision !== value.revision ||
			value.evidence?.orders.some((order) => order.status === "open") === true)
	);
}

function trimExecutionHistory(journal: ExecutionJournalState): void {
	const closed = journal.records
		.filter((entry) => !isUnresolvedExecution(entry) && !retainReference(entry))
		.slice(-EXECUTION_HISTORY_LIMIT);
	const keep = new Set(closed.map((entry) => entry.id));
	journal.records = journal.records.filter(
		(entry) => isUnresolvedExecution(entry) || retainReference(entry) || keep.has(entry.id),
	);
}
export function isExecutionJournalState(value: unknown): value is ExecutionJournalState {
	if (
		!record(value) ||
		value.version !== 1 ||
		!keys(value, ["version", "records", "maintenance", "admissionGeneration", "intentKeys", "protections"]) ||
		(value.admissionGeneration !== undefined &&
			(!Number.isSafeInteger(value.admissionGeneration) || Number(value.admissionGeneration) < 0)) ||
		!Array.isArray(value.records)
	)
		return false;
	if (
		value.intentKeys !== undefined &&
		(!record(value.intentKeys) ||
			Object.entries(value.intentKeys).some(
				([key, entry]) =>
					!identifier(key) ||
					!record(entry) ||
					!identifier(entry.executionId) ||
					typeof entry.fingerprint !== "string" ||
					!/^[a-f0-9]{64}$/.test(entry.fingerprint),
			))
	)
		return false;
	if (
		value.protections !== undefined &&
		(!Array.isArray(value.protections) ||
			value.protections.some(
				(target) =>
					!record(target) ||
					!identifier(target.id) ||
					!identifier(target.executionId) ||
					!scopeValid(target.scope) ||
					typeof target.symbol !== "string" ||
					!nonnegative(target.stopPrice) ||
					target.stopPrice === 0 ||
					(target.side !== "buy" && target.side !== "sell") ||
					!Number.isSafeInteger(target.generation) ||
					Number(target.generation) < 0 ||
					(target.failures !== undefined &&
						(!Number.isSafeInteger(target.failures) || Number(target.failures) < 0)) ||
					(target.lastRepairIntentId !== undefined && !identifier(target.lastRepairIntentId)) ||
					(target.positionSide !== undefined && !["BOTH", "LONG", "SHORT"].includes(String(target.positionSide))),
			))
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
		value.records.length <= EXECUTION_HISTORY_LIMIT + UNRESOLVED_EXECUTION_LIMIT + REFERENCED_EXECUTION_LIMIT &&
		value.records.every((entry) => {
			if (!record(entry) || !identifier(entry.id) || ids.has(entry.id)) return false;
			ids.add(entry.id);
			return (
				scopeValid(entry.scope) &&
				(entry.intentId === undefined || identifier(entry.intentId)) &&
				(entry.reference === undefined || (referenceValid(entry.reference) && identifier(entry.intentId))) &&
				(entry.archiveAcknowledgedRevision === undefined ||
					(entry.reference !== undefined &&
						Number.isSafeInteger(entry.archiveAcknowledgedRevision) &&
						Number(entry.archiveAcknowledgedRevision) >= 0 &&
						Number(entry.archiveAcknowledgedRevision) <= Number(entry.revision))) &&
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
					"intentId",
					"reference",
					"archiveAcknowledgedRevision",
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
	if (
		pending > UNRESOLVED_EXECUTION_LIMIT ||
		records.filter((entry) => !isUnresolvedExecution(entry) && !retainReference(entry)).length >
			EXECUTION_HISTORY_LIMIT ||
		records.filter((entry) => !isUnresolvedExecution(entry) && retainReference(entry)).length >
			REFERENCED_EXECUTION_LIMIT
	)
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
		const feeOrders = entry.evidence?.orders ?? [];
		const expectedFeeSource = entry.scope.mode === "paper" ? "paper-ledger" : "exchange";
		if (
			feeOrders.some((order) => order.feeObservation && order.feeObservation.source !== expectedFeeSource) ||
			(entry.evidence?.fee !== undefined &&
				feeOrders.some((order) => order.feeObservation !== undefined) &&
				observedExecutionFee(entry) !== entry.evidence.fee)
		)
			throw new Error("Execution fee provenance or total invariant failed");
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
	prepare(
		intent: ExecutionRecord["intent"],
		notional: number,
		count: boolean,
		options: {
			intentId?: string;
			reference?: ExecutionReference;
			riskRevision?: number;
			protectionStopPrice?: number;
		} = {},
	): ExecutionRecord {
		return this.transact((state, risk) => {
			this.assertAdmission(state);
			const journal = state.executions ?? { version: 1, records: [], admissionGeneration: this.admissionGeneration };
			if (options.reference !== undefined && (!referenceValid(options.reference) || !identifier(options.intentId)))
				throw new Error("Referenced execution requires a valid reference and stable intent ID");
			if (
				options.reference &&
				journal.records.filter(
					(entry) => entry.reference && (isUnresolvedExecution(entry) || retainReference(entry)),
				).length >= REFERENCED_EXECUTION_LIMIT
			)
				throw new Error(
					"Referenced execution archive capacity reached; archive evidence before linking more orders",
				);
			const fingerprint = createHash("sha256")
				.update(JSON.stringify(options.reference ? { intent, reference: options.reference } : intent))
				.digest("hex");
			const intentKey = options.intentId === undefined ? undefined : this.intentKey(options.intentId);
			if (options.intentId !== undefined) {
				if (!identifier(options.intentId)) throw new Error("Invalid stable intent identity");
				const known = journal.intentKeys?.[intentKey!];
				if (known) {
					const prior = journal.records.find((entry) => entry.id === known.executionId);
					const released =
						known.fingerprint === fingerprint &&
						prior !== undefined &&
						!isUnresolvedExecution(prior) &&
						prior.settlement?.outcome === "release";
					if (!released) {
						throw new ExecutionRecoveryError(
							known.executionId,
							known.fingerprint === fingerprint
								? "intent already recorded"
								: "intent identity reused with different parameters",
						);
					}
				}
			}
			const accountRisk = state.accountRisk?.[accountRiskKey(this.scope)];
			if (accountRisk) {
				if (options.riskRevision !== accountRisk.revision)
					throw new Error("Account changed after risk preflight; collect fresh facts");
				if (count && (accountRisk.blockedReasons.length || accountRisk.memory?.lossTrip || accountRisk.mutation)) {
					throw new Error(`Account risk blocks new exposure: ${accountRisk.blockedReasons.join(", ")}`);
				}
				accountRisk.revision++;
			}
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
				...(options.intentId === undefined ? {} : { intentId: options.intentId }),
				...(options.reference === undefined ? {} : { reference: structuredClone(options.reference) }),
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
			if (options.protectionStopPrice !== undefined) {
				if (!count || !Number.isFinite(options.protectionStopPrice) || options.protectionStopPrice <= 0)
					throw new Error("Invalid opening protection target");
				journal.protections ??= [];
				journal.protections.push({
					id,
					executionId: id,
					scope: structuredClone(this.scope),
					symbol: intent.input.symbol,
					side: intent.input.side === "buy" ? "sell" : "buy",
					positionSide: intent.kind === "order" ? intent.input.positionSide : undefined,
					stopPrice: options.protectionStopPrice,
					generation: 0,
				});
			}
			if (intentKey) {
				journal.intentKeys ??= {};
				journal.intentKeys[intentKey] = { executionId: id, fingerprint };
			}
			state.executions = journal;
			state[this.scope.mode].executionBlocks = { ...state[this.scope.mode].executionBlocks, [id]: true };
			this.audit(state, entry);
			return entry;
		});
	}
	findIntent(intentId: string): string | undefined {
		return (this.store.load() as ExecutionRiskState).executions?.intentKeys?.[this.intentKey(intentId)]?.executionId;
	}
	acknowledgeExecutionArchive(id: string, revision: number): void {
		this.transact((state) => {
			const entry = this.find(state, id);
			if (!entry.reference || entry.revision !== revision)
				throw new Error("Execution archive revision changed; archive current evidence first");
			entry.archiveAcknowledgedRevision = revision;
			trimExecutionHistory(state.executions!);
		});
	}
	updateEvidence(id: string, revision: number, evidence: ExecutionEvidence): void {
		this.transact((state) => {
			const entry = this.find(state, id);
			if (entry.revision !== revision || isUnresolvedExecution(entry))
				throw new Error("Execution changed; use correlated recovery for unresolved records");
			// Poll receipt freshness belongs to consumer health, not a new immutable evidence revision.
			if (
				JSON.stringify(entry.evidence?.orders) === JSON.stringify(evidence.orders) &&
				entry.evidence?.fee === evidence.fee
			)
				return;
			entry.evidence = structuredClone(evidence);
			this.transition(state, entry, "reconciled");
		});
	}
	private intentKey(intentId: string): string {
		return createHash("sha256")
			.update(`${accountRiskKey(this.scope)}:${intentId}`)
			.digest("hex");
	}
	protectionTargets(): ProtectionTarget[] {
		return structuredClone((this.store.load() as ExecutionRiskState).executions?.protections ?? []).filter(
			(target) => accountRiskKey(target.scope) === accountRiskKey(this.scope),
		);
	}
	claimProtectionRepair(id: string): string {
		return this.transact((state) => {
			const target = state.executions?.protections?.find((target) => target.id === id);
			if (!target) throw new Error("Protection target missing");
			if (target.lastRepairIntentId) return target.lastRepairIntentId;
			target.lastRepairIntentId = createHash("sha256").update(`${id}:protection:${target.generation}`).digest("hex");
			return target.lastRepairIntentId;
		});
	}
	finishProtectionRepair(id: string, succeeded = false): void {
		this.transact((state) => {
			const target = state.executions?.protections?.find((target) => target.id === id);
			if (!target) throw new Error("Protection target missing");
			delete target.lastRepairIntentId;
			target.generation++;
			target.failures = succeeded ? 0 : (target.failures ?? 0) + 1;
		});
	}
	retireProtectionTarget(id: string): void {
		this.transact((state) => {
			if (
				!state.executions?.protections?.some(
					(target) => target.id === id && accountRiskKey(target.scope) === accountRiskKey(this.scope),
				)
			)
				throw new Error("Protection target missing");
			state.executions.protections = state.executions.protections.filter((target) => target.id !== id);
		});
	}
	begin(id: string, riskRevision?: number): ExecutionRecord {
		return this.transact((state, risk) => {
			this.assertAdmission(state);
			const entry = this.find(state, id);
			if (entry.status !== "prepared") throw new ExecutionRecoveryError(id, "stale preparation");
			if ((entry.admissionGeneration ?? 0) !== this.admissionGeneration)
				throw new Error("Execution admission generation changed; reinitialize this runtime");
			if (entry.reservationId) risk.assertNewExposureAllowed(id);
			const account = state.accountRisk?.[accountRiskKey(this.scope)];
			if (
				account &&
				(account.revision !== riskRevision ||
					(entry.reservationId &&
						(account.blockedReasons.length > 0 || account.memory?.lossTrip || account.mutation)))
			) {
				throw new Error("Final account risk admission changed; collect fresh facts");
			}
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
			if (outcome === "commit" && state.executions?.protections) {
				const target = state.executions.protections.find((target) => target.executionId === entry.id);
				if (target)
					state.executions.protections = state.executions.protections.filter(
						(candidate) =>
							candidate.id === target.id ||
							accountRiskKey(candidate.scope) !== accountRiskKey(target.scope) ||
							candidate.symbol !== target.symbol ||
							candidate.side !== target.side ||
							candidate.positionSide !== target.positionSide,
					);
				if (
					entry.intent.kind === "order" &&
					entry.intent.replacementIds &&
					entry.intent.input.type === "stop_market"
				) {
					for (const target of state.executions.protections) {
						if (
							accountRiskKey(target.scope) === accountRiskKey(entry.scope) &&
							target.symbol === entry.intent.input.symbol &&
							target.side === entry.intent.input.side
						) {
							target.stopPrice = entry.intent.input.stopPrice!;
							target.failures = 0;
						}
					}
				}
			}
			delete entry.issue;
			delete entry.nextAttemptAt;
			delete state[entry.scope.mode].executionBlocks?.[entry.id];
			this.transition(state, entry, status);
			const journal = state.executions;
			if (journal) {
				// Persist settlement order, including deterministic ties when clocks return the same timestamp.
				journal.records = [...journal.records.filter((item) => item.id !== entry.id), entry];
				trimExecutionHistory(journal);
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

export function executionClientIds(intentId?: string): {
	clientOrderId: string;
	listClientOrderId: string;
	aboveClientOrderId: string;
	belowClientOrderId: string;
} {
	const id = intentId
		? createHash("sha256").update(intentId).digest("hex").slice(0, 30)
		: randomUUID().replaceAll("-", "").slice(0, 30);
	return {
		clientOrderId: `ti${id}`,
		listClientOrderId: `tl${id}`,
		aboveClientOrderId: `ta${id}`,
		belowClientOrderId: `tb${id}`,
	};
}
