import { describe, expect, it } from "vitest";
import { validateOrderInput } from "./order-input.ts";

const base = { symbol: "BTC/USDT", side: "buy" as const, type: "market" as const, amount: 1 };

describe("validateOrderInput", () => {
	it("returns execution metadata for a valid limit order", () => {
		expect(validateOrderInput({ ...base, type: "limit", price: 100 })).toEqual({
			isLimitExecution: true,
			isTrigger: false,
		});
	});

	it.each([
		[{ ...base, amount: 0 }, "Amount must be finite and positive"],
		[{ ...base, type: "limit" as const }, "limit orders require a finite positive price"],
		[{ ...base, type: "stop_market" as const }, "stop_market orders require a finite positive stopPrice"],
		[
			{ ...base, type: "trailing_stop_market" as const, trailingPercent: 100 },
			"trailing_stop_market orders require a finite trailingPercent between 0 and 100",
		],
	] as const)("rejects invalid exchange-independent fields", (input, message) => {
		expect(() => validateOrderInput(input)).toThrow(message);
	});
});
