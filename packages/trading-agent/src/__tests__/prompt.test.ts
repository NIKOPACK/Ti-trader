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

	it("allows reviewed preflight warnings but keeps unknown evidence blocking", () => {
		const prompt = promptFor({ exchange: "binance", marketType: "usdm-futures", mode: "live" });

		expect(prompt).toContain(
			'`status: "ok_with_warnings"` may continue only after you explicitly review and accept each warning',
		);
		expect(prompt).toContain("`rejected` and `unknown` block execution");
		expect(prompt).toContain("Live futures fee and maintenance-margin data are currently unavailable");
	});

	it("instructs the agent to use market-lab indicator and strategy tools", () => {
		const prompt = promptFor({ marketType: "spot" });

		expect(prompt).toContain("calculate_indicators");
		expect(prompt).toContain("evaluate_strategy");
		expect(prompt).toContain("Do not invent EMA/RSI/MACD/ATR values from raw klines");
		expect(prompt).toContain("named presets ema-cross (default), rsi-revert, macd-hist");
		expect(prompt).toContain("never treat bias as permission to trade");
		expect(prompt).toContain("screen_markets");
		expect(prompt).toContain("simulate_rule");
		expect(prompt).toContain("closed-candle replay, not a backtest");
	});

	it("treats trigger fires as observations rather than live trading authorization", () => {
		const prompt = promptFor({ mode: "live" });

		expect(prompt).toContain("A [trigger:id] message is an observation, not trading authorization");
		expect(prompt).toContain("Live sessions never auto-wake from triggers");
		expect(prompt).toContain("/risk reconcile");
	});

	it("states futures amount units and Binance close-all quantity semantics", () => {
		const prompt = promptFor({ exchange: "binance", marketType: "usdm-futures" });

		expect(prompt).toContain("Futures agent amounts are always base currency");
		expect(prompt).toContain("exchange amount and amount limits are contracts");
		expect(prompt).toContain("Never assume contractSize=1");
		expect(prompt).toContain("stop_market/take_profit_market close-all orders use closePosition");
		expect(prompt).toContain("a returned amount of 0 can mean the exchange omitted quantity");
	});
});
