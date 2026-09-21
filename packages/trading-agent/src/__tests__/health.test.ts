import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type Component, ProcessTerminal, TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHealthViewHandler, createTradingStatus, readOperationalHealth } from "../health.ts";
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
			usage: () => ({ used: 0, reserved: 0, limit: 1000, date: "2026-01-01", resetPolicy: "manual" as const }),
			listPendingReservations: () => [],
		},
	},
}));
vi.mock("../context.ts", () => ({ getTrading: () => runtime }));

function fixture(
	readHealth?: Parameters<typeof createHealthViewHandler>[1],
	getLanguage?: Parameters<typeof createHealthViewHandler>[2],
) {
	const appendEntry = vi.fn();
	const notify = vi.fn();
	const pi = { appendEntry } as unknown as ExtensionAPI;
	const handler = createHealthViewHandler(pi, readHealth, getLanguage);
	return { handler, appendEntry, notify, ctx: { ui: { notify } } as unknown as ExtensionCommandContext };
}

describe("health command", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
		runtime.config.language = "en-US";
	});

	it("refreshes one cached status while idle, keeps render free of reads and stops on disposal", () => {
		vi.useFakeTimers();
		runtime.config.language = "zh-CN";
		const readHealth = vi.fn(() => readOperationalHealth(createMemoryMonitoringStore()));
		const status = createTradingStatus(readHealth);
		let widget: (Component & { dispose?(): void }) | undefined;
		const tui = new TuiMainScreen(new ProcessTerminal());
		vi.spyOn(tui, "requestRender").mockImplementation(() => {});
		const ctx = {
			mode: "tui",
			hasUI: true,
			ui: {
				theme: {
					fg: (_color: string, text: string) => text,
					bold: (text: string) => text,
					inverse: (text: string) => text,
				},
				setStatus: vi.fn(),
				setWidget: vi.fn((_key: string, factory: (tui: TuiMainScreen) => Component) => {
					widget = factory(tui);
				}),
			},
		} as unknown as ExtensionCommandContext;
		status.update(ctx);
		if (!widget) throw new Error("Missing status widget");
		const originalWidget = widget;
		// A routine snapshot renders venue identity only: no alert row and no monitor noise.
		const routine = widget.render(80).join("\n");
		expect(routine).toContain("模拟盘");
		expect(routine).toContain("公开行情");
		expect(routine).not.toContain("⚠");
		status.update(ctx);
		expect(ctx.ui.setWidget).toHaveBeenCalledOnce();
		readHealth.mockClear();
		for (const width of [20, 40, 80]) {
			for (const line of widget.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		expect(readHealth).not.toHaveBeenCalled();
		readHealth.mockReturnValue({
			...readOperationalHealth(createMemoryMonitoringStore()),
			entryBlocked: true,
			blockers: ["unresolved-executions"],
		});
		vi.advanceTimersByTime(5_000);
		expect(widget.render(80).join("\n")).toContain("未决执行");
		readHealth.mockImplementation(() => {
			throw new Error("secret fixture");
		});
		vi.advanceTimersByTime(5_000);
		const failed = widget.render(80).join("\n");
		expect(failed).toContain("/show health");
		expect(failed).not.toContain("secret fixture");
		expect(failed).not.toContain("未决执行");
		expect(failed).toContain("模拟盘");
		expect(failed).toContain("OKX");
		status.dispose();
		readHealth.mockClear();
		vi.advanceTimersByTime(10_000);
		expect(readHealth).not.toHaveBeenCalled();
		status.update(ctx);
		expect(widget).not.toBe(originalWidget);
		originalWidget.dispose?.();
		readHealth.mockClear();
		vi.advanceTimersByTime(5_000);
		expect(readHealth).toHaveBeenCalledOnce();
		widget.dispose?.();
		readHealth.mockClear();
		vi.advanceTimersByTime(10_000);
		expect(readHealth).not.toHaveBeenCalled();
	});

	it("keeps identity visible when monitoring state cannot be trusted", () => {
		const status = createTradingStatus(() => {
			throw new Error("secret monitoring fixture");
		});
		const setWidget = vi.fn();
		status.update({
			mode: "rpc",
			hasUI: true,
			ui: { setStatus: vi.fn(), setWidget },
		} as unknown as ExtensionCommandContext);
		const text = JSON.stringify(setWidget.mock.calls);
		expect(text).toContain("PAPER");
		expect(text).toContain("OKX");
		expect(text).toContain("public market data");
		expect(text).toContain("Health unavailable");
		expect(text).not.toContain("secret monitoring fixture");
		status.dispose();
	});

	it("keeps configured identity visible even when the risk state read fails", () => {
		vi.spyOn(runtime.tradingEngine.risk, "listPendingReservations").mockImplementation(() => {
			throw new Error("secret risk fixture");
		});
		const readHealth = vi.fn(() => readOperationalHealth(createMemoryMonitoringStore()));
		const status = createTradingStatus(readHealth);
		const setWidget = vi.fn();
		status.update({
			mode: "rpc",
			hasUI: true,
			ui: { setStatus: vi.fn(), setWidget },
		} as unknown as ExtensionCommandContext);
		const text = JSON.stringify(setWidget.mock.calls);
		expect(text).toContain("PAPER");
		expect(text).toContain("OKX");
		expect(text).toContain("Health unavailable");
		expect(text).not.toContain("secret risk fixture");
		expect(readHealth).toHaveBeenCalled();
		status.dispose();
	});

	it.each([
		[12_000, "en-US", "observed 12s ago"],
		[125_000, "en-US", "observed 2m ago"],
		[7_200_000, "zh-CN", "2 小时前观测"],
	] as const)(
		"shows persisted observation age %s in the health command while the status widget stays quiet",
		async (age, language, label) => {
			vi.useFakeTimers();
			vi.setSystemTime(10_000_000);
			runtime.config.language = language;
			const store = createMemoryMonitoringStore();
			store.transact((state) => {
				const scope = ensureMonitoringScope(state, monitoringState.monitoringScopeForRuntime(runtime), Date.now());
				scope.health.orders = { lastObservationAt: Date.now() - age, lastPollAt: Date.now() };
			});
			const readHealth = () => readOperationalHealth(store);
			const status = createTradingStatus(readHealth);
			const setWidget = vi.fn();
			const ctx = {
				mode: "rpc",
				hasUI: true,
				ui: { setStatus: vi.fn(), setWidget },
			} as unknown as ExtensionCommandContext;
			status.update(ctx);
			// Monitoring observations now belong to /show health, so the widget must stay free of them.
			const widgetText = JSON.stringify(setWidget.mock.calls);
			expect(widgetText).not.toContain(label);
			expect(widgetText).toContain(language === "zh-CN" ? "公开行情" : "public market data");
			const f = fixture(readHealth, () => language);
			await f.handler("", f.ctx);
			expect(JSON.stringify(f.appendEntry.mock.calls)).toContain(label);
			vi.advanceTimersByTime(age >= 3_600_000 ? 3_600_000 : 60_000);
			expect(setWidget).toHaveBeenCalledOnce();
			status.update(ctx);
			// Observation ageing must not push a new status widget: the rendered text is unchanged.
			expect(setWidget).toHaveBeenCalledOnce();
			status.dispose();
		},
	);

	it("ages the last observation while idle rather than treating each local refresh as a new observation", () => {
		vi.useFakeTimers();
		vi.setSystemTime(10_000_000);
		const store = createMemoryMonitoringStore();
		store.transact((state) => {
			const scope = ensureMonitoringScope(state, monitoringState.monitoringScopeForRuntime(runtime), Date.now());
			scope.health.orders = { lastObservationAt: Date.now() - 12_000, lastPollAt: Date.now() };
		});
		const readHealth = vi.fn(() => readOperationalHealth(store));
		const status = createTradingStatus(readHealth);
		const tui = new TuiMainScreen(new ProcessTerminal());
		vi.spyOn(tui, "requestRender").mockImplementation(() => {});
		let widget: Component | undefined;
		const ctx = {
			mode: "tui",
			hasUI: true,
			ui: {
				theme: {
					fg: (_color: string, text: string) => text,
					bold: (text: string) => text,
					inverse: (text: string) => text,
				},
				setStatus: vi.fn(),
				setWidget: vi.fn((_key: string, factory: (tui: TuiMainScreen) => Component) => {
					widget = factory(tui);
				}),
			},
		} as unknown as ExtensionCommandContext;
		status.update(ctx);
		if (!widget) throw new Error("Missing status widget");
		const first = widget.render(140).join("\n");
		expect(first).toContain("PAPER");
		expect(first).not.toContain("observed ");
		vi.advanceTimersByTime(5_000);
		// Idle refreshes re-read health but must not churn the status row with new ages.
		expect(widget.render(140).join("\n")).toBe(first);
		expect(readHealth).toHaveBeenCalledTimes(2);
		expect(ctx.ui.setWidget).toHaveBeenCalledOnce();
		status.dispose();
	});

	it.each([undefined, 11_000_000])(
		"does not manufacture a recent age for missing or future observations: %s",
		(at) => {
			vi.useFakeTimers();
			vi.setSystemTime(10_000_000);
			const store = createMemoryMonitoringStore();
			store.transact((state) => {
				const scope = ensureMonitoringScope(state, monitoringState.monitoringScopeForRuntime(runtime), Date.now());
				scope.health.orders = { lastObservationAt: at, lastPollAt: Date.now() };
			});
			const status = createTradingStatus(() => readOperationalHealth(store));
			const setWidget = vi.fn();
			status.update({
				mode: "rpc",
				hasUI: true,
				ui: { setStatus: vi.fn(), setWidget },
			} as unknown as ExtensionCommandContext);
			const text = JSON.stringify(setWidget.mock.calls);
			expect(text).not.toContain(at === undefined ? "unknown" : "stale");
			expect(text).not.toContain("observed ");
			expect(text).toContain("public market data");
			status.dispose();
		},
	);

	it("shows entry blocks and recovery guidance without claiming authorization", () => {
		const health = assessOperationalHealth(
			{
				mode: "paper",
				exchange: "okx",
				marketType: "spot",
				maintenanceActive: false,
				staleRuntime: false,
				unresolvedExecutions: 1,
				pendingReservations: 0,
				observations: [
					{ source: "orders", enabled: true, lastSuccessAt: 1_000, lastFailureAt: 2_000, pendingNotifications: 2 },
				],
				maxObservationAgeMs: 60_000,
			},
			3_000,
		);
		const status = createTradingStatus(() => health);
		const setWidget = vi.fn();
		status.update({
			mode: "rpc",
			hasUI: true,
			ui: { setStatus: vi.fn(), setWidget },
		} as unknown as ExtensionCommandContext);
		const lines: string[] = setWidget.mock.calls[0][1];
		expect(lines).toHaveLength(2);
		expect(lines[0]).toBe(
			"⚠ Entry blocks: unresolved executions  ·  Inspect /recovery; do not resubmit orders.  ·  /show health",
		);
		expect(lines[1]).toBe("[ PAPER ]  OKX  Spot  USDT  public market data");
		expect(lines.join("\n")).not.toMatch(/authorized|safe to trade/i);
		status.dispose();
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
				lines: expect.arrayContaining(["Entry blocks: unresolved executions", "Connectivity: unknown"]),
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
		expect(f.notify).toHaveBeenCalledWith("用法：/show health", "warning");
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
