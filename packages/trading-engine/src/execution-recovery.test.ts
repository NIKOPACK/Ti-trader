import { describe, expect, it, vi } from "vitest";
import * as Capabilities from "./capabilities.ts";
import { TradingEngine, type TradingEngineConfig } from "./engine.ts";
import {
	ExecutionJournal,
	type ExecutionRiskState,
	isUnresolvedExecution,
	observedExecutionFee,
	validateExecutionRiskState,
} from "./execution-journal.ts";
import type { ExchangeClient, Order, OrderFeeObservation, PlaceOcoOrderInput, PlaceOrderInput } from "./types.ts";
import { SubmissionRejectedError } from "./types.ts";

const config: TradingEngineConfig = {
	mode: "paper",
	marketType: "spot",
	positionMode: "one-way",
	quoteCurrency: "USDT",
	risk: { maxOrderNotional: 500, maxDailyNotional: 100_000, allowedSymbols: [] },
};
const recovery = { backoffMs: 0, lookupTimeoutMs: 20, attemptsPerRecord: 3 };
function fixture() {
	let state: ExecutionRiskState = {
		paper: { date: new Date().toISOString().slice(0, 10), usedDailyNotional: 0 },
		live: { date: new Date().toISOString().slice(0, 10), usedDailyNotional: 0 },
	};
	let writes = 0;
	let failAt = 0;
	let boundary: "before" | "draft" | "committed" = "before";
	const orders = new Map<string, Order>();
	const lists = new Map<string, Order[]>();
	const store = {
		load: () => structuredClone(state),
		save: (next: ExecutionRiskState) => {
			state = structuredClone(next);
		},
		transact: <T>(mutate: (draft: ExecutionRiskState) => T): T => {
			writes++;
			const fails = writes === failAt;
			if (fails && boundary === "before") throw new Error("storage failed");
			const draft = structuredClone(state);
			const value = mutate(draft);
			if (fails && boundary === "draft") throw new Error("storage failed");
			state = draft;
			if (fails && boundary === "committed") throw new Error("storage failed");
			return value;
		},
	};
	const submit = vi.fn(async (input: PlaceOrderInput) => {
		const order: Order = {
			...input,
			id: `native-${orders.size}`,
			filled: input.amount,
			remaining: 0,
			cost: input.amount * 100,
			status: "closed",
			timestamp: Date.now(),
		};
		orders.set(input.clientOrderId as string, order);
		return { order };
	});
	const submitOco = vi.fn(async (input: PlaceOcoOrderInput) => {
		const legs: Order[] = [input.aboveClientOrderId, input.belowClientOrderId].map((clientOrderId, index) => ({
			id: `leg-${index}`,
			clientOrderId,
			listClientOrderId: input.listClientOrderId,
			orderListId: "list-1",
			symbol: input.symbol,
			side: input.side,
			type: "limit",
			amount: input.amount,
			filled: 0,
			remaining: input.amount,
			cost: 0,
			status: "open",
			timestamp: Date.now(),
		}));
		lists.set(input.listClientOrderId as string, legs);
		return { orders: legs };
	});
	const lookup = vi.fn(async (id: string) => {
		const order = orders.get(id);
		if (!order) throw new Error("not found");
		return structuredClone(order);
	});
	const lookupList = vi.fn(async (id: string) => {
		const legs = lists.get(id);
		if (!legs) throw new Error("not found");
		return { id: "list-1", status: "open" as const, listOrderStatus: "EXECUTING", orders: structuredClone(legs) };
	});
	const exchange: ExchangeClient = {
		id: "binance",
		mode: "paper",
		quoteCurrency: "USDT",
		getTicker: async (symbol) => ({ symbol, last: 100, timestamp: Date.now() }),
		getMarketInfo: async (symbol) => ({
			symbol,
			base: "BTC",
			quote: "USDT",
			marketType: "spot",
			contract: false,
			active: true,
			amountStep: 0.0001,
		}),
		getOrderBook: async (symbol) => ({ symbol, timestamp: Date.now(), bids: [], asks: [], bidDepth: 0, askDepth: 0 }),
		getContractStats: async (symbol) => ({ symbol }),
		getKlines: async () => [],
		getPositions: async () => [],
		getOpenOrders: async () => [],
		getBalances: async () => [
			{ asset: "USDT", free: 1e6, used: 0, total: 1e6 },
			{ asset: "BTC", free: 100, used: 0, total: 100 },
		],
		getOrderHistory: async () => [],
		getOrder: lookup,
		getOrderByClientId: lookup,
		getOrderList: lookupList,
		getOrderListByClientId: lookupList,
		placeOrder: submit,
		placeOcoOrder: submitOco,
		cancelOrder: async () => {},
		cancelOrderList: async () => {},
		getTopMarkets: async () => [],
		getFundingRate: async (symbol) => ({ symbol }),
		getFundingRateHistory: async () => [],
		setLeverage: async () => {},
		setMarginMode: async () => {},
		setMultiAssetsMode: async () => {},
		close: async () => {},
	};
	const engine = (accountId = "fixture-account", client = exchange) =>
		new TradingEngine({ ...config, mode: client.mode }, client, store, undefined, {
			durability: "memory",
			accountId,
		});
	return {
		engine,
		store,
		exchange,
		submit,
		submitOco,
		lookup,
		lookupList,
		orders,
		lists,
		state: () => state,
		fail: (at: number, point: typeof boundary = "before") => {
			failAt = writes + at;
			boundary = point;
		},
	};
}
const orderIntent = { symbol: "BTC/USDT", type: "market" as const, amount: 1 };
const ocoIntent = { symbol: "BTC/USDT", side: "sell" as const, amount: 1, stopLossPrice: 90, takeProfitPrice: 110 };

