import type { AgentToolResult, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { getTrading } from "../context.ts";
import type { PlaceOrderInput } from "../exchange/types.ts";

const SYMBOL_DESC = `Market symbol in ccxt format, e.g. "BTC/USDT". The quote currency must match the configured quote currency.`;

const getPriceSchema = Type.Object({
	symbol: Type.String({ description: SYMBOL_DESC }),
});
const marketInfoSchema = Type.Object({ symbol: Type.String({ description: SYMBOL_DESC }) });
const depthSchema = Type.Object({
	symbol: Type.String({ description: SYMBOL_DESC }),
	limit: Type.Optional(
		Type.Integer({ minimum: 5, maximum: 100, description: "Number of price levels per side. Default 20." }),
	),
});

const getKlinesSchema = Type.Object({
	symbol: Type.String({ description: SYMBOL_DESC }),
	timeframe: Type.Optional(
		Type.String({ description: "Candle timeframe, e.g. 1m, 5m, 15m, 1h, 4h, 1d. Default 1h." }),
	),
	limit: Type.Optional(Type.Number({ description: "Number of candles, max 200. Default 100." })),
});

const emptySchema = Type.Object({});
const futuresSymbolSchema = Type.Object({
	symbol: Type.String({ description: 'Binance USDⓈ-M ccxt symbol, e.g. "BTC/USDT:USDT".' }),
});
const leverageSchema = Type.Object({ symbol: Type.String(), leverage: Type.Integer({ minimum: 1, maximum: 125 }) });
const marginSchema = Type.Object({
	symbol: Type.String(),
	marginType: Type.Union([Type.Literal("isolated"), Type.Literal("cross")]),
});

const symbolFilterSchema = Type.Object({
	symbol: Type.Optional(Type.String({ description: SYMBOL_DESC })),
});

const orderHistorySchema = Type.Object({
	symbol: Type.Optional(Type.String({ description: SYMBOL_DESC })),
	limit: Type.Optional(Type.Number({ description: "Max orders to return. Default 20, max 100." })),
});

const orderSchema = Type.Object({
	symbol: Type.String({ description: SYMBOL_DESC }),
	type: Type.Union(
		[
			Type.Literal("market"),
			Type.Literal("limit"),
			Type.Literal("stop"),
			Type.Literal("stop_market"),
			Type.Literal("take_profit"),
			Type.Literal("take_profit_market"),
			Type.Literal("trailing_stop_market"),
		],
		{
			description:
				"market/limit execute normally. stop/stop_market trigger when the price moves against you " +
				"(sell: falls to stopPrice — a stop-loss; buy: rises to stopPrice). take_profit/take_profit_market " +
				"trigger when the price moves in your favor (sell: rises to stopPrice; buy: falls to stopPrice). " +
				"stop/take_profit rest as limit orders at `price` after triggering; the _market variants fill immediately. " +
				"trailing_stop_market trails the best price by trailingPercent and fires on the pullback.",
		},
	),
	amount: Type.Optional(Type.Number({ description: "Amount in base currency, e.g. 0.01 BTC" })),
	quoteAmount: Type.Optional(Type.Number({ description: "Amount in quote currency, e.g. 100 USDT" })),
	price: Type.Optional(Type.Number({ description: "Limit price (required for limit, stop and take_profit orders)" })),
	reduceOnly: Type.Optional(Type.Boolean()),
	positionSide: Type.Optional(Type.Union([Type.Literal("BOTH"), Type.Literal("LONG"), Type.Literal("SHORT")])),
	stopPrice: Type.Optional(
		Type.Number({
			exclusiveMinimum: 0,
			description:
				"Trigger price for stop/take-profit orders. For trailing_stop_market it is the optional activation " +
				"price (live mode only).",
		}),
	),
	trailingPercent: Type.Optional(
		Type.Number({
			exclusiveMinimum: 0,
			maximum: 99,
			description:
				"Trailing distance in percent for trailing_stop_market, e.g. 2 = trigger after a 2% pullback " +
				"from the best price since placement.",
		}),
	),
	closePosition: Type.Optional(Type.Boolean()),
});

const cancelOrderSchema = Type.Object({
	id: Type.String({ description: "Order id (see get_open_orders)" }),
	symbol: Type.String({ description: SYMBOL_DESC }),
});

const ocoSchema = Type.Object({
	symbol: Type.String({ description: SYMBOL_DESC }),
	side: Type.Union([Type.Literal("buy"), Type.Literal("sell")], {
		description:
			"sell protects an existing holding (the usual bracket: stop-loss below, take-profit above). " +
			"buy brackets a planned entry (stop above, dip target below).",
	}),
	amount: Type.Number({ exclusiveMinimum: 0, description: "Amount in base currency, e.g. 0.01 BTC" }),
	stopLossPrice: Type.Number({
		exclusiveMinimum: 0,
		description: "Stop-loss trigger price, on the adverse side of the current price (sell: below, buy: above).",
	}),
	takeProfitPrice: Type.Number({
		exclusiveMinimum: 0,
		description: "Take-profit trigger price, on the favourable side of the current price (sell: above, buy: below).",
	}),
});

type OcoToolParams = Static<typeof ocoSchema>;

type OrderToolParams = Static<typeof orderSchema>;

function jsonResult(data: unknown): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
		details: data,
	};
}

