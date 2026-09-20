import type { AccountRiskLimits, RiskStateStore, TradingRiskState } from "@nikopack/ti-trading-risk";
import { describe, expect, it } from "vitest";
import { TradingEngine, type TradingEngineConfig } from "./engine.ts";
import { ExecutionRecoveryError, type ExecutionRiskState } from "./execution-journal.ts";
import { superviseAccountRisk } from "./risk-supervisor.ts";
import type { AccountSnapshot, ExchangeClient, Order, PlaceOrderInput, Position } from "./types.ts";
import { SubmissionRejectedError } from "./types.ts";

const now = Date.parse("2026-09-14T00:00:00Z");
const accountLimits: AccountRiskLimits = {
	maxGrossExposure: 150,
	maxNetExposure: 150,
	maxAssetExposure: 150,
	maxLeverage: 2,
	maxMarginUsagePct: 80,
	maxDailyLoss: 50,
	maxDrawdown: 100,
	maxDataAgeMs: 10000,
	maxPriceDeviationPct: 5,
	minDepthRatio: 1,
	minLiquidationDistancePct: 5,
	minProtectionCoveragePct: 95,
	maxStopDistancePct: 20,
	cancelEntriesOnBreach: true,
	reduceOnBreach: true,
};

function fixture() {
	let state: TradingRiskState = {
		paper: { date: "2026-09-14", usedDailyNotional: 0 },
		live: { date: "2026-09-14", usedDailyNotional: 0 },
	};
	const store: RiskStateStore = {
		load: () => structuredClone(state),
		save: (next) => {
			state = structuredClone(next);
		},
		transact: (fn) => {
			const draft = structuredClone(state);
			const result = fn(draft);
			state = draft;
			return result;
		},
	};
	const positions: Position[] = [];
	const orders: Order[] = [];
	let cash = 1000;
	const behavior = {
		acceptedTimeout: false,
		failProtection: false,
		partial: false,
		stale: false,
		unknownAccount: false,
		lookupVisible: true,
	};
	let submissions = 0;
	const client: ExchangeClient = {
		id: "binance",
		mode: "paper",
		quoteCurrency: "USDT",
		feeRate: 0.001,
		getTicker: async (symbol) => ({
			symbol,
			last: 100,
			bid: 100,
			ask: 100,
			timestamp: behavior.stale ? now - 20000 : now,
		}),
		getOrderBook: async (symbol) => ({
			symbol,
			timestamp: now,
			bids: [{ price: 100, amount: 100 }],
			asks: [{ price: 100, amount: 100 }],
			bidDepth: 100,
			askDepth: 100,
		}),
		getMarketInfo: async (symbol) => ({
			symbol,
			base: symbol.split("/")[0],
			quote: "USDT",
			marketType: "spot",
			contract: false,
			active: true,
			amountStep: 0.001,
		}),
		getContractStats: async () => {
			throw new Error("Not futures");
		},
		getKlines: async () => [],
		getBalances: async () => [
			{ asset: "USDT", total: cash, free: cash, used: 0, quoteValue: cash },
			...positions.map((position) => ({
				asset: position.asset,
				total: position.amount,
				free:
					position.amount -
					orders
						.filter(
							(order) => order.symbol === position.symbol && order.side === "sell" && order.status === "open",
						)
						.reduce((sum, order) => sum + order.remaining, 0),
				used: 0,
				quoteValue: position.amount * 100,
			})),
		],
		getPositions: async () => structuredClone(positions),
		getOpenOrders: async () => structuredClone(orders.filter((order) => order.status === "open")),
		getOrderHistory: async () => structuredClone(orders),
		getOrder: async (id) => {
			const order = orders.find((order) => order.id === id);
			if (!behavior.lookupVisible || !order) throw new Error("not found");
			return structuredClone(order);
		},
		getOrderByClientId: async (id) => {
			const order = orders.find((order) => order.clientOrderId === id);
			if (!behavior.lookupVisible || !order) throw new Error("not found");
			return structuredClone(order);
		},
		getOrderList: async () => {
			throw new Error("No list");
		},
		getOrderListByClientId: async () => {
			throw new Error("No list");
		},
		placeOcoOrder: async () => {
			throw new Error("No OCO fixture");
		},
		placeOrder: async (input: PlaceOrderInput) => {
			submissions++;
			if (input.type === "stop_market" && behavior.failProtection)
				throw new SubmissionRejectedError("protection rejected");
			const filled =
				input.type === "market" ? input.amount * (behavior.partial && input.side === "buy" ? 0.5 : 1) : 0;
			const order: Order = {
				...input,
				id: `order-${submissions}`,
				filled,
				remaining: input.amount - filled,
				cost: filled * 100,
				average: filled ? 100 : undefined,
				status: filled === input.amount ? "closed" : "open",
				timestamp: now,
			};
			orders.push(order);
			if (filled) {
				let position = positions.find((position) => position.symbol === input.symbol);
				if (!position) {
					position = {
						symbol: input.symbol,
						asset: input.symbol.split("/")[0],
						amount: 0,
						markPrice: 100,
						avgEntryPrice: 100,
						quoteValue: 0,
					};
					positions.push(position);
				}
				position.amount += filled * (input.side === "buy" ? 1 : -1);
				position.quoteValue = position.amount * 100;
				cash += filled * 100 * (input.side === "buy" ? -1 : 1) - filled * 0.1;
				if (position.amount === 0) positions.splice(positions.indexOf(position), 1);
			}
			if (behavior.acceptedTimeout) {
				behavior.acceptedTimeout = false;
				throw new Error("timeout after acceptance");
			}
			return { order: structuredClone(order), fee: filled * 0.1 };
		},
		cancelOrder: async (id) => {
			const order = orders.find((order) => order.id === id);
			if (!order) throw new Error("not found");
			order.status = "canceled";
		},
		cancelOrderList: async () => {
			throw new Error("No list");
		},
		getTopMarkets: async () => [],
		getFundingRate: async (symbol) => ({ symbol }),
		getFundingRateHistory: async () => [],
		getEffectiveLeverage: () => 1,
		setLeverage: async () => {},
		setMarginMode: async () => {},
		setMultiAssetsMode: async () => {},
		close: async () => {},
		getAccountSnapshot: async (): Promise<AccountSnapshot> => {
			if (behavior.unknownAccount) throw new Error("Account disconnected");
			return {
				source: "fake-paper",
				epoch: "one",
				observedAt: now,
				oldestPriceAt: behavior.stale ? now - 20000 : now,
				equity: cash + positions.reduce((sum, position) => sum + position.amount * 100, 0),
				netExternalFlows: 1000,
				marginUsed: 0,
				positions: structuredClone(positions),
				orders: structuredClone(orders.filter((order) => order.status === "open")),
				prices: Object.fromEntries(
					[
						...new Set([...positions.map((position) => position.symbol), ...orders.map((order) => order.symbol)]),
					].map((symbol) => [symbol, { price: 100, timestamp: now }]),
				),
				limitations: ["deterministic fixture"],
			};
		},
	};
	const config: TradingEngineConfig = {
		mode: "paper",
		marketType: "spot",
		positionMode: "one-way",
		quoteCurrency: "USDT",
		risk: { maxOrderNotional: 100, maxDailyNotional: 100, allowedSymbols: [], account: accountLimits },
	};
	const createEngine = () =>
		new TradingEngine(
			config,
			client,
			store,
			{ now: () => new Date(now) },
			{ durability: "memory", accountId: "test-account" },
		);
	return {
		engine: createEngine(),
		createEngine,
		config,
		store,
		client,
		positions,
		orders,
		behavior,
		submissions: () => submissions,
	};
}