describe("durable execution protocol", () => {
	it.each(["order", "oco"] as const)(
		"gates %s recovery with the original type and scope, not current metadata",
		async (kind) => {
			const f = fixture();
			const engine = f.engine();
			f.fail(3);
			await expect(
				kind === "order"
					? engine.placeOrder(await engine.prepareOrder("buy", orderIntent))
					: engine.placeOco(await engine.prepareOcoOrder(ocoIntent)),
			).rejects.toThrow();
			const matrix = vi.spyOn(Capabilities, "getTradingCapabilities");
			try {
				expect((await engine.recoverExecutions(recovery)).reconciled).toBe(1);
				expect(matrix).toHaveBeenCalledWith({
					exchangeId: "binance",
					mode: "paper",
					marketFamily: "spot",
					positionMode: "one-way",
					orderType: kind === "order" ? "market" : "oco",
				});
			} finally {
				matrix.mockRestore();
			}
		},
	);

	it("requires deliberate journal wiring instead of silently using an in-memory log", async () => {
		const f = fixture();
		const engine = new TradingEngine(config, f.exchange, f.store);
		await expect(engine.placeOrder(await engine.prepareOrder("buy", orderIntent))).rejects.toThrow(
			/journal is not configured/,
		);
		expect(f.submit).not.toHaveBeenCalled();
	});

	it.each(["before", "draft", "committed"] as const)("fails closed at prepared %s boundary", async (boundary) => {
		const f = fixture();
		const engine = f.engine();
		const plan = await engine.prepareOrder("buy", orderIntent);
		f.fail(1, boundary);
		await expect(engine.placeOrder(plan)).rejects.toThrow("storage failed");
		expect(f.submit).not.toHaveBeenCalled();
		validateExecutionRiskState(f.state());
		if (boundary === "committed") {
			expect(engine.listExecutions()[0]).toMatchObject({ status: "prepared" });
			expect(engine.risk.usage().reserved).toBe(100);
			expect((await f.engine().recoverExecutions(recovery)).reconciled).toBe(1);
			expect(engine.risk.usage()).toMatchObject({ used: 0, reserved: 0 });
		} else expect(engine.listExecutions()).toEqual([]);
	});

	it.each(["before", "draft", "committed"] as const)(
		"never sends after a started-state %s write failure",
		async (boundary) => {
			const f = fixture();
			const engine = f.engine();
			const plan = await engine.prepareOrder("buy", orderIntent);
			f.fail(2, boundary);
			await expect(engine.placeOrder(plan)).rejects.toThrow();
			expect(f.submit).not.toHaveBeenCalled();
			validateExecutionRiskState(f.state());
			if (boundary === "committed") {
				expect(engine.risk.usage().reserved).toBe(100);
				expect((await f.engine().recoverExecutions(recovery)).unresolved).toBe(1);
				await expect(engine.placeOrder(plan)).rejects.toThrow(/already been submitted/);
			} else expect(engine.risk.usage().reserved).toBe(0);
		},
	);

	it.each(["before", "draft", "committed"] as const)(
		"settles atomically after acceptance at %s boundary",
		async (boundary) => {
			const f = fixture();
			const engine = f.engine();
			const plan = await engine.prepareOrder("buy", orderIntent);
			f.fail(3, boundary);
			await expect(engine.placeOrder(plan)).rejects.toMatchObject({
				retryable: false,
				errorCategory: "EXECUTION_RECOVERY_REQUIRED",
			});
			expect(f.submit).toHaveBeenCalledOnce();
			validateExecutionRiskState(f.state());
			const results = await Promise.all([
				f.engine().recoverExecutions(recovery),
				f.engine().recoverExecutions(recovery),
			]);
			expect(results.reduce((sum, report) => sum + report.reconciled, 0)).toBe(boundary === "committed" ? 0 : 1);
			expect(engine.risk.usage()).toMatchObject({ used: 100, reserved: 0 });
			expect(engine.listExecutions().filter(isUnresolvedExecution)).toEqual([]);
			expect(f.submit).toHaveBeenCalledOnce();
			await f.engine().recoverExecutions(recovery);
			expect(engine.risk.usage().used).toBe(100);
		},
	);

	it("records stable order/list/leg IDs before adapter invocation, including exits without reservations", async () => {
		const f = fixture();
		const original = f.submitOco.getMockImplementation()!;
		f.submitOco.mockImplementationOnce(async (input) => {
			const record = f.engine().listExecutions()[0];
			expect(record).toMatchObject({ status: "submission-started", intent: { input } });
			expect(record.reservationId).toBeUndefined();
			expect(input.listClientOrderId).toMatch(/^tl/);
			expect(input.listClientOrderId).toHaveLength(32);
			expect(new Set([input.listClientOrderId, input.aboveClientOrderId, input.belowClientOrderId]).size).toBe(3);
			return original(input);
		});
		const engine = f.engine();
		const result = await engine.placeOco(await engine.prepareOcoOrder(ocoIntent));
		expect(result.executionId).toBe(engine.listExecutions()[0].id);
		expect(engine.risk.usage()).toMatchObject({ used: 0, reserved: 0 });
	});

	it("retains a reducing unknown and blocks entries independently of quota", async () => {
		const f = fixture();
		const engine = f.engine();
		f.submit.mockRejectedValueOnce(new Error("apiKey=PRIVATE secret=PRIVATE network timeout"));
		await expect(engine.placeOrder(await engine.prepareOrder("sell", orderIntent))).rejects.toThrow(/unknown/);
		expect(engine.risk.usage()).toMatchObject({ reserved: 0, used: 0 });
		await expect(engine.placeOrder(await engine.prepareOrder("buy", orderIntent))).rejects.toThrow(
			/unresolved executions/,
		);
		await engine.placeOrder(await engine.prepareOrder("sell", orderIntent));
		expect(JSON.stringify(f.state())).not.toContain("PRIVATE");
		expect(engine.getExecutionStatus().unresolved).toHaveLength(1);
	});

	it("does not abandon another process's active submission when lookup is missing", async () => {
		const f = fixture();
		const original = f.submit.getMockImplementation()!;
		let complete!: () => void;
		const gate = new Promise<void>((resolve) => {
			complete = resolve;
		});

		f.submit.mockImplementationOnce(async (input) => {
			await gate;
			return original(input);
		});
		const engine = f.engine();
		const pending = engine.placeOrder(await engine.prepareOrder("buy", orderIntent));
		await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce());
		expect((await f.engine().recoverExecutions(recovery)).unresolved).toBe(1);
		expect(engine.risk.usage().reserved).toBe(100);
		complete();
		await pending;
		expect(engine.risk.usage()).toMatchObject({ used: 100, reserved: 0 });
		expect(f.submit).toHaveBeenCalledOnce();
	});

	it("blocks entries across paper and live modes while preserving safe reducing orders", async () => {
		const f = fixture();
		const paper = f.engine();
		f.submit.mockRejectedValueOnce(new Error("unknown"));
		await expect(paper.placeOrder(await paper.prepareOrder("sell", orderIntent))).rejects.toThrow(/unknown/);
		const live = f.engine("live-account", { ...f.exchange, mode: "live" });
		expect(live.risk.check("BTC/USDT", 100)).toMatch(/unresolved executions/);
		expect(() => live.risk.reserve("BTC/USDT", 100)).toThrow(/unresolved executions/);
		await expect(
			live.placeOrder(await live.prepareOrder("buy", orderIntent), { allowUnconfirmedLive: true }),
		).rejects.toThrow(/unresolved executions/);
		await live.placeOrder(await live.prepareOrder("sell", orderIntent), { allowUnconfirmedLive: true });
		expect(f.submit).toHaveBeenCalledTimes(2);
	});

	it("holds a durable maintenance fence across recoverers and rejects stale release", async () => {
		const f = fixture();
		const engine = f.engine();
		const maintenance = engine.beginMaintenance("paper-reset");
		await f.engine().recoverExecutions(recovery);
		expect(f.engine().getExecutionStatus().maintenance?.id).toBe(maintenance.id);
		const other = f.engine();
		await expect(other.placeOrder(await other.prepareOrder("buy", orderIntent))).rejects.toThrow(/maintenance/);
		expect(() => f.engine().beginMaintenance("runtime-replacement")).toThrow(/already active/);
		expect(() => engine.completeMaintenance("stale")).toThrow(/changed/);
		engine.completeMaintenance(maintenance.id);
		expect(f.engine().getExecutionStatus().maintenance).toBeUndefined();
	});

	it("revokes a prepared sender atomically before releasing its never-sent claim", async () => {
		const f = fixture();
		const engine = f.engine();
		await expect(
			engine.placeOrder(await engine.prepareOrder("buy", orderIntent), {
				confirm: async () => {
					expect((await f.engine().recoverExecutions(recovery)).reconciled).toBe(1);
					return true;
				},
			}),
		).rejects.toThrow();
		expect(f.submit).not.toHaveBeenCalled();
		expect(engine.risk.usage()).toMatchObject({ used: 0, reserved: 0 });
	});

	it("only releases definite rejection, never an arbitrary adapter error", async () => {
		const f = fixture();
		const engine = f.engine();
		f.submit.mockRejectedValueOnce(new SubmissionRejectedError("Rejected"));
		await expect(engine.placeOrder(await engine.prepareOrder("buy", orderIntent))).rejects.toThrow("Rejected");
		expect(engine.risk.usage().reserved).toBe(0);
		f.submit.mockRejectedValueOnce(new Error("internal adapter failure"));
		await expect(engine.placeOrder(await engine.prepareOrder("buy", orderIntent))).rejects.toThrow(/unknown/);
		expect(engine.risk.usage().reserved).toBe(100);
		const claim = engine.risk.listPendingReservations()[0];
		expect(() => engine.risk.reconcileReservation(claim.id, "release")).toThrow(/atomically through \/recovery/);
	});

	it.each([
		{ status: "open" as const, filled: 0.4, remaining: 0.6, cost: 40, used: 100 },
		{ status: "canceled" as const, filled: 0.4, remaining: 0.6, cost: 40, used: 40 },
		{ status: "canceled" as const, filled: 0, remaining: 1, cost: 0, used: 0 },
	])("reconciles $status partial/zero fills conservatively", async (observation) => {
		const f = fixture();
		const engine = f.engine();
		f.fail(3);
		await expect(engine.placeOrder(await engine.prepareOrder("buy", orderIntent))).rejects.toThrow();
		const order = [...f.orders.values()][0];
		Object.assign(order, observation);
		expect((await f.engine().recoverExecutions(recovery)).reconciled).toBe(1);
		expect(engine.risk.usage()).toMatchObject({ used: observation.used, reserved: 0 });
	});

	it.each([
		"wrong-id",
		"wrong-symbol",
		"zero-fill-cost",
		"overfill",
		"unknown-status",
		"closed-zero-fill",
		"closed-partial",
	] as const)("retains conflicting %s evidence", async (conflict) => {
		const f = fixture();
		const engine = f.engine();
		f.fail(3);
		await expect(engine.placeOrder(await engine.prepareOrder("buy", orderIntent))).rejects.toThrow();
		const order = [...f.orders.values()][0];
		if (conflict === "wrong-id") order.clientOrderId = "other-id";
		if (conflict === "wrong-symbol") order.symbol = "ETH/USDT";
		if (conflict === "zero-fill-cost") order.cost = 0;
		if (conflict === "overfill") order.filled = 2;
		if (conflict === "unknown-status") order.status = "unknown";
		if (conflict === "closed-zero-fill") Object.assign(order, { filled: 0, remaining: 1, cost: 0 });
		if (conflict === "closed-partial") Object.assign(order, { filled: 0.4, remaining: 0.6, cost: 40 });
		expect((await f.engine().recoverExecutions(recovery)).issues).toContainEqual(
			expect.objectContaining({ issue: "evidence-conflict" }),
		);
		expect(engine.risk.usage().reserved).toBe(100);
	});

	it.each(["paper", "live"] as const)(
		"submits a truncated $mode spot amount so the fill matches the plan",
		async (mode) => {
			const f = fixture();
			const engine = f.engine(mode === "live" ? "live-account" : "fixture-account", { ...f.exchange, mode });
			const policy = mode === "live" ? { allowUnconfirmedLive: true } : {};
			const requested = 25 / 108_234.56;
			const plan = await engine.prepareOrder("buy", { symbol: "BTC/USDT", type: "market", amount: requested });
			expect(plan.input.amount).toBe(0.0002);
			const result = await engine.placeOrder(plan, policy);
			expect(result.order.amount).toBe(0.0002);
			expect(engine.listExecutions()).toEqual([
				expect.objectContaining({
					status: "acknowledged",
					intent: expect.objectContaining({ input: expect.objectContaining({ amount: 0.0002 }) }),
				}),
			]);
			expect(engine.risk.usage()).toMatchObject({ reserved: 0 });
			expect(engine.listExecutions().filter(isUnresolvedExecution)).toEqual([]);
		},
	);

	it.each(["paper", "live"] as const)(
		"recovers a truncated $mode fill after settlement persistence fails",
		async (mode) => {
			const f = fixture();
			const engine = f.engine(mode === "live" ? "live-account" : "fixture-account", { ...f.exchange, mode });
			const policy = mode === "live" ? { allowUnconfirmedLive: true } : {};
			f.fail(3);
			await expect(
				engine.placeOrder(
					await engine.prepareOrder("buy", { symbol: "BTC/USDT", type: "market", amount: 25 / 108_234.56 }),
					policy,
				),
			).rejects.toThrow();
			expect(engine.listExecutions()[0]).toMatchObject({ status: "submission-started" });
			const restarted = f.engine(mode === "live" ? "live-account" : "fixture-account", { ...f.exchange, mode });
			expect((await restarted.recoverExecutions(recovery)).issues).toEqual([]);
			expect(engine.listExecutions().filter(isUnresolvedExecution)).toEqual([]);
			expect(f.submit).toHaveBeenCalledOnce();
		},
	);

	it.each(["complete", "missing-leg", "duplicate-leg", "wrong-list", "excess-fills"] as const)(
		"validates OCO %s evidence",
		async (condition) => {
			const f = fixture();
			const engine = f.engine();
			f.fail(3);
			await expect(
				engine.placeOco(
					await engine.prepareOcoOrder({ ...ocoIntent, side: "buy", stopLossPrice: 110, takeProfitPrice: 90 }),
				),
			).rejects.toThrow();
			const legs = [...f.lists.values()][0];
			Object.assign(legs[0], { status: "closed", filled: 1, remaining: 0, cost: 90 });
			Object.assign(legs[1], { status: "canceled" });
			if (condition === "missing-leg") legs.pop();
			if (condition === "duplicate-leg") legs[1] = { ...legs[0] };
			if (condition === "wrong-list") legs[1].listClientOrderId = "different";
			if (condition === "excess-fills")
				Object.assign(legs[1], { status: "closed", filled: 1, remaining: 0, cost: 110 });
			const report = await f.engine().recoverExecutions(recovery);
			expect(report.unresolved).toBe(condition === "complete" ? 0 : 1);
			expect(engine.risk.usage()).toMatchObject(
				condition === "complete" ? { used: 90, reserved: 0 } : { used: 0, reserved: 110 },
			);
			expect(f.submitOco).toHaveBeenCalledOnce();
		},
	);

	it("bounds failed reads across restarts, never interpreting repeated not-found as rejection", async () => {
		const f = fixture();
		const engine = f.engine();
		f.submit.mockRejectedValueOnce(new Error("connection lost"));
		await expect(engine.placeOrder(await engine.prepareOrder("buy", orderIntent))).rejects.toThrow();
		for (let run = 0; run < 5; run++) await f.engine().recoverExecutions(recovery);
		expect(f.lookup).toHaveBeenCalledTimes(9);
		expect(engine.listExecutions()[0]).toMatchObject({ attempts: 9, status: "unknown" });
		expect(engine.risk.usage().reserved).toBe(100);
	});

	it("bounds hanging reads and preserves uncertainty", async () => {
		const f = fixture();
		const engine = f.engine();
		f.submit.mockRejectedValueOnce(new Error("connection lost"));
		await expect(engine.placeOrder(await engine.prepareOrder("buy", orderIntent))).rejects.toThrow();
		f.lookup.mockImplementation(async () => new Promise<Order>(() => {}));
		expect(
			(await f.engine().recoverExecutions({ ...recovery, attemptsPerRecord: 1, lookupTimeoutMs: 5 })).unresolved,
		).toBe(1);
	});

	it("does not query a different original account or experimental lookup", async () => {
		const f = fixture();
		const exchange = { ...f.exchange, mode: "live" as const, id: "okx" };
		const engine = f.engine("account-original", exchange);
		f.submit.mockRejectedValueOnce(new Error("missing credentials"));
		await expect(
			engine.placeOrder(await engine.prepareOrder("buy", orderIntent), { allowUnconfirmedLive: true }),
		).rejects.toThrow();
		expect((await f.engine("account-new", exchange).recoverExecutions(recovery)).issues[0].issue).toBe(
			"account-mismatch",
		);
		expect((await f.engine("account-original", exchange).recoverExecutions(recovery)).issues[0].issue).toBe(
			"lookup-unsupported",
		);
		expect(f.lookup).not.toHaveBeenCalled();
	});

	it("manual resolution requires original scope, stale-proof revision and explicit terminal evidence", async () => {
		const f = fixture();
		const engine = f.engine();
		f.submit.mockRejectedValueOnce(new Error("unknown"));
		await expect(engine.placeOrder(await engine.prepareOrder("buy", orderIntent))).rejects.toThrow();
		const entry = engine.listExecutions()[0];
		const resolution = {
			executionId: entry.id,
			expectedRevision: entry.revision,
			accountId: entry.scope.accountId,
			outcome: "release" as const,
			notional: 0,
			evidenceReference: "ticket-123",
			verifiedTerminal: true,
		};
		for (const patch of [
			{ accountId: "other" },
			{ expectedRevision: -1 },
			{ evidenceReference: "apiKey=secret" },
			{ verifiedTerminal: false },
			{ notional: 10 },
		])
			expect(() => engine.resolveExecution({ ...resolution, ...patch })).toThrow();
		engine.resolveExecution(resolution);
		expect(() => engine.resolveExecution(resolution)).toThrow(/already resolved/);
		expect(engine.risk.usage()).toMatchObject({ used: 0, reserved: 0 });
		expect(engine.listExecutions()[0].evidence).toMatchObject({ source: "operator", reference: "ticket-123" });
	});

	it("fails closed on lost correlation or unknown secret-bearing journal fields", async () => {
		const f = fixture();
		const engine = f.engine();
		f.submit.mockRejectedValueOnce(new Error("unknown"));
		await expect(engine.placeOrder(await engine.prepareOrder("buy", orderIntent))).rejects.toThrow();
		const good = structuredClone(f.state());
		for (const corrupt of [
			() => {
				f.state().paper.reservations = {};
				f.state().paper.reservedDailyNotional = 0;
			},
			() => Object.assign(f.state().executions!.records[0].intent.input, { apiKey: "NEVER" }),
			() => {
				f.state().paper.executionBlocks = {};
			},
		]) {
			f.store.save(good);
			corrupt();
			expect(() => f.engine()).toThrow();
			await expect(engine.recoverExecutions(recovery)).rejects.toThrow();
		}
	});

	it("bounds terminal and audit history without removing unresolved executions", async () => {
		const f = fixture();
		const engine = f.engine();
		f.submit.mockRejectedValueOnce(new Error("unknown"));
		await expect(engine.placeOrder(await engine.prepareOrder("sell", orderIntent))).rejects.toThrow();
		const unresolvedId = engine.listExecutions()[0].id;
		const journal = new ExecutionJournal(f.store, config, {
			accountId: "fixture-account",
			exchange: "binance",
			mode: "paper",
			marketType: "spot",
			quoteCurrency: "USDT",
			positionMode: "one-way",
		});
		for (let i = 0; i < 205; i++) {
			const entry = journal.prepare(
				{ kind: "order", input: { ...orderIntent, side: "sell", clientOrderId: `history-${i}` } },
				100,
				false,
			);
			journal.settle(entry.id, "release", 0, "definite-rejection");
		}
		expect(engine.listExecutions()).toHaveLength(201);
		expect(engine.getExecutionStatus().unresolved.map((entry) => entry.id)).toEqual([unresolvedId]);
		expect(engine.listAuditEvents().length).toBeLessThanOrEqual(500);
		const unresolved = engine.listExecutions().find((entry) => entry.id === unresolvedId)!;
		engine.resolveExecution({
			executionId: unresolvedId,
			expectedRevision: unresolved.revision,
			accountId: unresolved.scope.accountId,
			outcome: "commit",
			notional: 25,
			evidenceReference: "verified-oldest-fill",
			verifiedTerminal: true,
		});
		expect(engine.listExecutions()).toHaveLength(200);
		expect(engine.listExecutions().at(-1)).toMatchObject({
			id: unresolvedId,
			settlement: { outcome: "commit", notional: 25 },
			evidence: { source: "operator", reference: "verified-oldest-fill" },
		});
		expect(engine.listAuditEvents().at(-1)).toMatchObject({
			executionId: unresolvedId,
			action: "reconciled",
			evidenceReference: "verified-oldest-fill",
			settlement: { outcome: "commit", notional: 25 },
		});
	});

	it("invalidates independent engines only on durable maintenance completion", async () => {
		const f = fixture();
		const owner = f.engine();
		const old = f.engine();
		const plan = await old.prepareOrder("buy", orderIntent);
		const maintenance = owner.beginMaintenance("paper-reset");
		const during = f.engine();
		const duringPlan = await during.prepareOrder("buy", orderIntent);
		expect(maintenance.nextGeneration).toBe(1);
		expect(f.state().executions?.admissionGeneration ?? 0).toBe(0);
		owner.completeMaintenance(maintenance.id);
		expect(old.getExecutionStatus()).toMatchObject({ configured: true, staleRuntime: true });
		expect(old.getExecutionStatus().admission).toEqual({ generation: 0, currentGeneration: 1, stale: true });
		await expect(old.placeOrder(plan)).rejects.toThrow(/admission generation/);
		await expect(during.placeOrder(duringPlan)).rejects.toThrow(/admission generation/);
		expect(() => old.beginMaintenance("runtime-replacement")).toThrow(/admission generation/);
		const fresh = f.engine();
		await fresh.placeOrder(await fresh.prepareOrder("buy", orderIntent));
		expect(f.submit).toHaveBeenCalledOnce();
		expect(fresh.getExecutionScope()).toEqual(old.getExecutionScope());
		expect(old.listExecutions()).toHaveLength(1);
		expect(fresh.getExecutionStatus()).toMatchObject({ configured: true, staleRuntime: false });
	});

	it("checks both the captured and recorded admission generation atomically at begin", () => {
		const f = fixture();
		const scope = f.engine().getExecutionScope();
		const journal = new ExecutionJournal(f.store, config, scope, undefined, 0);
		const entry = journal.prepare(
			{ kind: "order", input: { ...orderIntent, side: "buy", clientOrderId: "generation-test" } },
			100,
			true,
		);
		f.store.transact((draft) => {
			draft.executions!.admissionGeneration = 1;
		});
		expect(() => journal.begin(entry.id)).toThrow(/admission generation/);
		const fresh = new ExecutionJournal(f.store, config, scope, undefined, 1);
		expect(() => fresh.begin(entry.id)).toThrow(/admission generation/);
		expect(f.state().executions?.records[0].status).toBe("prepared");
	});

	it("only lets the original owner cancel a read-only inspection without advancing admission", () => {
		const f = fixture();
		const owner = f.engine();
		const foreign = f.engine();
		const maintenance = owner.beginMaintenance("runtime-replacement");
		expect(() => foreign.cancelMaintenance(maintenance.id)).toThrow(/owner/);
		expect(() => foreign.completeMaintenance(maintenance.id)).toThrow(/owner/);
		owner.cancelMaintenance(maintenance.id);
		expect(owner.getExecutionStatus()).toMatchObject({
			maintenance: undefined,
			admission: { stale: false, generation: 0, currentGeneration: 0 },
		});
		expect(owner.listAuditEvents().at(-1)?.action).toBe("runtime-replacement-cancelled");
	});

	it.each(["before", "draft", "committed"] as const)(
		"keeps stale admissions blocked after a %s completion failure",
		async (boundary) => {
			const f = fixture();
			const owner = f.engine();
			const stale = f.engine();
			const plan = await stale.prepareOrder("buy", orderIntent);
			const maintenance = owner.beginMaintenance("paper-reset");
			f.fail(1, boundary);
			expect(() => owner.completeMaintenance(maintenance.id)).toThrow(/storage failed/);
			await expect(stale.placeOrder(plan)).rejects.toThrow(/maintenance|admission generation/);
			expect(f.submit).not.toHaveBeenCalled();
			expect(stale.getExecutionStatus().admission.currentGeneration).toBe(boundary === "committed" ? 1 : 0);
		},
	);

	it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid admission generation %s", (generation) => {
		const f = fixture();
		f.store.transact((draft) => {
			draft.executions = { version: 1, records: [], admissionGeneration: generation };
		});
		expect(() => f.engine()).toThrow();
	});

	it.each(["order", "oco"] as const)(
		"persists %s references before send and clones caller metadata before waits",
		async (kind) => {
			const f = fixture();
			const engine = f.engine();
			const reference = { kind: "trade-plan", id: "plan-1", version: 1 };
			const confirm = async () => {
				reference.version = 9;
				return true;
			};
			if (kind === "order") {
				const original = f.submit.getMockImplementation()!;
				f.submit.mockImplementationOnce(async (input) => {
					expect(engine.listExecutions()[0]).toMatchObject({
						status: "submission-started",
						intentId: "intent-1",
						reference: { kind: "trade-plan", id: "plan-1", version: 1 },
					});
					return original(input);
				});
				await engine.placeOrder(await engine.prepareOrder("buy", orderIntent), {
					intentId: "intent-1",
					reference,
					confirm,
				});
			} else
				await engine.placeOco(await engine.prepareOcoOrder(ocoIntent), {
					intentId: "intent-1",
					reference,
					confirm,
				});
			expect(engine.listExecutions()[0].reference?.version).toBe(1);
			expect(() => engine.acknowledgeExecutionArchive(engine.listExecutions()[0].id, 0)).toThrow(/revision/);
			const record = engine.listExecutions()[0];
			engine.acknowledgeExecutionArchive(record.id, record.revision);
			expect(engine.listExecutions()[0].archiveAcknowledgedRevision).toBe(record.revision);
		},
	);

	it("rejects stale reference checks without sending or retaining a quota claim", async () => {
		const f = fixture();
		const engine = f.engine();
		await expect(
			engine.placeOrder(await engine.prepareOrder("buy", orderIntent), {
				intentId: "stale-reference",
				reference: { kind: "trade-plan", id: "plan", version: 1 },
				validateReference: () => {
					throw new Error("Plan was archived");
				},
			}),
		).rejects.toThrow(/archived/);
		expect(f.submit).not.toHaveBeenCalled();
		expect(engine.risk.usage()).toMatchObject({ used: 0, reserved: 0 });
		expect(engine.listExecutions()[0]).toMatchObject({ status: "definite-rejection", reference: { id: "plan" } });
	});

	it("reuses a stable intentId after confirmation cancel or a pre-submission reference failure", async () => {
		const f = fixture();
		const engine = f.engine();
		const reference = { kind: "trade-plan", id: "plan", version: 1 };
		await expect(
			engine.placeOrder(await engine.prepareOrder("buy", orderIntent), {
				intentId: "retry-me",
				confirm: async () => false,
			}),
		).rejects.toThrow(/cancelled/);
		expect(f.submit).not.toHaveBeenCalled();
		await expect(
			engine.placeOrder(await engine.prepareOrder("sell", orderIntent), { intentId: "retry-me" }),
		).rejects.toThrow(/different parameters/);
		const first = await engine.placeOrder(await engine.prepareOrder("buy", orderIntent), { intentId: "retry-me" });
		expect(f.submit).toHaveBeenCalledOnce();
		expect(engine.findExecutionIntent("retry-me")).toBe(first.executionId);

		let allowed = false;
		await expect(
			engine.placeOrder(await engine.prepareOrder("buy", orderIntent), {
				intentId: "stale-then-retry",
				reference,
				validateReference: () => {
					if (!allowed) throw new Error("Plan was archived");
				},
			}),
		).rejects.toThrow(/archived/);
		allowed = true;
		const retried = await engine.placeOrder(await engine.prepareOrder("buy", orderIntent), {
			intentId: "stale-then-retry",
			reference,
			validateReference: () => {},
		});
		expect(f.submit).toHaveBeenCalledTimes(2);
		expect(engine.findExecutionIntent("stale-then-retry")).toBe(retried.executionId);
	});

	it("reuses a stable intentId after a definite exchange rejection", async () => {
		const f = fixture();
		const engine = f.engine();
		f.submit.mockRejectedValueOnce(new SubmissionRejectedError("Rejected"));
		await expect(
			engine.placeOrder(await engine.prepareOrder("buy", orderIntent), { intentId: "rejected-then-retry" }),
		).rejects.toThrow("Rejected");
		const retried = await engine.placeOrder(await engine.prepareOrder("buy", orderIntent), {
			intentId: "rejected-then-retry",
		});
		expect(f.submit).toHaveBeenCalledTimes(2);
		expect(engine.findExecutionIntent("rejected-then-retry")).toBe(retried.executionId);
	});

	it("retains linked execution evidence beyond ordinary history until the exact revision is archived", async () => {
		const f = fixture();
		const engine = f.engine();
		const result = await engine.placeOrder(await engine.prepareOrder("buy", orderIntent), {
			intentId: "first-entry",
			reference: { kind: "trade-plan", id: "plan", version: 1 },
		});
		for (let i = 0; i < 205; i++) await engine.placeOrder(await engine.prepareOrder("sell", orderIntent));
		const retained = engine.listExecutions().find((record) => record.id === result.executionId)!;
		expect(retained).toBeDefined();
		expect(engine.listExecutions()).toHaveLength(201);
		engine.acknowledgeExecutionArchive(retained.id, retained.revision);
		expect(engine.listExecutions()).toHaveLength(200);
		await expect(
			f.engine().placeOrder(await engine.prepareOrder("buy", orderIntent), { intentId: "first-entry" }),
		).rejects.toThrow();
		expect(engine.findExecutionIntent("first-entry")).toBe(result.executionId);
	});

	it("retains archived open orders and refreshes fills read-only without changing quota settlement", async () => {
		const f = fixture();
		const engine = f.engine();
		const result = await engine.placeOco(await engine.prepareOcoOrder(ocoIntent), {
			intentId: "exit-oco",
			reference: { kind: "trade-plan", id: "plan", version: 1 },
		});
		const first = engine.listExecutions()[0];
		engine.acknowledgeExecutionArchive(first.id, first.revision);
		for (let i = 0; i < 201; i++) await engine.placeOrder(await engine.prepareOrder("sell", orderIntent));
		expect(engine.listExecutions().some((record) => record.id === result.executionId)).toBe(true);
		const legs = [...f.lists.values()][0];
		Object.assign(legs[0], { status: "closed", filled: 1, remaining: 0, cost: 110 });
		Object.assign(legs[1], { status: "canceled" });
		const usage = engine.risk.usage();
		await engine.refreshExecutionEvidence(first.id);
		const refreshed = engine.listExecutions().find((record) => record.id === first.id)!;
		expect(refreshed).toMatchObject({ status: "reconciled", revision: first.revision + 1 });
		expect(refreshed.evidence?.fee).toBeUndefined();
		expect(engine.risk.usage()).toEqual(usage);
		expect(f.submitOco).toHaveBeenCalledOnce();
		expect(() => engine.acknowledgeExecutionArchive(first.id, first.revision)).toThrow(/revision/);
		engine.acknowledgeExecutionArchive(refreshed.id, refreshed.revision);
	});

	it("reserves archive capacity for acknowledged pending records so settlement remains possible", () => {
		const f = fixture();
		const journal = new ExecutionJournal(f.store, config, f.engine().getExecutionScope());
		const intent = {
			kind: "order" as const,
			input: { ...orderIntent, side: "sell" as const, clientOrderId: "capacity" },
		};
		const first = journal.prepare(intent, 100, false, {
			intentId: "first",
			reference: { kind: "trade-plan", id: "plan", version: 1 },
		});
		journal.settle(first.id, "release", 0, "definite-rejection");
		f.store.transact((state) => {
			const template = state.executions!.records[0];
			state.executions!.records = Array.from({ length: 999 }, (_, index) => ({
				...structuredClone(template),
				id: `record-${index}`,
			}));
		});
		const pending = journal.prepare(intent, 100, false, {
			intentId: "last",
			reference: { kind: "trade-plan", id: "plan", version: 1 },
		});
		journal.acknowledgeExecutionArchive(pending.id, pending.revision);
		expect(() =>
			journal.prepare(intent, 100, false, {
				intentId: "overflow",
				reference: { kind: "trade-plan", id: "plan", version: 1 },
			}),
		).toThrow(/capacity/);
		expect(journal.settle(pending.id, "release", 0, "definite-rejection")).toBe(true);
		validateExecutionRiskState(f.state());
	});

	it.each([
		{
			status: "open" as const,
			filled: 0.4,
			remaining: 0.6,
			cost: 40,
			completeness: "complete" as const,
			fee: undefined,
		},
		{
			status: "canceled" as const,
			filled: 0.4,
			remaining: 0.6,
			cost: 40,
			completeness: "complete" as const,
			fee: 0.1,
		},
		{
			status: "closed" as const,
			filled: 1,
			remaining: 0,
			cost: 100,
			completeness: "partial" as const,
			fee: undefined,
		},
		{ status: "closed" as const, filled: 1, remaining: 0, cost: 100, completeness: "complete" as const, fee: 0.1 },
	])("persists $status $completeness fee observations through recovery", async (observation) => {
		const f = fixture();
		const engine = f.engine();
		f.fail(3);
		await expect(engine.placeOrder(await engine.prepareOrder("buy", orderIntent))).rejects.toThrow();
		const order = [...f.orders.values()][0];
		const feeObservation: OrderFeeObservation = {
			source: "paper-ledger",
			completeness: observation.completeness,
			charges: [{ currency: "USDT", cost: 0.1 }],
		};
		Object.assign(order, observation, { feeObservation });
		expect((await f.engine().recoverExecutions(recovery)).reconciled).toBe(1);
		const evidence = f.engine().listExecutions()[0].evidence;
		expect(evidence?.orders[0].feeObservation).toEqual(feeObservation);
		expect(evidence?.fee).toBe(observation.fee);
		expect(f.submit).toHaveBeenCalledOnce();
	});

	it.each(["missing", "legacy", "unknown-source", "wrong-mode", "foreign", "base", "zero", "rebate"] as const)(
		"only trusts explicitly observed terminal quote fees, not %s guesses",
		async (condition) => {
			const f = fixture();
			const original = f.submit.getMockImplementation()!;
			f.submit.mockImplementationOnce(async (input) => {
				const result = await original(input);
				const fee = condition === "zero" ? 0 : condition === "rebate" ? -0.1 : 0.1;
				const currency = condition === "foreign" ? "BNB" : condition === "base" ? "BTC" : "USDT";
				if (condition !== "missing" && condition !== "legacy")
					Object.assign(result.order, {
						feeObservation: {
							source:
								condition === "unknown-source"
									? "estimate"
									: condition === "wrong-mode"
										? "exchange"
										: "paper-ledger",
							completeness: "complete",
							charges: [{ currency, cost: fee }],
						},
					});
				return { ...result, fee: condition === "legacy" ? 99 : fee };
			});
			const engine = f.engine();
			await engine.placeOrder(await engine.prepareOrder("buy", orderIntent));
			const evidence = f.engine().listExecutions()[0].evidence;
			expect(evidence?.fee).toBe(condition === "zero" ? 0 : condition === "rebate" ? -0.1 : undefined);
			if (condition === "base" || condition === "foreign")
				expect(evidence?.orders[0].feeObservation?.charges[0].currency).toBe(condition === "base" ? "BTC" : "BNB");
			if (["missing", "legacy", "unknown-source", "wrong-mode"].includes(condition))
				expect(evidence?.orders[0].feeObservation).toBeUndefined();
		},
	);

	it.each(["complete", "missing-canceled-leg", "foreign", "still-open"] as const)(
		"refreshes %s OCO fees per leg without double counting or quota refunds",
		async (condition) => {
			const f = fixture();
			const engine = f.engine();
			await engine.placeOco(
				await engine.prepareOcoOrder({ ...ocoIntent, side: "buy", stopLossPrice: 110, takeProfitPrice: 90 }),
				{ intentId: "fee-oco", reference: { kind: "trade-plan", id: "plan", version: 1 } },
			);
			const before = engine.listExecutions()[0];
			engine.acknowledgeExecutionArchive(before.id, before.revision);
			const legs = [...f.lists.values()][0];
			Object.assign(legs[0], {
				status: "closed",
				filled: 1,
				remaining: 0,
				cost: 90,
				feeObservation: {
					source: "paper-ledger",
					completeness: "complete",
					charges: [{ currency: condition === "foreign" ? "BNB" : "USDT", cost: 0.09 }],
				},
			});
			Object.assign(legs[1], {
				status: condition === "still-open" ? "open" : "canceled",
				...(condition === "missing-canceled-leg"
					? {}
					: {
							feeObservation: {
								source: "paper-ledger",
								completeness: "complete",
								charges: [{ currency: "USDT", cost: 0 }],
							},
						}),
			});
			const usage = engine.risk.usage();
			await f.engine().refreshExecutionEvidence(before.id);
			const after = engine.listExecutions()[0];
			expect(after.evidence?.fee).toBe(condition === "complete" ? 0.09 : undefined);
			expect(after.evidence?.orders[0].feeObservation?.charges).toHaveLength(1);
			expect(after.archiveAcknowledgedRevision).toBe(before.revision);
			expect(after.revision).toBe(before.revision + 1);
			expect(engine.risk.usage()).toEqual(usage);
			expect(f.submitOco).toHaveBeenCalledOnce();
			expect(f.submit).not.toHaveBeenCalled();
			expect(() => engine.acknowledgeExecutionArchive(before.id, before.revision)).toThrow(/revision/);
		},
	);

	it("refreshes late terminal fees and preserves them through JSON persistence and archival", async () => {
		const f = fixture();
		const engine = f.engine();
		await engine.placeOrder(await engine.prepareOrder("buy", orderIntent), {
			intentId: "late-fee",
			reference: { kind: "trade-plan", id: "plan", version: 1 },
		});
		const before = engine.listExecutions()[0];
		engine.acknowledgeExecutionArchive(before.id, before.revision);
		[...f.orders.values()][0].feeObservation = {
			source: "paper-ledger",
			completeness: "complete",
			charges: [{ currency: "USDT", cost: 0 }],
		};
		const usage = engine.risk.usage();
		await f.engine().refreshExecutionEvidence(before.id);
		f.store.save(JSON.parse(JSON.stringify(f.state())) as ExecutionRiskState);
		expect(f.engine().listExecutions()[0].evidence?.fee).toBe(0);
		expect(f.engine().listExecutions()[0].evidence?.orders[0].feeObservation?.source).toBe("paper-ledger");
		expect(engine.risk.usage()).toEqual(usage);
		await engine.refreshExecutionEvidence(before.id);
		expect(f.lookup).toHaveBeenCalledOnce();
		expect(f.submit).toHaveBeenCalledOnce();
		for (let i = 0; i < 201; i++) await engine.placeOrder(await engine.prepareOrder("sell", orderIntent));
		const retained = engine.listExecutions().find((record) => record.id === before.id)!;
		expect(retained.evidence?.fee).toBe(0);
		engine.acknowledgeExecutionArchive(retained.id, retained.revision);
		expect(engine.listExecutions().some((record) => record.id === retained.id)).toBe(false);
	});

	it("retains prior observations on sparse refresh but never calls old partial fees complete after new fills", async () => {
		const f = fixture();
		const original = f.submit.getMockImplementation()!;
		f.submit.mockImplementationOnce(async (input) => {
			const result = await original(input);
			Object.assign(result.order, {
				status: "open",
				filled: 0.4,
				remaining: 0.6,
				cost: 40,
				feeObservation: {
					source: "paper-ledger",
					completeness: "complete",
					charges: [{ currency: "USDT", cost: 0.04 }],
				},
			});
			return result;
		});
		const engine = f.engine();
		await engine.placeOrder(await engine.prepareOrder("buy", orderIntent));
		const before = engine.listExecutions()[0];
		const order = [...f.orders.values()][0];
		delete order.feeObservation;
		await engine.refreshExecutionEvidence(before.id);
		expect(engine.listExecutions()[0].evidence?.orders[0].feeObservation?.completeness).toBe("complete");
		Object.assign(order, { status: "closed", filled: 1, remaining: 0, cost: 100 });
		await engine.refreshExecutionEvidence(before.id);
		const after = engine.listExecutions()[0];
		expect(after.evidence?.orders[0].feeObservation).toMatchObject({
			completeness: "partial",
			charges: [{ currency: "USDT", cost: 0.04 }],
		});
		expect(after.evidence?.fee).toBeUndefined();
		const usage = engine.risk.usage();
		Object.assign(order, { status: "open", filled: 0.4, remaining: 0.6, cost: 40 });
		await expect(engine.refreshExecutionEvidence(before.id)).rejects.toThrow(/regressed/);
		expect(engine.listExecutions()[0]).toEqual(after);
		expect(engine.risk.usage()).toEqual(usage);
	});

	it("reads old saved numeric fees but rejects malformed new observation provenance", async () => {
		const f = fixture();
		const engine = f.engine();
		await engine.placeOrder(await engine.prepareOrder("buy", orderIntent));
		const legacy = structuredClone(f.state());
		legacy.executions!.records[0].evidence!.fee = 0.1;
		f.store.save(legacy);
		expect(f.engine().listExecutions()[0].evidence?.fee).toBe(0.1);
		expect(observedExecutionFee(f.engine().listExecutions()[0])).toBeUndefined();
		for (const feeObservation of [
			{ source: "unknown", completeness: "complete", charges: [{ currency: "USDT", cost: 1 }] },
			{ source: "paper-ledger", completeness: "complete", charges: [] },
			{ source: "paper-ledger", completeness: "complete", charges: [{ currency: "USDT", cost: null }] },
			{
				source: "paper-ledger",
				completeness: "complete",
				charges: [{ currency: "USDT", cost: 1, secret: "blocked" }],
			},
		]) {
			const draft = structuredClone(legacy);
			Object.assign(draft.executions!.records[0].evidence!.orders[0], { feeObservation });
			f.store.save(draft);
			expect(() => f.engine()).toThrow(/Invalid execution journal/);
		}
	});

	it.each(["submission", "recovery", "refresh"] as const)(
		"persists optional actual parameters from %s, never the requested intent",
		async (phase) => {
			const f = fixture();
			const engine = f.engine();
			const actual = {
				type: "trailing_stop_market" as const,
				price: 99,
				stopPrice: 91,
				reduceOnly: false,
				positionSide: "BOTH" as const,
				closePosition: false,
				trailingPercent: 0.5,
				activationPrice: 105,
				callbackRate: 0.5,
				feeObservation: {
					source: "paper-ledger" as const,
					completeness: "complete" as const,
					charges: [{ currency: "USDT", cost: 0.1 }],
				},
			};
			if (phase === "submission") {
				const original = f.submit.getMockImplementation()!;
				f.submit.mockImplementationOnce(async (input) => {
					const result = await original(input);
					Object.assign(result.order, actual);
					return result;
				});
			}
			if (phase === "recovery") f.fail(3);
			const submitted = engine.placeOrder(await engine.prepareOrder("buy", orderIntent));
			if (phase === "recovery") await expect(submitted).rejects.toThrow();
			else await submitted;
			if (phase !== "submission") {
				Object.assign([...f.orders.values()][0], actual);
				if (phase === "recovery") expect((await f.engine().recoverExecutions(recovery)).reconciled).toBe(1);
				else await f.engine().refreshExecutionEvidence(engine.listExecutions()[0].id);
			}
			f.store.save(JSON.parse(JSON.stringify(f.state())) as ExecutionRiskState);
			const record = f.engine().listExecutions()[0];
			expect(record.evidence?.orders[0]).toMatchObject(actual);
			expect(record.evidence?.fee).toBe(0.1);
			expect(record.intent.input).toMatchObject({ type: "market" });
			expect(f.submit).toHaveBeenCalledOnce();
		},
	);

	it("keeps missing actual parameters absent in new evidence and legacy saved snapshots", async () => {
		const f = fixture();
		const engine = f.engine();
		const original = f.submit.getMockImplementation()!;
		f.submit.mockImplementationOnce(async (input) => {
			const result = await original(input);
			Object.assign(result.order, { type: undefined, price: undefined });
			return result;
		});
		await engine.placeOrder(await engine.prepareOrder("buy", { ...orderIntent, type: "limit", price: 100 }));
		f.store.save(JSON.parse(JSON.stringify(f.state())) as ExecutionRiskState);
		const record = f.engine().listExecutions()[0];
		for (const key of [
			"type",
			"price",
			"stopPrice",
			"reduceOnly",
			"positionSide",
			"closePosition",
			"trailingPercent",
			"activationPrice",
			"callbackRate",
		] as const)
			expect(Object.hasOwn(record.evidence!.orders[0], key)).toBe(false);
		expect(record.intent.input).toMatchObject({ type: "limit", price: 100 });
	});

	it.each([
		{ type: "unsupported" },
		{ price: 0 },
		{ stopPrice: -1 },
		{ reduceOnly: "false" },
		{ closePosition: 0 },
		{ positionSide: "UNKNOWN" },
		{ activationPrice: null },
		{ callbackRate: "0.5" },
		{ trailingPercent: Number.POSITIVE_INFINITY },
	])("rejects malformed saved actual parameters: %s", async (patch) => {
		const f = fixture();
		const engine = f.engine();
		await engine.placeOrder(await engine.prepareOrder("buy", orderIntent));
		Object.assign(f.state().executions!.records[0].evidence!.orders[0], patch);
		expect(() => f.engine()).toThrow(/Invalid execution journal/);
	});

	it.each(["order", "oco"] as const)(
		"does not spend archive revisions on 1001 unchanged %s polling receipts",
		async (kind) => {
			vi.useFakeTimers({ toFake: ["Date"] });
			try {
				const start = Date.parse("2026-09-15T00:00:00.000Z");
				vi.setSystemTime(start);
				const f = fixture();
				const engine = f.engine();
				if (kind === "order") {
					const original = f.submit.getMockImplementation()!;
					f.submit.mockImplementationOnce(async (input) => {
						const result = await original(input);
						Object.assign(result.order, { status: "open", filled: 0, remaining: 1, cost: 0 });
						return result;
					});
					await engine.placeOrder(
						await engine.prepareOrder("buy", { ...orderIntent, type: "limit", price: 100 }),
						{ intentId: "polled-order", reference: { kind: "trade-plan", id: "plan", version: 1 } },
					);
				} else
					await engine.placeOco(await engine.prepareOcoOrder(ocoIntent), {
						intentId: "polled-oco",
						reference: { kind: "trade-plan", id: "plan", version: 1 },
					});
				const initial = engine.listExecutions()[0];
				engine.acknowledgeExecutionArchive(initial.id, initial.revision);
				f.store.save(JSON.parse(JSON.stringify(f.state())) as ExecutionRiskState);
				const poller = f.engine();
				const archived = poller.listExecutions()[0];
				const usage = poller.risk.usage();
				const audit = poller.listAuditEvents();
				for (let poll = 1; poll <= 1001; poll++) {
					vi.setSystemTime(start + poll * 1000);
					await poller.refreshExecutionEvidence(archived.id);
				}
				expect(poller.listExecutions()[0]).toEqual(archived);
				expect(poller.listExecutions()[0].evidence?.observedAt).toBe(new Date(start).toISOString());
				expect(poller.listExecutions()[0].evidence?.source).toBe("submission");
				expect(poller.listAuditEvents()).toEqual(audit);
				expect(poller.risk.usage()).toEqual(usage);
				expect(kind === "order" ? f.lookup : f.lookupList).toHaveBeenCalledTimes(1001);

				const changed = kind === "order" ? [...f.orders.values()][0] : [...f.lists.values()][0][0];
				changed.price = 99;
				vi.setSystemTime(start + 1002 * 1000);
				await poller.refreshExecutionEvidence(archived.id);
				const revised = poller.listExecutions()[0];
				expect(revised.revision).toBe(archived.revision + 1);
				expect(revised.archiveAcknowledgedRevision).toBe(archived.revision);
				expect(revised.evidence?.source).toBe("client-id-lookup");
				expect(revised.evidence?.observedAt).toBe(new Date(start + 1002 * 1000).toISOString());
				vi.setSystemTime(start + 1003 * 1000);
				await poller.refreshExecutionEvidence(archived.id);
				expect(poller.listExecutions()[0]).toEqual(revised);
				expect(poller.risk.usage()).toEqual(usage);
				expect(kind === "order" ? f.submit : f.submitOco).toHaveBeenCalledOnce();
			} finally {
				vi.useRealTimers();
			}
		},
	);
});
