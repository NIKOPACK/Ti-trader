import { type ExtensionCommandContext, initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openTradingSettings, TradingSettingsPanel } from "../settings-menu.ts";
import * as state from "../state.ts";

const runtime = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../context.ts", () => ({ getTrading: () => runtime.get() }));

function fixture() {
	const config = { ...structuredClone(state.DEFAULT_CONFIG), language: "en-US" as const };
	const trading = {
		config,
		mode: "paper",
		patchConfig: vi.fn(async (_patch: { risk?: Partial<state.TradingConfig["risk"]> }) => {}),
		tradingEngine: { risk: { usage: () => ({ used: 0, limit: 2000 }) } },
	};
	runtime.get.mockReturnValue(trading);
	const done = vi.fn();
	const onStatus = vi.fn();
	const ctx = {
		mode: "tui",
		isIdle: () => true,
		waitForIdle: vi.fn(async () => {}),
		ui: { notify: vi.fn(), setEditorText: vi.fn(), custom: vi.fn() },
	} as unknown as ExtensionCommandContext;
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as ExtensionCommandContext["ui"]["theme"];
	const panel = new TradingSettingsPanel(theme, done, ctx, onStatus);
	return { trading, done, ctx, panel, onStatus };
}

describe("trading settings interactions", () => {
	beforeEach(() => {
		initTheme("dark", false);
		vi.spyOn(state, "loadExchangeKeys").mockReturnValue({});
	});
	afterEach(() => vi.restoreAllMocks());

	it("offers the TUI command from the settings navigation row", () => {
		const f = fixture();
		f.panel.handleInput("Agent TUI");
		f.panel.handleInput("\r");
		expect(f.done).toHaveBeenCalledWith({ type: "tui-settings" });
	});

	it("returns to the editor with the built-in settings command ready to run", async () => {
		const f = fixture();
		vi.mocked(f.ctx.ui.custom).mockResolvedValue({ type: "tui-settings" });
		await openTradingSettings(f.ctx, f.onStatus);
		expect(f.ctx.ui.setEditorText).toHaveBeenCalledWith("/tui-settings");
	});

	it("edits a risk limit through the existing runtime and marks observational rows read only", async () => {
		const f = fixture();
		f.panel.handleInput("Risk");
		f.panel.handleInput("\r");
		expect(f.panel.render(80).join("\n")).toContain("Read only");
		f.panel.handleInput("\x1b[B");
		f.panel.handleInput("\r");
		f.panel.handleInput("\x05");
		f.panel.handleInput("\x15");
		f.panel.handleInput("750");
		f.panel.handleInput("\r");
		await vi.waitFor(() => expect(f.trading.patchConfig).toHaveBeenCalledWith({ risk: { maxOrderNotional: 750 } }));
	});

	it("shows runtime validation failures and leaves the stored limit unchanged", async () => {
		const f = fixture();
		f.trading.patchConfig.mockRejectedValue(new Error("risk.maxOrderNotional must be positive"));
		f.panel.handleInput("Risk");
		f.panel.handleInput("\r");
		f.panel.handleInput("\x1b[B");
		f.panel.handleInput("\r");
		f.panel.handleInput("\x05");
		f.panel.handleInput("\x15");
		f.panel.handleInput("-1");
		f.panel.handleInput("\r");
		await vi.waitFor(() =>
			expect(f.ctx.ui.notify).toHaveBeenCalledWith("risk.maxOrderNotional must be positive", "error"),
		);
		expect(f.trading.config.risk.maxOrderNotional).toBe(500);
	});

	it("drops empty allowed-symbol tokens", async () => {
		const f = fixture();
		f.panel.handleInput("Risk");
		f.panel.handleInput("\r");
		f.panel.handleInput("\x1b[B");
		f.panel.handleInput("\x1b[B");
		f.panel.handleInput("\x1b[B");
		f.panel.handleInput("\x1b[B");
		f.panel.handleInput("\r");
		f.panel.handleInput("\x05");
		f.panel.handleInput("\x15");
		f.panel.handleInput("BTC/USDT,");
		f.panel.handleInput("\r");
		await vi.waitFor(() =>
			expect(f.trading.patchConfig).toHaveBeenCalledWith({ risk: { allowedSymbols: ["BTC/USDT"] } }),
		);
	});

	it("cancels an edit without changing risk configuration", () => {
		const f = fixture();
		f.panel.handleInput("Risk");
		f.panel.handleInput("\r");
		f.panel.handleInput("\x1b[B");
		f.panel.handleInput("\r");
		f.panel.handleInput("\x1b");
		expect(f.trading.patchConfig).not.toHaveBeenCalled();
	});

	it.each([20, 40, 80])("keeps settings and confirmation descriptions within %i columns", (width) => {
		const f = fixture();
		for (const line of f.panel.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		f.panel.handleInput("Trading mode");
		f.panel.handleInput("\r");
		f.panel.handleInput("\x1b[B");
		f.panel.handleInput("\r");
		for (const line of f.panel.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	});
});
