import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchCandles, setMarketLabCandleProvider } from "../../../extensions/market-lab/index.ts";
import { installMarketLabSessionBridge, uninstallMarketLabSessionBridge } from "../src/market-lab-bridge.ts";

const trading = vi.hoisted(() => ({
	mode: "paper" as const,
	config: { quoteCurrency: "USDT" },
	tradingEngine: { id: "okx" },
	marketData: {
		getKlines: vi.fn(async () =>
			Array.from({ length: 21 }, (_, index) => ({
				timestamp: (index + 1) * 3_600_000,
				closed: index < 20,
				open: 100,
				high: 101,
				low: 99,
				close: 100,
				volume: 10,
			})),
		),
	},
}));

vi.mock("../src/context.ts", () => ({ getTrading: () => trading }));

afterEach(() => {
	uninstallMarketLabSessionBridge();
	setMarketLabCandleProvider(undefined);
	vi.clearAllMocks();
});

describe("market-lab session bridge", () => {
	it("feeds session klines into lab and stamps source", async () => {
		installMarketLabSessionBridge();
		const result = await fetchCandles({ symbol: "BTC/USDT", timeframe: "1h", limit: 20 });
		expect(trading.marketData.getKlines).toHaveBeenCalledWith("BTC/USDT", "1h", 21);
		expect(result.source).toEqual({
			venue: "okx",
			market: "spot",
			kind: "session-klines",
			mode: "paper",
		});
		expect(result.candles).toHaveLength(20);
	});

	it("accepts a futures session symbol", async () => {
		installMarketLabSessionBridge();
		const result = await fetchCandles({ symbol: "BTC/USDT:USDT", timeframe: "1h", limit: 20 });
		expect(trading.marketData.getKlines).toHaveBeenCalledWith("BTC/USDT:USDT", "1h", 21);
		expect(result.source.market).toBe("swap");
	});
});
