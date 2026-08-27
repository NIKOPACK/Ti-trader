// Paper-trading smoke test against live public market data (default: okx).
import { initTrading } from "../dist/context.js";

const trading = await initTrading({ mode: "paper", exchange: "okx" });
const ex = trading.exchange;
console.log(`mode=${ex.mode} exchange=${ex.id} quote=${ex.quoteCurrency}`);

// 1. Market data
const ticker = await ex.getTicker("BTC/USDT");
console.log(`BTC/USDT last=${ticker.last} 24h=${ticker.changePct24h?.toFixed(2)}%`);

const klines = await ex.getKlines("ETH/USDT", "1h", 5);
console.log(`ETH/USDT 1h klines: ${klines.length} candles, last close=${klines.at(-1)?.close}`);

// 2. Initial balance (fresh paper account: 10000 USDT)
const before = await ex.getBalances();
console.log("balances before:", JSON.stringify(before.map((b) => `${b.asset}=${b.total}`)));

// 3. Market buy ~100 USDT of BTC
const amount = 100 / ticker.last;
const buyResult = await ex.placeOrder({ symbol: "BTC/USDT", side: "buy", type: "market", amount });
console.log(`BUY filled: ${buyResult.order.filled} BTC @ ${buyResult.order.average}, fee=${buyResult.fee?.toFixed(4)}`);

// 4. Positions should show BTC with avg entry
const positions = await ex.getPositions();
console.log("positions:", JSON.stringify(positions, null, 1));

// 5. Limit sell above market (rests), then cancel
const limitSell = await ex.placeOrder({
	symbol: "BTC/USDT",
	side: "sell",
	type: "limit",
	amount: buyResult.order.filled,
	price: Math.round(ticker.last * 1.5),
});
console.log(`limit sell placed: #${limitSell.order.id} status=${limitSell.order.status}`);
const open = await ex.getOpenOrders("BTC/USDT");
console.log(`open orders: ${open.length}`);
await ex.cancelOrder(limitSell.order.id, "BTC/USDT");
console.log(`after cancel, open: ${(await ex.getOpenOrders()).length}`);

// 5b. Conditional orders: stop-loss, trailing stop, OCO bracket
const held = buyResult.order.filled;
const slice = held / 4;
const stop = await ex.placeOrder({
	symbol: "BTC/USDT",
	side: "sell",
	type: "stop_market",
	amount: slice,
	stopPrice: Math.round(ticker.last * 0.5),
});
console.log(`stop_market placed: #${stop.order.id} trigger=${stop.order.stopPrice}`);
const trail = await ex.placeOrder({
	symbol: "BTC/USDT",
	side: "sell",
	type: "trailing_stop_market",
	amount: slice,
	trailingPercent: 30,
});
console.log(`trailing placed: #${trail.order.id} trail=${trail.order.trailingPercent}%`);
const oco = await ex.placeOcoOrder({
	symbol: "BTC/USDT",
	side: "sell",
	amount: slice,
	stopLossPrice: Math.round(ticker.last * 0.5),
	takeProfitPrice: Math.round(ticker.last * 2),
});
console.log(`OCO placed: ${oco.orders.map((o) => `#${o.id} ${o.type}`).join(" + ")} group=${oco.orders[0].ocoGroup}`);
const openCond = await ex.getOpenOrders("BTC/USDT");
if (openCond.length !== 4) throw new Error(`expected 4 open conditional orders, got ${openCond.length}`);
console.log(`open conditional orders: ${openCond.length}`);
// Cancelling one OCO leg must cancel the sibling too.
await ex.cancelOrder(oco.orders[0].id, "BTC/USDT");
await ex.cancelOrder(stop.order.id, "BTC/USDT");
await ex.cancelOrder(trail.order.id, "BTC/USDT");
const afterCancel = await ex.getOpenOrders();
if (afterCancel.length !== 0) throw new Error(`expected 0 open orders after cancels, got ${afterCancel.length}`);
console.log("conditional orders cancelled, reservations released");

// 6. Market sell everything back
const sellResult = await ex.placeOrder({
	symbol: "BTC/USDT",
	side: "sell",
	type: "market",
	amount: buyResult.order.filled,
});
console.log(`SELL filled @ ${sellResult.order.average}, fee=${sellResult.fee?.toFixed(4)}`);

// 7. Final balance
const after = await ex.getBalances();
console.log("balances after:", JSON.stringify(after.map((b) => `${b.asset}=${b.total.toFixed(2)} (≈${b.quoteValue?.toFixed(2)})`)));

// 8. Top markets
const top = await ex.getTopMarkets(3);
console.log("top3:", top.map((t) => `${t.symbol}@${t.last}`).join(", "));

// 9. Paper account reset with a custom starting balance
ex.resetAccount(25_000);
const reset = await ex.getBalances();
const resetQuote = reset.find((b) => b.asset === ex.quoteCurrency);
if (resetQuote?.free !== 25_000) throw new Error(`expected 25000 after reset, got ${resetQuote?.free}`);
if ((await ex.getOrderHistory()).length !== 0) throw new Error("expected empty history after reset");
console.log(`reset OK: balance=${resetQuote.free} ${ex.quoteCurrency}, history empty`);
ex.resetAccount(10_000);

await trading.close();
console.log("SMOKE OK");
