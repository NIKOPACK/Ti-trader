import { createHash, randomUUID } from "node:crypto";
import type { AccountSnapshot, RiskSupervisionReport } from "@nikopack/ti-trading-engine";
import type { FactValue } from "@nikopack/ti-triggers";
import { failureCode } from "../failure-code.ts";
import { ensureMonitoringScope, findMonitoringScope } from "../monitoring-state.ts";
import {
	collectTriggerFactKeys,
	parsePositionPnlFactKey,
	prepareTriggerFacts,
	transitionObservedTrigger,
} from "../trigger-facts.ts";
import type { AutonomousConfig } from "./config.ts";
import {
	type AutonomousDecision,
	type AutonomousStore,
	enqueueAutonomousEvent,
	noteObservationEvent,
} from "./state.ts";

export { failureCode };

export interface AutonomousModel {
	run(decision: AutonomousDecision, context: string, signal: AbortSignal): Promise<string>;
	stop(): Promise<void>;
}
export interface AutonomousRuntimeDependencies {
	state: AutonomousStore;
	config: AutonomousConfig;
	model: AutonomousModel;
	supervise(): Promise<RiskSupervisionReport>;
	ticker(symbol: string): Promise<{ last?: number; timestamp: number }>;
	block(reason: string): void;
	recover(): Promise<void>;
	now?: () => number;
}

