import { describe, expect, it } from "vitest";
import { formatTradingVenue } from "../venue.ts";

describe("formatTradingVenue", () => {
	it("shows paper market data as the configured exchange public feed", () => {
		expect(
			formatTradingVenue({
				language: "zh-CN",
				mode: "paper",
				exchangeId: "okx",
				marketType: "spot",
				quoteCurrency: "USDT",
			}),
		).toEqual({
			identity: "模拟盘  OKX  现货  USDT",
			source: "行情来源：OKX 公开接口",
		});
	});

	it("shows live orders and market data on the same exchange", () => {
		expect(
			formatTradingVenue({
				language: "en-US",
				mode: "live",
				exchangeId: "binance",
				marketType: "usdm-futures",
				quoteCurrency: "USDT",
				paused: true,
			}),
		).toEqual({
			identity: "LIVE  Binance  USDⓈ-M futures  USDT  PAUSED",
			source: "orders and market data: Binance",
		});
	});
});
