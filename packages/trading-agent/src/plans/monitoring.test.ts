import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionRecord, Order, Position } from "@nikopack/ti-trading-engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evidenceExtensionHarness, evidenceRuntime } from "../__tests__/evidence-fixture.ts";
import type { MonitoringNotification } from "../monitoring-state.ts";
import { assessOperationalHealth } from "../operational-health.ts";
import { observePlanAccounts, planAccountObservation } from "./account-observations.ts";
import { createPlanExtension } from "./extension.ts";
import type { PlanContent } from "./model.ts";
import { PLAN_LIMITS } from "./model.ts";
import { deliverPlanNotifications, readPlanHealth } from "./monitoring.ts";
import { planDetailView, planPage } from "./presentation.ts";
import { archivePlanExecutions, PlanMonitor, preparePlanSubmission, reviewPlan } from "./runtime.ts";
import { PlanStore } from "./store.ts";

let root: string;
let now: number;
let store: PlanStore;
const content = (): PlanContent => ({
	symbol: "BTC/USDT",
	timeframe: "1h",
	direction: "long",
	thesis: "Original breakout rationale",
	entry: [{ fact: "price", operator: "gte", value: 90 }],
	invalidation: [{ fact: "price", operator: "lt", value: 80 }],
	expiresAt: new Date(now + 86_400_000).toISOString(),
	reviewAt: new Date(now + 3_600_000).toISOString(),
	risk: "Research risk limit, not an engine override",
	evidence: [{ source: "fixture", observedAt: new Date(now).toISOString(), summary: "Price observed at 100" }],
});

beforeEach(() => {
	root = mkdtempSync(join(realpathSync(tmpdir()), "ti-plan-monitor-"));
	now = Date.now();
	vi.useFakeTimers();
	vi.setSystemTime(now);
	store = new PlanStore(root, () => now);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	rmSync(root, { recursive: true, force: true });
});

async function tracked() {
	const f = evidenceRuntime();
	const plan = store.create(f.scope, content());
	store.activate(plan.id, f.scope, 1);
	const monitor = new PlanMonitor(store, () => now);
	await monitor.tick(f.scope, f.exchange, () => true, { executions: f.engine });
	return { ...f, id: plan.id, monitor };
}

