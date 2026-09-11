import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { getThemeByName } from "../../../coding-agent/src/modes/interactive/theme/theme.ts";
import { formatTradingVenue, renderTradingVenue, type TradingVenueInput } from "../venue.ts";

describe("formatTradingVenue", () => {
	it("shows paper market data as the configured exchange public feed", () => {
		expect(
			formatTradingVenue({
				language: "zh-CN",
				mode: "paper",
				exchangeId: "okx",
				marketType: "spot",
				quoteCurrency: "USDT",
			}),
		).toEqual({
			identity: "模拟盘  OKX  现货  USDT",
			source: "行情来源：OKX 公开接口",
		});
	});

	describe("trading venue layout", () => {
		const input: TradingVenueInput = {
			language: "en-US",
			mode: "live",
			exchangeId: "binance",
			marketType: "usdm-futures",
			quoteCurrency: "USDT",
			paused: true,
		};
		const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

		it("aligns the source to the right on wide terminals", () => {
			const lines = renderTradingVenue(input, plainTheme, 140);
			expect(lines).toHaveLength(1);
			expect(lines[0].startsWith(" [ LIVE ]  [ PAUSED ]  |  Binance")).toBe(true);
			expect(lines[0]).toMatch(/orders and market data: Binance $/);
			expect(visibleWidth(lines[0])).toBe(140);
		});

		it("keeps the pause next to the mode and moves the source to its own line", () => {
			const lines = renderTradingVenue(input, plainTheme, 80).map((line) => line.trim());
			expect(lines).toEqual([
				"[ LIVE ]  [ PAUSED ]  |  Binance  |  USDⓈ-M futures  USDT",
				"orders and market data: Binance",
			]);
		});

		it.each(["en-US", "zh-CN"] as const)("preserves venue information when wrapping %s", (language) => {
			const lines = renderTradingVenue({ ...input, language }, plainTheme, 32);
			const text = lines.join("\n");
			expect(text).toContain(language === "zh-CN" ? "[ 已暂停 ]" : "[ PAUSED ]");
			expect(text).toContain("Binance");
			expect(text).toContain("USDⓈ-M");
			expect(text).toContain("USDT");
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(32);
		});

		it("keeps the paper feed distinct from live execution", () => {
			const text = renderTradingVenue({ ...input, mode: "paper", paused: false }, plainTheme, 100).join("\n");
			expect(text).toContain("[ PAPER ]");
			expect(text).toContain("market data: Binance public");
			expect(text).not.toContain("PAUSED");
			expect(text).not.toContain("orders and market data");
		});

		it.each(["light", "dark"])("uses semantic colors in the %s theme without overflowing", (name) => {
			const theme = getThemeByName(name);
			if (!theme) throw new Error(`Missing theme: ${name}`);
			const wide = renderTradingVenue(input, theme, 140).join("\n");
			expect(wide).toContain(theme.bold(theme.fg("error", "[ LIVE ]")));
			expect(wide).toContain(theme.bold(theme.fg("warning", "[ PAUSED ]")));
			expect(wide).toContain(theme.fg("text", "Binance"));
			for (const width of [1, 2, 20, 40, 80, 140]) {
				for (const line of renderTradingVenue({ ...input, language: "zh-CN" }, theme, width)) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width);
					expect(stripVTControlCharacters(line)).not.toContain("\x1b");
				}
			}
			expect(renderTradingVenue(input, theme, 0)).toEqual([]);
		});
	});

	it("shows live orders and market data on the same exchange", () => {
		expect(
			formatTradingVenue({
				language: "en-US",
				mode: "live",
				exchangeId: "binance",
				marketType: "usdm-futures",
				quoteCurrency: "USDT",
				paused: true,
			}),
		).toEqual({
			identity: "LIVE  Binance  USDⓈ-M futures  USDT  PAUSED",
			source: "orders and market data: Binance",
		});
	});
});
