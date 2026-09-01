import {
	type OcoIntent,
	type OrderIntent,
	type OrderPlanningContext,
	type PreparedOco,
	type PreparedOrder,
	prepareOcoOrder,
	prepareOrder,
} from "./order-plan.ts";
import {
	type EngineClock,
	RiskLedger,
	type RiskReservation,
	type RiskStateStore,
	type TradingEngineConfig,
} from "./risk.ts";
import {
	createMarketDataView,
	type ExchangeClient,
	type MarketDataClient,
	type Order,
	type OrderList,
	type OrderSide,
	type PlaceOcoOrderResult,
	type PlaceOrderResult,
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
	/** Return true when a failed submission may have reached the exchange. */
	submissionStatusUnknown?(error: unknown): boolean;
}

function combineFailures(message: string, first: unknown, second: unknown): Error {
	return new AggregateError([first, second], message);
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

	constructor(config: TradingEngineConfig, exchange: ExchangeClient, stateStore: RiskStateStore, clock?: EngineClock) {
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
		this.risk = new RiskLedger(acceptedConfig, stateStore, clock);
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
		return this.exchangeClient.getTicker(symbol);
	}
	getOrderBook(symbol: string, limit?: number) {
		return this.exchangeClient.getOrderBook(symbol, limit);
	}
	getMarketInfo(symbol: string) {
		return this.exchangeClient.getMarketInfo(symbol);
	}
	getContractStats(symbol: string) {
		return this.exchangeClient.getContractStats(symbol);
	}
	getKlines(symbol: string, timeframe: string, limit: number) {
		return this.exchangeClient.getKlines(symbol, timeframe, limit);
	}
	getBalances() {
		return this.exchangeClient.getBalances();
	}
	getPositions() {
		return this.exchangeClient.getPositions();
	}
	getOpenOrders(symbol?: string) {
		return this.exchangeClient.getOpenOrders(symbol);
	}
	getOrderHistory(symbol?: string, limit?: number) {
		return this.exchangeClient.getOrderHistory(symbol, limit);
	}
	getTopMarkets(limit: number) {
		return this.exchangeClient.getTopMarkets(limit);
	}
	getFundingRate(symbol: string) {
		return this.exchangeClient.getFundingRate(symbol);
	}
	getFundingRateHistory(symbol: string, limit?: number) {
		return this.exchangeClient.getFundingRateHistory(symbol, limit);
	}
	setLeverage(symbol: string, leverage: number) {
		return this.exchangeClient.setLeverage(symbol, leverage);
	}
	setMarginMode(symbol: string, marginType: "isolated" | "cross") {
		return this.exchangeClient.setMarginMode(symbol, marginType);
	}
	setMultiAssetsMode(enabled: boolean) {
		return this.exchangeClient.setMultiAssetsMode(enabled);
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
		this.risk.setConfig(acceptedConfig);
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

	async placeOrder(plan: PreparedOrder, policy: TradingEngineSubmissionPolicy = {}): Promise<PlaceOrderResult> {
		const prepared = this.preparedOrders.get(plan);
		if (!prepared) throw new PreparedPlanError("Order plan was not prepared by this trading engine");
		return this.submitWithReservation(
			plan,
			"Order",
			prepared.input.symbol,
			prepared.notional,
			prepared.countTowardsDailyLimit,
			prepared.summary,
			() => this.exchangeClient.placeOrder({ ...prepared.input }),
			policy,
		);
	}

	async placeOco(plan: PreparedOco, policy: TradingEngineSubmissionPolicy = {}): Promise<PlaceOcoOrderResult> {
		const prepared = this.preparedOcos.get(plan);
		if (!prepared) throw new PreparedPlanError("OCO plan was not prepared by this trading engine");
		return this.submitWithReservation(
			plan,
			"OCO order",
			prepared.input.symbol,
			prepared.riskNotional,
			prepared.countTowardsDailyLimit,
			prepared.summary,
			() => this.exchangeClient.placeOcoOrder({ ...prepared.input }),
			policy,
		);
	}

	private async submitWithReservation<T>(
		plan: object,
		label: string,
		symbol: string,
		notional: number,
		countTowardsDailyLimit: boolean,
		summary: string,
		submit: () => Promise<T>,
		policy: TradingEngineSubmissionPolicy,
	): Promise<T> {
		if (this.consumedPlans.has(plan)) {
			throw new PreparedPlanError(`${label} plan has already been submitted; prepare a new plan before retrying`);
		}
		if (this.inFlightPlans.has(plan)) {
			throw new PreparedPlanError(`${label} plan is already being submitted`);
		}
		this.inFlightPlans.add(plan);

		let reservation: RiskReservation;
		try {
			reservation = this.risk.reserve(symbol, notional, { countTowardsDailyLimit });
		} catch (error) {
			this.inFlightPlans.delete(plan);
			throw error;
		}

		const releaseAndThrow = (original: unknown, message: string): never => {
			try {
				reservation.release();
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
		}

		// From this point onward an exchange call may happen. Consume the plan
		// before awaiting it so concurrent callers and retries cannot double-submit.
		this.inFlightPlans.delete(plan);
		this.consumedPlans.add(plan);
		let result: T;
		try {
			result = await submit();
		} catch (submissionError) {
			let statusUnknown = false;
			let policyError: unknown;
			if (policy.submissionStatusUnknown) {
				try {
					statusUnknown = policy.submissionStatusUnknown(submissionError);
				} catch (error) {
					// A broken classifier is itself ambiguous: conservatively account for
					// the attempted submission and retain the original error as context.
					statusUnknown = true;
					policyError = error;
				}
			}
			if (statusUnknown) {
				try {
					reservation.commit();
				} catch (settlementError) {
					throw combineFailures(
						`${label} submission status is unknown and risk settlement failed; do not retry`,
						submissionError,
						settlementError,
					);
				}
				if (policyError !== undefined) {
					throw combineFailures(
						`${label} submission status classifier failed; do not retry`,
						submissionError,
						policyError,
					);
				}
				throw submissionError;
			}
			try {
				reservation.release();
			} catch (releaseError) {
				throw combineFailures(
					`${label} submission failed and risk reservation release failed`,
					submissionError,
					releaseError,
				);
			}
			throw submissionError;
		}

		// A successful exchange response still needs durable risk settlement. A
		// RiskCommitError intentionally leaves its reservation claim unresolved.
		reservation.commit();
		return result;
	}

	async cancelOrder(id: string, symbol: string): Promise<void> {
		await this.exchangeClient.cancelOrder(id, symbol);
	}

	async cancelOrderList(orderListId: string, symbol: string): Promise<void> {
		await this.exchangeClient.cancelOrderList(orderListId, symbol);
	}

	getOrder(id: string, symbol: string): Promise<Order> {
		return this.exchangeClient.getOrder(id, symbol);
	}

	getOrderByClientId(origClientOrderId: string, symbol: string): Promise<Order> {
		return this.exchangeClient.getOrderByClientId(origClientOrderId, symbol);
	}

	getOrderList(orderListId: string): Promise<OrderList> {
		return this.exchangeClient.getOrderList(orderListId);
	}

	getOrderListByClientId(listClientOrderId: string): Promise<OrderList> {
		return this.exchangeClient.getOrderListByClientId(listClientOrderId);
	}

	close(): Promise<void> {
		return this.exchangeClient.close();
	}
}

export type { RiskReservation };
