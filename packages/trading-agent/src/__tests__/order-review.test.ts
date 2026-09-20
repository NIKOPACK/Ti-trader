import { type ExtensionContext, initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import {
	type ExchangeClient,
	type MarketInfo,
	type Order,
	type PlaceOcoOrderInput,
	type PlaceOrderInput,
	type Position,
	preflightOco,
	resolveLiveVenue,
	TradingEngine,
	type TradingRiskState,
} from "@nikopack/ti-trading-engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TradingRuntime } from "../context.ts";
import { t } from "../i18n.ts";
import { createOrderReview, OrderReviewPanel, showOrderReview } from "../order-review.ts";
import { DEFAULT_CONFIG, type TradingConfig } from "../state.ts";
import { executeOco, executeOrder } from "../tools/execution.ts";

const timestamp = Date.parse("2026-09-14T06:00:00Z");
const accountId = "a".repeat(64);
const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

function fixture(configPatch: Partial<TradingConfig> = {}, positions: Position[] = []) {
	const config = {
		...structuredClone(DEFAULT_CONFIG),
		language: "en-US" as const,
		mode: "live" as const,
		exchange: "binance",
		orderApproval: "confirm" as const,
		...configPatch,
	};
	const order = (input: PlaceOrderInput): Order => ({
		...input,
		id: "offline-order",
		filled: 0,
		remaining: input.amount,
		cost: 0,
		status: "open",
		timestamp,
	});
	const placeOrder = vi.fn(async (input: PlaceOrderInput) => ({ order: order(input) }));
	const placeOcoOrder = vi.fn(async (input: PlaceOcoOrderInput) => ({
		orders:
			config.mode === "live" && !resolveLiveVenue(config.exchange).supportsNativeOrderList("spot")
				? [
						{
							...order({ ...input, type: "stop_market", stopPrice: input.stopLossPrice }),
							clientOrderId: input.listClientOrderId,
						},
					]
				: [
						{
							...order({ ...input, type: "stop_market", stopPrice: input.stopLossPrice }),
							id: "offline-stop",
							clientOrderId: input.belowClientOrderId,
							listClientOrderId: input.listClientOrderId,
							orderListId: "offline-list",
						},
						{
							...order({ ...input, type: "take_profit_market", stopPrice: input.takeProfitPrice }),
							id: "offline-take",
							clientOrderId: input.aboveClientOrderId,
							listClientOrderId: input.listClientOrderId,
							orderListId: "offline-list",
						},
					],
	}));
	const getTicker = vi.fn(async (symbol: string) => ({ symbol, last: 100, ask: 101, bid: 99, timestamp }));
	const getMarketInfo = vi.fn(async (symbol: string): Promise<MarketInfo> => {
		const futures = symbol.includes(":");
		return {
			symbol,
			base: symbol.split("/")[0],
			quote: "USDT",
			marketType: futures ? "swap" : "spot",
			contract: futures,
			linear: futures ? true : undefined,
			contractSize: futures ? 1 : undefined,
			amountStep: 0.01,
			active: true,
		};
	});
	const getBalances = vi.fn(async () => [
		{ asset: "USDT", free: 10_000, used: 0, total: 10_000 },
		{ asset: "BTC", free: 10, used: 0, total: 10 },
	]);
	const exchange = {
		id: config.exchange,
		mode: config.mode,
		quoteCurrency: config.quoteCurrency,
		getTicker,
		getMarketInfo,
		getBalances,
		getPositions: vi.fn(async () => positions),
		getOpenOrders: vi.fn(async () => []),
		getEffectiveLeverage: () => config.leverage,
		placeOrder,
		placeOcoOrder,
	} as unknown as ExchangeClient;
	let state: TradingRiskState = {
		paper: { date: "2026-09-14", usedDailyNotional: 0 },
		live: { date: "2026-09-14", usedDailyNotional: 0 },
	};
	const engine = new TradingEngine(
		config,
		exchange,
		{
			load: () => structuredClone(state),
			save: (next) => {
				state = structuredClone(next);
			},
			transact: (mutator) => {
				const next = structuredClone(state);
				const result = mutator(next);
				state = next;
				return result;
			},
		},
		undefined,
		{ accountId, durability: "memory" },
	);
	const runtime = { config, mode: config.mode, tradingEngine: engine } as unknown as TradingRuntime;
	const reviewContext = {
		language: config.language,
		quoteCurrency: config.quoteCurrency,
		accountId,
		usage: { used: 12.5, reserved: 23.75, limit: 2000 },
	};
	return { engine, runtime, reviewContext, placeOrder, placeOcoOrder, getTicker, getMarketInfo, getBalances };
}

function rpcContext(confirm = vi.fn(async () => false)) {
	return { mode: "rpc", hasUI: true, ui: { confirm, notify: vi.fn() } } as unknown as ExtensionContext;
}

describe("structured live order review", () => {
	const originalBindings = getKeybindings().getUserBindings();
	beforeEach(() => initTheme("dark", false));
	afterEach(() => {
		getKeybindings().setUserBindings(originalBindings);
		vi.restoreAllMocks();
	});

	it("uses the prepared rounded base amount and exact notional without parsing its summary", async () => {
		const f = fixture();
		const plan = await f.engine.prepareOrder("buy", {
			symbol: "BTC/USDT",
			type: "limit",
			quoteAmount: 113.45,
			price: 100,
		});
		const review = createOrderReview(
			{ kind: "order", plan: { ...plan, summary: "NOT REVIEW DATA" } },
			f.reviewContext,
		);
		expect(review.title).toBe(`Review LIVE order on ${f.runtime.config.exchange}`);
		expect(review.body).toContain("Amount: 1.13 BTC (base units)");
		expect(review.body).toContain("Estimated notional: 113.45 USDT");
		expect(review.body).toContain("Limit price: 100 USDT");
		expect(review.body).toContain("Price source: Limit price");
		expect(review.body).toContain("2026-09-14T06:00:00.000Z");
		expect(review.body).toContain(`Account: ${accountId}`);
		expect(review.body).toContain("Used 12.5 + reserved 23.75 / limit 2000 USDT");
		expect(review.body).toContain("Live fees are unknown");
		expect(review.body).toContain("not guaranteed");
		expect(review.body).not.toContain("NOT REVIEW DATA");
		expect(f.getTicker).toHaveBeenCalledTimes(1);
	});

	it("localizes buy, sell, conditions and notices in Chinese", async () => {
		const f = fixture({ language: "zh-CN" });
		const plan = await f.engine.prepareOrder("sell", {
			symbol: "BTC/USDT",
			type: "stop",
			amount: 1,
			stopPrice: 90,
			price: 89,
		});
		const review = createOrderReview({ kind: "order", plan }, { ...f.reviewContext, protectionStopPrice: 88 });
		expect(review.title).toContain("复核");
		expect(review.body).toContain("卖出");
		expect(review.body).toContain("1 BTC（基础币数量）");
		expect(review.body).toContain("止损限价 (stop)");
		expect(review.body).toContain("触发价: 90 USDT");
		expect(review.body).toContain("限价: 89 USDT");
		expect(review.body).toContain("保护止损价: 88 USDT");
		expect(review.body).toContain("实盘手续费未知");
		expect(review.body).toContain("停止 Agent 不会撤销已提交的订单");
	});

	it("shows the immutable plan version and logical intent alongside the actual order", async () => {
		const f = fixture({ language: "zh-CN" });
		const plan = await f.engine.prepareOrder("buy", { symbol: "BTC/USDT", type: "market", amount: 1 });
		const review = createOrderReview(
			{ kind: "order", plan },
			{ ...f.reviewContext, planReference: { id: "plan-example", version: 3, intentId: "entry-1" } },
		);
		expect(review.body).toContain("交易计划: plan-example v3");
		expect(review.body).toContain("计划订单意图: entry-1");
		expect(review.body).toContain("启用跟踪不等于交易授权");
		expect(review.body).toContain("1 BTC");
	});

	it("shows close-all, reducing intent and exact final exchange constraints", async () => {
		const f = fixture({ exchange: "binance", marketType: "usdm-futures", positionMode: "hedge" }, [
			{ symbol: "BTC/USDT:USDT", asset: "BTC", amount: 2, positionSide: "LONG", avgEntryPrice: 80, quoteValue: 200 },
		]);
		const plan = await f.engine.prepareOrder("sell", {
			symbol: "BTC/USDT:USDT",
			type: "stop_market",
			closePosition: true,
			positionSide: "LONG",
			stopPrice: 90,
		});
		const review = createOrderReview({ kind: "order", plan }, f.reviewContext);
		expect(plan.exchangeConstraint).toBeTruthy();
		expect(review.body).toContain(plan.exchangeConstraint);
		expect(review.body).toContain("Amount: 2 BTC (base units)");
		expect(review.body).toContain("Position side: LONG");
		expect(review.body).toContain("Reduce only: Requested: yes; Applied: no");
		expect(review.body).toContain("Close entire matching position: yes");
		expect(review.body).toContain("Counts towards quota: no");
	});

	it("distinguishes OCO observed notional from conservative buy risk and existing balance preflight", async () => {
		const f = fixture({ language: "zh-CN", exchange: "okx" });
		const plan = await f.engine.prepareOcoOrder({
			symbol: "BTC/USDT",
			side: "buy",
			amount: 1,
			stopLossPrice: 110,
			takeProfitPrice: 90,
		});
		const preflight = await preflightOco(plan, {
			getMarketInfo: f.getMarketInfo,
			getBalances: f.getBalances,
			quoteCurrency: "USDT",
		});
		const review = createOrderReview({ kind: "oco", plan, preflight }, f.reviewContext);
		expect(review.body).toContain("买入");
		expect(review.body).toContain("止损: 110 USDT");
		expect(review.body).toContain("止盈: 90 USDT");
		expect(review.body).toContain("估算名义金额: 100 USDT");
		expect(review.body).toContain("风险名义金额: 110 USDT");
		expect(review.body).toContain("所需余额（估算）: 110 USDT");
		expect(review.body).toContain("价格来源: 最新成交价");
		expect(review.body).toContain("不是最终支出的保证上限");
		expect(review.body).not.toContain("risk ≤");
		expect(f.getTicker).toHaveBeenCalledTimes(1);
	});

	it("marks missing identities and invalid price/time/notional unknown without inventing zeroes", async () => {
		const f = fixture();
		const plan = await f.engine.prepareOrder("buy", { symbol: "BTC/USDT", type: "market", amount: 1 });
		const review = createOrderReview(
			{ kind: "order", plan: { ...plan, notional: 0, referencePrice: Number.NaN, referenceTimestamp: 0 } },
			{
				...f.reviewContext,
				accountId: "api-key-do-not-display",
				usage: { used: 0, reserved: Number.NaN, limit: 0 },
			},
		);
		expect(review.body).toContain("Account: Unavailable");
		expect(review.body).toContain("Estimated notional: Unavailable");
		expect(review.body).toContain("Reference price: Unavailable");
		expect(review.body).toContain("Price observed at: Unavailable");
		expect(review.body).toContain("Used 0 + reserved Unavailable / limit Unavailable");
		expect(review.body).not.toContain("api-key-do-not-display");
		expect(review.body).not.toContain("NaN");
		expect(review.body).not.toContain("1970");
	});

	it("defaults to cancel and requires selecting submission explicitly", () => {
		const review = { language: "en-US" as const, title: "Live", body: "Review" };
		const done = vi.fn();
		const panel = new OrderReviewPanel(review, plainTheme, () => 24, done);
		expect(panel.render(40).join("\n")).toContain("> Cancel; do not submit");
		panel.handleInput("\r");
		expect(done).toHaveBeenLastCalledWith(false);
		panel.handleInput("\x1b[B");
		panel.handleInput("\r");
		expect(done).toHaveBeenLastCalledWith(true);
		panel.handleInput("\x1b");
		expect(done).toHaveBeenLastCalledWith(false);
	});

	it.each([20, 40, 80])("preserves every CJK field with navigable review at %i columns and after resize", (width) => {
		let rows = 16;
		const fields = Array.from({ length: 30 }, (_, i) => `字段${i}: 价格与订单条件`);
		const panel = new OrderReviewPanel(
			{ language: "zh-CN", title: "复核实盘订单", body: fields.join("\n") },
			plainTheme,
			() => rows,
			vi.fn(),
		);
		const collect = (columns: number): string => {
			const screens: string[] = [];
			for (let page = 0; page < 100; page++) {
				const lines = panel.render(columns);
				expect(lines.length).toBeLessThanOrEqual(rows - 2);
				for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(columns);
				const screen = lines.join("\n");
				if (screens.at(-1) === screen) break;
				screens.push(screen);
				panel.handleInput("\x1b[6~");
			}
			return screens.join("\n");
		};
		const text = collect(width);
		for (const field of fields) expect(text).toContain(field.split(":")[0]);
		rows = 12;
		panel.render(20);
		for (let i = 0; i < 100; i++) panel.handleInput("\x1b[5~");
		const resized = collect(20);
		for (const field of fields) expect(resized).toContain(field.split(":")[0]);
	});

	it("uses configured selector and scrolling keybindings", () => {
		getKeybindings().setUserBindings({
			"tui.select.down": "ctrl+n",
			"tui.select.confirm": "ctrl+y",
			"tui.select.cancel": "ctrl+x",
			"tui.select.pageDown": "ctrl+f",
		});
		const done = vi.fn();
		const panel = new OrderReviewPanel(
			{ language: "en-US", title: "Live", body: Array.from({ length: 30 }, (_, i) => `field ${i}`).join("\n") },
			plainTheme,
			() => 16,
			done,
		);
		const initial = panel.render(40).join("\n");
		expect(initial).toContain("ctrl+f");
		panel.handleInput("\x06");
		expect(panel.render(40).join("\n")).not.toEqual(initial);
		panel.handleInput("\x0e");
		panel.handleInput("\x19");
		expect(done).toHaveBeenLastCalledWith(true);
		panel.handleInput("\x18");
		expect(done).toHaveBeenLastCalledWith(false);
	});

	it("keeps very small resized terminals navigable but disables hidden submission controls", () => {
		const done = vi.fn();
		const panel = new OrderReviewPanel(
			{ language: "zh-CN", title: "复核", body: "价格: 100\n数量: 1\n最后字段" },
			plainTheme,
			() => 6,
			done,
		);
		const screens: string[] = [];
		for (let page = 0; page < 30; page++) {
			const lines = panel.render(10);
			expect(lines.length).toBeLessThanOrEqual(4);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(10);
			screens.push(lines.join("\n"));
			panel.handleInput("\x1b[6~");
		}
		expect(screens.join("\n")).toContain("最后字段");
		panel.handleInput("\x1b[B");
		panel.handleInput("\r");
		expect(done).toHaveBeenCalledWith(false);
	});

	it("uses custom TUI review and dismisses it on abort without leaving a listener", async () => {
		const controller = new AbortController();
		const removeListener = vi.spyOn(controller.signal, "removeEventListener");
		type Factory = Parameters<ExtensionContext["ui"]["custom"]>[0];
		type FactoryArgs = Parameters<Factory>;
		const custom = vi.fn(async (factory: Factory) => {
			const done = vi.fn();
			const panel = await factory(
				{ terminal: { rows: 24 } } as FactoryArgs[0],
				plainTheme,
				{} as FactoryArgs[2],
				done,
			);
			expect(panel.render(40).join("\n")).toContain("> Cancel; do not submit");
			controller.abort();
			expect(done).toHaveBeenCalledWith(false);
			panel.dispose?.();
			return false;
		});
		const ctx = { mode: "tui", hasUI: true, ui: { custom, confirm: vi.fn() } } as unknown as ExtensionContext;
		expect(await showOrderReview(ctx, { language: "en-US", title: "Live", body: "Review" }, controller.signal)).toBe(
			false,
		);
		expect(ctx.ui.confirm).not.toHaveBeenCalled();
		expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
	});

	it("never submits before rendering or after the review has no visible width", () => {
		const done = vi.fn();
		const panel = new OrderReviewPanel(
			{ language: "en-US", title: "Live", body: "Review" },
			plainTheme,
			() => 24,
			done,
		);
		panel.handleInput("\x1b[B");
		panel.handleInput("\r");
		expect(done).toHaveBeenLastCalledWith(false);
		panel.render(80);
		expect(panel.render(0)).toEqual([]);
		panel.handleInput("\x1b[B");
		panel.handleInput("\r");
		expect(done).toHaveBeenLastCalledWith(false);
	});

	it("retains RPC confirmation with the complete localized structured body and abort signal", async () => {
		const f = fixture({ language: "zh-CN" });
		const plan = await f.engine.prepareOrder("buy", { symbol: "BTC/USDT", type: "market", amount: 1 });
		const review = createOrderReview({ kind: "order", plan }, f.reviewContext);
		const ctx = rpcContext();
		const controller = new AbortController();
		expect(await showOrderReview(ctx, review, controller.signal)).toBe(false);
		expect(ctx.ui.confirm).toHaveBeenCalledWith(review.title, review.body, { signal: controller.signal });
		controller.abort();
		await showOrderReview(ctx, review, controller.signal);
		expect(ctx.ui.confirm).toHaveBeenCalledTimes(1);
	});

	it("shows the engine reservation at confirmation, localizes cancellation and never submits after rejection", async () => {
		const f = fixture({ language: "zh-CN" });
		const ctx = rpcContext(
			vi.fn(async (_title?: string, body?: string) => {
				expect(f.engine.risk.usage().reserved).toBe(101);
				expect(body).toContain("预占 101");
				return false;
			}),
		);
		const result = await executeOrder("buy", { symbol: "BTC/USDT", type: "market", amount: 1 }, ctx, f.runtime);
		expect(result.details).toMatchObject({ status: "cancelled" });
		expect(ctx.ui.notify).toHaveBeenCalledWith(t("zh-CN", "orderReviewCancelled"), "info");
		expect(f.placeOrder).not.toHaveBeenCalled();
		expect(f.engine.risk.usage().reserved).toBe(0);
		expect(f.getTicker).toHaveBeenCalledTimes(2);
	});

	it("shows the updated live review when market evidence is requoted after confirmation", async () => {
		const f = fixture();
		let ask = 100;
		f.getTicker.mockImplementation(async (symbol: string) => ({
			symbol,
			last: ask,
			ask,
			bid: ask,
			timestamp,
		}));
		const bodies: string[] = [];
		const ctx = rpcContext(
			vi.fn(async (_title?: string, body?: string) => {
				bodies.push(body ?? "");
				if (bodies.length === 1) ask = 105;
				return true;
			}),
		);
		await executeOrder("buy", { symbol: "BTC/USDT", type: "market", amount: 1 }, ctx, f.runtime);
		expect(bodies).toHaveLength(2);
		expect(bodies[0]).toContain("Estimated notional: 100 USDT");
		expect(bodies[1]).toContain("Estimated notional: 105 USDT");
		expect(bodies[1]).toContain("Market evidence changed after the previous confirmation");
		expect(f.placeOrder).toHaveBeenCalledTimes(1);
	});

	it("overlays requote evidence on the structured review without fetching a second plan", async () => {
		const f = fixture();
		const plan = await f.engine.prepareOrder("buy", { symbol: "BTC/USDT", type: "market", amount: 1 });
		const review = createOrderReview(
			{ kind: "order", plan },
			{
				...f.reviewContext,
				confirmation: {
					summary: "BUY 1 BTC/USDT (market) ≈ 105.00 USDT",
					referencePrice: 105,
					amount: 1,
					notional: 105,
					riskNotional: 105,
					warnings: ["capability unknown"],
					requote: true,
				},
			},
		);
		expect(review.body).toContain("Market evidence changed after the previous confirmation");
		expect(review.body).toContain("Estimated notional: 105 USDT");
		expect(review.body).toContain("Reference price: 105 USDT");
		expect(review.body).toContain("Warnings: capability unknown");
		expect(review.body).not.toContain(plan.summary);
	});

	it("submits the exact reviewed plan after confirmation and retains final revalidation", async () => {
		const f = fixture();
		const ctx = rpcContext(
			vi.fn(async (_title?: string, body?: string) => {
				expect(body).toContain("Amount: 1.13 BTC (base units)");
				expect(body).toContain("Limit price: 100 USDT");
				return true;
			}),
		);
		await executeOrder("buy", { symbol: "BTC/USDT", type: "limit", quoteAmount: 113.45, price: 100 }, ctx, f.runtime);
		expect(f.placeOrder).toHaveBeenCalledWith(expect.objectContaining({ amount: 1.13, price: 100, type: "limit" }));
		expect(f.getTicker).toHaveBeenCalledTimes(1);
		expect(f.getMarketInfo).toHaveBeenCalledTimes(3);
		expect(f.getBalances).toHaveBeenCalledTimes(2);
	});

	it("does not submit if final balance revalidation or abort rejects an approved order", async () => {
		const f = fixture();
		const ctx = rpcContext(
			vi.fn(async () => {
				f.getBalances.mockResolvedValue([{ asset: "USDT", free: 0, used: 0, total: 0 }]);
				return true;
			}),
		);
		await expect(
			executeOrder("buy", { symbol: "BTC/USDT", type: "market", amount: 1 }, ctx, f.runtime),
		).rejects.toThrow("Insufficient");
		expect(f.placeOrder).not.toHaveBeenCalled();
		expect(f.engine.risk.usage().reserved).toBe(0);

		const second = fixture();
		const controller = new AbortController();
		const abortContext = rpcContext(
			vi.fn(async () => {
				controller.abort(new Error("offline abort"));
				return true;
			}),
		);
		await expect(
			executeOrder(
				"buy",
				{ symbol: "BTC/USDT", type: "market", amount: 1 },
				abortContext,
				second.runtime,
				controller.signal,
			),
		).rejects.toThrow("offline abort");
		expect(second.placeOrder).not.toHaveBeenCalled();
		expect(second.engine.risk.usage().reserved).toBe(0);
	});

	it("reviews the same OCO plan and reserved risk from the engine confirmation snapshot", async () => {
		const f = fixture({ exchange: "okx" });
		const ctx = rpcContext(
			vi.fn(async (_title?: string, body?: string) => {
				expect(body).toContain("Estimated notional: 100 USDT");
				expect(body).toContain("Risk notional: 110 USDT");
				expect(body).toContain("reserved 110");
				return true;
			}),
		);
		await executeOco(
			{ symbol: "BTC/USDT", side: "buy", amount: 1, stopLossPrice: 110, takeProfitPrice: 90 },
			ctx,
			() => f.runtime,
		);
		expect(f.placeOcoOrder).toHaveBeenCalledWith(
			expect.objectContaining({ amount: 1, stopLossPrice: 110, takeProfitPrice: 90 }),
		);
		expect(f.getTicker).toHaveBeenCalledTimes(3);
	});

	it.each(["paper", "unattended", "headless"] as const)("preserves the %s submission policy", async (policy) => {
		const f = fixture(
			policy === "paper" ? { mode: "paper" } : { orderApproval: policy === "unattended" ? "unattended" : "confirm" },
		);
		const ctx = rpcContext();
		ctx.hasUI = false;
		const submission = executeOrder("buy", { symbol: "BTC/USDT", type: "market", amount: 1 }, ctx, f.runtime);
		if (policy === "headless") {
			await expect(submission).rejects.toThrow("no UI is available");
			expect(f.placeOrder).not.toHaveBeenCalled();
			expect(f.engine.risk.usage().reserved).toBe(0);
		} else {
			await expect(submission).resolves.toHaveProperty("details.status", "ok");
			expect(f.placeOrder).toHaveBeenCalledTimes(1);
		}
		expect(ctx.ui.confirm).not.toHaveBeenCalled();
	});
});