describe("autonomous engine risk boundary", () => {
	it("does not submit when cancellation arrives during the final asynchronous preflight", async () => {
		const f = fixture();
		const plan = await f.engine.prepareOrder("buy", { symbol: "BTC/USDT", type: "market", amount: 0.5 });
		const abort = new AbortController();
		const getMarketInfo = f.client.getMarketInfo;
		let calls = 0;
		f.client.getMarketInfo = async (symbol) => {
			if (++calls === 1) abort.abort();
			return getMarketInfo(symbol);
		};
		await expect(
			f.engine.placeOrder(plan, { intentId: "aborted-final", protectionStopPrice: 90 }, abort.signal),
		).rejects.toThrow(/aborted/i);
		expect(f.submissions()).toBe(0);
		expect(f.engine.risk.usage().reserved).toBe(0);
	});
	it("rejects nonexistent cancellation identities without creating an unresolvable mutation", async () => {
		const f = fixture();
		await expect(f.engine.cancelOrder("nonexistent", "BTC/USDT")).rejects.toThrow("identities");
		expect(f.engine.accountRisk!.state()?.mutation).toBeUndefined();
	});
	it("continues protection when a persisted cancellation cannot be reconciled", async () => {
		const f = fixture();
		await f.engine.placeOrder(
			await f.engine.prepareOrder("buy", { symbol: "BTC/USDT", type: "market", amount: 0.5 }),
			{ intentId: "entry", protectionStopPrice: 90 },
		);
		f.store.transact!((state) => {
			state.accountRisk![f.engine.accountRisk!.key].mutation = {
				id: "abandoned-cancel",
				kind: "cancel",
				symbol: "BTC/USDT",
				orderIds: ["missing"],
			};
		});
		f.client.getOrder = () => new Promise<Order>(() => {});
		const report = await superviseAccountRisk(f.engine, { timeoutMs: 5, protectionAttempts: 2, now: () => now });
		expect(report.snapshot).toBeDefined();
		expect(
			report.actions.some((action) => action.action === "reconcile-mutation" && action.status === "unknown"),
		).toBe(true);
		expect(f.orders.some((order) => order.type === "stop_market" && order.status === "open")).toBe(true);
		expect(f.engine.accountRisk!.state()?.mutation).toBeDefined();
	});
	it("rechecks opening flow limits at the final observed price rather than the old plan price", async () => {
		const f = fixture();
		const plan = await f.engine.prepareOrder("buy", { symbol: "BTC/USDT", type: "market", amount: 1 });
		// Stay inside the 1% confirmed-price band so account risk, not plan materiality, is the rejecting check.
		f.client.getTicker = async (symbol) => ({ symbol, last: 100.5, bid: 100.5, ask: 100.5, timestamp: now });
		f.client.getOrderBook = async (symbol) => ({
			symbol,
			timestamp: now,
			bids: [{ price: 100.5, amount: 100 }],
			asks: [{ price: 100.5, amount: 100 }],
			bidDepth: 100,
			askDepth: 100,
		});
		await expect(f.engine.placeOrder(plan, { intentId: "repriced", protectionStopPrice: 90 })).rejects.toThrow(
			"maxOrderNotional",
		);
		expect(f.submissions()).toBe(0);
	});
	it("bounds pending account exposure even when transaction-flow quota is available", async () => {
		const f = fixture();
		f.engine.setConfig({ ...f.config, risk: { ...f.config.risk, maxDailyNotional: 1000 } });
		await f.engine.placeOrder(
			await f.engine.prepareOrder("buy", { symbol: "BTC/USDT", type: "limit", amount: 1, price: 100 }),
			{ intentId: "first", protectionStopPrice: 90 },
		);
		await expect(
			f.engine.placeOrder(
				await f.engine.prepareOrder("buy", { symbol: "BTC/USDT", type: "limit", amount: 1, price: 100 }),
				{ intentId: "second", protectionStopPrice: 90 },
			),
		).rejects.toThrow("maxGrossExposure");
		expect(f.submissions()).toBe(1);
	});
	it("reconciles unknown accepted orders during independent supervision without resending", async () => {
		const f = fixture();
		f.behavior.acceptedTimeout = true;
		await expect(
			f.engine.placeOrder(
				await f.engine.prepareOrder("buy", { symbol: "BTC/USDT", type: "limit", amount: 0.5, price: 100 }),
				{ intentId: "unknown", protectionStopPrice: 90 },
			),
		).rejects.toThrow();
		await superviseAccountRisk(f.engine, { timeoutMs: 1000, protectionAttempts: 2, now: () => now });
		expect(f.engine.getExecutionStatus().unresolved).toHaveLength(0);
		expect(f.submissions()).toBe(1);
	});
	it("preserves unknown cancellations across restart and reconciles by order identity", async () => {
		const f = fixture();
		await f.engine.placeOrder(
			await f.engine.prepareOrder("buy", { symbol: "BTC/USDT", type: "limit", amount: 0.5, price: 100 }),
			{ intentId: "first", protectionStopPrice: 90 },
		);
		const original = f.client.cancelOrder;
		f.client.cancelOrder = async (id, symbol) => {
			await original(id, symbol);
			throw new Error("timeout after cancellation");
		};
		await expect(f.engine.cancelOrder(f.orders[0].id, "BTC/USDT", undefined, "cancel-intent")).rejects.toThrow(
			"timeout",
		);
		const restarted = f.createEngine();
		expect(restarted.accountRisk!.state()?.mutation?.id).toBe("cancel-intent");
		await restarted.accountRisk!.reconcileMutation();
		expect(restarted.accountRisk!.state()?.mutation).toBeUndefined();
		expect(f.orders[0].status).toBe("canceled");
	});
	it("atomically rejects concurrent orders exceeding the shared budget", async () => {
		const f = fixture();
		const other = f.createEngine();
		const [left, right] = await Promise.all([
			f.engine.prepareOrder("buy", { symbol: "BTC/USDT", type: "limit", amount: 0.75, price: 100 }),
			other.prepareOrder("buy", { symbol: "BTC/USDT", type: "limit", amount: 0.75, price: 100 }),
		]);
		const results = await Promise.allSettled([
			f.engine.placeOrder(left, { intentId: "a", protectionStopPrice: 90 }),
			other.placeOrder(right, { intentId: "b", protectionStopPrice: 90 }),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(f.submissions()).toBe(1);
		expect(f.engine.risk.usage().used + f.engine.risk.usage().reserved).toBeLessThanOrEqual(100);
	});
	it("does not resend a durable intent after retry or restart and reconciles acceptance after timeout", async () => {
		const f = fixture();
		f.behavior.acceptedTimeout = true;
		const input = { symbol: "BTC/USDT", type: "limit" as const, amount: 0.5, price: 100 };
		await expect(
			f.engine.placeOrder(await f.engine.prepareOrder("buy", input), {
				intentId: "stable-event-action",
				protectionStopPrice: 90,
			}),
		).rejects.toBeInstanceOf(ExecutionRecoveryError);
		expect(f.engine.risk.usage().reserved).toBe(50);
		const restarted = f.createEngine();
		await restarted.recoverExecutions();
		expect(restarted.getExecutionStatus().unresolved).toHaveLength(0);
		expect(restarted.findExecutionIntent("stable-event-action")).toBeDefined();
		await expect(
			restarted.placeOrder(await restarted.prepareOrder("buy", input), {
				intentId: "stable-event-action",
				protectionStopPrice: 90,
			}),
		).rejects.toThrow();
		expect(f.submissions()).toBe(1);
	});
	it("covers partial fills using actual position quantity", async () => {
		const f = fixture();
		f.behavior.partial = true;
		await f.engine.placeOrder(await f.engine.prepareOrder("buy", { symbol: "BTC/USDT", type: "market", amount: 1 }), {
			intentId: "partial",
			protectionStopPrice: 90,
		});
		await superviseAccountRisk(f.engine, { timeoutMs: 1000, protectionAttempts: 2, now: () => now });
		expect(f.orders.find((order) => order.type === "stop_market")?.amount).toBe(0.5);
	});
	it("repairs successive partial fills without spending the failure retry budget on successful repairs", async () => {
		const f = fixture();
		f.behavior.partial = true;
		await f.engine.placeOrder(await f.engine.prepareOrder("buy", { symbol: "BTC/USDT", type: "market", amount: 1 }), {
			intentId: "progressive",
			protectionStopPrice: 90,
		});
		await superviseAccountRisk(f.engine, { timeoutMs: 1000, protectionAttempts: 1, now: () => now });
		for (let fill = 0; fill < 3; fill++) {
			f.positions[0].amount += 0.1;
			f.orders[0].filled += 0.1;
			f.orders[0].remaining -= 0.1;
			f.orders[0].cost += 10;
			await superviseAccountRisk(f.engine, { timeoutMs: 1000, protectionAttempts: 1, now: () => now });
			const covered = f.orders
				.filter((order) => order.status === "open" && order.type === "stop_market")
				.reduce((sum, order) => sum + order.remaining, 0);
			expect(covered).toBeCloseTo(f.positions[0].amount);
		}
	});
	it("independently cancels entries and reduces an unprotected fill after protection failure", async () => {
		const f = fixture();
		await f.engine.placeOrder(await f.engine.prepareOrder("buy", { symbol: "BTC/USDT", type: "market", amount: 1 }), {
			intentId: "entry",
			protectionStopPrice: 90,
		});
		f.behavior.failProtection = true;
		const report = await superviseAccountRisk(f.engine, { timeoutMs: 1000, protectionAttempts: 1, now: () => now });
		expect(report.actions.some((action) => action.action === "protect" && action.status !== "completed")).toBe(true);
		expect(f.positions).toHaveLength(0);
	});
	it("blocks cancellation of required protection and leverage changes that cannot be evaluated", async () => {
		const f = fixture();
		await f.engine.placeOrder(
			await f.engine.prepareOrder("buy", { symbol: "BTC/USDT", type: "market", amount: 0.5 }),
			{ intentId: "entry", protectionStopPrice: 90 },
		);
		await superviseAccountRisk(f.engine, { timeoutMs: 1000, protectionAttempts: 2, now: () => now });
		const stop = f.orders.find((order) => order.type === "stop_market")!;
		await expect(f.engine.cancelOrder(stop.id, stop.symbol)).rejects.toThrow("protection");
		await expect(f.engine.setLeverage("BTC/USDT:USDT", 100)).rejects.toThrow("Leverage");
	});
	it("allows exits after flow quota exhaustion and opening whitelist removal", async () => {
		const f = fixture();
		await f.engine.placeOrder(await f.engine.prepareOrder("buy", { symbol: "BTC/USDT", type: "market", amount: 1 }), {
			intentId: "entry",
			protectionStopPrice: 90,
		});
		f.engine.setConfig({
			...f.config,
			risk: { ...f.config.risk, maxOrderNotional: 10, allowedSymbols: ["ETH/USDT"] },
		});
		await f.engine.placeOrder(
			await f.engine.prepareOrder("sell", { symbol: "BTC/USDT", type: "market", amount: 1 }),
			{ intentId: "exit" },
		);
		expect(f.positions).toHaveLength(0);
		expect(f.engine.risk.usage().used).toBe(100);
	});
	it("fails closed on stale prices and unavailable account state", async () => {
		const f = fixture();
		f.behavior.stale = true;
		await expect(
			f.engine.placeOrder(await f.engine.prepareOrder("buy", { symbol: "BTC/USDT", type: "market", amount: 1 }), {
				protectionStopPrice: 90,
			}),
		).rejects.toThrow("stale");
		f.behavior.unknownAccount = true;
		await expect(f.engine.accountRisk!.inspect()).rejects.toThrow("disconnected");
		expect(f.engine.accountRisk!.state()?.blockedReasons).toContain("account-observation-unavailable");
		expect(f.submissions()).toBe(0);
	});
	it("does not resubmit a timed-out accepted protection after a delayed restart lookup", async () => {
		const f = fixture();
		f.behavior.partial = true;
		await f.engine.placeOrder(await f.engine.prepareOrder("buy", { symbol: "BTC/USDT", type: "market", amount: 1 }), {
			intentId: "entry",
			protectionStopPrice: 90,
		});
		expect(f.positions[0]?.amount).toBe(0.5);
		expect(f.engine.risk.usage()).toMatchObject({ used: 100, reserved: 0 });
		expect(f.engine.protectionTargets()).toEqual([
			expect.objectContaining({ symbol: "BTC/USDT", side: "sell", stopPrice: 90 }),
		]);

		f.behavior.acceptedTimeout = true;
		const timedOut = await superviseAccountRisk(f.engine, {
			timeoutMs: 1000,
			protectionAttempts: 2,
			now: () => now,
		});
		expect(timedOut.actions.some((action) => action.action === "protect" && action.status === "unknown")).toBe(true);
		expect(f.submissions()).toBe(2);
		expect(f.orders.filter((order) => order.type === "stop_market")).toHaveLength(1);
		expect(f.engine.getExecutionStatus().unresolved).toHaveLength(1);
		expect(f.engine.risk.usage()).toMatchObject({ used: 100, reserved: 0 });
		await expect(
			f.engine.placeOrder(
				await f.engine.prepareOrder("buy", { symbol: "BTC/USDT", type: "limit", amount: 0.1, price: 100 }),
				{ intentId: "blocked-while-unknown", protectionStopPrice: 90 },
			),
		).rejects.toThrow(/unresolved executions/);
		expect(f.submissions()).toBe(2);

		f.behavior.lookupVisible = false;
		const restarted = f.createEngine();
		const delayed = await restarted.recoverExecutions({
			backoffMs: 0,
			lookupTimeoutMs: 20,
			attemptsPerRecord: 1,
		});
		expect(delayed.unresolved).toBe(1);
		expect(delayed.issues).toContainEqual(expect.objectContaining({ issue: "lookup-unavailable" }));
		expect(restarted.listExecutions().find((entry) => entry.status === "unknown")).toMatchObject({
			issue: "lookup-unavailable",
			intent: expect.objectContaining({
				input: expect.objectContaining({ type: "stop_market", amount: 0.5, stopPrice: 90 }),
			}),
		});
		expect(restarted.protectionTargets()).toEqual([
			expect.objectContaining({ symbol: "BTC/USDT", side: "sell", stopPrice: 90 }),
		]);
		const hiddenSupervise = await superviseAccountRisk(restarted, {
			timeoutMs: 1000,
			protectionAttempts: 2,
			now: () => now,
		});
		expect(hiddenSupervise.actions.some((action) => action.status === "unknown")).toBe(true);
		expect(f.submissions()).toBe(2);
		expect(f.orders.filter((order) => order.type === "stop_market")).toHaveLength(1);
		expect(restarted.getExecutionStatus().unresolved).toHaveLength(1);

		f.behavior.lookupVisible = true;
		f.store.transact!((state) => {
			for (const record of (state as ExecutionRiskState).executions?.records ?? []) {
				delete record.nextAttemptAt;
			}
		});
		const recovered = await restarted.recoverExecutions({
			backoffMs: 0,
			lookupTimeoutMs: 20,
			attemptsPerRecord: 1,
		});
		expect(recovered.unresolved).toBe(0);
		expect(recovered.issues).toEqual([]);
		expect(restarted.getExecutionStatus().unresolved).toHaveLength(0);
		expect(restarted.risk.usage()).toMatchObject({ used: 100, reserved: 0 });
		expect(restarted.listExecutions()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					intentId: "entry",
					status: "acknowledged",
					settlement: { outcome: "commit", notional: 100 },
				}),
				expect.objectContaining({
					status: "reconciled",
					intent: expect.objectContaining({
						input: expect.objectContaining({ type: "stop_market", amount: 0.5 }),
					}),
					settlement: expect.objectContaining({ outcome: "commit" }),
				}),
			]),
		);
		await superviseAccountRisk(restarted, { timeoutMs: 1000, protectionAttempts: 2, now: () => now });
		expect(f.submissions()).toBe(2);
		expect(f.orders.filter((order) => order.type === "stop_market" && order.status === "open")).toHaveLength(1);
		expect(restarted.protectionTargets()).toEqual([
			expect.objectContaining({ symbol: "BTC/USDT", side: "sell", stopPrice: 90 }),
		]);
	});
});
