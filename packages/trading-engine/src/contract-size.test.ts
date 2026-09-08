import { describe, expect, it } from "vitest";
import { contractSizeForMarket, futuresAmountsEqual } from "./contract-size.ts";

describe("futuresAmountsEqual", () => {
	it.each([1e-14, 1, 1e14])("only tolerates arithmetic tails at scale %s", (scale) => {
		expect(futuresAmountsEqual(0.3 * scale - 0.1 * scale, 0.2 * scale)).toBe(true);
		expect(futuresAmountsEqual(0.2 * scale, 0.200001 * scale)).toBe(false);
		expect(futuresAmountsEqual(0, 0.2 * scale)).toBe(false);
	});

	it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
		"does not treat a non-finite amount %s as an arithmetic tail",
		(amount) => {
			expect(futuresAmountsEqual(amount, 1)).toBe(false);
			expect(futuresAmountsEqual(1, amount)).toBe(false);
		},
	);
});

describe("contractSizeForMarket", () => {
	it("rejects missing market metadata", () => {
		expect(() => contractSizeForMarket(undefined)).toThrow(/market metadata is unavailable/);
	});

	it("uses unit size 1 for spot markets", () => {
		expect(contractSizeForMarket({ contract: false })).toBe(1);
	});

	it("returns a finite positive linear contract size", () => {
		expect(contractSizeForMarket({ contract: true, linear: true, inverse: false, contractSize: 0.001 })).toBe(0.001);
	});

	it("rejects inverse or unidentified contracts", () => {
		expect(() => contractSizeForMarket({ contract: true, linear: false, inverse: true, contractSize: 1 })).toThrow(
			/linear USDⓈ-M/,
		);
		expect(() => contractSizeForMarket({ contract: true, contractSize: 1 })).toThrow(/linear USDⓈ-M/);
	});

	it("refuses to guess a missing contract size", () => {
		expect(() => contractSizeForMarket({ contract: true, linear: true, inverse: false })).toThrow(
			/contractSize is unavailable/,
		);
	});
});
