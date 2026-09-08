import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getTrading } from "./context.ts";
import { type MenuKey, t, translate } from "./i18n.ts";
import {
	createFileMonitoringStore,
	type MonitoringStore,
	monitoringScopeForRuntime,
	readMonitoringHealth,
} from "./monitoring-state.ts";
import { assessOperationalHealth } from "./operational-health.ts";
import type { TradingLanguage } from "./state.ts";
import { renderTradingTable, type TableData } from "./table.ts";

const HEALTH_LABELS: Readonly<Partial<Record<string, MenuKey>>> = {
	"new-exposure-paused": "healthPaused",
	"account-maintenance": "healthMaintenance",
	"stale-runtime": "healthStaleRuntime",
	"unresolved-executions": "healthExecutionBlock",
	"unsettled-risk-reservations": "healthReservationBlock",
	orders: "healthOrders",
	triggers: "healthTriggers",
	disabled: "healthDisabled",
	unknown: "healthUnknown",
	degraded: "healthDegraded",
	stale: "healthStale",
	recent: "healthRecent",
	"recent-observations": "healthRecentObservations",
};

export function readOperationalHealth(store: MonitoringStore = createFileMonitoringStore()) {
	const trading = getTrading();
	const execution = trading.getExecutionStatus();
	const pause = trading.tradingEngine.risk.usage().newExposurePause;
	const pending = trading.tradingEngine.risk.listPendingReservations();
	const observations = readMonitoringHealth(store, monitoringScopeForRuntime(trading));
	return assessOperationalHealth({
		mode: trading.mode,
		exchange: trading.config.exchange,
		marketType: trading.config.marketType,
		newExposurePaused: pause !== undefined,
		maintenanceActive: execution.maintenance !== undefined,
		staleRuntime: execution.admission.stale,
		unresolvedExecutions: execution.unresolved.length,
		pendingReservations: pending.length,
		maxObservationAgeMs: 5 * 60_000,
		observations: observations.map((observation) => ({
			source: observation.source,
			enabled:
				observation.source === "triggers"
					? observation.activeTriggers > 0 || observation.pendingNotifications > 0
					: trading.config.monitor.enabled || observation.pendingNotifications > 0,
			lastSuccessAt: observation.lastObservationAt,
			lastFailureAt: observation.lastFailureAt,
			errorCode: observation.errorCode,
			pendingNotifications: observation.pendingNotifications,
		})),
	});
}

export function createOperationalHealthExtension(
	readHealth = readOperationalHealth,
	getLanguage: () => TradingLanguage = () => getTrading().config.language,
) {
	return (pi: ExtensionAPI): void => {
		pi.registerEntryRenderer<TableData>("trading:health", (entry, _opts, theme) =>
			renderTradingTable(entry.data ?? { title: "health", lines: [] }, theme),
		);
		pi.registerCommand("health", {
			description: t("en-US", "cmdHealth"),
			handler: async (args, ctx) => {
				const language = getLanguage();
				if (args.trim()) {
					ctx.ui.notify(t(language, "healthUsage"), "warning");
					return;
				}
				const localize = (value: string) => {
					const key = HEALTH_LABELS[value];
					return key ? t(language, key) : value;
				};
				try {
					const health = readHealth();
					pi.appendEntry<TableData>("trading:health", {
						title: t(language, "healthTitle"),
						lines: [
							`${health.mode.toUpperCase()}  ${health.exchange}  ${health.marketType}`,
							translate(language, "healthEntryBlocks", {
								blocks: health.blockers.map(localize).join(", ") || t(language, "healthNone"),
							}),
							translate(language, "healthUnresolved", { count: health.unresolvedExecutions }),
							translate(language, "healthReservations", { count: health.pendingReservations }),
							translate(language, "healthConnectivity", { status: localize(health.connectivity) }),
							...health.observations.map((observation) =>
								translate(language, "healthObservation", {
									source: localize(observation.source),
									status: localize(observation.status),
									count: observation.pendingNotifications,
									error: observation.errorCode ? `; ${observation.errorCode}` : "",
								}),
							),
							t(language, "healthSemantics"),
						],
						warning:
							health.entryBlocked || health.connectivity !== "recent-observations"
								? t(language, "healthWarning")
								: undefined,
					});
				} catch {
					ctx.ui.notify(t(language, "healthUnavailable"), "error");
				}
			},
		});
	};
}
