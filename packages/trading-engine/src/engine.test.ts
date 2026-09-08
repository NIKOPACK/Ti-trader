import type { RiskClock, RiskStateStore, TradingRiskState } from "@nikopack/ti-trading-risk";
import { describe, expect, it, vi } from "vitest";
import { TradingEngine as BaseTradingEngine, PreparedPlanError, type TradingEngineConfig } from "./engine.ts";
import type { OrderIntent, PreparedOrder } from "./order-plan.ts";
import { OrderPreparationError } from "./order-plan.ts";
import {
	type ExchangeClient,
	type Order,
	SubmissionRejectedError,
	SubmissionStatusUnknownError,
	type Ticker,
} from "./types.ts";

class TradingEngine extends BaseTradingEngine {
	constructor(config: TradingEngineConfig, exchange: ExchangeClient, store: RiskStateStore, clock?: RiskClock) {
		super(config, exchange, store, clock, { durability: "memory", accountId: "fixture-account" });
	}
}

const config: TradingEngineConfig = {
	mode: "paper",
	marketType: "spot",
	positionMode: "one-way",
	quoteCurrency: "USDT",
	risk: { maxOrderNotional: 500, maxDailyNotional: 1_000, allowedSymbols: [] },
};

const futuresConfig: TradingEngineConfig = {
	mode: "paper",
	marketType: "usdm-futures",
	positionMode: "one-way",
	quoteCurrency: "USDT",
	risk: { maxOrderNotional: 500_000, maxDailyNotional: 1_000_000, allowedSymbols: [] },
};

function stateStore() {
	let state: TradingRiskState = {
		paper: { date: "2026-01-01", usedDailyNotional: 0 },
		live: { date: "2026-01-01", usedDailyNotional: 0 },
	};
	return {
		load: () => state,
		save: (next: typeof state) => {
			state = structuredClone(next);
		},
		transact: <T>(mutator: (next: typeof state) => T): T => {
			const next = structuredClone(state);
			const result = mutator(next);
			state = next;
			return result;
		},
		state: () => state,
	};
}

function client(overrides: Partial<ExchangeClient> = {}): ExchangeClient {
	const ticker: Ticker = { symbol: "BTC/USDT", timestamp: 1, last: 100 };
	const order: Order = {
		id: "1",
		symbol: "BTC/USDT",
		side: "buy",
		type: "market",
		amount: 1,
		filled: 1,
		remaining: 0,
		cost: 100,
		status: "closed",
		timestamp: 1,
	};
	return {
		id: "binance",
		mode: "paper",
		quoteCurrency: "USDT",
		getTicker: async () => ticker,
		getOrderBook: async () => ({ symbol: "BTC/USDT", timestamp: 1, bids: [], asks: [], bidDepth: 0, askDepth: 0 }),
		getMarketInfo: async () => ({
			symbol: "BTC/USDT",
			base: "BTC",
			quote: "USDT",
			marketType: "spot",
			contract: false,
			active: true,
		}),
		getContractStats: async () => ({ symbol: "BTC/USDT" }),
		getKlines: async () => [],
		getBalances: async () => [
			{ asset: "USDT", free: 100_000, used: 0, total: 100_000 },
			{ asset: "BTC", free: 100, used: 0, total: 100 },
		],
		getPositions: async () => [],
		getOpenOrders: async () => [],
		getOrderHistory: async () => [],
		getOrder: async () => order,
		getOrderByClientId: async () => order,
		getOrderList: async () => ({ id: "1", listOrderStatus: "ALL_DONE", status: "closed", orders: [order] }),
		getOrderListByClientId: async () => ({ id: "1", listOrderStatus: "ALL_DONE", status: "closed", orders: [order] }),
		placeOrder: async (input) => ({
			order: { ...order, ...input, filled: input.amount, remaining: 0, cost: input.amount * 100 },
		}),
		placeOcoOrder: async (input) => ({
			orders: [input.aboveClientOrderId, input.belowClientOrderId].map((clientOrderId, index) => ({
				...order,
				id: String(index + 1),
				symbol: input.symbol,
				side: input.side,
				type: "limit" as const,
				amount: input.amount,
				filled: 0,
				remaining: input.amount,
				cost: 0,
				status: "open" as const,
				clientOrderId,
				orderListId: "list-1",
				listClientOrderId: input.listClientOrderId,
			})),
		}),
		cancelOrder: async () => {},
		cancelOrderList: async () => {},
		getTopMarkets: async () => [],
		getFundingRate: async () => ({ symbol: "BTC/USDT", rate: 0 }),
		getFundingRateHistory: async () => [],
		getEffectiveLeverage: () => 1,
		setLeverage: async () => {},
		setMarginMode: async () => {},
		setMultiAssetsMode: async () => {},
		close: async () => {},
		...overrides,
	};
}

function makeEngine(overrides: Partial<ExchangeClient> = {}) {
	return new TradingEngine(config, client(overrides), stateStore());
}

function makeFuturesEngine(overrides: Partial<ExchangeClient> = {}) {
	return new TradingEngine(futuresConfig, client(overrides), stateStore());
}

const closeIntent: OrderIntent = {
	symbol: "BTC/USDT:USDT",
	type: "market",
	closePosition: true,
};

