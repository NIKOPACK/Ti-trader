import { type Static, Type } from "typebox";

export const SYMBOL_DESC = `Market symbol in ccxt format, e.g. "BTC/USDT". The quote currency must match the configured quote currency.`;

export const getPriceSchema = Type.Object({
	symbol: Type.String({ description: SYMBOL_DESC }),
});
export const marketInfoSchema = Type.Object({ symbol: Type.String({ description: SYMBOL_DESC }) });
export const depthSchema = Type.Object({
	symbol: Type.String({ description: SYMBOL_DESC }),
	limit: Type.Optional(
		Type.Integer({ minimum: 5, maximum: 100, description: "Number of price levels per side. Default 20." }),
	),
});

export const getKlinesSchema = Type.Object({
	symbol: Type.String({ description: SYMBOL_DESC }),
	timeframe: Type.Optional(
		Type.String({ description: "Candle timeframe, e.g. 1m, 5m, 15m, 1h, 4h, 1d. Default 1h." }),
	),
	limit: Type.Optional(Type.Number({ description: "Number of candles, max 200. Default 100." })),
});

export const topMarketsSchema = Type.Object({
	limit: Type.Optional(
		Type.Integer({ minimum: 1, maximum: 50, description: "Number of candidates to return. Default 15, max 50." }),
	),
});

export const emptySchema = Type.Object({});
export const futuresSymbolSchema = Type.Object({
	symbol: Type.String({ description: 'Binance USDⓈ-M ccxt symbol, e.g. "BTC/USDT:USDT".' }),
});
export const fundingHistorySchema = Type.Object({
	symbol: Type.String({ description: 'Binance USDⓈ-M ccxt symbol, e.g. "BTC/USDT:USDT".' }),
	limit: Type.Optional(
		Type.Integer({ minimum: 1, maximum: 100, description: "Number of historical funding records. Default 20." }),
	),
});
export const leverageSchema = Type.Object({
	symbol: Type.String(),
	leverage: Type.Integer({ minimum: 1, maximum: 125 }),
});
export const marginSchema = Type.Object({
	symbol: Type.String(),
	marginType: Type.Union([Type.Literal("isolated"), Type.Literal("cross")]),
});
export const multiAssetsModeSchema = Type.Object({
	enabled: Type.Boolean({ description: "Enable Binance Multi-Assets mode. Disable it to use isolated margin." }),
});

export const symbolFilterSchema = Type.Object({
	symbol: Type.Optional(Type.String({ description: SYMBOL_DESC })),
});

export const orderHistorySchema = Type.Object({
	symbol: Type.Optional(Type.String({ description: SYMBOL_DESC })),
	limit: Type.Optional(Type.Number({ description: "Max orders to return. Default 20, max 100." })),
});

const orderFields = {
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
				"trailing_stop_market trails the best price by trailingPercent and fires on the pullback. Paper spot and Paper futures simulate these conditional orders; Paper futures does not support OCO. " +
				"Live conditional and trailing support depends on the ccxt adapter and exchange capability. On Binance Spot this uses native trailingDelta (BIPS); it is not limited to USDⓈ-M futures.",
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
				"from the best price since placement. Binance Spot converts this to native trailingDelta BIPS.",
		}),
	),
	closePosition: Type.Optional(Type.Boolean()),
};

export const orderSchema = Type.Object(orderFields);

export const checkOrderSchema = Type.Object({
	side: Type.Union([Type.Literal("buy"), Type.Literal("sell")], {
		description: "Order direction to preview; no order is submitted.",
	}),
	...orderFields,
});

export const cancelOrderSchema = Type.Object({
	id: Type.String({ minLength: 1, description: "Order id (see get_open_orders)" }),
	symbol: Type.String({ minLength: 1, description: SYMBOL_DESC }),
});
export const getOrderStatusSchema = Type.Object({
	symbol: Type.String({ minLength: 1, description: SYMBOL_DESC }),
	id: Type.Optional(Type.String({ minLength: 1, description: "Order id" })),
	origClientOrderId: Type.Optional(Type.String({ minLength: 1, description: "Client order id" })),
});
export const getOrderListStatusSchema = Type.Object({
	orderListId: Type.Optional(Type.String({ minLength: 1, description: "Native OCO/order-list id" })),
	listClientOrderId: Type.Optional(Type.String({ minLength: 1, description: "Client order-list id" })),
});
export const cancelOrderListSchema = Type.Object({
	orderListId: Type.String({ minLength: 1, description: "Native OCO/order-list id" }),
	symbol: Type.String({ minLength: 1, description: SYMBOL_DESC }),
});

export const ocoSchema = Type.Object({
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

export type OcoToolParams = Static<typeof ocoSchema>;

export type OrderToolParams = Static<typeof orderSchema>;

export const capabilitySchema = Type.Object({
	symbol: Type.Optional(Type.String({ description: `${SYMBOL_DESC} If omitted, report account-level capabilities.` })),
});
