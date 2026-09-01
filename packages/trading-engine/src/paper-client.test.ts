import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PaperExchangeClient } from "./paper-client.ts";

/** Controllable stand-in for the ccxt exchange used by PaperExchangeClient. */
class StubExchange {
	last = 100;
	amountDigits = 4;
	priceDigits = 2;
	amountMin: number | undefined = 0.0001;
	amountMax: number | undefined;
	futuresContractSize: number | undefined = 1;
	futuresContract = true;
	futuresLinear = true;
	futuresInverse = false;
	futuresActive = true;
	futuresSwap = true;
	futuresQuote = "USDT";
	futuresSettle = "USDT";
	costMin: number | undefined = 5;
	costMax: number | undefined;
	tickerDelayMs = 0;
	activeTickerCalls = 0;
	maxActiveTickerCalls = 0;
	/** OHLCV rows returned by fetchOHLCV: [timestamp, open, high, low, close, volume]. */
	ohlcv: number[][] = [];

	async fetchTicker(
		symbol: string,
	): Promise<{ symbol: string; last?: number; bid?: number; ask?: number; timestamp: number }> {
		this.activeTickerCalls++;
		this.maxActiveTickerCalls = Math.max(this.maxActiveTickerCalls, this.activeTickerCalls);
		try {
			if (this.tickerDelayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, this.tickerDelayMs));
			return { symbol, last: this.last, bid: this.last, ask: this.last, timestamp: Date.now() };
		} finally {
			this.activeTickerCalls--;
		}
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
				quote: this.futuresQuote,
				settle: this.futuresSettle,
				spot: false,
				swap: this.futuresSwap,
				contract: this.futuresContract,
				linear: this.futuresLinear,
				inverse: this.futuresInverse,
				contractSize: this.futuresContractSize,
				active: this.futuresActive,
				precision: { price: 0.01, amount: 0.0001 },
				limits,
			},
			"ETH/USDT:USDT": {
				symbol: "ETH/USDT:USDT",
				base: "ETH",
				quote: this.futuresQuote,
				settle: this.futuresSettle,
				spot: false,
				swap: this.futuresSwap,
				contract: this.futuresContract,
				linear: this.futuresLinear,
				inverse: this.futuresInverse,
				contractSize: this.futuresContractSize,
				active: this.futuresActive,
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

describe("paper market guards", () => {
	it("rejects futures account queries and controls in spot mode", async () => {
		await expect(client.getOpenOrders("BTC/USDT:USDT")).rejects.toThrow(/Futures markets are disabled/);
		await expect(client.getOrderHistory("BTC/USDT:USDT")).rejects.toThrow(/Futures markets are disabled/);
		await expect(client.getContractStats("BTC/USDT:USDT")).rejects.toThrow(/Futures markets are disabled/);
		await expect(client.setLeverage("BTC/USDT:USDT", 5)).rejects.toThrow(/Futures markets are disabled/);
		await expect(client.setMarginMode("BTC/USDT:USDT", "cross")).rejects.toThrow(/Futures markets are disabled/);
	});

	it("rejects spot account queries in futures-only mode", async () => {
		const futures = newFuturesClient();
		await expect(futures.getOpenOrders("BTC/USDT")).rejects.toThrow(/Spot markets are disabled/);
		await expect(futures.getOrderHistory("BTC/USDT")).rejects.toThrow(/Spot markets are disabled/);
		await expect(futures.cancelOrder("missing", "BTC/USDT")).rejects.toThrow(/Spot markets are disabled/);
	});
});

/** Fault-injection cases for an unusable mark: the ledger position must survive. */
type MarkFault = () => Promise<{ symbol: string; last?: number; timestamp: number }>;

const unavailableMarkCases: Array<[string, MarkFault]> = [
	[
		"ticker throw",
		async () => {
			throw new Error("ticker service down");
		},
	],
	["missing last", async () => ({ symbol: "BTC/USDT", last: undefined, timestamp: 1 })],
	["zero last", async () => ({ symbol: "BTC/USDT", last: 0, timestamp: 1 })],
	["NaN last", async () => ({ symbol: "BTC/USDT", last: Number.NaN, timestamp: 1 })],
	["Infinity last", async () => ({ symbol: "BTC/USDT", last: Number.POSITIVE_INFINITY, timestamp: 1 })],
	["negative last", async () => ({ symbol: "BTC/USDT", last: -5, timestamp: 1 })],
];

function breakSpotTicker(fault: MarkFault): void {
	stub.fetchTicker = async () => fault();
}

function breakFuturesTicker(fault: MarkFault): void {
	stub.fetchTicker = async () => fault();
}

describe("paper valuation unavailability", () => {
	it.each(unavailableMarkCases)("keeps a spot position when the mark is %s", async (_, fault) => {
		const spot = newClient();
		await spot.placeOrder({ symbol: "BTC/USDT", side: "buy", type: "market", amount: 1 });
		breakSpotTicker(fault);

		const positions = await spot.getPositions();
		const [position] = positions;

		expect(positions).toHaveLength(1);
		expect(position).toMatchObject({
			symbol: "BTC/USDT",
			asset: "BTC",
			amount: 1,
			valuationStatus: "unavailable",
		});
		expect(position.avgEntryPrice).toBeCloseTo(100.1, 8);
		expect(position.valuationReason).toBeTruthy();
		expect(position.quoteValue).toBeUndefined();
		expect(position.unrealizedPnl).toBeUndefined();
		expect(position.unrealizedPnlPct).toBeUndefined();
		expect(position.markPrice).toBeUndefined();
		await spot.close();
	});

	it.each(unavailableMarkCases)("keeps a futures position when the mark is %s", async (_, fault) => {
		const futures = newFuturesClient();
		await futures.placeOrder({
			symbol: "BTC/USDT:USDT",
			side: "buy",
			type: "market",
			amount: 1,
			positionSide: "LONG",
		});
		breakFuturesTicker(fault);

		const positions = await futures.getPositions();
		const [position] = positions;

		expect(positions).toHaveLength(1);
		expect(position).toMatchObject({
			symbol: "BTC/USDT:USDT",
			asset: "BTC",
			amount: 1,
			positionSide: "LONG",
			leverage: 5,
			marginType: "isolated",
			margin: 20,
			avgEntryPrice: 100,
			valuationStatus: "unavailable",
		});
		expect(position.valuationReason).toBeTruthy();
		expect(position.quoteValue).toBeUndefined();
		expect(position.unrealizedPnl).toBeUndefined();
		expect(position.unrealizedPnlPct).toBeUndefined();
		expect(position.markPrice).toBeUndefined();
		await futures.close();
	});

	it("keeps a both-mode futures position while spot marks stay healthy", async () => {
		const both = new PaperExchangeClient("okx", "USDT", 10_000, 0.001, dir, "both");
		(both as unknown as { exchange: StubExchange }).exchange = stub;
		(both as unknown as { futuresExchange: StubExchange }).futuresExchange = stub;
		await both.placeOrder({ symbol: "BTC/USDT", side: "buy", type: "market", amount: 1 });
		await both.placeOrder({
			symbol: "BTC/USDT:USDT",
			side: "buy",
			type: "market",
			amount: 1,
		});
		// Only the futures mark is unavailable; the spot valuation stays complete.
		stub.fetchTicker = async (symbol: string) =>
			symbol === "BTC/USDT:USDT" ? { symbol, last: Number.NaN, timestamp: 1 } : { symbol, last: 100, timestamp: 1 };

		const positions = await both.getPositions();

		expect(positions).toHaveLength(2);
		expect(positions.find((p) => p.symbol === "BTC/USDT")).toMatchObject({
			amount: 1,
			quoteValue: 100,
			valuationStatus: "complete",
		});
		expect(positions.find((p) => p.symbol === "BTC/USDT:USDT")).toMatchObject({
			amount: 1,
			valuationStatus: "unavailable",
		});
		await both.close();
	});
});

describe("paper futures settings and identity", () => {
	const symbol = "BTC/USDT:USDT";

	it("round-trips futures client order IDs through lookup and persistence", async () => {
		const futures = newFuturesClient();
		const placed = await futures.placeOrder({
			symbol,
			side: "buy",
			type: "market",
			amount: 1,
			positionSide: "LONG",
			clientOrderId: "futures-client-1",
		});
		expect(placed.order.clientOrderId).toBe("futures-client-1");
		expect((await futures.getOrderByClientId("futures-client-1", symbol)).id).toBe(placed.order.id);
		await futures.close();
		const reloaded = newFuturesClient();
		expect((await reloaded.getOrderByClientId("futures-client-1", symbol)).id).toBe(placed.order.id);
		await reloaded.close();
	});

	it("gives futures market orders the spot-path default client order id", async () => {
		const futures = newFuturesClient();
		const placed = await futures.placeOrder({
			symbol,
			side: "buy",
			type: "market",
			amount: 1,
			positionSide: "LONG",
		});
		// The default mirrors the spot path: `paper-<order id>`.
		expect(placed.order.clientOrderId).toBe(`paper-${placed.order.id}`);
		expect((await futures.getOrderByClientId(`paper-${placed.order.id}`, symbol)).id).toBe(placed.order.id);
		await futures.close();
		const reloaded = newFuturesClient();
		expect((await reloaded.getOrderByClientId(`paper-${placed.order.id}`, symbol)).id).toBe(placed.order.id);
		await reloaded.close();
	});

	it("does not adopt a persisted futures account with a mismatched quote", async () => {
		const path = join(dir, "okx-USDT-futures.json");
		writeFileSync(
			path,
			JSON.stringify({
				quote: "BUSD",
				balances: { BUSD: 12_345 },
				entries: { BTC: { amount: 1, cost: 80 } },
				orders: [],
				trades: [],
				realizedPnl: 999,
				leverage: 3,
				marginType: "cross",
				positionMode: "hedge",
				createdAt: Date.now(),
			}),
		);
		const futures = newFuturesClient();
		// The configured USDT account starts fresh; the BUSD file is untouched.
		expect((await futures.getBalances())[0]).toMatchObject({ asset: "USDT", free: 10_000 });
		expect(await futures.getPositions()).toEqual([]);
		expect(readFileSync(path, "utf8")).toContain('"quote":"BUSD"');
		await futures.close();
	});

	it("fails construction on malformed persisted futures JSON instead of ignoring it", async () => {
		const path = join(dir, "okx-USDT-futures.json");
		writeFileSync(path, "{ not valid json");
		expect(() => newFuturesClient()).toThrow(SyntaxError);
	});

	it("isolates leverage and margin settings by symbol", async () => {
		const futures = newFuturesClient();
		await futures.setLeverage(symbol, 10);
		await futures.setMarginMode(symbol, "cross");
		await futures.setLeverage("ETH/USDT:USDT", 2);
		await futures.setMarginMode("ETH/USDT:USDT", "isolated");
		await futures.placeOrder({ symbol, side: "buy", type: "market", amount: 1, positionSide: "LONG" });
		await futures.placeOrder({
			symbol: "ETH/USDT:USDT",
			side: "buy",
			type: "market",
			amount: 1,
			positionSide: "LONG",
		});
		const positions = await futures.getPositions();
		expect(positions.find((position) => position.symbol === symbol)).toMatchObject({
			leverage: 10,
			marginType: "cross",
			margin: 10,
		});
		expect(positions.find((position) => position.symbol === "ETH/USDT:USDT")).toMatchObject({
			leverage: 2,
			marginType: "isolated",
			margin: 50,
		});
	});

	it("retains entry leverage and margin mode after settings change", async () => {
		const futures = newFuturesClient();
		await futures.setLeverage(symbol, 10);
		await futures.setMarginMode(symbol, "cross");
		await futures.placeOrder({ symbol, side: "buy", type: "market", amount: 1, positionSide: "LONG" });
		await futures.setLeverage(symbol, 2);
		await futures.setMarginMode(symbol, "isolated");
		expect((await futures.getPositions())[0]).toMatchObject({ leverage: 10, marginType: "cross", margin: 10 });
		await futures.placeOrder({
			symbol,
			side: "sell",
			type: "market",
			amount: 1,
			positionSide: "LONG",
			reduceOnly: true,
		});
		expect((await futures.getBalances())[0]?.free).toBeCloseTo(9_999.8, 8);
	});

	it("keeps mixed opening lots and releases margin FIFO on partial close", async () => {
		const futures = newFuturesClient();
		await futures.setLeverage(symbol, 10);
		await futures.placeOrder({ symbol, side: "buy", type: "market", amount: 1, positionSide: "LONG" });
		await futures.setLeverage(symbol, 2);
		await futures.placeOrder({ symbol, side: "buy", type: "market", amount: 1, positionSide: "LONG" });
		// A mixed position must not be reported as if the first lot's settings
		// applied to the whole position: both settings fields stay empty while
		// the margin still sums every lot (10 + 50).
		const mixed = (await futures.getPositions())[0];
		expect(mixed).toMatchObject({ amount: 2, margin: 60 });
		expect(mixed?.leverage).toBeUndefined();
		expect(mixed?.marginType).toBeUndefined();
		await futures.placeOrder({
			symbol,
			side: "sell",
			type: "market",
			amount: 1.5,
			positionSide: "LONG",
			reduceOnly: true,
		});
		// FIFO consumed the whole 10x lot; the remainder keeps the 2x identity.
		expect((await futures.getPositions())[0]).toMatchObject({
			amount: 0.5,
			leverage: 2,
			marginType: "isolated",
			margin: 25,
		});
		expect((await futures.getBalances())[0]?.free).toBeCloseTo(9_974.65, 8);
	});

	it("uses legacy account settings as defaults without rewriting on startup", async () => {
		const path = join(dir, "okx-USDT-futures.json");
		writeFileSync(
			path,
			JSON.stringify({
				quote: "USDT",
				balances: { USDT: 10_000 },
				entries: {},
				orders: [],
				trades: [],
				realizedPnl: 0,
				leverage: 7,
				marginType: "cross",
				positionMode: "hedge",
				createdAt: Date.now(),
			}),
		);
		const before = readFileSync(path, "utf8");
		const futures = newFuturesClient();
		expect(readFileSync(path, "utf8")).toBe(before);
		await futures.placeOrder({ symbol, side: "buy", type: "market", amount: 1, positionSide: "LONG" });
		expect((await futures.getPositions())[0]).toMatchObject({ leverage: 7, marginType: "cross", margin: 100 / 7 });
		await futures.close();
		expect(readFileSync(path, "utf8")).not.toBe(before);
	});

	it("snapshots legacy entries before a settings change and closes with the same margin", async () => {
		const path = join(dir, "okx-USDT-futures.json");
		writeFileSync(
			path,
			JSON.stringify({
				quote: "USDT",
				balances: { USDT: 10_000 },
				entries: { BTC: { amount: 1, cost: 80 } },
				orders: [],
				trades: [],
				realizedPnl: 0,
				leverage: 7,
				marginType: "cross",
				positionMode: "one-way",
				createdAt: Date.now(),
			}),
		);
		const before = readFileSync(path, "utf8");
		const futures = newFuturesClient("one-way");
		// Startup snapshots the legacy entry in memory without rewriting the file.
		expect(readFileSync(path, "utf8")).toBe(before);
		expect((await futures.getPositions())[0]).toMatchObject({
			symbol,
			amount: 1,
			avgEntryPrice: 80,
			leverage: 7,
			marginType: "cross",
			margin: 80 / 7,
		});
		// A later symbol settings change must not retroactively relabel the entry.
		await futures.setLeverage(symbol, 2);
		await futures.setMarginMode(symbol, "isolated");
		expect((await futures.getPositions())[0]).toMatchObject({
			leverage: 7,
			marginType: "cross",
			margin: 80 / 7,
		});
		stub.last = 120;
		await futures.placeOrder({
			symbol,
			side: "sell",
			type: "market",
			amount: 0.5,
			reduceOnly: true,
		});
		// The partial close releases margin at the legacy lot's leverage and
		// realizes PnL against the legacy entry price, not the new settings.
		expect((await futures.getPositions())[0]).toMatchObject({
			amount: 0.5,
			leverage: 7,
			marginType: "cross",
			margin: 40 / 7,
		});
		expect((await futures.getBalances())[0]?.free).toBeCloseTo(
			10_000 + (0.5 * 80) / 7 + 0.5 * (120 - 80) - 0.5 * 120 * 0.001,
			8,
		);
	});

	it("prefers entry-level settings over account-level defaults when snapshotted", async () => {
		const path = join(dir, "okx-USDT-futures.json");
		writeFileSync(
			path,
			JSON.stringify({
				quote: "USDT",
				balances: { USDT: 10_000 },
				entries: { BTC: { amount: 1, cost: 100, leverage: 20, marginType: "isolated" } },
				orders: [],
				trades: [],
				realizedPnl: 0,
				leverage: 7,
				marginType: "cross",
				positionMode: "one-way",
				createdAt: Date.now(),
			}),
		);
		const futures = newFuturesClient("one-way");
		expect((await futures.getPositions())[0]).toMatchObject({
			amount: 1,
			avgEntryPrice: 100,
			leverage: 20,
			marginType: "isolated",
			margin: 5,
		});
	});

	it("reverses by consuming old lots first and opening the new direction at current settings", async () => {
		const futures = newFuturesClient("one-way");
		await futures.setLeverage(symbol, 10);
		await futures.placeOrder({ symbol, side: "buy", type: "market", amount: 1 });
		await futures.setLeverage(symbol, 2);
		await futures.placeOrder({ symbol, side: "sell", type: "market", amount: 2 });

		const position = (await futures.getPositions())[0];
		expect(position).toMatchObject({
			amount: 1,
			positionSide: "SHORT",
			avgEntryPrice: 100,
			leverage: 2,
			margin: 50,
		});
		expect(position?.unrealizedPnl).toBeCloseTo(0, 8);
		// The original 10x lot's margin was released and replaced at the new
		// leverage; fees for both legs left the quote balance.
		expect((await futures.getBalances())[0]?.free).toBeCloseTo(10_000 - 50 - 3 * 100 * 0.001, 8);
	});

	it("rejects unknown futures settings before changing persisted state", async () => {
		const futures = newFuturesClient();
		await futures.setLeverage(symbol, 5);
		const path = join(dir, "okx-USDT-futures.json");
		const before = readFileSync(path, "utf8");
		await expect(futures.setLeverage("FOO/USDT:USDT", 20)).rejects.toThrow(/Unsupported futures market/);
		expect(readFileSync(path, "utf8")).toBe(before);
	});

	const futuresMetadataCases: Array<
		[
			string,
			Partial<
				Pick<
					StubExchange,
					| "futuresContract"
					| "futuresInverse"
					| "futuresActive"
					| "futuresLinear"
					| "futuresQuote"
					| "futuresSettle"
					| "futuresSwap"
				>
			>,
		]
	> = [
		["non-contract", { futuresContract: false }],
		["inverse", { futuresInverse: true }],
		["inactive", { futuresActive: false }],
		["non-linear", { futuresLinear: false }],
		["wrong quote", { futuresQuote: "BUSD" }],
		["wrong settlement", { futuresSettle: "BUSD" }],
		["non-swap", { futuresSwap: false }],
	];

	it.each(futuresMetadataCases)("rejects %s futures metadata before settings persistence", async (_name, options) => {
		stub.futuresContract = options.futuresContract ?? true;
		stub.futuresInverse = options.futuresInverse ?? false;
		stub.futuresActive = options.futuresActive ?? true;
		stub.futuresLinear = options.futuresLinear ?? true;
		stub.futuresQuote = options.futuresQuote ?? "USDT";
		stub.futuresSettle = options.futuresSettle ?? "USDT";
		stub.futuresSwap = options.futuresSwap ?? true;
		const path = join(dir, "okx-USDT-futures.json");
		writeFileSync(
			path,
			JSON.stringify({
				quote: "USDT",
				balances: { USDT: 10_000 },
				entries: {},
				orders: [],
				trades: [],
				realizedPnl: 0,
				leverage: 5,
				marginType: "isolated",
				positionMode: "hedge",
				createdAt: Date.now(),
			}),
		);
		const before = readFileSync(path, "utf8");
		const futures = newFuturesClient();
		await expect(futures.setMarginMode(symbol, "cross")).rejects.toThrow(/Unsupported futures market/);
		expect(readFileSync(path, "utf8")).toBe(before);
	});
});

describe("paper futures hedge ledger", () => {
	const symbol = "BTC/USDT:USDT";

	it("validates futures limits in contracts while keeping the ledger in base units", async () => {
		stub.futuresContractSize = 10;
		stub.amountMin = 3;
		const futures = newFuturesClient();

		await expect(
			futures.placeOrder({ symbol, side: "buy", type: "market", amount: 20, positionSide: "LONG" }),
		).rejects.toThrow(/Contract amount 2 is below minimum 3/);

		stub.amountMin = 2;
		const placed = await futures.placeOrder({
			symbol,
			side: "buy",
			type: "market",
			amount: 20,
			positionSide: "LONG",
		});
		expect(placed.order).toMatchObject({ amount: 20, filled: 20, positionSide: "LONG" });
		expect(await futures.getMarketInfo(symbol)).toMatchObject({
			amountUnit: "contracts",
			contractSize: 10,
			minAmount: 2,
		});
		const position = (await futures.getPositions()).find((candidate) => candidate.positionSide === "LONG");
		expect(position).toMatchObject({ amount: 20, quoteValue: 2_000 });
	});

	it("rejects a base amount that cannot round-trip through contract precision", async () => {
		stub.futuresContractSize = 10;
		stub.amountDigits = 0;
		const futures = newFuturesClient();

		await expect(
			futures.placeOrder({ symbol, side: "buy", type: "market", amount: 25, positionSide: "LONG" }),
		).rejects.toThrow(/cannot be represented exactly.*contractSize 10/);
	});

	it.each([
		["inverse", { futuresLinear: false, futuresContractSize: 1 }],
		["missing contractSize", { futuresLinear: true, futuresContractSize: undefined }],
	] as const)("rejects unsafe futures metadata (%s)", async (_name, options) => {
		stub.futuresLinear = options.futuresLinear;
		stub.futuresContractSize = options.futuresContractSize;
		const futures = newFuturesClient();

		await expect(
			futures.placeOrder({ symbol, side: "buy", type: "market", amount: 20, positionSide: "LONG" }),
		).rejects.toThrow(options.futuresLinear === false ? /linear USDⓈ-M/ : /contractSize is unavailable/);
	});

	it("executes and records reduceOnly in hedge mode after contract conversion", async () => {
		stub.futuresContractSize = 10;
		const futures = newFuturesClient();
		await futures.placeOrder({ symbol, side: "buy", type: "market", amount: 20, positionSide: "LONG" });

		const close = await futures.placeOrder({
			symbol,
			side: "sell",
			type: "market",
			amount: 10,
			positionSide: "LONG",
			reduceOnly: true,
		});

		expect(close.order).toMatchObject({ amount: 10, filled: 10, positionSide: "LONG", reduceOnly: true });
		expect((await futures.getPositions()).find((candidate) => candidate.positionSide === "LONG")).toMatchObject({
			amount: 10,
		});
	});

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
	it("preserves an explicit client order ID for spot market fills", async () => {
		const placed = await client.placeOrder({
			symbol: "BTC/USDT",
			side: "buy",
			type: "market",
			amount: 1,
			clientOrderId: "spot-market-client-1",
		});

		expect(placed.order.clientOrderId).toBe("spot-market-client-1");
		expect((await client.getOrderByClientId("spot-market-client-1", "BTC/USDT")).id).toBe(placed.order.id);
		await client.close();

		const reloaded = newClient();
		expect((await reloaded.getOrderByClientId("spot-market-client-1", "BTC/USDT")).id).toBe(placed.order.id);
		await reloaded.close();
	});

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
	it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
		"rejects a non-finite ticker during resting-order settlement (%s)",
		async (invalidLast) => {
			await buyBase(1);
			const placed = await client.placeOrder({
				symbol: "BTC/USDT",
				side: "sell",
				type: "limit",
				amount: 1,
				price: 150,
			});
			const orders = (
				client as unknown as {
					account: { orders: Array<{ id: string; status: string; lastCheckedAt?: number }> };
				}
			).account.orders;
			const order = orders.find((candidate) => candidate.id === placed.order.id);
			if (!order) throw new Error("order not found");
			const checkedBefore = order.lastCheckedAt;

			stub.last = invalidLast;
			await expect(client.getOpenOrders()).rejects.toThrow(/finite positive last price/);
			expect(order.status).toBe("open");
			expect(order.lastCheckedAt).toBe(checkedBefore);
		},
	);

	it("serializes concurrent lazy-settlement reads", async () => {
		await buyBase(1);
		const placed = await client.placeOrder({
			symbol: "BTC/USDT",
			side: "sell",
			type: "stop_market",
			amount: 1,
			stopPrice: 90,
		});

		stub.last = 89;
		stub.tickerDelayMs = 20;
		const [firstOpen, secondOpen] = await Promise.all([client.getOpenOrders(), client.getOpenOrders()]);

		expect(firstOpen).toHaveLength(0);
		expect(secondOpen).toHaveLength(0);
		expect(stub.maxActiveTickerCalls).toBe(1);
		const history = await client.getOrderHistory("BTC/USDT");
		expect(history.filter((order) => order.id === placed.order.id)).toHaveLength(1);
	});

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
		const since = rewindOrder(placed.order.id, 10);
		stub.ohlcv = [
			[since + 60_000, 100, 125, 99, 124, 1],
			[since + 120_000, 124, 130, 122, 129, 1],
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
	// Account operations now reload the locked file before executing so separate
	// Ti processes cannot spend a stale snapshot. Persist this deliberate test
	// time shift through the same private seam before triggering settlement.
	(client as unknown as { persist(): void }).persist();
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
	it("stops at the first sparse-candle gap and retries it before later candles", async () => {
		await buyBase(1);
		const placed = await client.placeOrder({
			symbol: "BTC/USDT",
			side: "sell",
			type: "limit",
			amount: 1,
			price: 150,
		});
		const since = rewindOrder(placed.order.id, 10);
		// The second candle crosses the limit but sits beyond a missing interval.
		// It must not be evaluated until a later response fills that interval.
		stub.ohlcv = [
			[since + 60_000, 100, 110, 99, 100, 1],
			[since + 5 * 60_000, 100, 160, 99, 100, 1],
		];
		stub.last = 100;
		expect(await client.getOpenOrders()).toHaveLength(1);
		const order = (
			client as unknown as {
				account: { orders: Array<{ id: string; lastCheckedAt?: number }> };
			}
		).account.orders.find((candidate) => candidate.id === placed.order.id);
		expect(order?.lastCheckedAt).toBe(since + 2 * 60_000);

		// A complete, deliberately unordered response now bridges the gap. The
		// previously deferred crossing candle becomes safe to evaluate.
		stub.ohlcv = [
			[since + 5 * 60_000, 100, 160, 99, 100, 1],
			[since + 3 * 60_000, 100, 110, 99, 100, 1],
			[since + 2 * 60_000, 100, 110, 99, 100, 1],
			[since + 4 * 60_000, 100, 110, 99, 100, 1],
		];
		expect(await client.getOpenOrders()).toHaveLength(0);
		expect(
			(await client.getOrderHistory("BTC/USDT")).find((candidate) => candidate.id === placed.order.id)?.average,
		).toBe(150);
	});

	it("retries a deferred crossing after the missing interval is backfilled", async () => {
		await buyBase(1);
		const placed = await client.placeOrder({
			symbol: "BTC/USDT",
			side: "sell",
			type: "limit",
			amount: 1,
			price: 150,
		});
		const since = rewindOrder(placed.order.id, 10);
		// The first response only covers the beginning of the gap. The order must
		// remain eligible for a later response covering the still-unobserved tail.
		stub.ohlcv = [[since + 60_000, 100, 110, 99, 100, 1]];
		stub.last = 100;
		expect(await client.getOpenOrders()).toHaveLength(1);

		stub.ohlcv = [
			[since + 2 * 60_000, 100, 110, 99, 100, 1],
			[since + 3 * 60_000, 100, 110, 99, 100, 1],
			[since + 4 * 60_000, 100, 110, 99, 100, 1],
			[since + 5 * 60_000, 100, 160, 99, 100, 1],
		];
		stub.last = 100;
		expect(await client.getOpenOrders()).toHaveLength(0);
		const history = await client.getOrderHistory("BTC/USDT");
		expect(history.find((order) => order.id === placed.order.id)?.average).toBe(150);
	});

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
	it("recovers an interrupted two-account transaction before loading state", async () => {
		const spotPath = join(dir, "okx-USDT.json");
		const futuresPath = join(dir, "okx-USDT-futures.json");
		const transactionPath = join(dir, "okx-USDT.transaction.json");
		const account = (quote: string, free: number) => ({
			quote,
			balances: { [quote]: free },
			entries: {},
			orders: [],
			trades: [],
			realizedPnl: 0,
			createdAt: 1,
		});
		writeFileSync(spotPath, JSON.stringify(account("USDT", 100)));
		writeFileSync(futuresPath, JSON.stringify({ ...account("USDT", 200), leverage: 5, marginType: "isolated" }));
		writeFileSync(
			transactionPath,
			JSON.stringify({
				version: 1,
				account: account("USDT", 75),
				futuresAccount: { ...account("USDT", 175), leverage: 5, marginType: "isolated", positionMode: "one-way" },
			}),
		);

		const recovered = newClient();
		expect(JSON.parse(readFileSync(spotPath, "utf8"))).toMatchObject({ balances: { USDT: 75 } });
		expect(JSON.parse(readFileSync(futuresPath, "utf8"))).toMatchObject({ balances: { USDT: 175 } });
		expect(existsSync(transactionPath)).toBe(false);
		await recovered.close();
	});

	it("serializes two clients sharing one persisted account", async () => {
		const first = client;
		const second = newClient();
		await first.resetAccount(6_100);
		stub.tickerDelayMs = 20;

		const results = await Promise.allSettled([
			first.placeOrder({ symbol: "BTC/USDT", side: "buy", type: "market", amount: 60 }),
			second.placeOrder({ symbol: "BTC/USDT", side: "buy", type: "market", amount: 60 }),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
		expect((await first.getOrderHistory("BTC/USDT")).filter((order) => order.status === "closed")).toHaveLength(1);
		expect(await freeBalance("USDT")).toBeCloseTo(6_100 - 60 * 100.1, 6);

		await Promise.all([first.close(), second.close()]);
	});

	it("queues reset behind an in-flight settlement", async () => {
		await buyBase(1);
		await client.placeOrder({ symbol: "BTC/USDT", side: "sell", type: "limit", amount: 1, price: 150 });

		stub.last = 100;
		stub.tickerDelayMs = 20;
		const read = client.getOpenOrders();
		const reset = client.resetAccount(50_000);
		// If reset bypasses the account queue, the delayed read observes 200 after
		// reset and fills into the supposedly fresh account.
		stub.last = 200;
		await Promise.all([read, reset]);

		expect(await freeBalance("USDT")).toBe(50_000);
		expect(await freeBalance("BTC")).toBe(0);
		expect(await client.getOpenOrders()).toHaveLength(0);
		expect(await client.getOrderHistory()).toHaveLength(0);
	});

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
