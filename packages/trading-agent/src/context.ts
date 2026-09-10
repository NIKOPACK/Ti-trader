import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
	CcxtExchangeClient,
	createMarketDataView,
	type ExchangeClient,
	type ExecutionMaintenance,
	type ManualExecutionResolution,
	type MarketDataClient,
	PaperExchangeClient,
	type RecoveryOptions,
	type RecoveryReport,
	type RiskStateStore,
	TradingEngine,
	type TradingEngineConfig,
	validateLiveVenueCredentials,
} from "@nikopack/ti-trading-engine";
import { PAPER_DIR } from "./config.ts";
import type { MonitoringScope } from "./monitoring-state.ts";
import {
	requiresAccountSwitchConfirmation,
	requiresClientReplace,
	requiresPaperFeeRateChange,
} from "./runtime-config.ts";
import {
	defaultOrderApproval,
	type FuturesMarginType,
	type FuturesPositionMode,
	loadExchangeKeys,
	loadTradingConfig,
	loadTradingState,
	type MarketType,
	normalizeTradingConfig,
	type OrderApprovalMode,
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
	orderApproval?: OrderApprovalMode;
	/** Required when switching accounts that still contain orders or positions. */
	confirmAccountSwitch?: boolean;
	/** Required when the next state is live and unattended. */
	confirmUnattendedTrading?: boolean;
	risk?: Partial<RiskLimits>;
	paper?: Partial<TradingConfig["paper"]>;
	monitor?: Partial<TradingConfig["monitor"]>;
}

export interface AccountSwitchOptions {
	confirmAccountSwitch?: boolean;
}

export interface PaperResetOptions {
	/** Explicitly acknowledge wiping simulated orders, positions, and history. */
	confirmExposure?: boolean;
}

export class AccountSwitchConfirmationRequired extends Error {
	readonly code = "ACCOUNT_SWITCH_CONFIRMATION_REQUIRED" as const;

	constructor(message: string) {
		super(message);
		this.name = "AccountSwitchConfirmationRequired";
	}
}

export class UnattendedTradingConfirmationRequired extends Error {
	readonly code = "UNATTENDED_TRADING_CONFIRMATION_REQUIRED" as const;

	constructor(message: string) {
		super(message);
		this.name = "UnattendedTradingConfirmationRequired";
	}
}

type DeepReadonly<Value> = Value extends (...args: never[]) => unknown
	? Value
	: Value extends readonly (infer Item)[]
		? readonly DeepReadonly<Item>[]
		: Value extends object
			? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
			: Value;

export type ReadonlyTradingConfig = DeepReadonly<TradingConfig>;

