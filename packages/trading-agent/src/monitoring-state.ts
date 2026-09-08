import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { withFileLockSync } from "@earendil-works/ti-trading-engine";
import {
	type Condition,
	type RuntimeState,
	type TriggerDefinition,
	validateTriggerDefinition,
} from "@earendil-works/ti-triggers";
import { readJsonFile, TRADING_STATE_PATH, writeJsonFile } from "./config.ts";

export const MONITORING_MAX_AGE_MS = 5 * 60_000;
export const MONITORING_LEASE_MS = 30_000;
const MAX_NOTIFICATIONS = 256;
const RETENTION_MS = 7 * 24 * 60 * 60_000;

export interface MonitoringScope {
	mode: "paper" | "live";
	exchange: string;
	marketType: "spot" | "usdm-futures" | "both";
	quoteCurrency: string;
	/** Captured execution position mode, when supplied by the scope provider. */
	positionMode?: "one-way" | "hedge";
	/** Non-secret identity of the active account; never a credential. */
	accountId: string;
}

export interface StoredTrigger {
	definition: TriggerDefinition;
	revision: string;
	state: RuntimeState;
	updatedAt: number;
	lastDeliveryId?: string;
}

export interface MonitorObservation {
	lastPollAt?: number;
	lastObservationAt?: number;
	lastSuccessAt?: number;
	lastFailureAt?: number;
	lastDeliveryFailureAt?: number;
	/** Fixed local category only; authenticated error messages are not persisted. */
	errorCode?: "observation-failed" | "poll-failed" | "delivery-failed" | "notification-expired";
}

export interface MonitoredOrder {
	id: string;
	symbol: string;
}

export interface OrderMonitorState {
	seeded: boolean;
	cursor?: number;
	known: MonitoredOrder[];
	missing: Array<{ key: string; checks: number; warned: boolean; since: number }>;
	guards: Array<{ key: string; firstSeenAt?: number; lastAlertAt?: number }>;
}

export interface MonitoringNotification {
	id: string;
	source: "triggers" | "orders";
	customType: "trigger" | "order-fill" | "position-alert";
	content: string;
	notices: string[];
	level: "info" | "warning";
	wake: boolean;
	triggerRevision?: string;
	createdAt: number;
	expiresAt: number;
	status: "pending" | "delivering" | "delivered" | "expired" | "cancelled";
	attempts: number;
	nextAttemptAt: number;
	leaseId?: string;
	leaseUntil?: number;
	finishedAt?: number;
}

export interface MonitoringScopeState {
	scope: MonitoringScope;
	updatedAt: number;
	triggers: StoredTrigger[];
	facts: Array<{ key: string; value: number; observedAt: number }>;
	orders: OrderMonitorState;
	health: { triggers: MonitorObservation; orders: MonitorObservation };
	notifications: MonitoringNotification[];
}

export interface MonitoringState {
	version: 1;
	scopes: MonitoringScopeState[];
}

/** Transactions must be synchronous and operate on the latest locked snapshot. */
export interface MonitoringStore {
	read(): MonitoringState;
	transact<T>(operation: (state: MonitoringState) => T): T;
}

export function monitoringScopeForRuntime(runtime: object): MonitoringScope {
	if ("getExecutionScope" in runtime && typeof runtime.getExecutionScope === "function") {
		const captured = object(runtime.getExecutionScope(), [
			"accountId",
			"exchange",
			"mode",
			"marketType",
			"quoteCurrency",
			"positionMode",
		]);
		oneOf(captured.positionMode, ["one-way", "hedge"]);
		const scope = {
			accountId: captured.accountId,
			exchange: captured.exchange,
			mode: captured.mode,
			marketType: captured.marketType,
			quoteCurrency: captured.quoteCurrency,
			positionMode: captured.positionMode,
		};
		validateMonitoringScope(scope);
		return scope;
	}
	if ("getMonitoringScope" in runtime && typeof runtime.getMonitoringScope === "function") {
		const scope: unknown = runtime.getMonitoringScope();
		validateMonitoringScope(scope);
		return scope;
	}
	if (
		"getExecutionStatus" in runtime &&
		typeof runtime.getExecutionStatus === "function" &&
		"config" in runtime &&
		runtime.config !== null &&
		typeof runtime.config === "object"
	) {
		const status: unknown = runtime.getExecutionStatus();
		if (status !== null && typeof status === "object" && "accountId" in status) {
			const config = runtime.config as Record<string, unknown>;
			const scope = {
				mode: config.mode,
				exchange: config.exchange,
				marketType: config.marketType,
				quoteCurrency: config.quoteCurrency,
				positionMode: config.positionMode,
				accountId: status.accountId,
			};
			validateMonitoringScope(scope);
			return scope;
		}
	}
	throw new Error("Monitoring requires the active runtime's non-secret account scope");
}

