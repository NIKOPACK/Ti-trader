import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Balance } from "@nikopack/ti-trading-engine";
import { AccountSwitchConfirmationRequired, getTrading } from "./context.ts";
import { isSupportedExchangeId } from "./exchanges.ts";
import { orderApprovalLabel, t, translate } from "./i18n.ts";
import { loginExchange, openTradingSettings } from "./settings-menu.ts";
import { wrapTradingAutocomplete } from "./slash-autocomplete.ts";
import {
	isOrderApprovalMode,
	loadExchangeKeys,
	type MarketType,
	type TradingLanguage,
	type TradingMode,
} from "./state.ts";
import { padEndWidth, padStartWidth, renderTradingTable, type TableData, type TableLine } from "./table.ts";
import { formatTradingVenue, renderTradingVenue } from "./venue.ts";

function fmt(n: number | undefined, decimals = 2): string {
	if (n === undefined || !Number.isFinite(n)) return "-";
	return n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtAmount(n: number | undefined): string {
	if (n === undefined || !Number.isFinite(n)) return "-";
	return n.toLocaleString("en-US", { maximumFractionDigits: 8 });
}

function uiLang(): TradingLanguage {
	return getTrading().config.language;
}

function hasFiniteQuoteValue(balance: Balance): balance is Balance & { quoteValue: number } {
	return balance.quoteValue !== undefined && Number.isFinite(balance.quoteValue);
}

async function waitForIdleBeforeMutation(ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.isIdle()) return;
	ctx.ui.notify(t(uiLang(), "waitingIdle"), "info");
	await ctx.waitForIdle();
}

async function runWithAccountSwitchConfirmation(
	ctx: ExtensionCommandContext,
	action: (confirmed: boolean) => Promise<void>,
	initialConfirmed = false,
): Promise<boolean> {
	try {
		await action(initialConfirmed);
		return true;
	} catch (error) {
		if (!(error instanceof AccountSwitchConfirmationRequired)) throw error;
		if (!ctx.hasUI) throw error;
		const language = uiLang();
		const confirmed = await ctx.ui.confirm(
			t(language, "confirmAccountSwitchTitle"),
			t(language, "confirmAccountSwitchMessage"),
		);
		if (!confirmed) {
			ctx.ui.notify(t(language, "accountSwitchCancelled"), "info");
			return false;
		}
		await action(true);
		return true;
	}
}

/**
 * Trading slash commands rendered as durable transcript entries (not sent to
 * the LLM). Registered as an inline extension factory at startup.
 */