describe("TradingEngine identity and reservations", () => {
	it.each(["order", "oco"] as const)(
		"rechecks a shared pause after %s confirmation and releases its claim",
		async (kind) => {
			const store = stateStore();
			const exchange = client();
			const submitOrder = vi.spyOn(exchange, "placeOrder");
			const submitOco = vi.spyOn(exchange, "placeOcoOrder");
			const trading = new TradingEngine(config, exchange, store);
			const otherProcess = new TradingEngine(config, client(), store);
			const orderPlan = await trading.prepareOrder("buy", { symbol: "BTC/USDT", type: "market", amount: 1 });
			const ocoPlan = await trading.prepareOcoOrder({
				symbol: "BTC/USDT",
				side: "buy",
				amount: 1,
				stopLossPrice: 110,
				takeProfitPrice: 90,
			});
			const confirm = async () => {
				expect(trading.risk.usage().reserved).toBeGreaterThan(0);
				otherProcess.risk.pauseNewExposure("Investigate exchange orders");
				return true;
			};
			await expect(
				kind === "order" ? trading.placeOrder(orderPlan, { confirm }) : trading.placeOco(ocoPlan, { confirm }),
			).rejects.toThrow(/New exposure is paused/);
			expect(submitOrder).not.toHaveBeenCalled();
			expect(submitOco).not.toHaveBeenCalled();
			expect(trading.risk.usage()).toMatchObject({
				used: 0,
				reserved: 0,
				newExposurePause: { reason: "Investigate exchange orders" },
			});
			const pause = trading.risk.usage().newExposurePause;
			if (!pause) throw new Error("Expected a persisted pause");
			otherProcess.risk.resumeNewExposure(pause.id);
			await (kind === "order" ? trading.placeOrder(orderPlan) : trading.placeOco(ocoPlan));
			expect(submitOrder.mock.calls.length + submitOco.mock.calls.length).toBe(1);
		},
	);

	it("does not read exchange state or ask for confirmation when entries are already paused", async () => {
		const exchange = client();
		const trading = new TradingEngine(config, exchange, stateStore());
		const plan = await trading.prepareOrder("buy", { symbol: "BTC/USDT", type: "market", amount: 1 });
		const getBalances = vi.spyOn(exchange, "getBalances");
		const submit = vi.spyOn(exchange, "placeOrder");
		const confirm = vi.fn(async () => true);
		trading.risk.pauseNewExposure("Manual pause");

		await expect(trading.placeOrder(plan, { confirm })).rejects.toThrow(/Manual pause/);
		expect(getBalances).not.toHaveBeenCalled();
		expect(confirm).not.toHaveBeenCalled();
		expect(submit).not.toHaveBeenCalled();
		expect(trading.risk.usage().reserved).toBe(0);
	});

	it("blocks submission if the final pause-state read fails", async () => {
		const store = stateStore();
		const exchange = client();
		const submit = vi.spyOn(exchange, "placeOrder");
		const trading = new TradingEngine(config, exchange, store);
		const plan = await trading.prepareOrder("buy", { symbol: "BTC/USDT", type: "market", amount: 1 });
		await expect(
			trading.placeOrder(plan, {
				confirm: async () => {
					vi.spyOn(store, "load").mockImplementationOnce(() => {
						throw new Error("Risk state unavailable");
					});
					return true;
				},
			}),
		).rejects.toThrow(/Risk state unavailable/);
		expect(submit).not.toHaveBeenCalled();
		expect(trading.risk.usage()).toMatchObject({ used: 0, reserved: 0 });
	});

	it("keeps spot exits, protective OCOs and cancellations available while entries are paused", async () => {
		const exchange = client();
		const submit = vi.spyOn(exchange, "placeOrder");
		const submitOco = vi.spyOn(exchange, "placeOcoOrder");
		const cancel = vi.spyOn(exchange, "cancelOrder");
		const cancelList = vi.spyOn(exchange, "cancelOrderList");
		const trading = new TradingEngine(config, exchange, stateStore());
		trading.risk.pauseNewExposure("Manual pause");

		await trading.placeOrder(await trading.prepareOrder("sell", { symbol: "BTC/USDT", type: "market", amount: 1 }));
		await trading.placeOco(
			await trading.prepareOcoOrder({
				symbol: "BTC/USDT",
				side: "sell",
				amount: 1,
				stopLossPrice: 90,
				takeProfitPrice: 110,
			}),
		);
		await trading.cancelOrder("order-1", "BTC/USDT");
		await trading.cancelOrderList("list-1", "BTC/USDT");
		expect(submit).toHaveBeenCalledOnce();
		expect(submitOco).toHaveBeenCalledOnce();
		expect(cancel).toHaveBeenCalledOnce();
		expect(cancelList).toHaveBeenCalledOnce();
		expect(trading.risk.usage()).toMatchObject({
			used: 0,
			reserved: 0,
			newExposurePause: { reason: "Manual pause" },
		});
	});

	it("keeps validated futures reductions available while rejecting entries", async () => {
		const symbol = "BTC/USDT:USDT";
		const trading = makeFuturesEngine({
			getPositions: async () => [{ symbol, asset: "BTC", amount: 1, positionSide: "LONG", quoteValue: 100 }],
			getMarketInfo: async () => ({
				symbol,
				base: "BTC",
				quote: "USDT",
				marketType: "swap",
				contract: true,
				linear: true,
				contractSize: 1,
				active: true,
			}),
		});
		trading.risk.pauseNewExposure("Manual pause");
		await expect(
			trading.placeOrder(
				await trading.prepareOrder("sell", {
					symbol,
					type: "market",
					amount: 1,
					reduceOnly: true,
				}),
			),
		).resolves.toBeDefined();
		await expect(
			trading.placeOrder(
				await trading.prepareOrder("buy", {
					symbol,
					type: "market",
					amount: 1,
				}),
			),
		).rejects.toThrow(/New exposure is paused/);
	});

	it("rejects a configuration whose identity differs from the attached client", () => {
		expect(() => new TradingEngine({ ...config, mode: "live" }, client(), stateStore())).toThrow(
			/mode.*does not match/,
		);
		expect(() => new TradingEngine({ ...config, quoteCurrency: "BTC" }, client(), stateStore())).toThrow(
			/quote currency.*does not match/,
		);
	});

	it("exposes only market-data methods through the planning context", () => {
		const trading = makeEngine();
		const view = trading.planningContext.exchange as Record<string, unknown>;
		expect(typeof view.getTicker).toBe("function");
		expect(view.placeOrder).toBeUndefined();
		expect(view.cancelOrder).toBeUndefined();
		expect(Object.isFrozen(view)).toBe(true);
	});

	it("rejects identity changes through setConfig", () => {
		const trading = makeEngine();
		expect(() => trading.setConfig({ ...config, mode: "live" })).toThrow(/cannot change/);
		expect(() => trading.setConfig({ ...config, quoteCurrency: "BTC" })).toThrow(/cannot change/);
		expect(() => trading.setConfig({ ...config, marketType: "both" })).toThrow(/market type.*cannot change/);
		expect(() => trading.setConfig({ ...config, positionMode: "hedge" })).toThrow(/position mode.*cannot change/);
		expect(() => trading.risk.setConfig({ ...config, mode: "live" })).toThrow(/Risk ledger identity cannot change/);
		expect(() => trading.risk.setConfig({ ...config, marketType: "both" })).toThrow(
			/Risk ledger identity cannot change/,
		);
	});

	it("rejects ordinary market metadata errors before reserving or submitting futures orders", async () => {
		const getMarketInfo = vi.fn(async () => {
			throw new Error("market metadata unavailable");
		});
		const placeOrder = vi.fn(async () => {
			throw new Error("must not submit");
		});
		const trading = makeFuturesEngine({ getMarketInfo, placeOrder });

		await expect(trading.prepareOrder("buy", { symbol: "BTC/USDT:USDT", type: "market", amount: 1 })).rejects.toThrow(
			"market metadata unavailable",
		);
		expect(placeOrder).not.toHaveBeenCalled();
		expect(trading.risk.usage().reserved).toBe(0);
	});

	it("preflights futures orders against effective leverage and the futures wallet", async () => {
		const placeOrder = vi.fn(async (input: Parameters<ExchangeClient["placeOrder"]>[0]) => ({
			order: clientOrder({ ...input, type: "market" }),
		}));
		const trading = makeFuturesEngine({
			getMarketInfo: async () => ({
				symbol: "BTC/USDT:USDT",
				base: "BTC",
				quote: "USDT",
				settle: "USDT",
				marketType: "swap",
				contract: true,
				linear: true,
				contractSize: 1,
				active: true,
			}),
			getBalances: async () => [{ asset: "USDT", free: 60, used: 0, total: 60 }],
			getEffectiveLeverage: () => 10,
			placeOrder,
		});
		const plan = await trading.prepareOrder("buy", {
			symbol: "BTC/USDT:USDT",
			type: "market",
			amount: 5,
		});

		await trading.placeOrder(plan);
		expect(placeOrder).toHaveBeenCalledTimes(1);
	});

	it("keeps spot and futures balances isolated in paper both mode", async () => {
		const bothConfig: TradingEngineConfig = {
			...futuresConfig,
			marketType: "both",
		};
		const exchange = client({
			getMarketInfo: async () => ({
				symbol: "BTC/USDT:USDT",
				base: "BTC",
				quote: "USDT",
				settle: "USDT",
				marketType: "swap",
				contract: true,
				linear: true,
				contractSize: 1,
				active: true,
			}),
			getBalances: async () => [{ asset: "futures:USDT", free: 60, used: 0, total: 60 }],
			getEffectiveLeverage: () => 10,
		});
		const trading = new TradingEngine(bothConfig, exchange, stateStore());
		const plan = await trading.prepareOrder("buy", {
			symbol: "BTC/USDT:USDT",
			type: "market",
			amount: 5,
		});

		await expect(trading.placeOrder(plan)).resolves.toBeDefined();
	});

	it("releases a reservation when confirmation is cancelled", async () => {
		const store = stateStore();
		const trading = new TradingEngine(config, client(), store);
		const plan = await trading.prepareOrder("buy", { symbol: "BTC/USDT", type: "market", amount: 1 });
		await expect(trading.placeOrder(plan, { confirm: async () => false })).rejects.toThrow(/cancelled/);
		expect(trading.risk.usage()).toMatchObject({ used: 0, reserved: 0 });
	});

	it("requires an explicit confirmation policy for live submissions", async () => {
		const placeOrder = vi.fn(async () => ({
			order: clientOrder({ symbol: "BTC/USDT", side: "buy", type: "market", amount: 1 }),
		}));
		const live = new TradingEngine({ ...config, mode: "live" }, client({ mode: "live", placeOrder }), stateStore());
		const plan = await live.prepareOrder("buy", { symbol: "BTC/USDT", type: "market", amount: 1 });

		await expect(live.placeOrder(plan)).rejects.toThrow(/explicit confirmation callback/);
		expect(placeOrder).not.toHaveBeenCalled();
		expect(live.risk.usage()).toMatchObject({ used: 0, reserved: 0 });
		await expect(
			live.placeOrder(await live.prepareOrder("buy", { symbol: "BTC/USDT", type: "market", amount: 1 }), {
				allowUnconfirmedLive: true,
			}),
		).resolves.toBeDefined();
	});

	it.each(["order", "oco"] as const)("releases a %s reservation when aborted during confirmation", async (kind) => {
		const exchange = client();
		const placeOrder = vi.spyOn(exchange, "placeOrder");
		const placeOco = vi.spyOn(exchange, "placeOcoOrder");
		const trading = new TradingEngine(config, exchange, stateStore());
		const controller = new AbortController();
		const cancelled = new Error("cancelled during confirmation");
		const confirm = async () => {
			expect(trading.risk.usage().reserved).toBeGreaterThan(0);
			controller.abort(cancelled);
			return true;
		};
		const plan =
			kind === "order"
				? await trading.prepareOrder("buy", { symbol: "BTC/USDT", type: "market", amount: 1 })
				: await trading.prepareOcoOrder({
						symbol: "BTC/USDT",
						side: "buy",
						amount: 1,
						stopLossPrice: 110,
						takeProfitPrice: 90,
					});
		const submit = (signal?: AbortSignal) =>
			"side" in plan
				? trading.placeOrder(plan, signal ? { confirm } : {}, signal)
				: trading.placeOco(plan, signal ? { confirm } : {}, signal);

		await expect(submit(controller.signal)).rejects.toBe(cancelled);
		expect(placeOrder).not.toHaveBeenCalled();
		expect(placeOco).not.toHaveBeenCalled();
		expect(trading.risk.usage()).toMatchObject({ used: 0, reserved: 0 });
		expect(trading.risk.listPendingReservations()).toEqual([]);
		await submit();
		expect(placeOrder.mock.calls.length + placeOco.mock.calls.length).toBe(1);
	});

	it("retains a failed cancellation release and rejects reuse of its plan", async () => {
		const store = stateStore();
		const exchange = client();
		const placeOrder = vi.spyOn(exchange, "placeOrder");
		const trading = new TradingEngine(config, exchange, store);
		const plan = await trading.prepareOrder("buy", { symbol: "BTC/USDT", type: "market", amount: 1 });
		const controller = new AbortController();
		const cancelled = new Error("cancelled during confirmation");
		const failure = trading.placeOrder(
			plan,
			{
				confirm: async () => {
					vi.spyOn(store, "transact").mockImplementationOnce(() => {
						throw new Error("disk unavailable");
					});
					controller.abort(cancelled);
					return true;
				},
			},
			controller.signal,
		);

		await expect(failure).rejects.toMatchObject({
			name: "AggregateError",
			errors: [cancelled, expect.objectContaining({ message: "disk unavailable" })],
		});
		expect(placeOrder).not.toHaveBeenCalled();
		expect(trading.risk.usage()).toMatchObject({ used: 0, reserved: 100 });
		await expect(trading.placeOrder(plan)).rejects.toBeInstanceOf(PreparedPlanError);
	});

	it("releases a reservation when the exchange rejects the order", async () => {
		const store = stateStore();
		const placeOrder = vi.fn(async () => {
			throw new SubmissionRejectedError("HTTP 400 insufficient balance");
		});
		const trading = new TradingEngine(config, client({ placeOrder }), store);
		const plan = await trading.prepareOrder("buy", { symbol: "BTC/USDT", type: "market", amount: 1 });
		await expect(trading.placeOrder(plan)).rejects.toThrow(/insufficient/);
		expect(placeOrder).toHaveBeenCalledTimes(1);
		expect(trading.risk.usage()).toMatchObject({ used: 0, reserved: 0 });
	});

	it("retains an unknown submission claim exactly once", async () => {
		const store = stateStore();
		const placeOrder = vi.fn(async () => {
			throw new Error("network timeout");
		});
		const trading = new TradingEngine(config, client({ placeOrder }), store);
		const plan = await trading.prepareOrder("buy", { symbol: "BTC/USDT", type: "market", amount: 1 });
		await expect(trading.placeOrder(plan, { submissionStatusUnknown: () => true })).rejects.toThrow(
			/submission status unknown/,
		);
		await expect(trading.placeOrder(plan, { submissionStatusUnknown: () => true })).rejects.toBeInstanceOf(
			PreparedPlanError,
		);
		expect(placeOrder).toHaveBeenCalledTimes(1);
		expect(trading.risk.usage()).toMatchObject({ used: 0, reserved: 100 });
	});

	it("retains an adapter-marked unknown submission without a caller classifier", async () => {
		const store = stateStore();
		const placeOrder = vi.fn(async () => {
			throw new SubmissionStatusUnknownError([new Error("network timeout")], "submission status unknown");
		});
		const trading = new TradingEngine(config, client({ placeOrder }), store);
		const plan = await trading.prepareOrder("buy", { symbol: "BTC/USDT", type: "market", amount: 1 });

		await expect(trading.placeOrder(plan)).rejects.toThrow(/submission status unknown/);
		expect(trading.risk.usage()).toMatchObject({ used: 0, reserved: 100 });
	});

	it("does not reserve or submit an already-aborted order", async () => {
		const placeOrder = vi.fn(async () => ({
			order: clientOrder({ symbol: "BTC/USDT", side: "buy", type: "market", amount: 1 }),
		}));
		const trading = makeEngine({ placeOrder });
		const plan = await trading.prepareOrder("buy", { symbol: "BTC/USDT", type: "market", amount: 1 });
		const controller = new AbortController();
		controller.abort(new Error("caller cancelled"));

		await expect(trading.placeOrder(plan, {}, controller.signal)).rejects.toThrow("caller cancelled");
		expect(placeOrder).not.toHaveBeenCalled();
		expect(trading.risk.usage()).toMatchObject({ used: 0, reserved: 0 });
	});

	it.each([80, 120])("settles a completed order using its observed cost of %s", async (cost) => {
		const trading = makeEngine({
			placeOrder: async () => ({
				order: clientOrder({ symbol: "BTC/USDT", side: "buy", type: "market", amount: 1, cost }),
			}),
		});
		const plan = await trading.prepareOrder("buy", { symbol: "BTC/USDT", type: "market", amount: 1 });

		await trading.placeOrder(plan);
		expect(trading.risk.usage()).toMatchObject({ used: cost, reserved: 0 });
	});

	it.each(["order", "oco"] as const)("keeps outstanding %s notional counted after a partial fill", async (kind) => {
		const store = stateStore();
		const partial: Order = {
			...clientOrder({ symbol: "BTC/USDT", side: "buy", type: "market", amount: 1 }),
			type: "limit",
			status: "open",
			filled: 0.1,
			remaining: 0.9,
			cost: 10,
		};
		const exchange = client({
			id: "okx",
			mode: "live",
			placeOrder: async () => ({ order: partial }),
			placeOcoOrder: async (input) => ({ orders: [{ ...partial, clientOrderId: input.listClientOrderId }] }),
		});
		const limits = {
			...config,
			mode: "live" as const,
			risk: { ...config.risk, maxOrderNotional: 110, maxDailyNotional: 110 },
		};
		const trading = new TradingEngine(limits, exchange, store);
		const policy = { allowUnconfirmedLive: true };
		if (kind === "order") {
			await trading.placeOrder(
				await trading.prepareOrder("buy", { symbol: "BTC/USDT", type: "limit", price: 110, amount: 1 }),
				policy,
			);
		} else {
			await trading.placeOco(
				await trading.prepareOcoOrder({
					symbol: "BTC/USDT",
					side: "buy",
					amount: 1,
					stopLossPrice: 110,
					takeProfitPrice: 90,
				}),
				policy,
			);
		}
		expect(trading.risk.usage()).toMatchObject({ used: 110, reserved: 0 });
		const restarted = new TradingEngine(limits, exchange, store);
		const next = await restarted.prepareOrder("buy", { symbol: "BTC/USDT", type: "market", amount: 0.9 });
		await expect(restarted.placeOrder(next, policy)).rejects.toThrow(/daily/i);
	});

	it.each([
		{ positionSide: "LONG", side: "sell", amount: 1 },
		{ positionSide: "SHORT", side: "buy", amount: -1 },
	] as const)(
		"closes hedge $positionSide without new free margin or a reduceOnly flag",
		async ({ positionSide, side, amount }) => {
			const symbol = "BTC/USDT:USDT";
			const placeOrder = vi.fn(async () => ({ order: clientOrder({ symbol, side, type: "market", amount: 1 }) }));
			const exchange = client({
				mode: "live",
				getMarketInfo: async () => ({
					symbol,
					base: "BTC",
					quote: "USDT",
					marketType: "swap",
					contract: true,
					linear: true,
					contractSize: 1,
					amountStep: 0.001,
				}),
				getPositions: async () => [{ symbol, asset: "BTC", amount, positionSide, quoteValue: 100 }],
				getBalances: async () => [{ asset: "USDT", free: 0, used: 10, total: 10 }],
				getEffectiveLeverage: () => 10,
				placeOrder,
			});
			const trading = new TradingEngine(
				{ ...futuresConfig, mode: "live", positionMode: "hedge" },
				exchange,
				stateStore(),
			);
			const intent = { symbol, type: "market" as const, amount: 1, positionSide };
			const plan = await trading.prepareOrder(side, intent);
			await trading.placeOrder(plan, { allowUnconfirmedLive: true });
			expect(plan.reducingPosition).toMatchObject({ symbol, amount, positionSide });
			expect(plan.countTowardsDailyLimit).toBe(false);
			expect(placeOrder).toHaveBeenCalledOnce();
			expect(trading.risk.usage()).toMatchObject({ used: 0, reserved: 0 });
			await expect(trading.prepareOrder(side, { ...intent, amount: 2 })).rejects.toThrow(/exceeds the open/);
		},
	);

	it.each(
		(
			[
				{ positionMode: "one-way", positionSide: "BOTH", side: "sell", direction: 1 },
				{ positionMode: "one-way", positionSide: "BOTH", side: "buy", direction: -1 },
				{ positionMode: "hedge", positionSide: "LONG", side: "sell", direction: 1 },
				{ positionMode: "hedge", positionSide: "SHORT", side: "buy", direction: -1 },
			] as const
		).flatMap((position) =>
			(["paper", "live"] as const).flatMap((mode) =>
				[1e-14, 1, 1e14].map((scale) => ({ ...position, mode, scale })),
			),
		),
	)(
		"allows only arithmetic tails when reducing $mode $positionMode $side at scale $scale",
		async ({ positionMode, positionSide, side, direction, mode, scale }) => {
			const symbol = "BTC/USDT:USDT";
			const amount = 0.2 * scale;
			const remaining = 0.3 * scale - 0.1 * scale;
			const placeOrder = vi.fn(async () => ({
				order: clientOrder({ symbol, side, type: "market", amount, cost: 20 }),
			}));
			const trading = new TradingEngine(
				{ ...futuresConfig, mode, positionMode },
				client({
					mode,
					getTicker: async () => ({ symbol, timestamp: 1, last: 100 / scale }),
					getMarketInfo: async () => ({
						symbol,
						base: "BTC",
						quote: "USDT",
						marketType: "swap",
						contract: true,
						linear: true,
						contractSize: 1,
						amountStep: 0.001 * scale,
					}),
					getPositions: async () => [
						{ symbol, asset: "BTC", amount: direction * remaining, positionSide, quoteValue: 20 },
					],
					placeOrder,
				}),
				stateStore(),
			);
			const intent: OrderIntent = {
				symbol,
				type: "market",
				amount,
				positionSide,
				reduceOnly: positionMode === "one-way" ? true : undefined,
			};
			const plan = await trading.prepareOrder(side, intent);
			expect(plan.input.amount).toBe(amount);
			expect(plan.countTowardsDailyLimit).toBe(false);
			await trading.placeOrder(plan, { allowUnconfirmedLive: true });
			expect(placeOrder).toHaveBeenCalledOnce();
			await expect(trading.prepareOrder(side, { ...intent, amount: 0.201 * scale })).rejects.toThrow(
				/exceeds the open/,
			);
		},
	);

	it("preserves non-retryable risk metadata when unknown submission settlement fails", async () => {
		const store = stateStore();
		const placeOrder = vi.fn(async () => {
			const current = store.state();
			current.paper.reservations = {};
			current.paper.reservedDailyNotional = 0;
			throw new Error("network timeout");
		});
		const trading = new TradingEngine(config, client({ placeOrder }), store);
		const plan = await trading.prepareOrder("buy", { symbol: "BTC/USDT", type: "market", amount: 1 });

		await expect(trading.placeOrder(plan, { submissionStatusUnknown: () => true })).rejects.toMatchObject({
			name: "ExecutionRecoveryError",
			submissionStatus: "unknown",
			retryable: false,
			errorCategory: "EXECUTION_RECOVERY_REQUIRED",
		});
	});

	it("marks a successful submission with a missing reservation as non-retryable", async () => {
		const store = stateStore();
		const placeOrder = vi.fn(async () => {
			const current = store.state();
			current.paper.reservations = {};
			current.paper.reservedDailyNotional = 0;
			return { order: clientOrder({ symbol: "BTC/USDT", side: "buy", type: "market", amount: 1 }) };
		});
		const trading = new TradingEngine(config, client({ placeOrder }), store);
		const plan = await trading.prepareOrder("buy", { symbol: "BTC/USDT", type: "market", amount: 1 });

		await expect(trading.placeOrder(plan)).rejects.toMatchObject({
			name: "ExecutionRecoveryError",
			submissionStatus: "unknown",
			retryable: false,
			errorCategory: "EXECUTION_RECOVERY_REQUIRED",
		});
		expect(placeOrder).toHaveBeenCalledTimes(1);
	});

	it("rejects a plan that was not prepared by this engine", async () => {
		const trading = makeEngine();
		const forged = {
			input: { symbol: "BTC/USDT", side: "buy", type: "market", amount: 1 },
			notional: 100,
			countTowardsDailyLimit: true,
		} as PreparedOrder;
		await expect(trading.placeOrder(forged)).rejects.toThrow(/not prepared by this trading engine/);
	});

	it("keeps the submitted input bound to an immutable prepared snapshot", async () => {
		const placeOrder = vi.fn(async (input) => ({ order: { ...clientOrder(input) } }));
		const trading = makeEngine({ placeOrder });
		const plan = await trading.prepareOrder("buy", { symbol: "BTC/USDT", type: "market", amount: 1 });
		expect(Object.isFrozen(plan)).toBe(true);
		expect(Object.isFrozen(plan.input)).toBe(true);
		const mutable = plan as unknown as { input: { symbol: string; amount: number } };
		expect(() => {
			mutable.input.symbol = "ETH/USDT";
		}).toThrow(TypeError);
		await trading.placeOrder(plan);
		expect(placeOrder).toHaveBeenCalledWith({
			symbol: "BTC/USDT",
			side: "buy",
			type: "market",
			amount: 1,
			clientOrderId: expect.stringMatching(/^ti[A-Za-z0-9]{30}$/),
			price: undefined,
			reduceOnly: undefined,
			positionSide: undefined,
			stopPrice: undefined,
			trailingPercent: undefined,
			closePosition: undefined,
		});
	});
});

