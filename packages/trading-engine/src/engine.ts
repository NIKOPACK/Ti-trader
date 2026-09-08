import {
	type RiskClock,
	type RiskConfig,
	RiskLedger,
	type RiskReservation,
	type RiskStateStore,
} from "@nikopack/ti-trading-risk";
import type { FuturesPositionMode } from "./client-types.ts";
import {
	ExecutionJournal,
	type ExecutionJournalOptions,
	type ExecutionMaintenance,
	type ExecutionRecord,
	ExecutionRecoveryError,
	executionClientIds,
	isUnresolvedExecution,
} from "./execution-journal.ts";
import {
	executionEvidence,
	type ManualExecutionResolution,
	manuallyResolveExecution,
	type RecoveryOptions,
	recoverJournal,
} from "./execution-recovery.ts";
import {
	type OcoIntent,
	type OrderIntent,
	type OrderPlanningContext,
	type PreparedOco,
	type PreparedOrder,
	prepareOcoOrder,
	prepareOrder,
} from "./order-plan.ts";
import { preflightOco, preflightOrder } from "./order-preflight.ts";
import {
	createMarketDataView,
	type ExchangeClient,
	isSubmissionStatusUnknownError,
	type MarketDataClient,
	type Order,
	type OrderList,
	type OrderSide,
	type PlaceOcoOrderResult,
	type PlaceOrderResult,
	SubmissionRejectedError,
} from "./types.ts";

export class PreparedPlanError extends Error {
	readonly code = "PREPARED_PLAN_REJECTED" as const;

	constructor(message: string) {
		super(message);
		this.name = "PreparedPlanError";
	}
}

export interface TradingEngineSubmissionPolicy {
	confirm?(summary: string): Promise<boolean>;
	/** Explicitly opt into headless live submission without a confirmation callback. */
	allowUnconfirmedLive?: boolean;
	/** Return true when a failed submission may have reached the exchange. */
	submissionStatusUnknown?(error: unknown): boolean;
}

function combineFailures(message: string, first: unknown, second: unknown): Error {
	return new AggregateError([first, second], message);
}

export interface TradingEngineConfig extends RiskConfig {
	positionMode: FuturesPositionMode;
}

function toRiskConfig(config: TradingEngineConfig): RiskConfig {
	return {
		mode: config.mode,
		marketType: config.marketType,
		quoteCurrency: config.quoteCurrency,
		risk: config.risk,
	};
}

/** Framework-independent trading orchestration: planning, risk reservation, and submission. */
function copyConfig(config: TradingEngineConfig): TradingEngineConfig {
	return {
		...config,
		risk: { ...config.risk, allowedSymbols: [...config.risk.allowedSymbols] },
	};
}

export class TradingEngine {
	readonly risk: RiskLedger;
	private config: TradingEngineConfig;
	private readonly exchangeClient: ExchangeClient;
	private readonly marketDataClient: MarketDataClient;
	private readonly preparedOrders = new WeakMap<object, PreparedOrder>();
	private readonly preparedOcos = new WeakMap<object, PreparedOco>();
	/** A prepared plan is single-use once an exchange attempt starts. */
	private readonly consumedPlans = new WeakSet<object>();
	/** Prevent two concurrent callers from submitting the same plan. */
	private readonly inFlightPlans = new WeakSet<object>();
	private readonly journal: ExecutionJournal | undefined;
	private submissionsRetired = false;

	constructor(
		config: TradingEngineConfig,
		exchange: ExchangeClient,
		stateStore: RiskStateStore,
		clock?: RiskClock,
		execution?: ExecutionJournalOptions,
	) {
		if (config.mode !== exchange.mode) {
			throw new Error(`Trading engine mode ${config.mode} does not match exchange client mode ${exchange.mode}`);
		}
		if (config.quoteCurrency !== exchange.quoteCurrency) {
			throw new Error(
				`Trading engine quote currency ${config.quoteCurrency} does not match exchange client quote currency ${exchange.quoteCurrency}`,
			);
		}
		const acceptedConfig = copyConfig(config);
		this.config = acceptedConfig;
		this.exchangeClient = exchange;
		this.marketDataClient = createMarketDataView(exchange);
		this.risk = new RiskLedger(toRiskConfig(acceptedConfig), stateStore, clock);
		if (execution) {
			if (execution.durability !== "durable" && execution.durability !== "memory")
				throw new Error("Explicit execution durability is required");
			if (execution.durability === "durable" && execution.admissionGeneration === undefined)
				throw new Error("Durable execution requires admission generation captured before configuration loading");
			this.journal = new ExecutionJournal(
				stateStore,
				toRiskConfig(acceptedConfig),
				{
					accountId: execution.accountId,
					exchange: exchange.id,
					mode: config.mode,
					marketType: config.marketType,
					quoteCurrency: config.quoteCurrency,
					positionMode: config.positionMode,
				},
				clock,
				execution.admissionGeneration,
			);
		}
	}

