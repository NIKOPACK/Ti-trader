import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PaperExchangeClient } from "../exchange/paper-client.ts";

/** Controllable stand-in for the ccxt exchange used by PaperExchangeClient. */
class StubExchange {
	last = 100;
	amountDigits = 4;
	priceDigits = 2;
	amountMin: number | undefined = 0.0001;
	amountMax: number | undefined;
	costMin: number | undefined = 5;
	costMax: number | undefined;
	/** OHLCV rows returned by fetchOHLCV: [timestamp, open, high, low, close, volume]. */
	ohlcv: number[][] = [];

	async fetchTicker(symbol: string) {
		return { symbol, last: this.last, bid: this.last, ask: this.last, timestamp: Date.now() };
	}

	async fetchOHLCV(_symbol: string, _timeframe: string, _since?: number, _limit?: number) {
		return this.ohlcv;
	}

	async fetchOrderBook(symbol: string, _limit?: number) {
		return { symbol, timestamp: Date.now(), bids: [[99, 2]], asks: [[101, 3]] };
	}

	markets: Record<string, unknown> = {};

	async loadMarkets() {
		const limits = {
			amount: { min: this.amountMin, max: this.amountMax },
			cost: { min: this.costMin, max: this.costMax },
		};
		this.markets = {
			"BTC/USDT": {
				symbol: "BTC/USDT",
				base: "BTC",
				quote: "USDT",
				spot: true,
				contract: false,
				active: true,
				precision: { price: 0.01, amount: 0.0001 },
				limits,
			},
			"BTC/USDT:USDT": {
				symbol: "BTC/USDT:USDT",
				base: "BTC",
				quote: "USDT",
				settle: "USDT",
				spot: false,
				swap: true,
				contract: true,
				active: true,
				precision: { price: 0.01, amount: 0.0001 },
				limits,
			},
		};
	}

	amountToPrecision(_symbol: string, amount: number): string {
		return amount.toFixed(this.amountDigits);
	}

	priceToPrecision(_symbol: string, price: number): string {
		return price.toFixed(this.priceDigits);
	}

	async close() {}
}

let dir: string;
let stub: StubExchange;
let client: PaperExchangeClient;

function newClient(): PaperExchangeClient {
	const c = new PaperExchangeClient("okx", "USDT", 10_000, 0.001, dir);
	(c as unknown as { exchange: StubExchange }).exchange = stub;
	return c;
}

function newFuturesClient(positionMode: "one-way" | "hedge" = "hedge"): PaperExchangeClient {
	const c = new PaperExchangeClient("okx", "USDT", 10_000, 0.001, dir, "usdm-futures", 5, "isolated", positionMode);
	(c as unknown as { exchange: StubExchange }).exchange = stub;
	(c as unknown as { futuresExchange: StubExchange }).futuresExchange = stub;
	return c;
}

async function buyBase(amount: number): Promise<void> {
	await client.placeOrder({ symbol: "BTC/USDT", side: "buy", type: "market", amount });
}