function object(value: unknown, allowed: string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid monitoring state object");
	const record = value as Record<string, unknown>;
	if (Object.keys(record).some((key) => !allowed.includes(key))) throw new Error("Unexpected monitoring state field");
	return record;
}

function text(value: unknown, max = 4096): asserts value is string {
	if (typeof value !== "string" || value.trim() === "" || value.length > max)
		throw new Error("Invalid monitoring state text");
}

function number(value: unknown): asserts value is number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Invalid monitoring state number");
}

function time(value: unknown): asserts value is number {
	number(value);
	if (value < 0 || value > 8_640_000_000_000_000) throw new Error("Invalid monitoring state timestamp");
}

function optionalTimes(record: Record<string, unknown>, keys: string[]): void {
	for (const key of keys) if (record[key] !== undefined) time(record[key]);
}

function oneOf(value: unknown, choices: readonly unknown[]): void {
	if (!choices.includes(value)) throw new Error("Invalid monitoring state enum");
}

function array(value: unknown, max: number): unknown[] {
	if (!Array.isArray(value) || value.length > max) throw new Error("Monitoring state collection limit exceeded");
	return value;
}

function unique(values: string[]): void {
	if (new Set(values).size !== values.length) throw new Error("Duplicate monitoring state identity");
}

export function validateMonitoringScope(value: unknown): asserts value is MonitoringScope {
	const scope = object(value, ["mode", "exchange", "marketType", "quoteCurrency", "accountId", "positionMode"]);
	oneOf(scope.mode, ["paper", "live"]);
	oneOf(scope.marketType, ["spot", "usdm-futures", "both"]);
	if (scope.positionMode !== undefined) oneOf(scope.positionMode, ["one-way", "hedge"]);
	for (const field of ["exchange", "quoteCurrency", "accountId"]) text(scope[field], 256);
}

function validateConditionFields(condition: Condition): void {
	const fields: Record<Condition["kind"], string[]> = {
		time: ["kind", "at"],
		compare: ["kind", "fact", "operator", "value"],
		cross: ["kind", "fact", "direction", "value"],
		change: ["kind", "fact", "windowSec", "operator", "value", "unit"],
		all: ["kind", "conditions"],
		any: ["kind", "conditions"],
		not: ["kind", "condition"],
		stable_for: ["kind", "condition", "durationSec"],
	};
	object(condition, fields[condition.kind]);
	if ("fact" in condition) {
		object(condition.fact, ["key"]);
		text(condition.fact.key, 256);
	}
	if ("conditions" in condition) for (const child of condition.conditions) validateConditionFields(child);
	if ("condition" in condition) validateConditionFields(condition.condition);
	if ("value" in condition && typeof condition.value === "string") text(condition.value);
}

