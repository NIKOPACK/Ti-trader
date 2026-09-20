import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type Component, ProcessTerminal, TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";
import type { ExecutionMaintenance, ExecutionRecord } from "@nikopack/ti-trading-engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOperationalHealthExtension } from "../health.ts";
import * as monitoringState from "../monitoring-state.ts";
import type { TradingLanguage } from "../state.ts";
import { renderTradingTable, type TableData } from "../table.ts";

const trading = vi.hoisted(() => ({
	mode: "paper" as const,
	config: {
		language: "en-US" as TradingLanguage,
		exchange: "okx",
		marketType: "spot" as const,
		quoteCurrency: "USDT",
		orderApproval: "confirm" as "confirm" | "unattended",
		monitor: { enabled: false },
		risk: { maxOrderNotional: 500, maxDailyNotional: 2000, allowedSymbols: [] as string[] },
	},
	setMode: vi.fn(async (_mode: "paper" | "live") => {}),
	setOrderApproval: vi.fn(async (_mode: "confirm" | "unattended") => {}),
	setLanguage: vi.fn(async (_language: TradingLanguage) => {}),
	getExecutionScope: () => ({
		accountId: "commands-test",
		mode: "paper",
		exchange: "okx",
		marketType: "spot",
		quoteCurrency: "USDT",
		positionMode: "one-way",
	}),
	getExecutionStatus: vi.fn(() => ({
		unresolved: [],
		maintenance: undefined,
		admission: { stale: false },
	})),
	close: vi.fn(async () => {}),
	resolveExecution: vi.fn(),
	resolveMaintenance: vi.fn(),
	recoverExecutions: vi.fn(async () => ({ examined: 1, reconciled: 0, unresolved: 1, issues: [] })),
	listAuditEvents: vi.fn(() => []),
	tradingEngine: {
		getBalances: vi.fn(async () => [{ asset: "USDT", free: 1200, used: 100, total: 1300, quoteValue: 1300 }]),
		getPositions: vi.fn(async () => [
			{
				symbol: "BTC/USDT",
				amount: 0.01234567,
				quoteValue: 1234.56,
				avgEntryPrice: 100000,
				unrealizedPnl: 12.34,
				unrealizedPnlPct: 1,
			},
		]),
		getOpenOrders: vi.fn(async () => [
			{
				id: "order-12345678901234567890",
				symbol: "BTC/USDT",
				side: "sell",
				type: "stop",
				remaining: 0.01234567,
				price: 94000,
				stopPrice: 95000,
				timestamp: 1,
			},
		]),
		getOrderHistory: vi.fn(async () => [
			{
				id: "order-12345678901234567890",
				symbol: "BTC/USDT",
				side: "buy",
				filled: 0.01234567,
				average: 100000,
				status: "closed",
				timestamp: 1,
			},
		]),
		getTopMarkets: vi.fn(async () => [
			{ symbol: "BTC/USDT", last: 100000, changePct24h: 2.34, quoteVolume24h: 1000000 },
		]),
		listExecutions: vi.fn(() => [] as ExecutionRecord[]),
		getExecutionStatus: vi.fn(() => ({ maintenance: undefined as ExecutionMaintenance | undefined })),
		risk: {
			usage: vi.fn(() => ({
				used: 0,
				reserved: 100,
				limit: 2000,
				date: "2026-01-01",
				resetPolicy: "manual" as const,
			})),
			reset: vi.fn(),
			listPendingReservations: vi.fn(() => [
				{ id: "res-1", mode: "paper" as const, symbol: "BTC/USDT", notional: 100 },
			]),
			reconcileReservation: vi.fn(),
		},
	},
}));

const settingsMenu = vi.hoisted(() => ({
	openTradingSettings: vi.fn(async () => {}),
	loginExchange: vi.fn(async () => {}),
}));

vi.mock("../context.ts", () => ({ getTrading: () => trading }));
vi.mock("../settings-menu.ts", () => settingsMenu);

import { createTradingExtension } from "../commands.ts";

