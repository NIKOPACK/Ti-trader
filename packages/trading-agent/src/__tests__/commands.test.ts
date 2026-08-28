import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

const trading = vi.hoisted(() => ({
	mode: "paper" as const,
	config: {
		language: "en-US" as const,
		exchange: "okx",
		marketType: "spot" as const,
		quoteCurrency: "USDT",
		confirmLiveOrders: true,
	},
	setMode: vi.fn(async (_mode: "paper" | "live") => {}),
}));

vi.mock("../context.ts", () => ({ getTrading: () => trading }));
vi.mock("../table.ts", () => ({
	padEndWidth: (value: string) => value,
	padStartWidth: (value: string) => value,
	renderTradingTable: vi.fn(),
}));

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

function commandContext(idle: boolean): ExtensionCommandContext {
	return {
		isIdle: vi.fn(() => idle),
		waitForIdle: vi.fn(async () => {}),
		ui: {
			notify: vi.fn(),
			setStatus: vi.fn(),
		},
	} as unknown as ExtensionCommandContext;
}

describe("trading commands", () => {
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
});