function clientOrder(input: {
	symbol: string;
	side: "buy" | "sell";
	type: "market";
	amount: number;
	cost?: number;
}): Order {
	return {
		id: "1",
		symbol: input.symbol,
		side: input.side,
		type: input.type,
		amount: input.amount,
		filled: input.amount,
		remaining: 0,
		cost: input.cost ?? input.amount * 100,
		status: "closed",
		timestamp: 1,
	};
}

describe("close-position planning with unavailable valuation", () => {
	it("derives a finite amount x reference-price notional when quoteValue is unavailable", async () => {
		const trading = makeFuturesEngine({
			getPositions: async () => [
				{
					symbol: "BTC/USDT:USDT",
					asset: "BTC",
					amount: 2,
					positionSide: "BOTH",
					valuationStatus: "unavailable",
					valuationReason: "mark data unavailable",
				},
			],
		});
		const plan = await trading.prepareOrder("sell", closeIntent);
		expect(plan.amount).toBe(2);
		expect(plan.referencePrice).toBe(100);
		expect(plan.referencePriceSource).toBe("last");
		expect(Number.isFinite(plan.notional)).toBe(true);
		expect(plan.notional).toBe(200);
		expect(plan.input).toMatchObject({ amount: 2, reduceOnly: true, closePosition: true });
		expect(plan.summary).toContain("200.00");
		expect(trading.risk.usage()).toMatchObject({ used: 0, reserved: 0 });
	});

	it("keeps a positive finite quote value as the preferred risk notional", async () => {
		const trading = makeFuturesEngine({
			getPositions: async () => [
				{
					symbol: "BTC/USDT:USDT",
					asset: "BTC",
					amount: 2,
					quoteValue: 640,
					positionSide: "BOTH",
					valuationStatus: "complete",
				},
			],
		});
		const plan = await trading.prepareOrder("sell", closeIntent);
		expect(plan.notional).toBe(640);
		expect(plan.amount).toBe(2);
		expect(plan.summary).toContain("640.00");
	});

	it("falls back to the execution estimate when quoteValue is invalid", async () => {
		const trading = makeFuturesEngine({
			getPositions: async () => [
				{
					symbol: "BTC/USDT:USDT",
					asset: "BTC",
					amount: 2,
					quoteValue: Number.NaN,
					positionSide: "BOTH",
					valuationStatus: "unavailable",
				},
			],
		});
		const plan = await trading.prepareOrder("sell", closeIntent);
		expect(plan.notional).toBe(200);
	});

	it("rejects an overflowing amount x reference-price estimate before any reservation", async () => {
		const trading = makeFuturesEngine({
			getPositions: async () => [
				{
					symbol: "BTC/USDT:USDT",
					asset: "BTC",
					amount: 1e308,
					positionSide: "BOTH",
					valuationStatus: "unavailable",
				},
			],
		});
		const planning = trading.prepareOrder("sell", closeIntent);
		await expect(planning).rejects.toThrow(/Order notional must be positive and finite/);
		await expect(planning).rejects.toBeInstanceOf(OrderPreparationError);
		expect(trading.risk.usage()).toMatchObject({ used: 0, reserved: 0 });
	});
});