describe("durable non-waking plan notifications", () => {
	it("commits the event and latest coalesced notification in the same private state", async () => {
		const f = await tracked();
		const state = store.storage.read();
		const pending = state.monitoring!.scopes[0].notifications.filter((event) => event.status === "pending");
		expect(pending).toHaveLength(1);
		expect(pending[0]).toMatchObject({ source: "plans", wake: false, planReference: { id: f.id, version: 1 } });
		expect(state.plans[0].events.some((event) => event.id === pending[0].planReference?.eventId)).toBe(true);
		expect(JSON.parse(pending[0].content)).toMatchObject({ condition: { entry: "true" }, totalOrders: 0 });
		const before = readFileSync(store.storage.path, "utf8");
		expect(() =>
			store.monitoring.transact((state) => {
				state.scopes[0].notifications[0].wake = true;
			}),
		).toThrow(/cannot wake/);
		expect(readFileSync(store.storage.path, "utf8")).toBe(before);
		expect(f.placeOrder).not.toHaveBeenCalled();
	});

	it("retries a failed send with the same ID after restart and exposes delivery degradation", async () => {
		const f = await tracked();
		const delivered = vi.fn<(_event: MonitoringNotification) => boolean>(() => {
			throw new Error("fixture delivery failed");
		});
		expect(
			deliverPlanNotifications(
				store,
				f.scope,
				delivered,
				() => true,
				() => now,
			),
		).toMatchObject({ failures: [expect.objectContaining({ error: expect.any(Error) })] });
		const eventId = delivered.mock.calls[0][0].id;
		const health = readPlanHealth(store, f.scope, true);
		expect(health).toMatchObject({ source: "plans", pendingNotifications: 1, errorCode: "delivery-failed" });
		now += 10_000;
		vi.setSystemTime(now);
		const send = vi.fn<(_event: MonitoringNotification) => boolean>(() => true);
		const reopened = new PlanStore(root, () => now);
		expect(
			deliverPlanNotifications(
				reopened,
				f.scope,
				send,
				() => true,
				() => now,
			).delivered,
		).toBe(1);
		expect(send.mock.calls[0]?.[0]).toMatchObject({ id: eventId, wake: false });
		expect(
			reopened.monitoring.read().scopes[0].notifications.filter((event) => event.status === "delivered"),
		).toHaveLength(1);
	});

	it("keeps the cooldown durable while recording intervening condition changes", async () => {
		const f = await tracked();
		const send = vi.fn<(_event: MonitoringNotification) => boolean>(() => true);
		deliverPlanNotifications(
			store,
			f.scope,
			send,
			() => true,
			() => now,
		);
		now += 1_000;
		vi.setSystemTime(now);
		vi.mocked(f.exchange.getTicker).mockResolvedValue({
			symbol: "BTC/USDT",
			last: 75,
			timestamp: now,
			sourceTimestampKnown: true,
		});
		await f.monitor.tick(f.scope, f.exchange, () => true, { executions: f.engine });
		expect(store.read(f.id, f.scope).observation?.invalidation).toBe("true");
		expect(
			deliverPlanNotifications(
				store,
				f.scope,
				send,
				() => true,
				() => now,
			).attempted,
		).toBe(0);
		now += 60_000;
		expect(
			deliverPlanNotifications(
				new PlanStore(root, () => now),
				f.scope,
				send,
				() => true,
				() => now,
			).delivered,
		).toBe(1);
		expect(send).toHaveBeenCalledTimes(2);
	});

	it("reclaims an expired delivery lease without inventing a historical condition crossing", async () => {
		const f = await tracked();
		let id = "";
		store.monitoring.transact((state) => {
			const event = state.scopes[0].notifications.find((event) => event.status === "pending")!;
			id = event.id;
			event.status = "delivering";
			event.attempts = 1;
			event.leaseId = "stopped-writer";
			event.leaseUntil = now + 30_000;
		});
		const send = vi.fn<(_event: MonitoringNotification) => boolean>(() => true);
		expect(
			deliverPlanNotifications(
				store,
				f.scope,
				send,
				() => true,
				() => now,
			).attempted,
		).toBe(0);
		now += 31_000;
		expect(
			deliverPlanNotifications(
				new PlanStore(root, () => now),
				f.scope,
				send,
				() => true,
				() => now,
			).delivered,
		).toBe(1);
		expect(send.mock.calls[0]?.[0]).toMatchObject({ id, wake: false });
	});

	it.each(["archive", "version", "reset"] as const)("cancels undelivered observations on %s", async (action) => {
		const f = await tracked();
		if (action === "archive") store.archive(f.id, f.scope, 2);
		else if (action === "reset") store.markPaperReset(f.scope);
		else {
			store.revise(f.id, f.scope, 2, content());
			store.activate(f.id, f.scope, 3);
		}
		const send = vi.fn(() => true);
		expect(
			deliverPlanNotifications(
				store,
				f.scope,
				send,
				() => true,
				() => now,
			).attempted,
		).toBe(0);
		expect(send).not.toHaveBeenCalled();
	});

	it("expires old notices visibly, without delivery or a new trading block", async () => {
		const f = await tracked();
		now += 300_001;
		const send = vi.fn(() => true);
		deliverPlanNotifications(
			store,
			f.scope,
			send,
			() => true,
			() => now,
		);
		const observation = readPlanHealth(store, f.scope, true);
		expect(observation.errorCode).toBe("notification-expired");
		expect(send).not.toHaveBeenCalled();
		const health = assessOperationalHealth(
			{
				mode: "paper",
				exchange: "binance",
				marketType: "spot",
				maintenanceActive: false,
				staleRuntime: false,
				unresolvedExecutions: 1,
				pendingReservations: 0,
				observations: [observation],
				maxObservationAgeMs: 300_000,
			},
			now,
		);
		expect(health.blockers).toEqual(["unresolved-executions"]);
		expect(health.observations[0].status).toBe("degraded");
	});
});

