import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { getThemeByName } from "../../../coding-agent/src/modes/interactive/theme/theme.ts";
import { formatTradingStatus, formatTradingVenue, renderTradingVenue, type TradingVenueInput } from "../venue.ts";

describe("formatTradingVenue", () => {
	it("shows paper market data as the configured exchange feed", () => {
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
			source: "行情来源：OKX",
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
			}),
		).toEqual({
			identity: "LIVE  Binance  USDⓈ-M futures  USDT",
			source: "orders and market data: Binance",
		});
	});
});

describe("trading venue status layout", () => {
	const input: TradingVenueInput = {
		language: "en-US",
		mode: "live",
		exchangeId: "binance",
		marketType: "usdm-futures",
		quoteCurrency: "USDT",
	};
	const plainTheme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		inverse: (text: string) => text,
	};
	const plain = (line: string) => stripVTControlCharacters(line).trim();
	const settled = { summary: "Entry blocks: none", tone: "muted", entryBlocked: false } as const;
	const blocked = {
		summary: "Entry blocks: unresolved executions",
		tone: "warning",
		entryBlocked: true,
		recoveryHint: "Inspect /recovery; do not resubmit orders.",
	} as const;

	it("renders a routine live venue as one identity row", () => {
		const lines = renderTradingVenue(input, plainTheme, 140, settled).map(plain);
		expect(lines).toEqual(["LIVE  Binance · USDⓈ-M futures · USDT"]);
	});

	it("drops the live feed source and the routine summary from the status area", () => {
		const text = renderTradingVenue(input, plainTheme, 140, settled).join("\n");
		expect(text).not.toContain("orders and market data");
		expect(text).not.toContain("Entry blocks");
	});

	it("shows unattended approval but hides the default confirm mode", () => {
		const unattended = renderTradingVenue({ ...input, orderApproval: "unattended" }, plainTheme, 140, settled).map(
			plain,
		);
		expect(unattended).toEqual(["LIVE  Binance · USDⓈ-M futures · USDT · Unattended"]);
		const confirm = renderTradingVenue({ ...input, orderApproval: "confirm" }, plainTheme, 140, settled).map(plain);
		expect(confirm).toEqual(["LIVE  Binance · USDⓈ-M futures · USDT"]);
	});

	it("reports entry blocks as one alert row ahead of the identity row", () => {
		const lines = renderTradingVenue(input, plainTheme, 140, blocked).map(plain);
		expect(lines).toEqual([
			"⚠ Entry blocks: unresolved executions  ·  Inspect /recovery; do not resubmit orders.  ·  /show health",
			"LIVE  Binance · USDⓈ-M futures · USDT",
		]);
	});

	it("alerts on untrusted health even when entry is not blocked", () => {
		const status = {
			summary: "Health unavailable: local trading state could not be trusted",
			tone: "error",
			entryBlocked: false,
		} as const;
		const lines = renderTradingVenue(input, plainTheme, 140, status).map(plain);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("⚠ Health unavailable");
		expect(lines[1]).toBe("LIVE  Binance · USDⓈ-M futures · USDT");
	});

	it.each(["en-US", "zh-CN"] as const)("preserves venue information when wrapping %s", (language) => {
		const status =
			language === "zh-CN" ? ({ summary: "开仓阻断：无", tone: "muted", entryBlocked: false } as const) : settled;
		for (const width of [1, 2, 20, 32, 40, 80, 140]) {
			const lines = renderTradingVenue({ ...input, language }, plainTheme, width, status);
			const text = lines.join("\n");
			expect(text).not.toContain("监控");
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			if (width >= 32) {
				expect(text).toContain("Binance");
				expect(text).toContain("USDT");
			}
		}
	});

	it("keeps the paper feed distinct from live execution", () => {
		const paperInput: TradingVenueInput = {
			language: "en-US",
			mode: "paper",
			exchangeId: "binance",
			marketType: "spot",
			quoteCurrency: "USDT",
		};
		const wide = renderTradingVenue(paperInput, plainTheme, 100, settled);
		expect(wide).toHaveLength(1);
		expect(plain(wide[0]).replace(/\s+/g, " ")).toBe("PAPER Binance · Spot · USDT public market data");
		const narrow = renderTradingVenue(paperInput, plainTheme, 40, settled);
		expect(narrow).toHaveLength(2);
		expect(narrow.map(plain)).toEqual(["PAPER  Binance · Spot · USDT", "public market data"]);
	});

	it.each(["light", "dark"])("uses semantic colors in the %s theme without overflowing", (name) => {
		const theme = getThemeByName(name);
		if (!theme) throw new Error(`Missing theme: ${name}`);
		const confirm = renderTradingVenue({ ...input, orderApproval: "confirm" }, theme, 140, settled).join("\n");
		expect(confirm).toContain(theme.inverse(theme.fg("text", " LIVE ")));
		expect(confirm).toContain(theme.bold(`\x1b[38;2;240;185;11mBinance\x1b[39m`));
		expect(confirm).not.toContain(theme.fg("warning", "Unattended"));
		const unattended = renderTradingVenue({ ...input, orderApproval: "unattended" }, theme, 140, settled).join("\n");
		expect(unattended).toContain(theme.inverse(theme.fg("error", " LIVE ")));
		expect(unattended).toContain(theme.fg("warning", "Unattended"));
		const paper = renderTradingVenue({ ...input, mode: "paper" }, theme, 140, settled).join("\n");
		expect(paper).toContain(theme.inverse(theme.fg("accent", " PAPER ")));
		const alert = renderTradingVenue(input, theme, 140, blocked).join("\n");
		expect(alert).toContain(theme.fg("warning", "⚠ Entry blocks: unresolved executions"));
		for (const width of [1, 2, 20, 40, 80, 140]) {
			for (const line of renderTradingVenue({ ...input, language: "zh-CN" }, theme, width, blocked)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				expect(stripVTControlCharacters(line)).not.toContain("\x1b");
			}
		}
		expect(renderTradingVenue(input, theme, 0)).toEqual([]);
	});

	it("mirrors the layout in the plain status widget without colors", () => {
		expect(formatTradingStatus(input, blocked)).toEqual([
			"⚠ Entry blocks: unresolved executions  ·  Inspect /recovery; do not resubmit orders.  ·  /show health",
			"[ LIVE ]  Binance  USDⓈ-M futures  USDT",
		]);
		expect(formatTradingStatus({ ...input, orderApproval: "unattended" }, settled)).toEqual([
			"[ LIVE ]  Binance  USDⓈ-M futures  USDT  Unattended",
		]);
		expect(formatTradingStatus({ ...input, orderApproval: "confirm" }, settled)).toEqual([
			"[ LIVE ]  Binance  USDⓈ-M futures  USDT",
		]);
		expect(
			formatTradingStatus(
				{ language: "en-US", mode: "paper", exchangeId: "okx", marketType: "spot", quoteCurrency: "USDT" },
				settled,
			),
		).toEqual(["[ PAPER ]  OKX  Spot  USDT  public market data"]);
	});

	it("renders the blocked alert without a recovery hint when none is set", () => {
		const status = { summary: "Entry blocks: none", tone: "warning", entryBlocked: true } as const;
		expect(renderTradingVenue(input, plainTheme, 140, status).map(plain)).toEqual([
			"⚠ Entry blocks: none  ·  /show health",
			"LIVE  Binance · USDⓈ-M futures · USDT",
		]);
	});
});
