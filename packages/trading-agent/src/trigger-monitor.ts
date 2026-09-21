import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Condition, type FactSnapshot, type FactValue, validateTriggerDefinition } from "@nikopack/ti-triggers";
import { getTrading } from "./context.ts";
import { failureCode } from "./failure-code.ts";
import { t, translate } from "./i18n.ts";
import {
	isFreshFirstDelivery,
	recordPollFailure,
	runtimeMatchesScope,
	sendMonitoringEvent,
	waitForIdleBeforeMutation,
} from "./monitor-shared.ts";
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
	recordMonitoringObservation,
	type StoredTrigger,
} from "./monitoring-state.ts";
import { errorMessage } from "./tools/format.ts";
import {
	collectTriggerFactKeys,
	parsePositionPnlFactKey,
	prepareTriggerFacts,
	transitionObservedTrigger,
} from "./trigger-facts.ts";

export interface TriggerMonitorOptions {
	store?: MonitoringStore;
	getScope?: (runtime: ReturnType<typeof getTrading>) => MonitoringScope;
}

function isAutonomousTrigger(trigger: StoredTrigger, triggerIds: readonly string[] | undefined): boolean {
	return triggerIds?.includes(trigger.definition.id) ?? false;
}

function validateMonitorFactKeys(condition: Condition): void {
	if ("fact" in condition) {
		if (condition.fact.key.startsWith("price:")) {
			if (condition.fact.key.slice("price:".length).trim() === "") throw new Error("price fact symbol is required");
		} else if (condition.fact.key.startsWith("position_pnl_pct:")) {
			parsePositionPnlFactKey(condition.fact.key);
		} else throw new Error(`unsupported fact key "${condition.fact.key}"`);
	}
	if ("conditions" in condition) for (const child of condition.conditions) validateMonitorFactKeys(child);
	if ("condition" in condition) validateMonitorFactKeys(condition.condition);
}

function warning(ctx: ExtensionContext, message: string): void {
	if (ctx.hasUI) ctx.ui.notify(translate(getTrading().config.language, "triggerWarning", { message }), "warning");
}

