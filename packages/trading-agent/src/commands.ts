import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Balance } from "@earendil-works/ti-trading-engine";
import { getTrading } from "./context.ts";
import { isSupportedExchangeId } from "./exchanges.ts";
import { t } from "./i18n.ts";
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
		pi.registerEntryRenderer<TableData>("trading:table", (entry, _opts, theme) =>
			renderTradingTable(entry.data ?? { title: "trading", lines: [] }, theme),
		);

		const show = (title: string, lines: TableLine[], warning?: string): void => {
			pi.appendEntry<TableData>("trading:table", { title, lines, warning });
		};

		const updateStatus = (ctx: ExtensionContext): void => {
			const trading = getTrading();
			ctx.ui.setStatus(
				"trading-status",
				`${trading.mode === "live" ? "LIVE" : "PAPER"}  ${trading.config.exchange}  ${trading.config.marketType}  ${trading.config.quoteCurrency}  ${trading.config.language}`,
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
				trading.setLanguage(language);
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
				if (target === "live") {
					const keys = loadExchangeKeys()[trading.config.exchange];
					if (!keys) {
						ctx.ui.notify(
							`No API keys for ${trading.config.exchange}. Set them with /exchange-login first.`,
							"error",
						);
						return;
					}
					const confirmed = await ctx.ui.confirm(
						"Switch to LIVE trading?",
						`Real orders will be placed on ${trading.config.exchange} with real funds. ` +
							`Confirm-live-orders is ${trading.config.confirmLiveOrders ? "ON" : "OFF"}.`,
					);
					if (!confirmed) {
						ctx.ui.notify("Stayed in paper mode", "info");
						return;
					}
				}
				try {
					await waitForIdleBeforeMutation(ctx);
					await trading.setMode(target as TradingMode);
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
					await trading.setExchange(target);
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
				if (isLiveFutures) {
					const confirmed = await ctx.ui.confirm(
						"Switch to Binance USDⓈ-M futures?",
						"This uses the separate futures wallet and exposes leverage and liquidation risk. Existing spot orders and positions are not changed.",
					);
					if (!confirmed) return;
				}
				try {
					await waitForIdleBeforeMutation(ctx);
					await trading.setMarketType(target);
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
			description: "Show risk limits and usage: /risk [show|reset|reconcile <id> commit|release]",
			handler: async (args, ctx) => {
				const trading = getTrading();
				const arg = args?.trim();
				if (!arg) {
					await openSettings(ctx);
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
				const parts = arg.split(/\s+/).filter(Boolean);
				if (parts[0] === "reconcile") {
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
						trading.tradingEngine.risk.reconcileReservation(id, outcome);
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
					ctx.ui.notify("Usage: /risk [show|reset|reconcile <id> commit|release]", "warning");
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
				const applied = await trading.resetPaperAccount(startQuote);
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