function round(n: number | undefined, decimals = 8): number | undefined {
	if (n === undefined || !Number.isFinite(n)) return undefined;
	const f = 10 ** decimals;
	return Math.round(n * f) / f;
}

export function createGetPriceTool(): ToolDefinition<typeof getPriceSchema> {
	return {
		name: "get_price",
		label: "get_price",
		description: "Get the latest ticker for a market: last price, bid/ask, 24h high/low, 24h change %, 24h volume.",
		parameters: getPriceSchema,
		async execute(_id, params) {
			const t = await getTrading().exchange.getTicker(params.symbol);
			return jsonResult({
				symbol: t.symbol,
				last: t.last,
				bid: t.bid ?? null,
				ask: t.ask ?? null,
				dataQuality: { last: Number.isFinite(t.last), bid: t.bid !== undefined, ask: t.ask !== undefined },
				warnings: [
					...(t.bid === undefined ? ["bid unavailable"] : []),
					...(t.ask === undefined ? ["ask unavailable"] : []),
				],
				high24h: t.high24h,
				low24h: t.low24h,
				changePct24h: round(t.changePct24h, 2),
				volume24h: round(t.volume24h, 2),
				quoteVolume24h: round(t.quoteVolume24h, 0),
				time: new Date(t.timestamp).toISOString(),
			});
		},
	};
}

export function createGetOrderBookTool(): ToolDefinition<typeof depthSchema> {
	return {
		name: "get_order_book",
		label: "get_order_book",
		description: "Get live bids and asks, spread, and aggregate depth. Empty sides are unavailable, not zero-priced.",
		parameters: depthSchema,
		async execute(_id, params) {
			const book = await getTrading().exchange.getOrderBook(params.symbol, params.limit ?? 20);
			return jsonResult({
				...book,
				time: new Date(book.timestamp).toISOString(),
				dataQuality: { bids: book.bids.length > 0, asks: book.asks.length > 0 },
				warnings: [
					...(book.bids.length === 0 ? ["bid order book unavailable"] : []),
					...(book.asks.length === 0 ? ["ask order book unavailable"] : []),
				],
			});
		},
	};
}

