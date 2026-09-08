import { describe, expect, it, vi } from "vitest";
import * as Capabilities from "./capabilities.ts";
import { TradingEngine, type TradingEngineConfig } from "./engine.ts";
import {
	ExecutionJournal,
	type ExecutionRiskState,
	isUnresolvedExecution,
	validateExecutionRiskState,
} from "./execution-journal.ts";
import type { ExchangeClient, Order, PlaceOcoOrderInput, PlaceOrderInput } from "./types.ts";
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

	it("retains a reducing unknown and blocks entries independently of manual pause and quota", async () => {
		const f = fixture();
		const engine = f.engine();
		f.submit.mockRejectedValueOnce(new Error("apiKey=PRIVATE secret=PRIVATE network timeout"));
		await expect(engine.placeOrder(await engine.prepareOrder("sell", orderIntent))).rejects.toThrow(/unknown/);
		expect(engine.risk.usage()).toMatchObject({ reserved: 0, used: 0 });
		const pause = engine.risk.pauseNewExposure("Review");
		expect(() => engine.risk.resumeNewExposure(pause.id)).toThrow(/unresolved executions/);
		delete f.state().paper.newExposurePause;
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
});
