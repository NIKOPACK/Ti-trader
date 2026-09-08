import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as config from "../config.ts";
import {
	createFileMonitoringStore,
	createMemoryMonitoringStore,
	deliverMonitoringNotifications,
	enqueueMonitoringNotification,
	ensureMonitoringScope,
	MONITORING_LEASE_MS,
	MONITORING_MAX_AGE_MS,
	type MonitoringNotification,
	type MonitoringScope,
	type MonitoringState,
	type MonitoringStore,
	monitoringScopeForRuntime,
	monitoringScopeKey,
	readMonitoringHealth,
	recordMonitoringObservation,
} from "../monitoring-state.ts";

const NOW = Date.parse("2026-01-01T00:00:00Z");
const SCOPE: MonitoringScope = {
	mode: "paper",
	exchange: "okx",
	marketType: "spot",
	quoteCurrency: "USDT",
	accountId: "account-fingerprint",
};
const paths: string[] = [];

function fileStore() {
	const dir = resolve(`src/__tests__/.monitoring-${randomUUID()}`);
	paths.push(dir);
	mkdirSync(dir);
	const path = `${dir}/monitoring-state.json`;
	return { path, store: createFileMonitoringStore(path) };
}

function seed(store: MonitoringStore): void {
	store.transact((state) => {
		const entry = ensureMonitoringScope(state, SCOPE, NOW);
		entry.triggers.push({
			definition: {
				id: "price",
				name: "price",
				when: { kind: "cross", fact: { key: "price:BTC/USDT" }, direction: "above", value: 100 },
				// biome-ignore lint/suspicious/noThenProperty: public trigger action field
				then: { kind: "notify", message: "review" },
				policy: { mode: "on_edge", cooldownSec: 60 },
			},
			revision: "revision",
			state: { status: "active", armed: true, lastFiredAt: NOW - 1000, stableSinceByPath: { "$.condition": NOW } },
			updatedAt: NOW,
		});
		entry.facts.push({ key: "price:BTC/USDT", value: 90, observedAt: NOW });
		entry.orders.known.push({ id: "pending", symbol: "BTC/USDT" });
		entry.orders.seeded = true;
		entry.orders.guards.push({ key: "BTC/USDT:LONG:drawdown", lastAlertAt: NOW });
	});
}

