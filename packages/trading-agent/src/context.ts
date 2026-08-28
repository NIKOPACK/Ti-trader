import { CcxtExchangeClient } from "./exchange/ccxt-client.ts";
import { PaperExchangeClient } from "./exchange/paper-client.ts";
import type { ExchangeClient } from "./exchange/types.ts";
import {
	loadExchangeKeys,
	loadTradingConfig,
	loadTradingState,
	type MarketType,
	saveTradingConfig,
	saveTradingState,
	type TradingConfig,
	type TradingLanguage,
	type TradingMode,
	type TradingState,
} from "./state.ts";

/**
 * Process-wide trading runtime: the active exchange client, trading config and
 * daily risk counters. Initialized once in main() before the agent session
 * starts; tools and commands access it via getTrading().
 */
export class TradingRuntime {
	config: TradingConfig;
	private state: TradingState;
	private client: ExchangeClient | undefined;

	private constructor(config: TradingConfig) {
		this.config = config;
		this.state = loadTradingState();
	}

	static async init(overrides: { mode?: TradingMode; exchange?: string } = {}): Promise<TradingRuntime> {
		const config = loadTradingConfig();
		if (overrides.mode) config.mode = overrides.mode;
		if (overrides.exchange) config.exchange = overrides.exchange;
		const runtime = new TradingRuntime(config);
		runtime.client = await runtime.createClient();
		return runtime;
	}

	get exchange(): ExchangeClient {
		if (!this.client) throw new Error("Trading runtime not initialized");
		return this.client;
	}

	get mode(): TradingMode {
		return this.config.mode;
	}

	setLanguage(language: TradingLanguage): void {
		if (language !== "zh-CN" && language !== "en-US") throw new Error(`Invalid language: ${language}`);
		this.config = { ...this.config, language };
		saveTradingConfig(this.config);
	}

	async setMode(mode: TradingMode): Promise<void> {
		if (mode === this.config.mode) return;
		const nextConfig = { ...this.config, mode };
		await this.replaceClient(nextConfig);
	}

	async setExchange(id: string): Promise<void> {
		const normalized = id.trim().toLowerCase();
		if (!normalized) throw new Error("Exchange id must not be empty");
		if (normalized === this.config.exchange) return;
		const nextConfig = { ...this.config, exchange: normalized };
		await this.replaceClient(nextConfig);
	}

	async setMarketType(marketType: MarketType): Promise<void> {
		if (!("spot" === marketType || "usdm-futures" === marketType || "both" === marketType))
			throw new Error(`Invalid market type: ${marketType}`);
		if (marketType === this.config.marketType) return;
		const nextConfig = { ...this.config, marketType };
		await this.replaceClient(nextConfig);
	}

	/**
	 * Validate an order against risk limits. Returns an error message, or null
	 * when the order is within limits.
	 */
	checkRisk(symbol: string, notional: number, options: { countTowardsDailyLimit?: boolean } = {}): string | null {
		const { risk, quoteCurrency, marketType } = this.config;
		const countTowardsDailyLimit = options.countTowardsDailyLimit ?? true;
		const symbolParts = symbol.split("/");
		const validSymbol =
			symbolParts.length === 2 &&
			(marketType === "both"
				? symbolParts[1] === quoteCurrency || symbolParts[1] === `${quoteCurrency}:${quoteCurrency}`
				: symbolParts[1] === (marketType === "usdm-futures" ? `${quoteCurrency}:${quoteCurrency}` : quoteCurrency));
		if (!validSymbol) {
			return `Symbol ${symbol} must use ${marketType === "both" ? `spot /${quoteCurrency} or futures /${quoteCurrency}:${quoteCurrency}` : marketType === "usdm-futures" ? `futures quote ${quoteCurrency} (for example BTC/${quoteCurrency}:${quoteCurrency})` : `quote currency ${quoteCurrency}`}`;
		}
		if (!Number.isFinite(notional) || notional <= 0) return "Order notional must be a positive finite number";
		if (risk.allowedSymbols.length > 0 && !risk.allowedSymbols.includes(symbol)) {
			return `Symbol ${symbol} is not in risk.allowedSymbols (${risk.allowedSymbols.join(", ")})`;
		}
		if (notional > risk.maxOrderNotional) {
			return `Order notional ${notional.toFixed(2)} ${quoteCurrency} exceeds maxOrderNotional ${risk.maxOrderNotional}`;
		}
		// Protective exit orders (for example an OCO attached to an existing
		// position) still obey the per-order cap, but must not consume the
		// entry-notional quota. Otherwise adding protection can reject the very
		// position it is meant to protect.
		if (!countTowardsDailyLimit) return null;
		this.refreshDailyCounter();
		if (this.state.usedDailyNotional + notional > risk.maxDailyNotional) {
			const used = this.state.usedDailyNotional.toFixed(2);
			return (
				`Order would exceed maxDailyNotional ${risk.maxDailyNotional} ${quoteCurrency} ` +
				(this.config.mode === "paper"
					? `(already used ${used} cumulatively; the quota only resets when the user runs /risk reset or /paper reset)`
					: `(already used ${used} today)`)
			);
		}
		return null;
	}