export function createGetMarketInfoTool(): ToolDefinition<typeof marketInfoSchema> {
	return {
		name: "get_market_info",
		label: "get_market_info",
		description: "Get exchange market rules: spot/swap type, settlement, precision, limits, and contract metadata.",
		parameters: marketInfoSchema,
		async execute(_id, params) {
			const info = await getTrading().exchange.getMarketInfo(params.symbol);
			return jsonResult({
				...info,
				dataQuality: {
					marketType: true,
					settlement: info.settle !== undefined,
					limits: info.minAmount !== undefined || info.minNotional !== undefined,
				},
				warnings: [
					...(info.settle === undefined ? ["settlement asset unavailable"] : []),
					...(info.minAmount === undefined && info.minNotional === undefined ? ["order limits unavailable"] : []),
				],
			});
		},
	};
}

export function createGetContractStatsTool(): ToolDefinition<typeof futuresSymbolSchema> {
	return {
		name: "get_contract_stats",
		label: "get_contract_stats",
		description:
			"Get futures mark price, index price, funding, open interest, and basis. Unavailable fields stay null.",
		parameters: futuresSymbolSchema,
		async execute(_id, params) {
			const stats = await getTrading().exchange.getContractStats(params.symbol);
			return jsonResult({
				...stats,
				dataQuality: {
					markPrice: stats.markPrice !== undefined,
					indexPrice: stats.indexPrice !== undefined,
					fundingRate: stats.fundingRate !== undefined,
					openInterest: stats.openInterest !== undefined,
				},
				warnings: [
					...(stats.markPrice === undefined ? ["mark price unavailable"] : []),
					...(stats.indexPrice === undefined ? ["index price unavailable"] : []),
				],
			});
		},
	};
}

export function createGetKlinesTool(): ToolDefinition<typeof getKlinesSchema> {
	return {
		name: "get_klines",
		label: "get_klines",
		description:
			"Get OHLCV candlesticks for a market, oldest first. Use for trend/momentum analysis. " +
			"Timeframes: 1m, 5m, 15m, 1h, 4h, 1d, ...",
		parameters: getKlinesSchema,
		async execute(_id, params) {
			const limit = Math.min(Math.max(Math.floor(params.limit ?? 100), 1), 200);
			const klines = await getTrading().exchange.getKlines(params.symbol, params.timeframe ?? "1h", limit);
			return jsonResult({
				symbol: params.symbol,
				timeframe: params.timeframe ?? "1h",
				count: klines.length,
				candles: klines.map((k) => [
					new Date(k.timestamp).toISOString(),
					k.open,
					k.high,
					k.low,
					k.close,
					round(k.volume, 4),
				]),
			});
		},
	};
}

export function createGetBalanceTool(): ToolDefinition<typeof emptySchema> {
	return {
		name: "get_balance",
		label: "get_balance",
		description:
			"Get account balances (non-zero assets) with estimated value in quote currency. " +
			"In paper mode this is the simulated account.",
		parameters: emptySchema,
		async execute() {
			const trading = getTrading();
			const balances = await trading.exchange.getBalances();
			const totalQuote = balances.reduce((sum, b) => sum + (b.quoteValue ?? 0), 0);
			return jsonResult({
				mode: trading.mode,
				exchange: trading.exchange.id,
				quoteCurrency: trading.exchange.quoteCurrency,
				totalQuoteValue: round(totalQuote, 2),
				balances: balances.map((b) => ({
					asset: b.asset,
					free: round(b.free),
					used: round(b.used),
					total: round(b.total),
					quoteValue: round(b.quoteValue, 2),
				})),
			});
		},
	};
}

export function createGetPositionsTool(): ToolDefinition<typeof emptySchema> {
	return {
		name: "get_positions",
		label: "get_positions",
		description:
			"Get current spot holdings valued in quote currency. In paper mode includes average entry price " +
			"and unrealized PnL per position.",
		parameters: emptySchema,
		async execute() {
			const trading = getTrading();
			const positions = await trading.exchange.getPositions();
			return jsonResult({
				mode: trading.mode,
				count: positions.length,
				positions: positions.map((p) => ({
					symbol: p.symbol,
					amount: round(p.amount),
					quoteValue: round(p.quoteValue, 2),
					avgEntryPrice: p.avgEntryPrice,
					unrealizedPnl: round(p.unrealizedPnl, 2),
					unrealizedPnlPct: round(p.unrealizedPnlPct, 2),
				})),
			});
		},
	};
}

