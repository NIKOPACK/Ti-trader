import { beforeEach, describe, expect, it, vi } from "vitest";

const getTrading = vi.fn();
vi.mock("ti-trader", () => ({ getTrading }));

const { default: marketChartExtension } = await import("./index.ts");

function fakeTrading() {
	return {
		mode: "paper" as const,
		tradingEngine: { id: "test-exchange" },
		marketData: {
			getTicker: vi.fn(async () => ({ symbol: "BTC/USDT", last: 100, timestamp: Date.now() })),
			getKlines: vi.fn(async () => [
				{ timestamp: 1, open: 98, high: 102, low: 97, close: 100, volume: 10 },
				{ timestamp: 2, open: 100, high: 104, low: 99, close: 103, volume: 12 },
			]),
			getPositions: vi.fn(async () => []),
			getOpenOrders: vi.fn(async () => []),
		},
	};
}

type RegisteredTool = {
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: unknown,
	) => Promise<{ details?: unknown }>;
};

function register() {
	let tool: RegisteredTool | undefined;
	const appendEntry = vi.fn();
	const pi = {
		registerTool: vi.fn((definition) => {
			tool = definition as RegisteredTool;
		}),
		registerEntryRenderer: vi.fn(),
		registerCommand: vi.fn(),
		appendEntry,
	};
	marketChartExtension(pi as never);
	if (!tool) throw new Error("tool was not registered");
	return { tool, appendEntry };
}

describe("show_market_view", () => {
	beforeEach(() => {
		getTrading.mockReset();
	});

	it("reads a fake trading provider and appends a snapshot entry", async () => {
		getTrading.mockReturnValue(fakeTrading());
		const { tool, appendEntry } = register();
		const result = await tool.execute(
			"call-1",
			{
				symbol: "BTC/USDT",
				timeframe: "1h",
				bias: "long",
				entryZone: { low: 98, high: 99 },
				invalidation: 92,
				targets: [105],
				rationale: "support retest",
			},
			undefined,
			undefined,
			{ mode: "tui" } as never,
		);
		expect(appendEntry).toHaveBeenCalledWith(
			"market-view",
			expect.objectContaining({ symbol: "BTC/USDT", mode: "paper" }),
		);
		expect(result.details).toMatchObject({
			last: 100,
			levels: expect.arrayContaining([expect.objectContaining({ pct: 5 })]),
		});
	});

	it("rejects an invalid long invalidation before any market read", async () => {
		const trading = fakeTrading();
		getTrading.mockReturnValue(trading);
		const { tool, appendEntry } = register();
		await expect(
			tool.execute(
				"call-2",
				{
					symbol: "BTC/USDT",
					bias: "long",
					entryZone: { low: 98, high: 99 },
					invalidation: 100,
				},
				undefined,
				undefined,
				{ mode: "tui" } as never,
			),
		).rejects.toThrow("wrong side");
		expect(trading.marketData.getTicker).not.toHaveBeenCalled();
		expect(appendEntry).not.toHaveBeenCalled();
	});

	it("reports that rendering is unavailable outside TUI mode", async () => {
		const { tool } = register();
		await expect(
			tool.execute("call-3", { symbol: "BTC/USDT", bias: "neutral" }, undefined, undefined, {
				mode: "print",
			} as never),
		).rejects.toThrow("requires Ti TUI mode");
	});
});
