import { randomUUID } from "node:crypto";
import {
	type AccountRiskAssessment,
	type AccountRiskFacts,
	type AccountRiskLimits,
	type AccountRiskMutation,
	type AccountRiskState,
	assessAccountRisk,
	assessExecutionPrice,
	assessLeverageSetting,
	assessProtectionTarget,
	type RiskStateStore,
	validateAccountRiskLimits,
	validateAccountRiskStates,
} from "@nikopack/ti-trading-risk";
import { boundedLookup } from "./bounded-lookup.ts";
import { accountRiskKey, type ExecutionScope } from "./execution-journal.ts";
import { hasStopComponent, reduceSide } from "./protection.ts";
import type { AccountSnapshot, ExchangeClient, Order, PlaceOrderInput, Position } from "./types.ts";

export class AccountRiskError extends Error {
	readonly code = "ACCOUNT_RISK_REJECTED";
}

/**
 * A stop-flavored order that reduces an open position. Removing such an order
 * can strip protection, so live cancellations without account hard risk must
 * refuse to touch it.
 */
export function isProtectiveExit(
	order: Pick<Order, "symbol" | "side" | "type" | "reduceOnly" | "closePosition" | "positionSide">,
	position: Position,
	scope: Pick<ExecutionScope, "positionMode">,
): boolean {
	return verifiedReducingOrder(order, position, scope) && hasStopComponent(order);
}

export function verifiedReducingOrder(
	order: Pick<Order, "symbol" | "side" | "reduceOnly" | "closePosition" | "positionSide">,
	position: Position,
	scope: Pick<ExecutionScope, "positionMode">,
): boolean {
	return (
		order.symbol === position.symbol &&
		order.side === reduceSide(position) &&
		(!order.symbol.includes(":") ||
			((order.reduceOnly === true || order.closePosition === true || scope.positionMode === "hedge") &&
				(scope.positionMode !== "hedge" || order.positionSide === position.positionSide)))
	);
}

function protectiveStopDistancePct(order: Order, mark: number, reduce: "buy" | "sell"): number | undefined {
	if (Number.isFinite(order.stopPrice) && order.stopPrice! > 0) {
		if (reduce === "sell" ? order.stopPrice! >= mark : order.stopPrice! <= mark) return undefined;
		return Math.abs(order.stopPrice! / mark - 1) * 100;
	}
	if (order.type === "trailing_stop_market" && Number.isFinite(order.trailingPercent) && order.trailingPercent! > 0)
		return order.trailingPercent;
	return undefined;
}

function exposureIdentity(exposure: { symbol: string; pending: boolean; notional: number }): string {
	return `${exposure.symbol}:${exposure.pending ? "pending" : "open"}:${Math.sign(exposure.notional)}`;
}

