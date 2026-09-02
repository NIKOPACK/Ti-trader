import type {
	CompareOperator,
	Condition,
	Evaluation,
	FactSnapshot,
	FactValue,
	RuntimeState,
	TransitionResult,
	TriggerDefinition,
	TriState,
} from "./model.ts";

export interface EvaluatorOptions {
	/** Maximum age of an observation. Defaults to five minutes. */
	maxAgeMs?: number;
	/** Clock skew accepted for observations from a source. Defaults to five seconds. */
	futureToleranceMs?: number;
}

const DEFAULT_OPTIONS: Required<EvaluatorOptions> = { maxAgeMs: 5 * 60_000, futureToleranceMs: 5_000 };
type StableState = Record<string, number>;

function compare(left: unknown, operator: CompareOperator, right: unknown): TriState {
	if (left === undefined || left === null || (typeof left === "number" && !Number.isFinite(left))) return "unknown";
	if (operator === "eq") return left === right ? "true" : "false";
	if (operator === "neq") return left !== right ? "true" : "false";
	if (typeof left !== "number" || typeof right !== "number" || !Number.isFinite(right)) return "unknown";
	if (operator === "gt") return left > right ? "true" : "false";
	if (operator === "gte") return left >= right ? "true" : "false";
	if (operator === "lt") return left < right ? "true" : "false";
	return left <= right ? "true" : "false";
}

function validObservation(fact: FactValue | undefined, now: number, options: Required<EvaluatorOptions>): boolean {
	return (
		!!fact &&
		Number.isFinite(fact.observedAt) &&
		fact.observedAt <= now + options.futureToleranceMs &&
		now - fact.observedAt <= options.maxAgeMs
	);
}

function evaluate(
	condition: Condition,
	facts: FactSnapshot,
	now: number,
	states: StableState,
	path: string,
	options: Required<EvaluatorOptions>,
): { result: Evaluation; states: StableState } {
	switch (condition.kind) {
		case "time": {
			const at = Date.parse(condition.at);
			return {
				result: Number.isFinite(at)
					? { state: now >= at ? "true" : "false" }
					: { state: "unknown", reason: "invalid time" },
				states,
			};
		}
		case "compare": {
			const fact = facts[condition.fact.key];
			return {
				result: validObservation(fact, now, options)
					? { state: compare(fact?.value, condition.operator, condition.value) }
					: { state: "unknown", reason: "observation is stale or invalid" },
				states,
			};
		}
		case "cross": {
			const fact = facts[condition.fact.key];
			if (
				!validObservation(fact, now, options) ||
				!fact ||
				typeof fact.value !== "number" ||
				!Number.isFinite(fact.value) ||
				typeof fact.previousValue !== "number" ||
				!Number.isFinite(fact.previousValue)
			)
				return { result: { state: "unknown", reason: "cross baseline unavailable" }, states };
			const crossed =
				condition.direction === "above"
					? fact.previousValue <= condition.value && fact.value > condition.value
					: fact.previousValue >= condition.value && fact.value < condition.value;
			return { result: { state: crossed ? "true" : "false" }, states };
		}
		case "change": {
			const fact = facts[condition.fact.key];
			const previousAt = fact?.previousObservedAt;
			if (
				!validObservation(fact, now, options) ||
				!fact ||
				typeof fact.value !== "number" ||
				!Number.isFinite(fact.value) ||
				typeof fact.previousValue !== "number" ||
				!Number.isFinite(fact.previousValue) ||
				typeof previousAt !== "number" ||
				!Number.isFinite(previousAt) ||
				previousAt > fact.observedAt ||
				fact.observedAt > now + options.futureToleranceMs ||
				now - fact.observedAt > condition.windowSec * 1000 ||
				now - previousAt > condition.windowSec * 1000
			)
				return { result: { state: "unknown", reason: "change window unavailable" }, states };
			const change =
				condition.unit === "percent"
					? fact.previousValue === 0
						? undefined
						: ((fact.value - fact.previousValue) / Math.abs(fact.previousValue)) * 100
					: fact.value - fact.previousValue;
			return {
				result: { state: change === undefined ? "unknown" : compare(change, condition.operator, condition.value) },
				states,
			};
		}
		case "not": {
			const inner = evaluate(condition.condition, facts, now, states, `${path}.0`, options);
			return {
				result: {
					state: inner.result.state === "unknown" ? "unknown" : inner.result.state === "true" ? "false" : "true",
				},
				states: inner.states,
			};
		}
		case "all":
		case "any": {
			let next = states;
			const results = condition.conditions.map((child, index) => {
				const evaluated = evaluate(child, facts, now, next, `${path}.${index}`, options);
				next = evaluated.states;
				return evaluated.result.state;
			});
			const state =
				condition.kind === "all"
					? results.includes("false")
						? "false"
						: results.every((s) => s === "true")
							? "true"
							: "unknown"
					: results.includes("true")
						? "true"
						: results.every((s) => s === "false")
							? "false"
							: "unknown";
			return { result: { state }, states: next };
		}
		case "stable_for": {
			const inner = evaluate(condition.condition, facts, now, states, `${path}.condition`, options);
			const since = inner.result.state === "true" ? (inner.states[path] ?? now) : undefined;
			const next = { ...inner.states };
			if (since === undefined) delete next[path];
			else next[path] = since;
			return {
				result: {
					state:
						since !== undefined && now - since >= condition.durationSec * 1000
							? "true"
							: inner.result.state === "unknown"
								? "unknown"
								: "false",
				},
				states: next,
			};
		}
	}
}