	listExecutions() {
		return this.executionJournal().list();
	}
	getExecutionScope() {
		return structuredClone(this.executionJournal().scope);
	}
	listAuditEvents() {
		return this.executionJournal().listAuditEvents();
	}
	recoverExecutions(options?: RecoveryOptions) {
		return recoverJournal(this.executionJournal(), this.exchangeClient, options);
	}
	resolveExecution(resolution: ManualExecutionResolution): void {
		manuallyResolveExecution(this.executionJournal(), resolution);
	}
	recordConfigurationChange(action = "requested"): void {
		this.executionJournal().recordConfigurationChange(action);
	}
	beginMaintenance(action: ExecutionMaintenance["action"]) {
		return this.executionJournal().beginMaintenance(action);
	}
	completeMaintenance(id: string, evidenceReference?: string): void {
		this.executionJournal().completeMaintenance(id, evidenceReference);
	}
	cancelMaintenance(id: string): void {
		this.executionJournal().cancelMaintenance(id);
	}
	retireSubmissions(): void {
		this.submissionsRetired = true;
	}
	getExecutionStatus() {
		const records = this.listExecutions();
		const admission = this.executionJournal().getAdmissionStatus();
		const staleRuntime = admission.stale || this.submissionsRetired;
		return {
			configured: this.journal !== undefined,
			staleRuntime,
			unresolved: records.filter(isUnresolvedExecution),
			accountId: this.executionJournal().scope.accountId,
			maintenance: this.executionJournal().getMaintenance(),
			admission: { ...admission, stale: staleRuntime },
		};
	}
	private executionJournal(): ExecutionJournal {
		if (!this.journal)
			throw new Error(
				"Durable execution journal is not configured; explicitly supply an atomic store and execution account identity (memory only for tests)",
			);
		return this.journal;
	}

	get id(): string {
		return this.exchangeClient.id;
	}
	get mode(): "paper" | "live" {
		return this.exchangeClient.mode;
	}
	get quoteCurrency(): string {
		return this.exchangeClient.quoteCurrency;
	}
	getTicker(symbol: string) {
		return this.marketDataClient.getTicker(symbol);
	}
	getOrderBook(symbol: string, limit?: number) {
		return this.marketDataClient.getOrderBook(symbol, limit);
	}
	getMarketInfo(symbol: string) {
		return this.marketDataClient.getMarketInfo(symbol);
	}
	getContractStats(symbol: string) {
		return this.marketDataClient.getContractStats(symbol);
	}
	getKlines(symbol: string, timeframe: string, limit: number) {
		return this.marketDataClient.getKlines(symbol, timeframe, limit);
	}
	getBalances() {
		return this.marketDataClient.getBalances();
	}
	getPositions() {
		return this.marketDataClient.getPositions();
	}
	getOpenOrders(symbol?: string) {
		return this.marketDataClient.getOpenOrders(symbol);
	}
	getOrderHistory(symbol?: string, limit?: number) {
		return this.marketDataClient.getOrderHistory(symbol, limit);
	}
	getTopMarkets(limit: number) {
		return this.marketDataClient.getTopMarkets(limit);
	}
	getFundingRate(symbol: string) {
		return this.marketDataClient.getFundingRate(symbol);
	}
	getFundingRateHistory(symbol: string, limit?: number) {
		return this.marketDataClient.getFundingRateHistory(symbol, limit);
	}
	getEffectiveLeverage(symbol: string): number {
		return this.exchangeClient.getEffectiveLeverage?.(symbol) ?? 1;
	}
	async setLeverage(symbol: string, leverage: number) {
		this.recordConfigurationChange("leverage-requested");
		const result = await this.exchangeClient.setLeverage(symbol, leverage);
		this.recordConfigurationChange("leverage-applied");
		return result;
	}
	async setMarginMode(symbol: string, marginType: "isolated" | "cross") {
		this.recordConfigurationChange("margin-mode-requested");
		const result = await this.exchangeClient.setMarginMode(symbol, marginType);
		this.recordConfigurationChange("margin-mode-applied");
		return result;
	}
	async setMultiAssetsMode(enabled: boolean) {
		this.recordConfigurationChange("multi-assets-requested");
		const result = await this.exchangeClient.setMultiAssetsMode(enabled);
		this.recordConfigurationChange("multi-assets-applied");
		return result;
	}
	get planningContext(): OrderPlanningContext {
		return { config: copyConfig(this.config), mode: this.config.mode, exchange: this.marketDataClient };
	}
	setConfig(config: TradingEngineConfig): void {
		if (config.mode !== this.exchangeClient.mode) {
			throw new Error(
				`Trading engine mode cannot change from ${this.exchangeClient.mode} while the client is attached`,
			);
		}
		if (config.quoteCurrency !== this.exchangeClient.quoteCurrency) {
			throw new Error(
				`Trading engine quote currency cannot change from ${this.exchangeClient.quoteCurrency} while the client is attached`,
			);
		}
		if (config.marketType !== this.config.marketType) {
			throw new Error(`Trading engine market type cannot change while the client is attached`);
		}
		if (config.positionMode !== this.config.positionMode) {
			throw new Error(`Trading engine position mode cannot change while the client is attached`);
		}
		const acceptedConfig = copyConfig(config);
		this.config = acceptedConfig;
		this.risk.setConfig(toRiskConfig(acceptedConfig));
		this.journal?.setConfig(toRiskConfig(acceptedConfig));
	}