export function accountRiskFacts(snapshot: AccountSnapshot, scope: ExecutionScope): AccountRiskFacts {
	const exposures: AccountRiskFacts["exposures"] = [];
	for (const position of snapshot.positions) {
		const mark = snapshot.prices[position.symbol]?.price;
		if (!Number.isFinite(mark) || mark! <= 0 || !Number.isFinite(position.amount))
			throw new Error(`Position mark/amount unavailable: ${position.symbol}`);
		const amount = Math.abs(position.amount);
		const reduce = reduceSide(position);
		const stops = snapshot.orders.filter(
			(order) =>
				order.status === "open" &&
				hasStopComponent(order) &&
				verifiedReducingOrder(order, position, scope) &&
				protectiveStopDistancePct(order, mark!, reduce) !== undefined,
		);
		const groups = new Set<string>();
		let covered = 0;
		let stopDistancePct: number | undefined;
		for (const order of stops) {
			const group = order.ocoGroup ?? order.id;
			if (groups.has(group)) continue;
			groups.add(group);
			covered += order.closePosition ? amount : Math.max(0, order.remaining);
			stopDistancePct = Math.max(stopDistancePct ?? 0, protectiveStopDistancePct(order, mark!, reduce)!);
		}
		const futures = position.symbol.includes(":");
		exposures.push({
			asset: position.asset,
			symbol: position.symbol,
			notional: amount * mark! * (reduceSide(position) === "buy" ? -1 : 1),
			pending: false,
			futures,
			liquidationDistancePct:
				futures && position.liquidationPrice !== undefined
					? (Math.abs(mark! - position.liquidationPrice) / mark!) * 100
					: undefined,
			protectionCoveragePct: amount > 0 ? Math.min(100, (covered / amount) * 100) : 100,
			stopDistancePct,
		});
	}
	const groups = new Set<string>();
	for (const order of snapshot.orders) {
		if (order.status !== "open" || !Number.isFinite(order.remaining) || order.remaining < 0)
			throw new Error("Open order status/quantity unavailable");
		const position = snapshot.positions.find((position) => verifiedReducingOrder(order, position, scope));
		if (position && (order.closePosition || order.remaining <= Math.abs(position.amount))) continue;
		// Spot sells cannot borrow and are bounded by locked balances at the venue.
		if (!order.symbol.includes(":") && order.side === "sell") continue;
		const group = order.ocoGroup ?? order.id;
		if (groups.has(group)) continue;
		groups.add(group);
		const mark = snapshot.prices[order.symbol]?.price;
		if (!Number.isFinite(mark) || mark! <= 0) throw new Error(`Open order price unavailable: ${order.symbol}`);
		const price = Math.max(mark!, order.price ?? 0, order.stopPrice ?? 0);
		exposures.push({
			asset: order.symbol.split("/")[0],
			symbol: order.symbol,
			notional: order.remaining * price * (order.side === "buy" ? 1 : -1),
			pending: true,
			futures: order.symbol.includes(":"),
			protectionCoveragePct: 0,
		});
	}
	return {
		source: snapshot.source,
		epoch: snapshot.epoch,
		observedAt: snapshot.observedAt,
		oldestPriceAt: snapshot.oldestPriceAt,
		equity: snapshot.equity,
		netExternalFlows: snapshot.netExternalFlows,
		marginUsed: snapshot.marginUsed,
		exposures,
	};
}

export class AccountRiskGuard {
	readonly key: string;
	private readonly store: RiskStateStore;
	private readonly client: ExchangeClient;
	private readonly scope: ExecutionScope;
	private readonly now: () => number;
	private mutationReconciliation: Promise<void> | undefined;

	constructor(
		store: RiskStateStore,
		client: ExchangeClient,
		scope: ExecutionScope,
		limits?: AccountRiskLimits,
		now = Date.now,
	) {
		this.store = store;
		this.client = client;
		this.scope = scope;
		this.key = accountRiskKey(scope);
		this.now = now;
		if (limits) {
			validateAccountRiskLimits(limits);
			this.transact((states) => {
				const previous = states[this.key];
				if (previous && JSON.stringify(previous.limits) !== JSON.stringify(limits)) {
					throw new Error(
						"Persisted account hard limits differ from configuration; explicit operator migration required",
					);
				}
				states[this.key] ??= { limits: structuredClone(limits), revision: 0, blockedReasons: [] };
			});
		}
	}

	state(): AccountRiskState | undefined {
		const states = this.store.load().accountRisk;
		if (states) validateAccountRiskStates(states);
		return structuredClone(states?.[this.key]);
	}

	private transact<T>(operation: (states: Record<string, AccountRiskState>) => T): T {
		if (!this.store.transact) throw new Error("Atomic risk store required");
		return this.store.transact((state) => {
			state.accountRisk ??= {};
			validateAccountRiskStates(state.accountRisk);
			const result = operation(state.accountRisk);
			validateAccountRiskStates(state.accountRisk);
			return result;
		});
	}

	block(reason: string): void {
		this.transact((states) => {
			const state = states[this.key];
			if (!state) throw new Error("Account hard limits are not configured");
			state.blockedReasons = [reason];
		});
	}

	async snapshot(): Promise<AccountSnapshot> {
		if (!this.client.getAccountSnapshot) {
			throw new Error(
				`Account risk facts unavailable on ${this.client.mode}:${this.client.id}: complete equity, external capital flows, margin and order enumeration are required`,
			);
		}
		return this.client.getAccountSnapshot();
	}

