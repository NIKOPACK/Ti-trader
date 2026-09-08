import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type Condition,
	evaluateCondition,
	type FactSnapshot,
	type FactValue,
	transitionTrigger,
	validateTriggerDefinition,
} from "@nikopack/ti-triggers";
import { getTrading } from "./context.ts";
import {
	cancelTriggerNotifications,
	createFileMonitoringStore,
	deliverMonitoringNotifications,
	enqueueMonitoringNotification,
	ensureMonitoringScope,
	findMonitoringScope,
	MONITORING_MAX_AGE_MS,
	type MonitoringScope,
	type MonitoringStore,
	monitoringScopeForRuntime,
	monitoringScopeKey,
	recordMonitoringObservation,
	type StoredTrigger,
} from "./monitoring-state.ts";

export interface TriggerMonitorOptions {
	store?: MonitoringStore;
	getScope?: (runtime: ReturnType<typeof getTrading>) => MonitoringScope;
}

function factKeys(condition: Condition, keys: Set<string>): void {
	switch (condition.kind) {
		case "compare":
		case "cross":
		case "change":
			keys.add(condition.fact.key);
			return;
		case "all":
		case "any":
			for (const child of condition.conditions) factKeys(child, keys);
			return;
		case "not":
		case "stable_for":
			factKeys(condition.condition, keys);
	}
}

function warning(ctx: ExtensionContext, message: string): void {
	if (ctx.hasUI) ctx.ui.notify(`Trigger: ${message}`, "warning");
}

async function waitForIdleBeforeMutation(ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.isIdle()) return;
	if (ctx.hasUI) ctx.ui.notify("Waiting for the active agent turn before changing triggers", "info");
	await ctx.waitForIdle();
}

