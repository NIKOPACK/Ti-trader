import { describe, expect, it } from "vitest";
import { amountStepFromCcxtPrecision } from "./ccxt-precision.ts";

describe("amountStepFromCcxtPrecision", () => {
	it("treats TICK_SIZE integers as the lot step", () => {
		expect(amountStepFromCcxtPrecision(1, 4)).toBe(1);
		expect(amountStepFromCcxtPrecision(0.001, 4)).toBe(0.001);
	});

	it("treats DECIMAL_PLACES integers as a digit count", () => {
		expect(amountStepFromCcxtPrecision(0, 2)).toBe(1);
		expect(amountStepFromCcxtPrecision(1, 2)).toBe(0.1);
	});

	it("refuses unknown precision modes instead of guessing", () => {
		expect(amountStepFromCcxtPrecision(1, 3)).toBeUndefined();
		expect(amountStepFromCcxtPrecision(1, undefined)).toBeUndefined();
		expect(amountStepFromCcxtPrecision(undefined, 4)).toBeUndefined();
	});
});
