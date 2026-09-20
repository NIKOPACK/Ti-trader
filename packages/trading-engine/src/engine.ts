import {
	assessLeverageSetting,
	type RiskClock,
	type RiskConfig,
	RiskLedger,
	type RiskReservation,
	type RiskStateStore,
} from "@nikopack/ti-trading-risk";
import { AccountRiskGuard, isProtectiveExit } from "./account-risk.ts";
import { getTradingCapabilities, supportsCorrelatedLookup } from "./capabilities.ts";
import type { FuturesPositionMode } from "./client-types.ts";
import {
	ExecutionJournal,
	type ExecutionJournalOptions,
	type ExecutionMaintenance,
	type ExecutionRecord,
	ExecutionRecoveryError,
	type ExecutionReference,
	executionClientIds,
	isUnresolvedExecution,
} from "./execution-journal.ts";
import {
	boundedLookup,
	executionEvidence,
	type ManualExecutionResolution,
	manuallyResolveExecution,
	type RecoveryOptions,
	recoverJournal,
} from "./execution-recovery.ts";
import {
	formatPreparedOcoSummary,
	formatPreparedOrderSummary,
	type OcoIntent,
	type OrderIntent,
	type OrderPlanningContext,
	type PreparedOco,
	type PreparedOrder,
	prepareOcoOrder,
	prepareOrder,
} from "./order-plan.ts";
import {
	confirmationSnapshotChanged,
	marketEvidenceChanged,
	type OrderConfirmationEvidence,
	type OrderPreflightResult,
	preflightOco,
	preflightOrder,
} from "./order-preflight.ts";
import {
	type Balance,
	createMarketDataView,
	type ExchangeClient,
	isSubmissionStatusUnknownError,
	type MarketDataClient,
	type Order,
	type OrderList,
	type OrderSide,
	type PlaceOcoOrderResult,
	type PlaceOrderInput,
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

/** Maximum age of a prepared plan from prepare() through the last asynchronous revalidation. */
export const PREPARED_PLAN_TTL_MS = 60_000;
/** Bound on confirmation prompts so a moving market cannot I/O-storm inside the TTL window. */
export const PREPARED_PLAN_MAX_CONFIRMATIONS = 4;

export interface PreparedPlanConfirmation {
	summary: string;
	referencePrice: number;
	amount: number;
	notional: number;
	riskNotional: number;
	warnings: string[];
	requote: boolean;
}

export interface TradingEngineSubmissionPolicy {
	/** Stable logical action identity, preserved across model turn retries and restarts. */
	intentId?: string;
	reference?: ExecutionReference;
	/** Trusted synchronous consumer check after final preflight, before submission starts. */
	validateReference?(): void;
	timeoutMs?: number;
	protectionStopPrice?: number;
	/** Engine-validated atomic protection replacement or full protected close. */
	replacementIds?: string[];
	confirm?(summary: string, confirmation?: PreparedPlanConfirmation): Promise<boolean>;
	/** Explicitly opt into headless live submission without a confirmation callback. */
	allowUnconfirmedLive?: boolean;
	/** Return true when a failed submission may have reached the exchange. */
	submissionStatusUnknown?(error: unknown): boolean;
}

function combineFailures(message: string, first: unknown, second: unknown): Error {
	return new AggregateError([first, second], message);
}

function withConfirmationWarnings(summary: string, warnings: string[]): string {
	return warnings.length === 0 ? summary : `${summary}\nWarnings: ${warnings.join("; ")}`;
}

function toPreparedPlanConfirmation(
	preflight: OrderPreflightResult,
	summarize: (evidence: OrderConfirmationEvidence, warnings: string[]) => string,
	requote: boolean,
): PreparedPlanConfirmation {
	const { evidence, warnings } = preflight;
	return {
		summary: summarize(evidence, warnings),
		referencePrice: evidence.referencePrice,
		amount: evidence.amount,
		notional: evidence.notional,
		riskNotional: evidence.riskNotional,
		warnings,
		requote,
	};
}

const LIVE_CANCELLATION_REQUIRES_OPEN_IDENTITY =
	"Cancellation requires current open order identities on the requested symbol";

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
	/** Engine clock; callers cannot write this. */
	private readonly preparedAt = new WeakMap<object, number>();
	/** A prepared plan is single-use once an exchange attempt starts. */
	private readonly consumedPlans = new WeakSet<object>();
	/** Prevent two concurrent callers from submitting the same plan. */
	private readonly inFlightPlans = new WeakSet<object>();
	private readonly journal: ExecutionJournal | undefined;
	private readonly clock: RiskClock;
	private submissionsRetired = false;
	readonly accountRisk: AccountRiskGuard | undefined;

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
		this.clock = clock ?? { now: () => new Date() };
		this.risk = new RiskLedger(toRiskConfig(acceptedConfig), stateStore, this.clock);
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
				this.clock,
				execution.admissionGeneration,
			);
			this.accountRisk = new AccountRiskGuard(stateStore, exchange, this.journal.scope, config.risk.account, () =>
				this.clock.now().getTime(),
			);
		}
	}

	listExecutions() {
		return this.executionJournal().list();
	}
	findExecutionIntent(intentId: string): string | undefined {
		return this.executionJournal().findIntent(intentId);
	}
	acknowledgeExecutionArchive(id: string, revision: number): void {
		this.executionJournal().acknowledgeExecutionArchive(id, revision);
	}
	async refreshExecutionEvidence(id: string): Promise<void> {
		const journal = this.executionJournal();
		const entry = journal.list().find((record) => record.id === id);
		if (
			!entry ||
			entry.scope.accountId !== journal.scope.accountId ||
			entry.scope.mode !== journal.scope.mode ||
			entry.scope.exchange !== journal.scope.exchange ||
			entry.scope.marketType !== journal.scope.marketType ||
			entry.scope.quoteCurrency !== journal.scope.quoteCurrency ||
			entry.scope.positionMode !== journal.scope.positionMode
		)
			throw new Error("Execution not found in the current account scope");
		if (isUnresolvedExecution(entry)) throw new Error("Execution is unresolved; use /recovery");
		if (
			!entry.evidence?.orders.length ||
			entry.evidence.orders.every(
				(order) => order.status !== "open" && order.feeObservation?.completeness === "complete",
			)
		)
			return;
		const capabilities = getTradingCapabilities({
			exchangeId: entry.scope.exchange,
			mode: entry.scope.mode,
			marketFamily: entry.intent.input.symbol.includes(":") ? "futures" : "spot",
			positionMode: entry.scope.positionMode,
			orderType: entry.intent.kind === "order" ? entry.intent.input.type : "oco",
		});
		if (
			!supportsCorrelatedLookup(
				entry.intent.kind === "order" ? capabilities.queryOrderByClientId : capabilities.queryOrderListByClientId,
			)
		)
			throw new Error("Correlated execution lookup is unsupported for this scope");
		const result = await boundedLookup(
			async () =>
				entry.intent.kind === "order"
					? { order: await this.getOrderByClientId(entry.intent.input.clientOrderId!, entry.intent.input.symbol) }
					: { orders: (await this.getOrderListByClientId(entry.intent.input.listClientOrderId!)).orders },
			1500,
		);
		const observation = executionEvidence(entry, result, "client-id-lookup");
		journal.updateEvidence(entry.id, entry.revision, observation.evidence);
	}
	protectionTargets() {
		return this.executionJournal().protectionTargets();
	}
	claimProtectionRepair(id: string): string {
		return this.executionJournal().claimProtectionRepair(id);
	}
	finishProtectionRepair(id: string, succeeded = false): void {
		this.executionJournal().finishProtectionRepair(id, succeeded);
	}
	retireProtectionTarget(id: string): void {
		this.executionJournal().retireProtectionTarget(id);
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
	async setLeverage(symbol: string, leverage: number, intentId?: string, signal?: AbortSignal) {
		signal?.throwIfAborted();
		let mutationId: string | undefined;
		if (this.accountRisk?.state()) {
			if (this.getExecutionStatus().unresolved.length)
				throw new Error("Reconcile in-flight orders before changing leverage");
			const observed = await this.accountRisk.inspect();
			const limits = this.accountRisk.state()!.limits;
			if (assessLeverageSetting(limits, leverage).length)
				throw new Error("Leverage exceeds configured account risk limit");
			if (observed.snapshot.positions.length || observed.snapshot.orders.length)
				throw new Error(
					"Leverage adjustment with exposure requires an adapter post-change margin/liquidation projection",
				);
			if (!observed.assessment.allowed) throw new Error(`Account risk: ${observed.assessment.reasons.join(", ")}`);
			signal?.throwIfAborted();
			mutationId = this.accountRisk.claim(observed.revision, { kind: "leverage", symbol, leverage }, intentId);
		}
		this.recordConfigurationChange("leverage-requested");
		const result = await this.exchangeClient.setLeverage(symbol, leverage);
		if (mutationId) this.accountRisk!.finishMutation(mutationId);
		this.recordConfigurationChange("leverage-applied");
		return result;
	}
	async setMarginMode(symbol: string, marginType: "isolated" | "cross", intentId?: string, signal?: AbortSignal) {
		signal?.throwIfAborted();
		let mutationId: string | undefined;
		if (this.accountRisk?.state()) {
			if (this.getExecutionStatus().unresolved.length)
				throw new Error("Reconcile in-flight orders before changing margin mode");
			const observed = await this.accountRisk.inspect();
			if (observed.snapshot.positions.length || observed.snapshot.orders.length)
				throw new Error(
					"Margin-mode adjustment with exposure requires an adapter post-change liquidation projection",
				);
			if (!observed.assessment.allowed) throw new Error(`Account risk: ${observed.assessment.reasons.join(", ")}`);
			signal?.throwIfAborted();
			mutationId = this.accountRisk.claim(observed.revision, { kind: "margin", symbol, marginType }, intentId);
		}
		this.recordConfigurationChange("margin-mode-requested");
		const result = await this.exchangeClient.setMarginMode(symbol, marginType);
		if (mutationId) this.accountRisk!.finishMutation(mutationId);
		this.recordConfigurationChange("margin-mode-applied");
		return result;
	}
	async setMultiAssetsMode(enabled: boolean) {
		if (this.accountRisk?.state())
			throw new Error("Multi-Assets risk projection is unavailable; account hard limits prohibit this change");
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
			this.preparedAt.set(plan, this.clock.now().getTime());
			return plan;
		});
	}
	prepareOcoOrder(intent: OcoIntent): Promise<PreparedOco> {
		return prepareOcoOrder(intent, this.planningContext).then((plan) => {
			this.preparedOcos.set(plan, plan);
			this.preparedAt.set(plan, this.clock.now().getTime());
			return plan;
		});
	}

	async previewOrder(plan: PreparedOrder, policy: TradingEngineSubmissionPolicy = {}) {
		const prepared = this.preparedOrders.get(plan);
		if (!prepared) throw new PreparedPlanError("Order plan was not prepared by this trading engine");
		const quotaError = this.risk.check(prepared.input.symbol, prepared.notional, {
			countTowardsDailyLimit: prepared.countTowardsDailyLimit,
		});
		if (quotaError) throw new PreparedPlanError(quotaError);
		const execution = await this.preflightPreparedOrder(prepared, policy.replacementIds);
		const account = this.accountRisk?.state()
			? await this.accountRisk.preflight(
					prepared.input,
					prepared.countTowardsDailyLimit,
					policy.protectionStopPrice,
					policy.replacementIds,
				)
			: undefined;
		if (account && prepared.countTowardsDailyLimit) {
			const freshQuotaError = this.risk.check(prepared.input.symbol, Math.max(prepared.notional, account.notional));
			if (freshQuotaError) throw new PreparedPlanError(freshQuotaError);
		}
		return { execution, account };
	}

	private async preflightPreparedOrder(prepared: PreparedOrder, replacementIds?: string[]) {
		const input = prepared.input;
		const result = await preflightOrder(prepared, {
			getMarketInfo: (symbol) => this.marketDataClient.getMarketInfo(symbol),
			getTicker: (symbol) => this.marketDataClient.getTicker(symbol),
			getPositions: () => this.marketDataClient.getPositions(),
			getBalances: async () => {
				const balances = await this.marketDataClient.getBalances();
				if (!replacementIds || input.symbol.includes(":")) return balances;
				const snapshot = await this.accountRisk!.snapshot();
				const groups = new Set<string>();
				let released = 0;
				for (const order of snapshot.orders.filter((order) => replacementIds.includes(order.id))) {
					const group = order.ocoGroup ?? order.id;
					if (!groups.has(group)) released += order.remaining;
					groups.add(group);
				}
				return balances.map(
					(balance): Balance =>
						balance.asset === input.symbol.split("/")[0]
							? { ...balance, free: balance.free + released }
							: balance,
				);
			},
			quoteCurrency: this.quoteCurrency,
			marketType: this.config.marketType,
			getEffectiveLeverage: (symbol) => this.getEffectiveLeverage(symbol),
			feeRate: this.exchangeClient.feeRate,
		});
		if (!prepared.countTowardsDailyLimit && !replacementIds) await this.verifyReduction(input);
		return result;
	}

	async placeOrder(
		plan: PreparedOrder,
		policy: TradingEngineSubmissionPolicy = {},
		signal?: AbortSignal,
	): Promise<PlaceOrderResult> {
		policy = {
			...policy,
			...(policy.reference ? { reference: structuredClone(policy.reference) } : {}),
			...(policy.replacementIds ? { replacementIds: [...policy.replacementIds] } : {}),
		};
		const prepared = this.preparedOrders.get(plan);
		if (!prepared) throw new PreparedPlanError("Order plan was not prepared by this trading engine");
		const input = { ...prepared.input, clientOrderId: executionClientIds(policy.intentId).clientOrderId };
		const replacementIds = policy.replacementIds;
		if (
			replacementIds &&
			(prepared.countTowardsDailyLimit || !this.accountRisk?.state() || !this.exchangeClient.replaceProtectiveOrders)
		) {
			throw new Error("Atomic replacement requires a reducing order, account hard risk and adapter support");
		}
		return this.submitWithReservation(
			plan,
			"Order",
			prepared.notional,
			prepared.countTowardsDailyLimit,
			{
				referencePrice: prepared.referencePrice,
				amount: prepared.amount,
				notional: prepared.notional,
				riskNotional: prepared.notional,
			},
			(evidence, warnings) =>
				withConfirmationWarnings(
					formatPreparedOrderSummary(
						prepared.side,
						prepared.amount,
						prepared.input,
						prepared.capabilityContext,
						this.quoteCurrency,
						evidence.notional,
					),
					warnings,
				),
			{ kind: "order", input, ...(replacementIds ? { replacementIds } : {}) },
			() =>
				replacementIds
					? this.exchangeClient.replaceProtectiveOrders!(input, replacementIds)
					: this.exchangeClient.placeOrder(input),
			() => this.preflightPreparedOrder(prepared, replacementIds),
			policy,
			signal,
		);
	}

	async placeOco(
		plan: PreparedOco,
		policy: TradingEngineSubmissionPolicy = {},
		signal?: AbortSignal,
	): Promise<PlaceOcoOrderResult> {
		policy = { ...policy, ...(policy.reference ? { reference: structuredClone(policy.reference) } : {}) };
		const prepared = this.preparedOcos.get(plan);
		if (!prepared) throw new PreparedPlanError("OCO plan was not prepared by this trading engine");
		const { listClientOrderId, aboveClientOrderId, belowClientOrderId } = executionClientIds(policy.intentId);
		const input = { ...prepared.input, listClientOrderId, aboveClientOrderId, belowClientOrderId };
		return this.submitWithReservation(
			plan,
			"OCO order",
			prepared.riskNotional,
			prepared.countTowardsDailyLimit,
			{
				referencePrice: prepared.referencePrice,
				amount: prepared.input.amount,
				notional: prepared.observedNotional,
				riskNotional: prepared.riskNotional,
			},
			(evidence, warnings) =>
				withConfirmationWarnings(
					formatPreparedOcoSummary(prepared.input, this.quoteCurrency, evidence.notional, evidence.riskNotional),
					warnings,
				),
			{ kind: "oco", input },
			() => this.exchangeClient.placeOcoOrder(input),
			async () => {
				const result = await preflightOco(prepared, {
					getMarketInfo: (symbol) => this.marketDataClient.getMarketInfo(symbol),
					getBalances: () => this.marketDataClient.getBalances(),
					getTicker: (symbol) => this.marketDataClient.getTicker(symbol),
					quoteCurrency: this.quoteCurrency,
				});
				if (!prepared.countTowardsDailyLimit)
					await this.verifyReduction({ ...input, type: "stop_market", stopPrice: input.stopLossPrice });
				return result;
			},
			policy,
			signal,
		);
	}

	private throwIfAborted(signal?: AbortSignal): void {
		if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Operation cancelled");
	}

	private async preflightAccountRisk(
		intent: ExecutionRecord["intent"],
		countTowardsDailyLimit: boolean,
		policy: TradingEngineSubmissionPolicy,
	) {
		if (!this.accountRisk?.state()) return;
		return this.accountRisk.preflight(
			intent.kind === "order"
				? intent.input
				: { ...intent.input, type: "stop_market" as const, stopPrice: intent.input.stopLossPrice },
			countTowardsDailyLimit,
			policy.protectionStopPrice,
			policy.replacementIds,
		);
	}

	private async revalidatePreparedPlan(
		plan: object,
		label: string,
		preflight: () => Promise<OrderPreflightResult>,
		intent: ExecutionRecord["intent"],
		countTowardsDailyLimit: boolean,
		policy: TradingEngineSubmissionPolicy,
		signal?: AbortSignal,
	) {
		this.throwIfAborted(signal);
		this.assertPreparedPlanFresh(plan, label);
		const executionPreflight = await preflight();
		this.throwIfAborted(signal);
		const account = await this.preflightAccountRisk(intent, countTowardsDailyLimit, policy);
		this.throwIfAborted(signal);
		this.assertPreparedPlanFresh(plan, label);
		return { preflight: executionPreflight, account };
	}

	private async submitWithReservation<T extends PlaceOrderResult | PlaceOcoOrderResult>(
		plan: object,
		label: string,
		notional: number,
		countTowardsDailyLimit: boolean,
		preparedEvidence: Pick<OrderConfirmationEvidence, "referencePrice" | "amount" | "notional" | "riskNotional">,
		summarize: (evidence: OrderConfirmationEvidence, warnings: string[]) => string,
		intent: ExecutionRecord["intent"],
		submit: () => Promise<T>,
		preflight: () => Promise<OrderPreflightResult>,
		policy: TradingEngineSubmissionPolicy,
		signal?: AbortSignal,
	): Promise<T> {
		this.throwIfAborted(signal);
		const journal = this.executionJournal();
		if (this.consumedPlans.has(plan)) {
			throw new PreparedPlanError(`${label} plan has already been submitted; prepare a new plan before retrying`);
		}
		if (this.inFlightPlans.has(plan)) {
			throw new PreparedPlanError(`${label} plan is already being submitted`);
		}
		if (countTowardsDailyLimit) this.risk.assertNewExposureAllowed();
		this.inFlightPlans.add(plan);
		let initial: Awaited<ReturnType<TradingEngine["revalidatePreparedPlan"]>>;
		let execution: ExecutionRecord;
		let riskRevision: number | undefined;
		try {
			initial = await this.revalidatePreparedPlan(
				plan,
				label,
				preflight,
				intent,
				countTowardsDailyLimit,
				policy,
				signal,
			);
			if (this.submissionsRetired) throw new Error("Trading engine was replaced; prepare with the active runtime");
			if (!policy.confirm && marketEvidenceChanged(preparedEvidence, initial.preflight)) {
				throw new PreparedPlanError(
					`${label} reference price or risk notional materially changed; prepare and confirm a new order`,
				);
			}
			const claimedNotional = countTowardsDailyLimit
				? Math.max(notional, initial.preflight.evidence.notional, initial.account?.notional ?? 0)
				: notional;
			execution = journal.prepare(intent, claimedNotional, countTowardsDailyLimit, {
				intentId: policy.intentId,
				reference: policy.reference,
				riskRevision: initial.account?.revision,
				protectionStopPrice: policy.protectionStopPrice,
			});
			// prepare() increments accountRisk.revision; begin() must see that generation.
			riskRevision = this.accountRisk?.state()?.revision;
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
			let confirmation = toPreparedPlanConfirmation(initial.preflight, summarize, false);
			let prompts = 0;
			for (;;) {
				if (++prompts > PREPARED_PLAN_MAX_CONFIRMATIONS) {
					return releaseAndThrow(
						new PreparedPlanError(
							`${label} market evidence kept changing during confirmation; prepare and confirm a new order`,
						),
						`${label} pre-submission check and risk release failed`,
					);
				}
				let confirmed: boolean;
				try {
					confirmed = await policy.confirm(confirmation.summary, confirmation);
				} catch (error) {
					return releaseAndThrow(error, `${label} confirmation failed and risk reservation release failed`);
				}
				if (!confirmed) {
					return releaseAndThrow(
						new Error("Order cancelled by user"),
						`${label} cancellation and risk release failed`,
					);
				}
				try {
					const current = await this.revalidatePreparedPlan(
						plan,
						label,
						preflight,
						intent,
						countTowardsDailyLimit,
						policy,
						signal,
					);
					if (countTowardsDailyLimit && current.account && current.account.notional > execution.notional) {
						throw new PreparedPlanError("Account notional increased after reservation; prepare a fresh intent");
					}
					if (!confirmationSnapshotChanged(confirmation, current.preflight)) break;
					confirmation = toPreparedPlanConfirmation(current.preflight, summarize, true);
				} catch (error) {
					return releaseAndThrow(error, `${label} pre-submission check and risk release failed`);
				}
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
			this.throwIfAborted(signal);
			if (policy.validateReference && policy.validateReference() !== undefined)
				throw new Error("Execution reference validation must be synchronous");
			if (countTowardsDailyLimit) this.risk.assertNewExposureAllowed(execution.id);
			journal.begin(execution.id, riskRevision);
		} catch (error) {
			return releaseAndThrow(error, `${label} pre-submission check and risk release failed`);
		}

		// From this point onward an exchange call may happen. Consume the plan
		// before awaiting it so concurrent callers and retries cannot double-submit.
		this.inFlightPlans.delete(plan);
		this.consumedPlans.add(plan);
		let result: T;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			if (policy.timeoutMs !== undefined && (!Number.isFinite(policy.timeoutMs) || policy.timeoutMs <= 0))
				throw new Error("Invalid submission timeout");
			result =
				policy.timeoutMs === undefined
					? await submit()
					: await Promise.race([
							submit(),
							new Promise<never>((_resolve, reject) => {
								timeout = setTimeout(
									() => reject(new Error("Submission timeout; exchange acceptance unknown")),
									policy.timeoutMs,
								);
							}),
						]);
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
		} finally {
			if (timeout) clearTimeout(timeout);
		}

		try {
			const observation = executionEvidence(execution, result, "submission");
			journal.settle(execution.id, observation.outcome, observation.notional, "acknowledged", observation.evidence);
		} catch {
			throw new ExecutionRecoveryError(execution.id, "response validation or settlement persistence failed");
		}
		return { ...result, executionId: execution.id };
	}

	private assertPreparedPlanFresh(plan: object, label: string): void {
		const preparedAt = this.preparedAt.get(plan);
		const age = preparedAt === undefined ? Number.NaN : this.clock.now().getTime() - preparedAt;
		if (!Number.isFinite(age) || age < 0 || age > PREPARED_PLAN_TTL_MS) {
			throw new PreparedPlanError(`${label} plan expired; prepare and confirm a new order`);
		}
	}

	async cancelOrder(id: string, symbol: string, signal?: AbortSignal, intentId?: string): Promise<void> {
		if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Operation cancelled");
		if (this.mode === "live" && !this.accountRisk?.state()) {
			await this.assertLiveCancellationKeepsProtection([await this.requireLiveOpenOrder(id, symbol)]);
		}
		const revision = await this.accountRisk?.checkCancellation([id], symbol);
		signal?.throwIfAborted();
		const mutationId =
			revision !== undefined
				? this.accountRisk!.claim(revision, { kind: "cancel", symbol, orderIds: [id] }, intentId)
				: undefined;
		await this.exchangeClient.cancelOrder(id, symbol);
		if (mutationId) this.accountRisk!.finishMutation(mutationId);
	}

	async cancelOrderList(orderListId: string, symbol: string, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Operation cancelled");
		let mutationId: string | undefined;
		if (this.accountRisk?.state()) {
			const list = await this.exchangeClient.getOrderList(orderListId);
			const revision = await this.accountRisk.checkCancellation(
				list.orders.map((order) => order.id),
				symbol,
			);
			signal?.throwIfAborted();
			if (revision !== undefined)
				mutationId = this.accountRisk.claim(revision, {
					kind: "cancel",
					symbol,
					orderIds: list.orders.map((order) => order.id),
				});
		} else if (this.mode === "live") {
			const list = await this.exchangeClient.getOrderList(orderListId);
			if (!list.orders.length) throw new Error(LIVE_CANCELLATION_REQUIRES_OPEN_IDENTITY);
			await this.assertLiveCancellationKeepsProtection(list.orders);
		}
		await this.exchangeClient.cancelOrderList(orderListId, symbol);
		if (mutationId) this.accountRisk!.finishMutation(mutationId);
	}

	/** A missing open-orders snapshot is not proof the target is unprotected. */
	private async requireLiveOpenOrder(id: string, symbol: string): Promise<Order> {
		const listed = (await this.exchangeClient.getOpenOrders(symbol)).find((order) => order.id === id);
		if (listed) return listed;
		try {
			const lookedUp = await this.exchangeClient.getOrder(id, symbol);
			if (lookedUp.id === id && lookedUp.symbol === symbol && lookedUp.status === "open") return lookedUp;
		} catch {
			// Lookup failure is not proof the order is unprotected.
		}
		throw new Error(LIVE_CANCELLATION_REQUIRES_OPEN_IDENTITY);
	}

	/**
	 * Account hard risk arbitrates live cancellations when configured. Without
	 * it, a live cancellation must never strip a stop-flavored exit from an
	 * open position; use a controlled close instead.
	 */
	private async assertLiveCancellationKeepsProtection(orders: Order[]): Promise<void> {
		const positions = await this.exchangeClient.getPositions();
		const scope = { positionMode: this.config.positionMode };
		const protectedExits = orders.filter((order) =>
			positions.some((position) => isProtectiveExit(order, position, scope)),
		);
		if (protectedExits.length > 0) {
			throw new Error(
				`Cancellation would remove protection for an open position (${protectedExits
					.map((order) => order.id)
					.join(
						", ",
					)}); retain it or use a controlled close, or configure risk.account to arbitrate cancellations`,
			);
		}
	}

	private async verifyReduction(input: PlaceOrderInput): Promise<void> {
		if (!input.symbol.includes(":")) {
			const balances = await this.exchangeClient.getBalances();
			const held = balances.find((balance) => balance.asset === input.symbol.split("/")[0]);
			if (
				input.side !== "sell" ||
				!held ||
				!Number.isFinite(held.free) ||
				input.amount - held.free > Number.EPSILON * Math.max(1, input.amount, Math.abs(held.free)) * 8
			)
				throw new Error("Spot reduction exceeds currently available holdings");
			return;
		}
		const positions = await this.exchangeClient.getPositions();
		const matches = positions.filter(
			(position) =>
				position.symbol === input.symbol &&
				(input.side === "buy"
					? position.positionSide === "SHORT" || position.amount < 0
					: position.positionSide !== "SHORT" && position.amount > 0) &&
				(this.config.positionMode !== "hedge" || position.positionSide === input.positionSide),
		);
		if (matches.length !== 1 || input.amount > Math.abs(matches[0].amount) * (1 + 1e-12))
			throw new Error("Reduction no longer fits the current position");
		if (this.config.positionMode === "one-way" && input.reduceOnly !== true && input.closePosition !== true)
			throw new Error("Reduction requires an exchange reduce-only constraint");
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