export function createTriggerMonitorExtension(options: TriggerMonitorOptions = {}) {
	const store = options.store ?? createFileMonitoringStore();
	const getScope = options.getScope ?? monitoringScopeForRuntime;
	return (pi: ExtensionAPI): void => {
		type Trading = ReturnType<typeof getTrading>;
		type TradingEngine = Trading["tradingEngine"];
		type MarketData = Trading["marketData"];
		const warnedFactKeys = new Set<string>();
		let timer: ReturnType<typeof setTimeout> | undefined;
		let pollingKey: { token: number; engine: TradingEngine; marketData: MarketData } | undefined;
		let lifecycleToken = 0;

		const isActive = (
			trading: Trading,
			engine: TradingEngine,
			marketData: MarketData,
			scope: MonitoringScope,
			token: number,
		): boolean => {
			if (token !== lifecycleToken) return false;
			try {
				const current = getTrading();
				return (
					current === trading &&
					current.tradingEngine === engine &&
					current.marketData === marketData &&
					monitoringScopeKey(getScope(current)) === monitoringScopeKey(scope)
				);
			} catch {
				return false;
			}
		};

		const factsFor = async (
			triggers: StoredTrigger[],
			ctx: ExtensionContext,
			engine: TradingEngine,
			marketData: MarketData,
			isCurrent: () => boolean,
		): Promise<{ facts: FactSnapshot; failed: boolean } | undefined> => {
			const keys = new Set<string>();
			for (const trigger of triggers) if (trigger.state.status === "active") factKeys(trigger.definition.when, keys);
			const facts: Record<string, FactValue> = {};
			let failed = false;
			const report = (source: string, error: unknown): void => {
				failed = true;
				const message = `${source}: ${error instanceof Error ? error.message : String(error)}; observation is unknown`;
				console.error(`[trigger monitor] ${message}`);
				warning(ctx, message);
			};
			let positions: Awaited<ReturnType<TradingEngine["getPositions"]>> | undefined;
			let positionsObservedAt: number | undefined;
			if ([...keys].some((key) => key.startsWith("position_pnl_pct:"))) {
				try {
					positions = await engine.getPositions();
					positionsObservedAt = Date.now();
				} catch (error) {
					if (!isCurrent()) return undefined;
					report("positions", error);
				}
			}
			if (!isCurrent()) return undefined;
			for (const key of keys) {
				let value: number | undefined;
				let observedAt: number | undefined;
				if (key.startsWith("price:")) {
					try {
						const ticker = await marketData.getTicker(key.slice("price:".length));
						if (!isCurrent()) return undefined;
						value = ticker.last;
						observedAt = ticker.timestamp;
					} catch (error) {
						if (!isCurrent()) return undefined;
						report(key, error);
					}
				} else if (key.startsWith("position_pnl_pct:")) {
					value = positions?.find((p) => p.symbol === key.slice("position_pnl_pct:".length))?.unrealizedPnlPct;
					observedAt = positionsObservedAt;
				} else {
					failed = true;
					if (!warnedFactKeys.has(key)) {
						warnedFactKeys.add(key);
						warning(ctx, `unsupported fact key "${key}"; its value is unknown`);
					}
				}
				if (
					value === undefined ||
					!Number.isFinite(value) ||
					observedAt === undefined ||
					!Number.isFinite(observedAt) ||
					observedAt <= 0
				) {
					failed = true;
					continue;
				}
				facts[key] = { value, observedAt };
			}
			return { facts, failed };
		};

		const deliver = (
			scope: MonitoringScope,
			ctx: ExtensionContext,
			isCurrent: () => boolean,
			freshDeliveries = new Set<string>(),
		): void => {
			const actions = new Map(
				(findMonitoringScope(store.read(), scope)?.triggers ?? []).map((trigger) => [
					trigger.revision,
					trigger.definition.then.kind,
				]),
			);
			const report = deliverMonitoringNotifications(
				store,
				scope,
				"triggers",
				(event) => {
					const action = event.triggerRevision ? actions.get(event.triggerRevision) : undefined;
					if (!action) return true;
					for (const notice of event.notices) if (ctx.hasUI) ctx.ui.notify(notice, event.level);
					if (action === "notify") return ctx.hasUI;
					const wake =
						event.wake &&
						freshDeliveries.has(event.id) &&
						event.attempts === 1 &&
						scope.mode !== "live" &&
						ctx.mode !== "print";
					pi.sendMessage(
						{
							customType: "trigger",
							content: event.content,
							details: { monitoringEventId: event.id },
							display: true,
						},
						wake ? { triggerTurn: true, deliverAs: "followUp" } : { triggerTurn: false },
					);
					return true;
				},
				isCurrent,
			);
			for (const failure of report.failures) {
				const message = `notification ${failure.eventId} delivery failed: ${failure.error instanceof Error ? failure.error.message : String(failure.error ?? "notification transport unavailable")}`;
				console.error(`[trigger monitor] ${message}`);
				try {
					warning(ctx, message);
				} catch (error) {
					console.error("[trigger monitor] delivery diagnostic failed", error);
				}
			}
		};

		const poll = async (ctx: ExtensionContext, token = lifecycleToken): Promise<void> => {
			let isCurrent = (): boolean => token === lifecycleToken;
			let scope: MonitoringScope | undefined;
			let key: typeof pollingKey;
			try {
				const trading = getTrading();
				const engine = trading.tradingEngine;
				const marketData = trading.marketData;
				if (pollingKey?.token === token && pollingKey.engine === engine && pollingKey.marketData === marketData)
					return;
				scope = getScope(trading);
				const capturedScope = scope;
				isCurrent = () => isActive(trading, engine, marketData, capturedScope, token);
				if (!isCurrent()) return;
				key = { token, engine, marketData };
				pollingKey = key;
				deliver(scope, ctx, isCurrent);
				const triggers = findMonitoringScope(store.read(), scope)?.triggers ?? [];
				const collected = await factsFor(triggers, ctx, engine, marketData, isCurrent);
				if (!collected || !isCurrent()) return;
				const now = Date.now();
				const freshDeliveries = new Set<string>();
				store.transact((state) => {
					const entry = ensureMonitoringScope(state, capturedScope, now);
					const facts: Record<string, FactValue> = {};
					const advanced = new Set<string>();
					let failed = collected.failed;
					for (const [factKey, fact] of Object.entries(collected.facts)) {
						if (fact.observedAt > now || now - fact.observedAt > MONITORING_MAX_AGE_MS) {
							failed = true;
							continue;
						}
						const previous = entry.facts.find((item) => item.key === factKey);
						if (previous && fact.observedAt < previous.observedAt) continue;
						const isNew = !previous || fact.observedAt > previous.observedAt;
						const baseline =
							isNew && previous && now - previous.observedAt <= MONITORING_MAX_AGE_MS ? previous : undefined;
						facts[factKey] = {
							...fact,
							previousValue: baseline?.value,
							previousObservedAt: baseline?.observedAt,
						};
						if (isNew) advanced.add(factKey);
					}
					for (const trigger of entry.triggers) {
						if (!triggers.some((item) => item.revision === trigger.revision)) continue;
						const definition = trigger.definition;
						const keys = new Set<string>();
						factKeys(definition.when, keys);
						const previous = { ...trigger.state };
						if (previous.lastEvaluationAt !== undefined && previous.lastEvaluationAt >= now) continue;
						// A long observation gap cannot prove continuous truth. Cooldown and
						// edge arming survive; only continuity evidence is discarded.
						if (
							previous.lastEvaluationAt !== undefined &&
							now - previous.lastEvaluationAt > Math.max(5, trading.config.monitor.intervalSec) * 2000
						) {
							delete previous.stableSince;
							delete previous.stableSinceByPath;
						}
						if (definition.when.kind === "time" && now - Date.parse(definition.when.at) > MONITORING_MAX_AGE_MS) {
							trigger.state = { ...previous, status: "expired", lastEvaluationAt: now };
							continue;
						}
						const result = transitionTrigger(definition, previous, facts, now, { futureToleranceMs: 0 });
						if (result.evaluation.state === "unknown") result.state.armed = previous.armed;
						// Keep continuity invalidation even without new facts. Repeated
						// snapshots cannot fire again unless clock branches independently
						// establish truth under the same nested evaluator semantics.
						if (
							result.shouldFire &&
							keys.size > 0 &&
							![...keys].some((factKey) => advanced.has(factKey)) &&
							evaluateCondition(
								definition.when,
								{},
								now,
								previous.stableSince,
								{ futureToleranceMs: 0 },
								previous.stableSinceByPath,
							).state !== "true"
						) {
							result.shouldFire = false;
							result.state = {
								...result.state,
								status: previous.status,
								lastFiredAt: previous.lastFiredAt,
								armed: previous.armed,
							};
						}
						trigger.state = result.state;
						trigger.updatedAt = now;
						if (!result.shouldFire) continue;
						const action = definition.then;
						const live = capturedScope.mode === "live";
						const id = enqueueMonitoringNotification(
							entry,
							{
								source: "triggers",
								customType: "trigger",
								content: `[trigger:${definition.id}] ${action.message}`,
								notices:
									action.kind === "notify" || live
										? [
												`Trigger ${definition.name}: ${action.message}${live && action.kind === "wake_agent" ? " (live: notify only)" : ""}`,
											]
										: [],
								level: "info",
								wake: action.kind === "wake_agent" && !live,
								triggerRevision: trigger.revision,
							},
							now,
							Math.min(
								now + MONITORING_MAX_AGE_MS,
								definition.policy?.expiresAt ? Date.parse(definition.policy.expiresAt) : Infinity,
							),
						);
						trigger.lastDeliveryId = id;
						freshDeliveries.add(id);
					}
					const activeKeys = new Set<string>();
					for (const trigger of entry.triggers) factKeys(trigger.definition.when, activeKeys);
					const nextFacts = new Map(
						entry.facts.filter((fact) => activeKeys.has(fact.key)).map((fact) => [fact.key, fact]),
					);
					for (const factKey of advanced) {
						const fact = facts[factKey];
						if (activeKeys.has(factKey) && typeof fact.value === "number")
							nextFacts.set(factKey, { key: factKey, value: fact.value, observedAt: fact.observedAt });
					}
					entry.facts = [...nextFacts.values()];
					const observed = Object.values(facts).map((fact) => fact.observedAt);
					recordMonitoringObservation(
						entry,
						"triggers",
						now,
						observed.length > 0 ? Math.min(...observed) : undefined,
						failed,
					);
				});
				deliver(scope, ctx, isCurrent, freshDeliveries);
			} catch (error) {
				if (isCurrent()) {
					console.error("[trigger monitor] poll failed", error);
					warning(ctx, error instanceof Error ? error.message : String(error));
					if (scope) {
						try {
							const capturedScope = scope;
							store.transact((state) => {
								const health = ensureMonitoringScope(state, capturedScope, Date.now()).health.triggers;
								health.lastPollAt = Date.now();
								health.lastFailureAt = Date.now();
								health.errorCode = "poll-failed";
							});
						} catch (storageError) {
							warning(ctx, `state persistence failed: ${String(storageError)}`);
						}
					}
				}
			} finally {
				if (pollingKey === key) pollingKey = undefined;
			}
		};

		const schedulePoll = (ctx: ExtensionContext, token: number): void => {
			if (token !== lifecycleToken) return;
			let intervalMs: number;
			try {
				intervalMs = Math.max(5, getTrading().config.monitor.intervalSec) * 1000;
			} catch {
				return;
			}
			timer = setTimeout(() => {
				timer = undefined;
				void poll(ctx, token).finally(() => schedulePoll(ctx, token));
			}, intervalMs);
			timer.unref?.();
		};

		pi.registerCommand("trigger", {
			description: "Manage scoped durable read-only triggers: /trigger add|list|remove|clear",
			handler: async (args, ctx) => {
				const input = args?.trim() ?? "";
				const space = input.indexOf(" ");
				const command = space < 0 ? input : input.slice(0, space);
				const rest = space < 0 ? "" : input.slice(space + 1).trim();
				try {
					if (command === "add" || command === "remove" || command === "clear")
						await waitForIdleBeforeMutation(ctx);
					const scope = getScope(getTrading());
					if (command === "add") {
						if (!rest) throw new Error("add requires one-line JSON TriggerDefinition");
						const value: unknown = JSON.parse(rest);
						validateTriggerDefinition(value);
						store.transact((state) => {
							const entry = ensureMonitoringScope(state, scope, Date.now());
							const old = entry.triggers.find((trigger) => trigger.definition.id === value.id);
							entry.triggers = entry.triggers.filter((trigger) => trigger !== old);
							if (old) cancelTriggerNotifications(entry, [old.revision], Date.now());
							entry.triggers.push({
								definition: value,
								revision: randomUUID(),
								state: { status: "active", armed: true },
								updatedAt: Date.now(),
							});
						});
						if (ctx.hasUI) ctx.ui.notify(`Trigger added: ${value.id}`, "info");
					} else if (command === "list") {
						const triggers = findMonitoringScope(store.read(), scope)?.triggers ?? [];
						if (ctx.hasUI)
							ctx.ui.notify(
								triggers.length === 0
									? "No triggers"
									: triggers
											.map(({ definition: d, state }) => `${d.id}: ${d.name} (${state.status})`)
											.join("\n"),
								"info",
							);
					} else if (command === "remove" || command === "clear") {
						store.transact((state) => {
							const entry = ensureMonitoringScope(state, scope, Date.now());
							const removed = entry.triggers.filter(
								(trigger) => command === "clear" || trigger.definition.id === rest,
							);
							if (command === "remove" && (!rest || removed.length === 0))
								throw new Error(`Trigger not found: ${rest}`);
							entry.triggers = entry.triggers.filter((trigger) => !removed.includes(trigger));
							cancelTriggerNotifications(
								entry,
								removed.map((trigger) => trigger.revision),
								Date.now(),
							);
							const keys = new Set<string>();
							for (const trigger of entry.triggers) factKeys(trigger.definition.when, keys);
							entry.facts = entry.facts.filter((fact) => keys.has(fact.key));
						});
					} else warning(ctx, "usage: /trigger add <JSON>|list|remove <id>|clear");
				} catch (error) {
					warning(ctx, error instanceof Error ? error.message : String(error));
				}
			},
		});

		pi.on("session_start", async (_event, ctx) => {
			lifecycleToken += 1;
			pollingKey = undefined;
			warnedFactKeys.clear();
			if (timer) clearTimeout(timer);
			timer = undefined;
			const token = lifecycleToken;
			await poll(ctx, token);
			if (token === lifecycleToken) schedulePoll(ctx, token);
		});
		pi.on("session_shutdown", async () => {
			lifecycleToken += 1;
			pollingKey = undefined;
			if (timer) clearTimeout(timer);
			timer = undefined;
			warnedFactKeys.clear();
		});
	};
}