	async inspect(): Promise<{ snapshot: AccountSnapshot; assessment: AccountRiskAssessment; revision: number }> {
		const state = this.state();
		if (!state) throw new Error("Account hard limits are not configured");
		const revision = state.revision;
		let snapshot: AccountSnapshot;
		let assessment: AccountRiskAssessment;
		try {
			snapshot = await this.snapshot();
			assessment = assessAccountRisk(state.limits, accountRiskFacts(snapshot, this.scope), state.memory, this.now());
		} catch (error) {
			this.block("account-observation-unavailable");
			throw error;
		}
		this.transact((states) => {
			const current = states[this.key];
			if (current.revision !== revision)
				throw new Error("Account changed during risk observation; collect fresh facts");
			const next = assessAccountRisk(
				current.limits,
				accountRiskFacts(snapshot, this.scope),
				current.memory,
				this.now(),
			);
			if (current.mutation) {
				next.allowed = false;
				next.reasons.push("account-mutation-pending");
			}
			current.memory = next.memory;
			current.blockedReasons = next.reasons;
			assessment = next;
		});
		return { snapshot, assessment, revision };
	}

	async preflight(
		input: PlaceOrderInput,
		increasing: boolean,
		protectionStopPrice?: number,
		replacementIds?: string[],
	): Promise<{ revision: number; assessment: AccountRiskAssessment; notional: number }> {
		const observed = await this.inspect();
		const state = this.state()!;
		const snapshot = observed.snapshot;
		const futures = input.symbol.includes(":");
		if (!increasing) {
			const matching = snapshot.positions.filter((position) => verifiedReducingOrder(input, position, this.scope));
			if (
				matching.length !== 1 ||
				input.amount > Math.abs(matching[0].amount) + Number.EPSILON * Math.max(1, input.amount) * 8
			) {
				throw new Error("Reduction must fit exactly one current position without reversing it");
			}
			if (replacementIds) {
				if (
					!replacementIds.length ||
					new Set(replacementIds).size !== replacementIds.length ||
					!replacementIds.every((id) =>
						snapshot.orders.some(
							(order) => order.id === id && verifiedReducingOrder(order, matching[0], this.scope),
						),
					)
				) {
					throw new Error("Replacement must reference current reducing orders for exactly this position");
				}
				if (input.type !== "market" && input.type !== "stop_market")
					throw new Error("Atomic replacement must close the position or maintain an executable stop");
				if (input.type === "market" && input.amount !== Math.abs(matching[0].amount))
					throw new Error("Atomic protected close must close the entire current position");
				const groups = new Set(
					snapshot.orders
						.filter((order) => replacementIds.includes(order.id))
						.map((order) => order.ocoGroup)
						.filter((id) => id !== undefined),
				);
				snapshot.orders = snapshot.orders.filter(
					(order) => !replacementIds.includes(order.id) && (!order.ocoGroup || !groups.has(order.ocoGroup)),
				);
			}
			// A valid exit is not blocked by loss, concentration, whitelist or flow quota.
			if (observed.assessment.reasons.some((reason) => reason.startsWith("stale:")))
				throw new Error("Reduction account/market facts are stale");
			if (input.type === "stop_market" || input.type === "stop" || input.type === "trailing_stop_market") {
				const targetReasons = assessProtectionTarget(
					state.limits,
					input.side,
					snapshot.prices[input.symbol]?.price,
					input.stopPrice!,
				);
				if (targetReasons.length) throw new AccountRiskError(`Protection risk: ${targetReasons.join(", ")}`);
				const proposed = {
					...snapshot,
					orders: [
						...snapshot.orders,
						{
							...input,
							id: "proposed-protection",
							filled: 0,
							remaining: input.amount,
							cost: 0,
							status: "open" as const,
							timestamp: this.now(),
						},
					],
				};
				const protection = assessAccountRisk(
					state.limits,
					accountRiskFacts(proposed, this.scope),
					state.memory,
					this.now(),
				);
				if (protection.reasons.includes(`stopDistance:${input.symbol}`))
					throw new Error("Protection target violates configured stop distance");
				if (replacementIds && protection.reasons.includes(`protection:${input.symbol}`))
					throw new Error("Replacement would leave insufficient protection");
			}
			return {
				revision: observed.revision,
				assessment: observed.assessment,
				notional: input.amount * snapshot.prices[input.symbol].price,
			};
		}
		if (!observed.assessment.allowed)
			throw new AccountRiskError(`Account risk: ${observed.assessment.reasons.join(", ")}`);
		const [ticker, book] = await Promise.all([
			this.client.getTicker(input.symbol),
			this.client.getOrderBook(input.symbol),
		]);
		if (!Number.isFinite(ticker.last) || ticker.last! <= 0) throw new Error("Reference market price unavailable");
		if (protectionStopPrice === undefined && state.limits.minProtectionCoveragePct > 0) {
			throw new AccountRiskError("Opening exposure requires a model-selected protectionStopPrice");
		}
		if (
			protectionStopPrice !== undefined &&
			assessProtectionTarget(state.limits, input.side === "buy" ? "sell" : "buy", ticker.last!, protectionStopPrice)
				.length
		)
			throw new AccountRiskError("Protection target violates configured stop distance");
		const price = Math.max(ticker.last!, input.price ?? 0, input.stopPrice ?? 0);
		const levels = input.side === "buy" ? book.asks : book.bids;
		const boundedDepth = levels
			.filter((level) => Math.abs(level.price / ticker.last! - 1) * 100 <= state.limits.maxPriceDeviationPct)
			.reduce((sum, level) => sum + level.amount, 0);
		const priceReasons = assessExecutionPrice(state.limits, {
			now: this.now(),
			observedAt: Math.min(book.timestamp, ticker.timestamp),
			referencePrice: ticker.last!,
			orderPrice: input.price ?? ticker.last!,
			availableDepth: boundedDepth,
			amount: input.amount,
		});
		if (priceReasons.length) throw new AccountRiskError(`Execution risk: ${priceReasons.join(", ")}`);
		const facts = accountRiskFacts(snapshot, this.scope);
		const leverage = futures ? this.client.getEffectiveLeverage?.(input.symbol) : 1;
		if (!Number.isFinite(leverage) || leverage! <= 0) throw new Error("Effective leverage unavailable");
		if (futures) {
			if (assessLeverageSetting(state.limits, leverage!).length)
				throw new AccountRiskError("Configured futures leverage exceeds account maxLeverage");
			if (!this.client.getRiskSettings)
				throw new AccountRiskError("Post-action margin/liquidation settings unavailable");
			const settings = await this.client.getRiskSettings(input.symbol);
			if (settings.marginType !== "isolated")
				throw new AccountRiskError("Post-action cross-margin liquidation projection is unavailable");
		}
		const notional = input.amount * price;
		let liquidationDistancePct: number | undefined;
		if (futures) {
			if (!this.client.projectOpeningRisk)
				throw new AccountRiskError("Post-action liquidation projection unavailable");
			liquidationDistancePct = (await this.client.projectOpeningRisk(input, price)).liquidationDistancePct;
		}
		facts.exposures.push({
			asset: input.symbol.split("/")[0],
			symbol: input.symbol,
			notional: notional * (input.side === "buy" ? 1 : -1),
			pending: true,
			futures,
			projected: futures,
			liquidationDistancePct,
			protectionCoveragePct: 0,
		});
		if (futures) facts.marginUsed += notional / leverage!;
		// Equity is already net of fees/funding. Reserve known submission fees as well.
		if (this.client.feeRate === undefined)
			throw new Error("Execution fee bound unavailable for account risk preflight");
		facts.equity -= notional * this.client.feeRate;
		const assessment = assessAccountRisk(state.limits, facts, state.memory, this.now());
		if (!assessment.allowed) throw new AccountRiskError(`Post-action account risk: ${assessment.reasons.join(", ")}`);
		return { revision: observed.revision, assessment, notional };
	}

