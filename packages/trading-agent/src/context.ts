import {
	CcxtExchangeClient,
	createMarketDataView,
	type ExchangeClient,
	type MarketDataClient,
	PaperExchangeClient,
	type RiskStateStore,
	TradingEngine,
	type TradingEngineConfig,
} from "@earendil-works/ti-trading-engine";
import { PAPER_DIR } from "./config.ts";
import {
	type FuturesMarginType,
	type FuturesPositionMode,
	loadExchangeKeys,
	loadTradingConfig,
	loadTradingState,
	type MarketType,
	type RiskLimits,
	saveTradingConfig,
	saveTradingState,
	type TradingConfig,
	type TradingLanguage,
	type TradingMode,
	transactTradingState,
	validateTradingConfig,
} from "./state.ts";

export interface TradingConfigPatch {
	language?: TradingLanguage;
	mode?: TradingMode;
	marketType?: MarketType;
	leverage?: number;
	marginType?: FuturesMarginType;
	positionMode?: FuturesPositionMode;
	exchange?: string;
	quoteCurrency?: string;
	confirmLiveOrders?: boolean;
	risk?: Partial<RiskLimits>;
	paper?: Partial<TradingConfig["paper"]>;
	monitor?: Partial<TradingConfig["monitor"]>;
}

type DeepReadonly<Value> = Value extends (...args: never[]) => unknown
	? Value
	: Value extends readonly (infer Item)[]
		? readonly DeepReadonly<Item>[]
		: Value extends object
			? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
			: Value;

export type ReadonlyTradingConfig = DeepReadonly<TradingConfig>;

/**
 * Process-wide trading runtime: the active exchange client, trading config and
 * daily risk counters. Initialized once in main() before the agent session
 * starts; tools and commands access it via getTrading().
 */
export class TradingRuntime {
	private currentConfig: ReadonlyTradingConfig;
	private client: ExchangeClient | undefined;
	private marketDataView: MarketDataClient | undefined;
	private engine: TradingEngine | undefined;
	private readonly stateStore: RiskStateStore = {
		load: () => loadTradingState(),
		save: (state) => saveTradingState(state),
		transact: (mutator) => transactTradingState(mutator),
	};

	private constructor(config: TradingConfig) {
		this.currentConfig = freezeConfig(config);
	}

	get config(): ReadonlyTradingConfig {
		return this.currentConfig;
	}

	static async init(overrides: { mode?: TradingMode; exchange?: string } = {}): Promise<TradingRuntime> {
		const config = loadTradingConfig();
		if (overrides.mode) config.mode = overrides.mode;
		if (overrides.exchange) config.exchange = overrides.exchange;
		validateTradingConfig(config);
		const runtime = new TradingRuntime(config);
		runtime.client = await runtime.createClient();
		runtime.marketDataView = createMarketDataView(runtime.client);
		runtime.engine = new TradingEngine(toEngineConfig(config), runtime.client, runtime.stateStore);
		return runtime;
	}

	/** Explicit read-only market-data boundary; trading operations go through tradingEngine. */
	get marketData(): MarketDataClient {
		if (!this.marketDataView) throw new Error("Trading runtime not initialized");
		return this.marketDataView;
	}

	get mode(): TradingMode {
		return this.config.mode;
	}

	get tradingEngine(): TradingEngine {
		if (!this.engine) throw new Error("Trading runtime not initialized");
		return this.engine;
	}

	setLanguage(language: TradingLanguage): void {
		if (language !== "zh-CN" && language !== "en-US") throw new Error(`Invalid language: ${language}`);
		const nextConfig: TradingConfig = {
			...this.config,
			language,
			risk: { ...this.config.risk, allowedSymbols: [...this.config.risk.allowedSymbols] },
		};
		validateTradingConfig(nextConfig);
		saveTradingConfig(nextConfig);
		this.currentConfig = freezeConfig(nextConfig);
	}

	async setMode(mode: TradingMode): Promise<void> {
		await this.patchConfig({ mode });
	}

	async setExchange(id: string): Promise<void> {
		const normalized = id.trim().toLowerCase();
		if (!normalized) throw new Error("Exchange id must not be empty");
		await this.patchConfig({ exchange: normalized });
	}

	async setMarketType(marketType: MarketType): Promise<void> {
		if (!("spot" === marketType || "usdm-futures" === marketType || "both" === marketType))
			throw new Error(`Invalid market type: ${marketType}`);
		await this.patchConfig({ marketType });
	}

	async patchConfig(patch: TradingConfigPatch): Promise<void> {
		const current = toMutableConfig(this.config);
		const next: TradingConfig = {
			...current,
			...omitUndefined({
				language: patch.language,
				mode: patch.mode,
				marketType: patch.marketType,
				leverage: patch.leverage,
				marginType: patch.marginType,
				positionMode: patch.positionMode,
				exchange: patch.exchange,
				quoteCurrency: patch.quoteCurrency,
				confirmLiveOrders: patch.confirmLiveOrders,
			}),
			risk: {
				...current.risk,
				...patch.risk,
				allowedSymbols: patch.risk?.allowedSymbols
					? [...patch.risk.allowedSymbols]
					: [...current.risk.allowedSymbols],
			},
			paper: { ...current.paper, ...patch.paper },
			monitor: { ...current.monitor, ...patch.monitor },
		};
		if (configSnapshot(this.config) === configSnapshot(next)) return;
		validateTradingConfig(next);
		if (requiresClientReplace(this.config, next)) {
			await this.replaceClient(next);
			return;
		}
		saveTradingConfig(next);
		this.currentConfig = freezeConfig(next);
	}

