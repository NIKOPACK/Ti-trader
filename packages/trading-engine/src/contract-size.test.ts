import { describe, expect, it } from "vitest";
import { contractSizeForMarket } from "./contract-size.ts";

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