/** `/monitor trigger` subcommand: manage scoped durable read-only triggers. */
export function createTriggerCommandHandler(
	options: TriggerMonitorOptions = {},
): (args: string | undefined, ctx: ExtensionCommandContext) => Promise<void> {
	const store = options.store ?? createFileMonitoringStore();
	const getScope = options.getScope ?? monitoringScopeForRuntime;
	return async (args, ctx) => {
		const input = args?.trim() ?? "";
		const space = input.indexOf(" ");
		const command = space < 0 ? input : input.slice(0, space);
		const rest = space < 0 ? "" : input.slice(space + 1).trim();
		try {
			if (command === "add" || command === "remove" || command === "clear")
				await waitForIdleBeforeMutation(ctx, "triggerWaitingIdle");
			const scope = getScope(getTrading());
			if (command === "add") {
				if (!rest) throw new Error("add requires one-line JSON TriggerDefinition");
				const value: unknown = JSON.parse(rest);
				validateTriggerDefinition(value);
				validateMonitorFactKeys(value.when);
				store.transact((state) => {
					const entry = ensureMonitoringScope(state, scope, Date.now());
					if (entry.autonomous?.triggerIds.includes(value.id))
						throw new Error(`Cannot modify autonomous-owned trigger: ${value.id}`);
					const old = entry.triggers.find(
						(trigger) =>
							trigger.definition.id === value.id && !isAutonomousTrigger(trigger, entry.autonomous?.triggerIds),
					);
					entry.triggers = entry.triggers.filter((trigger) => trigger !== old);
					if (old) cancelTriggerNotifications(entry, [old.revision], Date.now());
					entry.triggers.push({
						definition: value,
						revision: randomUUID(),
						state: { status: "active", armed: true },
						updatedAt: Date.now(),
					});
				});
				if (ctx.hasUI)
					ctx.ui.notify(translate(getTrading().config.language, "triggerAdded", { id: value.id }), "info");
			} else if (command === "list") {
				const monitoring = findMonitoringScope(store.read(), scope);
				const triggers =
					monitoring?.triggers.filter(
						(trigger) => !isAutonomousTrigger(trigger, monitoring.autonomous?.triggerIds),
					) ?? [];
				if (ctx.hasUI)
					ctx.ui.notify(
						triggers.length === 0
							? t(getTrading().config.language, "triggerNone")
							: triggers.map(({ definition: d, state }) => `${d.id}: ${d.name} (${state.status})`).join("\n"),
						"info",
					);
			} else if (command === "remove" || command === "clear") {
				store.transact((state) => {
					const entry = ensureMonitoringScope(state, scope, Date.now());
					const removed = entry.triggers.filter(
						(trigger) =>
							!isAutonomousTrigger(trigger, entry.autonomous?.triggerIds) &&
							(command === "clear" || trigger.definition.id === rest),
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
					for (const trigger of entry.triggers) collectTriggerFactKeys(trigger.definition.when, keys);
					entry.facts = entry.facts.filter((fact) => keys.has(fact.key));
					entry.factHistory = entry.factHistory?.filter((history) => keys.has(history.key));
					if (entry.factHistory?.length === 0) delete entry.factHistory;
				});
			} else warning(ctx, "usage: /monitor trigger add <JSON>|list|remove <id>|clear");
		} catch (error) {
			warning(ctx, errorMessage(error));
		}
	};
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
			return runtimeMatchesScope(
				getScope,
				scope,
				(current) => current === trading && current.tradingEngine === engine && current.marketData === marketData,
			);
		};

		const factsFor = async (
			keys: Iterable<string>,
			ctx: ExtensionContext,
			engine: TradingEngine,
			marketData: MarketData,
			isCurrent: () => boolean,
		): Promise<{ facts: FactSnapshot; failed: boolean } | undefined> => {
			const requestedKeys = [...keys];
			const facts: Record<string, FactValue> = {};
			let failed = false;
			const report = (source: string, error: unknown): void => {
				failed = true;
				// Raw transport errors can echo authenticated request details; report only
				// the coarse failure class, mirroring the autonomous runtime.
				const message = `${source}: ${failureCode(error)}; observation is unknown`;
				console.error(`[trigger monitor] ${message}`);
				warning(ctx, message);
			};
			let positions: Awaited<ReturnType<TradingEngine["getPositions"]>> | undefined;
			let positionsObservedAt: number | undefined;
			if (requestedKeys.some((key) => key.startsWith("position_pnl_pct:"))) {
				try {
					positions = await engine.getPositions();
					positionsObservedAt = Date.now();
				} catch (error) {
					if (!isCurrent()) return undefined;
					report("positions", error);
				}
			}
			if (!isCurrent()) return undefined;
			for (const key of requestedKeys) {
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
					const requested = parsePositionPnlFactKey(key);
					const matches = (positions ?? []).filter((position) => {
						if (position.symbol !== requested.symbol) return false;
						return requested.positionSide === undefined || position.positionSide === requested.positionSide;
					});
					if (matches.length > 1) {
						failed = true;
						if (!warnedFactKeys.has(key)) {
							warnedFactKeys.add(key);
							warning(
								ctx,
								`ambiguous position fact "${key}"; use position_pnl_pct:${requested.symbol}:LONG or position_pnl_pct:${requested.symbol}:SHORT`,
							);
						}
						continue;
					}
					value = matches[0]?.unrealizedPnlPct;
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
						isFreshFirstDelivery(event, freshDeliveries) &&
						scope.mode !== "live" &&
						ctx.mode !== "print";
					sendMonitoringEvent(pi, event, "trigger", wake);
					return true;
				},
				isCurrent,
			);
			for (const failure of report.failures) {
				const message = `notification ${failure.eventId} delivery failed: ${failureCode(failure.error ?? "transport unavailable")}`;
				console.error(`[trigger monitor] ${message}`);
				try {
					warning(ctx, message);
				} catch (error) {
					console.error("[trigger monitor] delivery diagnostic failed:", failureCode(error));
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
				const monitoring = findMonitoringScope(store.read(), scope);
				const triggers =
					monitoring?.triggers.filter(
						(trigger) => !isAutonomousTrigger(trigger, monitoring.autonomous?.triggerIds),
					) ?? [];
				const keys = new Set<string>();
				for (const trigger of triggers)
					if (trigger.state.status === "active") collectTriggerFactKeys(trigger.definition.when, keys);
				const collected = await factsFor(keys, ctx, engine, marketData, isCurrent);
				if (!collected || !isCurrent()) return;
				const now = Date.now();
				const freshDeliveries = new Set<string>();
				store.transact((state) => {
					const entry = ensureMonitoringScope(state, capturedScope, now);
					const { facts, advanced, failed } = prepareTriggerFacts(
						entry,
						collected.facts,
						now,
						MONITORING_MAX_AGE_MS,
					);
					for (const trigger of entry.triggers) {
						if (!triggers.some((item) => item.revision === trigger.revision)) continue;
						const definition = trigger.definition;
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
						const result = transitionObservedTrigger(definition, previous, facts, advanced, now, {
							futureToleranceMs: 0,
						});
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
					const observed = Object.values(facts).map((fact) => fact.observedAt);
					recordMonitoringObservation(
						entry,
						"triggers",
						now,
						observed.length > 0 ? Math.min(...observed) : undefined,
						failed || collected.failed,
					);
				});
				deliver(scope, ctx, isCurrent, freshDeliveries);
			} catch (error) {
				if (isCurrent()) {
					// Raw transport errors can echo authenticated request details; report
					// only the coarse failure class, mirroring the autonomous runtime.
					const message = `poll failed: ${failureCode(error)}`;
					console.error(`[trigger monitor] ${message}`);
					warning(ctx, message);
					if (scope) {
						try {
							recordPollFailure(store, scope, "triggers");
						} catch (storageError) {
							warning(ctx, `state persistence failed: ${failureCode(storageError)}`);
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
