import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Order, type Position, protectionCoverage, reduceSide } from "@nikopack/ti-trading-engine";
import { getTrading } from "./context.ts";
import {
	createFileMonitoringStore,
	deliverMonitoringNotifications,
	enqueueMonitoringNotification,
	ensureMonitoringScope,
	findMonitoringScope,
	MONITORING_MAX_AGE_MS,
	type MonitoredOrder,
	type MonitoringScope,
	type MonitoringScopeState,
	type MonitoringStore,
	monitoringScopeForRuntime,
	monitoringScopeKey,
	recordMonitoringObservation,
} from "./monitoring-state.ts";
import { openTradingSettings } from "./settings-menu.ts";

export { isProtection, protectionCoverage, reduceSide } from "@nikopack/ti-trading-engine";

const MAX_MISSING_HISTORY_CHECKS = 3;
const MAX_TRACKED_UNRESOLVED_ORDERS = 256;

function describeFill(order: Order): string {
	const price = order.average ?? order.price ?? order.stopPrice;
	const filledAmount = order.filled > 0 ? order.filled : order.amount;
	return (
		`${order.side.toUpperCase()} ${filledAmount} ${order.symbol} (${order.type})` +
		(price !== undefined ? ` filled @ ${price}` : " filled") +
		(order.cost ? `, cost ${order.cost.toFixed(2)}` : "") +
		(order.status !== "closed" ? `, final status ${order.status}` : "") +
		(order.ocoGroup ? ` [OCO ${order.ocoGroup}, sibling cancelled]` : "")
	);
}

function describePosition(p: Position): string {
	const pnl =
		p.unrealizedPnlPct !== undefined
			? ` PnL ${p.unrealizedPnlPct >= 0 ? "+" : ""}${p.unrealizedPnlPct.toFixed(2)}%` +
				(p.unrealizedPnl !== undefined ? ` (${p.unrealizedPnl.toFixed(2)})` : "")
			: "";
	const entry = p.avgEntryPrice !== undefined ? ` entry ${p.avgEntryPrice}` : "";
	const valuation =
		p.quoteValue !== undefined && Number.isFinite(p.quoteValue)
			? `~${p.quoteValue.toFixed(2)} quote`
			: `quote valuation unavailable${p.valuationReason ? ` (${p.valuationReason})` : ""}`;
	return `${p.symbol}${p.positionSide ? ` ${p.positionSide}` : ""} ${p.amount} (${valuation})${entry}${pnl}`;
}

function positionIdentity(position: Position): string {
	return `${position.symbol}:${position.positionSide ?? (position.amount < 0 ? "SHORT" : "LONG")}`;
}

function orderIdentity(order: MonitoredOrder): string {
	return `${order.symbol}:${order.id}`;
}

export interface OrderMonitorOptions {
	store?: MonitoringStore;
	getScope?: (runtime: ReturnType<typeof getTrading>) => MonitoringScope;
}

