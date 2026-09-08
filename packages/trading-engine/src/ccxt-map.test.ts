import ccxt, { type Order as CcxtOrder, type Ticker as CcxtTicker } from "ccxt";
import { describe, expect, it } from "vitest";
import { isUncertainSubmission, toOrder, toTicker } from "./ccxt-map.ts";

function ccxtOrder(overrides: Record<string, unknown> = {}): CcxtOrder {
	return {
		id: "101970248810",
		symbol: "DOGE/USDT:USDT",
		side: "buy",
		type: "market",
		status: "closed",
		amount: 63,
		filled: 63,
		remaining: 0,
		cost: 0,
		timestamp: 1,
		info: {},
		...overrides,
	} as unknown as CcxtOrder;
}

describe("isUncertainSubmission", () => {
	it("treats transport failures as uncertain even when the message is not a timeout", () => {
		expect(isUncertainSubmission(new Error("socket hang up"))).toBe(true);
		expect(isUncertainSubmission(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }))).toBe(true);
		expect(
			isUncertainSubmission(new ccxt.BadResponse("binance GET https://api.binance.com/api/v3/order 200 <html>")),
		).toBe(true);
		expect(isUncertainSubmission(new ccxt.DDoSProtection("binance 418"))).toBe(true);
		expect(isUncertainSubmission(new ccxt.RateLimitExceeded("Too many requests; -1003"))).toBe(true);
		expect(isUncertainSubmission(new ccxt.RequestTimeout("request timeout"))).toBe(true);
		expect(isUncertainSubmission(new Error("fetch failed"))).toBe(true);
	});

	it("treats explicit business rejections as certain", () => {
		expect(isUncertainSubmission(new ccxt.InsufficientFunds("not enough balance"))).toBe(false);
		expect(isUncertainSubmission(new ccxt.InvalidOrder("Filter failure: LOT_SIZE"))).toBe(false);
		expect(isUncertainSubmission(new ccxt.OrderImmediatelyFillable("Order would immediately trigger"))).toBe(false);
		expect(isUncertainSubmission(new ccxt.AuthenticationError("invalid API-key, IP, or permissions"))).toBe(false);
		expect(isUncertainSubmission(Object.assign(new Error("Account has insufficient balance"), { code: -2010 }))).toBe(
			false,
		);
		expect(isUncertainSubmission(Object.assign(new Error("Filter failure: PRICE_FILTER"), { code: -1013 }))).toBe(
			false,
		);
		expect(isUncertainSubmission(Object.assign(new Error("Order would immediately trigger."), { code: -2021 }))).toBe(
			false,
		);
		expect(isUncertainSubmission(new Error("HTTP 400 insufficient balance"))).toBe(false);
	});
});

describe("timestamp normalization", () => {
	it("does not treat the Unix epoch as a current market observation", () => {
		const before = Date.now();
		const ticker = toTicker({ symbol: "BTC/USDT", timestamp: 0, last: 100 } as unknown as CcxtTicker);
		const after = Date.now();

		expect(ticker.timestamp).toBeGreaterThanOrEqual(before);
		expect(ticker.timestamp).toBeLessThanOrEqual(after);
	});
});

describe("toOrder fill economics", () => {
	it("maps Binance USDM cumQuote and avgPrice when ccxt leaves cost at 0", () => {
		const order = toOrder(
			ccxtOrder({
				info: { executedQty: "63", cumQuote: "5.18457", avgPrice: "0.082295" },
			}),
			1,
			true,
		);
		expect(order.filled).toBe(63);
		expect(order.cost).toBe(5.18457);
		expect(order.average).toBe(0.082295);
	});

	it("derives quote cost from filled base and average when cumQuote is missing", () => {
		const order = toOrder(
			ccxtOrder({
				average: 50,
				filled: 2,
				amount: 2,
				info: {},
			}),
			10,
			true,
		);
		expect(order.filled).toBe(20);
		expect(order.cost).toBe(1000);
		expect(order.average).toBe(50);
	});

	it("derives average from cost and filled base", () => {
		const order = toOrder(
			ccxtOrder({
				info: { executedQty: "63", cumQuote: "5.18457" },
			}),
			1,
			true,
		);
		expect(order.cost).toBe(5.18457);
		expect(order.average).toBeCloseTo(5.18457 / 63);
	});

	it("keeps a real zero cost on unfilled orders", () => {
		const order = toOrder(
			ccxtOrder({
				status: "open",
				filled: 0,
				remaining: 63,
				cost: 0,
				info: { executedQty: "0", cumQuote: "0", avgPrice: "0.00000" },
			}),
			1,
			true,
		);
		expect(order.filled).toBe(0);
		expect(order.cost).toBe(0);
		expect(order.average).toBeUndefined();
	});

	it("prefers a positive ccxt cost over raw placeholders", () => {
		const order = toOrder(
			ccxtOrder({
				cost: 12.5,
				average: 0.1,
				info: { cumQuote: "1", avgPrice: "0.01" },
			}),
			1,
			true,
		);
		expect(order.cost).toBe(12.5);
		expect(order.average).toBe(0.1);
	});

	it("maps spot cummulativeQuoteQty when cost is a placeholder zero", () => {
		const order = toOrder(
			ccxtOrder({
				symbol: "BTC/USDT",
				amount: 0.001,
				filled: 0.001,
				remaining: 0,
				info: { origQty: "0.001", executedQty: "0.001", cummulativeQuoteQty: "42.5" },
			}),
			1,
			false,
		);
		expect(order.cost).toBe(42.5);
		expect(order.average).toBe(42500);
	});
});