	async checkCancellation(ids: string[], symbol: string): Promise<number | undefined> {
		if (!this.state()) return undefined;
		const { snapshot, revision } = await this.inspect();
		if (
			!ids.length ||
			new Set(ids).size !== ids.length ||
			!ids.every((id) => snapshot.orders.some((order) => order.id === id && order.symbol === symbol))
		)
			throw new AccountRiskError("Cancellation requires current open order identities on the requested symbol");
		const oldCoverage = accountRiskFacts(snapshot, this.scope).exposures;
		const before = assessAccountRisk(
			this.state()!.limits,
			accountRiskFacts(snapshot, this.scope),
			this.state()!.memory,
			this.now(),
		);
		const groups = new Set(
			snapshot.orders
				.filter((order) => ids.includes(order.id))
				.map((order) => order.ocoGroup)
				.filter((id) => id !== undefined),
		);
		snapshot.orders = snapshot.orders.filter(
			(order) => !ids.includes(order.id) && (!order.ocoGroup || !groups.has(order.ocoGroup)),
		);
		const after = assessAccountRisk(
			this.state()!.limits,
			accountRiskFacts(snapshot, this.scope),
			this.state()!.memory,
			this.now(),
		);
		if (after.reasons.some((reason) => reason.startsWith("protection:") && !before.reasons.includes(reason))) {
			throw new Error("Cancellation would remove required protection; retain it or use a controlled close");
		}
		const previousCoverage = new Map(
			oldCoverage.map((exposure) => [exposureIdentity(exposure), exposure.protectionCoveragePct]),
		);
		const newCoverage = accountRiskFacts(snapshot, this.scope).exposures;
		if (
			newCoverage.some(
				(exposure) => exposure.protectionCoveragePct < (previousCoverage.get(exposureIdentity(exposure)) ?? 0),
			)
		) {
			throw new Error("Cancellation would weaken protection");
		}
		return revision;
	}