describe("futures quoteAmount contract lots", () => {
	const doge = "DOGE/USDT:USDT";
	const dogeMarket = {
		symbol: doge,
		base: "DOGE",
		quote: "USDT",
		marketType: "swap" as const,
		contract: true,
		linear: true,
		amountUnit: "contracts" as const,
		contractSize: 1,
		amountPrecision: 0,
		minAmount: 1,
		minNotional: 5,
		active: true,
	};
	const dogeTicker = { symbol: doge, timestamp: 1, last: 0.08224 };

	function dogeEngine(overrides: Partial<ExchangeClient> = {}) {
		return makeFuturesEngine({
			getTicker: async () => dogeTicker,
			getMarketInfo: async () => dogeMarket,
			...overrides,
		});
	}

	it("snaps quoteAmount up to a representable contract lot and min notional", async () => {
		const trading = dogeEngine();
		const plan = await trading.prepareOrder("buy", { symbol: doge, type: "market", quoteAmount: 5 });
		expect(plan.amount).toBe(61);
		expect(plan.input.amount).toBe(61);
		expect(plan.notional).toBeCloseTo(61 * 0.08224);
		expect(plan.notional).toBeGreaterThanOrEqual(5);
	});

	it("raises a ceiled lot that still sits below min notional", async () => {
		const trading = dogeEngine();
		const plan = await trading.prepareOrder("buy", { symbol: doge, type: "market", quoteAmount: 4.9 });
		expect(plan.amount).toBe(61);
		expect(plan.notional).toBeCloseTo(61 * 0.08224);
	});

	it("rejects an explicit amount that is not on the contract grid", async () => {
		const trading = dogeEngine();
		await expect(
			trading.prepareOrder("buy", { symbol: doge, type: "market", amount: 60.79766536964981 }),
		).rejects.toThrow(/cannot be represented exactly/);
	});

	it("reports uncertain futures metadata while validating an explicit amount", async () => {
		const metadataError = new Error("market metadata refresh failed");
		const getMarketInfo = vi.fn().mockRejectedValue(metadataError);
		const trading = dogeEngine({ getMarketInfo });

		await expect(trading.prepareOrder("buy", { symbol: doge, type: "market", amount: 61 })).rejects.toMatchObject({
			name: "OrderPreparationError",
			uncertain: true,
			message: expect.stringContaining("market metadata refresh failed"),
		});
		expect(getMarketInfo).toHaveBeenCalledTimes(1);
	});

	it("rejects an explicit futures amount when contract metadata is incomplete", async () => {
		const trading = dogeEngine({
			getMarketInfo: async () => ({ ...dogeMarket, contractSize: undefined }),
		});

		await expect(trading.prepareOrder("buy", { symbol: doge, type: "market", amount: 61 })).rejects.toMatchObject({
			name: "OrderPreparationError",
			code: "ORDER_PREPARATION_REJECTED",
		});
	});

	it("rejects quoteAmount when amount precision is unavailable", async () => {
		const trading = dogeEngine({
			getMarketInfo: async () => ({ ...dogeMarket, amountPrecision: undefined }),
		});
		await expect(trading.prepareOrder("buy", { symbol: doge, type: "market", quoteAmount: 5 })).rejects.toThrow(
			/amount precision is unavailable/,
		);
	});

	it("uses TICK_SIZE amountStep 1 instead of treating amountPrecision 1 as 0.1 contracts", async () => {
		const trading = dogeEngine({
			getTicker: async () => ({ symbol: doge, timestamp: 1, last: 0.08241 }),
			getMarketInfo: async () => ({ ...dogeMarket, amountPrecision: 1, amountStep: 1 }),
		});
		const plan = await trading.prepareOrder("buy", { symbol: doge, type: "market", quoteAmount: 20 });
		expect(plan.amount).toBe(243);
		expect(plan.input.amount).toBe(243);
	});
});

