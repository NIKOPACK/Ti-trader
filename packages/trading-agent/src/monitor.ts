import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getTrading } from "./context.ts";
import type { Order, Position } from "./exchange/types.ts";

const MAX_MISSING_HISTORY_CHECKS = 3;

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
	return `${p.symbol}${p.positionSide ? ` ${p.positionSide}` : ""} ${p.amount} (~${p.quoteValue.toFixed(2)} quote)${entry}${pnl}`;
}

function positionIdentity(position: Position): string {
	return `${position.symbol}:${position.positionSide ?? (position.amount < 0 ? "SHORT" : "LONG")}`;
}

function orderIdentity(order: Order): string {
	return `${order.symbol}:${order.id}`;
}

/** Reduce direction for a position: the side that closes it. */
export function reduceSide(p: Position): "buy" | "sell" {
	return p.positionSide === "SHORT" || p.amount < 0 ? "buy" : "sell";
}

function hasStopComponent(order: Order): boolean {
	return order.type === "oco" || order.type.includes("stop");
}

/** Stop-loss style protection: a reduce-direction resting order with a stop component. */
export function isProtection(
	order: Order,
	p: Position,
	coveragePct = 95,
	positionMode: "one-way" | "hedge" = "one-way",
): boolean {
	if (positionMode === "hedge" && order.positionSide !== p.positionSide) return false;
	if (order.symbol !== p.symbol || order.side !== reduceSide(p) || !hasStopComponent(order)) return false;
	const positionAmount = Math.abs(p.amount);
	return (
		positionAmount > 0 &&
		(order.closePosition === true || Math.abs(order.amount) >= positionAmount * (coveragePct / 100))
	);
}

export function protectionCoverage(
	order: Order,
	p: Position,
	coveragePct = 95,
	positionMode: "one-way" | "hedge" = "one-way",
): "protected" | "partial" | "none" {
	if (positionMode === "hedge" && order.positionSide !== p.positionSide) return "none";
	if (order.symbol !== p.symbol || order.side !== reduceSide(p) || !hasStopComponent(order)) return "none";
	const positionAmount = Math.abs(p.amount);
	if (positionAmount <= 0) return "none";
	if (order.closePosition === true) return "protected";
	if (Math.abs(order.amount) <= 0) return "none";
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
		let lastError: { message: string; reportedAt: number } | undefined;
		const missingHistoryChecks = new Map<string, number>();
		/** Guard alert state per `${symbol}:{unprotected|drawdown}` key. */
		const guardState = new Map<string, { firstSeenAt?: number; lastAlertAt?: number }>();

		type Trading = ReturnType<typeof getTrading>;

		const reportError = (ctx: ExtensionContext, scope: string, error: unknown): void => {
			const message = `${scope}: ${error instanceof Error ? error.message : String(error)}`;
			const now = Date.now();
			if (lastError?.message === message && now - lastError.reportedAt < 60_000) return;
			lastError = { message, reportedAt: now };
			console.error(`[order monitor] ${message}`);
			if (ctx.hasUI) ctx.ui.notify(`Order monitor error: ${message}`, "warning");
		};

		const reportFills = async (trading: Trading, open: Order[], ctx: ExtensionContext): Promise<void> => {
			const openIds = new Set(open.map(orderIdentity));
			for (const id of openIds) missingHistoryChecks.delete(id);
			if (!seeded) {
				seeded = true;
				known = new Map(open.map((o) => [orderIdentity(o), o]));
				return;
			}
			const disappeared = [...known.values()].filter((o) => !openIds.has(orderIdentity(o)));
			const nextKnown = new Map(open.map((o) => [orderIdentity(o), o]));
			if (disappeared.length === 0) {
				known = nextKnown;
				return;
			}

			// Classify disappeared orders via order history, per symbol.
			const fills: Order[] = [];
			const symbols = [...new Set(disappeared.map((o) => o.symbol))];
			for (const symbol of symbols) {
				let history: Order[];
				try {
					history = await trading.exchange.getOrderHistory(symbol, 50);
				} catch (error) {
					reportError(ctx, `history query failed for ${symbol}`, error);
					for (const gone of disappeared.filter((order) => order.symbol === symbol)) {
						nextKnown.set(orderIdentity(gone), gone);
					}
					continue;
				}
				for (const gone of disappeared.filter((o) => o.symbol === symbol)) {
					const id = orderIdentity(gone);
					const final = history.find((h) => h.id === gone.id);
					if (
						final &&
						final.status !== "open" &&
						final.status !== "unknown" &&
						(final.status === "closed" || final.filled > 0)
					) {
						missingHistoryChecks.delete(id);
						fills.push(final);
					} else if (!final) {
						const checks = (missingHistoryChecks.get(id) ?? 0) + 1;
						if (checks >= MAX_MISSING_HISTORY_CHECKS) {
							missingHistoryChecks.delete(id);
							reportError(
								ctx,
								`order ${gone.id} status unresolved after ${MAX_MISSING_HISTORY_CHECKS} history checks`,
								`not present in ${symbol} order history`,
							);
						} else {
							missingHistoryChecks.set(id, checks);
							nextKnown.set(id, gone);
						}
					} else if (final.status === "open" || final.status === "unknown") {
						missingHistoryChecks.delete(id);
						nextKnown.set(id, gone);
						if (final?.status === "unknown") {
							reportError(ctx, `unknown final status for order ${gone.id}`, final.status);
						}
					} else {
						missingHistoryChecks.delete(id);
					}
				}
			}
			known = nextKnown;
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
				const protections = open.filter((o) =>
					isProtection(o, p, cfg.protectionCoveragePct, trading.config.positionMode),
				);
				const partialProtections = open.filter(
					(o) => protectionCoverage(o, p, cfg.protectionCoveragePct, trading.config.positionMode) === "partial",
				);
				const cooldownMs = cfg.alertCooldownSec * 1000;

				if (protections.length === 0) {
					// Grace of one poll interval so the agent can place a bracket right after entry.
					const key = `${positionIdentity(p)}:unprotected`;
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
					const key = `${positionIdentity(p)}:drawdown`;
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
			} catch (error) {
				reportError(ctx, "poll failed", error);
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