async function freeBalance(asset: string): Promise<number> {
	const balances = await client.getBalances();
	return balances.find((b) => b.asset === asset)?.free ?? 0;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ti-paper-"));
	stub = new StubExchange();
	client = newClient();
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("paper both-market mode", () => {
	it("routes futures orders to an isolated paper account", async () => {
		const both = new PaperExchangeClient("okx", "USDT", 10_000, 0.001, dir, "both");
		(both as unknown as { exchange: StubExchange }).exchange = stub;
		(both as unknown as { futuresExchange: StubExchange }).futuresExchange = stub;
		await both.setLeverage("BTC/USDT:USDT", 5);
		const order = await both.placeOrder({ symbol: "BTC/USDT:USDT", side: "buy", type: "market", amount: 0.1 });
		expect(order.order.symbol).toBe("BTC/USDT:USDT");
		expect((await both.getPositions())[0]?.positionSide).toBe("LONG");
		await expect(both.placeOrder({ symbol: "BTC/USDT", side: "sell", type: "market", amount: 1 })).rejects.toThrow(
			/Insufficient/,
		);
		await both.close();
	});
});

describe("paper futures hedge ledger", () => {
	const symbol = "BTC/USDT:USDT";

	it("tracks LONG and SHORT positions independently", async () => {
		const futures = newFuturesClient();
		await futures.placeOrder({ symbol, side: "buy", type: "market", amount: 2, positionSide: "LONG" });
		await futures.placeOrder({ symbol, side: "sell", type: "market", amount: 3, positionSide: "SHORT" });

		const positions = await futures.getPositions();
		expect(positions).toHaveLength(2);
		expect(positions.find((position) => position.positionSide === "LONG")).toMatchObject({
			amount: 2,
			avgEntryPrice: 100,
		});
		expect(positions.find((position) => position.positionSide === "SHORT")).toMatchObject({
			amount: 3,
			avgEntryPrice: 100,
		});
	});

	it("rejects flat, increasing, and oversized reduce-only orders", async () => {
		const futures = newFuturesClient();
		await expect(
			futures.placeOrder({
				symbol,
				side: "sell",
				type: "market",
				amount: 1,
				positionSide: "LONG",
				reduceOnly: true,
			}),
		).rejects.toThrow(/requires an open futures position/);

		await futures.placeOrder({ symbol, side: "buy", type: "market", amount: 1, positionSide: "LONG" });
		await expect(
			futures.placeOrder({
				symbol,
				side: "buy",
				type: "market",
				amount: 0.5,
				positionSide: "LONG",
				reduceOnly: true,
			}),
		).rejects.toThrow(/cannot increase the position/);
		await expect(
			futures.placeOrder({
				symbol,
				side: "sell",
				type: "market",
				amount: 2,
				positionSide: "LONG",
				reduceOnly: true,
			}),
		).rejects.toThrow(/exceeds the open position/);
	});

	it("reduces entry cost proportionally on a partial close", async () => {
		const futures = newFuturesClient();
		await futures.placeOrder({ symbol, side: "buy", type: "market", amount: 2, positionSide: "LONG" });

		stub.last = 120;
		await futures.placeOrder({
			symbol,
			side: "sell",
			type: "market",
			amount: 0.5,
			positionSide: "LONG",
			reduceOnly: true,
		});

		const position = (await futures.getPositions()).find((candidate) => candidate.positionSide === "LONG");
		expect(position).toMatchObject({ amount: 1.5, avgEntryPrice: 100, margin: 30, unrealizedPnl: 30 });
	});
});

describe("paper market data", () => {
	it("returns order book depth and market rules", async () => {
		const book = await client.getOrderBook("BTC/USDT");
		expect(book.bids[0]).toEqual({ price: 99, amount: 2 });
		expect(book.spread).toBe(2);
		const info = await client.getMarketInfo("BTC/USDT");
		expect(info.marketType).toBe("spot");
		expect(info.minNotional).toBe(5);
	});

	it("marks only completed candles as closed", async () => {
		const now = Date.now();
		stub.ohlcv = [
			[now - 120_000, 90, 105, 85, 100, 10],
			[now - 30_000, 100, 110, 95, 105, 8],
		];

		const candles = await client.getKlines("BTC/USDT", "1m", 2);
		expect(candles.map((candle) => candle.closed)).toEqual([true, false]);
	});

	it("leaves candle completion unknown for unsupported timeframes", async () => {
		stub.ohlcv = [[1, 90, 105, 85, 100, 10]];

		const candles = await client.getKlines("BTC/USDT", "custom", 1);

		expect(candles[0]?.closed).toBeUndefined();
	});
});

describe("paper order normalization", () => {
	it("uses exchange amount and price precision before reserving an order", async () => {
		stub.amountDigits = 3;
		stub.priceDigits = 1;

		const { order } = await client.placeOrder({
			symbol: "BTC/USDT",
			side: "buy",
			type: "limit",
			amount: 1.23456,
			price: 90.04,
		});

		expect(order).toMatchObject({ amount: 1.235, price: 90 });
	});

	it("enforces rounded amount and notional limits", async () => {
		stub.amountDigits = 3;
		await expect(
			client.placeOrder({ symbol: "BTC/USDT", side: "buy", type: "market", amount: 0.0004 }),
		).rejects.toThrow(/rounds to zero/);

		stub.amountMin = 0.01;
		await expect(
			client.placeOrder({ symbol: "BTC/USDT", side: "buy", type: "market", amount: 0.005 }),
		).rejects.toThrow(/below minimum/);

		stub.amountMin = 0.0001;
		stub.amountMax = 1;
		await expect(client.placeOrder({ symbol: "BTC/USDT", side: "buy", type: "market", amount: 2 })).rejects.toThrow(
			/exceeds maximum/,
		);

		stub.amountMax = undefined;
		stub.costMin = 5;
		await expect(
			client.placeOrder({ symbol: "BTC/USDT", side: "buy", type: "market", amount: 0.01 }),
		).rejects.toThrow(/cost .* below minimum/);

		stub.costMin = 0;
		stub.costMax = 150;
		await expect(client.placeOrder({ symbol: "BTC/USDT", side: "buy", type: "market", amount: 2 })).rejects.toThrow(
			/cost .* exceeds maximum/,
		);
	});
});

describe("paper stop-loss / take-profit orders", () => {
	it("fills a stop_market sell (stop-loss) when the price falls to the trigger", async () => {
		await buyBase(1);
		await client.placeOrder({ symbol: "BTC/USDT", side: "sell", type: "stop_market", amount: 1, stopPrice: 90 });

		stub.last = 95;
		expect(await client.getOpenOrders()).toHaveLength(1);

		stub.last = 89;
		const open = await client.getOpenOrders();
		expect(open).toHaveLength(0);
		const history = await client.getOrderHistory("BTC/USDT");
		const stop = history.find((o) => o.type === "stop_market");
		expect(stop?.status).toBe("closed");
		expect(stop?.average).toBe(90);
		expect(await freeBalance("BTC")).toBe(0);
	});

	it("fills a take_profit_market sell when the price rises to the trigger", async () => {
		await buyBase(1);
		await client.placeOrder({
			symbol: "BTC/USDT",
			side: "sell",
			type: "take_profit_market",
			amount: 1,
			stopPrice: 120,
		});

		stub.last = 119;
		expect(await client.getOpenOrders()).toHaveLength(1);

		stub.last = 121;
		expect(await client.getOpenOrders()).toHaveLength(0);
		const history = await client.getOrderHistory("BTC/USDT");
		expect(history.find((o) => o.type === "take_profit_market")?.average).toBe(120);
	});

	it("converts a triggered stop (limit) sell into a resting limit order and fills it", async () => {
		await buyBase(1);
		await client.placeOrder({
			symbol: "BTC/USDT",
			side: "sell",
			type: "stop",
			amount: 1,
			stopPrice: 90,
			price: 88,
		});

		// Trigger fires and, with last (89) above the 88 limit, fills in the same pass.
		stub.last = 89;
		expect(await client.getOpenOrders()).toHaveLength(0);
		const history = await client.getOrderHistory("BTC/USDT");
		expect(history.find((o) => o.type === "stop")?.average).toBe(88);
	});

	it("fills a stop_market buy (breakout entry) when the price rises to the trigger", async () => {
		await client.placeOrder({ symbol: "BTC/USDT", side: "buy", type: "stop_market", amount: 1, stopPrice: 110 });
		// 10000 - 110 * 1.001 (reserved incl. fee)
		expect(await freeBalance("USDT")).toBeCloseTo(10_000 - 110 * 1.001, 6);

		stub.last = 111;
		expect(await client.getOpenOrders()).toHaveLength(0);
		expect(await freeBalance("BTC")).toBe(1);
	});

	it("rejects orders that would trigger immediately", async () => {
		await buyBase(1);
		await expect(
			client.placeOrder({ symbol: "BTC/USDT", side: "sell", type: "stop_market", amount: 1, stopPrice: 105 }),
		).rejects.toThrow(/trigger immediately/);
		await expect(
			client.placeOrder({ symbol: "BTC/USDT", side: "sell", type: "take_profit_market", amount: 1, stopPrice: 95 }),
		).rejects.toThrow(/trigger immediately/);
	});

	it("releases the reservation when a trigger order is cancelled", async () => {
		await buyBase(1);
		const placed = await client.placeOrder({
			symbol: "BTC/USDT",
			side: "sell",
			type: "stop_market",
			amount: 1,
			stopPrice: 90,
		});
		expect(await freeBalance("BTC")).toBe(0);
		await client.cancelOrder(placed.order.id, "BTC/USDT");
		expect(await freeBalance("BTC")).toBe(1);
	});

	it("rejects futures-only parameters in paper mode", async () => {
		await expect(
			client.placeOrder({ symbol: "BTC/USDT", side: "buy", type: "market", amount: 1, reduceOnly: true }),
		).rejects.toThrow(/futures-only/);
	});
});

describe("paper trailing stop orders", () => {
	it("trails the peak and fills on the configured pullback", async () => {
		await buyBase(1);
		await client.placeOrder({
			symbol: "BTC/USDT",
			side: "sell",
			type: "trailing_stop_market",
			amount: 1,
			trailingPercent: 5,
		});

		// Price climbs; each read advances the tracked peak.
		stub.last = 110;
		expect(await client.getOpenOrders()).toHaveLength(1);
		stub.last = 120;
		expect(await client.getOpenOrders()).toHaveLength(1);

		// 3% pullback from the 120 peak: still holding.
		stub.last = 116.5;
		expect(await client.getOpenOrders()).toHaveLength(1);

		// 5% pullback from the peak: stop fires at 120 * 0.95 = 114.
		stub.last = 113;
		expect(await client.getOpenOrders()).toHaveLength(0);
		const history = await client.getOrderHistory("BTC/USDT");
		expect(history.find((o) => o.type === "trailing_stop_market")?.average).toBeCloseTo(114, 8);
	});

	it("backfills the peak from klines between account reads", async () => {
		await buyBase(1);
		const placed = await client.placeOrder({
			symbol: "BTC/USDT",
			side: "sell",
			type: "trailing_stop_market",
			amount: 1,
			trailingPercent: 5,
		});

		// Simulate a long gap since placement so the kline backfill path runs:
		// the peak of 130 was never observed via a ticker read.
		const orders = (
			client as unknown as {
				account: { orders: Array<{ id: string; timestamp: number; lastCheckedAt?: number }> };
			}
		).account.orders;
		const order = orders.find((o) => o.id === placed.order.id);
		if (!order) throw new Error("order not found");
		order.timestamp = Date.now() - 10 * 60_000;
		order.lastCheckedAt = order.timestamp;
		stub.ohlcv = [
			[order.timestamp + 60_000, 100, 125, 99, 124, 1],
			[order.timestamp + 120_000, 124, 130, 122, 129, 1],
		];

		stub.last = 122;
		expect(await client.getOpenOrders()).toHaveLength(0);
		const history = await client.getOrderHistory("BTC/USDT");
		// Stop level derives from the kline peak: 130 * 0.95 = 123.5.
		expect(history.find((o) => o.type === "trailing_stop_market")?.average).toBeCloseTo(123.5, 8);
	});

	it("reserves quote funds for a trailing buy at the placement stop level", async () => {
		await client.placeOrder({
			symbol: "BTC/USDT",
			side: "buy",
			type: "trailing_stop_market",
			amount: 1,
			trailingPercent: 10,
		});
		// Initial stop level 100 * 1.10 = 110, reserved incl. fee.
		expect(await freeBalance("USDT")).toBeCloseTo(10_000 - 110 * 1.001, 6);

		// Price falls; the trough and stop level follow it down.
		stub.last = 80;
		expect(await client.getOpenOrders()).toHaveLength(1);

		// Rebound of 10% from the 80 trough fires the stop at 88.
		stub.last = 88.5;
		expect(await client.getOpenOrders()).toHaveLength(0);
		expect(await freeBalance("BTC")).toBe(1);
		const history = await client.getOrderHistory("BTC/USDT");
		expect(history.find((o) => o.type === "trailing_stop_market")?.average).toBeCloseTo(88, 8);
	});

	it("rejects invalid trailing parameters", async () => {
		await buyBase(1);
		await expect(
			client.placeOrder({ symbol: "BTC/USDT", side: "sell", type: "trailing_stop_market", amount: 1 }),
		).rejects.toThrow(/trailingPercent/);
		await expect(
			client.placeOrder({
				symbol: "BTC/USDT",
				side: "sell",
				type: "trailing_stop_market",
				amount: 1,
				trailingPercent: 5,
				stopPrice: 120,
			}),
		).rejects.toThrow(/not supported in paper mode/);
	});
});

function rewindOrder(id: string, minutes: number): number {
	const orders = (
		client as unknown as {
			account: { orders: Array<{ id: string; timestamp: number; lastCheckedAt?: number }> };
		}
	).account.orders;
	const order = orders.find((o) => o.id === id);
	if (!order) throw new Error(`order ${id} not found`);
	order.timestamp = Date.now() - minutes * 60_000;
	order.lastCheckedAt = order.timestamp;
	return order.timestamp;
}

describe("paper OCO bracket orders", () => {
	it("fills the take-profit leg on a rise and cancels the stop-loss leg", async () => {
		await buyBase(1);
		const { orders } = await client.placeOcoOrder({
			symbol: "BTC/USDT",
			side: "sell",
			amount: 1,
			stopLossPrice: 90,
			takeProfitPrice: 120,
		});
		expect(orders).toHaveLength(2);
		expect(orders[0].ocoGroup).toBe(orders[1].ocoGroup);

		// Base is reserved once, not per leg.
		const balances = await client.getBalances();
		const btc = balances.find((b) => b.asset === "BTC");
		expect(btc?.used).toBe(1);
		expect(btc?.free).toBe(0);

		stub.last = 121;
		expect(await client.getOpenOrders()).toHaveLength(0);
		const history = await client.getOrderHistory("BTC/USDT");
		expect(history.find((o) => o.type === "take_profit_market")?.status).toBe("closed");
		expect(history.find((o) => o.type === "take_profit_market")?.average).toBe(120);
		expect(history.find((o) => o.type === "stop_market")?.status).toBe("canceled");
		expect(await freeBalance("BTC")).toBe(0);
	});

	it("fills the stop-loss leg on a fall and cancels the take-profit leg", async () => {
		await buyBase(1);
		await client.placeOcoOrder({
			symbol: "BTC/USDT",
			side: "sell",
			amount: 1,
			stopLossPrice: 90,
			takeProfitPrice: 120,
		});
		stub.last = 89;
		expect(await client.getOpenOrders()).toHaveLength(0);
		const history = await client.getOrderHistory("BTC/USDT");
		expect(history.find((o) => o.type === "stop_market")?.average).toBe(90);
		expect(history.find((o) => o.type === "take_profit_market")?.status).toBe("canceled");
	});

	it("cancels the whole group and releases the reservation once when one leg is cancelled", async () => {
		await buyBase(1);
		const { orders } = await client.placeOcoOrder({
			symbol: "BTC/USDT",
			side: "sell",
			amount: 1,
			stopLossPrice: 90,
			takeProfitPrice: 120,
		});
		await client.cancelOrder(orders[0].id, "BTC/USDT");
		expect(await client.getOpenOrders()).toHaveLength(0);
		expect(await freeBalance("BTC")).toBe(1);
	});

	it("rejects triggers on the wrong side of the market", async () => {
		await buyBase(1);
		await expect(
			client.placeOcoOrder({
				symbol: "BTC/USDT",
				side: "sell",
				amount: 1,
				stopLossPrice: 110,
				takeProfitPrice: 120,
			}),
		).rejects.toThrow(/below the last price/);
		await expect(
			client.placeOcoOrder({ symbol: "BTC/USDT", side: "sell", amount: 1, stopLossPrice: 90, takeProfitPrice: 95 }),
		).rejects.toThrow(/above the last price/);
	});

	it("reserves a buy OCO at the worst-case leg and refunds the surplus on fill", async () => {
		await client.placeOcoOrder({
			symbol: "BTC/USDT",
			side: "buy",
			amount: 1,
			stopLossPrice: 120,
			takeProfitPrice: 80,
		});
		// Reserved at max(120, 80) incl. fee.
		expect(await freeBalance("USDT")).toBeCloseTo(10_000 - 120 * 1.001, 6);

		stub.last = 79;
		expect(await client.getOpenOrders()).toHaveLength(0);
		expect(await freeBalance("BTC")).toBe(1);
		// Filled at 80: full reservation released, actual cost deducted.
		expect(await freeBalance("USDT")).toBeCloseTo(10_000 - 80 * 1.001, 6);
	});

	it("prefers the stop-loss leg when one candle crosses both triggers", async () => {
		await buyBase(1);
		const { orders } = await client.placeOcoOrder({
			symbol: "BTC/USDT",
			side: "sell",
			amount: 1,
			stopLossPrice: 90,
			takeProfitPrice: 120,
		});
		const since = rewindOrder(orders[0].id, 10);
		rewindOrder(orders[1].id, 10);
		stub.ohlcv = [[since + 60_000, 100, 130, 85, 100, 1]];

		stub.last = 100;
		expect(await client.getOpenOrders()).toHaveLength(0);
		const history = await client.getOrderHistory("BTC/USDT");
		expect(history.find((o) => o.type === "stop_market")?.average).toBe(90);
		expect(history.find((o) => o.type === "take_profit_market")?.status).toBe("canceled");
	});
});

describe("kline backfill for resting orders", () => {
	it("fills a stop_market sell from an intra-gap dip even after the price recovers", async () => {
		await buyBase(1);
		const placed = await client.placeOrder({
			symbol: "BTC/USDT",
			side: "sell",
			type: "stop_market",
			amount: 1,
			stopPrice: 90,
		});
		const since = rewindOrder(placed.order.id, 10);
		stub.ohlcv = [[since + 60_000, 100, 101, 85, 100, 1]];

		stub.last = 100; // recovered by the time we look
		expect(await client.getOpenOrders()).toHaveLength(0);
		const history = await client.getOrderHistory("BTC/USDT");
		expect(history.find((o) => o.type === "stop_market")?.average).toBe(90);
	});

	it("fills a resting limit sell from an intra-gap wick", async () => {
		await buyBase(1);
		const placed = await client.placeOrder({
			symbol: "BTC/USDT",
			side: "sell",
			type: "limit",
			amount: 1,
			price: 120,
		});
		const since = rewindOrder(placed.order.id, 10);
		stub.ohlcv = [[since + 60_000, 100, 125, 99, 100, 1]];

		stub.last = 100;
		expect(await client.getOpenOrders()).toHaveLength(0);
		const history = await client.getOrderHistory("BTC/USDT");
		expect(history.find((o) => o.type === "limit")?.average).toBe(120);
	});

	it("triggers a stop-limit in one candle and fills the limit in a later candle", async () => {
		await buyBase(1);
		const placed = await client.placeOrder({
			symbol: "BTC/USDT",
			side: "sell",
			type: "stop",
			amount: 1,
			stopPrice: 90,
			price: 89,
		});
		const since = rewindOrder(placed.order.id, 10);
		stub.ohlcv = [
			[since + 60_000, 100, 100, 88, 88, 1], // trigger fires (low 88 <= 90); no same-candle limit fill
			[since + 120_000, 88, 95, 87, 92, 1], // bounce crosses the 89 limit
		];

		stub.last = 87;
		expect(await client.getOpenOrders()).toHaveLength(0);
		const history = await client.getOrderHistory("BTC/USDT");
		expect(history.find((o) => o.type === "stop")?.average).toBe(89);
	});

	it("does not fill the limit leg of a stop-limit within the trigger candle", async () => {
		await buyBase(1);
		const placed = await client.placeOrder({
			symbol: "BTC/USDT",
			side: "sell",
			type: "stop",
			amount: 1,
			stopPrice: 90,
			price: 89,
		});
		const since = rewindOrder(placed.order.id, 10);
		// One candle that both dips to the trigger and bounces past the limit:
		// conservative semantics keep the order resting as a triggered limit.
		stub.ohlcv = [[since + 60_000, 100, 100, 88, 88, 1]];

		stub.last = 88;
		const open = await client.getOpenOrders();
		expect(open).toHaveLength(1);

		stub.last = 92; // later tick crosses the limit
		expect(await client.getOpenOrders()).toHaveLength(0);
		const history = await client.getOrderHistory("BTC/USDT");
		expect(history.find((o) => o.type === "stop")?.average).toBe(89);
	});
});

describe("paper account reset", () => {
	it("wipes balances, orders and history and applies a new starting balance", async () => {
		await buyBase(1);
		await client.placeOrder({ symbol: "BTC/USDT", side: "sell", type: "limit", amount: 1, price: 150 });
		client.resetAccount(50_000);

		expect(await freeBalance("USDT")).toBe(50_000);
		expect(await freeBalance("BTC")).toBe(0);
		expect(await client.getOpenOrders()).toHaveLength(0);
		expect(await client.getOrderHistory()).toHaveLength(0);

		// Fresh account is fully usable.
		await buyBase(2);
		expect(await freeBalance("BTC")).toBe(2);
	});
});
