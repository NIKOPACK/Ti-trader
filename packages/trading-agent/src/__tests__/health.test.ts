import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOperationalHealthExtension, readOperationalHealth } from "../health.ts";
import * as monitoringState from "../monitoring-state.ts";
import { createMemoryMonitoringStore, ensureMonitoringScope } from "../monitoring-state.ts";
import { assessOperationalHealth } from "../operational-health.ts";

const runtime = vi.hoisted(() => ({
	mode: "paper" as const,
	config: {
		mode: "paper",
		exchange: "okx",
		marketType: "spot",
		quoteCurrency: "USDT",
		language: "en-US",
		monitor: { enabled: true },
	},
	getExecutionStatus: () => ({
		accountId: "health-test",
		unresolved: [],
		maintenance: undefined,
		admission: { stale: false },
	}),
	tradingEngine: {
		risk: {
			usage: () => ({ newExposurePause: undefined }),
			listPendingReservations: () => [],
		},
	},
}));
vi.mock("../context.ts", () => ({ getTrading: () => runtime }));

function fixture(
	readHealth: Parameters<typeof createOperationalHealthExtension>[0],
	getLanguage?: Parameters<typeof createOperationalHealthExtension>[1],
) {
	let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void> | void) | undefined;
	const appendEntry = vi.fn();
	const notify = vi.fn();
	const api = {
		registerEntryRenderer: vi.fn(),
		appendEntry,
		registerCommand: vi.fn((_name: string, command: { handler: typeof handler }) => {
			handler = command.handler;
		}),
	} as unknown as ExtensionAPI;
	createOperationalHealthExtension(readHealth, getLanguage)(api);
	if (!handler) throw new Error("Health command was not registered");
	return { handler, appendEntry, notify, ctx: { ui: { notify } } as unknown as ExtensionCommandContext };
}

describe("health command", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("reads scoped persisted observations without treating an unused trigger lane as degraded connectivity", () => {
		const store = createMemoryMonitoringStore();
		const now = Date.now();
		store.transact((state) => {
			const scope = ensureMonitoringScope(
				state,
				{
					mode: "paper",
					exchange: "okx",
					marketType: "spot",
					quoteCurrency: "USDT",
					accountId: "health-test",
				},
				now,
			);
			scope.health.orders = { lastPollAt: now, lastSuccessAt: now, lastObservationAt: now };
		});
		expect(readOperationalHealth(store)).toMatchObject({
			connectivity: "recent-observations",
			entryBlocked: false,
			observations: [
				{ source: "triggers", status: "disabled" },
				{ source: "orders", status: "recent" },
			],
		});
	});

	it("shows local blocks without claiming that a connected account is safe to trade", async () => {
		const health = assessOperationalHealth({
			mode: "paper",
			exchange: "binance",
			marketType: "spot",
			newExposurePaused: true,
			maintenanceActive: false,
			staleRuntime: false,
			unresolvedExecutions: 1,
			pendingReservations: 0,
			observations: [],
			maxObservationAgeMs: 60_000,
		});
		const f = fixture(() => health);
		await f.handler("", f.ctx);
		expect(f.appendEntry).toHaveBeenCalledWith(
			"trading:health",
			expect.objectContaining({
				lines: expect.arrayContaining([
					"Entry blocks: new exposure paused, unresolved executions",
					"Connectivity: unknown",
				]),
				warning: expect.any(String),
			}),
		);
	});

	it("reports stale admission and the required restart in localized output", async () => {
		vi.spyOn(runtime, "getExecutionStatus").mockReturnValueOnce({
			...runtime.getExecutionStatus(),
			admission: { stale: true },
		});
		const f = fixture(
			() => readOperationalHealth(createMemoryMonitoringStore()),
			() => "zh-CN",
		);
		await f.handler("", f.ctx);
		expect(f.appendEntry).toHaveBeenCalledWith(
			"trading:health",
			expect.objectContaining({
				lines: expect.arrayContaining(["开仓阻断：运行时已过期，请重启 Ti"]),
				warning: expect.any(String),
			}),
		);
	});

	it("localizes health output and usage without contacting the exchange", async () => {
		const readHealth = vi.fn(() => readOperationalHealth(createMemoryMonitoringStore()));
		const f = fixture(readHealth, () => "zh-CN");
		await f.handler("run", f.ctx);
		expect(f.notify).toHaveBeenCalledWith("用法：/health", "warning");
		expect(readHealth).not.toHaveBeenCalled();
		await f.handler("", f.ctx);
		expect(f.appendEntry).toHaveBeenCalledWith(
			"trading:health",
			expect.objectContaining({
				title: "运行健康",
				lines: expect.arrayContaining(["开仓阻断：无", "连接观测：未知", "订单：未知；待发送通知=0"]),
			}),
		);
	});

	it("keeps a pending once-trigger delivery visible after its definition has fired", () => {
		const store = createMemoryMonitoringStore();
		const observations = monitoringState.readMonitoringHealth(
			store,
			monitoringState.monitoringScopeForRuntime(runtime),
		);
		vi.spyOn(monitoringState, "readMonitoringHealth").mockReturnValueOnce(
			observations.map((observation) => ({
				...observation,
				pendingNotifications: observation.source === "triggers" ? 1 : 0,
				lastFailureAt: Date.now(),
				errorCode: "delivery-failed",
			})),
		);
		expect(readOperationalHealth(store).observations[0]).toMatchObject({
			source: "triggers",
			enabled: true,
			status: "degraded",
			pendingNotifications: 1,
		});
	});

	it("reports failed delivery even when order observations continue successfully", () => {
		const store = createMemoryMonitoringStore();
		const now = Date.now();
		const observations = monitoringState.readMonitoringHealth(
			store,
			monitoringState.monitoringScopeForRuntime(runtime),
		);
		vi.spyOn(monitoringState, "readMonitoringHealth").mockReturnValueOnce(
			observations.map((observation) => ({
				...observation,
				pendingNotifications: observation.source === "orders" ? 1 : 0,
				lastObservationAt: now,
				lastSuccessAt: now,
				lastFailureAt: now,
				lastDeliveryFailureAt: now,
				errorCode: "delivery-failed",
			})),
		);
		expect(readOperationalHealth(store)).toMatchObject({
			connectivity: "degraded",
			observations: [
				{ source: "triggers", status: "disabled" },
				{ source: "orders", status: "degraded", errorCode: "delivery-failed", pendingNotifications: 1 },
			],
		});
	});

	it("surfaces untrusted state without emitting success-shaped health or raw secrets", async () => {
		const f = fixture(() => {
			throw new Error("authenticated request secret fixture");
		});
		await f.handler("", f.ctx);
		expect(f.appendEntry).not.toHaveBeenCalled();
		expect(f.notify).toHaveBeenCalledWith(expect.stringContaining("Health unavailable"), "error");
		expect(JSON.stringify(f.notify.mock.calls)).not.toContain("secret fixture");
	});
});
