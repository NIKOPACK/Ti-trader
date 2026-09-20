import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getTrading } from "./context.ts";
import { type MenuKey, t, translate } from "./i18n.ts";
import {
	createFileMonitoringStore,
	type MonitoringStore,
	monitoringScopeForRuntime,
	readMonitoringHealth,
} from "./monitoring-state.ts";
import { assessOperationalHealth } from "./operational-health.ts";
import { readPlanHealth } from "./plans/monitoring.ts";
import { PlanStore } from "./plans/store.ts";
import type { TradingLanguage } from "./state.ts";
import { renderTradingTable, type TableData } from "./table.ts";
import { formatTradingStatus, renderTradingVenue, type TradingVenueInput, type TradingVenueStatus } from "./venue.ts";

const HEALTH_LABELS: Readonly<Partial<Record<string, MenuKey>>> = {
	"account-maintenance": "healthMaintenance",
	"stale-runtime": "healthStaleRuntime",
	"unresolved-executions": "healthExecutionBlock",
	"unsettled-risk-reservations": "healthReservationBlock",
	orders: "healthOrders",
	triggers: "healthTriggers",
	plans: "healthPlans",
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

export function readOperationalHealth(store: MonitoringStore = createFileMonitoringStore(), plans?: PlanStore) {
	const trading = getTrading();
	const execution = trading.getExecutionStatus();
	const pending = trading.tradingEngine.risk.listPendingReservations();
	const observations = readMonitoringHealth(store, monitoringScopeForRuntime(trading));
	return assessOperationalHealth({
		mode: trading.mode,
		exchange: trading.config.exchange,
		marketType: trading.config.marketType,
		maintenanceActive: execution.maintenance !== undefined,
		staleRuntime: execution.admission.stale,
		unresolvedExecutions: execution.unresolved.length,
		pendingReservations: pending.length,
		maxObservationAgeMs: 5 * 60_000,
		observations: [
			...observations.map((observation) => ({
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
			...(plans ? [readPlanHealth(plans, trading.getExecutionScope(), trading.config.monitor.enabled)] : []),
		],
	});
}

function observationAge(language: TradingLanguage, ageMs: number | undefined): string {
	if (ageMs === undefined || ageMs < 0) return "";
	const seconds = Math.floor(ageMs / 1_000);
	if (seconds < 60) return translate(language, "healthAgeSeconds", { age: seconds });
	if (seconds < 3_600) return translate(language, "healthAgeMinutes", { age: Math.floor(seconds / 60) });
	return translate(language, "healthAgeHours", { age: Math.floor(seconds / 3_600) });
}

function readTradingStatus(readHealth: typeof readOperationalHealth) {
	const trading = getTrading();
	const language = trading.config.language;
	const input: TradingVenueInput = {
		language,
		mode: trading.mode,
		exchangeId: trading.config.exchange,
		marketType: trading.config.marketType,
		quoteCurrency: trading.config.quoteCurrency,
		orderApproval: trading.config.orderApproval,
	};
	let health: ReturnType<typeof readHealth>;
	try {
		health = readHealth();
	} catch {
		return {
			input,
			status: {
				summary: t(language, "healthUnavailable"),
				tone: "error",
				entryBlocked: false,
			} satisfies TradingVenueStatus,
		};
	}
	return {
		input,
		status: {
			summary: health.entryBlocked
				? translate(language, "healthEntryBlocks", {
						blocks: health.blockers.map((block) => healthLabel(language, block)).join(", "),
					})
				: t(language, "healthNoEntryBlocks"),
			tone: health.entryBlocked ? "warning" : "muted",
			entryBlocked: health.entryBlocked,
			recoveryHint:
				health.unresolvedExecutions > 0 ||
				health.pendingReservations > 0 ||
				health.blockers.includes("account-maintenance")
					? t(language, "healthRecoveryHint")
					: undefined,
		} satisfies TradingVenueStatus,
	};
}

/** One owner for venue and local health; rendering only consumes the refreshed snapshot. */
export function createTradingStatus(readHealth = () => readOperationalHealth(undefined, new PlanStore())) {
	let active:
		| { ui: ExtensionContext["ui"]; mode: ExtensionContext["mode"]; refresh(): void; dispose(): void }
		| undefined;
	return {
		update(ctx: ExtensionContext): void {
			ctx.ui.setStatus("trading-status", undefined);
			if (!ctx.hasUI) {
				active?.dispose();
				return;
			}
			if (active?.ui === ctx.ui && active.mode === ctx.mode) {
				active.refresh();
				return;
			}
			active?.dispose();
			let snapshot = readTradingStatus(readHealth);
			let disposed = false;
			let timer: ReturnType<typeof setInterval> | undefined;
			let requestRender: (() => void) | undefined;
			const refresh = () => {
				if (disposed) return;
				const next = readTradingStatus(readHealth);
				if (JSON.stringify(next) === JSON.stringify(snapshot)) return;
				snapshot = next;
				if (ctx.mode === "tui") requestRender?.();
				else ctx.ui.setWidget("trading-status", formatTradingStatus(snapshot.input, snapshot.status));
			};
			const dispose = () => {
				if (disposed) return;
				disposed = true;
				clearInterval(timer);
				if (active?.dispose === dispose) active = undefined;
			};
			active = { ui: ctx.ui, mode: ctx.mode, refresh, dispose };
			if (ctx.mode !== "tui") {
				ctx.ui.setWidget("trading-status", formatTradingStatus(snapshot.input, snapshot.status));
				return;
			}
			ctx.ui.setWidget("trading-status", (tui) => {
				if (!disposed) {
					requestRender = () => tui.requestRender();
					clearInterval(timer);
					timer = setInterval(refresh, HEALTH_REFRESH_MS);
					timer.unref();
				}
				return {
					render: (width) => renderTradingVenue(snapshot.input, ctx.ui.theme, width, snapshot.status),
					invalidate() {},
					dispose,
				};
			});
		},
		dispose(): void {
			active?.dispose();
		},
	};
}

export function createOperationalHealthExtension(
	readHealth = () => readOperationalHealth(undefined, new PlanStore()),
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
								[
									translate(language, "healthObservation", {
										source: localize(observation.source),
										status: localize(observation.status),
										count: observation.pendingNotifications,
										error: observation.errorCode ? `; ${observation.errorCode}` : "",
									}),
									observationAge(language, observation.ageMs),
								]
									.filter(Boolean)
									.join("; "),
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
