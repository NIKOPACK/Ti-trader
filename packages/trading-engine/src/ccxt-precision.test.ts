import { describe, expect, it } from "vitest";
import { amountStepFromCcxtPrecision, truncateToAmountStep } from "./ccxt-precision.ts";

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

describe("truncateToAmountStep", () => {
	it("truncates like ccxt amountToPrecision instead of rounding", () => {
		expect(truncateToAmountStep(0.00025, 0.0001)).toBe(0.0002);
		expect(truncateToAmountStep(25 / 108_234.56, 0.0001)).toBe(0.0002);
		expect(truncateToAmountStep(0.0002, 0.0001)).toBe(0.0002);
	});

	it("rejects amounts that fall below one lot", () => {
		expect(truncateToAmountStep(0.00004, 0.0001)).toBeUndefined();
		expect(truncateToAmountStep(0, 0.0001)).toBeUndefined();
	});
});