interface RegisteredCommand {
	handler(args: string, ctx: ExtensionCommandContext): Promise<void> | void;
}

let shutdownHandler: ((event: { reason: "quit" | "reload" }) => Promise<void>) | undefined;
const sessionStartHandlers: Array<(event: unknown, ctx: ExtensionCommandContext) => Promise<void>> = [];
const eventHandlers = new Map<string, (event: unknown, ctx: ExtensionCommandContext) => Promise<void>>();
const appendEntry = vi.fn();

function registerCommands(includeHealth = false): Map<string, RegisteredCommand> {
	const commands = new Map<string, RegisteredCommand>();
	const pi = {
		on: vi.fn((event: string, handler: (event: unknown, ctx: ExtensionCommandContext) => Promise<void>) => {
			if (event === "session_shutdown") shutdownHandler = handler as typeof shutdownHandler;
			if (event === "session_start") sessionStartHandlers.push(handler);
			else eventHandlers.set(event, handler);
		}),
		registerEntryRenderer: vi.fn(),
		appendEntry,
		sendMessage: vi.fn(),
		registerCommand: vi.fn((name: string, command: RegisteredCommand) => commands.set(name, command)),
	} as unknown as ExtensionAPI;
	createTradingExtension()(pi);
	if (includeHealth) createOperationalHealthExtension()(pi);
	return commands;
}

function commandContext(idle: boolean, confirm = true, hasUI = true): ExtensionCommandContext {
	return {
		mode: "tui",
		isIdle: vi.fn(() => idle),
		waitForIdle: vi.fn(async () => {}),
		hasUI,
		ui: {
			notify: vi.fn(),
			setStatus: vi.fn(),
			setWidget: vi.fn(),
			addAutocompleteProvider: vi.fn(),
			theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
			confirm: vi.fn(async () => confirm),
		},
	} as unknown as ExtensionCommandContext;
}

