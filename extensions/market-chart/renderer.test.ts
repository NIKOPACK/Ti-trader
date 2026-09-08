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
});
