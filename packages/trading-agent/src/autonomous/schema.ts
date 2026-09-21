import type { AccountSnapshot, RiskSupervisionReport } from "@nikopack/ti-trading-engine";

export interface AutonomousEvent {
	id: string;
	kind: "start" | "timer" | "condition" | "fill" | "position" | "risk";
	at: number;
	message: string;
	/** Historical audit evidence only; current decisions must query the account again. */
	evidence?: Pick<AccountSnapshot, "source" | "observedAt" | "equity" | "netExternalFlows" | "marginUsed"> & {
		actions: RiskSupervisionReport["actions"];
	};
}
export interface AutonomousAction {
	id: string;
	name: string;
	args: unknown;
	status: "started" | "completed" | "unknown" | "failed";
	result?: unknown;
}
export interface AutonomousDecision {
	id: string;
	event: AutonomousEvent;
	attempts: number;
	nextAttemptAt: number;
	actions: AutonomousAction[];
	blockedByAction?: string;
}
export interface AutonomousState {
	version: 1;
	control: "running" | "paused" | "stopped";
	heartbeat?: number;
	pid?: number;
	events: AutonomousEvent[];
	/** Exact receipts, retained independently of bounded diagnostic history. */
	receipts: Record<string, true>;
	/** Monotonic count of every event ever minted; never reset by receipt compaction. */
	sequence: number;
	/** Observation events folded into an already pending event of the same kind. */
	coalescedEvents?: number;
	/** Wake events that could not be queued; every loss is counted, never silent. */
	droppedEvents?: number;
	decision?: AutonomousDecision;
	triggerIds: string[];
	lastAccountFingerprint?: string;
	lastOrdersFingerprint?: string;
	lastRiskFingerprint?: string;
	summaries: Array<{
		id: string;
		eventId: string;
		at: number;
		text: string;
		outcome: "completed" | "failed";
		evidence?: AutonomousEvent["evidence"];
	}>;
	failures: Array<{ at: number; source: string; reason: string }>;
	unfinishedActions?: Array<AutonomousAction & { decisionId: string }>;
}

function validateRiskEvidence(evidence: NonNullable<AutonomousEvent["evidence"]>): void {
	if (
		!evidence ||
		typeof evidence.source !== "string" ||
		!evidence.source ||
		![evidence.observedAt, evidence.equity, evidence.netExternalFlows, evidence.marginUsed].every(Number.isFinite) ||
		!Array.isArray(evidence.actions) ||
		evidence.actions.some(
			(action) =>
				!action ||
				typeof action.action !== "string" ||
				typeof action.reference !== "string" ||
				!["completed", "unknown", "failed"].includes(action.status) ||
				(action.reason !== undefined && typeof action.reason !== "string"),
		)
	)
		throw new Error("Invalid risk event evidence");
}

export function validateAutonomousState(value: unknown): asserts value is AutonomousState {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid autonomous state");
	const state = value as AutonomousState;
	if (
		state.version !== 1 ||
		!["running", "paused", "stopped"].includes(state.control) ||
		!Number.isSafeInteger(state.sequence) ||
		state.sequence < 0 ||
		!Array.isArray(state.events) ||
		state.events.length > 256 ||
		!Array.isArray(state.triggerIds) ||
		state.triggerIds.some((id) => typeof id !== "string") ||
		new Set(state.triggerIds).size !== state.triggerIds.length ||
		!Array.isArray(state.summaries) ||
		state.summaries.length > 100 ||
		!Array.isArray(state.failures) ||
		state.failures.length > 100 ||
		!state.receipts ||
		typeof state.receipts !== "object" ||
		Array.isArray(state.receipts) ||
		Object.values(state.receipts).some((receipt) => receipt !== true) ||
		// `sequence` counts minted events forever, while receipts compact once an event is
		// summarized. A receipt count above the minted count is the invalid direction.
		state.sequence < Object.keys(state.receipts).length ||
		(state.coalescedEvents !== undefined &&
			(!Number.isSafeInteger(state.coalescedEvents) || state.coalescedEvents < 0)) ||
		(state.droppedEvents !== undefined && (!Number.isSafeInteger(state.droppedEvents) || state.droppedEvents < 0)) ||
		(state.heartbeat !== undefined && (!Number.isFinite(state.heartbeat) || state.heartbeat < 0)) ||
		(state.pid !== undefined && (!Number.isSafeInteger(state.pid) || state.pid <= 0))
	)
		throw new Error("Invalid autonomous state fields");
	for (const event of [...state.events, ...(state.decision ? [state.decision.event] : [])]) {
		if (
			!event ||
			typeof event.id !== "string" ||
			!event.id ||
			!["start", "timer", "condition", "fill", "position", "risk"].includes(event.kind) ||
			typeof event.message !== "string" ||
			!Number.isFinite(event.at)
		)
			throw new Error("Invalid autonomous event");
		if (!Object.hasOwn(state.receipts, event.id)) throw new Error("Autonomous event receipt is missing");
		if (event.evidence !== undefined) validateRiskEvidence(event.evidence);
	}
	if (
		new Set(state.events.map((event) => event.id)).size !== state.events.length ||
		state.events.some((event) => event.id === state.decision?.event.id)
	)
		throw new Error("Duplicate pending autonomous event");
	for (const summary of state.summaries) {
		if (
			!summary ||
			typeof summary.id !== "string" ||
			!/^[a-f0-9]{64}$/.test(summary.id) ||
			typeof summary.eventId !== "string" ||
			!Object.hasOwn(state.receipts, summary.eventId) ||
			!Number.isFinite(summary.at) ||
			typeof summary.text !== "string" ||
			!["completed", "failed"].includes(summary.outcome)
		)
			throw new Error("Invalid autonomous decision summary");
		if (summary.evidence !== undefined) validateRiskEvidence(summary.evidence);
	}
	for (const failure of state.failures) {
		if (
			!failure ||
			!Number.isFinite(failure.at) ||
			typeof failure.source !== "string" ||
			typeof failure.reason !== "string"
		)
			throw new Error("Invalid autonomous failure");
	}
	if (state.decision) {
		if (
			typeof state.decision.id !== "string" ||
			!/^[a-f0-9]{64}$/.test(state.decision.id) ||
			!Array.isArray(state.decision.actions) ||
			!Number.isSafeInteger(state.decision.attempts) ||
			state.decision.attempts < 0 ||
			!Number.isFinite(state.decision.nextAttemptAt)
		)
			throw new Error("Invalid autonomous decision");
		if (state.decision.blockedByAction !== undefined && !/^[a-f0-9]{64}$/.test(state.decision.blockedByAction))
			throw new Error("Invalid blocked decision action");
	}
	if (state.unfinishedActions !== undefined && !Array.isArray(state.unfinishedActions))
		throw new Error("Invalid unfinished autonomous actions");
	const actions = [...(state.decision?.actions ?? []), ...(state.unfinishedActions ?? [])];
	if (new Set(actions.map((action) => action.id)).size !== actions.length)
		throw new Error("Duplicate autonomous action");
	for (const action of actions) {
		if (
			!action ||
			!/^[a-f0-9]{64}$/.test(action.id) ||
			typeof action.name !== "string" ||
			!["started", "completed", "unknown", "failed"].includes(action.status)
		)
			throw new Error("Invalid autonomous action");
	}
	for (const action of state.unfinishedActions ?? [])
		if (!/^[a-f0-9]{64}$/.test(action.decisionId)) throw new Error("Invalid unfinished decision identity");
}