export async function withDeadline<T>(operation: Promise<T>, ms: number, source: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`${source} timeout`)), ms);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** Model execution is deliberately NOT awaited by the independent supervision path. */
export class AutonomousRuntime {
	private readonly deps: AutonomousRuntimeDependencies;
	private readonly now: () => number;
	private modelTask: Promise<void> | undefined;
	private modelAbort: AbortController | undefined;
	private initialized = false;
	private stopped = false;
	private pollTask: Promise<RiskSupervisionReport> | undefined;
	private pollFailures = 0;
	private nextPollAt = 0;
	constructor(deps: AutonomousRuntimeDependencies) {
		this.deps = deps;
		this.now = deps.now ?? Date.now;
	}
	async initialize(): Promise<void> {
		if (this.initialized) return;
		await this.deps.recover();
		const decision = this.deps.state.read().decision;
		if (decision?.actions.length) {
			this.deps.state.finishDecision(
				decision.id,
				"Recovered interrupted decision with attempted account actions; original event is not replayed. Query execution records before any follow-up.",
				"failed",
			);
		}
		this.initialized = true;
	}
	async tick(): Promise<void> {
		if (!this.initialized) throw new Error("Reconcile before autonomous trading");
		const { state, config } = this.deps;
		const control = state.read().control;
		if (control !== "running" && this.modelTask) {
			this.modelAbort?.abort(new Error(`Autonomous model ${control}`));
			await this.deps.model.stop();
		}
		if (control === "stopped") {
			this.stopped = true;
			return;
		}
		if (this.now() >= this.nextPollAt) {
			try {
				// Do not pile up timed-out account requests while their outcome is unknown.
				if (!this.pollTask) {
					const task = this.deps.supervise();
					this.pollTask = task;
					void task.then(
						() => {
							if (this.pollTask === task) this.pollTask = undefined;
						},
						() => {
							if (this.pollTask === task) this.pollTask = undefined;
						},
					);
				}
				const report = await withDeadline(this.pollTask, config.serviceTimeoutMs, "risk-supervision");
				this.observe(report);
				this.pollFailures = 0;
				this.nextPollAt = this.now() + config.pollIntervalMs;
				try {
					await this.evaluateWakes(report.snapshot);
				} catch (error) {
					state.recordFailure("wake-observation", failureCode(error));
				}
			} catch (error) {
				this.deps.block(`risk-supervision-${failureCode(error)}`);
				state.recordFailure("risk-supervision", failureCode(error));
				this.pollFailures++;
				this.nextPollAt =
					this.now() + Math.min(config.retryMaxMs, config.retryBaseMs * 2 ** Math.min(this.pollFailures - 1, 30));
				if (this.pollFailures >= config.maxAttempts) {
					state.mutate((state) => {
						state.control = "paused";
					});
				}
			}
		}
		if (state.read().control === "running" && !this.modelTask) {
			const decision = state.beginDecision();
			if (decision) {
				const abort = new AbortController();
				this.modelAbort = abort;
				const task = this.runDecision(decision, abort);
				this.modelTask = task;
				void task
					.finally(() => {
						if (this.modelTask === task) {
							this.modelTask = undefined;
							this.modelAbort = undefined;
						}
					})
					.catch((error) => {
						// Persistence failures cannot be turned into a successful turn.
						this.deps.block("decision-persistence-failed");
						console.error(`[autonomous] ${failureCode(error)}`);
						this.stopped = true;
					});
			}
		}
	}
	private observe(report: RiskSupervisionReport): void {
		const state = this.deps.state;
		state.mutate((current) => {
			current.heartbeat = this.now();
			const emitChange = (
				field: "lastAccountFingerprint" | "lastOrdersFingerprint" | "lastRiskFingerprint",
				value: unknown,
				kind: "position" | "fill" | "risk",
			): void => {
				const fingerprint = createHash("sha256").update(JSON.stringify(value)).digest("hex");
				const before = current[field];
				if (before !== fingerprint) {
					current[field] = fingerprint;
					if (before !== undefined || (kind === "risk" && report.reasons.length > 0)) {
						const queued = noteObservationEvent(current, {
							id: `${kind}-${current.sequence}-${fingerprint}`,
							kind,
							at: this.now(),
							message: `${kind} observation changed; query current authoritative facts. ${kind === "risk" ? report.reasons.join(", ") : ""}`,
							...(kind === "risk" && report.snapshot
								? {
										evidence: {
											source: report.snapshot.source,
											observedAt: report.snapshot.observedAt,
											equity: report.snapshot.equity,
											netExternalFlows: report.snapshot.netExternalFlows,
											marginUsed: report.snapshot.marginUsed,
											actions: report.actions,
										},
									}
								: {}),
						});
						if (queued === "dropped")
							current.failures.push({
								at: this.now(),
								source: `observation:${kind}`,
								reason: "event-backlog-full",
							});
					}
				}
			};
			if (report.snapshot) {
				emitChange(
					"lastAccountFingerprint",
					report.snapshot.positions.map((position) => [position.symbol, position.positionSide, position.amount]),
					"position",
				);
				emitChange(
					"lastOrdersFingerprint",
					report.snapshot.orders.map((order) => [
						order.symbol,
						order.id,
						order.filled,
						order.remaining,
						order.status,
					]),
					"fill",
				);
			}
			emitChange("lastRiskFingerprint", report.reasons, "risk");
			for (const action of report.actions.filter((action) => action.status !== "completed")) {
				current.failures.push({ at: this.now(), source: action.action, reason: action.reason ?? action.status });
			}
			current.failures = current.failures.slice(-100);
		});
	}
	private async evaluateWakes(snapshot?: AccountSnapshot): Promise<void> {
		const { state, config } = this.deps;
		const entry = findMonitoringScope(state.store.read(), state.scope);
		const triggers =
			entry?.triggers.filter(
				(trigger) =>
					entry.autonomous?.triggerIds.includes(trigger.definition.id) && trigger.state.status === "active",
			) ?? [];
		const keys = new Set<string>();
		for (const trigger of triggers) collectTriggerFactKeys(trigger.definition.when, keys);
		const facts: Record<string, FactValue> = {};
		for (const key of keys) {
			try {
				if (key.startsWith("price:")) {
					const ticker = await withDeadline(this.deps.ticker(key.slice(6)), config.serviceTimeoutMs, "wake-price");
					if (ticker.last !== undefined && Number.isFinite(ticker.last))
						facts[key] = { value: ticker.last, observedAt: ticker.timestamp };
				} else if (key.startsWith("position_pnl_pct:")) {
					const requested = parsePositionPnlFactKey(key);
					const positions = snapshot?.positions.filter(
						(position) =>
							position.symbol === requested.symbol &&
							(requested.positionSide === undefined || position.positionSide === requested.positionSide),
					);
					if (positions && positions.length > 1) throw new Error(`Ambiguous wake position fact: ${key}`);
					const position = positions?.[0];
					if (position?.unrealizedPnlPct !== undefined && snapshot)
						facts[key] = { value: position.unrealizedPnlPct, observedAt: snapshot.observedAt };
				} else throw new Error(`Unsupported wake fact: ${key}`);
			} catch (error) {
				state.recordFailure(`wake:${key}`, failureCode(error));
			}
		}
		state.store.transact((root) => {
			const entry = ensureMonitoringScope(root, state.scope, this.now());
			if (!entry.autonomous) throw new Error("Autonomous state missing");
			const observations = prepareTriggerFacts(entry, facts, this.now(), config.pollIntervalMs * 2);
			for (const trigger of entry.triggers) {
				if (!triggers.some((candidate) => candidate.revision === trigger.revision)) continue;
				const previous = { ...trigger.state };
				if (
					previous.lastEvaluationAt !== undefined &&
					this.now() - previous.lastEvaluationAt > config.pollIntervalMs * 2
				) {
					delete previous.stableSince;
					delete previous.stableSinceByPath;
				}
				const result = transitionObservedTrigger(
					trigger.definition,
					previous,
					observations.facts,
					observations.advanced,
					this.now(),
					{
						maxAgeMs: config.pollIntervalMs * 2,
						futureToleranceMs: 0,
					},
				);
				trigger.state = result.state;
				trigger.updatedAt = this.now();
				if (result.shouldFire) {
					const id = `${trigger.revision}-${result.state.lastFiredAt}`;
					const outcome = enqueueAutonomousEvent(entry.autonomous, {
						id,
						kind: trigger.definition.when.kind === "time" ? "timer" : "condition",
						at: this.now(),
						message: trigger.definition.then.message,
					});
					if (outcome === "dropped")
						entry.autonomous.failures.push({
							at: this.now(),
							source: `wake:${trigger.definition.id}`,
							reason: "event-backlog-full",
						});
				}
			}
			entry.autonomous.failures = entry.autonomous.failures.slice(-100);
		});
	}
	private async runDecision(decision: AutonomousDecision, abort: AbortController): Promise<void> {
		const { state, config } = this.deps;
		const context = JSON.stringify({
			objective: config.objective,
			event: decision.event,
			previousActions: decision.actions,
			summaries: state.read().summaries.slice(-20),
			unfinishedActions: state.read().unfinishedActions,
		});
		try {
			const text = await withDeadline(
				this.deps.model.run(decision, context, abort.signal),
				config.modelTimeoutMs,
				"model",
			);
			state.finishDecision(decision.id, text, "completed");
		} catch (error) {
			abort.abort(error);
			await this.deps.model.stop();
			const reason = failureCode(error);
			state.recordFailure("model", reason);
			const current = state.read().decision;
			if (!current || current.id !== decision.id) throw new Error("Decision progress changed during model failure");
			// Retry only observation-only rounds. A round with an attempted mutation
			// advances as failed rather than asking a fresh model to invent a second intent.
			if (current.actions.length || current.attempts >= config.maxAttempts || state.read().control !== "running") {
				state.finishDecision(
					decision.id,
					`Model round failed: ${reason}; attempted actions remain in execution/risk records.`,
					"failed",
				);
			} else
				state.mutate((state) => {
					if (!state.decision) throw new Error("Decision missing");
					state.decision.nextAttemptAt =
						this.now() +
						Math.min(config.retryMaxMs, config.retryBaseMs * 2 ** Math.min(current.attempts - 1, 30));
				});
		}
	}
	async run(signal: AbortSignal): Promise<void> {
		await this.initialize();
		while (!signal.aborted && !this.stopped) {
			await this.tick();
			if (this.stopped || signal.aborted) break;
			await new Promise<void>((resolve) => {
				const finish = (): void => {
					clearTimeout(timer);
					signal.removeEventListener("abort", finish);
					resolve();
				};
				const timer = setTimeout(finish, this.deps.config.pollIntervalMs);
				signal.addEventListener("abort", finish, { once: true });
			});
		}
		await this.stop();
	}
	async stop(): Promise<void> {
		this.stopped = true;
		this.modelAbort?.abort(new Error("Autonomous runtime stopped"));
		await this.deps.model.stop();
		await this.modelTask;
	}
	startEvent(): void {
		this.deps.state.enqueue({
			id: randomUUID(),
			kind: "start",
			at: this.now(),
			message:
				"Autonomous session started after execution reconciliation. Decide whether to research, trade, manage positions, or schedule a later wake.",
		});
	}
}