	/** Record entry/order notional against the daily limit. Protective exits are excluded. */
	recordFill(notional: number, options: { countTowardsDailyLimit?: boolean } = {}): void {
		if (options.countTowardsDailyLimit === false) return;
		this.refreshDailyCounter();
		this.state.usedDailyNotional += notional;
		saveTradingState(this.state);
	}

	/** Manually reset the used-notional counter (paper quota is cumulative). */
	resetRiskUsage(): void {
		this.state = { date: new Date().toISOString().slice(0, 10), usedDailyNotional: 0 };
		saveTradingState(this.state);
	}

	dailyUsage(): { date: string; used: number; limit: number; resetPolicy: "daily-auto" | "manual" } {
		this.refreshDailyCounter();
		return {
			date: this.state.date,
			used: this.state.usedDailyNotional,
			limit: this.config.risk.maxDailyNotional,
			resetPolicy: this.config.mode === "paper" ? "manual" : "daily-auto",
		};
	}

	async close(): Promise<void> {
		await this.client?.close();
	}

	/**
	 * Reset the simulated account, optionally changing (and persisting) the
	 * starting quote balance. Paper mode only.
	 */
	resetPaperAccount(startQuote?: number): number {
		if (this.config.mode !== "paper") throw new Error("Paper account reset is only available in paper mode");
		const client = this.exchange;
		if (!(client instanceof PaperExchangeClient)) throw new Error("Active exchange client is not a paper client");
		if (startQuote !== undefined) {
			if (!Number.isFinite(startQuote) || startQuote <= 0) throw new Error("startQuote must be a positive number");
			const nextConfig = { ...this.config, paper: { ...this.config.paper, startQuote } };
			saveTradingConfig(nextConfig);
			this.config = nextConfig;
		}
		client.resetAccount(this.config.paper.startQuote);
		this.resetRiskUsage();
		return this.config.paper.startQuote;
	}

	/**
	 * Live mode: the notional counter resets automatically on date rollover.
	 * Paper mode: the quota is cumulative and only resets manually
	 * (resetRiskUsage / resetPaperAccount), so the counter is kept as-is.
	 */
	private refreshDailyCounter(): void {
		if (this.config.mode !== "live") return;
		const today = new Date().toISOString().slice(0, 10);
		if (this.state.date !== today) {
			this.state = { date: today, usedDailyNotional: 0 };
			saveTradingState(this.state);
		}
	}

	private async replaceClient(nextConfig: TradingConfig): Promise<void> {
		const nextClient = await this.createClient(nextConfig);
		const old = this.client;
		this.config = nextConfig;
		saveTradingConfig(this.config);
		this.client = nextClient;
		await old?.close().catch(() => {});
	}

	private async createClient(config = this.config): Promise<ExchangeClient> {
		const { exchange, mode, quoteCurrency, paper } = config;
		if (mode === "paper") {
			return new PaperExchangeClient(
				exchange,
				quoteCurrency,
				paper.startQuote,
				paper.feeRate,
				undefined,
				config.marketType,
				config.leverage,
				config.marginType,
			);
		}
		if (config.marketType === "both") throw new Error('marketType "both" is supported only in Paper mode');
		const keys = loadExchangeKeys()[exchange];
		if (!keys) {
			throw new Error(
				`Live mode requires API keys for "${exchange}".\n` +
					`Add them with /exchange-login or edit ~/.ti-trader/agent/keys.json, e.g.:\n` +
					`{ "${exchange}": { "apiKey": "...", "secret": "..." } }`,
			);
		}
		return new CcxtExchangeClient(exchange, quoteCurrency, keys, config.marketType);
	}
}

let runtime: TradingRuntime | undefined;

export async function initTrading(overrides: { mode?: TradingMode; exchange?: string } = {}): Promise<TradingRuntime> {
	runtime = await TradingRuntime.init(overrides);
	return runtime;
}

export function getTrading(): TradingRuntime {
	if (!runtime) throw new Error("Trading runtime not initialized");
	return runtime;
}