export function createGetOpenOrdersTool(): ToolDefinition<typeof symbolFilterSchema> {
	return {
		name: "get_open_orders",
		label: "get_open_orders",
		description: "List open (unfilled) orders, optionally filtered by symbol.",
		parameters: symbolFilterSchema,
		async execute(_id, params) {
			const orders = await getTrading().exchange.getOpenOrders(params.symbol);
			return jsonResult({
				count: orders.length,
				orders: orders.map(formatOrder),
			});
		},
	};
}

export function createGetOrderHistoryTool(): ToolDefinition<typeof orderHistorySchema> {
	return {
		name: "get_order_history",
		label: "get_order_history",
		description: "List recently closed/filled orders, optionally filtered by symbol.",
		parameters: orderHistorySchema,
		async execute(_id, params) {
			const limit = Math.min(Math.max(Math.floor(params.limit ?? 20), 1), 100);
			const orders = await getTrading().exchange.getOrderHistory(params.symbol, limit);
			return jsonResult({
				count: orders.length,
				orders: orders.map(formatOrder),
			});
		},
	};
}

async function executeOrder(
	side: "buy" | "sell",
	params: OrderToolParams,
	ctx: ExtensionContext,
): Promise<AgentToolResult<unknown>> {
	const trading = getTrading();
	const { config } = trading;

	const priceRequired = params.type === "limit" || params.type === "stop" || params.type === "take_profit";
	if (priceRequired && (params.price === undefined || !Number.isFinite(params.price) || params.price <= 0)) {
		throw new Error(`${params.type} orders require a positive price`);
	}
	const stopType =
		params.type === "stop" ||
		params.type === "stop_market" ||
		params.type === "take_profit" ||
		params.type === "take_profit_market";
	if (stopType && (params.stopPrice === undefined || !Number.isFinite(params.stopPrice) || params.stopPrice <= 0)) {
		throw new Error(`${params.type} orders require a positive stopPrice`);
	}
	if (params.type === "trailing_stop_market") {
		if (
			params.trailingPercent === undefined ||
			!Number.isFinite(params.trailingPercent) ||
			params.trailingPercent <= 0 ||
			params.trailingPercent >= 100
		) {
			throw new Error("trailing_stop_market orders require trailingPercent in (0, 100)");
		}
	} else if (params.trailingPercent !== undefined) {
		throw new Error("trailingPercent is only valid for trailing_stop_market orders");
	}
	if (params.closePosition && params.type !== "market" && !stopType)
		throw new Error("closePosition is supported only for market or stop/take-profit orders");
	if (params.closePosition && (params.amount !== undefined || params.quoteAmount !== undefined)) {
		throw new Error("closePosition orders must omit amount and quoteAmount");
	}
	if (params.closePosition && params.reduceOnly === false) throw new Error("closePosition is always reduceOnly");
	if (config.marketType === "usdm-futures") {
		if (config.positionMode === "hedge" && (!params.positionSide || params.positionSide === "BOTH")) {
			throw new Error("Hedge mode futures orders require positionSide LONG or SHORT");
		}
		if (config.positionMode === "one-way" && params.positionSide && params.positionSide !== "BOTH") {
			throw new Error("One-way mode futures orders must use positionSide BOTH or omit it");
		}
	}

	if (!params.closePosition && (params.amount === undefined) === (params.quoteAmount === undefined)) {
		throw new Error("Provide exactly one of amount (base currency) or quoteAmount (quote currency)");
	}
	if (
		!params.closePosition &&
		params.amount !== undefined &&
		(!Number.isFinite(params.amount) || params.amount <= 0)
	) {
		throw new Error("amount must be a positive finite number");
	}
	if (
		!params.closePosition &&
		params.quoteAmount !== undefined &&
		(!Number.isFinite(params.quoteAmount) || params.quoteAmount <= 0)
	) {
		throw new Error("quoteAmount must be a positive finite number");
	}

	// Resolve base amount and estimated notional against the current price.
	const ticker = await trading.exchange.getTicker(params.symbol);
	const refPrice =
		params.price ?? params.stopPrice ?? (side === "buy" ? ticker.ask || ticker.last : ticker.bid || ticker.last);
	if (!refPrice || refPrice <= 0) throw new Error(`No reference price for ${params.symbol}`);

	let amount = params.amount;
	if (amount === undefined && !params.closePosition) amount = (params.quoteAmount ?? 0) / refPrice;
	if (!params.closePosition && (!amount || amount <= 0)) throw new Error("Order amount must be positive");
	const notional = params.closePosition ? 0 : (params.quoteAmount ?? (amount ?? 0) * refPrice);

	const riskError = trading.checkRisk(params.symbol, notional);
	if (riskError) throw new Error(`Risk limit: ${riskError}`);

	const summary =
		`${side.toUpperCase()} ${amount} ${params.symbol} (${params.type})` +
		(params.price !== undefined ? ` @ ${params.price}` : "") +
		(params.stopPrice !== undefined ? ` trigger ${params.stopPrice}` : "") +
		(params.trailingPercent !== undefined ? ` trail ${params.trailingPercent}%` : "") +
		` ≈ ${notional.toFixed(2)} ${config.quoteCurrency}`;

	if (trading.mode === "live" && config.confirmLiveOrders) {
		if (!ctx.hasUI) {
			throw new Error(
				"Live orders require interactive confirmation but no UI is available. " +
					"Set confirmLiveOrders=false in ~/.ti-trader/agent/trading.json to allow headless live trading.",
			);
		}
		const usage = trading.dailyUsage();
		const confirmed = await ctx.ui.confirm(
			`Confirm LIVE order on ${config.exchange}`,
			`${summary}\n\nDaily notional after fill: ${(usage.used + notional).toFixed(2)} / ${usage.limit} ${config.quoteCurrency}`,
		);
		if (!confirmed) {
			ctx.ui.notify("Order cancelled by user", "info");
			return jsonResult({ status: "cancelled", reason: "user rejected confirmation", order: summary });
		}
	}

	const input: PlaceOrderInput = {
		symbol: params.symbol,
		side,
		type: params.type,
		amount: amount ?? 0,
		price: priceRequired ? params.price : undefined,
		reduceOnly: params.reduceOnly,
		positionSide: params.positionSide,
		stopPrice: params.stopPrice,
		trailingPercent: params.trailingPercent,
		closePosition: params.closePosition,
	};
	const result = await trading.exchange.placeOrder(input);
	trading.recordFill(notional);

	return jsonResult({
		status: "ok",
		mode: trading.mode,
		summary,
		fee: round(result.fee, 4),
		order: formatOrder(result.order),
	});
}