/** Durable observations and bounded notification retries do not authorize trading. */
export function createOrderMonitorExtension(options: OrderMonitorOptions = {}) {
	const store = options.store ?? createFileMonitoringStore();
	const getScope = options.getScope ?? monitoringScopeForRuntime;
	return (pi: ExtensionAPI): void => {
		type Trading = ReturnType<typeof getTrading>;
		type TradingEngine = Trading["tradingEngine"];
		let timer: ReturnType<typeof setInterval> | undefined;
		let pollingKey: { token: number; engine: TradingEngine } | undefined;
		let lifecycleToken = 0;
		let trackedTrading: Trading | undefined;
		let trackedEngine: TradingEngine | undefined;
		let lastPollAt = 0;
		let observedScope: string | undefined;
		let trackedScope: string | undefined;
		const openEvidence = new Map<string, number>();
		let lastError: { message: string; reportedAt: number } | undefined;

		const resetTracking = (): void => {
			lastError = undefined;
			lastPollAt = 0;
			observedScope = undefined;
			trackedScope = undefined;
			openEvidence.clear();
		};

		const isActive = (trading: Trading, engine: TradingEngine, scope: MonitoringScope, token: number): boolean => {
			if (token !== lifecycleToken) return false;
			try {
				const current = getTrading();
				return (
					current === trading &&
					current.tradingEngine === engine &&
					current.config.monitor.enabled &&
					monitoringScopeKey(getScope(current)) === monitoringScopeKey(scope)
				);
			} catch {
				return false;
			}
		};

		const reportError = (ctx: ExtensionContext, scope: string, error: unknown): void => {
			const message = `${scope}: ${error instanceof Error ? error.message : String(error)}`;
			const now = Date.now();
			if (lastError?.message === message && now - lastError.reportedAt < 60_000) return;
			lastError = { message, reportedAt: now };
			console.error(`[order monitor] ${message}`);
			if (ctx.hasUI) ctx.ui.notify(`Order monitor error: ${message}`, "warning");
		};

		const recordFills = (
			entry: MonitoringScopeState,
			open: Order[],
			histories: Map<string, Order[] | Error>,
			now: number,
			wake: boolean,
			warnings: string[],
			freshDeliveries: Set<string>,
		): void => {
			const orders = entry.orders;
			const known = new Map(orders.known.map((order) => [orderIdentity(order), order]));
			const missing = new Map(orders.missing.map((item) => [item.key, item]));
			const openIds = new Set(open.map(orderIdentity));
			for (const id of openIds) missing.delete(id);
			const nextKnown = new Map(open.map((order) => [orderIdentity(order), { id: order.id, symbol: order.symbol }]));
			if (!orders.seeded) {
				orders.seeded = true;
				orders.known = [...nextKnown.values()];
				return;
			}
			const disappeared = [...known.values()].filter((o) => !openIds.has(orderIdentity(o)));
			const fills = new Map<boolean, Order[]>();
			for (const gone of disappeared) {
				const id = orderIdentity(gone);
				const history = histories.get(gone.symbol);
				const tracked = missing.get(id) ?? { key: id, checks: 0, warned: false, since: now };
				if (!history || history instanceof Error) {
					missing.set(id, tracked);
					nextKnown.set(id, gone);
					continue;
				}
				const final = history.find((h) => h.id === gone.id && h.symbol === gone.symbol);
				if (
					final &&
					final.status !== "open" &&
					final.status !== "unknown" &&
					(final.status === "closed" || final.filled > 0)
				) {
					missing.delete(id);
					const observedAt = openEvidence.get(id);
					const wakeFill =
						wake && observedAt !== undefined && observedAt <= now && now - observedAt <= MONITORING_MAX_AGE_MS;
					const group = fills.get(wakeFill) ?? [];
					group.push(final);
					fills.set(wakeFill, group);
				} else if (!final || final.status === "open" || final.status === "unknown") {
					if (!final) {
						tracked.checks = Math.min(tracked.checks + 1, MAX_MISSING_HISTORY_CHECKS);
						if (tracked.checks >= MAX_MISSING_HISTORY_CHECKS && !tracked.warned) {
							tracked.warned = true;
							warnings.push(
								`order ${gone.id} status unresolved after ${MAX_MISSING_HISTORY_CHECKS} history checks`,
							);
						}
					} else if (final.status === "unknown" && !tracked.warned) {
						tracked.warned = true;
						warnings.push(`unknown final status for order ${gone.id}`);
					}
					missing.set(id, tracked);
					nextKnown.set(id, gone);
				} else {
					missing.delete(id);
				}
			}
			const trackedUnresolved = [...missing.values()].sort((left, right) => left.since - right.since);
			for (const dropped of trackedUnresolved.slice(0, -MAX_TRACKED_UNRESOLVED_ORDERS)) {
				nextKnown.delete(dropped.key);
				missing.delete(dropped.key);
				warnings.push(`dropping unresolved order ${dropped.key}: tracking limit reached`);
			}
			orders.known = [...nextKnown.values()];
			orders.missing = [...missing.values()];
			// A recovered fill must not join a waking batch just because another
			// order in the same history response was observed open by this run.
			for (const [wakeFill, group] of fills) {
				const lines = group.map(describeFill);
				const id = enqueueMonitoringNotification(
					entry,
					{
						source: "orders",
						customType: "order-fill",
						content:
							`[order monitor] ${group.length === 1 ? "An order" : `${group.length} orders`} filled:\n` +
							lines.map((l) => `- ${l}`).join("\n") +
							"\nReassess the position: check balances/positions and decide whether to protect or follow up.",
						notices: lines.map((line) => `Order filled: ${line}`),
						level: "info",
						wake: wakeFill,
					},
					now,
				);
				freshDeliveries.add(id);
			}
		};

		const deliver = (
			scope: MonitoringScope,
			ctx: ExtensionContext,
			isCurrent: () => boolean,
			freshDeliveries = new Set<string>(),
		): void => {
			const report = deliverMonitoringNotifications(
				store,
				scope,
				"orders",
				(event) => {
					for (const notice of event.notices) if (ctx.hasUI) ctx.ui.notify(notice, event.level);
					const wake =
						event.wake &&
						freshDeliveries.has(event.id) &&
						event.attempts === 1 &&
						ctx.hasUI &&
						ctx.mode !== "print";
					pi.sendMessage(
						{
							customType: event.customType,
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
				try {
					reportError(
						ctx,
						`notification ${failure.eventId} delivery failed`,
						failure.error ?? "notification transport unavailable",
					);
				} catch (error) {
					console.error("[order monitor] delivery diagnostic failed", error);
				}
			}
		};

		const recordGuards = (
			entry: MonitoringScopeState,
			trading: Trading,
			open: Order[],
			positions: Position[],
			now: number,
			wake: boolean,
			freshDeliveries: Set<string>,
		): void => {
			const cfg = trading.config.monitor;
			const guardState = new Map(
				entry.orders.guards.map((guard) => [
					guard.key,
					{ firstSeenAt: guard.firstSeenAt, lastAlertAt: guard.lastAlertAt },
				]),
			);
			const alerts: string[] = [];
			const unprotectedKeys = new Set<string>();
			const activePositionIdentities = new Set<string>();

			for (const p of positions) {
				activePositionIdentities.add(positionIdentity(p));
				const coverages = open.map((order) => ({
					order,
					coverage: protectionCoverage(order, p, cfg.protectionCoveragePct, trading.config.positionMode),
				}));
				const protections = coverages.filter((item) => item.coverage === "protected").map((item) => item.order);
				const partiallyProtected = coverages.some((item) => item.coverage === "partial");
				const cooldownMs = cfg.alertCooldownSec * 1000;

				if (protections.length === 0) {
					// Grace of one poll interval so the agent can place a bracket right after entry.
					const key = `${positionIdentity(p)}:unprotected`;
					unprotectedKeys.add(key);
					const st = guardState.get(key) ?? { firstSeenAt: undefined, lastAlertAt: undefined };
					st.firstSeenAt ??= now;
					guardState.set(key, st);
					const grace = Math.max(5, cfg.intervalSec) * 1000;
					const cooled = st.lastAlertAt === undefined || now - st.lastAlertAt >= cooldownMs;
					if (now - st.firstSeenAt >= grace && cooled) {
						st.lastAlertAt = now;
						alerts.push(
							`${partiallyProtected ? "PARTIALLY PROTECTED" : "UNPROTECTED"}: ${describePosition(p)} has ` +
								(partiallyProtected
									? "stop-loss coverage below the configured threshold. "
									: "no stop-loss order. ") +
								`Place protection (place_oco, or a ${reduceSide(p)} stop_market at your invalidation level) ` +
								"or briefly tell the user why you are leaving it unprotected.",
						);
					}
				}

				if (p.unrealizedPnlPct !== undefined && p.unrealizedPnlPct <= -cfg.alertLossPct) {
					const key = `${positionIdentity(p)}:drawdown`;
					const st = guardState.get(key) ?? { firstSeenAt: undefined, lastAlertAt: undefined };
					const cooled = st.lastAlertAt === undefined || now - st.lastAlertAt >= cooldownMs;
					if (cooled) {
						st.lastAlertAt = now;
						guardState.set(key, st);
						alerts.push(
							`DRAWDOWN: ${describePosition(p)} breached the -${cfg.alertLossPct}% alert threshold. ` +
								(protections.length > 0
									? `Existing protection: ${protections.map((o) => `${o.type} @ ${o.stopPrice ?? o.price ?? "?"}`).join(", ")}. `
									: "No stop-loss in place. ") +
								"Reassess now: cut the loss, tighten the stop, or hold — then report your decision and reasoning to the user.",
						);
					}
				}
			}

			// A position that regained protection restarts its grace period next time;
			// a closed position must not carry alert cooldowns into a later re-entry.
			for (const key of [...guardState.keys()]) {
				const suffix = key.endsWith(":unprotected")
					? ":unprotected"
					: key.endsWith(":drawdown")
						? ":drawdown"
						: undefined;
				if (suffix === undefined) continue;
				const identity = key.slice(0, -suffix.length);
				if (!activePositionIdentities.has(identity) || (suffix === ":unprotected" && !unprotectedKeys.has(key)))
					guardState.delete(key);
			}
			entry.orders.guards = [...guardState].map(([key, state]) => ({ key, ...state }));
			if (alerts.length === 0) return;
			const id = enqueueMonitoringNotification(
				entry,
				{
					source: "orders",
					customType: "position-alert",
					content:
						"[position guard] Attention needed on open positions:\n" +
						alerts.map((a) => `- ${a}`).join("\n") +
						"\nAct on this now (protect, adjust, or close via the trading tools) or report to the user why no action is needed.",
					notices: alerts.map((alert) => `Position guard: ${alert}`),
					level: "warning",
					wake,
				},
				now,
			);
			freshDeliveries.add(id);
		};

		const poll = async (ctx: ExtensionContext, token = lifecycleToken): Promise<void> => {
			let isCurrent = (): boolean => token === lifecycleToken;
			let scope: MonitoringScope | undefined;
			let key: typeof pollingKey;
			try {
				const trading = getTrading();
				const engine = trading.tradingEngine;
				if (pollingKey?.token === token && pollingKey.engine === engine) return;
				if (trackedTrading !== trading || trackedEngine !== engine) {
					resetTracking();
					trackedTrading = trading;
					trackedEngine = engine;
				}
				const cfg = trading.config.monitor;
				if (!cfg.enabled) return;
				scope = getScope(trading);
				const capturedScope = scope;
				const scopeKey = monitoringScopeKey(scope);
				if (trackedScope !== scopeKey) {
					resetTracking();
					trackedScope = scopeKey;
				}
				isCurrent = () => isActive(trading, engine, capturedScope, token);
				if (!isCurrent()) return;
				const intervalMs = Math.max(5, cfg.intervalSec) * 1000;
				const startedAt = Date.now();
				if (lastPollAt !== 0 && startedAt - lastPollAt < intervalMs) return;
				key = { token, engine };
				pollingKey = key;
				lastPollAt = startedAt;
				deliver(scope, ctx, isCurrent);
				const baseline = findMonitoringScope(store.read(), scope)?.orders;
				const open = await engine.getOpenOrders();
				if (!isCurrent()) return;
				const openObservedAt = Date.now();
				const openIds = new Set(open.map(orderIdentity));
				const disappeared = baseline?.known.filter((order) => !openIds.has(orderIdentity(order))) ?? [];
				const histories = new Map<string, Order[] | Error>();
				let failed = false;
				for (const symbol of new Set(disappeared.map((order) => order.symbol))) {
					try {
						histories.set(symbol, await engine.getOrderHistory(symbol, 50));
					} catch (error) {
						if (!isCurrent()) return;
						failed = true;
						reportError(ctx, `history query failed for ${symbol}`, error);
						histories.set(symbol, new Error("history query failed"));
					}
					if (!isCurrent()) return;
				}
				let positions: Position[] | undefined;
				if (cfg.guardPositions) {
					try {
						positions = await engine.getPositions();
					} catch (error) {
						if (!isCurrent()) return;
						failed = true;
						reportError(ctx, "positions query failed", error);
					}
				}
				if (!isCurrent()) return;
				const now = Date.now();
				if (now < openObservedAt || now - openObservedAt > MONITORING_MAX_AGE_MS)
					throw new Error("Open-order observation became stale during collection");
				for (const [id, observedAt] of openEvidence) {
					if (observedAt > now || now - observedAt > MONITORING_MAX_AGE_MS) openEvidence.delete(id);
				}
				for (const order of open) {
					if (order.status === "open") openEvidence.set(orderIdentity(order), openObservedAt);
				}
				const freshDeliveries = new Set<string>();
				const observation = store.transact((state) => {
					const entry = ensureMonitoringScope(state, capturedScope, now);
					if (entry.orders.cursor !== undefined && entry.orders.cursor >= startedAt) return undefined;
					const warnings: string[] = [];
					const uninterrupted =
						observedScope === scopeKey &&
						entry.orders.cursor !== undefined &&
						now - entry.orders.cursor <= MONITORING_MAX_AGE_MS;
					const wakeGuards = cfg.wakeAgent && (uninterrupted || !entry.orders.seeded);
					// Merge observations into the latest state, never a pre-await copy.
					recordFills(entry, open, histories, now, cfg.wakeAgent, warnings, freshDeliveries);
					if (positions) recordGuards(entry, trading, open, positions, now, wakeGuards, freshDeliveries);
					entry.orders.cursor = startedAt;
					recordMonitoringObservation(
						entry,
						"orders",
						now,
						openObservedAt,
						failed || warnings.length > 0 || entry.orders.missing.length > 0,
					);
					return { warnings, knownIds: entry.orders.known.map(orderIdentity) };
				});
				if (observation !== undefined) {
					observedScope = scopeKey;
					const knownIds = new Set(observation.knownIds);
					for (const id of openEvidence.keys()) if (!knownIds.has(id)) openEvidence.delete(id);
				}
				for (const message of observation?.warnings ?? []) reportError(ctx, message, "observation unresolved");
				deliver(scope, ctx, isCurrent, freshDeliveries);
			} catch (error) {
				if (isCurrent()) {
					reportError(ctx, "poll failed", error);
					if (scope) {
						try {
							const capturedScope = scope;
							store.transact((state) => {
								const health = ensureMonitoringScope(state, capturedScope, Date.now()).health.orders;
								health.lastPollAt = Date.now();
								health.lastFailureAt = Date.now();
								health.errorCode = "poll-failed";
							});
						} catch (storageError) {
							reportError(ctx, "state persistence failed", storageError);
						}
					}
				}
			} finally {
				if (pollingKey === key) pollingKey = undefined;
			}
		};

		pi.registerCommand("monitor", {
			description: "Order fill monitor & position guard: /monitor [on|off]",
			handler: async (args, ctx) => {
				const arg = args?.trim();
				if (!arg) {
					await openTradingSettings(ctx, () => {});
					return;
				}
				const trading = getTrading();
				if (arg === "on" || arg === "off") {
					await trading.patchConfig({ monitor: { enabled: arg === "on" } });
				} else if (arg !== "status") {
					ctx.ui.notify("Usage: /monitor [on|off]", "warning");
					return;
				}
				const cfg = trading.config.monitor;
				const status = cfg.enabled ? "on" : "off";
				const known = findMonitoringScope(store.read(), getScope(trading))?.orders.known ?? [];
				ctx.ui.notify(
					`Order monitor ${status} (interval ${cfg.intervalSec}s, wakeAgent ${cfg.wakeAgent}, watching ${known.length} open orders; ` +
						`position guard ${cfg.guardPositions ? "on" : "off"}, loss alert -${cfg.alertLossPct}%, cooldown ${cfg.alertCooldownSec}s)`,
					"info",
				);
			},
		});

		pi.on("session_start", async (_event, ctx) => {
			lifecycleToken += 1;
			pollingKey = undefined;
			resetTracking();
			if (timer) clearInterval(timer);
			const token = lifecycleToken;
			await poll(ctx, token); // seed the open-order snapshot when enabled
			if (token !== lifecycleToken) return;
			timer = setInterval(() => void poll(ctx, token), 5_000);
			// Never keep the process alive just for the monitor (print mode).
			timer.unref?.();
		});

		pi.on("session_shutdown", async () => {
			lifecycleToken += 1;
			pollingKey = undefined;
			if (timer) clearInterval(timer);
			timer = undefined;
			trackedTrading = undefined;
			trackedEngine = undefined;
			resetTracking();
		});
	};
}