function validateStoredTrigger(value: unknown): void {
	const entry = object(value, ["definition", "revision", "state", "updatedAt", "lastDeliveryId"]);
	validateTriggerDefinition(entry.definition);
	const definition = entry.definition;
	object(definition, ["id", "name", "when", "then", "policy"]);
	text(definition.id, 256);
	text(definition.name, 256);
	text(definition.then.message);
	object(definition.then, ["kind", "message"]);
	if (definition.policy) object(definition.policy, ["mode", "cooldownSec", "expiresAt"]);
	validateConditionFields(definition.when);
	text(entry.revision, 256);
	time(entry.updatedAt);
	if (entry.lastDeliveryId !== undefined) text(entry.lastDeliveryId, 256);
	const state = object(entry.state, [
		"status",
		"armed",
		"baseline",
		"stableSince",
		"stableSinceByPath",
		"lastFiredAt",
		"lastEvaluationAt",
	]);
	oneOf(state.status, ["active", "fired", "expired"]);
	oneOf(state.armed, [true, false]);
	if (state.baseline !== undefined) number(state.baseline);
	optionalTimes(state, ["stableSince", "lastFiredAt", "lastEvaluationAt"]);
	if (state.stableSinceByPath !== undefined) {
		if (
			!state.stableSinceByPath ||
			typeof state.stableSinceByPath !== "object" ||
			Array.isArray(state.stableSinceByPath)
		)
			throw new Error("Invalid stable trigger state");
		const paths = Object.entries(state.stableSinceByPath);
		if (paths.length > 128) throw new Error("Stable trigger state limit exceeded");
		for (const [key, since] of paths) {
			if (!/^\$(\.(\d+|condition))*$/.test(key)) throw new Error("Invalid stable trigger state path");
			time(since);
		}
	}
}

function validateObservation(value: unknown): void {
	const observation = object(value, [
		"lastPollAt",
		"lastObservationAt",
		"lastSuccessAt",
		"lastFailureAt",
		"lastDeliveryFailureAt",
		"errorCode",
	]);
	optionalTimes(observation, [
		"lastPollAt",
		"lastObservationAt",
		"lastSuccessAt",
		"lastFailureAt",
		"lastDeliveryFailureAt",
	]);
	if (observation.errorCode !== undefined)
		oneOf(observation.errorCode, ["observation-failed", "poll-failed", "delivery-failed", "notification-expired"]);
}

function validateNotification(value: unknown): void {
	const event = object(value, [
		"id",
		"source",
		"customType",
		"content",
		"notices",
		"level",
		"wake",
		"triggerRevision",
		"createdAt",
		"expiresAt",
		"status",
		"attempts",
		"nextAttemptAt",
		"leaseId",
		"leaseUntil",
		"finishedAt",
	]);
	text(event.id, 256);
	oneOf(event.source, ["triggers", "orders"]);
	oneOf(event.customType, event.source === "triggers" ? ["trigger"] : ["order-fill", "position-alert"]);
	text(event.content, 65_536);
	for (const notice of array(event.notices, 256)) text(notice, 16_384);
	oneOf(event.level, ["info", "warning"]);
	oneOf(event.wake, [true, false]);
	oneOf(event.status, ["pending", "delivering", "delivered", "expired", "cancelled"]);
	for (const field of ["createdAt", "expiresAt", "nextAttemptAt"]) time(event[field]);
	if ((event.expiresAt as number) < (event.createdAt as number)) throw new Error("Invalid notification expiry");
	if ((event.nextAttemptAt as number) < (event.createdAt as number))
		throw new Error("Invalid notification retry time");
	number(event.attempts);
	if (!Number.isSafeInteger(event.attempts) || event.attempts < 0) throw new Error("Invalid delivery attempts");
	optionalTimes(event, ["leaseUntil", "finishedAt"]);
	for (const field of ["leaseId", "triggerRevision"]) if (event[field] !== undefined) text(event[field], 256);
	if (
		(event.status === "delivering" && (event.leaseId === undefined || event.leaseUntil === undefined)) ||
		(event.status !== "delivering" && (event.leaseId !== undefined || event.leaseUntil !== undefined)) ||
		(event.status === "delivered" || event.status === "expired" || event.status === "cancelled") !==
			(event.finishedAt !== undefined)
	)
		throw new Error("Invalid notification delivery state");
	if (
		(event.finishedAt !== undefined && (event.finishedAt as number) < (event.createdAt as number)) ||
		(event.leaseUntil !== undefined && (event.leaseUntil as number) < (event.createdAt as number))
	)
		throw new Error("Invalid notification delivery time");
}

