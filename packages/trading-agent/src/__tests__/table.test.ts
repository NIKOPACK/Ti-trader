import { stripVTControlCharacters } from "node:util";
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

	it("wraps long content without discarding it", () => {
		const lines = renderTradingTable({ title: "markets", lines: ["x".repeat(200)] }, identityTheme).render(40);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(40);
		}
		expect(lines.join("").match(/x/g)).toHaveLength(200);
	});

	it.each([20, 40, 80, 140])("preserves labeled order fields and warnings at %i columns", (width) => {
		const fields = [
			{ label: "交易对", value: "BTC/USDT" },
			{ label: "盈亏", value: "+12.34 (1.00%)" },
			{ label: "触发价", value: "95,000.000000" },
			{ label: "订单编号", value: "order-12345678901234567890" },
		];
		const warning = "请核对订单状态，不要重复提交。";
		const box = renderTradingTable({ title: "订单", lines: [{ fields, tone: "up" }], warning }, identityTheme);
		const lines = box.render(width).map(stripVTControlCharacters);
		const content = lines
			.slice(1, -1)
			.map((line) => line.trim().slice(1, -1).trim())
			.join("")
			.replaceAll(" ", "");
		for (const field of fields) expect(content).toContain(`${field.label}:${field.value}`.replaceAll(" ", ""));
		expect(content).toContain(warning);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		box.invalidate();
		expect(box.render(width).map(stripVTControlCharacters)).toEqual(lines);
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
