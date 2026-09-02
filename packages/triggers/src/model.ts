export type TriState = "true" | "false" | "unknown";
export type CompareOperator = "eq" | "neq" | "gt" | "gte" | "lt" | "lte";

export type FactRef = { key: string };
export type Condition =
	| { kind: "time"; at: string }
	| { kind: "compare"; fact: FactRef; operator: CompareOperator; value: number | string | boolean }
	| { kind: "cross"; fact: FactRef; direction: "above" | "below"; value: number }
	| {
			kind: "change";
			fact: FactRef;
			windowSec: number;
			operator: CompareOperator;
			value: number;
			unit: "absolute" | "percent";
	  }
	| { kind: "all" | "any"; conditions: Condition[] }
	| { kind: "not"; condition: Condition }
	| { kind: "stable_for"; condition: Condition; durationSec: number };

export type TriggerPolicy = { mode?: "once" | "on_edge" | "while_true"; cooldownSec?: number; expiresAt?: string };
export type TriggerAction = { kind: "notify" | "wake_agent"; message: string };
export interface TriggerDefinition {
	id: string;
	name: string;
	when: Condition;
	then: TriggerAction;
	policy?: TriggerPolicy;
}
export interface RuntimeState {
	status: "active" | "fired" | "expired";
	armed: boolean;
	baseline?: number;
	/** Deprecated root compatibility value; nested conditions use stableSinceByPath. */
	stableSince?: number;
	stableSinceByPath?: Readonly<Record<string, number>>;
	lastFiredAt?: number;
	lastEvaluationAt?: number;
}
export interface FactValue {
	value: number | string | boolean;
	observedAt: number;
	previousValue?: number;
	previousObservedAt?: number;
	quality?: "live" | "delayed" | "recovered";
}
export type FactSnapshot = Readonly<Record<string, FactValue>>;
export interface Evaluation {
	state: TriState;
	reason?: string;
}
export interface TransitionResult {
	state: RuntimeState;
	evaluation: Evaluation;
	shouldFire: boolean;
}