export function validateMonitoringState(value: unknown): asserts value is MonitoringState {
	const root = object(value, ["version", "scopes"]);
	if (root.version !== 1) throw new Error("Unsupported monitoring state version");
	const scopes = array(root.scopes, 64);
	for (const value of scopes) {
		const scope = object(value, ["scope", "updatedAt", "triggers", "facts", "orders", "health", "notifications"]);
		validateMonitoringScope(scope.scope);
		time(scope.updatedAt);
		const triggers = array(scope.triggers, 256);
		for (const trigger of triggers) validateStoredTrigger(trigger);
		unique((triggers as StoredTrigger[]).map((trigger) => trigger.definition.id));
		unique((triggers as StoredTrigger[]).map((trigger) => trigger.revision));
		const facts = array(scope.facts, 7680);
		for (const value of facts) {
			const fact = object(value, ["key", "value", "observedAt"]);
			text(fact.key, 256);
			number(fact.value);
			time(fact.observedAt);
		}
		unique((facts as MonitoringScopeState["facts"]).map((fact) => fact.key));
		const orders = object(scope.orders, ["seeded", "cursor", "known", "missing", "guards"]);
		oneOf(orders.seeded, [true, false]);
		optionalTimes(orders, ["cursor"]);
		const known = array(orders.known, 10_000);
		for (const value of known) {
			const order = object(value, ["id", "symbol"]);
			text(order.id, 256);
			text(order.symbol, 256);
		}
		const orderIds = (known as MonitoredOrder[]).map((order) => `${order.symbol}:${order.id}`);
		unique(orderIds);
		const missing = array(orders.missing, 256);
		for (const value of missing) {
			const entry = object(value, ["key", "checks", "warned", "since"]);
			text(entry.key, 513);
			if (!orderIds.includes(entry.key)) throw new Error("Untracked missing order");
			number(entry.checks);
			if (!Number.isSafeInteger(entry.checks) || entry.checks < 0 || entry.checks > 3)
				throw new Error("Invalid missing order count");
			oneOf(entry.warned, [true, false]);
			time(entry.since);
		}
		unique((missing as OrderMonitorState["missing"]).map((entry) => entry.key));
		const guards = array(orders.guards, 20_000);
		for (const value of guards) {
			const guard = object(value, ["key", "firstSeenAt", "lastAlertAt"]);
			text(guard.key, 513);
			if (!guard.key.endsWith(":unprotected") && !guard.key.endsWith(":drawdown"))
				throw new Error("Invalid position guard identity");
			optionalTimes(guard, ["firstSeenAt", "lastAlertAt"]);
		}
		unique((guards as OrderMonitorState["guards"]).map((guard) => guard.key));
		const health = object(scope.health, ["triggers", "orders"]);
		validateObservation(health.triggers);
		validateObservation(health.orders);
		const events = array(scope.notifications, MAX_NOTIFICATIONS);
		for (const event of events) validateNotification(event);
		unique((events as MonitoringNotification[]).map((event) => event.id));
	}
	unique((scopes as MonitoringScopeState[]).map((entry) => monitoringScopeKey(entry.scope)));
}

export function monitoringScopeKey(scope: MonitoringScope): string {
	validateMonitoringScope(scope);
	return JSON.stringify([
		scope.mode,
		scope.exchange,
		scope.marketType,
		scope.quoteCurrency,
		scope.accountId,
		scope.positionMode,
	]);
}

export function createFileMonitoringStore(
	path = join(dirname(TRADING_STATE_PATH), "monitoring-state.json"),
): MonitoringStore {
	const read = (): MonitoringState => {
		const stored = readJsonFile<unknown>(path);
		const state = stored === undefined ? { version: 1, scopes: [] } : stored;
		validateMonitoringState(state);
		return state;
	};
	return {
		read,
		transact: (operation) =>
			withFileLockSync(`${path}.lock`, () => {
				const state = read();
				const result = operation(state);
				if (result instanceof Promise) throw new Error("Monitoring transactions must be synchronous");
				validateMonitoringState(state);
				writeJsonFile(path, state);
				return structuredClone(result);
			}),
	};
}