	async close(): Promise<void> {
		await this.engine?.close();
	}

	/**
	 * Reset the simulated account, optionally changing (and persisting) the
	 * starting quote balance. Paper mode only.
	 */
	async resetPaperAccount(startQuote?: number): Promise<number> {
		if (this.config.mode !== "paper") throw new Error("Paper account reset is only available in paper mode");
		const client = this.client;
		if (!client) throw new Error("Trading runtime not initialized");
		if (!(client instanceof PaperExchangeClient)) throw new Error("Active exchange client is not a paper client");
		const risk = this.tradingEngine.risk;
		// Check before mutating the paper ledger. A pending submission owns a
		// durable claim; wiping the account first would strand that claim and make
		// the next process observe an account/risk mismatch.
		if (risk.usage().reserved > 0) {
			throw new Error(
				"Cannot reset the paper account while orders are being submitted; settle or cancel them first",
			);
		}
		const targetStartQuote = startQuote ?? this.config.paper.startQuote;
		if (!Number.isFinite(targetStartQuote) || targetStartQuote <= 0) {
			throw new Error("startQuote must be a positive number");
		}
		const nextConfig: TradingConfig | undefined =
			startQuote === undefined
				? undefined
				: {
						...this.config,
						risk: { ...this.config.risk, allowedSymbols: [...this.config.risk.allowedSymbols] },
						paper: { ...this.config.paper, startQuote: targetStartQuote },
					};
		if (nextConfig) validateTradingConfig(nextConfig);
		await client.resetAccount(targetStartQuote);
		// The account reset is complete before quota reset. If persistence of the
		// quota fails, the error remains visible and the old quota conservatively
		// blocks further counted orders instead of silently granting capacity.
		risk.reset();
		if (nextConfig) {
			saveTradingConfig(nextConfig);
			this.currentConfig = freezeConfig(nextConfig);
		}
		return targetStartQuote;
	}

	private async replaceClient(nextConfig: TradingConfig): Promise<void> {
		validateTradingConfig(nextConfig);
		const nextClient = await this.createClient(nextConfig);
		const old = this.client;
		try {
			saveTradingConfig(nextConfig);
		} catch (error) {
			await nextClient.close();
			throw error;
		}
		this.currentConfig = freezeConfig(nextConfig);
		this.engine = new TradingEngine(toEngineConfig(nextConfig), nextClient, this.stateStore);
		this.client = nextClient;
		this.marketDataView = createMarketDataView(nextClient);
		// The new runtime is fully installed (config saved, engine and client
		// swapped) before the old client retires. A close failure must surface
		// to the caller unchanged instead of being swallowed: the switch already
		// happened, so the cleanup error is the only remaining observable signal.
		await old?.close();
	}

	private async createClient(config = this.config): Promise<ExchangeClient> {
		const { exchange, mode, quoteCurrency, paper } = config;
		if (mode === "paper") {
			return new PaperExchangeClient(
				exchange,
				quoteCurrency,
				paper.startQuote,
				paper.feeRate,
				PAPER_DIR,
				config.marketType,
				config.leverage,
				config.marginType,
				config.positionMode,
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
		return new CcxtExchangeClient(
			exchange,
			quoteCurrency,
			keys,
			config.marketType,
			config.leverage,
			config.marginType,
			config.positionMode,
		);
	}
}

function freezeConfig(config: TradingConfig): ReadonlyTradingConfig {
	const risk = Object.freeze({ ...config.risk, allowedSymbols: Object.freeze([...config.risk.allowedSymbols]) });
	const paper = Object.freeze({ ...config.paper });
	const monitor = Object.freeze({ ...config.monitor });
	return Object.freeze({ ...config, risk, paper, monitor }) as ReadonlyTradingConfig;
}

function toMutableConfig(config: ReadonlyTradingConfig): TradingConfig {
	return {
		...config,
		risk: { ...config.risk, allowedSymbols: [...config.risk.allowedSymbols] },
		paper: { ...config.paper },
		monitor: { ...config.monitor },
	};
}

function toEngineConfig(config: ReadonlyTradingConfig): TradingEngineConfig {
	return {
		mode: config.mode,
		marketType: config.marketType,
		positionMode: config.positionMode,
		quoteCurrency: config.quoteCurrency,
		risk: { ...config.risk, allowedSymbols: [...config.risk.allowedSymbols] },
	};
}

function omitUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
	const result: Partial<T> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (entry !== undefined) result[key as keyof T] = entry as T[keyof T];
	}
	return result;
}

function configSnapshot(config: ReadonlyTradingConfig | TradingConfig): string {
	return JSON.stringify({
		language: config.language,
		mode: config.mode,
		marketType: config.marketType,
		leverage: config.leverage,
		marginType: config.marginType,
		positionMode: config.positionMode,
		exchange: config.exchange,
		quoteCurrency: config.quoteCurrency,
		confirmLiveOrders: config.confirmLiveOrders,
		risk: { ...config.risk, allowedSymbols: [...config.risk.allowedSymbols] },
		paper: { ...config.paper },
		monitor: { ...config.monitor },
	});
}

function requiresClientReplace(prev: ReadonlyTradingConfig, next: TradingConfig): boolean {
	return (
		prev.mode !== next.mode ||
		prev.exchange !== next.exchange ||
		prev.marketType !== next.marketType ||
		prev.quoteCurrency !== next.quoteCurrency ||
		prev.leverage !== next.leverage ||
		prev.marginType !== next.marginType ||
		prev.positionMode !== next.positionMode
	);
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
