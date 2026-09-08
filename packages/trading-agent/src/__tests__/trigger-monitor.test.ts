import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Position } from "@earendil-works/ti-trading-engine";
import { afterEach, describe, expect, it, vi } from "vitest";

const NOW = Date.parse("2026-01-01T00:00:00Z");
const runtime = vi.hoisted(() => ({
	mode: "paper" as "paper" | "live",
	config: { monitor: { intervalSec: 5 } },
	marketData: { getTicker: vi.fn(async (_symbol: string) => ({ last: 101, timestamp: NOW })) },
	tradingEngine: { getPositions: vi.fn(async (): Promise<Position[]> => []) },
}));
vi.mock("../context.ts", () => ({ getTrading: () => runtime }));

import { createMemoryMonitoringStore, type MonitoringScope, type MonitoringStore } from "../monitoring-state.ts";
import { createTriggerMonitorExtension as createDurableTriggerMonitorExtension } from "../trigger-monitor.ts";

const TEST_SCOPE: MonitoringScope = {
	mode: "paper",
	exchange: "okx",
	marketType: "spot",
	quoteCurrency: "USDT",
	accountId: "test-account",
};

function createTriggerMonitorExtension(store: MonitoringStore = createMemoryMonitoringStore()) {
	return createDurableTriggerMonitorExtension({
		store,
		getScope: () => ({ ...TEST_SCOPE, mode: runtime.mode }),
	});
}

type Handler = (args: string | undefined, ctx: ExtensionContext) => Promise<void>;

afterEach(() => {
	runtime.mode = "paper";
	runtime.marketData.getTicker.mockImplementation(async () => ({ last: 101, timestamp: NOW }));
	runtime.tradingEngine.getPositions.mockImplementation(async () => []);
	vi.clearAllMocks();
	vi.useRealTimers();
});