	claim(revision: number, mutation: AccountRiskMutation, intentId?: string): string {
		return this.transact((states) => {
			const state = states[this.key];
			if (!state || state.revision !== revision)
				throw new Error("Account risk observation is stale; retry with fresh facts");
			if (state.mutation) throw new AccountRiskError("Unresolved account mutation blocks another account mutation");
			state.mutation = { ...mutation, id: intentId ?? randomUUID() };
			state.revision++;
			return state.mutation.id;
		});
	}

	finishMutation(id: string): void {
		this.transact((states) => {
			const state = states[this.key];
			if (state.mutation?.id !== id) throw new Error("Account mutation identity changed");
			delete state.mutation;
			state.revision++;
		});
	}

	async reconcileMutation(timeoutMs = 1500): Promise<void> {
		if (!this.mutationReconciliation) {
			const operation = this.reconcileCurrentMutation();
			this.mutationReconciliation = operation;
			void operation.then(
				() => {
					if (this.mutationReconciliation === operation) this.mutationReconciliation = undefined;
				},
				() => {
					if (this.mutationReconciliation === operation) this.mutationReconciliation = undefined;
				},
			);
		}
		const operation = this.mutationReconciliation;
		await boundedLookup(() => operation, timeoutMs);
	}

	private async reconcileCurrentMutation(): Promise<void> {
		const mutation = this.state()?.mutation;
		if (!mutation) return;
		let resolved: boolean;
		if (mutation.kind === "cancel") {
			const orders = await Promise.all(mutation.orderIds.map((id) => this.client.getOrder(id, mutation.symbol)));
			resolved = orders.every(
				(order, index) =>
					order.id === mutation.orderIds[index] &&
					order.symbol === mutation.symbol &&
					["canceled", "closed", "expired", "rejected"].includes(order.status),
			);
		} else {
			if (!this.client.getRiskSettings) return;
			const settings = await this.client.getRiskSettings(mutation.symbol);
			resolved =
				mutation.kind === "leverage"
					? settings.leverage === mutation.leverage
					: settings.marginType === mutation.marginType;
		}
		if (resolved) this.finishMutation(mutation.id);
	}
}
