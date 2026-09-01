import { describe, expect, it } from "vitest";
import { type ExchangeClient, type PlaceOrderInput, timeframeDurationMs } from "./index.ts";

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
});
