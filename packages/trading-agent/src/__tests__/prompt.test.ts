import { describe, expect, it } from "vitest";
import { buildTradingPrompt } from "../prompt.ts";
import { DEFAULT_CONFIG, type TradingConfig } from "../state.ts";

function promptFor(overrides: Partial<TradingConfig>): string {
	return buildTradingPrompt({ ...DEFAULT_CONFIG, ...overrides });
}

describe("trading prompt", () => {
	it("describes both spot and futures without presenting the session as spot-only", () => {
		const prompt = promptFor({ exchange: "binance", marketType: "both" });

		expect(prompt).toContain("Binance spot and USDⓈ-M futures markets");
		expect(prompt).toContain("Market type: both");
		expect(prompt).toContain("never call it for a futures symbol");
	});

	it("states the futures OCO and Paper order limitations", () => {
		const prompt = promptFor({ exchange: "binance", marketType: "usdm-futures" });

		expect(prompt).toContain("OCO is rejected for futures");
		expect(prompt).toContain("Paper futures currently support market orders only");
		expect(prompt).toContain("Do not call place_oco for a futures symbol");
	});

	it("documents the actual get_klines candle shape and finality field", () => {
		const prompt = promptFor({ marketType: "spot" });

		expect(prompt).toContain("returns `candles` as {time, closed, open, high, low, close, volume} objects");
		expect(prompt).toContain("`closed=false`");
		expect(prompt).toContain("`closed=null` means finality is unknown");
	});
});