export function createBuyTool(): ToolDefinition<typeof orderSchema> {
	return {
		name: "buy",
		label: "buy",
		description:
			"Place a buy order (spot or Binance USDⓈ-M futures). Use quoteAmount for a fixed quote value, or amount for " +
			"base units. Supports take-profit/stop-loss (stop, stop_market, take_profit, take_profit_market with " +
			"stopPrice) and trailing stops (trailing_stop_market with trailingPercent) in paper and live mode. " +
			"Futures additionally support reduceOnly, positionSide and closePosition.",
		parameters: orderSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return executeOrder("buy", params, ctx);
		},
	};
}

export function createSellTool(): ToolDefinition<typeof orderSchema> {
	return {
		name: "sell",
		label: "sell",
		description:
			"Place a sell order (spot or Binance USDⓈ-M futures). Use get_positions first to check holdings. " +
			"Protect positions with stop_market (stop-loss, triggers when price falls to stopPrice), " +
			"take_profit_market (triggers when price rises to stopPrice) or trailing_stop_market " +
			"(trailingPercent pullback from the peak); all work in paper and live mode.",
		parameters: orderSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return executeOrder("sell", params, ctx);
		},
	};
}

export function createCancelOrderTool(): ToolDefinition<typeof cancelOrderSchema> {
	return {
		name: "cancel_order",
		label: "cancel_order",
		description:
			"Cancel an open order by id. Use get_open_orders to list order ids. " +
			"Cancelling one leg of an OCO bracket cancels the whole bracket.",
		parameters: cancelOrderSchema,
		async execute(_id, params) {
			await getTrading().exchange.cancelOrder(params.id, params.symbol);
			return jsonResult({ status: "ok", cancelled: params.id, symbol: params.symbol });
		},
	};
}