describe("trading commands", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		shutdownHandler = undefined;
		sessionStartHandlers.length = 0;
		eventHandlers.clear();
		trading.config.language = "en-US";
		trading.config.quoteCurrency = "USDT";
		trading.config.orderApproval = "confirm";
		trading.tradingEngine.risk.usage.mockReturnValue({
			used: 0,
			reserved: 100,
			limit: 2000,
			date: "2026-01-01",
			resetPolicy: "manual",
		});
		trading.tradingEngine.listExecutions.mockReturnValue([]);
		trading.tradingEngine.getExecutionStatus.mockReturnValue({ maintenance: undefined });
		vi.spyOn(monitoringState, "createFileMonitoringStore").mockImplementation(() =>
			monitoringState.createMemoryMonitoringStore(),
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("installs one cached widget for venue and health above the editor", async () => {
		vi.useFakeTimers();
		const ctx = commandContext(true);
		registerCommands(true);
		for (const handler of sessionStartHandlers) await handler({}, ctx);
		expect(ctx.ui.setStatus).toHaveBeenCalledWith("trading-status", undefined);
		expect(ctx.ui.setWidget).toHaveBeenCalledOnce();
		expect(ctx.ui.setWidget).toHaveBeenCalledWith("trading-status", expect.any(Function));
		const factory = vi.mocked(ctx.ui.setWidget).mock.calls.at(-1)?.[1];
		if (typeof factory !== "function") throw new Error("Missing venue widget factory");
		const widget = factory(new TuiMainScreen(new ProcessTerminal()), ctx.ui.theme);
		const text = widget.render(80).join("\n");
		expect(text).toContain("[ PAPER ]");
		expect(text).toContain("OKX");
		expect(text).toContain("market data: OKX public");
		expect(text).toContain("unsettled risk reservations");
		expect(text).toContain("/health");
		trading.tradingEngine.risk.usage.mockClear();
		widget.render(40);
		widget.invalidate();
		widget.render(80);
		expect(trading.tradingEngine.risk.usage).not.toHaveBeenCalled();
		await shutdownHandler?.({ reason: "reload" });
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([
		["balance", "Available:1,200", "Locked:100"],
		["positions", "PnL:+12.34USDT(1.00%)", "Entry:100,000.000000"],
		["orders", "Trigger:95,000.000000", "OrderID:order-12345678901234567890"],
		["trades", "Filled:0.01234567", "Status:closed"],
		["markets", "24hchange:+2.34%", "24hvolume:1,000,000"],
	])("keeps %s query fields readable at 40 and 80 columns", async (command, first, last) => {
		await registerCommands().get(command)!.handler("", commandContext(true));
		const data: TableData = appendEntry.mock.calls.at(-1)?.[1];
		expect(data.lines.some((line) => typeof line !== "string" && "fields" in line)).toBe(true);
		for (const width of [40, 80]) {
			const lines = renderTradingTable(data, { fg: (_color, text) => text, bg: (_color, text) => text })
				.render(width)
				.map(stripVTControlCharacters);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			const text = lines
				.slice(1, -1)
				.map((line) => line.trim().slice(1, -1))
				.join("")
				.replaceAll(" ", "");
			expect(text).toContain(first);
			expect(text).toContain(last);
		}
	});

	it("keeps serializable unified status text for RPC clients", async () => {
		const ctx = { ...commandContext(true), mode: "rpc" as const };
		registerCommands();
		for (const handler of sessionStartHandlers) await handler({}, ctx);
		expect(ctx.ui.setWidget).toHaveBeenCalledWith(
			"trading-status",
			expect.arrayContaining([
				"⚠ Entry blocks: unsettled risk reservations  ·  Inspect /recovery; do not resubmit orders.  ·  /health",
				"[ PAPER ]  OKX  Spot  USDT  market data: OKX public",
			]),
		);
	});

	it("refreshes language, configuration and tool results without reinstalling the TUI widget", async () => {
		vi.useFakeTimers();
		const ctx = commandContext(true);
		const commands = registerCommands();
		const tui = new TuiMainScreen(new ProcessTerminal());
		vi.spyOn(tui, "requestRender").mockImplementation(() => {});
		let widget: Component | undefined;
		vi.mocked(ctx.ui.setWidget).mockImplementation((_key, factory) => {
			if (typeof factory === "function") widget = factory(tui, ctx.ui.theme);
		});
		for (const handler of sessionStartHandlers) await handler({}, ctx);
		trading.setLanguage.mockImplementationOnce(async (language) => {
			trading.config.language = language;
		});
		await commands.get("language")!.handler("zh-CN", ctx);
		if (!widget) throw new Error("Missing status widget");
		expect(widget.render(80).join("\n")).toContain("模拟盘");
		expect(widget.render(80).join("\n")).toContain("未结算风险占用");
		trading.config.quoteCurrency = "USDC";
		await eventHandlers.get("tool_result")?.({}, ctx);
		expect(widget.render(80).join("\n")).toContain("USDC");
		expect(ctx.ui.setWidget).toHaveBeenCalledOnce();
		await shutdownHandler?.({ reason: "reload" });
		const readsBeforeShutdown = trading.tradingEngine.risk.usage.mock.calls.length;
		await eventHandlers.get("tool_result")?.({}, ctx);
		vi.advanceTimersByTime(10_000);
		expect(trading.tradingEngine.risk.usage).toHaveBeenCalledTimes(readsBeforeShutdown);
		expect(ctx.ui.setWidget).toHaveBeenCalledOnce();
		for (const handler of sessionStartHandlers) await handler({}, ctx);
		expect(ctx.ui.setWidget).toHaveBeenCalledTimes(2);
		expect(vi.getTimerCount()).toBe(1);
		await shutdownHandler?.({ reason: "reload" });
	});

	it("does not install a venue component in headless mode", async () => {
		const ctx = commandContext(true, true, false);
		registerCommands();
		for (const handler of sessionStartHandlers) await handler({}, ctx);
		expect(ctx.ui.setWidget).not.toHaveBeenCalled();
	});

	it("lists execution history without lookup, mutation or confirmation", async () => {
		const ctx = commandContext(false);
		await registerCommands().get("recovery")!.handler("", ctx);
		expect(trading.tradingEngine.listExecutions).toHaveBeenCalledOnce();
		expect(trading.recoverExecutions).not.toHaveBeenCalled();
		expect(trading.resolveExecution).not.toHaveBeenCalled();
		expect(ctx.ui.confirm).not.toHaveBeenCalled();
	});

	it.each([true, false])(
		"requires explicit human confirmation to release a maintenance fence: %s",
		async (confirmed) => {
			trading.tradingEngine.getExecutionStatus.mockReturnValue({
				maintenance: {
					id: "maintenance-1",
					action: "paper-reset",
					nextGeneration: 1,
					createdAt: "2026-01-01T00:00:00.000Z",
					scope: {
						accountId: "account-1",
						exchange: "binance",
						mode: "paper",
						marketType: "spot",
						quoteCurrency: "USDT",
						positionMode: "one-way",
					},
				},
			});
			await registerCommands()
				.get("recovery")!
				.handler("maintenance maintenance-1 verified-account", commandContext(true, confirmed));
			if (confirmed) expect(trading.resolveMaintenance).toHaveBeenCalledWith("maintenance-1", "verified-account");
			else expect(trading.resolveMaintenance).not.toHaveBeenCalled();
		},
	);

	it.each(["confirm", "decline", "headless", "replacement"] as const)(
		"requires scope-stable manual recovery: %s",
		async (mode) => {
			const entry: ExecutionRecord = {
				id: "execution-1",
				scope: {
					accountId: "account-1",
					exchange: "binance",
					mode: "paper",
					marketType: "spot",
					quoteCurrency: "USDT",
					positionMode: "one-way",
				},
				intent: {
					kind: "order",
					input: { symbol: "BTC/USDT", side: "buy", type: "market", amount: 1, clientOrderId: "client-1" },
				},
				status: "unknown",
				notional: 100,
				revision: 2,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
				attempts: 1,
			};
			trading.tradingEngine.listExecutions.mockReturnValue([entry]);
			const previous = trading.tradingEngine;
			const ctx = { ...commandContext(true, mode !== "decline"), hasUI: mode !== "headless" };
			if (mode === "replacement")
				vi.mocked(ctx.ui.confirm).mockImplementationOnce(async () => {
					trading.tradingEngine = { ...previous };
					return true;
				});
			try {
				await registerCommands().get("recovery")!.handler("resolve execution-1 release 0 evidence-123", ctx);
				if (mode === "confirm")
					expect(trading.resolveExecution).toHaveBeenCalledWith({
						executionId: entry.id,
						expectedRevision: 2,
						accountId: "account-1",
						outcome: "release",
						notional: 0,
						evidenceReference: "evidence-123",
						verifiedTerminal: true,
					});
				else expect(trading.resolveExecution).not.toHaveBeenCalled();
			} finally {
				trading.tradingEngine = previous;
			}
		},
	);

	it("registers the trading slash commands", () => {
		expect([...registerCommands().keys()]).toEqual([
			"settings",
			"language",
			"balance",
			"positions",
			"orders",
			"trades",
			"markets",
			"mode",
			"approval",
			"exchange",
			"market",
			"risk",
			"recovery",
			"audit",
			"paper",
			"exchange-login",
		]);
	});

	it("shows quota in the offline risk transcript", async () => {
		await registerCommands().get("risk")!.handler("show", commandContext(true));
		expect(appendEntry).toHaveBeenCalledWith(
			"trading:table",
			expect.objectContaining({
				lines: expect.arrayContaining(["Reserved: 100.00 USDT"]),
			}),
		);
	});

	it("closes the trading runtime during session shutdown", async () => {
		registerCommands();
		if (!shutdownHandler) throw new Error("session_shutdown handler was not registered");

		await shutdownHandler({ reason: "quit" });

		expect(trading.close).toHaveBeenCalledOnce();
	});

	it("keeps the trading runtime open when a session is reloaded", async () => {
		registerCommands();
		if (!shutdownHandler) throw new Error("session_shutdown handler was not registered");

		await shutdownHandler({ reason: "reload" });

		expect(trading.close).not.toHaveBeenCalled();
	});

	it("opens trading settings when /mode is invoked without arguments", async () => {
		const command = registerCommands().get("mode");
		if (!command) throw new Error("mode command was not registered");
		const ctx = commandContext(true);

		await command.handler("", ctx);

		expect(settingsMenu.openTradingSettings).toHaveBeenCalledOnce();
		expect(trading.setMode).not.toHaveBeenCalled();
	});

	it("waits for the active agent turn before switching trading mode", async () => {
		const command = registerCommands().get("mode");
		if (!command) throw new Error("mode command was not registered");
		const ctx = commandContext(false);

		await command.handler("paper", ctx);

		expect(ctx.waitForIdle).toHaveBeenCalledOnce();
		expect(vi.mocked(ctx.waitForIdle).mock.invocationCallOrder[0]).toBeLessThan(
			trading.setMode.mock.invocationCallOrder[0],
		);
	});

	it("opens trading settings when /approval is invoked without arguments", async () => {
		const command = registerCommands().get("approval");
		if (!command) throw new Error("approval command was not registered");
		const ctx = commandContext(true);

		await command.handler("", ctx);

		expect(settingsMenu.openTradingSettings).toHaveBeenCalledOnce();
		expect(trading.setOrderApproval).not.toHaveBeenCalled();
	});

	it("requires confirmation before switching order approval to unattended", async () => {
		const command = registerCommands().get("approval");
		if (!command) throw new Error("approval command was not registered");
		const ctx = commandContext(true);

		await command.handler("unattended", ctx);

		expect(ctx.ui.confirm).toHaveBeenCalledOnce();
		expect(trading.setOrderApproval).toHaveBeenCalledWith("unattended", { confirmUnattendedTrading: true });
	});

	it("does not switch order approval to unattended when confirmation is declined", async () => {
		const command = registerCommands().get("approval");
		if (!command) throw new Error("approval command was not registered");
		const ctx = commandContext(true, false);

		await command.handler("unattended", ctx);

		expect(trading.setOrderApproval).not.toHaveBeenCalled();
		expect(ctx.waitForIdle).not.toHaveBeenCalled();
	});

	it("rejects headless /approval unattended without changing config", async () => {
		const command = registerCommands().get("approval");
		if (!command) throw new Error("approval command was not registered");
		const ctx = commandContext(true, true, false);

		await command.handler("unattended", ctx);

		expect(ctx.ui.confirm).not.toHaveBeenCalled();
		expect(trading.setOrderApproval).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Switching to unattended live trading requires interactive confirmation",
			"error",
		);
	});

	it("switches back to confirm without an extra confirmation", async () => {
		trading.config.orderApproval = "unattended";
		const command = registerCommands().get("approval");
		if (!command) throw new Error("approval command was not registered");
		const ctx = commandContext(true);

		await command.handler("confirm", ctx);

		expect(ctx.ui.confirm).not.toHaveBeenCalled();
		expect(trading.setOrderApproval).toHaveBeenCalledWith("confirm", { confirmUnattendedTrading: false });
	});

	it("reconciles a pending reservation after confirmation", async () => {
		const command = registerCommands().get("risk");
		if (!command) throw new Error("risk command was not registered");
		const ctx = commandContext(false);

		await command.handler("reconcile res-1 release", ctx);

		expect(ctx.ui.confirm).toHaveBeenCalledOnce();
		expect(ctx.waitForIdle).toHaveBeenCalledOnce();
		expect(trading.tradingEngine.risk.reconcileReservation).toHaveBeenCalledWith("res-1", "release");
	});

	it("does not reconcile when confirmation is declined", async () => {
		const command = registerCommands().get("risk");
		if (!command) throw new Error("risk command was not registered");
		const ctx = commandContext(true, false);

		await command.handler("reconcile res-1 commit", ctx);

		expect(trading.tradingEngine.risk.reconcileReservation).not.toHaveBeenCalled();
		expect(ctx.waitForIdle).not.toHaveBeenCalled();
	});
});