export function createMemoryMonitoringStore(initial: MonitoringState = { version: 1, scopes: [] }): MonitoringStore {
	validateMonitoringState(initial);
	let state = structuredClone(initial);
	return {
		read: () => structuredClone(state),
		transact: (operation) => {
			const next = structuredClone(state);
			const result = operation(next);
			if (result instanceof Promise) throw new Error("Monitoring transactions must be synchronous");
			validateMonitoringState(next);
			state = structuredClone(next);
			return structuredClone(result);
		},
	};
}

export function findMonitoringScope(state: MonitoringState, scope: MonitoringScope): MonitoringScopeState | undefined {
	const key = monitoringScopeKey(scope);
	return state.scopes.find((entry) => monitoringScopeKey(entry.scope) === key);
}

export function ensureMonitoringScope(
	state: MonitoringState,
	scope: MonitoringScope,
	now: number,
): MonitoringScopeState {
	let entry = findMonitoringScope(state, scope);
	if (!entry) {
		entry = {
			scope: structuredClone(scope),
			updatedAt: now,
			triggers: [],
			facts: [],
			orders: { seeded: false, known: [], missing: [], guards: [] },
			health: { triggers: {}, orders: {} },
			notifications: [],
		};
		state.scopes.push(entry);
	}
	entry.updatedAt = now;
	pruneMonitoringNotifications(entry, now);
	return entry;
}

export function pruneMonitoringNotifications(entry: MonitoringScopeState, now: number): void {
	for (const event of entry.notifications) {
		if ((event.status === "pending" || event.status === "delivering") && now >= event.expiresAt) {
			event.status = "expired";
			event.finishedAt = now;
			delete event.leaseId;
			delete event.leaseUntil;
			entry.health[event.source].lastFailureAt = now;
			entry.health[event.source].errorCode = "notification-expired";
		}
	}
	entry.notifications = entry.notifications.filter(
		(event) => event.finishedAt === undefined || now - event.finishedAt < RETENTION_MS,
	);
}

export function enqueueMonitoringNotification(
	entry: MonitoringScopeState,
	notification: Pick<
		MonitoringNotification,
		"source" | "customType" | "content" | "notices" | "level" | "wake" | "triggerRevision"
	>,
	now: number,
	expiresAt = now + MONITORING_MAX_AGE_MS,
): string {
	pruneMonitoringNotifications(entry, now);
	while (entry.notifications.length >= MAX_NOTIFICATIONS) {
		const index = entry.notifications.findIndex((event) => event.finishedAt !== undefined);
		if (index < 0) throw new Error("Monitoring notification backlog is full; delivery must recover before advancing");
		entry.notifications.splice(index, 1);
	}
	const id = randomUUID();
	entry.notifications.push({
		...notification,
		id,
		createdAt: now,
		expiresAt,
		status: "pending",
		attempts: 0,
		nextAttemptAt: now,
	});
	return id;
}

export function cancelTriggerNotifications(entry: MonitoringScopeState, revisions: string[], now: number): void {
	for (const event of entry.notifications) {
		if (event.triggerRevision && revisions.includes(event.triggerRevision) && event.finishedAt === undefined) {
			event.status = "cancelled";
			event.finishedAt = now;
			delete event.leaseId;
			delete event.leaseUntil;
		}
	}
}

export function recordMonitoringObservation(
	entry: MonitoringScopeState,
	source: MonitoringNotification["source"],
	now: number,
	observedAt: number | undefined,
	failed: boolean,
): void {
	const health = entry.health[source];
	health.lastPollAt = now;
	if (observedAt !== undefined) health.lastObservationAt = observedAt;
	if (failed) {
		health.lastFailureAt = now;
		health.errorCode = "observation-failed";
	} else {
		if (observedAt !== undefined) health.lastSuccessAt = now;
		if (
			entry.notifications.some(
				(event) => event.source === source && event.status === "pending" && event.attempts > 0,
			)
		) {
			health.lastFailureAt = now;
			health.errorCode = "delivery-failed";
		} else if (observedAt !== undefined) {
			delete health.errorCode;
		}
	}
}

export interface MonitoringDeliveryReport {
	attempted: number;
	delivered: number;
	failures: Array<{ eventId: string; error?: unknown }>;
}