describe("trigger monitor", () => {
	it.each(["fresh price", "expired trigger", "stale price", "fresh position", "stale position"] as const)(
		"evaluates %s against the time when collection completes",
		async (scenario) => {
			vi.useFakeTimers();
			vi.setSystemTime(NOW);
			const position = scenario.includes("position");
			const delayMs = scenario === "fresh price" || scenario === "expired trigger" ? 6_000 : 360_000;
			runtime.tradingEngine.getPositions.mockImplementation(async () => {
				if (scenario === "fresh position") await new Promise((resolve) => setTimeout(resolve, delayMs));
				return [{ symbol: "BTC/USDT", asset: "BTC", amount: 1, quoteValue: 101, unrealizedPnlPct: 2 }];
			});
			runtime.marketData.getTicker.mockImplementation(async () => {
				await new Promise((resolve) => setTimeout(resolve, delayMs));
				return {
					last: 101,
					timestamp: scenario === "stale price" || scenario === "expired trigger" ? NOW : Date.now(),
				};
			});
			const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
			const commands = new Map<string, Handler>();
			const sendMessage = vi.fn();
			createTriggerMonitorExtension()({
				registerCommand: (name: string, value: { handler: Handler }) => commands.set(name, value.handler),
				on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) =>
					handlers.set(event, handler),
				sendMessage,
			} as unknown as ExtensionAPI);
			const ctx = {
				hasUI: true,
				mode: "tui",
				isIdle: () => true,
				ui: { notify: vi.fn() },
			} as unknown as ExtensionContext;
			const condition = {
				kind: "compare",
				fact: { key: position ? "position_pnl_pct:BTC/USDT" : "price:BTC/USDT" },
				operator: "gt",
				value: position ? 0 : 100,
			};
			await commands.get("trigger")!(
				`add ${JSON.stringify({
					id: "delayed",
					name: "delayed",
					when:
						scenario === "stale position"
							? {
									kind: "all",
									conditions: [
										condition,
										{ kind: "compare", fact: { key: "price:BTC/USDT" }, operator: "gt", value: 100 },
									],
								}
							: condition,
					// biome-ignore lint/suspicious/noThenProperty: public trigger action field
					then: { kind: "wake_agent", message: "review" },
					policy: {
						mode: "once",
						expiresAt: scenario === "expired trigger" ? new Date(NOW + 5_000).toISOString() : undefined,
					},
				})}`,
				ctx,
			);
			try {
				const start = handlers.get("session_start")!({}, ctx);
				await vi.advanceTimersByTimeAsync(delayMs);
				await start;
				expect(sendMessage).toHaveBeenCalledTimes(
					scenario === "fresh price" || scenario === "fresh position" ? 1 : 0,
				);
			} finally {
				await handlers.get("session_shutdown")!({}, ctx);
			}
		},
	);

	it("does not lose a crossing while waiting for a slow price response", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		let price = 100;
		runtime.marketData.getTicker.mockImplementation(async () => {
			if (price > 100) await new Promise((resolve) => setTimeout(resolve, 6_000));
			return { last: price, timestamp: Date.now() };
		});
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
		const commands = new Map<string, Handler>();
		const sendMessage = vi.fn();
		createTriggerMonitorExtension()({
			registerCommand: (name: string, value: { handler: Handler }) => commands.set(name, value.handler),
			on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) =>
				handlers.set(event, handler),
			sendMessage,
		} as unknown as ExtensionAPI);
		const ctx = {
			hasUI: true,
			mode: "tui",
			isIdle: () => true,
			ui: { notify: vi.fn() },
		} as unknown as ExtensionContext;
		await commands.get("trigger")!(
			`add ${JSON.stringify({
				id: "cross",
				name: "cross",
				when: { kind: "cross", fact: { key: "price:BTC/USDT" }, direction: "above", value: 101 },
				// biome-ignore lint/suspicious/noThenProperty: public trigger action field
				then: { kind: "wake_agent", message: "review" },
				policy: { mode: "once" },
			})}`,
			ctx,
		);
		try {
			await handlers.get("session_start")!({}, ctx);
			price = 102;
			await vi.advanceTimersByTimeAsync(11_000);
			expect(sendMessage).toHaveBeenCalledOnce();
			await vi.advanceTimersByTimeAsync(11_000);
			expect(sendMessage).toHaveBeenCalledOnce();
		} finally {
			await handlers.get("session_shutdown")!({}, ctx);
		}
	});

	it.each(["price", "positions"] as const)("isolates a failed %s source from independent triggers", async (source) => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const failure = new Error("observation unavailable");
		if (source === "price") {
			runtime.marketData.getTicker.mockImplementation(async (symbol) => {
				if (symbol === "BAD/USDT") throw failure;
				return { last: 101, timestamp: Date.now() };
			});
		} else {
			runtime.tradingEngine.getPositions.mockRejectedValue(failure);
		}
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
		const commands = new Map<string, Handler>();
		const sendMessage = vi.fn();
		const notify = vi.fn();
		createTriggerMonitorExtension()({
			registerCommand: (name: string, value: { handler: Handler }) => commands.set(name, value.handler),
			on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) =>
				handlers.set(event, handler),
			sendMessage,
		} as unknown as ExtensionAPI);
		const ctx = { hasUI: true, mode: "tui", isIdle: () => true, ui: { notify } } as unknown as ExtensionContext;
		const add = async (id: string, when: unknown) => {
			await commands.get("trigger")!(
				`add ${JSON.stringify({
					id,
					name: id,
					when,
					// biome-ignore lint/suspicious/noThenProperty: public trigger action field
					then: { kind: "wake_agent", message: id },
					policy: { mode: "once" },
				})}`,
				ctx,
			);
		};
		await add("failed", {
			kind: "compare",
			fact: { key: source === "price" ? "price:BAD/USDT" : "position_pnl_pct:BTC/USDT" },
			operator: "gt",
			value: 0,
		});
		await add("healthy", { kind: "compare", fact: { key: "price:ETH/USDT" }, operator: "gt", value: 100 });
		await add("due", { kind: "time", at: new Date(NOW - 1).toISOString() });
		try {
			await handlers.get("session_start")!({}, ctx);
			expect(notify).toHaveBeenCalledWith(expect.stringContaining("observation unavailable"), "warning");
			expect(sendMessage.mock.calls.map(([message]) => message.content)).toEqual([
				"[trigger:healthy] healthy",
				"[trigger:due] due",
			]);
			await vi.advanceTimersByTimeAsync(5_000);
			expect(sendMessage).toHaveBeenCalledTimes(2);
		} finally {
			await handlers.get("session_shutdown")!({}, ctx);
		}
	});

	it("uses one shared fact snapshot for cross and change triggers", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		let price = 100;
		runtime.marketData.getTicker.mockImplementation(async () => ({ last: price, timestamp: Date.now() }));
		let start: ((ctx: ExtensionContext) => Promise<void>) | undefined;
		const commands = new Map<string, Handler>();
		const sendMessage = vi.fn();
		const notify = vi.fn();
		const api = {
			registerCommand: (name: string, value: { handler: Handler }) => commands.set(name, value.handler),
			on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) => {
				if (event === "session_start") start = (sessionCtx) => handler({}, sessionCtx);
			},
			sendMessage,
		} as unknown as ExtensionAPI;
		createTriggerMonitorExtension()(api);
		const ctx = { hasUI: true, mode: "tui", isIdle: () => true, ui: { notify } } as unknown as ExtensionContext;
		const add = async (id: string, when: unknown) => {
			const definition = { id, name: id, when, policy: { mode: "once" } } as Record<string, unknown>;
			// biome-ignore lint/suspicious/noThenProperty: public trigger action field
			definition.then = { kind: "wake_agent", message: id };
			await commands.get("trigger")?.(`add ${JSON.stringify(definition)}`, ctx);
		};
		await add("cross", { kind: "cross", fact: { key: "price:BTC/USDT" }, direction: "above", value: 101 });
		await add("change", {
			kind: "change",
			fact: { key: "price:BTC/USDT" },
			windowSec: 60,
			operator: "gt",
			value: 0,
			unit: "absolute",
		});
		await start?.(ctx);
		price = 102;
		await vi.advanceTimersByTimeAsync(5_000);
		expect(sendMessage).toHaveBeenCalledTimes(2);
		expect(sendMessage.mock.calls.map(([message]) => message.content)).toEqual(
			expect.arrayContaining([
				expect.stringContaining("[trigger:cross]"),
				expect.stringContaining("[trigger:change]"),
			]),
		);
		vi.useRealTimers();
	});

	it("manages definitions and fires a price wake without order access", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		let start: ((ctx: ExtensionContext) => Promise<void>) | undefined;
		const commands = new Map<string, Handler>();
		const sendMessage = vi.fn();
		const notify = vi.fn();
		const api = {
			registerCommand: (name: string, value: { handler: Handler }) => commands.set(name, value.handler),
			on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) => {
				if (event === "session_start") start = (sessionCtx) => handler({}, sessionCtx);
			},
			sendMessage,
		} as unknown as ExtensionAPI;
		createTriggerMonitorExtension()(api);
		const ctx = { hasUI: true, mode: "tui", isIdle: () => true, ui: { notify } } as unknown as ExtensionContext;
		const definition = JSON.stringify({
			id: "price-hit",
			name: "price hit",
			when: { kind: "compare", fact: { key: "price:BTC/USDT" }, operator: "gt", value: 100 },
			// biome-ignore lint/suspicious/noThenProperty: `then` is the public trigger action field.
			then: { kind: "wake_agent", message: "review" },
			policy: { mode: "once" },
		});
		await commands.get("trigger")?.(`add ${definition}`, ctx);
		await commands.get("trigger")?.("list", ctx);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("price-hit"), "info");
		await start?.(ctx);
		expect(sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: "trigger" }),
			expect.objectContaining({ triggerTurn: true }),
		);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(sendMessage).toHaveBeenCalledOnce();
		await commands.get("trigger")?.("remove price-hit", ctx);
		await commands.get("trigger")?.("list", ctx);
		expect(notify).toHaveBeenCalledWith("No triggers", "info");
		vi.useRealTimers();
	});

	it("does not auto-wake the agent from triggers in live mode", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		runtime.mode = "live";
		let start: ((ctx: ExtensionContext) => Promise<void>) | undefined;
		const commands = new Map<string, Handler>();
		const sendMessage = vi.fn();
		const notify = vi.fn();
		const api = {
			registerCommand: (name: string, value: { handler: Handler }) => commands.set(name, value.handler),
			on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) => {
				if (event === "session_start") start = (sessionCtx) => handler({}, sessionCtx);
			},
			sendMessage,
		} as unknown as ExtensionAPI;
		createTriggerMonitorExtension()(api);
		const ctx = { hasUI: true, mode: "tui", isIdle: () => true, ui: { notify } } as unknown as ExtensionContext;
		const definition = JSON.stringify({
			id: "price-hit",
			name: "price hit",
			when: { kind: "compare", fact: { key: "price:BTC/USDT" }, operator: "gt", value: 100 },
			// biome-ignore lint/suspicious/noThenProperty: `then` is the public trigger action field.
			then: { kind: "wake_agent", message: "review" },
			policy: { mode: "once" },
		});
		await commands.get("trigger")?.(`add ${definition}`, ctx);
		await start?.(ctx);
		expect(sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: "trigger" }),
			expect.objectContaining({ triggerTurn: false }),
		);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("live: notify only"), "info");
		vi.useRealTimers();
	});

	it("skips price facts whose ticker timestamp is missing or stale", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		runtime.marketData.getTicker.mockImplementation(async () => ({ last: 101, timestamp: NOW - 10 * 60_000 }));
		let start: ((ctx: ExtensionContext) => Promise<void>) | undefined;
		const commands = new Map<string, Handler>();
		const sendMessage = vi.fn();
		const api = {
			registerCommand: (name: string, value: { handler: Handler }) => commands.set(name, value.handler),
			on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) => {
				if (event === "session_start") start = (sessionCtx) => handler({}, sessionCtx);
			},
			sendMessage,
		} as unknown as ExtensionAPI;
		createTriggerMonitorExtension()(api);
		const ctx = {
			hasUI: true,
			mode: "tui",
			isIdle: () => true,
			ui: { notify: vi.fn() },
		} as unknown as ExtensionContext;
		const definition = JSON.stringify({
			id: "stale",
			name: "stale",
			when: { kind: "compare", fact: { key: "price:BTC/USDT" }, operator: "gt", value: 100 },
			// biome-ignore lint/suspicious/noThenProperty: `then` is the public trigger action field.
			then: { kind: "wake_agent", message: "review" },
			policy: { mode: "once" },
		});
		await commands.get("trigger")?.(`add ${definition}`, ctx);
		await start?.(ctx);
		expect(sendMessage).not.toHaveBeenCalled();
		runtime.marketData.getTicker.mockImplementation(async () => ({ last: 101, timestamp: 0 }));
		await vi.advanceTimersByTimeAsync(5_000);
		expect(sendMessage).not.toHaveBeenCalled();
		vi.useRealTimers();
	});

	it("waits for an active agent turn before mutating trigger definitions", async () => {
		const commands = new Map<string, Handler>();
		const waitForIdle = vi.fn(async () => {});
		const api = {
			registerCommand: (name: string, value: { handler: Handler }) => commands.set(name, value.handler),
			on: vi.fn(),
			sendMessage: vi.fn(),
		} as unknown as ExtensionAPI;
		createTriggerMonitorExtension()(api);
		const ctx = {
			hasUI: true,
			mode: "tui",
			isIdle: () => false,
			waitForIdle,
			ui: { notify: vi.fn() },
		} as unknown as ExtensionContext;
		const definition = JSON.stringify({
			id: "wait",
			name: "wait",
			when: { kind: "compare", fact: { key: "price:BTC/USDT" }, operator: "gt", value: 100 },
			// biome-ignore lint/suspicious/noThenProperty: `then` is the public trigger action field.
			then: { kind: "notify", message: "hit" },
			policy: { mode: "once" },
		});
		await commands.get("trigger")?.(`add ${definition}`, ctx);
		expect(waitForIdle).toHaveBeenCalledOnce();
		waitForIdle.mockClear();
		await commands.get("trigger")?.("list", ctx);
		expect(waitForIdle).not.toHaveBeenCalled();
	});

	it("warns once and evaluates unsupported fact keys as unknown", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		let start: ((ctx: ExtensionContext) => Promise<void>) | undefined;
		const commands = new Map<string, Handler>();
		const notify = vi.fn();
		const api = {
			registerCommand: (name: string, value: { handler: Handler }) => commands.set(name, value.handler),
			on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) => {
				if (event === "session_start") start = (sessionCtx) => handler({}, sessionCtx);
			},
			sendMessage: vi.fn(),
		} as unknown as ExtensionAPI;
		createTriggerMonitorExtension()(api);
		const ctx = { hasUI: true, mode: "tui", isIdle: () => true, ui: { notify } } as unknown as ExtensionContext;
		const definition = {
			id: "unknown",
			name: "unknown",
			when: { kind: "compare", fact: { key: "other:value" }, operator: "gt", value: 1 },
		} as Record<string, unknown>;
		// biome-ignore lint/suspicious/noThenProperty: public trigger action field
		definition.then = { kind: "notify", message: "hit" };
		await commands.get("trigger")?.(`add ${JSON.stringify(definition)}`, ctx);
		await start?.(ctx);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining('unsupported fact key "other:value"'), "warning");
		expect(notify.mock.calls.filter(([message]) => String(message).includes("unsupported fact key")).length).toBe(1);
		vi.useRealTimers();
	});
});
