import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

const trading = vi.hoisted(() => ({
	mode: "paper" as const,
	config: {
		language: "en-US" as const,
		exchange: "okx",
		marketType: "spot" as const,
		quoteCurrency: "USDT",
		confirmLiveOrders: true,
		risk: { maxOrderNotional: 500, maxDailyNotional: 2000, allowedSymbols: [] as string[] },
	},
	setMode: vi.fn(async (_mode: "paper" | "live") => {}),
	tradingEngine: {
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
vi.mock("../table.ts", () => ({
	padEndWidth: (value: string) => value,
	padStartWidth: (value: string) => value,
	renderTradingTable: vi.fn(),
}));
vi.mock("../settings-menu.ts", () => settingsMenu);

import { createTradingExtension } from "../commands.ts";

interface RegisteredCommand {
	handler(args: string, ctx: ExtensionCommandContext): Promise<void> | void;
}

function registerCommands(): Map<string, RegisteredCommand> {
	const commands = new Map<string, RegisteredCommand>();
	const pi = {
		on: vi.fn(),
		registerEntryRenderer: vi.fn(),
		appendEntry: vi.fn(),
		sendMessage: vi.fn(),
		registerCommand: vi.fn((name: string, command: RegisteredCommand) => commands.set(name, command)),
	} as unknown as ExtensionAPI;
	createTradingExtension()(pi);
	return commands;
}

function commandContext(idle: boolean, confirm = true): ExtensionCommandContext {
	return {
		isIdle: vi.fn(() => idle),
		waitForIdle: vi.fn(async () => {}),
		hasUI: true,
		ui: {
			notify: vi.fn(),
			setStatus: vi.fn(),
			confirm: vi.fn(async () => confirm),
		},
	} as unknown as ExtensionCommandContext;
}

describe("trading commands", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

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
			"exchange",
			"market",
			"risk",
			"paper",
			"exchange-login",
		]);
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