/**
 * Bounded at-least-once delivery attempts, not exactly-once UI/session delivery.
 * A crash after send and before acknowledgement may duplicate the same event ID.
 * Expired events are retained as diagnostics, never replayed as agent actions.
 * The callback performs delivery only: its failures are reported after retry state
 * is persisted. Store read, claim and acknowledgement failures still throw.
 */
export function deliverMonitoringNotifications(
	store: MonitoringStore,
	scope: MonitoringScope,
	source: MonitoringNotification["source"],
	deliver: (event: MonitoringNotification) => boolean,
	isCurrent: () => boolean,
	now: () => number = Date.now,
): MonitoringDeliveryReport {
	const report: MonitoringDeliveryReport = { attempted: 0, delivered: 0, failures: [] };
	const candidates = (findMonitoringScope(store.read(), scope)?.notifications ?? [])
		.filter(
			(event) =>
				event.source === source &&
				event.finishedAt === undefined &&
				event.nextAttemptAt <= now() &&
				(event.leaseUntil === undefined || event.leaseUntil <= now()),
		)
		.sort((left, right) => left.nextAttemptAt - right.nextAttemptAt || left.attempts - right.attempts);
	for (const candidate of candidates) {
		if (report.attempted >= 32 || !isCurrent()) break;
		const claimed = store.transact((state) => {
			const entry = ensureMonitoringScope(state, scope, now());
			const event = entry.notifications.find((item) => item.id === candidate.id);
			if (
				!event ||
				event.finishedAt !== undefined ||
				event.nextAttemptAt > now() ||
				(event.leaseUntil !== undefined && event.leaseUntil > now())
			)
				return undefined;
			event.status = "delivering";
			event.leaseId = randomUUID();
			event.leaseUntil = now() + MONITORING_LEASE_MS;
			event.attempts++;
			return event;
		});
		if (!claimed) continue;
		if (!isCurrent()) break;
		report.attempted++;
		let delivered = false;
		let failure: unknown;
		try {
			delivered = deliver(claimed);
		} catch (error) {
			failure = error;
		}
		store.transact((state) => {
			const entry = ensureMonitoringScope(state, scope, now());
			const event = entry.notifications.find((item) => item.id === claimed.id);
			if (!event || event.status !== "delivering" || event.leaseId !== claimed.leaseId) return;
			delete event.leaseId;
			delete event.leaseUntil;
			if (delivered) {
				event.status = "delivered";
				event.finishedAt = now();
			} else {
				event.status = "pending";
				event.nextAttemptAt = now() + Math.min(60_000, 1000 * 2 ** Math.min(event.attempts, 6));
				entry.health[source].lastFailureAt = now();
				entry.health[source].lastDeliveryFailureAt = now();
				entry.health[source].errorCode = "delivery-failed";
			}
		});
		if (delivered) report.delivered++;
		else report.failures.push({ eventId: claimed.id, error: failure });
	}
	return report;
}

export function readMonitoringHealth(store: MonitoringStore, scope: MonitoringScope, now = Date.now()) {
	time(now);
	const entry = findMonitoringScope(store.read(), scope);
	return (["triggers", "orders"] as const).map((source) => {
		const observation = entry?.health[source] ?? {};
		const ageMs = observation.lastObservationAt === undefined ? undefined : now - observation.lastObservationAt;
		const events = entry?.notifications.filter((event) => event.source === source) ?? [];
		return {
			source,
			scope: structuredClone(scope),
			...observation,
			ageMs,
			stale: ageMs === undefined || ageMs < 0 || ageMs > MONITORING_MAX_AGE_MS,
			pendingNotifications: events.filter((event) => event.finishedAt === undefined && event.expiresAt > now).length,
			expiredNotifications: events.filter(
				(event) => event.status === "expired" || (event.finishedAt === undefined && event.expiresAt <= now),
			).length,
			activeTriggers: entry?.triggers.filter((trigger) => trigger.state.status === "active").length ?? 0,
			monitoredOrders: entry?.orders.known.length ?? 0,
			unresolvedOrders: entry?.orders.missing.length ?? 0,
		};
	});
}
