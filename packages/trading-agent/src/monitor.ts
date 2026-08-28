import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getTrading } from "./context.ts";
import type { Order, Position } from "./exchange/types.ts";

function describeFill(order: Order): string {
	const price = order.average ?? order.price ?? order.stopPrice;
	return (
		`${order.side.toUpperCase()} ${order.amount} ${order.symbol} (${order.type})` +
		(price !== undefined ? ` filled @ ${price}` : " filled") +
		(order.cost ? `, cost ${order.cost.toFixed(2)}` : "") +
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
	return `${p.symbol} ${p.amount} (~${p.quoteValue.toFixed(2)} quote)${entry}${pnl}`;
}

/** Reduce direction for a position: the side that closes it. */
export function reduceSide(p: Position): "buy" | "sell" {
	return p.positionSide === "SHORT" || p.amount < 0 ? "buy" : "sell";
}

/** Stop-loss style protection: a reduce-direction resting order with a stop component. */
export function isProtection(order: Order, p: Position, coveragePct = 95): boolean {
	if (order.symbol !== p.symbol || order.side !== reduceSide(p) || !order.type.includes("stop")) return false;
	const positionAmount = Math.abs(p.amount);
	return positionAmount > 0 && Math.abs(order.amount) >= positionAmount * (coveragePct / 100);
}

export function protectionCoverage(order: Order, p: Position, coveragePct = 95): "protected" | "partial" | "none" {
	if (order.symbol !== p.symbol || order.side !== reduceSide(p) || !order.type.includes("stop")) return "none";
	const positionAmount = Math.abs(p.amount);
	if (positionAmount <= 0 || Math.abs(order.amount) <= 0) return "none";
	return Math.abs(order.amount) >= positionAmount * (coveragePct / 100) ? "protected" : "partial";
}

/**
 * Background order-fill monitor and position guard. Polls open orders on an
 * interval (which in paper mode also drives trigger/trailing settlement),
 * detects orders that left the open set, and reports fills back into the
 * session: a UI notice plus an injected message that can wake the agent so it
 * can react (e.g. place a protective bracket after an entry fills). The
 * position guard additionally watches open positions and wakes the agent when
 * a position has no stop-loss protection or its unrealized loss breaches the
 * configured alert threshold, so the agent can act or report to the user.
 */
export function createOrderMonitorExtension() {
	return (pi: ExtensionAPI): void => {
		let timer: ReturnType<typeof setInterval> | undefined;
		let known = new Map<string, Order>();
		let seeded = false;
		let polling = false;
		let enabled = true;
		/** Guard alert state per `${symbol}:{unprotected|drawdown}` key. */
		const guardState = new Map<string, { firstSeenAt?: number; lastAlertAt?: number }>();

		type Trading = ReturnType<typeof getTrading>;

		const reportFills = async (trading: Trading, open: Order[], ctx: ExtensionContext): Promise<void> => {
			const openIds = new Set(open.map((o) => o.id));
			if (!seeded) {
				seeded = true;
				known = new Map(open.map((o) => [o.id, o]));
				return;
			}
			const disappeared = [...known.values()].filter((o) => !openIds.has(o.id));
			known = new Map(open.map((o) => [o.id, o]));
			if (disappeared.length === 0) return;

			// Classify disappeared orders via order history, per symbol.
			const fills: Order[] = [];
			const symbols = [...new Set(disappeared.map((o) => o.symbol))];
			for (const symbol of symbols) {
				let history: Order[] = [];
				try {
					history = await trading.exchange.getOrderHistory(symbol, 50);
				} catch {
					// History unavailable: skip classification for this symbol.
				}
				for (const gone of disappeared.filter((o) => o.symbol === symbol)) {
					const final = history.find((h) => h.id === gone.id);
					if (final?.status === "closed") fills.push(final);
				}
			}
			if (fills.length === 0) return;

			const lines = fills.map(describeFill);
			if (ctx.hasUI) {
				for (const line of lines) ctx.ui.notify(`Order filled: ${line}`, "info");
			}
			const wake = trading.config.monitor.wakeAgent;
			pi.sendMessage(
				{
					customType: "order-fill",
					content:
						`[order monitor] ${fills.length === 1 ? "An order" : `${fills.length} orders`} filled:\n` +
						lines.map((l) => `- ${l}`).join("\n") +
						"\nReassess the position: check balances/positions and decide whether to protect or follow up.",
					display: true,
				},
				wake ? { triggerTurn: true, deliverAs: "followUp" } : { triggerTurn: false },
			);
		};

		const guardPositions = async (trading: Trading, open: Order[], ctx: ExtensionContext): Promise<void> => {
			const cfg = trading.config.monitor;
			const positions = await trading.exchange.getPositions();
			const now = Date.now();
			const alerts: string[] = [];
			const unprotectedKeys = new Set<string>();

			for (const p of positions) {
				const protections = open.filter((o) => isProtection(o, p, cfg.protectionCoveragePct));
				const partialProtections = open.filter(
					(o) => protectionCoverage(o, p, cfg.protectionCoveragePct) === "partial",
				);
				const cooldownMs = cfg.alertCooldownSec * 1000;

				if (protections.length === 0) {
					// Grace of one poll interval so the agent can place a bracket right after entry.
					const key = `${p.symbol}:unprotected`;
					unprotectedKeys.add(key);
					const st = guardState.get(key) ?? {};
					st.firstSeenAt ??= now;
					guardState.set(key, st);
					const grace = Math.max(5, cfg.intervalSec) * 1000;
					const cooled = st.lastAlertAt === undefined || now - st.lastAlertAt >= cooldownMs;
					if (now - st.firstSeenAt >= grace && cooled) {
						st.lastAlertAt = now;
						alerts.push(
							`${partialProtections.length > 0 ? "PARTIALLY PROTECTED" : "UNPROTECTED"}: ${describePosition(p)} has ` +
								(partialProtections.length > 0
									? "stop-loss coverage below the configured threshold. "
									: "no stop-loss order. ") +
								`Place protection (place_oco, or a ${reduceSide(p)} stop_market at your invalidation level) ` +
								"or briefly tell the user why you are leaving it unprotected.",
						);
					}
				}

				if (p.unrealizedPnlPct !== undefined && p.unrealizedPnlPct <= -cfg.alertLossPct) {
					const key = `${p.symbol}:drawdown`;
					const st = guardState.get(key) ?? {};
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

			// A position that regained protection restarts its grace period next time.
			for (const key of [...guardState.keys()]) {
				if (key.endsWith(":unprotected") && !unprotectedKeys.has(key)) guardState.delete(key);
			}
			if (alerts.length === 0) return;

			if (ctx.hasUI) {
				for (const alert of alerts) ctx.ui.notify(`Position guard: ${alert}`, "warning");
			}
			pi.sendMessage(
				{
					customType: "position-alert",
					content:
						"[position guard] Attention needed on open positions:\n" +
						alerts.map((a) => `- ${a}`).join("\n") +
						"\nAct on this now (protect, adjust, or close via the trading tools) or report to the user why no action is needed.",
					display: true,
				},
				trading.config.monitor.wakeAgent ? { triggerTurn: true, deliverAs: "followUp" } : { triggerTurn: false },
			);
		};

		const poll = async (ctx: ExtensionContext): Promise<void> => {
			if (polling || !enabled) return;
			polling = true;
			try {
				const trading = getTrading();
				const open = await trading.exchange.getOpenOrders();
				await reportFills(trading, open, ctx);
				if (trading.config.monitor.guardPositions) await guardPositions(trading, open, ctx);
			} catch {
				// Transient feed/exchange error: retry on the next tick.
			} finally {
				polling = false;
			}
		};

		pi.registerCommand("monitor", {
			description: "Order fill monitor & position guard: /monitor [on|off]",
			handler: async (args, ctx) => {
				let arg = args?.trim();
				if (!arg) {
					const english = getTrading().config.language === "en-US";
					const choice = await ctx.ui.select(
						english ? "Order monitor" : "后台监控",
						english
							? ["Enable monitor", "Disable monitor", "Show status", "Cancel"]
							: ["开启监控", "关闭监控", "查看状态", "取消"],
					);
					if (!choice || choice === "取消" || choice === "Cancel") return;
					if (choice === "开启监控" || choice === "Enable monitor") arg = "on";
					else if (choice === "关闭监控" || choice === "Disable monitor") arg = "off";
					else arg = "status";
				}
				if (arg === "on") enabled = true;
				else if (arg === "off") enabled = false;
				else if (arg !== "status") {
					ctx.ui.notify("Usage: /monitor [on|off]", "warning");
					return;
				}
				const trading = getTrading();
				const cfg = trading.config.monitor;
				const status = enabled ? "on" : "off";
				ctx.ui.notify(
					`Order monitor ${status} (interval ${cfg.intervalSec}s, wakeAgent ${cfg.wakeAgent}, watching ${known.size} open orders; ` +
						`position guard ${cfg.guardPositions ? "on" : "off"}, loss alert -${cfg.alertLossPct}%, cooldown ${cfg.alertCooldownSec}s)`,
					"info",
				);
			},
		});

		pi.on("session_start", async (_event, ctx) => {
			const trading = getTrading();
			if (!trading.config.monitor.enabled) {
				enabled = false;
				return;
			}
			const intervalMs = Math.max(5, trading.config.monitor.intervalSec) * 1000;
			await poll(ctx); // seed the open-order snapshot
			timer = setInterval(() => void poll(ctx), intervalMs);
			// Never keep the process alive just for the monitor (print mode).
			timer.unref?.();
		});

		pi.on("session_shutdown", async () => {
			if (timer) clearInterval(timer);
			timer = undefined;
		});
	};
}