export function evaluateCondition(
	condition: Condition,
	facts: FactSnapshot,
	now: number,
	stableSince?: number,
	options: EvaluatorOptions = {},
	stableSinceByPath?: StableState,
): Evaluation & { stableSince?: number; stableSinceByPath?: StableState } {
	const initial: StableState = { ...(stableSinceByPath ?? {}) };
	if (stableSince !== undefined && initial.$ === undefined) initial.$ = stableSince;
	const result = evaluate(condition, facts, now, initial, "$", { ...DEFAULT_OPTIONS, ...options });
	return { ...result.result, stableSince: result.states.$, stableSinceByPath: result.states };
}

export function transitionTrigger(
	definition: TriggerDefinition,
	previous: RuntimeState,
	facts: FactSnapshot,
	now: number,
	options: EvaluatorOptions = {},
): TransitionResult {
	if (!Number.isFinite(now)) throw new Error("Evaluation time must be finite");
	if (previous.status !== "active")
		return {
			state: previous,
			evaluation: { state: previous.status === "expired" ? "false" : "unknown" },
			shouldFire: false,
		};
	const expiresAt = definition.policy?.expiresAt ? Date.parse(definition.policy.expiresAt) : undefined;
	if (expiresAt !== undefined && (!Number.isFinite(expiresAt) || now >= expiresAt))
		return {
			state: { ...previous, status: "expired", lastEvaluationAt: now },
			evaluation: { state: "false", reason: "expired" },
			shouldFire: false,
		};
	const evaluation = evaluateCondition(
		definition.when,
		facts,
		now,
		previous.stableSince,
		options,
		previous.stableSinceByPath,
	);
	const mode = definition.policy?.mode ?? "on_edge";
	const cooled =
		previous.lastFiredAt === undefined || now - previous.lastFiredAt >= (definition.policy?.cooldownSec ?? 0) * 1000;
	const shouldFire =
		evaluation.state === "true" && cooled && (mode === "once" || mode === "while_true" || previous.armed);
	const next: RuntimeState = {
		...previous,
		lastEvaluationAt: now,
		stableSince: evaluation.stableSince,
		stableSinceByPath: evaluation.stableSinceByPath,
		armed: evaluation.state !== "true",
	};
	if (shouldFire) {
		next.lastFiredAt = now;
		if (mode === "once") next.status = "fired";
	}
	return { state: next, evaluation, shouldFire };
}
