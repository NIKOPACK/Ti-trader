import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getTrading } from "./context.ts";
import {
	loadExchangeKeys,
	type MarketType,
	saveExchangeKeys,
	type TradingLanguage,
	type TradingMode,
} from "./state.ts";
import { padEndWidth, padStartWidth, renderTradingTable, type TableData, type TableLine } from "./table.ts";

const SUPPORTED_EXCHANGES = [
	{ id: "binance", name: "Binance（币安）" },
	{ id: "okx", name: "OKX" },
	{ id: "bybit", name: "Bybit" },
] as const;

function fmt(n: number | undefined, decimals = 2): string {
	if (n === undefined || !Number.isFinite(n)) return "-";
	return n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtAmount(n: number | undefined): string {
	if (n === undefined || !Number.isFinite(n)) return "-";
	return n.toLocaleString("en-US", { maximumFractionDigits: 8 });
}

function text(language: TradingLanguage, chinese: string, english: string): string {
	return language === "zh-CN" ? chinese : english;
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

		pi.on("session_start", async (_event, ctx) => updateStatus(ctx));

		pi.registerCommand("language", {
			description: "Change TUI language. Usage: /language [zh-CN|en-US]",
			handler: async (args, ctx) => {
				const trading = getTrading();
				let language = args.trim() as TradingLanguage;
				if (!language) {
					const choice = await ctx.ui.select(
						text(trading.config.language, "语言", "Language"),
						trading.config.language === "zh-CN"
							? ["中文（简体）", "English", "取消"]
							: ["中文（简体）", "English", "Cancel"],
					);
					if (!choice || choice === "取消" || choice === "Cancel") return;
					language = choice === "English" ? "en-US" : "zh-CN";
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
				const balances = await trading.exchange.getBalances();
				const total = balances.reduce((s, b) => s + (b.quoteValue ?? 0), 0);
				const english = trading.config.language === "en-US";
				const lines: TableLine[] = [
					`${english ? "Exchange" : "交易所"}: ${trading.exchange.id}   ${english ? "Mode" : "模式"}: ${trading.mode}   ${english ? "Quote" : "计价币"}: ${trading.config.quoteCurrency}`,
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
					`${english ? "Total valuation" : "总资产估值"} ≈ ${fmt(total)} ${trading.config.quoteCurrency}`,
				];
				show("balance", lines);
				ctx.ui.notify(
					`${english ? "Total valuation" : "总资产估值"} ≈ ${fmt(total)} ${trading.config.quoteCurrency} (${trading.mode})`,
					"info",
				);
			},
		});

		pi.registerCommand("positions", {
			description: "Show current holdings with average entry and unrealized PnL when available",
			handler: async (_args, ctx) => {
				const trading = getTrading();
				const positions = await trading.exchange.getPositions();
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
					return {
						text: `${padEndWidth(p.symbol, 12)} ${padStartWidth(fmtAmount(p.amount), 16)}  ≈ ${fmt(p.quoteValue)}${entry}${basis}${pnl}`,
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
				const orders = await getTrading().exchange.getOpenOrders(symbol);
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
				const orders = await getTrading().exchange.getOrderHistory(symbol, 20);
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
				const tickers = await getTrading().exchange.getTopMarkets(limit);
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
				let target = args.trim().toLowerCase();
				if (!target) {
					const choice = await ctx.ui.select(
						text(
							trading.config.language,
							`交易模式（当前：${trading.mode}）`,
							`Trading mode (current: ${trading.mode})`,
						),
						trading.config.language === "zh-CN"
							? ["模拟盘（paper）", "实盘（live）", "取消"]
							: ["Paper", "Live", "Cancel"],
					);
					if (!choice || choice === "取消" || choice === "Cancel") return;
					target = choice.toLowerCase().includes("live") ? "live" : "paper";
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
				let target = args.trim().toLowerCase();
				if (!target) {
					const choice = await ctx.ui.select(
						text(
							trading.config.language,
							`选择交易所（当前：${trading.config.exchange}）`,
							`Select exchange (current: ${trading.config.exchange})`,
						),
						[
							...SUPPORTED_EXCHANGES.map((exchange) => `${exchange.name} (${exchange.id})`),
							text(trading.config.language, "取消", "Cancel"),
						],
					);
					if (!choice || choice === "取消" || choice === "Cancel") return;
					target = SUPPORTED_EXCHANGES.find((exchange) => choice.endsWith(`(${exchange.id})`))?.id ?? choice;
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
				let target = args.trim().toLowerCase() as MarketType | "";
				if (!target) {
					const choice = await ctx.ui.select(
						text(
							trading.config.language,
							`市场类型（当前：${trading.config.marketType}）`,
							`Market type (current: ${trading.config.marketType})`,
						),
						trading.config.language === "zh-CN"
							? ["现货（spot）", "USDⓈ-M 合约（usdm-futures）", "现货+合约（仅 paper）", "取消"]
							: ["Spot (spot)", "USDⓈ-M Futures (usdm-futures)", "Spot + Futures (paper only)", "Cancel"],
					);
					if (!choice || choice === "取消" || choice === "Cancel") return;
					target =
						choice.includes("现货+") || choice.includes("Spot + Futures")
							? "both"
							: choice.includes("usdm-futures")
								? "usdm-futures"
								: "spot";
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
			description: "Show risk limits and usage: /risk [reset]",
			handler: async (args, ctx) => {
				const trading = getTrading();
				let arg = args?.trim();
				if (!arg) {
					const choice = await ctx.ui.select(
						text(trading.config.language, "风险管理", "Risk management"),
						trading.config.language === "zh-CN"
							? ["查看风险状态", "重置已用额度", "取消"]
							: ["Show risk status", "Reset used quota", "Cancel"],
					);
					if (!choice || choice === "取消" || choice === "Cancel") return;
					arg = choice.toLowerCase().startsWith("reset") || choice === "重置已用额度" ? "reset" : "show";
				}
				if (arg === "reset") {
					const usage = trading.dailyUsage();
					const ok = await ctx.ui.confirm(
						"Reset used notional quota?",
						`Used ${fmt(usage.used)} of ${fmt(usage.limit)} ${trading.config.quoteCurrency} will be reset to 0.`,
					);
					if (!ok) {
						ctx.ui.notify("Risk usage reset cancelled", "info");
						return;
					}
					await waitForIdleBeforeMutation(ctx);
					trading.resetRiskUsage();
					ctx.ui.notify("Used notional quota reset to 0", "info");
					return;
				}
				if (arg !== "show") {
					ctx.ui.notify("Usage: /risk [reset]", "warning");
					return;
				}
				const usage = trading.dailyUsage();
				const { risk } = trading.config;
				const usedLabel =
					usage.resetPolicy === "manual"
						? `Used (cumulative): ${fmt(usage.used)} ${trading.config.quoteCurrency} — manual reset via /risk reset`
						: `Used today:        ${fmt(usage.used)} ${trading.config.quoteCurrency} (${usage.date}, resets daily)`;
				show("risk", [
					`Max per order:     ${fmt(risk.maxOrderNotional)} ${trading.config.quoteCurrency}`,
					`Max notional:      ${fmt(risk.maxDailyNotional)} ${trading.config.quoteCurrency} ${usage.resetPolicy === "manual" ? "(cumulative quota, paper)" : "(per day, live)"}`,
					usedLabel,
					`Allowed symbols:   ${risk.allowedSymbols.length > 0 ? risk.allowedSymbols.join(", ") : "(all)"}`,
					`Confirm live:      ${trading.config.confirmLiveOrders ? "yes" : "no"}`,
					"",
					"Edit limits in ~/.ti-trader/agent/trading.json",
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
					const choice = await ctx.ui.select(
						text(trading.config.language, "模拟账户", "Paper account"),
						trading.config.language === "zh-CN"
							? ["查看账户", "重置账户", "取消"]
							: ["Show account", "Reset account", "Cancel"],
					);
					if (choice?.toLowerCase().startsWith("reset") || choice === "重置账户") parts.push("reset");
					else if (!choice || choice === "取消" || choice === "Cancel") return;
				}
				if (parts.length === 0) {
					const balances = await trading.exchange.getBalances();
					const total = balances.reduce((s, b) => s + (b.quoteValue ?? 0), 0);
					show("paper", [
						`Mode: ${trading.mode}   Exchange: ${trading.config.exchange}`,
						`Configured start balance: ${fmt(trading.config.paper.startQuote)} ${trading.config.quoteCurrency}`,
						`Current total value: ≈ ${fmt(total)} ${trading.config.quoteCurrency}`,
						"",
						"Reset with /paper reset [startQuote], e.g. /paper reset 50000",
					]);
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
				const applied = trading.resetPaperAccount(startQuote);
				show("paper", [`Paper account reset. Balance: ${fmt(applied)} ${trading.config.quoteCurrency}.`]);
				ctx.ui.notify(`Paper account reset to ${fmt(applied)} ${trading.config.quoteCurrency}`, "info");
			},
		});

		const loginExchange = async (exchange: string, ctx: ExtensionCommandContext): Promise<void> => {
			const apiKey = await ctx.ui.input(`API key for ${exchange}`, "paste API key");
			if (!apiKey) return ctx.ui.notify("Cancelled", "info");
			const secret = await ctx.ui.input(`Secret for ${exchange}`, "paste API secret");
			if (!secret) return ctx.ui.notify("Cancelled", "info");
			const password = await ctx.ui.input(`Password/passphrase for ${exchange} (optional)`, "leave empty if none");
			const keys = loadExchangeKeys();
			keys[exchange] = { apiKey: apiKey.trim(), secret: secret.trim(), password: password?.trim() || undefined };
			saveExchangeKeys(keys);
			ctx.ui.notify(`Keys for ${exchange} saved to ~/.ti-trader/agent/keys.json (mode 600)`, "info");
		};

		// /login is reserved by pi for model-provider authentication.
		// Use /exchange-login for trading exchange credentials.
		pi.registerCommand("exchange-login", {
			description: "Configure API credentials for a trading exchange",
			handler: async (args, ctx) => {
				const target = args.trim().toLowerCase();

				const exchangeChoice =
					target && target !== "exchange"
						? target
						: await ctx.ui.select(
								"选择交易所（Select exchange）",
								SUPPORTED_EXCHANGES.map((exchange) => `${exchange.name} (${exchange.id})`),
							);
				if (!exchangeChoice) return;
				const exchange =
					SUPPORTED_EXCHANGES.find((item) => exchangeChoice.endsWith(`(${item.id})`))?.id ?? exchangeChoice;
				if (!SUPPORTED_EXCHANGES.some((item) => item.id === exchange)) {
					ctx.ui.notify(`Unsupported exchange: ${exchange}`, "error");
					return;
				}
				await loginExchange(exchange, ctx);
			},
		});
	};
}
