import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getTrading, type TradingRuntime } from "./context.ts";
import { type MenuKey, t } from "./i18n.ts";
import {
	ensureMonitoringScope,
	type MonitoringNotificationSource,
	type MonitoringScope,
	type MonitoringStore,
	monitoringScopeKey,
} from "./monitoring-state.ts";

/** getTrading() may throw once the runtime is closed; treat that as "not current". */
export function runtimeMatchesScope(
	getScope: (runtime: TradingRuntime) => MonitoringScope,
	scope: MonitoringScope,
	matches: (current: TradingRuntime) => boolean,
): boolean {
	try {
		const current = getTrading();
		return matches(current) && monitoringScopeKey(getScope(current)) === monitoringScopeKey(scope);
	} catch {
		return false;
	}
}

/** Record a failed poll in the scope's health without touching observations. */
export function recordPollFailure(
	store: MonitoringStore,
	scope: MonitoringScope,
	source: MonitoringNotificationSource,
): void {
	store.transact((state) => {
		const entry = ensureMonitoringScope(state, scope, Date.now());
		const health = entry.health[source] ?? {};
		entry.health[source] = health;
		health.lastPollAt = Date.now();
		health.lastFailureAt = Date.now();
		health.errorCode = "poll-failed";
	});
}

/** A notification wakes the agent only on its first delivery attempt by the run that enqueued it. */
export function isFreshFirstDelivery(
	event: { id: string; attempts: number },
	freshDeliveries: ReadonlySet<string>,
): boolean {
	return freshDeliveries.has(event.id) && event.attempts === 1;
}

export function sendMonitoringEvent(
	pi: ExtensionAPI,
	event: { id: string; content: string },
	customType: string,
	wake: boolean,
): void {
	pi.sendMessage(
		{
			customType,
			content: event.content,
			details: { monitoringEventId: event.id },
			display: true,
		},
		wake ? { triggerTurn: true, deliverAs: "followUp" } : { triggerTurn: false },
	);
}

export async function waitForIdleBeforeMutation(ctx: ExtensionCommandContext, noticeKey: MenuKey): Promise<void> {
	if (ctx.isIdle()) return;
	if (ctx.hasUI) ctx.ui.notify(t(getTrading().config.language, noticeKey), "info");
	await ctx.waitForIdle();
}
