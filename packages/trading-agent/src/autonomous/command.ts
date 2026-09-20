import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { accountRiskKey, type ExecutionScope } from "@nikopack/ti-trading-engine";
import { getTrading } from "../context.ts";
import { type MenuKey, t } from "../i18n.ts";
import type { TradingLanguage } from "../state.ts";
import { renderTradingTable, type TableData, type TableLine } from "../table.ts";
import {
	type AutonomousCommandOptions,
	type AutonomousStatus,
	assertAutonomousScope,
	autonomousCommand,
} from "./daemon.ts";

const actions = ["start", "status", "pause", "resume", "stop"] as const;
type ControlAction = (typeof actions)[number];
const actionMessages: Record<Exclude<ControlAction, "status">, MenuKey> = {
	start: "autonomousStarted",
	pause: "autonomousPaused",
	resume: "autonomousResumed",
	stop: "autonomousStopped",
};

export interface AutonomousCommandDependencies {
	current(): { scope: ExecutionScope; language: TradingLanguage; stale?: boolean };
	execute(action: ControlAction, options: AutonomousCommandOptions): Promise<void>;
}

export function createAutonomousCommandExtension(dependencies?: AutonomousCommandDependencies) {
	const deps: AutonomousCommandDependencies = dependencies ?? {
		current: () => {
			const trading = getTrading();
			return {
				scope: trading.getExecutionScope(),
				language: trading.config.language,
				get stale() {
					return trading.tradingEngine.getExecutionStatus().staleRuntime;
				},
			};
		},
		execute: autonomousCommand,
	};
	return (pi: Pick<ExtensionAPI, "registerCommand" | "registerEntryRenderer" | "appendEntry">): void => {
		pi.registerEntryRenderer<TableData>("trading:autonomous", (entry, _options, theme) =>
			renderTradingTable(entry.data ?? { title: "autonomous", lines: [] }, theme),
		);
		pi.registerCommand("autonomous", {
			description: "Start, inspect, pause, resume or stop autonomous Paper trading",
			getArgumentCompletions: (prefix) =>
				actions.filter((action) => action.startsWith(prefix)).map((action) => ({ value: action, label: action })),
			handler: async (args, ctx) => {
				const initial = deps.current();
				const language = initial.language;
				if (!ctx.hasUI || ctx.mode !== "tui") {
					ctx.ui.notify(t(language, "autonomousTuiOnly"), "error");
					return;
				}
				const action = args.trim() || "status";
				const command = actions.find((candidate) => candidate === action);
				if (!command) {
					ctx.ui.notify(t(language, "autonomousUsage"), "warning");
					return;
				}
				const show = (lines: TableLine[], warning?: string): void =>
					pi.appendEntry<TableData>("trading:autonomous", {
						title: t(language, "autonomousTitle"),
						lines,
						warning,
					});
				try {
					if ((command === "start" || command === "resume") && !ctx.isIdle()) {
						ctx.ui.notify(t(language, "waitingIdle"), "info");
						await ctx.waitForIdle();
					}
					const current = deps.current();
					assertAutonomousScope(initial.scope, current.scope);
					if ((command === "start" || command === "resume") && current.stale)
						throw new Error(t(language, "healthStaleRuntime"));
					const onStatus = (status: AutonomousStatus): void => {
						const activeWakes = status.wakes?.filter((wake) => wake.state.status === "active") ?? [];
						const risk = status.risk?.[accountRiskKey(current.scope)];
						const blocks = [...(risk?.blockedReasons ?? []), ...(risk?.memory?.lossTrip ? ["lossTrip"] : [])];
						show([
							`${status.mode} | ${status.exchange} | ${status.marketType}`,
							{
								fields: [
									{ label: t(language, "colStatus"), value: status.control },
									{
										label: t(language, "autonomousProcess"),
										value: t(language, status.processAlive ? "yes" : "no"),
									},
									{ label: "PID", value: String(status.pid) },
								],
							},
							{
								fields: [
									{ label: t(language, "autonomousEvents"), value: String(status.pendingEvents) },
									{ label: t(language, "autonomousWakes"), value: String(activeWakes.length) },
								],
							},
							`${t(language, "autonomousHeartbeat")}: ${status.heartbeat === undefined ? t(language, "healthNone") : new Date(status.heartbeat).toISOString()}`,
							`${t(language, "autonomousBlocks")}: ${[...new Set(blocks)].join(", ") || t(language, "healthNone")}`,
							...activeWakes
								.slice(0, 5)
								.map(
									(wake) =>
										`${wake.definition.name}: ${wake.definition.when.kind === "time" ? wake.definition.when.at : t(language, "autonomousCondition")}`,
								),
							...(status.lastDecision
								? [`${t(language, "autonomousLastDecision")}: ${status.lastDecision.text}`]
								: []),
							...status.failures
								.slice(-3)
								.map((failure) => ({ text: `${failure.source}: ${failure.reason}`, tone: "warn" as const })),
							{ text: t(language, "healthSemantics"), tone: "muted" },
						]);
					};
					await deps.execute(command, {
						expectedScope: current.scope,
						onStatus,
						output: (message) =>
							show(
								command === "status"
									? [message]
									: [
											t(language, actionMessages[command]),
											...(command === "start" ? [{ text: message, tone: "muted" as const }] : []),
										],
							),
					});
				} catch (error) {
					show(
						[
							error instanceof Error ? error.message : String(error),
							t(language, "autonomousConfigHint"),
							t(language, "autonomousUsage"),
						],
						t(language, "autonomousFailed"),
					);
					ctx.ui.notify(t(language, "autonomousFailed"), "error");
				}
			},
		});
	};
}