export function createPlaceOcoTool(): ToolDefinition<typeof ocoSchema> {
	return {
		name: "place_oco",
		label: "place_oco",
		description:
			"Place a one-cancels-the-other bracket: a stop-loss AND a take-profit exit for the same amount. " +
			"When one leg fills the other is cancelled automatically, so one holding is protected in both " +
			"directions without double-reserving funds. Preferred way to protect a position after an entry fills. " +
			"Paper mode simulates the bracket; live support depends on the exchange (okx native).",
		parameters: ocoSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return executeOco(params, ctx);
		},
	};
}

async function executeOco(params: OcoToolParams, ctx: ExtensionContext): Promise<AgentToolResult<unknown>> {
	const trading = getTrading();
	const { config } = trading;
	if (!Number.isFinite(params.amount) || params.amount <= 0) throw new Error("amount must be positive");
	if (params.stopLossPrice === params.takeProfitPrice)
		throw new Error("stopLossPrice and takeProfitPrice must differ");

	const ticker = await trading.exchange.getTicker(params.symbol);
	const refPrice = ticker.last;
	if (!refPrice || refPrice <= 0) throw new Error(`No reference price for ${params.symbol}`);
	const notional = params.amount * refPrice;
	const riskError = trading.checkRisk(params.symbol, notional);
	if (riskError) throw new Error(`Risk limit: ${riskError}`);

	const summary =
		`OCO ${params.side.toUpperCase()} ${params.amount} ${params.symbol}` +
		` SL ${params.stopLossPrice} / TP ${params.takeProfitPrice}` +
		` ≈ ${notional.toFixed(2)} ${config.quoteCurrency}`;

	if (trading.mode === "live" && config.confirmLiveOrders) {
		if (!ctx.hasUI) {
			throw new Error(
				"Live orders require interactive confirmation but no UI is available. " +
					"Set confirmLiveOrders=false in ~/.ti-trader/agent/trading.json to allow headless live trading.",
			);
		}
		const usage = trading.dailyUsage();
		const confirmed = await ctx.ui.confirm(
			`Confirm LIVE OCO order on ${config.exchange}`,
			`${summary}\n\nDaily notional after fill: ${(usage.used + notional).toFixed(2)} / ${usage.limit} ${config.quoteCurrency}`,
		);
		if (!confirmed) {
			ctx.ui.notify("Order cancelled by user", "info");
			return jsonResult({ status: "cancelled", reason: "user rejected confirmation", order: summary });
		}
	}

	const result = await trading.exchange.placeOcoOrder({
		symbol: params.symbol,
		side: params.side,
		amount: params.amount,
		stopLossPrice: params.stopLossPrice,
		takeProfitPrice: params.takeProfitPrice,
	});
	trading.recordFill(notional);

	return jsonResult({
		status: "ok",
		mode: trading.mode,
		summary,
		orders: result.orders.map(formatOrder),
	});
}

