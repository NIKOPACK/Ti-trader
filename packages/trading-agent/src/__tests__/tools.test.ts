import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { RiskReservation, TradingRuntime } from "../context.ts";
import type { ExchangeClient, Order, PlaceOrderInput, Position } from "../exchange/types.ts";
import { DEFAULT_CONFIG, type TradingConfig } from "../state.ts";
import { createSellTool } from "../tools/index.ts";

type SellToolParams = Parameters<ReturnType<typeof createSellTool>["execute"]>[1];

function filledOrder(input: PlaceOrderInput): Order {
	return {
		id: "filled-1",
		symbol: input.symbol,
		side: input.side,
		type: input.type,
		price: input.price,
		stopPrice: input.stopPrice,
		positionSide: input.positionSide,
		reduceOnly: input.reduceOnly,
		closePosition: input.closePosition,
		amount: input.amount,
		filled: input.amount,
		remaining: 0,
		average: 100,
		cost: input.amount * 100,
		status: "closed",
		timestamp: 1,
	};
}

function createRuntime(options: { config?: TradingConfig; positions?: Position[] } = {}) {
	const config = options.config ?? DEFAULT_CONFIG;
	const placeOrder = vi.fn(async (input: PlaceOrderInput) => ({ order: filledOrder(input) }));
	const getPositions = vi.fn(async () => options.positions ?? []);
	const exchange = {
		id: config.exchange,
		mode: config.mode,
		quoteCurrency: config.quoteCurrency,
		getTicker: vi.fn(async (symbol: string) => ({
			symbol,
			last: 100,
			bid: 99,
			ask: 101,
			timestamp: 1,
		})),
		getPositions,
		placeOrder,
	} as unknown as ExchangeClient;
	const commit = vi.fn();
	const release = vi.fn();
	const reserveRisk = vi.fn(
		(_symbol: string, _notional: number, _options: { countTowardsDailyLimit?: boolean }): RiskReservation => ({
			commit,
			release,
		}),
	);
	const runtime = {
		config,
		mode: config.mode,
		exchange,
		reserveRisk,
		dailyUsage: () => ({ date: "2026-08-28", used: 0, reserved: 0, limit: 2000, resetPolicy: "manual" }),
	} as unknown as TradingRuntime;
	return { commit, getPositions, placeOrder, release, reserveRisk, runtime };
}

const context = {
	hasUI: false,
	ui: { confirm: vi.fn(), notify: vi.fn() },
} as unknown as ExtensionContext;

describe("trading order tools", () => {
	it("uses the real position amount and quote value for market closePosition", async () => {
		const position: Position = {
			symbol: "BTC/USDT:USDT",
			asset: "BTC",
			amount: 0.75,
			quoteValue: 75,
			positionSide: "BOTH",
		};
		const { commit, placeOrder, reserveRisk, runtime } = createRuntime({
			config: { ...DEFAULT_CONFIG, exchange: "binance", marketType: "usdm-futures" },
			positions: [position],
		});
		const tool = createSellTool(() => runtime);

		await tool.execute(
			"close-market",
			{ symbol: position.symbol, type: "market", closePosition: true },
			undefined,
			undefined,
			context,
		);

		expect(reserveRisk).toHaveBeenCalledWith(position.symbol, 75, { countTowardsDailyLimit: false });
		expect(placeOrder).toHaveBeenCalledWith({
			symbol: position.symbol,
			side: "sell",
			type: "market",
			amount: 0.75,
			price: undefined,
			reduceOnly: true,
			positionSide: undefined,
			stopPrice: undefined,
			trailingPercent: undefined,
			closePosition: true,
		});
		expect(commit).toHaveBeenCalledOnce();
	});

	it.each([
		["market", undefined],
		["stop_market", 90],
		["take_profit_market", 120],
	] as const)("allows %s closePosition orders", async (type, stopPrice) => {
		const position: Position = {
			symbol: "BTC/USDT:USDT",
			asset: "BTC",
			amount: 1,
			quoteValue: 100,
			positionSide: "BOTH",
		};
		const { placeOrder, runtime } = createRuntime({
			config: { ...DEFAULT_CONFIG, exchange: "binance", marketType: "usdm-futures" },
			positions: [position],
		});
		const tool = createSellTool(() => runtime);
		const params: SellToolParams = {
			symbol: position.symbol,
			type,
			closePosition: true,
			...(stopPrice === undefined ? {} : { stopPrice }),
		};

		await tool.execute(`close-${type}`, params, undefined, undefined, context);

		expect(placeOrder).toHaveBeenCalledOnce();
	});

	it.each(["stop", "take_profit"] as const)("rejects closePosition with %s limit execution", async (type) => {
		const { getPositions, placeOrder, runtime } = createRuntime({
			config: { ...DEFAULT_CONFIG, exchange: "binance", marketType: "usdm-futures" },
		});
		const tool = createSellTool(() => runtime);

		await expect(
			tool.execute(
				`close-${type}`,
				{ symbol: "BTC/USDT:USDT", type, price: 95, stopPrice: 90, closePosition: true },
				undefined,
				undefined,
				context,
			),
		).rejects.toThrow(/only for market, stop_market or take_profit_market/);
		expect(getPositions).not.toHaveBeenCalled();
		expect(placeOrder).not.toHaveBeenCalled();
	});

	it("does not charge spot sell protection against the entry quota", async () => {
		const { reserveRisk, runtime } = createRuntime();
		const tool = createSellTool(() => runtime);

		await tool.execute(
			"protect-spot",
			{ symbol: "BTC/USDT", type: "stop_market", amount: 1, stopPrice: 90 },
			undefined,
			undefined,
			context,
		);

		expect(reserveRisk).toHaveBeenCalledWith("BTC/USDT", 90, { countTowardsDailyLimit: false });
	});
});