describe("spot lot precision", () => {
	const market = {
		symbol: "BTC/USDT",
		base: "BTC",
		quote: "USDT",
		marketType: "spot" as const,
		contract: false,
		active: true,
		amountStep: 0.0001,
	};

	it.each(["paper", "live"] as const)("truncates $mode spot buy and sell onto the same amountStep", async (mode) => {
		const trading = new TradingEngine(
			{ ...config, mode },
			client({
				mode,
				getTicker: async () => ({ symbol: "BTC/USDT", timestamp: 1, last: 100_000 }),
				getMarketInfo: async () => market,
			}),
			stateStore(),
		);
		const buy = await trading.prepareOrder("buy", { symbol: "BTC/USDT", type: "market", quoteAmount: 25 });
		const sell = await trading.prepareOrder("sell", { symbol: "BTC/USDT", type: "market", amount: 0.00025 });
		expect(buy.amount).toBe(0.0002);
		expect(buy.input.amount).toBe(0.0002);
		expect(sell.amount).toBe(0.0002);
		expect(sell.input.amount).toBe(0.0002);
	});

	it("truncates a spot OCO amount onto amountStep", async () => {
		const trading = makeEngine({ getMarketInfo: async () => market });
		const plan = await trading.prepareOcoOrder({
			symbol: "BTC/USDT",
			side: "sell",
			amount: 0.00025,
			stopLossPrice: 90,
			takeProfitPrice: 110,
		});
		expect(plan.input.amount).toBe(0.0002);
	});

	it("rejects a spot quoteAmount when amountStep is unavailable", async () => {
		const trading = makeEngine();
		await expect(
			trading.prepareOrder("buy", { symbol: "BTC/USDT", type: "market", quoteAmount: 25 }),
		).rejects.toThrow(/amount precision is unavailable/);
	});

	it("reports uncertain spot metadata while converting quoteAmount", async () => {
		const trading = makeEngine({
			getMarketInfo: async () => {
				throw new Error("market metadata refresh failed");
			},
		});
		await expect(
			trading.prepareOrder("buy", { symbol: "BTC/USDT", type: "market", quoteAmount: 25 }),
		).rejects.toMatchObject({
			name: "OrderPreparationError",
			uncertain: true,
			message: expect.stringContaining("market metadata refresh failed"),
		});
	});
});
