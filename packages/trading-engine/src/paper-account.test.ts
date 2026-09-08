import { describe, expect, it } from "vitest";
import { parsePaperAccount } from "./paper-account.ts";

const path = "/tmp/binance-USDT.json";

function validAccount(overrides: Record<string, unknown> = {}) {
	return {
		quote: "USDT",
		balances: { USDT: 10000 },
		entries: { BTC: { amount: 0.1, cost: 1000 } },
		orders: [],
		trades: [],
		realizedPnl: 0,
		createdAt: 1,
		...overrides,
	};
}

describe("parsePaperAccount", () => {
	it("accepts a ledger with createdAt, empty orders, and lots-less entries", () => {
		expect(parsePaperAccount(validAccount(), path)).toMatchObject({
			quote: "USDT",
			balances: { USDT: 10000 },
			entries: { BTC: { amount: 0.1, cost: 1000 } },
			orders: [],
			trades: [],
			realizedPnl: 0,
			createdAt: 1,
		});
	});

	it("accepts optional futures fields and drops unknown extras", () => {
		const parsed = parsePaperAccount(
			validAccount({
				leverage: 5,
				marginType: "isolated",
				positionMode: "one-way",
				extra: "ignored",
			}),
			path,
		);
		expect(parsed.leverage).toBe(5);
		expect(parsed.marginType).toBe("isolated");
		expect(parsed.positionMode).toBe("one-way");
		expect(parsed).not.toHaveProperty("extra");
	});

	it("rejects nested invalid orders", () => {
		expect(() =>
			parsePaperAccount(
				validAccount({
					orders: [
						{
							id: "1",
							symbol: "BTC/USDT",
							side: "buy",
							type: "not-a-type",
							amount: 1,
							filled: 0,
							cost: 0,
							status: "open",
							timestamp: 1,
						},
					],
				}),
				path,
			),
		).toThrow("Invalid paper account in /tmp/binance-USDT.json: orders[0].type is not a supported order type");
	});

	it("rejects non-finite balances", () => {
		expect(() => parsePaperAccount(validAccount({ balances: { USDT: Number.NaN } }), path)).toThrow(
			"balances must contain finite numbers",
		);
	});

	it("rejects negative or overfilled persisted orders", () => {
		const baseOrder = {
			id: "1",
			symbol: "BTC/USDT",
			side: "buy",
			type: "limit",
			amount: 1,
			filled: 0,
			cost: 0,
			status: "open",
			timestamp: 1,
		};
		expect(() => parsePaperAccount(validAccount({ orders: [{ ...baseOrder, amount: -1 }] }), path)).toThrow(
			"orders[0].amount must be positive",
		);
		expect(() => parsePaperAccount(validAccount({ orders: [{ ...baseOrder, filled: 2 }] }), path)).toThrow(
			"orders[0].filled cannot exceed amount",
		);
	});

	it("rejects negative persisted trade economics and inconsistent futures lots", () => {
		const trade = {
			id: "1",
			symbol: "BTC/USDT",
			side: "buy",
			price: 100,
			amount: 1,
			cost: 100,
			fee: -1,
			timestamp: 1,
		};
		expect(() => parsePaperAccount(validAccount({ trades: [trade] }), path)).toThrow(
			"trades[0].fee must be non-negative",
		);
		expect(() =>
			parsePaperAccount(
				validAccount({
					entries: {
						BTC: { amount: 2, cost: 200, lots: [{ amount: 1, price: 100, leverage: 1, marginType: "cross" }] },
					},
				}),
				path,
			),
		).toThrow("entries.BTC.lots amounts must equal the absolute entry amount");
	});
});