	prepareOrder(side: OrderSide, intent: OrderIntent): Promise<PreparedOrder> {
		return prepareOrder(side, intent, this.planningContext).then((plan) => {
			this.preparedOrders.set(plan, plan);
			return plan;
		});
	}
	prepareOcoOrder(intent: OcoIntent): Promise<PreparedOco> {
		return prepareOcoOrder(intent, this.planningContext).then((plan) => {
			this.preparedOcos.set(plan, plan);
			return plan;
		});
	}

	async placeOrder(
		plan: PreparedOrder,
		policy: TradingEngineSubmissionPolicy = {},
		signal?: AbortSignal,
	): Promise<PlaceOrderResult> {
		const prepared = this.preparedOrders.get(plan);
		if (!prepared) throw new PreparedPlanError("Order plan was not prepared by this trading engine");
		const input = { ...prepared.input, clientOrderId: executionClientIds().clientOrderId };
		return this.submitWithReservation(
			plan,
			"Order",
			prepared.notional,
			prepared.countTowardsDailyLimit,
			prepared.summary,
			{ kind: "order", input },
			() => this.exchangeClient.placeOrder(input),
			() =>
				preflightOrder(prepared, {
					getMarketInfo: (symbol) => this.marketDataClient.getMarketInfo(symbol),
					getBalances: () => this.marketDataClient.getBalances(),
					quoteCurrency: this.quoteCurrency,
					marketType: this.config.marketType,
					getEffectiveLeverage: (symbol) => this.getEffectiveLeverage(symbol),
				}),
			policy,
			signal,
		);
	}

	async placeOco(
		plan: PreparedOco,
		policy: TradingEngineSubmissionPolicy = {},
		signal?: AbortSignal,
	): Promise<PlaceOcoOrderResult> {
		const prepared = this.preparedOcos.get(plan);
		if (!prepared) throw new PreparedPlanError("OCO plan was not prepared by this trading engine");
		const { listClientOrderId, aboveClientOrderId, belowClientOrderId } = executionClientIds();
		const input = { ...prepared.input, listClientOrderId, aboveClientOrderId, belowClientOrderId };
		return this.submitWithReservation(
			plan,
			"OCO order",
			prepared.riskNotional,
			prepared.countTowardsDailyLimit,
			prepared.summary,
			{ kind: "oco", input },
			() => this.exchangeClient.placeOcoOrder(input),
			() =>
				preflightOco(prepared, {
					getMarketInfo: (symbol) => this.marketDataClient.getMarketInfo(symbol),
					getBalances: () => this.marketDataClient.getBalances(),
					quoteCurrency: this.quoteCurrency,
				}),
			policy,
			signal,
		);
	}

