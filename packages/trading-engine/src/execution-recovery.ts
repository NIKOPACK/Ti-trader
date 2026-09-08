import { getTradingCapabilities, supportsCorrelatedLookup } from "./capabilities.ts";
import {
	type ExecutionEvidence,
	type ExecutionIssue,
	type ExecutionJournal,
	type ExecutionRecord,
	type ExecutionScope,
	isUnresolvedExecution,
	MAX_RECOVERY_ATTEMPTS,
} from "./execution-journal.ts";
import type { ExchangeClient, PlaceOcoOrderResult, PlaceOrderResult } from "./types.ts";

export interface RecoveryReport {
	examined: number;
	reconciled: number;
	unresolved: number;
	issues: Array<{ executionId: string; issue: ExecutionIssue }>;
}
export interface RecoveryOptions {
	maxRecords?: number;
	attemptsPerRecord?: number;
	lookupTimeoutMs?: number;
	backoffMs?: number;
}
export interface ManualExecutionResolution {
	executionId: string;
	expectedRevision: number;
	accountId: string;
	outcome: "commit" | "release";
	notional: number;
	/** A safe external evidence reference, not an exchange response or credential. */
	evidenceReference: string;
	/** For release, operator must attest the submission is terminal and has no fills or future execution. */
	verifiedTerminal: boolean;
}

export function sameExecutionScope(left: ExecutionScope, right: ExecutionScope): boolean {
	return (
		left.accountId === right.accountId &&
		left.exchange === right.exchange &&
		left.mode === right.mode &&
		left.marketType === right.marketType &&
		left.quoteCurrency === right.quoteCurrency &&
		left.positionMode === right.positionMode
	);
}

/** Require numerical and identity evidence; absence, truncated OCOs and zero-cost fills are not rejection. */
export function executionEvidence(
	entry: ExecutionRecord,
	result: PlaceOrderResult | PlaceOcoOrderResult,
	source: "submission" | "client-id-lookup",
): { evidence: ExecutionEvidence; notional: number; outcome: "commit" | "release" } {
	const orders = "order" in result ? [result.order] : result.orders;
	const input = entry.intent.input;
	const nativeOco = entry.scope.mode === "paper" || entry.scope.exchange === "binance";
	if (orders.length !== (entry.intent.kind === "oco" && nativeOco ? 2 : 1))
		throw new Error("Incomplete execution evidence");
	const ids = new Set<string>();
	const clientIds = new Set<string>();
	for (const order of orders) {
		if (
			!/^[A-Za-z0-9_-]{1,80}$/.test(order.id) ||
			order.id === "unknown" ||
			ids.has(order.id) ||
			order.symbol !== input.symbol ||
			order.side !== input.side ||
			![order.amount, order.filled, order.remaining, order.cost].every((n) => Number.isFinite(n) && n >= 0) ||
			!["open", "closed", "canceled", "rejected", "expired"].includes(order.status)
		)
			throw new Error("Conflicting execution evidence");
		ids.add(order.id);
		const tolerance = Math.max(Number.MIN_VALUE, Math.abs(input.amount) * 1e-8);
		const closeAll = entry.intent.kind === "order" && entry.intent.input.closePosition === true;
		if (
			(!closeAll && Math.abs(order.amount - input.amount) > tolerance) ||
			order.filled > Math.max(input.amount, order.amount) + tolerance ||
			(!closeAll && Math.abs(order.filled + order.remaining - order.amount) > tolerance) ||
			(order.status === "closed" && (order.filled === 0 || order.remaining > tolerance)) ||
			(order.filled > 0 && order.cost === 0) ||
			(order.filled === 0 && order.cost > 0)
		)
			throw new Error("Incomplete fill evidence");
		if (entry.intent.kind === "order") {
			if (
				(order.clientOrderId !== undefined && order.clientOrderId !== entry.intent.input.clientOrderId) ||
				(source === "client-id-lookup" && order.clientOrderId !== entry.intent.input.clientOrderId)
			)
				throw new Error("Uncorrelated order");
			if (
				entry.intent.input.positionSide &&
				order.positionSide &&
				entry.intent.input.positionSide !== order.positionSide
			)
				throw new Error("Conflicting futures position side");
		} else {
			const expected = nativeOco
				? [entry.intent.input.aboveClientOrderId, entry.intent.input.belowClientOrderId]
				: [entry.intent.input.listClientOrderId];
			if (!order.clientOrderId || !expected.includes(order.clientOrderId) || clientIds.has(order.clientOrderId))
				throw new Error("Uncorrelated OCO leg");
			clientIds.add(order.clientOrderId);
			if (
				nativeOco &&
				(!order.orderListId ||
					order.orderListId !== orders[0].orderListId ||
					order.listClientOrderId !== entry.intent.input.listClientOrderId)
			)
				throw new Error("Conflicting OCO list identity");
		}
	}
	if (entry.intent.kind === "oco" && orders.reduce((sum, order) => sum + order.filled, 0) > input.amount * (1 + 1e-8))
		throw new Error("OCO fills exceed the shared amount");
	const cost = orders.reduce((sum, order) => sum + order.cost, 0);
	if (!Number.isFinite(cost)) throw new Error("Invalid total fill cost");
	const final = orders.every((order) => order.status !== "open");
	const notional = final ? cost : Math.max(entry.notional, cost);
	const evidence: ExecutionEvidence = {
		source,
		observedAt: new Date().toISOString(),
		orders: orders.map((order) => ({
			id: order.id,
			clientOrderId: order.clientOrderId,
			symbol: order.symbol,
			side: order.side,
			amount: order.amount,
			filled: order.filled,
			remaining: order.remaining,
			cost: order.cost,
			status: order.status,
			orderListId: order.orderListId,
			listClientOrderId: order.listClientOrderId,
		})),
	};
	return { evidence, notional, outcome: notional === 0 ? "release" : "commit" };
}

