import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { distanceFrom, formatDistance, type MarketViewData, renderMarketChart } from "./renderer.ts";

const theme = { fg: (_color: string, text: string) => text };
const data: MarketViewData = {
	symbol: "BTC/USDT",
	timeframe: "1h",
	bias: "long",
	exchange: "okx",
	mode: "paper",
	ticker: { symbol: "BTC/USDT", last: 100, timestamp: 1 },
	candles: Array.from({ length: 8 }, (_, index) => ({
		timestamp: index,
		open: 95 + index,
		high: 101 + index,
		low: 94 + index,
		close: 100 + index,
		volume: 10,
	})),
	entryZone: { low: 98, high: 99 },
	waitZone: { low: 95, high: 97 },
	invalidation: 92,
	targets: [105, 110],
	rationale: "wait for a pullback into support",
	levels: [
		{ kind: "entry", price: 98, label: "Entry low" },
		{ kind: "entry", price: 99, label: "Entry high" },
		{ kind: "wait", price: 95, label: "Wait low" },
		{ kind: "wait", price: 97, label: "Wait high" },
		{ kind: "invalidation", price: 92, label: "Invalidation" },
		{ kind: "target", price: 105, label: "Target 1" },
		{ kind: "target", price: 110, label: "Target 2" },
	],
	positions: [],
	orders: [],
	createdAt: 1,
};

describe("market chart renderer", () => {
	it("calculates signed absolute and percentage distances", () => {
		expect(distanceFrom(100, 95)).toEqual({ price: 95, delta: -5, pct: -5 });
		expect(formatDistance(100, 105)).toContain("+5.00%");
	});

	it("renders a compact collapsed explanation", () => {
		const lines = renderMarketChart(data, 80, theme, false);
		expect(lines.join("\n")).toContain("Wait low");
		expect(lines.join("\n")).toContain("Why: wait for a pullback");
	});

	it("renders candles and scenario levels without exceeding the requested width", () => {
		const lines = renderMarketChart(data, 80, theme, true);
		expect(lines.join("\n")).toContain("Target 1");
		expect(lines.some((line) => line.includes("█") || line.includes("▓"))).toBe(true);
		expect(Math.max(...lines.map((line) => [...line].length))).toBeLessThanOrEqual(80);
	});

	it.each([20, 40, 80, 140])("preserves Chinese explanations and ANSI styles at %i columns", (width) => {
		const rationale = "等待价格回落后确认支撑是否有效，再判断是否入场。".repeat(3);
		const coloredTheme = { fg: (_color: string, text: string) => `\x1b[31m${text}\x1b[0m` };
		for (const expanded of [false, true]) {
			const lines = renderMarketChart({ ...data, rationale }, width, coloredTheme, expanded);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			const content = lines
				.map(stripVTControlCharacters)
				.map((line) => line.replace(/^[│┌└][─ ]?\s?/, "").trim())
				.join("");
			expect(content).toContain(rationale);
			expect(content).toContain("Invalidation: 92");
			expect(content).not.toContain("\x1b");
		}
	});

	it("only advertises manual view keys in a manual view", () => {
		expect(renderMarketChart(data, 100, theme, true, "manual").join("\n")).toContain("Esc / q: close");
		expect(renderMarketChart(data, 100, theme, false, "manual").join("\n")).toContain("e / Space: expand");
		expect(renderMarketChart(data, 100, theme, true).join("\n")).not.toContain("Esc");
		expect(renderMarketChart(data, 0, theme, true)).toEqual([]);
	});
});