	private async submitWithReservation<T extends PlaceOrderResult | PlaceOcoOrderResult>(
		plan: object,
		label: string,
		notional: number,
		countTowardsDailyLimit: boolean,
		summary: string,
		intent: ExecutionRecord["intent"],
		submit: () => Promise<T>,
		preflight: () => Promise<unknown>,
		policy: TradingEngineSubmissionPolicy,
		signal?: AbortSignal,
	): Promise<T> {
		const throwIfAborted = (): void => {
			if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Operation cancelled");
		};
		throwIfAborted();
		const journal = this.executionJournal();
		if (this.consumedPlans.has(plan)) {
			throw new PreparedPlanError(`${label} plan has already been submitted; prepare a new plan before retrying`);
		}
		if (this.inFlightPlans.has(plan)) {
			throw new PreparedPlanError(`${label} plan is already being submitted`);
		}
		if (countTowardsDailyLimit) this.risk.assertNewExposureAllowed();
		this.inFlightPlans.add(plan);
		try {
			await preflight();
		} catch (error) {
			this.inFlightPlans.delete(plan);
			throw error;
		}

		let execution: ExecutionRecord;
		try {
			if (this.submissionsRetired) throw new Error("Trading engine was replaced; prepare with the active runtime");
			execution = journal.prepare(intent, notional, countTowardsDailyLimit);
		} catch (error) {
			this.inFlightPlans.delete(plan);
			throw error;
		}

		const releaseAndThrow = (original: unknown, message: string): never => {
			try {
				if (!journal.settle(execution.id, "release", 0, "definite-rejection", undefined, execution.revision))
					throw new ExecutionRecoveryError(execution.id, "stale pre-submission settlement");
			} catch (releaseError) {
				// A failed release leaves the durable claim unresolved. Block this plan
				// from being submitted again and expose both failures to the caller.
				this.consumedPlans.add(plan);
				this.inFlightPlans.delete(plan);
				throw combineFailures(message, original, releaseError);
			}
			this.inFlightPlans.delete(plan);
			throw original;
		};

		if (policy.confirm) {
			let confirmed: boolean;
			try {
				confirmed = await policy.confirm(summary);
			} catch (error) {
				return releaseAndThrow(error, `${label} confirmation failed and risk reservation release failed`);
			}
			if (!confirmed) {
				return releaseAndThrow(
					new Error("Order cancelled by user"),
					`${label} cancellation and risk release failed`,
				);
			}
		} else if (this.mode === "live" && policy.allowUnconfirmedLive !== true) {
			return releaseAndThrow(
				new Error(
					"Live order submission requires an explicit confirmation callback; set allowUnconfirmedLive only for an intentional headless workflow",
				),
				`${label} confirmation policy rejected and risk reservation release failed`,
			);
		}
		try {
			throwIfAborted();
			// A user or another process may pause entries while confirmation is open.
			if (countTowardsDailyLimit) this.risk.assertNewExposureAllowed(execution.id);
			journal.begin(execution.id);
		} catch (error) {
			return releaseAndThrow(error, `${label} pre-submission check and risk release failed`);
		}

		// From this point onward an exchange call may happen. Consume the plan
		// before awaiting it so concurrent callers and retries cannot double-submit.
		this.inFlightPlans.delete(plan);
		this.consumedPlans.add(plan);
		let result: T;
		try {
			result = await submit();
		} catch (submissionError) {
			let statusUnknown =
				!(submissionError instanceof SubmissionRejectedError) || isSubmissionStatusUnknownError(submissionError);
			if (policy.submissionStatusUnknown) {
				try {
					statusUnknown ||= policy.submissionStatusUnknown(submissionError);
				} catch {
					// A broken classifier is itself ambiguous: conservatively account for
					// the attempted submission and retain the original error as context.
					statusUnknown = true;
				}
			}
			if (statusUnknown) {
				try {
					journal.unknown(execution.id, "submission-unknown");
				} catch {
					throw new ExecutionRecoveryError(execution.id, "outcome persistence failed");
				}
				throw new ExecutionRecoveryError(execution.id, "submission status unknown");
			}
			try {
				journal.settle(execution.id, "release", 0, "definite-rejection");
			} catch {
				throw new ExecutionRecoveryError(execution.id, "rejection persistence failed");
			}
			throw submissionError;
		}

		try {
			const observation = executionEvidence(execution, result, "submission");
			journal.settle(execution.id, observation.outcome, observation.notional, "acknowledged", observation.evidence);
		} catch {
			throw new ExecutionRecoveryError(execution.id, "response validation or settlement persistence failed");
		}
		return { ...result, executionId: execution.id };
	}

	async cancelOrder(id: string, symbol: string, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Operation cancelled");
		await this.exchangeClient.cancelOrder(id, symbol);
	}

	async cancelOrderList(orderListId: string, symbol: string, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Operation cancelled");
		await this.exchangeClient.cancelOrderList(orderListId, symbol);
	}

	getOrder(id: string, symbol: string): Promise<Order> {
		return this.marketDataClient.getOrder(id, symbol);
	}

	getOrderByClientId(origClientOrderId: string, symbol: string): Promise<Order> {
		return this.marketDataClient.getOrderByClientId(origClientOrderId, symbol);
	}

	getOrderList(orderListId: string): Promise<OrderList> {
		return this.marketDataClient.getOrderList(orderListId);
	}

	getOrderListByClientId(listClientOrderId: string): Promise<OrderList> {
		return this.marketDataClient.getOrderListByClientId(listClientOrderId);
	}

	close(): Promise<void> {
		return this.exchangeClient.close();
	}
}

export type { RiskReservation };