async function boundedLookup<T>(lookup: () => Promise<T>, timeoutMs: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			lookup(),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("Recovery lookup timed out")), timeoutMs);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

export async function recoverJournal(
	journal: ExecutionJournal,
	exchange: ExchangeClient,
	options: RecoveryOptions = {},
): Promise<RecoveryReport> {
	const maxRecords = options.maxRecords ?? 10;
	const attempts = options.attemptsPerRecord ?? 3;
	const timeoutMs = options.lookupTimeoutMs ?? 1500;
	const backoff = options.backoffMs ?? 100;
	if (
		!Number.isInteger(maxRecords) ||
		maxRecords < 1 ||
		maxRecords > 100 ||
		!Number.isInteger(attempts) ||
		attempts < 1 ||
		attempts > 3 ||
		!Number.isFinite(timeoutMs) ||
		timeoutMs < 1 ||
		timeoutMs > 10_000 ||
		!Number.isFinite(backoff) ||
		backoff < 0 ||
		backoff > 1000
	)
		throw new Error("Invalid bounded recovery options");
	const report: RecoveryReport = { examined: 0, reconciled: 0, unresolved: 0, issues: [] };
	const pending = journal
		.list()
		.filter(isUnresolvedExecution)
		.sort(
			(left, right) =>
				Number(sameExecutionScope(right.scope, journal.scope)) -
				Number(sameExecutionScope(left.scope, journal.scope)),
		)
		.slice(0, maxRecords);
	for (const original of pending) {
		report.examined++;
		if (!sameExecutionScope(original.scope, journal.scope)) {
			report.issues.push({ executionId: original.id, issue: "account-mismatch" });
			continue;
		}
		if (original.status === "prepared") {
			// CAS revokes the send permission BEFORE releasing quota, even if its original confirmer is still alive.
			if (journal.settle(original.id, "release", 0, "reconciled", undefined, original.revision)) report.reconciled++;
			continue;
		}
		let issue: ExecutionIssue = "lookup-unavailable";
		const capabilities = getTradingCapabilities({
			exchangeId: original.scope.exchange,
			mode: original.scope.mode,
			marketFamily: original.intent.input.symbol.includes(":") ? "futures" : "spot",
			positionMode: original.scope.positionMode,
			orderType: original.intent.kind === "order" ? original.intent.input.type : "oco",
		});
		if (
			!supportsCorrelatedLookup(
				original.intent.kind === "order"
					? capabilities.queryOrderByClientId
					: capabilities.queryOrderListByClientId,
			)
		) {
			issue = "lookup-unsupported";
			journal.unknown(original.id, issue, original.revision);
			report.issues.push({ executionId: original.id, issue });
			continue;
		}
		for (let attempt = 0; attempt < attempts; attempt++) {
			const waitMs = backoff * 2 ** attempt;
			const claim = journal.claimAttempt(original.id, new Date(Date.now() + waitMs).toISOString());
			if (!claim) {
				if (journal.list().find((entry) => entry.id === original.id)?.attempts === MAX_RECOVERY_ATTEMPTS)
					issue = "attempts-exhausted";
				break;
			}
			let result: PlaceOrderResult | PlaceOcoOrderResult;
			try {
				result = await boundedLookup(async () => {
					if (claim.intent.kind === "order")
						return {
							order: await exchange.getOrderByClientId(
								claim.intent.input.clientOrderId as string,
								claim.intent.input.symbol,
							),
						};
					const list = await exchange.getOrderListByClientId(claim.intent.input.listClientOrderId as string);
					return { orders: list.orders };
				}, timeoutMs);
			} catch {
				// Not-found, missing credentials and transport failures all retain uncertainty. No placement call exists here.
				journal.unknown(claim.id, "lookup-unavailable", claim.revision);
				issue = "lookup-unavailable";
				if (attempt < attempts - 1 && waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
				continue;
			}
			let observation: ReturnType<typeof executionEvidence>;
			try {
				observation = executionEvidence(claim, result, "client-id-lookup");
			} catch {
				journal.unknown(claim.id, "evidence-conflict", claim.revision);
				issue = "evidence-conflict";
				break;
			}
			if (
				journal.settle(
					claim.id,
					observation.outcome,
					observation.notional,
					"reconciled",
					observation.evidence,
					claim.revision,
				)
			)
				report.reconciled++;
			break;
		}
		if (journal.list().some((entry) => entry.id === original.id && isUnresolvedExecution(entry)))
			report.issues.push({ executionId: original.id, issue });
	}
	report.unresolved = journal.list().filter(isUnresolvedExecution).length;
	return report;
}

export function manuallyResolveExecution(journal: ExecutionJournal, resolution: ManualExecutionResolution): void {
	const entry = journal.list().find((item) => item.id === resolution.executionId);
	if (!entry || !isUnresolvedExecution(entry)) throw new Error("Execution is absent or already resolved");
	if (!sameExecutionScope(entry.scope, journal.scope) || resolution.accountId !== entry.scope.accountId)
		throw new Error("Original execution account and runtime must match");
	if (entry.revision !== resolution.expectedRevision) throw new Error("Execution changed during confirmation");
	if (
		!/^[A-Za-z0-9_-]{1,80}$/.test(resolution.evidenceReference) ||
		!Number.isFinite(resolution.notional) ||
		resolution.notional < 0 ||
		(resolution.outcome !== "commit" && resolution.outcome !== "release") ||
		!resolution.verifiedTerminal ||
		(resolution.outcome === "release" && resolution.notional !== 0)
	)
		throw new Error("Verified terminal evidence reference and a finite settled notional are required");
	if (entry.status === "prepared" && resolution.outcome !== "release")
		throw new Error("Never-started execution cannot be committed");
	const evidence: ExecutionEvidence = {
		source: "operator",
		observedAt: new Date().toISOString(),
		orders: [],
		reference: resolution.evidenceReference,
	};
	if (
		!journal.settle(
			entry.id,
			resolution.outcome,
			resolution.notional,
			"reconciled",
			evidence,
			resolution.expectedRevision,
		)
	)
		throw new Error("Execution changed during confirmation");
}
