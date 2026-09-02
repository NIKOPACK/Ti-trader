import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { getSelectListTheme, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { type Component, type SelectItem, SelectList, type SettingItem, SettingsList } from "@earendil-works/pi-tui";
import { getTrading } from "./context.ts";
import { exchangeLabel, isSupportedExchangeId, SUPPORTED_EXCHANGES } from "./exchanges.ts";
import { t } from "./i18n.ts";
import {
	loadExchangeKeys,
	type MarketType,
	saveExchangeKeys,
	type TradingLanguage,
	type TradingMode,
} from "./state.ts";

export type TradingSettingsResult = { type: "closed" } | { type: "login"; exchange: string };

function lang(): TradingLanguage {
	return getTrading().config.language;
}

function onOff(language: TradingLanguage, value: boolean): string {
	return value ? t(language, "on") : t(language, "off");
}

function parseOnOff(language: TradingLanguage, value: string): boolean {
	return value === t(language, "on");
}

class TitledSelect implements Component {
	private readonly list: SelectList;
	private readonly title: string;
	private readonly description: string;
	private readonly theme: Theme;

	constructor(
		theme: Theme,
		title: string,
		description: string,
		items: SelectItem[],
		current: string,
		onSelect: (value: string) => void,
		onCancel: () => void,
	) {
		this.theme = theme;
		this.title = title;
		this.description = description;
		this.list = new SelectList(items, Math.min(Math.max(items.length, 1), 10), getSelectListTheme());
		const idx = items.findIndex((item) => item.value === current);
		if (idx >= 0) this.list.setSelectedIndex(idx);
		this.list.onSelect = (item) => onSelect(item.value);
		this.list.onCancel = onCancel;
	}

	render(width: number): string[] {
		const lines = [this.theme.bold(this.theme.fg("accent", this.title))];
		if (this.description) {
			lines.push(this.theme.fg("muted", this.description));
		}
		lines.push("");
		return [...lines, ...this.list.render(width)];
	}

	handleInput(data: string): void {
		this.list.handleInput(data);
	}

	invalidate(): void {
		this.list.invalidate();
	}
}

class TwoStepSelect implements Component {
	private phase: "pick" | "confirm" = "pick";
	private readonly pick: TitledSelect;
	private readonly confirm: TitledSelect;

	constructor(
		theme: Theme,
		pickTitle: string,
		pickDescription: string,
		items: SelectItem[],
		current: string,
		confirmValue: string,
		confirmTitle: string,
		confirmDescription: string,
		confirmYes: string,
		confirmNo: string,
		onSelect: (value: string) => void,
		onCancel: () => void,
	) {
		this.pick = new TitledSelect(
			theme,
			pickTitle,
			pickDescription,
			items,
			current,
			(value) => {
				if (value === confirmValue && current !== confirmValue) {
					this.phase = "confirm";
					return;
				}
				onSelect(value);
			},
			onCancel,
		);
		this.confirm = new TitledSelect(
			theme,
			confirmTitle,
			confirmDescription,
			[
				{ value: "yes", label: confirmYes },
				{ value: "no", label: confirmNo },
			],
			"no",
			(value) => {
				if (value === "yes") onSelect(confirmValue);
				else this.phase = "pick";
			},
			() => {
				this.phase = "pick";
			},
		);
	}

	render(width: number): string[] {
		return (this.phase === "confirm" ? this.confirm : this.pick).render(width);
	}

	handleInput(data: string): void {
		(this.phase === "confirm" ? this.confirm : this.pick).handleInput(data);
	}

	invalidate(): void {
		this.pick.invalidate();
		this.confirm.invalidate();
	}
}

function marketTypeLabel(language: TradingLanguage, marketType: MarketType): string {
	if (marketType === "usdm-futures") return t(language, "marketFutures");
	if (marketType === "both") return t(language, "marketBoth");
	return t(language, "marketSpot");
}

export class TradingSettingsPanel implements Component {
	private list: SettingsList;
	private readonly theme: Theme;
	private readonly done: (result?: TradingSettingsResult) => void;
	private readonly ctx: ExtensionCommandContext;
	private readonly onStatus: () => void;
	private applying = false;

	constructor(
		theme: Theme,
		done: (result?: TradingSettingsResult) => void,
		ctx: ExtensionCommandContext,
		onStatus: () => void,
	) {
		this.theme = theme;
		this.done = done;
		this.ctx = ctx;
		this.onStatus = onStatus;
		this.list = this.createList();
	}

	private createList(selectId?: string): SettingsList {
		const list = new SettingsList(
			this.buildItems(),
			12,
			getSettingsListTheme(),
			(id, value) => {
				void this.onChange(id, value);
			},
			() => this.done({ type: "closed" }),
			{ enableSearch: true, hint: t(lang(), "searchHint") },
		);
		if (selectId) list.selectItem(selectId);
		return list;
	}

	private rebuild(selectId?: string): void {
		this.list = this.createList(selectId);
	}

	private async waitForIdle(): Promise<void> {
		if (this.ctx.isIdle()) return;
		this.ctx.ui.notify(t(lang(), "waitingIdle"), "info");
		await this.ctx.waitForIdle();
	}

	private async onChange(id: string, value: string): Promise<void> {
		if (this.applying) return;
		this.applying = true;
		const language = lang();
		try {
			if (id === "api-keys") {
				this.done({ type: "login", exchange: value });
				return;
			}
			await this.waitForIdle();
			const trading = getTrading();
			switch (id) {
				case "language":
					trading.setLanguage(value === "en-US" ? "en-US" : "zh-CN");
					this.onStatus();
					this.rebuild("language");
					return;
				case "mode":
					if (value === "live" && !loadExchangeKeys()[trading.config.exchange]) {
						this.ctx.ui.notify(t(language, "liveKeysMissing"), "error");
						break;
					}
					await trading.setMode(value as TradingMode);
					break;
				case "exchange":
					await trading.setExchange(value);
					break;
				case "market-type": {
					if (value === "both" && trading.mode !== "paper") {
						this.ctx.ui.notify(t(language, "marketBothPaperOnly"), "error");
						break;
					}
					if (value === "usdm-futures" && trading.config.exchange !== "binance") {
						this.ctx.ui.notify(t(language, "marketFuturesBinanceOnly"), "error");
						break;
					}
					await trading.setMarketType(value as MarketType);
					break;
				}
				case "quote-currency":
					await trading.patchConfig({ quoteCurrency: value });
					break;
				case "confirm-live":
					await trading.patchConfig({ confirmLiveOrders: parseOnOff(language, value) });
					break;
				case "risk-reset":
					trading.tradingEngine.risk.reset();
					break;
				case "paper-reset": {
					if (trading.mode !== "paper") {
						this.ctx.ui.notify(t(language, "paperResetOnly"), "error");
						break;
					}
					await trading.resetPaperAccount();
					break;
				}
				case "monitor-enabled":
					await trading.patchConfig({ monitor: { enabled: parseOnOff(language, value) } });
					break;
				case "monitor-interval":
					await trading.patchConfig({ monitor: { intervalSec: Number(value) } });
					break;
				case "monitor-wake":
					await trading.patchConfig({ monitor: { wakeAgent: parseOnOff(language, value) } });
					break;
				case "monitor-guard":
					await trading.patchConfig({ monitor: { guardPositions: parseOnOff(language, value) } });
					break;
				case "monitor-alert":
					await trading.patchConfig({ monitor: { alertLossPct: Number(value) } });
					break;
				case "leverage":
					await trading.patchConfig({ leverage: Number(value) });
					break;
				case "margin-type":
					await trading.patchConfig({ marginType: value === "cross" ? "cross" : "isolated" });
					break;
				case "position-mode":
					await trading.patchConfig({ positionMode: value === "hedge" ? "hedge" : "one-way" });
					break;
				default:
					break;
			}
			this.onStatus();
			this.rebuild(parentSettingId(id));
		} catch (error) {
			this.ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			this.rebuild(parentSettingId(id));
		} finally {
			this.applying = false;
		}
	}

	private buildItems(): SettingItem[] {
		const trading = getTrading();
		const cfg = trading.config;
		const language = cfg.language;
		const keys = loadExchangeKeys();
		const usage = trading.tradingEngine.risk.usage();
		const items: SettingItem[] = [
			{
				id: "language",
				label: t(language, "language"),
				description: t(language, "languageDesc"),
				currentValue: language,
				submenu: (_current, done) =>
					new TitledSelect(
						this.theme,
						t(language, "language"),
						t(language, "languageDesc"),
						[
							{ value: "zh-CN", label: "中文（简体）" },
							{ value: "en-US", label: "English" },
						],
						language,
						(value) => done(value),
						() => done(),
					),
			},
			{
				id: "mode",
				label: t(language, "mode"),
				description: t(language, "modeDesc"),
				currentValue: cfg.mode === "live" ? t(language, "modeLive") : t(language, "modePaper"),
				submenu: (_current, done) =>
					new TwoStepSelect(
						this.theme,
						t(language, "mode"),
						t(language, "modeDesc"),
						[
							{ value: "paper", label: t(language, "modePaper") },
							{ value: "live", label: t(language, "modeLive") },
						],
						cfg.mode,
						"live",
						t(language, "confirmLiveTitle"),
						`${t(language, "confirmLiveMessage")} ${cfg.exchange}. ${t(language, "confirmLive")}: ${onOff(language, cfg.confirmLiveOrders)}.`,
						t(language, "confirmLiveYes"),
						t(language, "confirmLiveNo"),
						(value) => done(value),
						() => done(),
					),
			},
			{
				id: "exchange",
				label: t(language, "exchange"),
				description: t(language, "exchangeDesc"),
				currentValue: exchangeLabel(cfg.exchange, language),
				submenu: (_current, done) =>
					new TitledSelect(
						this.theme,
						t(language, "exchange"),
						t(language, "exchangeDesc"),
						SUPPORTED_EXCHANGES.map((exchange) => ({
							value: exchange.id,
							label: `${exchangeLabel(exchange.id, language)} (${exchange.id})`,
						})),
						cfg.exchange,
						(value) => done(value),
						() => done(),
					),
			},
			{
				id: "market-type",
				label: t(language, "marketType"),
				description: t(language, "marketTypeDesc"),
				currentValue: marketTypeLabel(language, cfg.marketType),
				submenu: (_current, done) => {
					const items = [
						{ value: "spot", label: t(language, "marketSpot") },
						{ value: "usdm-futures", label: t(language, "marketFutures") },
						{ value: "both", label: t(language, "marketBoth") },
					];
					if (cfg.mode === "live") {
						return new TwoStepSelect(
							this.theme,
							t(language, "marketType"),
							t(language, "marketTypeDesc"),
							items,
							cfg.marketType,
							"usdm-futures",
							t(language, "confirmFuturesTitle"),
							t(language, "confirmFuturesMessage"),
							t(language, "confirmFuturesYes"),
							t(language, "confirmFuturesNo"),
							(value) => done(value),
							() => done(),
						);
					}
					return new TitledSelect(
						this.theme,
						t(language, "marketType"),
						t(language, "marketTypeDesc"),
						items,
						cfg.marketType,
						(value) => done(value),
						() => done(),
					);
				},
			},
			{
				id: "quote-currency",
				label: t(language, "quoteCurrency"),
				description: t(language, "quoteCurrencyDesc"),
				currentValue: cfg.quoteCurrency,
				values: uniqueValues(["USDT", "USDC", cfg.quoteCurrency]),
			},
			{
				id: "confirm-live",
				label: t(language, "confirmLive"),
				description: t(language, "confirmLiveDesc"),
				currentValue: onOff(language, cfg.confirmLiveOrders),
				values: [t(language, "on"), t(language, "off")],
			},
			{
				id: "api-keys",
				label: t(language, "keys"),
				description: t(language, "keysDesc"),
				currentValue: keys[cfg.exchange] ? t(language, "keysConfigured") : t(language, "keysMissing"),
				submenu: (_current, done) =>
					new TitledSelect(
						this.theme,
						t(language, "keys"),
						t(language, "keysDesc"),
						SUPPORTED_EXCHANGES.map((exchange) => ({
							value: exchange.id,
							label: `${exchangeLabel(exchange.id, language)} (${exchange.id})`,
							description: keys[exchange.id] ? t(language, "keysConfigured") : t(language, "keysMissing"),
						})),
						cfg.exchange,
						(value) => done(value),
						() => done(),
					),
			},
			{
				id: "risk",
				label: t(language, "risk"),
				description: t(language, "riskDesc"),
				currentValue: `${usage.used}/${usage.limit} ${cfg.quoteCurrency}`,
				submenu: (_current, done) => this.riskSubmenu(done),
			},
			{
				id: "paper",
				label: t(language, "paper"),
				description: t(language, "paperDesc"),
				currentValue: `${cfg.paper.startQuote} ${cfg.quoteCurrency}`,
				submenu: (_current, done) => this.paperSubmenu(done),
			},
			{
				id: "monitor",
				label: t(language, "monitor"),
				description: t(language, "monitorDesc"),
				currentValue: `${onOff(language, cfg.monitor.enabled)} · ${cfg.monitor.intervalSec}${t(language, "secondsSuffix")}`,
				submenu: (_current, done) => this.monitorSubmenu(done),
			},
		];
		if (cfg.marketType === "usdm-futures" || cfg.marketType === "both") {
			items.push({
				id: "futures",
				label: t(language, "futures"),
				description: t(language, "futuresDesc"),
				currentValue: `${cfg.leverage}x · ${cfg.marginType} · ${cfg.positionMode}`,
				submenu: (_current, done) => this.futuresSubmenu(done),
			});
		}
		items.push({
			id: "tui-settings",
			label: t(language, "tuiSettings"),
			description: t(language, "tuiSettingsDesc"),
			currentValue: "/tui-settings",
		});
		return items;
	}

	private nestedList(items: SettingItem[], done: (selectedValue?: string) => void): SettingsList {
		return new SettingsList(
			items,
			Math.min(items.length, 10),
			getSettingsListTheme(),
			(id, value) => {
				void this.onChange(id, value);
			},
			() => done(),
			{ hint: t(lang(), "searchHint") },
		);
	}

	private riskSubmenu(done: (selectedValue?: string) => void): SettingsList {
		const trading = getTrading();
		const cfg = trading.config;
		const language = cfg.language;
		const usage = trading.tradingEngine.risk.usage();
		const allowed =
			cfg.risk.allowedSymbols.length > 0 ? cfg.risk.allowedSymbols.join(", ") : t(language, "riskAllowedAll");
		return this.nestedList(
			[
				{
					id: "risk-max-order",
					label: t(language, "riskMaxOrder"),
					currentValue: `${cfg.risk.maxOrderNotional} ${cfg.quoteCurrency}`,
				},
				{
					id: "risk-max-notional",
					label: t(language, "riskMaxNotional"),
					currentValue: `${cfg.risk.maxDailyNotional} ${cfg.quoteCurrency}`,
				},
				{
					id: "risk-used",
					label: t(language, "riskUsed"),
					currentValue: `${usage.used} ${cfg.quoteCurrency}`,
				},
				{
					id: "risk-allowed",
					label: t(language, "riskAllowed"),
					currentValue: allowed,
				},
				{
					id: "risk-reset",
					label: t(language, "riskReset"),
					description: t(language, "riskDesc"),
					currentValue: t(language, "riskResetAction"),
					submenu: (_current, innerDone) =>
						new TitledSelect(
							this.theme,
							t(language, "riskReset"),
							t(language, "riskResetConfirm"),
							[
								{ value: "yes", label: t(language, "riskResetYes") },
								{ value: "no", label: t(language, "riskResetNo") },
							],
							"no",
							(value) => {
								if (value === "yes") innerDone("yes");
								else innerDone();
							},
							() => innerDone(),
						),
				},
			],
			done,
		);
	}

	private paperSubmenu(done: (selectedValue?: string) => void): SettingsList {
		const cfg = getTrading().config;
		const language = cfg.language;
		return this.nestedList(
			[
				{
					id: "paper-start",
					label: t(language, "paperStart"),
					currentValue: `${cfg.paper.startQuote} ${cfg.quoteCurrency}`,
				},
				{
					id: "paper-fee",
					label: t(language, "paperFee"),
					currentValue: `${(cfg.paper.feeRate * 100).toFixed(2)}%`,
				},
				{
					id: "paper-reset",
					label: t(language, "paperReset"),
					description: t(language, "paperDesc"),
					currentValue: t(language, "paperResetAction"),
					submenu: (_current, innerDone) =>
						new TitledSelect(
							this.theme,
							t(language, "paperReset"),
							t(language, "paperResetConfirm"),
							[
								{ value: "yes", label: t(language, "paperResetYes") },
								{ value: "no", label: t(language, "paperResetNo") },
							],
							"no",
							(value) => {
								if (value === "yes") innerDone("yes");
								else innerDone();
							},
							() => innerDone(),
						),
				},
			],
			done,
		);
	}

	private monitorSubmenu(done: (selectedValue?: string) => void): SettingsList {
		const cfg = getTrading().config;
		const language = cfg.language;
		const intervalValues = uniqueValues(["5", "15", "30", "60", String(cfg.monitor.intervalSec)]);
		const alertValues = uniqueValues(["3", "5", "8", "10", String(cfg.monitor.alertLossPct)]);
		return this.nestedList(
			[
				{
					id: "monitor-enabled",
					label: t(language, "monitorEnabled"),
					currentValue: onOff(language, cfg.monitor.enabled),
					values: [t(language, "on"), t(language, "off")],
				},
				{
					id: "monitor-interval",
					label: t(language, "monitorInterval"),
					currentValue: String(cfg.monitor.intervalSec),
					values: intervalValues,
				},
				{
					id: "monitor-wake",
					label: t(language, "monitorWake"),
					currentValue: onOff(language, cfg.monitor.wakeAgent),
					values: [t(language, "on"), t(language, "off")],
				},
				{
					id: "monitor-guard",
					label: t(language, "monitorGuard"),
					currentValue: onOff(language, cfg.monitor.guardPositions),
					values: [t(language, "on"), t(language, "off")],
				},
				{
					id: "monitor-alert",
					label: t(language, "monitorAlert"),
					currentValue: String(cfg.monitor.alertLossPct),
					values: alertValues,
				},
			],
			done,
		);
	}

	private futuresSubmenu(done: (selectedValue?: string) => void): SettingsList {
		const cfg = getTrading().config;
		const language = cfg.language;
		const leverageValues = uniqueValues(["1", "2", "3", "5", "10", "20", "50", String(cfg.leverage)]);
		return this.nestedList(
			[
				{
					id: "leverage",
					label: t(language, "leverage"),
					currentValue: String(cfg.leverage),
					values: leverageValues,
				},
				{
					id: "margin-type",
					label: t(language, "marginType"),
					currentValue: cfg.marginType === "cross" ? t(language, "marginCross") : t(language, "marginIsolated"),
					submenu: (_current, innerDone) =>
						new TitledSelect(
							this.theme,
							t(language, "marginType"),
							t(language, "futuresDesc"),
							[
								{ value: "isolated", label: t(language, "marginIsolated") },
								{ value: "cross", label: t(language, "marginCross") },
							],
							cfg.marginType,
							(value) => innerDone(value),
							() => innerDone(),
						),
				},
				{
					id: "position-mode",
					label: t(language, "positionMode"),
					currentValue:
						cfg.positionMode === "hedge" ? t(language, "positionHedge") : t(language, "positionOneWay"),
					submenu: (_current, innerDone) =>
						new TitledSelect(
							this.theme,
							t(language, "positionMode"),
							t(language, "futuresDesc"),
							[
								{ value: "one-way", label: t(language, "positionOneWay") },
								{ value: "hedge", label: t(language, "positionHedge") },
							],
							cfg.positionMode,
							(value) => innerDone(value),
							() => innerDone(),
						),
				},
			],
			done,
		);
	}

	render(width: number): string[] {
		const cfg = getTrading().config;
		const language = cfg.language;
		const title = this.theme.bold(this.theme.fg("accent", t(language, "settingsTitle")));
		const status = this.theme.fg(
			"dim",
			`${cfg.mode.toUpperCase()} · ${cfg.exchange} · ${cfg.marketType} · ${cfg.quoteCurrency}`,
		);
		return [title, status, "", ...this.list.render(width)];
	}

	handleInput(data: string): void {
		this.list.handleInput(data);
	}

	invalidate(): void {
		this.list.invalidate();
	}
}

function uniqueValues(values: string[]): string[] {
	return [...new Set(values)];
}

function parentSettingId(id: string): string {
	if (id.startsWith("monitor-")) return "monitor";
	if (id.startsWith("risk-")) return "risk";
	if (id.startsWith("paper-")) return "paper";
	if (id === "leverage" || id === "margin-type" || id === "position-mode") return "futures";
	return id;
}

export async function loginExchange(exchange: string, ctx: ExtensionCommandContext): Promise<void> {
	const apiKey = await ctx.ui.input(`API key for ${exchange}`, "paste API key");
	if (!apiKey) {
		ctx.ui.notify("Cancelled", "info");
		return;
	}
	const secret = await ctx.ui.input(`Secret for ${exchange}`, "paste API secret");
	if (!secret) {
		ctx.ui.notify("Cancelled", "info");
		return;
	}
	const password = await ctx.ui.input(`Password/passphrase for ${exchange} (optional)`, "leave empty if none");
	const keys = loadExchangeKeys();
	keys[exchange] = { apiKey: apiKey.trim(), secret: secret.trim(), password: password?.trim() || undefined };
	saveExchangeKeys(keys);
	ctx.ui.notify(`Keys for ${exchange} saved to ~/.ti-trader/agent/keys.json (mode 600)`, "info");
}

export async function openTradingSettings(ctx: ExtensionCommandContext, onStatus: () => void): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(t(lang(), "settingsTuiOnly"), "warning");
		return;
	}
	while (true) {
		const result = await ctx.ui.custom<TradingSettingsResult | undefined>(
			(_tui, theme, _keybindings, done) => new TradingSettingsPanel(theme, done, ctx, onStatus),
		);
		if (!result || result.type === "closed") return;
		if (result.type === "login") {
			const exchange = result.exchange;
			if (!isSupportedExchangeId(exchange)) {
				ctx.ui.notify(`Unsupported exchange: ${exchange}`, "error");
				continue;
			}
			await loginExchange(exchange, ctx);
		}
	}
}
