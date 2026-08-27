import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { padEndWidth, padStartWidth, renderTradingTable, type TableTheme } from "../table.ts";

const identityTheme: TableTheme = {
	fg: (_color, text) => text,
	bg: (_color, text) => text,
};

const tagTheme: TableTheme = {
	fg: (color, text) => `<${color}>${text}</>`,
	bg: (_color, text) => text,
};

function renderPlain(lines: Parameters<typeof renderTradingTable>[0]["lines"], width: number, title = "test") {
	return renderTradingTable({ title, lines }, identityTheme)
		.render(width)
		.map((line) => line.trimEnd());
}

describe("trading table renderer", () => {
	it("aligns all borders for mixed-length content including CJK", () => {
		const lines = renderPlain(
			["short", "a much longer line that sets the box width", "", "可用余额 冻结余额", "x"],
			80,
		);
		expect(lines[0]).toMatch(/^ ?╭─ TEST ─+╮$/);
		expect(lines.at(-1)).toMatch(/^ ?╰─+╯$/);
		const widths = lines.map((line) => visibleWidth(line));
		for (const w of widths) {
			expect(w).toBe(widths[0]);
		}
	});

	it("clamps the box to the terminal width and truncates overflow", () => {
		const lines = renderTradingTable({ title: "markets", lines: ["x".repeat(200)] }, identityTheme).render(40);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(40);
		}
	});

	it("renders the warning row inside the box", () => {
		const lines = renderTradingTable(
			{ title: "risk", lines: ["limit"], warning: "quota nearly exhausted" },
			identityTheme,
		).render(80);
		const warningRow = lines.find((line) => line.includes("quota nearly exhausted"));
		expect(warningRow).toBeDefined();
		expect(visibleWidth(warningRow!)).toBe(visibleWidth(lines[0]!));
	});

	it("colors explicit tones and legacy string heuristics", () => {
		const box = renderTradingTable(
			{
				title: "positions",
				lines: [
					{ text: "BTC up line", tone: "up" },
					{ text: "ETH down line", tone: "down" },
					{ text: "header", tone: "muted" },
					"legacy PnL -5.00 line",
				],
			},
			tagTheme,
		);
		const out = box.render(80).join("\n");
		expect(out).toContain("<success>BTC up line");
		expect(out).toContain("<error>ETH down line");
		expect(out).toContain("<borderMuted>header");
		expect(out).toContain("<error>legacy PnL -5.00 line");
	});
});

describe("width-aware padding", () => {
	it("pads CJK text by visible columns", () => {
		expect(padStartWidth("可用余额", 16)).toBe(`${" ".repeat(8)}可用余额`);
		expect(padEndWidth("资产", 8)).toBe(`资产${" ".repeat(4)}`);
	});
	it("leaves over-wide text untouched", () => {
		expect(padEndWidth("toolong", 3)).toBe("toolong");
	});
});
