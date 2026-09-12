import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
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

const HEALTH_REFRESH_MS = 5_000;

function healthLabel(language: TradingLanguage, value: string): string {
	const key = HEALTH_LABELS[value];
	return key ? t(language, key) : value;
}

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
		let refreshStatus: (() => void) | undefined;
		let disposeStatus: (() => void) | undefined;
		pi.on("session_shutdown", () => disposeStatus?.());
		pi.on("session_start", (_event, ctx) => {
			if (ctx.mode !== "tui") return;
			ctx.ui.setWidget("trading-health", (tui) => {
				let text = "";
				let color: "warning" | "error" | "muted" = "muted";
				const refresh = () => {
					const language = getLanguage();
					let next: string;
					let nextColor: typeof color;
					try {
						const health = readHealth();
						const active = health.observations.filter((item) => item.enabled);
						const observations =
							active.length === 0
								? t(language, "healthDisabled")
								: active
										.map(
											(item) =>
												`${healthLabel(language, item.source)}: ${healthLabel(language, item.status)}${item.pendingNotifications ? ` (${item.pendingNotifications})` : ""}`,
										)
										.join(" · ");
						next = [
							...(health.entryBlocked
								? [
										translate(language, "healthEntryBlocks", {
											blocks: health.blockers.map((block) => healthLabel(language, block)).join(", "),
										}),
									]
								: []),
							`${t(language, "monitor")}: ${observations}  /health`,
						].join("\n");
						nextColor =
							health.entryBlocked || active.some((item) => item.status !== "recent") ? "warning" : "muted";
					} catch {
						next = `${t(language, "healthUnavailable")}  /health`;
						nextColor = "error";
					}
					if (next === text && nextColor === color) return;
					text = next;
					color = nextColor;
					tui.requestRender();
				};
				refreshStatus = refresh;
				refresh();
				const timer = setInterval(refresh, HEALTH_REFRESH_MS);
				timer.unref();
				const dispose = () => {
					clearInterval(timer);
					if (refreshStatus === refresh) refreshStatus = undefined;
					if (disposeStatus === dispose) disposeStatus = undefined;
				};
				disposeStatus = dispose;
				return {
					render: (width) => (width <= 0 ? [] : new Text(ctx.ui.theme.fg(color, text), 1, 0).render(width)),
					invalidate() {},
					dispose,
				};
			});
		});
		pi.on("turn_end", () => refreshStatus?.());
		pi.on("tool_result", () => {
			refreshStatus?.();
		});
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
				const localize = (value: string) => healthLabel(language, value);
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
