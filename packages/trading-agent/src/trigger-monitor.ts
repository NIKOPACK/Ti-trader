import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type Condition,
	type FactSnapshot,
	type RuntimeState,
	type TriggerDefinition,
	transitionTrigger,
	validateTriggerDefinition,
} from "@earendil-works/ti-triggers";
import { getTrading } from "./context.ts";

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

function observationTime(timestamp: number | undefined): number | undefined {
	if (timestamp === undefined || !Number.isFinite(timestamp) || timestamp <= 0) return undefined;
	return timestamp;
}

async function waitForIdleBeforeMutation(ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.isIdle()) return;
	if (ctx.hasUI) ctx.ui.notify("Waiting for the active agent turn before changing triggers", "info");
	await ctx.waitForIdle();
}

export function createTriggerMonitorExtension() {
	return (pi: ExtensionAPI): void => {
		const definitions = new Map<string, TriggerDefinition>();
		const states = new Map<string, RuntimeState>();
		const previousFacts = new Map<string, { value: number; observedAt: number }>();
		const warnedFactKeys = new Set<string>();
		let timer: ReturnType<typeof setInterval> | undefined;
		let polling = false;

		const factsFor = async (
			definitions: Iterable<TriggerDefinition>,
			now: number,
			ctx: ExtensionContext,
		): Promise<FactSnapshot> => {
			const keys = new Set<string>();
			for (const definition of definitions) factKeys(definition.when, keys);
			const facts: Record<
				string,
				{ value: number; observedAt: number; previousValue?: number; previousObservedAt?: number }
			> = {};
			const positions = [...keys].some((key) => key.startsWith("position_pnl_pct:"))
				? await getTrading().tradingEngine.getPositions()
				: [];
			for (const key of keys) {
				if (key.startsWith("time")) continue;
				let value: number | undefined;
				let observedAt: number | undefined;
				if (key.startsWith("price:")) {
					const ticker = await getTrading().marketData.getTicker(key.slice("price:".length));
					value = ticker.last;
					observedAt = observationTime(ticker.timestamp);
				} else if (key.startsWith("position_pnl_pct:")) {
					const symbol = key.slice("position_pnl_pct:".length);
					value = positions.find((p) => p.symbol === symbol)?.unrealizedPnlPct;
					observedAt = now;
				} else if (!warnedFactKeys.has(key)) {
					warnedFactKeys.add(key);
					warning(ctx, `unsupported fact key "${key}"; its value is unknown`);
				}
				if (value === undefined || !Number.isFinite(value) || observedAt === undefined) continue;
				const previous = previousFacts.get(key);
				facts[key] = {
					value,
					observedAt,
					previousValue: previous?.value,
					previousObservedAt: previous?.observedAt,
				};
			}
			// Update baselines only after all facts have been assembled. This prevents
			// one trigger from changing the previous value seen by another trigger in
			// the same polling round.
			for (const [key, fact] of Object.entries(facts))
				previousFacts.set(key, { value: fact.value, observedAt: fact.observedAt });
			return facts;
		};

		const poll = async (ctx: ExtensionContext): Promise<void> => {
			if (polling) return;
			polling = true;
			try {
				const now = Date.now();
				const facts = await factsFor(definitions.values(), now, ctx);
				for (const [id, definition] of definitions) {
					const previous = states.get(id) ?? { status: "active", armed: true };
					const result = transitionTrigger(definition, previous, facts, now);
					states.set(id, result.state);
					if (!result.shouldFire) continue;
					if (definition.then.kind === "notify" && ctx.hasUI)
						ctx.ui.notify(`Trigger ${definition.name}: ${definition.then.message}`, "info");
					if (definition.then.kind === "wake_agent") {
						const live = getTrading().mode === "live";
						const wake = !live && ctx.mode !== "print";
						if (live && ctx.hasUI) {
							ctx.ui.notify(
								`Trigger ${definition.name}: ${definition.then.message} (live: notify only)`,
								"info",
							);
						}
						pi.sendMessage(
							{
								customType: "trigger",
								content: `[trigger:${definition.id}] ${definition.then.message}`,
								display: true,
							},
							wake ? { triggerTurn: true, deliverAs: "followUp" } : { triggerTurn: false },
						);
					}
				}
			} catch (error) {
				warning(ctx, error instanceof Error ? error.message : String(error));
			} finally {
				polling = false;
			}
		};

		pi.registerCommand("trigger", {
			description: "Manage read-only triggers: /trigger add|list|remove|clear",
			handler: async (args, ctx) => {
				const input = args?.trim() ?? "";
				const space = input.indexOf(" ");
				const command = space < 0 ? input : input.slice(0, space);
				const rest = space < 0 ? "" : input.slice(space + 1).trim();
				try {
					if (command === "add" || command === "remove" || command === "clear") {
						await waitForIdleBeforeMutation(ctx);
					}
					if (command === "add") {
						if (!rest) throw new Error("add requires one-line JSON TriggerDefinition");
						const value: unknown = JSON.parse(rest);
						validateTriggerDefinition(value);
						definitions.set(value.id, value);
						states.set(value.id, { status: "active", armed: true });
						if (ctx.hasUI) ctx.ui.notify(`Trigger added: ${value.id}`, "info");
					} else if (command === "list") {
						if (ctx.hasUI)
							ctx.ui.notify(
								definitions.size === 0
									? "No triggers"
									: [...definitions.values()].map((d) => `${d.id}: ${d.name}`).join("\n"),
								"info",
							);
					} else if (command === "remove") {
						if (!rest || !definitions.delete(rest)) throw new Error(`Trigger not found: ${rest}`);
						states.delete(rest);
					} else if (command === "clear") {
						definitions.clear();
						states.clear();
					} else warning(ctx, "usage: /trigger add <JSON>|list|remove <id>|clear");
				} catch (error) {
					warning(ctx, error instanceof Error ? error.message : String(error));
				}
			},
		});

		pi.on("session_start", async (_event, ctx) => {
			if (timer) {
				clearInterval(timer);
				timer = undefined;
			}
			await poll(ctx);
			const intervalMs = Math.max(5, getTrading().config.monitor.intervalSec) * 1000;
			timer = setInterval(() => void poll(ctx), intervalMs);
			timer.unref?.();
		});
		pi.on("session_shutdown", async () => {
			if (timer) clearInterval(timer);
			timer = undefined;
		});
	};
}