export function createGetFundingRateTool(): ToolDefinition<typeof futuresSymbolSchema> {
	return {
		name: "get_funding_rate",
		label: "get_funding_rate",
		description: "Get current futures funding rate.",
		parameters: futuresSymbolSchema,
		async execute(_id, params) {
			return jsonResult(await getTrading().exchange.getFundingRate(params.symbol));
		},
	};
}
export function createSetLeverageTool(): ToolDefinition<typeof leverageSchema> {
	return {
		name: "set_leverage",
		label: "set_leverage",
		description: "Set futures leverage.",
		parameters: leverageSchema,
		async execute(_id, params) {
			await getTrading().exchange.setLeverage(params.symbol, params.leverage);
			return jsonResult({ status: "ok" });
		},
	};
}
export function createSetMarginModeTool(): ToolDefinition<typeof marginSchema> {
	return {
		name: "set_margin_mode",
		label: "set_margin_mode",
		description: "Set futures margin mode.",
		parameters: marginSchema,
		async execute(_id, params) {
			await getTrading().exchange.setMarginMode(params.symbol, params.marginType);
			return jsonResult({ status: "ok" });
		},
	};
}
export function createGetFuturesPositionsTool(): ToolDefinition<typeof emptySchema> {
	return {
		name: "get_futures_positions",
		label: "get_futures_positions",
		description: "Get futures positions.",
		parameters: emptySchema,
		async execute() {
			const trading = getTrading();
			return jsonResult({ positions: await trading.exchange.getPositions(), marketType: trading.config.marketType });
		},
	};
}

export function createGetRiskStatusTool(): ToolDefinition<typeof emptySchema> {
	return {
		name: "get_risk_status",
		label: "get_risk_status",
		description:
			"Get current risk limits and used notional quota. In paper mode the quota is cumulative and only the user can reset it (/risk reset); in live mode it resets daily.",
		parameters: emptySchema,
		async execute() {
			const trading = getTrading();
			const usage = trading.dailyUsage();
			return jsonResult({
				mode: trading.mode,
				limits: {
					maxOrderNotional: trading.config.risk.maxOrderNotional,
					maxDailyNotional: trading.config.risk.maxDailyNotional,
					allowedSymbols: trading.config.risk.allowedSymbols,
				},
				quoteCurrency: trading.config.quoteCurrency,
				usage,
			});
		},
	};
}

function formatOrder(o: {
	id: string;
	symbol: string;
	side: string;
	type: string;
	price?: number;
	stopPrice?: number;
	trailingPercent?: number;
	ocoGroup?: string;
	amount: number;
	filled: number;
	remaining: number;
	average?: number;
	cost: number;
	status: string;
	timestamp: number;
}) {
	return {
		id: o.id,
		symbol: o.symbol,
		side: o.side,
		type: o.type,
		price: o.price,
		stopPrice: o.stopPrice,
		trailingPercent: o.trailingPercent,
		ocoGroup: o.ocoGroup,
		amount: round(o.amount),
		filled: round(o.filled),
		remaining: round(o.remaining),
		average: o.average,
		cost: round(o.cost, 2),
		status: o.status,
		time: new Date(o.timestamp).toISOString(),
	};
}

export function createTradingTools(): ToolDefinition[] {
	return [
		createGetPriceTool(),
		createGetOrderBookTool(),
		createGetMarketInfoTool(),
		createGetContractStatsTool(),
		createGetKlinesTool(),
		createGetBalanceTool(),
		createGetPositionsTool(),
		createGetOpenOrdersTool(),
		createGetOrderHistoryTool(),
		createBuyTool(),
		createSellTool(),
		createPlaceOcoTool(),
		createCancelOrderTool(),
		createGetRiskStatusTool(),
		createGetFundingRateTool(),
		createSetLeverageTool(),
		createSetMarginModeTool(),
		createGetFuturesPositionsTool(),
	];
}
