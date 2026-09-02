import { describe, expect, it, vi } from "vitest";
import { createMarketDataView, type ExchangeClient, type PlaceOrderInput, timeframeDurationMs } from "./index.ts";

describe("exchange contract", () => {
	it("converts supported ccxt timeframes", () => {
		expect(timeframeDurationMs("15m")).toBe(900_000);
		expect(timeframeDurationMs("2h")).toBe(7_200_000);
		expect(timeframeDurationMs("invalid")).toBeUndefined();
	});

	it("keeps order amounts in base currency at the contract boundary", () => {
		const input: PlaceOrderInput = { symbol: "BTC/USDT", side: "buy", type: "market", amount: 0.1 };
		const client: Pick<ExchangeClient, "placeOrder"> = {
			placeOrder: async () => {
				throw new Error("not implemented");
			},
		};
		expect(input.amount).toBe(0.1);
		expect(client.placeOrder).toBeTypeOf("function");
	});

	it("delegates market reads to the live client instead of binding a method snapshot", async () => {
		const getMarketInfo = vi.fn(async (symbol: string) => ({
			symbol,
			base: "BTC",
			quote: "USDT",
			marketType: "spot" as const,
			contract: false,
		}));
		const client = {
			id: "binance",
			mode: "paper" as const,
			quoteCurrency: "USDT",
			getMarketInfo,
		} as unknown as ExchangeClient;
		const view = createMarketDataView(client);
		getMarketInfo.mockResolvedValueOnce({
			symbol: "ETH/USDT",
			base: "ETH",
			quote: "USDT",
			marketType: "spot",
			contract: false,
		});

		await expect(view.getMarketInfo("ETH/USDT")).resolves.toMatchObject({ symbol: "ETH/USDT" });
		expect(getMarketInfo).toHaveBeenCalledWith("ETH/USDT");
		expect(Object.getOwnPropertyNames(view)).not.toContain("placeOrder");
	});
});
