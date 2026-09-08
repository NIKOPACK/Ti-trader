import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Balance } from "@earendil-works/ti-trading-engine";
import { AccountSwitchConfirmationRequired, getTrading } from "./context.ts";
import { isSupportedExchangeId } from "./exchanges.ts";
import { t, translate } from "./i18n.ts";
import { loginExchange, openTradingSettings } from "./settings-menu.ts";
import { wrapTradingAutocomplete } from "./slash-autocomplete.ts";
import { loadExchangeKeys, type MarketType, type TradingLanguage, type TradingMode } from "./state.ts";
import { padEndWidth, padStartWidth, renderTradingTable, type TableData, type TableLine } from "./table.ts";

function fmt(n: number | undefined, decimals = 2): string {
	if (n === undefined || !Number.isFinite(n)) return "-";
	return n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtAmount(n: number | undefined): string {
	if (n === undefined || !Number.isFinite(n)) return "-";
	return n.toLocaleString("en-US", { maximumFractionDigits: 8 });
}

function hasFiniteQuoteValue(balance: Balance): balance is Balance & { quoteValue: number } {
	return balance.quoteValue !== undefined && Number.isFinite(balance.quoteValue);
}

async function waitForIdleBeforeMutation(ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.isIdle()) return;
	ctx.ui.notify("Waiting for the active agent turn before changing trading state", "info");
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
		const confirmed = await ctx.ui.confirm(
			"Confirm account switch?",
			"The previous account may still have orders or positions, or could not be fully verified. They will remain there but be hidden by the new configuration. Continue only after verifying them.",
		);
		if (!confirmed) {
			ctx.ui.notify("Account switch cancelled", "info");
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
			const label = mode === "live" ? "LIVE (real funds)" : "PAPER (simulated)";
			if (ctx.hasUI) ctx.ui.notify(`Trading mode changed: ${previous.toUpperCase()} → ${label}`, "warning");
			pi.sendMessage(
				{
					customType: "mode-change",
					content: `[mode change] Trading mode is now ${label}. Re-check this before placing any order.`,
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
					`Risk: ${pending.length} unsettled reservation(s). Verify exchange orders, then /risk reconcile <id> commit|release.`,
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

		const updateStatus = (ctx: ExtensionContext): void => {
			const trading = getTrading();
			const paused = trading.tradingEngine.risk.usage().newExposurePause !== undefined;
			ctx.ui.setStatus(
				"trading-status",
				`${trading.mode === "live" ? "LIVE" : "PAPER"}  ${trading.config.exchange}  ${trading.config.marketType}  ${trading.config.quoteCurrency}  ${trading.config.language}${paused ? `  ${t(trading.config.language, "riskEntriesPaused")}` : ""}`,
			);
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
					ctx.ui.notify("Language must be zh-CN or en-US", "error");
					return;
				}
				await waitForIdleBeforeMutation(ctx);
				await trading.setLanguage(language);
				updateStatus(ctx);
				ctx.ui.notify(language === "zh-CN" ? "语言已切换为中文" : "Language changed to English", "info");
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
						: `- (${fmt(total)} known; valuation incomplete)`;
				const english = trading.config.language === "en-US";
				const lines: TableLine[] = [
					`${english ? "Exchange" : "交易所"}: ${trading.tradingEngine.id}   ${english ? "Mode" : "模式"}: ${trading.mode}   ${english ? "Quote" : "计价币"}: ${trading.config.quoteCurrency}`,
					"",
					{
						text: `${padEndWidth(english ? "Asset" : "资产", 8)} ${padStartWidth(english ? "Available" : "可用余额", 16)}  ${padStartWidth(english ? "Locked" : "冻结余额", 14)}  ${padStartWidth(english ? "Valuation" : "估值", 16)}`,
						tone: "muted",
					},
					...balances.map(
						(b) =>
							`${padEndWidth(b.asset, 8)} ${padStartWidth(fmtAmount(b.free), 16)}  ${padStartWidth(fmtAmount(b.used), 14)}  ${padStartWidth(`${fmt(b.quoteValue)} ${trading.config.quoteCurrency}`, 16)}`,
					),
					"",
					`${english ? "Total valuation" : "总资产估值"} ≈ ${totalLabel}`,
				];
				show("balance", lines);
				ctx.ui.notify(`${english ? "Total valuation" : "总资产估值"} ≈ ${totalLabel} (${trading.mode})`, "info");
			},
		});

		pi.registerCommand("positions", {
			description: "Show current holdings with average entry and unrealized PnL when available",
			handler: async (_args, ctx) => {
				const trading = getTrading();
				const positions = await trading.tradingEngine.getPositions();
				if (positions.length === 0) {
					show("positions", ["No open positions."]);
					return;
				}
				const lines: TableLine[] = positions.map((p) => {
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
				});
				show("positions", lines);
				ctx.ui.notify(`${positions.length} position(s)`, "info");
			},
		});

		pi.registerCommand("orders", {
			description: "Show open orders. Usage: /orders [symbol]",
			handler: async (args, ctx) => {
				const symbol = args.trim() || undefined;
				const orders = await getTrading().tradingEngine.getOpenOrders(symbol);
				if (orders.length === 0) {
					show("orders", ["No open orders."]);
					return;
				}
				show(
					"orders",
					orders.map((o): TableLine => {
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
				);
				ctx.ui.notify(`${orders.length} open order(s)`, "info");
			},
		});

		pi.registerCommand("trades", {
			description: "Show recently closed orders. Usage: /trades [symbol]",
			handler: async (args, ctx) => {
				const symbol = args.trim() || undefined;
				const orders = await getTrading().tradingEngine.getOrderHistory(symbol, 20);
				if (orders.length === 0) {
					show("trades", ["No order history."]);
					return;
				}
				show(
					"trades",
					orders.map(
						(o): TableLine => ({
							text: `#${o.id} ${padEndWidth(o.side, 4)} ${padEndWidth(o.symbol, 12)} ${fmtAmount(o.filled)} @ ${fmt(o.average, 6)}  ${o.status}  (${new Date(o.timestamp).toLocaleString()})`,
							tone: o.side === "buy" ? "up" : "down",
						}),
					),
				);
				ctx.ui.notify(`${orders.length} historical order(s)`, "info");
			},
		});

		pi.registerCommand("markets", {
			description: `Show top markets by 24h quote volume. Usage: /markets [limit]`,
			handler: async (args, ctx) => {
				const limit = Math.min(Math.max(Number.parseInt(args.trim(), 10) || 15, 1), 50);
				const tickers = await getTrading().tradingEngine.getTopMarkets(limit);
				show(
					"markets",
					tickers.map(
						(t, i): TableLine => ({
							text: `${String(i + 1).padStart(2)}. ${padEndWidth(t.symbol, 14)} ${padStartWidth(fmt(t.last, 6), 14)}  ${(t.changePct24h ?? 0) >= 0 ? "+" : ""}${fmt(t.changePct24h)}%  vol ${fmt(t.quoteVolume24h, 0)}`,
							tone: (t.changePct24h ?? 0) >= 0 ? "up" : "down",
						}),
					),
				);
				ctx.ui.notify(`Top ${tickers.length} markets by volume`, "info");
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
				if (target !== "paper" && target !== "live") {
					ctx.ui.notify(`Unknown mode "${target}". Use paper or live.`, "error");
					return;
				}
				let liveConfirmed = false;
				if (target === "live") {
					const keys = loadExchangeKeys()[trading.config.exchange];
					if (!keys) {
						ctx.ui.notify(
							`No API keys for ${trading.config.exchange}. Set them with /exchange-login first.`,
							"error",
						);
						return;
					}
					liveConfirmed = await ctx.ui.confirm(
						"Switch to LIVE trading?",
						`Real orders will be placed on ${trading.config.exchange} with real funds. ` +
							`Confirm-live-orders is ${trading.config.confirmLiveOrders ? "ON" : "OFF"}.`,
					);
					if (!liveConfirmed) {
						ctx.ui.notify("Stayed in paper mode", "info");
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
					show("mode", [
						{
							text: `Switched to ${target.toUpperCase()} trading on ${trading.config.exchange}.`,
							tone: target === "live" ? "warn" : undefined,
						},
					]);
					ctx.ui.notify(`Mode: ${target}`, "info");
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
					show("exchange", [`Switched to ${target} (${trading.mode} mode).`]);
					ctx.ui.notify(`Exchange: ${target}`, "info");
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
				if (target !== "spot" && target !== "usdm-futures" && target !== "both") {
					ctx.ui.notify(`Unknown market type "${target}". Use spot, usdm-futures, or both.`, "error");
					return;
				}
				if (target === "both" && trading.mode !== "paper") {
					ctx.ui.notify('market type "both" is available only in paper mode', "error");
					return;
				}
				if (target === "usdm-futures" && trading.config.exchange !== "binance") {
					ctx.ui.notify("USDⓈ-M futures require Binance", "error");
					return;
				}
				const isLiveFutures = trading.mode === "live" && target === "usdm-futures";
				let futuresConfirmed = false;
				if (isLiveFutures) {
					futuresConfirmed = await ctx.ui.confirm(
						"Switch to Binance USDⓈ-M futures?",
						"This uses the separate futures wallet and exposes leverage and liquidation risk. Existing spot orders and positions are not changed.",
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
					show("market", [
						`Market type: ${target}`,
						target === "usdm-futures" ? "Symbol format: BTC/USDT:USDT" : "",
					]);
					ctx.ui.notify(`Market type: ${target}`, "info");
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
						"Reset used notional quota?",
						`Used ${fmt(usage.used)} of ${fmt(usage.limit)} ${trading.config.quoteCurrency} will be reset to 0.`,
					);
					if (!ok) {
						ctx.ui.notify("Risk usage reset cancelled", "info");
						return;
					}
					await waitForIdleBeforeMutation(ctx);
					trading.tradingEngine.risk.reset();
					ctx.ui.notify("Used notional quota reset to 0", "info");
					return;
				}
				if (parts[0] === "reconcile") {
					if (!ctx.hasUI) {
						ctx.ui.notify("Manual reconciliation requires interactive confirmation", "error");
						return;
					}
					const engine = trading.tradingEngine;
					const id = parts[1];
					const outcome = parts[2];
					if (parts.length !== 3 || (outcome !== "commit" && outcome !== "release")) {
						ctx.ui.notify("Usage: /risk reconcile <id> commit|release", "warning");
						return;
					}
					const claim = trading.tradingEngine.risk.listPendingReservations().find((item) => item.id === id);
					if (!claim) {
						ctx.ui.notify(`No unsettled reservation ${id}`, "error");
						return;
					}
					const ok = await ctx.ui.confirm(
						outcome === "commit"
							? "Commit reserved notional into used quota?"
							: "Release reserved notional without counting it as used?",
						`Reservation ${claim.id}: ${fmt(claim.notional)} ${trading.config.quoteCurrency} on ${claim.symbol} (${claim.mode}). Verify the exchange order first. Do not retry the submission.`,
					);
					if (!ok) {
						ctx.ui.notify("Risk reservation unchanged", "info");
						return;
					}
					await waitForIdleBeforeMutation(ctx);
					try {
						if (getTrading() !== trading || getTrading().tradingEngine !== engine)
							throw new Error("Trading runtime changed during confirmation");
						engine.risk.reconcileReservation(id, outcome);
						ctx.ui.notify(
							outcome === "commit" ? `Reservation ${id} committed to used quota` : `Reservation ${id} released`,
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
						? `Used (cumulative): ${fmt(usage.used)} ${trading.config.quoteCurrency} — manual reset via /risk reset`
						: `Used today:        ${fmt(usage.used)} ${trading.config.quoteCurrency} (${usage.date}, resets daily)`;
				show("risk", [
					`${t(language, "riskEntries")}: ${t(language, usage.newExposurePause ? "riskEntriesPaused" : "riskEntriesAllowed")}`,
					...(usage.newExposurePause
						? [`${usage.newExposurePause.pausedAt}  ${usage.newExposurePause.reason}`]
						: []),
					t(language, "riskPauseControls"),
					`Max per order:     ${fmt(risk.maxOrderNotional)} ${trading.config.quoteCurrency}`,
					`Max notional:      ${fmt(risk.maxDailyNotional)} ${trading.config.quoteCurrency} ${usage.resetPolicy === "manual" ? "(cumulative quota, paper)" : "(per day, live)"}`,
					usedLabel,
					`Reserved:          ${fmt(usage.reserved)} ${trading.config.quoteCurrency}`,
					`Allowed symbols:   ${risk.allowedSymbols.length > 0 ? risk.allowedSymbols.join(", ") : "(all)"}`,
					`Confirm live:      ${trading.config.confirmLiveOrders ? "yes" : "no"}`,
					...(pending.length === 0
						? ["Unsettled:         none"]
						: [
								`Unsettled:         ${pending.length}`,
								...pending.map(
									(claim) =>
										`  ${claim.id}  ${claim.mode}  ${claim.symbol}  ${fmt(claim.notional)} ${trading.config.quoteCurrency}`,
								),
							]),
					"",
					"Edit limits in ~/.ti-trader/agent/trading.json",
					"Settle stuck claims with /risk reconcile <id> commit|release after verifying the exchange.",
				]);
				ctx.ui.notify("Risk limits shown in transcript", "info");
			},
		});

		pi.registerCommand("recovery", {
			description: "Execution recovery: /recovery [run|resolve <id> commit|release <notional> <evidence-reference>]",
			handler: async (args, ctx) => {
				const trading = getTrading();
				const engine = trading.tradingEngine;
				const parts = args.trim().split(/\s+/).filter(Boolean);
				try {
					if (parts.length === 0) {
						const records = engine.listExecutions();
						const maintenance = engine.getExecutionStatus().maintenance;
						show("recovery", [
							...(maintenance
								? [
										`Maintenance ${maintenance.id}: ${maintenance.action}; all submissions blocked. Verify every writer is stopped and account/risk state is consistent before /recovery maintenance ${maintenance.id} <evidence-reference>.`,
									]
								: []),
							...(records.length
								? records.flatMap((entry) => [
										`${entry.id}  ${entry.status}  revision=${entry.revision}  attempts=${entry.attempts}  ${entry.issue ?? ""}`,
										`${entry.scope.mode} ${entry.scope.exchange} ${entry.scope.marketType} ${entry.scope.quoteCurrency} account=${entry.scope.accountId}`,
										JSON.stringify(entry.intent),
									])
								: ["No execution records."]),
						]);
						return;
					}
					if (parts[0] === "maintenance") {
						if (parts.length !== 3 || !/^[A-Za-z0-9_-]{1,80}$/.test(parts[2]))
							throw new Error("Usage: /recovery maintenance <id> <evidence-reference>");
						if (!ctx.hasUI) throw new Error("Maintenance resolution requires interactive human confirmation");
						const maintenance = engine.getExecutionStatus().maintenance;
						if (!maintenance || maintenance.id !== parts[1]) throw new Error("Account maintenance changed");
						if (
							!(await ctx.ui.confirm(
								"Release abandoned account maintenance?",
								`${maintenance.id}: ${maintenance.action}. Confirm every other writer is stopped and account, configuration and risk state have been independently verified consistent. This does not rerun or finish a reset. Evidence=${parts[2]}`,
							))
						)
							return;
						await waitForIdleBeforeMutation(ctx);
						if (getTrading() !== trading || trading.tradingEngine !== engine)
							throw new Error("Trading runtime changed during confirmation");
						trading.resolveMaintenance(maintenance.id, parts[2]);
						ctx.ui.notify("Maintenance fence released; manual entry pauses remain in effect", "info");
						return;
					}
					if (parts.length === 1 && parts[0] === "run") {
						const report = await trading.recoverExecutions();
						show("recovery", [
							`Examined ${report.examined}; reconciled ${report.reconciled}; unresolved ${report.unresolved}. No orders were resubmitted.`,
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
						throw new Error(
							"Usage: /recovery resolve <id> commit|release <notional> <evidence-reference>. Evidence must be a non-secret reference, not raw exchange data.",
						);
					}
					if (!ctx.hasUI) throw new Error("Manual execution resolution requires interactive human confirmation");
					const entry = engine.listExecutions().find((item) => item.id === parts[1]);
					if (!entry) throw new Error("Execution record not found");
					const confirmed = await ctx.ui.confirm(
						"Resolve execution with verified terminal evidence?",
						`${entry.id}: ${entry.scope.mode} ${entry.scope.exchange} ${entry.intent.input.symbol}; account=${entry.scope.accountId}.\n` +
							`Decision: ${outcome} ${notional} ${entry.scope.quoteCurrency}; evidence=${parts[4]}.\n` +
							"Confirm all submitting processes are stopped or this request has finished, and exchange evidence proves terminal status and final filled notional. Release requires zero fills and no possibility of later acceptance. This NEVER retries an order.",
					);
					if (!confirmed) return;
					await waitForIdleBeforeMutation(ctx);
					if (getTrading() !== trading || trading.tradingEngine !== engine)
						throw new Error("Trading runtime changed during confirmation");
					trading.resolveExecution({
						executionId: entry.id,
						expectedRevision: entry.revision,
						accountId: entry.scope.accountId,
						outcome,
						notional,
						evidenceReference: parts[4],
						verifiedTerminal: true,
					});
					ctx.ui.notify("Execution reconciled; any manual entry pause remains in effect", "info");
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : "Execution recovery failed", "error");
				}
			},
		});

		pi.registerCommand("audit", {
			description: "Read bounded, redacted trading audit history",
			handler: async (_args, _ctx) => {
				show(
					"audit",
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
				if (parts[0] !== "reset" || parts.length > 2) {
					ctx.ui.notify("Usage: /paper [reset [startQuote]]", "warning");
					return;
				}
				let startQuote: number | undefined;
				if (parts.length === 2) {
					startQuote = Number(parts[1]);
					if (!Number.isFinite(startQuote) || startQuote <= 0) {
						ctx.ui.notify(`Invalid start balance: ${parts[1]}`, "error");
						return;
					}
				}
				if (trading.mode !== "paper") {
					ctx.ui.notify("Paper reset is only available in paper mode (see /mode)", "error");
					return;
				}
				const target = startQuote ?? trading.config.paper.startQuote;
				const confirmed = await ctx.ui.confirm(
					"Reset paper account?",
					`All simulated balances, open orders and trade history will be wiped. ` +
						`New starting balance: ${fmt(target)} ${trading.config.quoteCurrency}.`,
				);
				if (!confirmed) {
					ctx.ui.notify("Paper account unchanged", "info");
					return;
				}
				await waitForIdleBeforeMutation(ctx);
				const applied = await trading.resetPaperAccount(startQuote, { confirmExposure: true });
				show("paper", [`Paper account reset. Balance: ${fmt(applied)} ${trading.config.quoteCurrency}.`]);
				ctx.ui.notify(`Paper account reset to ${fmt(applied)} ${trading.config.quoteCurrency}`, "info");
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
					ctx.ui.notify(`Unsupported exchange: ${target}`, "error");
					return;
				}
				await loginExchange(target, ctx);
			},
		});
	};
}