describe("account observations and operator review", () => {
	it.each([false, undefined])(
		"rejects a local or unverified ticker timestamp (%s) for plan conditions",
		async (known) => {
			const f = await tracked();
			now++;
			vi.setSystemTime(now);
			vi.mocked(f.exchange.getTicker).mockResolvedValue({
				symbol: "BTC/USDT",
				last: 100,
				timestamp: now,
				sourceTimestampKnown: known,
			});
			await f.monitor.tick(f.scope, f.exchange);
			expect(store.read(f.id, f.scope).observation).toMatchObject({ entry: "unknown", invalidation: "unknown" });
			expect(f.placeOrder).not.toHaveBeenCalled();
		},
	);
	it("distinguishes qualified coverage, missing stop evidence and no proven plan inventory", async () => {
		const f = await tracked();
		const plan = store.read(f.id, f.scope);
		const position: Position = { symbol: "BTC/USDT", asset: "BTC", amount: 1, quoteValue: 100 };
		const stop: Order = {
			id: "outside-stop",
			symbol: "BTC/USDT",
			side: "sell",
			type: "stop_market",
			amount: 1,
			filled: 0,
			remaining: 1,
			status: "open",
			cost: 0,
			stopPrice: 80,
			timestamp: now,
		};
		expect(planAccountObservation(plan, [], [position], [stop], now)).toMatchObject({
			protection: "protected",
			orders: [],
		});
		expect(
			planAccountObservation(plan, [], [position], [{ ...stop, remaining: 0.5, amount: 0.5 }], now).protection,
		).toBe("partial");
		expect(planAccountObservation(plan, [], [position], [{ ...stop, stopPrice: undefined }], now)).toMatchObject({
			status: "unknown",
			protection: "unknown",
		});
		expect(planAccountObservation(plan, [], undefined, [], now).protection).toBe("unknown");
		expect(reviewPlan(plan).result.netQuoteCashFlow).toBeNull();
	});

	it("refreshes only correlated orders and preserves actual transitions without submitting twice", async () => {
		const f = await tracked();
		let current: Order | undefined;
		f.placeOrder.mockImplementation(async (input) => {
			current = {
				...input,
				id: "resting",
				amount: input.amount,
				filled: 0,
				remaining: input.amount,
				cost: 0,
				status: "open",
				timestamp: now,
			};
			return { order: current, fee: 0 };
		});
		vi.spyOn(f.exchange, "getOrder").mockImplementation(async () => current!);
		vi.spyOn(f.exchange, "getOrderByClientId").mockImplementation(async () => current!);
		const prepared = await f.engine.prepareOrder("buy", { symbol: "BTC/USDT", type: "limit", price: 90, amount: 1 });
		const policy = preparePlanSubmission(
			f.runtime,
			{ id: f.id, version: 1, intentId: "entry" },
			{
				intent: { kind: "order", input: prepared.input },
				countTowardsDailyLimit: true,
			},
			store,
		);
		await f.engine.placeOrder(prepared, policy);
		archivePlanExecutions(f.runtime, store);
		current = { ...current!, status: "closed", filled: 1, remaining: 0, cost: 89 };
		now += 1_000;
		vi.setSystemTime(now);
		await f.monitor.tick(f.scope, f.exchange, () => true, { executions: f.engine });
		expect(store.read(f.id, f.scope).accountObservation?.orders).toEqual([
			expect.objectContaining({ id: "resting", status: "closed", filled: 1, remaining: 0 }),
		]);
		expect(f.placeOrder).toHaveBeenCalledOnce();
		const comparison = reviewPlan(store.read(f.id, f.scope)).differences[0];
		expect(comparison).toMatchObject({ intentId: "entry", version: 1, originalRationale: content().thesis });
		expect(comparison.actual[0].orders[0].averageFillPrice).toBe(89);
		const revision = f.engine.listExecutions()[0].revision;
		current.feeObservation = {
			source: "paper-ledger",
			completeness: "complete",
			charges: [{ currency: "USDT", cost: 0.089 }],
		};
		now += 1_000;
		vi.setSystemTime(now);
		await f.monitor.tick(f.scope, f.exchange, () => true, { executions: f.engine });
		expect(f.engine.listExecutions()[0].revision).toBe(revision + 1);
		expect(store.read(f.id, f.scope).executions.at(-1)?.fee).toBe(0.089);
		expect(f.placeOrder).toHaveBeenCalledOnce();
		expect(f.exchange.cancelOrder).not.toHaveBeenCalled();
	});

	it("rotates a bounded refresh window and reports deferred observations instead of false freshness", async () => {
		const f = await tracked();
		const prepared = await f.engine.prepareOrder("buy", { symbol: "BTC/USDT", type: "market", amount: 1 });
		await f.engine.placeOrder(
			prepared,
			preparePlanSubmission(
				f.runtime,
				{ id: f.id, version: 1, intentId: "entry" },
				{
					intent: { kind: "order", input: prepared.input },
					countTowardsDailyLimit: true,
				},
				store,
			),
		);
		const original = f.engine.listExecutions()[0];
		const records: ExecutionRecord[] = Array.from({ length: 21 }, (_, index) => ({
			...structuredClone(original),
			id: `bounded-${String(index).padStart(2, "0")}`,
			archiveAcknowledgedRevision: original.revision,
			evidence: {
				...original.evidence!,
				orders: original.evidence!.orders.map((order) => ({
					...order,
					status: "open",
					filled: 0,
					remaining: 1,
					cost: 0,
				})),
			},
		}));
		const refreshExecutionEvidence = vi.fn(async (_id: string) => {});
		const reader = { listExecutions: () => records, refreshExecutionEvidence, acknowledgeExecutionArchive: vi.fn() };
		const plan = store.read(f.id, f.scope);
		now++;
		await observePlanAccounts(
			store,
			[plan],
			f.scope,
			f.exchange,
			reader,
			() => true,
			() => now,
		);
		expect(refreshExecutionEvidence).toHaveBeenCalledTimes(20);
		expect(store.read(f.id, f.scope).accountObservation?.limitations.join(" ")).toContain("bounded refresh");
		now++;
		await observePlanAccounts(
			new PlanStore(root, () => now),
			[plan],
			f.scope,
			f.exchange,
			reader,
			() => true,
			() => now,
		);
		expect(new Set(refreshExecutionEvidence.mock.calls.map(([id]) => id)).size).toBe(21);
	});

	it("keeps operator pages out of model messages and retries never wake the model", async () => {
		const f = await tracked();
		f.config.language = "zh-CN";
		f.config.monitor.intervalSec = 5;
		const h = evidenceExtensionHarness();
		createPlanExtension(() => f.runtime, new PlanStore(root))(h.api);
		await h.commands.get("plan")!.handler(`show ${f.id}`, h.ctx);
		expect(h.appendEntry).toHaveBeenCalledWith("trading:plan", expect.objectContaining({ title: "交易计划" }));
		expect(h.sendMessage).not.toHaveBeenCalled();
		h.sendMessage.mockImplementationOnce(() => {
			throw new Error("fixture transport");
		});
		await h.emit("session_start");
		await vi.advanceTimersByTimeAsync(5_000);
		now = Date.now();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(h.sendMessage.mock.calls.length).toBeGreaterThanOrEqual(2);
		expect(h.sendMessage.mock.calls.every(([, options]) => options?.triggerTurn === false)).toBe(true);
		await h.emit("session_shutdown");
		expect(f.placeOrder).not.toHaveBeenCalled();
	});

	it("bounds tool pages and marks oversized evidence instead of silently discarding it", async () => {
		const f = await tracked();
		const page = planPage(["x".repeat(20_000), ...Array.from({ length: 40 }, (_, index) => String(index))]);
		expect(page.oversizedRecords).toEqual([0]);
		expect(page.nextOffset).toBe(20);
		expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(16_384);
		expect(planDetailView(store.read(f.id, f.scope), "en-US").lines.join(" ")).toContain("Original rationale");
		expect(() => planDetailView(store.read(f.id, f.scope), "en-US", 0)).toThrow(/page/);
	});

	it("surfaces corrupted plan health without resetting evidence or inventing a clean state", async () => {
		const f = await tracked();
		writeFileSync(store.storage.path, "{invalid");
		expect(readPlanHealth(store, f.scope, true)).toMatchObject({
			enabled: true,
			errorCode: "plan-state-unavailable",
		});
		expect(readFileSync(store.storage.path, "utf8")).toBe("{invalid");
	});

	it("rejects asynchronous private transactions without committing their mutations", async () => {
		const f = await tracked();
		const before = readFileSync(store.storage.path, "utf8");
		expect(() =>
			store.storage.transact(async (state) => {
				state.plans.length = 0;
			}),
		).toThrow(/synchronous/);
		expect(readFileSync(store.storage.path, "utf8")).toBe(before);
		expect(store.read(f.id, f.scope).versions[0].content.thesis).toBe(content().thesis);
	});

	it("reserves enough history capacity to stop a saturated plan and does not block later Paper resets", async () => {
		const f = await tracked();
		store.storage.transact((state) => {
			const plan = state.plans[0];
			while (plan.events.length < PLAN_LIMITS.events - 1)
				plan.events.push({
					id: `capacity-${plan.events.length}`,
					version: 1,
					at: new Date(now).toISOString(),
					kind: "fixture",
					detail: "Retained historical event",
				});
		});
		const observation = store.read(f.id, f.scope).observation!;
		expect(() =>
			store.observe(f.id, f.scope, { ...observation, at: new Date(now + 1).toISOString(), entry: "false" }),
		).toThrow(/capacity/);
		store.archive(f.id, f.scope, 2);
		expect(store.read(f.id, f.scope).events).toHaveLength(PLAN_LIMITS.events);
		expect(() => store.markPaperReset(f.scope)).not.toThrow();
		expect(store.read(f.id, f.scope).status).toBe("archived");
	});

	it("reads historical review pages without another network poll and strips terminal controls from research views", async () => {
		const f = await tracked();
		const h = evidenceExtensionHarness();
		createPlanExtension(() => f.runtime, store)(h.api);
		vi.mocked(f.exchange.getTicker).mockClear();
		const output = await h.tools
			.get("get_plan_review")!
			.execute("page", { id: f.id, section: "events" }, undefined, undefined, h.ctx);
		expect(output.details).toMatchObject({ total: expect.any(Number), offset: 0 });
		expect(f.exchange.getTicker).not.toHaveBeenCalled();
		const plan = store.read(f.id, f.scope);
		plan.versions[0].content.thesis = "\x1b[31mResearch\x1b[0m";
		const view = planDetailView(plan, "en-US");
		expect(JSON.stringify(view)).not.toContain("\\u001b");
		expect(JSON.stringify(view)).toContain("Research");
	});
});