export function createTradingExtension() {
	return (pi: ExtensionAPI): void => {
		let lastObservedMode: TradingMode | undefined;
		let modeAlertInFlight = false;

		const observeMode = (ctx: ExtensionContext): void => {
			const trading = getTrading();
			updateStatus(ctx);
			const mode = trading.mode;
			if (lastObservedMode === undefined) {
				lastObservedMode = mode;
				return;
			}
			if (lastObservedMode === mode || modeAlertInFlight) return;
			const previous = lastObservedMode;
			lastObservedMode = mode;
			modeAlertInFlight = true;
			const language = trading.config.language;
			const label = t(language, mode === "live" ? "modeLive" : "modePaper");
			const previousLabel = t(language, previous === "live" ? "modeLive" : "modePaper");
			if (ctx.hasUI)
				ctx.ui.notify(translate(language, "modeChangedNotify", { previous: previousLabel, label }), "warning");
			pi.sendMessage(
				{
					customType: "mode-change",
					content: translate(language, "modeChangedAgent", { label }),
					display: true,
				},
				{ triggerTurn: false },
			);
			modeAlertInFlight = false;
		};

		pi.on("session_start", async (_event, ctx) => {
			lastObservedMode = getTrading().mode;
			observeMode(ctx);
			const pending = getTrading().tradingEngine.risk.listPendingReservations();
			const trading = getTrading();
			const pause = trading.tradingEngine.risk.usage().newExposurePause;
			if (pause && ctx.hasUI) {
				ctx.ui.notify(
					translate(trading.config.language, "riskPauseNotice", { mode: trading.mode, reason: pause.reason }),
					"warning",
				);
			}
			if (pending.length > 0 && ctx.hasUI) {
				ctx.ui.notify(
					translate(trading.config.language, "unsettledReservationsNotice", { count: pending.length }),
					"warning",
				);
			}
		});
		pi.on("input", async (_event, ctx) => observeMode(ctx));
		pi.on("turn_start", async (_event, ctx) => observeMode(ctx));
		pi.on("turn_end", async (_event, ctx) => observeMode(ctx));
		// InteractiveMode exits the process from its shutdown path, so code after
		// `interactiveMode.run()` is not guaranteed to execute. Close the exchange
		// client through the session lifecycle instead of relying on the caller.
		pi.on("session_shutdown", async (event) => {
			if (event.reason !== "quit") return;
			await getTrading().close();
		});
		pi.registerEntryRenderer<TableData>("trading:table", (entry, _opts, theme) =>
			renderTradingTable(entry.data ?? { title: "trading", lines: [] }, theme),
		);

		const show = (title: string, lines: TableLine[], warning?: string): void => {
			pi.appendEntry<TableData>("trading:table", { title, lines, warning });
		};

		const tradingVenueInput = () => {
			const trading = getTrading();
			return {
				language: trading.config.language,
				mode: trading.mode,
				exchangeId: trading.config.exchange,
				marketType: trading.config.marketType,
				quoteCurrency: trading.config.quoteCurrency,
				paused: trading.tradingEngine.risk.usage().newExposurePause !== undefined,
			};
		};

		const tradingVenue = () => formatTradingVenue(tradingVenueInput());

		const updateStatus = (ctx: ExtensionContext): void => {
			ctx.ui.setStatus("trading-status", undefined);
			if (!ctx.hasUI) return;
			const input = tradingVenueInput();
			if (ctx.mode !== "tui") {
				const venue = formatTradingVenue(input);
				ctx.ui.setWidget("trading-venue", [`${venue.identity}  ${venue.source}`]);
				return;
			}
			ctx.ui.setWidget("trading-venue", () => ({
				render: (width) => renderTradingVenue(input, ctx.ui.theme, width),
				invalidate() {},
			}));
		};

		let autocompleteWrapped = false;
		pi.on("session_start", async (_event, ctx) => {
			updateStatus(ctx);
			if (ctx.hasUI && !autocompleteWrapped) {
				ctx.ui.addAutocompleteProvider(wrapTradingAutocomplete);
				autocompleteWrapped = true;
			}
		});

		const openSettings = async (ctx: ExtensionCommandContext): Promise<void> => {
			await openTradingSettings(ctx, () => updateStatus(ctx));
		};

		pi.registerCommand("settings", {
			description: "Open trading settings",
			handler: async (args, ctx) => {
				if (args.trim()) {
					ctx.ui.notify(t(getTrading().config.language, "usageSettings"), "warning");
					return;
				}
				await openSettings(ctx);
			},
		});

		pi.registerCommand("language", {
			description: "Change TUI language. Usage: /language [zh-CN|en-US]",
			handler: async (args, ctx) => {
				const trading = getTrading();
				const language = args.trim() as TradingLanguage;
				if (!language) {
					await openSettings(ctx);
					return;
				}
				if (language !== "zh-CN" && language !== "en-US") {
					ctx.ui.notify(t(trading.config.language, "languageInvalid"), "error");
					return;
				}
				await waitForIdleBeforeMutation(ctx);
				await trading.setLanguage(language);
				updateStatus(ctx);
				ctx.ui.notify(t(language, "languageChanged"), "info");
			},
		});

		pi.registerCommand("balance", {
			description: "Show account balances with quote-currency valuation",
			handler: async (_args, ctx) => {
				const trading = getTrading();
				const balances = await trading.tradingEngine.getBalances();
				const valuedBalances = balances.filter(hasFiniteQuoteValue);
				const total = valuedBalances.reduce((s, b) => s + b.quoteValue, 0);
				const totalLabel =
					valuedBalances.length === balances.length
						? `${fmt(total)} ${trading.config.quoteCurrency}`
						: translate(trading.config.language, "valuationIncomplete", { known: fmt(total) });
				const language = trading.config.language;
				const venue = tradingVenue();
				const lines: TableLine[] = [
					venue.identity,
					{ text: venue.source, tone: "muted" },
					"",
					{
						text: `${padEndWidth(t(language, "colAsset"), 8)} ${padStartWidth(t(language, "colAvailable"), 16)}  ${padStartWidth(t(language, "colLocked"), 14)}  ${padStartWidth(t(language, "colValuation"), 16)}`,
						tone: "muted",
					},
					...balances.map(
						(b) =>
							`${padEndWidth(b.asset, 8)} ${padStartWidth(fmtAmount(b.free), 16)}  ${padStartWidth(fmtAmount(b.used), 14)}  ${padStartWidth(`${fmt(b.quoteValue)} ${trading.config.quoteCurrency}`, 16)}`,
					),
					"",
					`${t(language, "totalValuation")} ≈ ${totalLabel}`,
				];
				show(t(language, "titleBalance"), lines);
				ctx.ui.notify(
					translate(language, "notifyTotalValuation", {
						label: t(language, "totalValuation"),
						total: totalLabel,
						mode: trading.mode,
					}),
					"info",
				);
			},
		});

		pi.registerCommand("positions", {
			description: "Show current holdings with average entry and unrealized PnL when available",
			handler: async (_args, ctx) => {
				const trading = getTrading();
				const positions = await trading.tradingEngine.getPositions();
				const language = trading.config.language;
				const venue = tradingVenue();
				const header: TableLine[] = [venue.identity, { text: venue.source, tone: "muted" }, ""];
				if (positions.length === 0) {
					show(t(language, "titlePositions"), [...header, t(language, "emptyPositions")]);
					return;
				}
				show(t(language, "titlePositions"), [
					...header,
					...positions.map((p): TableLine => {
						const pnl =
							p.unrealizedPnl !== undefined
								? `  PnL ${p.unrealizedPnl >= 0 ? "+" : ""}${fmt(p.unrealizedPnl)} (${fmt(p.unrealizedPnlPct)}%)`
								: "";
						const entry = p.avgEntryPrice !== undefined ? `  entry ${fmt(p.avgEntryPrice, 6)}` : "";
						const basis =
							p.costBasisStatus && p.costBasisStatus !== "complete" ? `  basis ${p.costBasisStatus}` : "";
						const valuation =
							p.quoteValue !== undefined && Number.isFinite(p.quoteValue)
								? `≈ ${fmt(p.quoteValue)}`
								: `≈ - (valuation unavailable${p.valuationReason ? `: ${p.valuationReason}` : ""})`;
						return {
							text: `${padEndWidth(p.symbol, 12)} ${padStartWidth(fmtAmount(p.amount), 16)}  ${valuation}${entry}${basis}${pnl}`,
							tone: p.unrealizedPnl === undefined ? undefined : p.unrealizedPnl >= 0 ? "up" : "down",
						};
					}),
				]);
				ctx.ui.notify(translate(language, "notifyPositions", { count: positions.length }), "info");
			},
		});

		pi.registerCommand("orders", {
			description: "Show open orders. Usage: /orders [symbol]",
			handler: async (args, ctx) => {
				const symbol = args.trim() || undefined;
				const language = uiLang();
				const orders = await getTrading().tradingEngine.getOpenOrders(symbol);
				const venue = tradingVenue();
				const header: TableLine[] = [venue.identity, { text: venue.source, tone: "muted" }, ""];
				if (orders.length === 0) {
					show(t(language, "titleOrders"), [...header, t(language, "emptyOrders")]);
					return;
				}
				show(t(language, "titleOrders"), [
					...header,
					...orders.map((o): TableLine => {
						const level =
							o.price !== undefined
								? `@ ${fmt(o.price, 6)}${o.stopPrice !== undefined ? ` trigger ${fmt(o.stopPrice, 6)}` : ""}`
								: o.stopPrice !== undefined
									? `trigger ${fmt(o.stopPrice, 6)}`
									: o.trailingPercent !== undefined
										? `trail ${fmt(o.trailingPercent, 2)}%`
										: "@ market";
						return {
							text: `#${o.id} ${padEndWidth(o.side, 4)} ${padEndWidth(o.type, 6)} ${padEndWidth(o.symbol, 12)} ${fmtAmount(o.remaining)} ${level}${o.ocoGroup ? ` [${o.ocoGroup}]` : ""}  (${new Date(o.timestamp).toLocaleTimeString()})`,
							tone: o.side === "buy" ? "up" : "down",
						};
					}),
				]);
				ctx.ui.notify(translate(language, "notifyOrders", { count: orders.length }), "info");
			},
		});

		pi.registerCommand("trades", {
			description: "Show recently closed orders. Usage: /trades [symbol]",
			handler: async (args, ctx) => {
				const symbol = args.trim() || undefined;
				const language = uiLang();
				const orders = await getTrading().tradingEngine.getOrderHistory(symbol, 20);
				const venue = tradingVenue();
				const header: TableLine[] = [venue.identity, { text: venue.source, tone: "muted" }, ""];
				if (orders.length === 0) {
					show(t(language, "titleTrades"), [...header, t(language, "emptyTrades")]);
					return;
				}
				show(t(language, "titleTrades"), [
					...header,
					...orders.map(
						(o): TableLine => ({
							text: `#${o.id} ${padEndWidth(o.side, 4)} ${padEndWidth(o.symbol, 12)} ${fmtAmount(o.filled)} @ ${fmt(o.average, 6)}  ${o.status}  (${new Date(o.timestamp).toLocaleString()})`,
							tone: o.side === "buy" ? "up" : "down",
						}),
					),
				]);
				ctx.ui.notify(translate(language, "notifyTrades", { count: orders.length }), "info");
			},
		});

		pi.registerCommand("markets", {
			description: `Show top markets by 24h quote volume. Usage: /markets [limit]`,
			handler: async (args, ctx) => {
				const limit = Math.min(Math.max(Number.parseInt(args.trim(), 10) || 15, 1), 50);
				const language = uiLang();
				const tickers = await getTrading().tradingEngine.getTopMarkets(limit);
				const venue = tradingVenue();
				show(t(language, "titleMarkets"), [
					venue.identity,
					{ text: venue.source, tone: "muted" },
					"",
					...tickers.map(
						(t, i): TableLine => ({
							text: `${String(i + 1).padStart(2)}. ${padEndWidth(t.symbol, 14)} ${padStartWidth(fmt(t.last, 6), 14)}  ${(t.changePct24h ?? 0) >= 0 ? "+" : ""}${fmt(t.changePct24h)}%  vol ${fmt(t.quoteVolume24h, 0)}`,
							tone: (t.changePct24h ?? 0) >= 0 ? "up" : "down",
						}),
					),
				]);
				ctx.ui.notify(translate(language, "notifyMarkets", { count: tickers.length }), "info");
			},
		});

		pi.registerCommand("mode", {
			description: "Show or switch trading mode. Usage: /mode [paper|live]",
			handler: async (args, ctx) => {
				const trading = getTrading();
				const target = args.trim().toLowerCase();
				if (!target) {
					await openSettings(ctx);
					return;
				}
				const language = trading.config.language;
				if (target !== "paper" && target !== "live") {
					ctx.ui.notify(translate(language, "unknownMode", { target }), "error");
					return;
				}
				let liveConfirmed = false;
				if (target === "live") {
					const keys = loadExchangeKeys()[trading.config.exchange];
					if (!keys) {
						ctx.ui.notify(
							translate(language, "liveKeysMissingSlash", { exchange: trading.config.exchange }),
							"error",
						);
						return;
					}
					liveConfirmed = await ctx.ui.confirm(
						t(language, "confirmLiveTitle"),
						`${translate(language, "confirmLiveMessage", { exchange: trading.config.exchange })} ${translate(language, "orderApprovalState", { state: orderApprovalLabel(language, trading.config.orderApproval) })}`,
					);
					if (!liveConfirmed) {
						ctx.ui.notify(t(language, "stayedPaper"), "info");
						return;
					}
				}
				try {
					await waitForIdleBeforeMutation(ctx);
					const applied = await runWithAccountSwitchConfirmation(ctx, (confirmAccountSwitch) =>
						trading.setMode(target as TradingMode, { confirmAccountSwitch }),
					);
					if (!applied) return;
					updateStatus(ctx);
					const modeLabel = t(language, target === "live" ? "venueLive" : "venuePaper");
					show(t(language, "titleMode"), [
						{
							text: translate(language, "switchedMode", {
								mode: modeLabel,
								exchange: trading.config.exchange,
							}),
							tone: target === "live" ? "warn" : undefined,
						},
					]);
					ctx.ui.notify(translate(language, "notifyMode", { mode: target }), "info");
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
			},
		});

		pi.registerCommand("approval", {
			description: "Show or switch live order approval. Usage: /approval [confirm|unattended]",
			handler: async (args, ctx) => {
				const trading = getTrading();
				const target = args.trim().toLowerCase();
				if (!target) {
					await openSettings(ctx);
					return;
				}
				const language = trading.config.language;
				if (!isOrderApprovalMode(target)) {
					ctx.ui.notify(translate(language, "unknownApproval", { target }), "error");
					return;
				}
				if (trading.config.orderApproval === target) {
					ctx.ui.notify(
						translate(language, "notifyApproval", { state: orderApprovalLabel(language, target) }),
						"info",
					);
					return;
				}
				if (target === "unattended") {
					if (!ctx.hasUI) {
						ctx.ui.notify(t(language, "approvalUnattendedNeedsUi"), "error");
						return;
					}
					const confirmed = await ctx.ui.confirm(
						t(language, "confirmUnattendedTitle"),
						t(language, "confirmUnattendedMessage"),
					);
					if (!confirmed) {
						ctx.ui.notify(t(language, "approvalUnchanged"), "info");
						return;
					}
				}
				try {
					await waitForIdleBeforeMutation(ctx);
					if (getTrading() !== trading) throw new Error(t(language, "riskRuntimeChanged"));
					await trading.setOrderApproval(target, { confirmUnattendedTrading: target === "unattended" });
					const state = orderApprovalLabel(language, target);
					show(t(language, "titleApproval"), [
						{
							text: translate(language, "switchedApproval", { state }),
							tone: target === "unattended" ? "warn" : undefined,
						},
					]);
					ctx.ui.notify(
						translate(language, "notifyApproval", { state }),
						target === "unattended" ? "warning" : "info",
					);
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
			},
		});

		pi.registerCommand("exchange", {
			description: "Show or switch the active exchange (ccxt id). Usage: /exchange [id]",
			handler: async (args, ctx) => {
				const trading = getTrading();
				const target = args.trim().toLowerCase();
				if (!target) {
					await openSettings(ctx);
					return;
				}
				try {
					await waitForIdleBeforeMutation(ctx);
					const applied = await runWithAccountSwitchConfirmation(ctx, (confirmAccountSwitch) =>
						trading.setExchange(target, { confirmAccountSwitch }),
					);
					if (!applied) return;
					updateStatus(ctx);
					const language = trading.config.language;
					show(t(language, "titleExchange"), [
						translate(language, "switchedExchange", { exchange: target, mode: trading.mode }),
					]);
					ctx.ui.notify(translate(language, "notifyExchange", { exchange: target }), "info");
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
			},
		});

		pi.registerCommand("market", {
			description: "Show or switch market type. Usage: /market [spot|usdm-futures|both]",
			handler: async (args, ctx) => {
				const trading = getTrading();
				const target = args.trim().toLowerCase() as MarketType | "";
				if (!target) {
					await openSettings(ctx);
					return;
				}
				const language = trading.config.language;
				if (target !== "spot" && target !== "usdm-futures" && target !== "both") {
					ctx.ui.notify(translate(language, "unknownMarketType", { target }), "error");
					return;
				}
				if (target === "both" && trading.mode !== "paper") {
					ctx.ui.notify(t(language, "marketBothPaperOnly"), "error");
					return;
				}
				if (target === "usdm-futures" && trading.config.exchange !== "binance") {
					ctx.ui.notify(t(language, "marketFuturesBinanceOnly"), "error");
					return;
				}
				const isLiveFutures = trading.mode === "live" && target === "usdm-futures";
				let futuresConfirmed = false;
				if (isLiveFutures) {
					futuresConfirmed = await ctx.ui.confirm(
						t(language, "confirmFuturesTitle"),
						t(language, "confirmFuturesMessage"),
					);
					if (!futuresConfirmed) return;
				}
				try {
					await waitForIdleBeforeMutation(ctx);
					const applied = await runWithAccountSwitchConfirmation(ctx, (confirmAccountSwitch) =>
						trading.setMarketType(target, { confirmAccountSwitch }),
					);
					if (!applied) return;
					updateStatus(ctx);
					show(t(language, "titleMarket"), [
						translate(language, "switchedMarket", {
							market: target,
							hint: target === "usdm-futures" ? t(language, "futuresSymbolHint") : "",
						}),
					]);
					ctx.ui.notify(translate(language, "notifyMarket", { market: target }), "info");
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
			},
		});

		pi.registerCommand("risk", {
			description:
				"Risk limits and entry pause: /risk [show|pause [reason]|resume|reset|reconcile <id> commit|release]",
			handler: async (args, ctx) => {
				const trading = getTrading();
				const arg = args?.trim();
				if (!arg) {
					await openSettings(ctx);
					return;
				}
				const parts = arg.split(/\s+/).filter(Boolean);
				const language = trading.config.language;
				if (parts[0] === "pause") {
					try {
						// Pausing must not wait for a turn whose order is awaiting confirmation.
						const pause = trading.tradingEngine.risk.pauseNewExposure(
							arg.slice("pause".length).trim() || t(language, "riskPauseDefaultReason"),
						);
						updateStatus(ctx);
						ctx.ui.notify(
							translate(language, "riskPauseNotice", { mode: trading.mode, reason: pause.reason }),
							"warning",
						);
					} catch (error) {
						ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
					}
					return;
				}
				if (arg === "resume") {
					if (!ctx.hasUI) {
						ctx.ui.notify(t(language, "riskResumeUiRequired"), "error");
						return;
					}
					try {
						const engine = trading.tradingEngine;
						const pause = engine.risk.usage().newExposurePause;
						if (!pause) {
							ctx.ui.notify(t(language, "riskNotPaused"), "info");
							return;
						}
						const confirmed = await ctx.ui.confirm(
							t(language, "riskResumeTitle"),
							translate(language, "riskResumeMessage", {
								mode: trading.mode,
								pausedAt: pause.pausedAt,
								reason: pause.reason,
							}),
						);
						if (!confirmed) {
							ctx.ui.notify(t(language, "riskResumeCancelled"), "info");
							return;
						}
						await waitForIdleBeforeMutation(ctx);
						const current = getTrading();
						if (current !== trading || current.tradingEngine !== engine) {
							throw new Error(t(language, "riskRuntimeChanged"));
						}
						engine.risk.resumeNewExposure(pause.id);
						updateStatus(ctx);
						ctx.ui.notify(t(language, "riskResumeDone"), "info");
					} catch (error) {
						ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
					}
					return;
				}
				if (arg === "reset") {
					const usage = trading.tradingEngine.risk.usage();
					const ok = await ctx.ui.confirm(
						t(language, "riskResetConfirm"),
						translate(language, "riskResetConfirmBody", {
							used: fmt(usage.used),
							limit: fmt(usage.limit),
							quote: trading.config.quoteCurrency,
						}),
					);
					if (!ok) {
						ctx.ui.notify(t(language, "riskResetCancelled"), "info");
						return;
					}
					await waitForIdleBeforeMutation(ctx);
					trading.tradingEngine.risk.reset();
					ctx.ui.notify(t(language, "riskResetDone"), "info");
					return;
				}
				if (parts[0] === "reconcile") {
					if (!ctx.hasUI) {
						ctx.ui.notify(t(language, "riskReconcileUiRequired"), "error");
						return;
					}
					const engine = trading.tradingEngine;
					const id = parts[1];
					const outcome = parts[2];
					if (parts.length !== 3 || (outcome !== "commit" && outcome !== "release")) {
						ctx.ui.notify(t(language, "riskReconcileUsage"), "warning");
						return;
					}
					const claim = trading.tradingEngine.risk.listPendingReservations().find((item) => item.id === id);
					if (!claim) {
						ctx.ui.notify(translate(language, "riskReservationMissing", { id }), "error");
						return;
					}
					const ok = await ctx.ui.confirm(
						t(language, outcome === "commit" ? "riskCommitTitle" : "riskReleaseTitle"),
						translate(language, "riskReconcileBody", {
							id: claim.id,
							notional: fmt(claim.notional),
							quote: trading.config.quoteCurrency,
							symbol: claim.symbol,
							mode: claim.mode,
						}),
					);
					if (!ok) {
						ctx.ui.notify(t(language, "riskReservationUnchanged"), "info");
						return;
					}
					await waitForIdleBeforeMutation(ctx);
					try {
						if (getTrading() !== trading || getTrading().tradingEngine !== engine)
							throw new Error(t(language, "riskRuntimeChanged"));
						engine.risk.reconcileReservation(id, outcome);
						ctx.ui.notify(
							translate(
								language,
								outcome === "commit" ? "riskReservationCommitted" : "riskReservationReleased",
								{ id },
							),
							"info",
						);
					} catch (error) {
						ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
					}
					return;
				}
				if (arg !== "show") {
					ctx.ui.notify(t(language, "riskUsage"), "warning");
					return;
				}
				const usage = trading.tradingEngine.risk.usage();
				const pending = trading.tradingEngine.risk.listPendingReservations();
				const { risk } = trading.config;
				const usedLabel =
					usage.resetPolicy === "manual"
						? translate(language, "riskUsedCumulative", {
								used: fmt(usage.used),
								quote: trading.config.quoteCurrency,
							})
						: translate(language, "riskUsedDaily", {
								used: fmt(usage.used),
								quote: trading.config.quoteCurrency,
								date: usage.date,
							});
				show(t(language, "titleRisk"), [
					`${t(language, "riskEntries")}: ${t(language, usage.newExposurePause ? "riskEntriesPaused" : "riskEntriesAllowed")}`,
					...(usage.newExposurePause
						? [`${usage.newExposurePause.pausedAt}  ${usage.newExposurePause.reason}`]
						: []),
					t(language, "riskPauseControls"),
					translate(language, "riskMaxOrderLine", {
						value: fmt(risk.maxOrderNotional),
						quote: trading.config.quoteCurrency,
					}),
					translate(language, "riskMaxNotionalLine", {
						value: fmt(risk.maxDailyNotional),
						quote: trading.config.quoteCurrency,
						policy: t(language, usage.resetPolicy === "manual" ? "riskQuotaCumulative" : "riskQuotaDaily"),
					}),
					usedLabel,
					translate(language, "riskReservedLine", {
						value: fmt(usage.reserved),
						quote: trading.config.quoteCurrency,
					}),
					translate(language, "riskAllowedLine", {
						symbols:
							risk.allowedSymbols.length > 0 ? risk.allowedSymbols.join(", ") : t(language, "riskAllowedAll"),
					}),
					translate(language, "riskOrderApprovalLine", {
						value: orderApprovalLabel(language, trading.config.orderApproval),
					}),
					...(pending.length === 0
						? [t(language, "riskUnsettledNone")]
						: [
								translate(language, "riskUnsettledCount", { count: pending.length }),
								...pending.map(
									(claim) =>
										`  ${claim.id}  ${claim.mode}  ${claim.symbol}  ${fmt(claim.notional)} ${trading.config.quoteCurrency}`,
								),
							]),
					"",
					t(language, "riskEditLimits"),
					t(language, "riskSettleHint"),
				]);
				ctx.ui.notify(t(language, "riskShown"), "info");
			},
		});

		pi.registerCommand("recovery", {
			description: "Execution recovery: /recovery [run|resolve <id> commit|release <notional> <evidence-reference>]",
			handler: async (args, ctx) => {
				const trading = getTrading();
				const language = trading.config.language;
				const engine = trading.tradingEngine;
				const parts = args.trim().split(/\s+/).filter(Boolean);
				try {
					if (parts.length === 0) {
						const records = engine.listExecutions();
						const maintenance = engine.getExecutionStatus().maintenance;
						show(t(language, "titleRecovery"), [
							...(maintenance
								? [
										translate(language, "recoveryMaintenanceLine", {
											id: maintenance.id,
											action: maintenance.action,
										}),
									]
								: []),
							...(records.length
								? records.flatMap((entry) => [
										`${entry.id}  ${entry.status}  revision=${entry.revision}  attempts=${entry.attempts}  ${entry.issue ?? ""}`,
										`${entry.scope.mode} ${entry.scope.exchange} ${entry.scope.marketType} ${entry.scope.quoteCurrency} account=${entry.scope.accountId}`,
										JSON.stringify(entry.intent),
									])
								: [t(language, "recoveryNoRecords")]),
						]);
						return;
					}
					if (parts[0] === "maintenance") {
						if (parts.length !== 3 || !/^[A-Za-z0-9_-]{1,80}$/.test(parts[2]))
							throw new Error(t(language, "recoveryMaintenanceUsage"));
						if (!ctx.hasUI) throw new Error(t(language, "recoveryMaintenanceNeedsUi"));
						const maintenance = engine.getExecutionStatus().maintenance;
						if (!maintenance || maintenance.id !== parts[1])
							throw new Error(t(language, "recoveryMaintenanceChanged"));
						if (
							!(await ctx.ui.confirm(
								t(language, "recoveryMaintenanceTitle"),
								translate(language, "recoveryMaintenanceBody", {
									id: maintenance.id,
									action: maintenance.action,
									evidence: parts[2],
								}),
							))
						)
							return;
						await waitForIdleBeforeMutation(ctx);
						if (getTrading() !== trading || trading.tradingEngine !== engine)
							throw new Error(t(language, "riskRuntimeChanged"));
						trading.resolveMaintenance(maintenance.id, parts[2]);
						ctx.ui.notify(t(language, "recoveryMaintenanceReleased"), "info");
						return;
					}
					if (parts.length === 1 && parts[0] === "run") {
						const report = await trading.recoverExecutions();
						show(t(language, "titleRecovery"), [
							translate(language, "recoveryRunReport", {
								examined: report.examined,
								reconciled: report.reconciled,
								unresolved: report.unresolved,
							}),
							...report.issues.map((issue) => `${issue.executionId}: ${issue.issue}`),
						]);
						return;
					}
					const outcome = parts[2];
					const notional = Number(parts[3]);
					if (
						parts.length !== 5 ||
						parts[0] !== "resolve" ||
						(outcome !== "commit" && outcome !== "release") ||
						!Number.isFinite(notional) ||
						notional < 0 ||
						!/^[A-Za-z0-9_-]{1,80}$/.test(parts[4])
					) {
						throw new Error(t(language, "recoveryResolveUsage"));
					}
					if (!ctx.hasUI) throw new Error(t(language, "recoveryResolveNeedsUi"));
					const entry = engine.listExecutions().find((item) => item.id === parts[1]);
					if (!entry) throw new Error(t(language, "recoveryNotFound"));
					const confirmed = await ctx.ui.confirm(
						t(language, "recoveryResolveTitle"),
						translate(language, "recoveryResolveBody", {
							id: entry.id,
							mode: entry.scope.mode,
							exchange: entry.scope.exchange,
							symbol: entry.intent.input.symbol,
							account: entry.scope.accountId,
							outcome,
							notional,
							quote: entry.scope.quoteCurrency,
							evidence: parts[4],
						}),
					);
					if (!confirmed) return;
					await waitForIdleBeforeMutation(ctx);
					if (getTrading() !== trading || trading.tradingEngine !== engine)
						throw new Error(t(language, "riskRuntimeChanged"));
					trading.resolveExecution({
						executionId: entry.id,
						expectedRevision: entry.revision,
						accountId: entry.scope.accountId,
						outcome,
						notional,
						evidenceReference: parts[4],
						verifiedTerminal: true,
					});
					ctx.ui.notify(t(language, "recoveryReconciled"), "info");
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : t(language, "recoveryFailed"), "error");
				}
			},
		});

		pi.registerCommand("audit", {
			description: "Read bounded, redacted trading audit history",
			handler: async (_args, _ctx) => {
				show(
					t(uiLang(), "titleAudit"),
					getTrading()
						.listAuditEvents()
						.map(
							(event) =>
								`${event.at} ${event.mode} ${event.kind} ${event.action ?? ""} ${event.executionId ?? ""} ${event.evidenceReference ?? ""}`,
						),
				);
			},
		});

		pi.registerCommand("paper", {
			description: "Paper account: /paper [reset [startQuote]] — reset simulated balances, e.g. /paper reset 50000",
			handler: async (args, ctx) => {
				const trading = getTrading();
				const parts = args.trim().split(/\s+/).filter(Boolean);
				if (parts.length === 0) {
					await openSettings(ctx);
					return;
				}
				const language = trading.config.language;
				if (parts[0] !== "reset" || parts.length > 2) {
					ctx.ui.notify(t(language, "paperUsage"), "warning");
					return;
				}
				let startQuote: number | undefined;
				if (parts.length === 2) {
					startQuote = Number(parts[1]);
					if (!Number.isFinite(startQuote) || startQuote <= 0) {
						ctx.ui.notify(translate(language, "paperInvalidStart", { value: parts[1] }), "error");
						return;
					}
				}
				if (trading.mode !== "paper") {
					ctx.ui.notify(t(language, "paperResetOnlyHint"), "error");
					return;
				}
				const target = startQuote ?? trading.config.paper.startQuote;
				const confirmed = await ctx.ui.confirm(
					t(language, "paperReset"),
					translate(language, "paperResetWipe", {
						amount: fmt(target),
						quote: trading.config.quoteCurrency,
					}),
				);
				if (!confirmed) {
					ctx.ui.notify(t(language, "paperUnchanged"), "info");
					return;
				}
				await waitForIdleBeforeMutation(ctx);
				const applied = await trading.resetPaperAccount(startQuote, { confirmExposure: true });
				show(t(language, "titlePaper"), [
					translate(language, "paperResetDone", {
						amount: fmt(applied),
						quote: trading.config.quoteCurrency,
					}),
				]);
				ctx.ui.notify(
					translate(language, "paperResetNotify", {
						amount: fmt(applied),
						quote: trading.config.quoteCurrency,
					}),
					"info",
				);
			},
		});

		// /login is reserved by pi for model-provider authentication.
		// Use /exchange-login for trading exchange credentials.
		pi.registerCommand("exchange-login", {
			description: "Configure API credentials for a trading exchange",
			handler: async (args, ctx) => {
				const target = args.trim().toLowerCase();
				if (!target || target === "exchange") {
					await openSettings(ctx);
					return;
				}
				if (!isSupportedExchangeId(target)) {
					ctx.ui.notify(translate(uiLang(), "unsupportedExchange", { exchange: target }), "error");
					return;
				}
				await loginExchange(target, ctx);
			},
		});
	};
}