function enqueue(store: MonitoringStore, now = NOW): string {
	return store.transact((state) =>
		enqueueMonitoringNotification(
			ensureMonitoringScope(state, SCOPE, now),
			{
				source: "triggers",
				customType: "trigger",
				content: "review",
				notices: ["review"],
				level: "info",
				wake: false,
				triggerRevision: "revision",
			},
			now,
		),
	);
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("durable monitoring state", () => {
	it("roundtrips scoped definitions, baselines, runtime state and guard cooldown", () => {
		const { store, path } = fileStore();
		seed(store);
		expect(createFileMonitoringStore(path).read()).toEqual(store.read());
		const independent = createFileMonitoringStore(path);
		independent.transact((state) => {
			state.scopes[0].triggers[0].state.armed = false;
		});
		store.transact((state) => {
			state.scopes[0].orders.cursor = NOW + 1;
		});
		expect(independent.read().scopes[0].triggers[0].state.armed).toBe(false);
		expect(independent.read().scopes[0].orders.cursor).toBe(NOW + 1);
	});

	it.each([
		(state: MonitoringState) => Object.assign(state, { version: 2 }),
		(state: MonitoringState) => Object.assign(state.scopes[0].scope, { secret: "must-not-persist" }),
		(state: MonitoringState) => Object.assign(state.scopes[0].triggers[0].definition.when, { unexpected: true }),
		(state: MonitoringState) => Object.assign(state.scopes[0].triggers[0].definition.then, { kind: "trade" }),
		(state: MonitoringState) => Object.assign(state.scopes[0].triggers[0].state, { armed: "yes" }),
		(state: MonitoringState) => Object.assign(state.scopes[0].triggers[0].state, { stableSinceByPath: { $: NaN } }),
		(state: MonitoringState) => Object.assign(state.scopes[0].facts[0], { observedAt: Infinity }),
		(state: MonitoringState) => Object.assign(state.scopes[0].orders.guards[0], { lastAlertAt: -1 }),
		(state: MonitoringState) => state.scopes[0].orders.known.push({ id: "pending", symbol: "BTC/USDT" }),
		(state: MonitoringState) => Object.assign(state.scopes[0].health.orders, { errorCode: "raw-request-secret" }),
		(state: MonitoringState) => Object.assign(state.scopes[0].health.orders, { lastDeliveryFailureAt: -1 }),
	])("rejects malformed nested writes without overwriting valid state (%#)", (corrupt) => {
		const { store, path } = fileStore();
		seed(store);
		const original = readFileSync(path, "utf8");
		expect(() =>
			store.transact((state) => {
				corrupt(state);
			}),
		).toThrow();
		expect(readFileSync(path, "utf8")).toBe(original);
	});

	it("surfaces corrupt reads and storage failures without resetting state", () => {
		const { store, path } = fileStore();
		writeFileSync(path, '{"version":1,"scopes":[{}]}');
		expect(() => store.read()).toThrow();
		expect(() => store.transact(() => {})).toThrow();
		expect(readFileSync(path, "utf8")).toBe('{"version":1,"scopes":[{}]}');
		rmSync(path);
		seed(store);
		vi.spyOn(config, "writeJsonFile").mockImplementation(() => {
			throw new Error("disk full");
		});
		expect(() => enqueue(store)).toThrow("disk full");
		expect(store.read().scopes[0].notifications).toEqual([]);
	});

	it("rejects JSON null instead of treating it as a missing file", () => {
		const { store, path } = fileStore();
		writeFileSync(path, "null");
		expect(() => store.read()).toThrow();
		expect(() => store.transact(() => {})).toThrow();
		expect(readFileSync(path, "utf8")).toBe("null");
	});

	it("derives the production path from the configured trading-state directory", () => {
		const read = vi.spyOn(config, "readJsonFile").mockReturnValue(undefined);
		createFileMonitoringStore().read();
		expect(read).toHaveBeenCalledWith(config.TRADING_STATE_PATH.replace(/[^/]+$/, "monitoring-state.json"));
	});

	it("isolates memory snapshots and rejects asynchronous transactions", () => {
		const store = createMemoryMonitoringStore();
		seed(store);
		store.read().scopes[0].triggers.length = 0;
		expect(store.read().scopes[0].triggers).toHaveLength(1);
		expect(() => store.transact(async () => {})).toThrow("synchronous");
	});

	it("requires the active runtime's explicit non-secret account identity", () => {
		expect(() => monitoringScopeForRuntime({})).toThrow("account scope");
		expect(monitoringScopeForRuntime({ getMonitoringScope: () => SCOPE })).toEqual(SCOPE);
		expect(
			monitoringScopeForRuntime({ config: SCOPE, getExecutionStatus: () => ({ accountId: SCOPE.accountId }) }),
		).toEqual(SCOPE);
		expect(() => monitoringScopeForRuntime({ config: SCOPE, getExecutionStatus: () => ({}) })).toThrow(
			"account scope",
		);
	});

	it("uses captured execution scope without reading journal status or mutable config", () => {
		const captured = { ...SCOPE, positionMode: "one-way" };
		const getExecutionStatus = vi.fn(() => {
			throw new Error("journal unavailable");
		});
		const scope = monitoringScopeForRuntime({
			getExecutionScope: () => captured,
			getExecutionStatus,
			config: { ...SCOPE, mode: "live", accountId: "different-account" },
		});
		expect(scope).toEqual(captured);
		expect(monitoringScopeKey(scope)).not.toBe(monitoringScopeKey({ ...scope, positionMode: "hedge" }));
		expect(getExecutionStatus).not.toHaveBeenCalled();
		scope.accountId = "changed-snapshot";
		expect(captured.accountId).toBe(SCOPE.accountId);
		expect(() =>
			monitoringScopeForRuntime({
				getExecutionScope: () => ({ ...captured, accountId: "" }),
			}),
		).toThrow();
	});

	it("serializes actual independent local-process writers", async () => {
		const { path, store } = fileStore();
		const worker = resolve("src/__tests__/fixtures/monitoring-store-worker.ts");
		const run = (id: string) =>
			new Promise<void>((done, reject) => {
				const child = spawn(process.execPath, ["--import", "tsx", worker, path, id], {
					cwd: resolve("../.."),
					stdio: ["ignore", "ignore", "pipe"],
				});
				let error = "";
				child.stderr.on("data", (data: Buffer) => {
					error += data.toString();
				});
				child.on("error", reject);
				child.on("exit", (code) => (code === 0 ? done() : reject(new Error(error))));
			});
		await Promise.all([run("first"), run("second")]);
		expect(store.read().scopes[0].orders.known).toHaveLength(40);
	}, 20_000);
});

describe("durable monitoring outbox", () => {
	it.each([
		{ status: "delivering", leaseId: undefined, leaseUntil: undefined },
		{ status: "delivered", finishedAt: undefined },
		{ status: "pending", leaseId: "orphan", leaseUntil: NOW + 1000 },
		{ attempts: -1 },
		{ nextAttemptAt: NOW - 1 },
		{ notices: [5] },
		{ source: "orders", customType: "trigger" },
	])("rejects inconsistent delivery records (%#)", (invalid) => {
		const store = createMemoryMonitoringStore();
		enqueue(store);
		const before = store.read();
		expect(() =>
			store.transact((state) => {
				Object.assign(state.scopes[0].notifications[0], invalid);
			}),
		).toThrow();
		expect(store.read()).toEqual(before);
	});

	it("recovers before delivery, acknowledges once, and exposes stable identity", () => {
		const { store, path } = fileStore();
		const id = enqueue(store);
		const deliver = vi.fn(() => true);
		deliverMonitoringNotifications(
			createFileMonitoringStore(path),
			SCOPE,
			"triggers",
			deliver,
			() => true,
			() => NOW,
		);
		deliverMonitoringNotifications(
			createFileMonitoringStore(path),
			SCOPE,
			"triggers",
			deliver,
			() => true,
			() => NOW,
		);
		expect(deliver).toHaveBeenCalledOnce();
		expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ id, attempts: 1 }));
		expect(store.read().scopes[0].notifications[0].status).toBe("delivered");
	});

	it("does not deliver if persisting the claim fails", () => {
		const { store } = fileStore();
		enqueue(store);
		const deliver = vi.fn(() => true);
		vi.spyOn(config, "writeJsonFile").mockImplementation(() => {
			throw new Error("claim failed");
		});
		expect(() =>
			deliverMonitoringNotifications(
				store,
				SCOPE,
				"triggers",
				deliver,
				() => true,
				() => NOW,
			),
		).toThrow("claim failed");
		expect(deliver).not.toHaveBeenCalled();
		expect(store.read().scopes[0].notifications[0].status).toBe("pending");
	});

	it("retries the same identity after send-before-ack failure, never during an unexpired lease", () => {
		const { store, path } = fileStore();
		const id = enqueue(store);
		const originalWrite = config.writeJsonFile;
		let writes = 0;
		vi.spyOn(config, "writeJsonFile").mockImplementation((...args) => {
			writes++;
			if (writes === 2) throw new Error("ack failed");
			originalWrite(...args);
		});
		const delivered: string[] = [];
		const deliver = (event: MonitoringNotification) => {
			delivered.push(event.id);
			return true;
		};
		expect(() =>
			deliverMonitoringNotifications(
				store,
				SCOPE,
				"triggers",
				deliver,
				() => true,
				() => NOW,
			),
		).toThrow("ack failed");
		deliverMonitoringNotifications(
			createFileMonitoringStore(path),
			SCOPE,
			"triggers",
			deliver,
			() => true,
			() => NOW + 1,
		);
		expect(delivered).toEqual([id]);
		deliverMonitoringNotifications(
			createFileMonitoringStore(path),
			SCOPE,
			"triggers",
			deliver,
			() => true,
			() => NOW + MONITORING_LEASE_MS + 1,
		);
		expect(delivered).toEqual([id, id]);
		expect(store.read().scopes[0].notifications[0].attempts).toBe(2);
	});

	it("retries failed delivery with backoff and prevents overlapping consumers", () => {
		const store = createMemoryMonitoringStore();
		enqueue(store);
		const second = vi.fn(() => true);
		const first = vi.fn(() => {
			deliverMonitoringNotifications(
				store,
				SCOPE,
				"triggers",
				second,
				() => true,
				() => NOW,
			);
			throw new Error("notification transport failed");
		});
		expect(
			deliverMonitoringNotifications(
				store,
				SCOPE,
				"triggers",
				first,
				() => true,
				() => NOW,
			),
		).toMatchObject({
			attempted: 1,
			delivered: 0,
			failures: [{ error: expect.objectContaining({ message: "notification transport failed" }) }],
		});
		expect(second).not.toHaveBeenCalled();
		deliverMonitoringNotifications(
			store,
			SCOPE,
			"triggers",
			second,
			() => true,
			() => NOW + 1,
		);
		expect(second).not.toHaveBeenCalled();
		deliverMonitoringNotifications(
			store,
			SCOPE,
			"triggers",
			second,
			() => true,
			() => NOW + 2_000,
		);
		expect(second).toHaveBeenCalledOnce();
	});

	it.each(["leased", "backoff", "unavailable-5s", "unavailable-60s"] as const)(
		"does not starve a deliverable event behind 32 %s entries",
		(scenario) => {
			const store = createMemoryMonitoringStore();
			const ids = Array.from({ length: 33 }, () => enqueue(store));
			const lastId = ids[32];
			if (scenario === "leased" || scenario === "backoff") {
				store.transact((state) => {
					for (const event of state.scopes[0].notifications.slice(0, 32)) {
						event.attempts = 1;
						if (scenario === "leased") {
							event.status = "delivering";
							event.leaseId = `lease-${event.id}`;
							event.leaseUntil = NOW + 60_000;
						} else event.nextAttemptAt = NOW + 60_000;
					}
				});
			}
			const deliver = vi.fn((event: MonitoringNotification) => event.id === lastId);
			const first = deliverMonitoringNotifications(
				store,
				SCOPE,
				"triggers",
				deliver,
				() => true,
				() => NOW,
			);
			if (scenario.startsWith("unavailable")) {
				expect(first.attempted).toBe(32);
				expect(store.read().scopes[0].notifications[32].attempts).toBe(0);
				const delay = scenario === "unavailable-5s" ? 5_000 : 60_000;
				const second = deliverMonitoringNotifications(
					store,
					SCOPE,
					"triggers",
					deliver,
					() => true,
					() => NOW + delay,
				);
				expect(second.attempted).toBeLessThanOrEqual(32);
				expect(second.delivered).toBe(1);
			} else expect(first.attempted).toBe(1);
			expect(store.read().scopes[0].notifications[32]).toMatchObject({
				id: lastId,
				status: "delivered",
				attempts: 1,
			});
		},
	);

	it("rechecks leases under lock without spending the claim budget on lost races", () => {
		const base = createMemoryMonitoringStore();
		for (let index = 0; index < 33; index++) enqueue(base);
		const store: MonitoringStore = {
			read: () => {
				const snapshot = base.read();
				base.transact((state) => {
					for (const event of state.scopes[0].notifications.slice(0, 32)) {
						event.status = "delivering";
						event.attempts = 1;
						event.leaseId = `other-${event.id}`;
						event.leaseUntil = NOW + 60_000;
					}
				});
				return snapshot;
			},
			transact: (operation) => base.transact(operation),
		};
		const deliver = vi.fn(() => true);
		const result = deliverMonitoringNotifications(
			store,
			SCOPE,
			"triggers",
			deliver,
			() => true,
			() => NOW,
		);
		expect(result).toMatchObject({ attempted: 1, delivered: 1, failures: [] });
		expect(deliver).toHaveBeenCalledOnce();
		expect(base.read().scopes[0].notifications[32].status).toBe("delivered");
	});

	it("still throws if persisting callback failure and retry state fails", () => {
		const { store } = fileStore();
		enqueue(store);
		const originalWrite = config.writeJsonFile;
		let writes = 0;
		vi.spyOn(config, "writeJsonFile").mockImplementation((...args) => {
			if (++writes === 2) throw new Error("retry persistence failed");
			originalWrite(...args);
		});
		expect(() =>
			deliverMonitoringNotifications(
				store,
				SCOPE,
				"triggers",
				() => {
					throw new Error("transport failed");
				},
				() => true,
				() => NOW,
			),
		).toThrow("retry persistence failed");
		expect(store.read().scopes[0].notifications[0]).toMatchObject({ status: "delivering", attempts: 1 });
	});

	it("retains delivery diagnostics across successful observations and backoff", () => {
		const store = createMemoryMonitoringStore();
		enqueue(store);
		deliverMonitoringNotifications(
			store,
			SCOPE,
			"triggers",
			() => false,
			() => true,
			() => NOW,
		);
		store.transact((state) => {
			recordMonitoringObservation(state.scopes[0], "triggers", NOW + 1_000, NOW + 1_000, false);
		});
		expect(readMonitoringHealth(store, SCOPE, NOW + 1_000)[0]).toMatchObject({
			lastSuccessAt: NOW + 1_000,
			lastFailureAt: NOW + 1_000,
			lastDeliveryFailureAt: NOW,
			errorCode: "delivery-failed",
			pendingNotifications: 1,
		});
		deliverMonitoringNotifications(
			store,
			SCOPE,
			"triggers",
			() => true,
			() => true,
			() => NOW + 2_000,
		);
		store.transact((state) => {
			recordMonitoringObservation(state.scopes[0], "triggers", NOW + 2_000, NOW + 2_000, false);
		});
		const recovered = readMonitoringHealth(store, SCOPE, NOW + 2_000)[0];
		expect(recovered.errorCode).toBeUndefined();
		expect(recovered.lastDeliveryFailureAt).toBe(NOW);
		expect(recovered.pendingNotifications).toBe(0);
	});

	it("does not replay expired events or deliver under another account", () => {
		const store = createMemoryMonitoringStore();
		enqueue(store);
		const deliver = vi.fn(() => true);
		deliverMonitoringNotifications(
			store,
			{ ...SCOPE, accountId: "other" },
			"triggers",
			deliver,
			() => true,
			() => NOW,
		);
		deliverMonitoringNotifications(
			store,
			SCOPE,
			"triggers",
			deliver,
			() => true,
			() => NOW + MONITORING_MAX_AGE_MS,
		);
		expect(deliver).not.toHaveBeenCalled();
		expect(store.read().scopes[0].notifications[0].status).toBe("expired");
		expect(readMonitoringHealth(store, SCOPE, NOW + MONITORING_MAX_AGE_MS)[0]).toMatchObject({
			expiredNotifications: 1,
			pendingNotifications: 0,
			errorCode: "notification-expired",
		});
	});

	it("bounds retained events, keeps active definitions and fails closed on a full pending backlog", () => {
		const store = createMemoryMonitoringStore();
		seed(store);
		for (let i = 0; i < 260; i++) {
			enqueue(store, NOW + i);
			deliverMonitoringNotifications(
				store,
				SCOPE,
				"triggers",
				() => true,
				() => true,
				() => NOW + i,
			);
		}
		expect(store.read().scopes[0].notifications).toHaveLength(256);
		expect(store.read().scopes[0].triggers).toHaveLength(1);
		store.transact((state) => {
			state.scopes[0].notifications = [];
		});
		for (let i = 0; i < 256; i++) enqueue(store);
		expect(() => enqueue(store)).toThrow("backlog is full");
		expect(store.read().scopes[0].notifications).toHaveLength(256);
	});

	it("returns read-only health with observation age and future/stale detection", () => {
		const store = createMemoryMonitoringStore();
		store.transact((state) => {
			const entry = ensureMonitoringScope(state, SCOPE, NOW);
			entry.health.triggers = { lastPollAt: NOW, lastObservationAt: NOW, lastSuccessAt: NOW };
		});
		enqueue(store);
		expect(readMonitoringHealth(store, SCOPE, NOW)[0]).toMatchObject({
			ageMs: 0,
			stale: false,
			pendingNotifications: 1,
			scope: SCOPE,
		});
		const snapshot = store.read();
		expect(readMonitoringHealth(store, SCOPE, NOW - 1)[0].stale).toBe(true);
		expect(readMonitoringHealth(store, SCOPE, NOW + MONITORING_MAX_AGE_MS + 1)[0].stale).toBe(true);
		expect(store.read()).toEqual(snapshot);
	});
});