interface AccountExposureInspector {
	hasAnyAccountExposure(): Promise<boolean>;
}

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
	private closePromise: Promise<void> | undefined;
	private lifecycle: "active" | "closing" | "closed" = "active";
	private configOperationTail: Promise<void> = Promise.resolve();
	private recoveryReport: RecoveryReport | undefined;
	private readonly accountIds = new WeakMap<ExchangeClient, string>();
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

	static async init(
		overrides: { mode?: TradingMode; exchange?: string } = {},
		installation?: ExecutionMaintenance,
	): Promise<TradingRuntime> {
		if (installation && !runtimeInstallations.delete(installation))
			throw new Error("Runtime installation is reserved for the maintenance owner");
		// Capture before configuration/client construction, never bless an old config with a newer generation.
		const initialState = loadTradingState();
		const generation = initialState.executions?.admissionGeneration ?? 0;
		if (
			installation &&
			(initialState.executions?.maintenance?.id !== installation.id ||
				installation.nextGeneration !== generation + 1)
		)
			throw new Error("Runtime installation maintenance changed");
		const config = loadTradingConfig(overrides.mode);
		if (overrides.exchange) config.exchange = overrides.exchange;
		const normalized = normalizeTradingConfig(config);
		validateTradingConfig(normalized);
		const runtime = new TradingRuntime(normalized);
		const client = await runtime.createClient();
		try {
			const marketDataView = createMarketDataView(client);
			const engine = runtime.createEngine(normalized, client, installation?.nextGeneration ?? generation);
			runtime.recoveryReport = await engine.recoverExecutions();
			const currentState = loadTradingState();
			if (
				(currentState.executions?.admissionGeneration ?? 0) !== generation ||
				(installation && currentState.executions?.maintenance?.id !== installation.id)
			)
				throw new Error("Trading admission generation changed during initialization; reinitialize");
			runtime.client = client;
			runtime.marketDataView = marketDataView;
			runtime.engine = engine;
		} catch (error) {
			try {
				await client.close();
			} catch (closeError) {
				throw new AggregateError([error, closeError], "Failed to initialize trading runtime");
			}
			throw error;
		}
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

	getExecutionStatus() {
		return { ...this.tradingEngine.getExecutionStatus(), recovery: this.recoveryReport };
	}
	getExecutionScope() {
		return this.tradingEngine.getExecutionScope();
	}
	getMonitoringScope(): MonitoringScope {
		const { accountId, mode, exchange, marketType, quoteCurrency } = this.getExecutionScope();
		return { accountId, mode, exchange, marketType, quoteCurrency };
	}
	listAuditEvents() {
		return this.tradingEngine.listAuditEvents();
	}
	async recoverExecutions(options?: RecoveryOptions): Promise<RecoveryReport> {
		return this.enqueueConfigOperation(async () => {
			this.assertActive();
			this.recoveryReport = await this.tradingEngine.recoverExecutions(options);
			return this.recoveryReport;
		});
	}
	resolveExecution(resolution: ManualExecutionResolution): void {
		this.assertActive();
		this.tradingEngine.resolveExecution(resolution);
	}
	resolveMaintenance(id: string, evidenceReference: string): void {
		this.assertActive();
		if (!/^[A-Za-z0-9_-]{1,80}$/.test(evidenceReference))
			throw new Error("A safe verified evidence reference is required");
		this.tradingEngine.completeMaintenance(id, evidenceReference);
	}

	async setLanguage(language: TradingLanguage): Promise<void> {
		await this.patchConfig({ language });
	}

	async setMode(mode: TradingMode, options: AccountSwitchOptions = {}): Promise<void> {
		await this.patchConfig({ mode, confirmAccountSwitch: options.confirmAccountSwitch });
	}

	async setExchange(id: string, options: AccountSwitchOptions = {}): Promise<void> {
		const normalized = id.trim().toLowerCase();
		if (!normalized) throw new Error("Exchange id must not be empty");
		await this.patchConfig({ exchange: normalized, confirmAccountSwitch: options.confirmAccountSwitch });
	}

	async setMarketType(marketType: MarketType, options: AccountSwitchOptions = {}): Promise<void> {
		if (!("spot" === marketType || "usdm-futures" === marketType || "both" === marketType))
			throw new Error(`Invalid market type: ${marketType}`);
		await this.patchConfig({ marketType, confirmAccountSwitch: options.confirmAccountSwitch });
	}

	async setOrderApproval(
		orderApproval: OrderApprovalMode,
		options: { confirmUnattendedTrading?: boolean } = {},
	): Promise<void> {
		await this.patchConfig({
			orderApproval,
			confirmUnattendedTrading: options.confirmUnattendedTrading,
		});
	}

	async patchConfig(patch: TradingConfigPatch): Promise<void> {
		await this.enqueueConfigOperation(() => this.applyConfigPatch(patch));
	}

	private async applyConfigPatch(patch: TradingConfigPatch): Promise<void> {
		this.assertActive();
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
				orderApproval: patch.orderApproval,
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
		if (patch.mode !== undefined && patch.orderApproval === undefined && patch.mode !== current.mode) {
			next.orderApproval = defaultOrderApproval(patch.mode);
		}
		if (configSnapshot(this.config) === configSnapshot(next)) return;
		validateTradingConfig(next);
		const alreadyLiveUnattended = current.mode === "live" && current.orderApproval === "unattended";
		if (
			next.mode === "live" &&
			next.orderApproval === "unattended" &&
			!alreadyLiveUnattended &&
			patch.confirmUnattendedTrading !== true
		) {
			throw new UnattendedTradingConfirmationRequired(
				"Switching order approval to unattended submits live orders without a per-order confirmation. Retry after an explicit operator confirmation.",
			);
		}
		this.tradingEngine.recordConfigurationChange();
		await this.installConfiguration(next, patch.confirmAccountSwitch);
	}

	async close(): Promise<void> {
		if (!this.closePromise) {
			this.closePromise = this.enqueueConfigOperation(async () => {
				if (this.lifecycle === "closed") return;
				this.lifecycle = "closing";
				try {
					await this.engine?.close();
					this.lifecycle = "closed";
				} catch (error) {
					this.lifecycle = "active";
					this.closePromise = undefined;
					throw error;
				}
			});
		}
		await this.closePromise;
	}

	/**
	 * Reset the simulated account, optionally changing (and persisting) the
	 * starting quote balance. Paper mode only.
	 */
	async resetPaperAccount(startQuote?: number, options: PaperResetOptions = {}): Promise<number> {
		return this.enqueueConfigOperation(() => this.applyPaperAccountReset(startQuote, options));
	}

	private async applyPaperAccountReset(startQuote: number | undefined, options: PaperResetOptions): Promise<number> {
		this.assertActive();
		if (this.config.mode !== "paper") throw new Error("Paper account reset is only available in paper mode");
		const client = this.client;
		if (!client) throw new Error("Trading runtime not initialized");
		if (!(client instanceof PaperExchangeClient)) throw new Error("Active exchange client is not a paper client");
		const risk = this.tradingEngine.risk;
		if (this.tradingEngine.getExecutionStatus().unresolved.length > 0)
			throw new Error("Cannot reset the paper account with unresolved executions; inspect /recovery");
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
		const previousEngine = this.tradingEngine;
		const maintenance = previousEngine.beginMaintenance("paper-reset");
		try {
			if (!options.confirmExposure && (await client.hasAnyAccountExposure())) {
				throw new Error(
					"Paper account reset would delete existing orders, positions, or balances; confirm the reset explicitly before retrying",
				);
			}
		} catch (error) {
			try {
				previousEngine.cancelMaintenance(maintenance.id);
			} catch (cancelError) {
				throw new AggregateError([error, cancelError], "Paper reset inspection and fence cancellation failed");
			}
			throw error;
		}
		await client.resetAccount(targetStartQuote);
		// The account reset is complete before quota reset. If persistence of the
		// quota fails, the error remains visible and the old quota conservatively
		// blocks further counted orders instead of silently granting capacity.
		risk.reset();
		if (nextConfig) {
			saveTradingConfig(nextConfig);
			this.currentConfig = freezeConfig(nextConfig);
		}
		const nextEngine = this.createEngine(this.config, client, maintenance.nextGeneration);
		this.recoveryReport = await nextEngine.recoverExecutions();
		this.engine = nextEngine;
		previousEngine.retireSubmissions();
		try {
			nextEngine.completeMaintenance(maintenance.id);
		} catch (error) {
			nextEngine.retireSubmissions();
			throw error;
		}
		return targetStartQuote;
	}

	private async confirmAccountSwitch(confirmed = false): Promise<void> {
		if (this.tradingEngine.getExecutionStatus().unresolved.length > 0)
			throw new Error(
				"Cannot switch accounts with unresolved executions; restore their original scope and inspect /recovery",
			);
		const pendingReservations = this.tradingEngine.risk.listPendingReservations();
		if (pendingReservations.length > 0) {
			throw new Error(
				`Cannot switch accounts while ${pendingReservations.length} risk reservation(s) are unsettled. ` +
					"Verify each exchange order and reconcile it with /risk reconcile <id> commit|release before switching.",
			);
		}
		if (confirmed || !this.client) return;
		const inspectAllAccounts = (this.client as Partial<AccountExposureInspector>).hasAnyAccountExposure;
		if (typeof inspectAllAccounts === "function") {
			if (await inspectAllAccounts.call(this.client)) {
				throw new AccountSwitchConfirmationRequired(
					"Account switch would hide existing orders or positions, or the account could not be fully verified. " +
						"Verify/cancel/close them first, or retry with confirmAccountSwitch: true. Existing account data is not deleted.",
				);
			}
			return;
		}
		const [openOrders, positions] = await Promise.all([this.client.getOpenOrders(), this.client.getPositions()]);
		if (openOrders.length === 0 && positions.length === 0) return;
		throw new AccountSwitchConfirmationRequired(
			"Account switch would hide existing orders or positions. Cancel/close them first, or retry with confirmAccountSwitch: true. " +
				"The previous account is not deleted and can be accessed again by restoring the old configuration.",
		);
	}

	private enqueueConfigOperation<T>(operation: () => Promise<T>): Promise<T> {
		const run = this.configOperationTail.then(operation, operation);
		this.configOperationTail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private async confirmPaperFeeRateChange(): Promise<void> {
		const [openOrders, positions, pendingReservations] = await Promise.all([
			this.client?.getOpenOrders() ?? Promise.resolve([]),
			this.client?.getPositions() ?? Promise.resolve([]),
			Promise.resolve(this.tradingEngine.risk.listPendingReservations()),
		]);
		if (openOrders.length > 0 || positions.length > 0 || pendingReservations.length > 0) {
			throw new Error(
				"Cannot change the paper fee rate while open orders, positions, or unsettled risk reservations exist; close/cancel/settle them first",
			);
		}
	}

	private async installConfiguration(nextConfig: TradingConfig, confirmAccountSwitch?: boolean): Promise<void> {
		validateTradingConfig(nextConfig);
		if (this.tradingEngine.getExecutionStatus().unresolved.length > 0)
			throw new Error("Cannot replace the trading engine with unresolved executions; inspect /recovery");
		const previousEngine = this.tradingEngine;
		const maintenance = previousEngine.beginMaintenance("runtime-replacement");
		try {
			if (requiresPaperFeeRateChange(this.config, nextConfig)) await this.confirmPaperFeeRateChange();
			if (requiresAccountSwitchConfirmation(this.config, nextConfig))
				await this.confirmAccountSwitch(confirmAccountSwitch);
		} catch (error) {
			try {
				previousEngine.cancelMaintenance(maintenance.id);
			} catch (cancelError) {
				throw new AggregateError([error, cancelError], "Configuration inspection and fence cancellation failed");
			}
			throw error;
		}
		const oldClient = this.client;
		const replaceClient = requiresClientReplace(this.config, nextConfig);
		const nextClient = replaceClient ? await this.createClient(nextConfig) : oldClient;
		if (!nextClient) throw new Error("Trading runtime not initialized");
		let nextEngine: TradingEngine;
		let nextMarketDataView: MarketDataClient;
		try {
			nextEngine = this.createEngine(nextConfig, nextClient, maintenance.nextGeneration);
			this.recoveryReport = await nextEngine.recoverExecutions();
			nextMarketDataView = createMarketDataView(nextClient);
		} catch (error) {
			try {
				if (replaceClient) await nextClient.close();
			} catch (closeError) {
				throw new AggregateError([error, closeError], "Failed to initialize replacement trading runtime");
			}
			throw error;
		}

		try {
			saveTradingConfig(nextConfig);
		} catch (error) {
			try {
				if (replaceClient) await nextEngine.close();
			} catch (closeError) {
				throw new AggregateError([error, closeError], "Failed to persist replacement trading configuration");
			}
			throw error;
		}

		this.currentConfig = freezeConfig(nextConfig);
		this.engine = nextEngine;
		this.client = nextClient;
		this.marketDataView = nextMarketDataView;
		previousEngine.retireSubmissions();
		// The new runtime is fully installed (config saved, engine and client
		// swapped) before the old client retires. A close failure must surface
		// to the caller unchanged instead of being swallowed: the switch already
		// happened, so the cleanup error is the only remaining observable signal.
		if (replaceClient) await oldClient?.close();
		try {
			nextEngine.completeMaintenance(maintenance.id);
		} catch (error) {
			nextEngine.retireSubmissions();
			throw error;
		}
	}

	private createEngine(
		config: ReadonlyTradingConfig,
		client: ExchangeClient,
		admissionGeneration: number,
	): TradingEngine {
		const accountId = this.accountIds.get(client);
		if (!accountId) throw new Error("Exchange client account identity unavailable");
		return new TradingEngine(toEngineConfig(config), client, this.stateStore, undefined, {
			accountId,
			durability: "durable",
			admissionGeneration,
		});
	}

	private async createClient(config = this.config): Promise<ExchangeClient> {
		const { exchange, mode, quoteCurrency, paper } = config;
		if (mode === "paper") {
			const client = new PaperExchangeClient(
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
			this.accountIds.set(
				client,
				createHash("sha256")
					.update(`paper:${resolve(PAPER_DIR, `${exchange}-${quoteCurrency}.json`)}`)
					.digest("hex"),
			);
			return client;
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
		validateLiveVenueCredentials(exchange, keys);
		const client = new CcxtExchangeClient(
			exchange,
			quoteCurrency,
			keys,
			config.marketType,
			config.leverage,
			config.marginType,
			config.positionMode,
		);
		// Bind identity to the SAME credential snapshot used by the client; a second read could race key rotation.
		this.accountIds.set(client, createHash("sha256").update(`${exchange}:${keys.apiKey}`).digest("hex"));
		return client;
	}

	private assertActive(): void {
		if (this.lifecycle !== undefined && this.lifecycle !== "active") {
			throw new Error(`Trading runtime is ${this.lifecycle}`);
		}
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
		orderApproval: config.orderApproval,
		risk: { ...config.risk, allowedSymbols: [...config.risk.allowedSymbols] },
		paper: { ...config.paper },
		monitor: { ...config.monitor },
	});
}

let runtime: TradingRuntime | undefined;
const runtimeInstallations = new WeakSet<ExecutionMaintenance>();
let initializationTail: Promise<void> = Promise.resolve();

export async function initTrading(overrides: { mode?: TradingMode; exchange?: string } = {}): Promise<TradingRuntime> {
	const initialize = async (): Promise<TradingRuntime> => {
		const previous = runtime;
		const maintenance = previous?.tradingEngine.beginMaintenance("runtime-replacement");
		if (maintenance) runtimeInstallations.add(maintenance);
		const next = await TradingRuntime.init(overrides, maintenance);
		if (previous) {
			previous.tradingEngine.retireSubmissions();
			try {
				await previous.close();
			} catch (error) {
				try {
					await next.close();
				} catch (closeError) {
					throw new AggregateError([error, closeError], "Failed to replace the process trading runtime");
				}
				throw error;
			}
		}
		runtime = next;
		if (maintenance) {
			try {
				next.tradingEngine.completeMaintenance(maintenance.id);
			} catch (error) {
				next.tradingEngine.retireSubmissions();
				throw error;
			}
		}
		return next;
	};
	const result = initializationTail.then(initialize, initialize);
	initializationTail = result.then(
		() => undefined,
		() => undefined,
	);
	return result;
}

export function getTrading(): TradingRuntime {
	if (!runtime) throw new Error("Trading runtime not initialized");
	return runtime;
}
