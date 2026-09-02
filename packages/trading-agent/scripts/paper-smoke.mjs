// Paper-trading smoke test against live public market data (default: okx).
import { initTrading } from "../dist/context.js";

const trading = await initTrading({ mode: "paper", exchange: "okx" });
const marketData = trading.marketData;
const engine = trading.tradingEngine;
await trading.resetPaperAccount();
console.log(`mode=${engine.mode} exchange=${engine.id} quote=${engine.quoteCurrency}`);

try {
	// 1. Market data
	const ticker = await marketData.getTicker("BTC/USDT");
	if (ticker.last === undefined) throw new Error("BTC/USDT ticker has no last price");
	console.log(`BTC/USDT last=${ticker.last} 24h=${ticker.changePct24h?.toFixed(2)}%`);

	const klines = await marketData.getKlines("ETH/USDT", "1h", 5);
	console.log(`ETH/USDT 1h klines: ${klines.length} candles, last close=${klines.at(-1)?.close}`);

	// 2. Initial balance (fresh paper account: 10000 USDT)
	const before = await marketData.getBalances();
	console.log("balances before:", JSON.stringify(before.map((b) => `${b.asset}=${b.total}`)));

	// 3. Market buy ~100 USDT of BTC
	const amount = 100 / ticker.last;
	const buyPlan = await engine.prepareOrder("buy", { symbol: "BTC/USDT", type: "market", amount });
	const buyResult = await engine.placeOrder(buyPlan);
	console.log(`BUY filled: ${buyResult.order.filled} BTC @ ${buyResult.order.average}, fee=${buyResult.fee?.toFixed(4)}`);

	// 4. Positions should show BTC with avg entry
	const positions = await marketData.getPositions();
	console.log("positions:", JSON.stringify(positions, null, 1));

	// 5. Limit sell above market (rests), then cancel
	const limitSellPlan = await engine.prepareOrder("sell", {
		symbol: "BTC/USDT",
		type: "limit",
		amount: buyResult.order.filled,
		price: Math.round(ticker.last * 1.5),
	});
	const limitSell = await engine.placeOrder(limitSellPlan);
	console.log(`limit sell placed: #${limitSell.order.id} status=${limitSell.order.status}`);
	const open = await engine.getOpenOrders("BTC/USDT");
	console.log(`open orders: ${open.length}`);
	await engine.cancelOrder(limitSell.order.id, "BTC/USDT");
	console.log(`after cancel, open: ${(await engine.getOpenOrders()).length}`);

	// 5b. Conditional orders: stop-loss, trailing stop, OCO bracket
	const held = buyResult.order.filled;
	const slice = held / 4;
	const stopPlan = await engine.prepareOrder("sell", {
		symbol: "BTC/USDT",
		type: "stop_market",
		amount: slice,
		stopPrice: Math.round(ticker.last * 0.5),
	});
	const stop = await engine.placeOrder(stopPlan);
	console.log(`stop_market placed: #${stop.order.id} trigger=${stop.order.stopPrice}`);
	const trailPlan = await engine.prepareOrder("sell", {
		symbol: "BTC/USDT",
		type: "trailing_stop_market",
		amount: slice,
		trailingPercent: 30,
	});
	const trail = await engine.placeOrder(trailPlan);
	console.log(`trailing placed: #${trail.order.id} trail=${trail.order.trailingPercent}%`);
	const ocoPlan = await engine.prepareOcoOrder({
		symbol: "BTC/USDT",
		side: "sell",
		amount: slice,
		stopLossPrice: Math.round(ticker.last * 0.5),
		takeProfitPrice: Math.round(ticker.last * 2),
	});
	const oco = await engine.placeOco(ocoPlan);
	console.log(`OCO placed: ${oco.orders.map((o) => `#${o.id} ${o.type}`).join(" + ")} group=${oco.orders[0].ocoGroup}`);
	const openCond = await engine.getOpenOrders("BTC/USDT");
	if (openCond.length !== 4) throw new Error(`expected 4 open conditional orders, got ${openCond.length}`);
	console.log(`open conditional orders: ${openCond.length}`);
	// Cancelling one OCO leg must cancel the sibling too.
	await engine.cancelOrder(oco.orders[0].id, "BTC/USDT");
	await engine.cancelOrder(stop.order.id, "BTC/USDT");
	await engine.cancelOrder(trail.order.id, "BTC/USDT");
	const afterCancel = await engine.getOpenOrders();
	if (afterCancel.length !== 0) throw new Error(`expected 0 open orders after cancels, got ${afterCancel.length}`);
	console.log("conditional orders cancelled, reservations released");

	// 6. Market sell everything back
	const sellPlan = await engine.prepareOrder("sell", {
		symbol: "BTC/USDT",
		type: "market",
		amount: buyResult.order.filled,
	});
	const sellResult = await engine.placeOrder(sellPlan);
	console.log(`SELL filled @ ${sellResult.order.average}, fee=${sellResult.fee?.toFixed(4)}`);

	// 7. Final balance
	const after = await marketData.getBalances();
	console.log("balances after:", JSON.stringify(after.map((b) => `${b.asset}=${b.total.toFixed(2)} (≈${b.quoteValue?.toFixed(2)})`)));

	// 8. Top markets
	const top = await marketData.getTopMarkets(3);
	console.log("top3:", top.map((t) => `${t.symbol}@${t.last}`).join(", "));

	// 9. Paper account reset with a custom starting balance
	await trading.resetPaperAccount(25_000);
	const reset = await marketData.getBalances();
	const resetQuote = reset.find((b) => b.asset === engine.quoteCurrency);
	if (resetQuote?.free !== 25_000) throw new Error(`expected 25000 after reset, got ${resetQuote?.free}`);
	if ((await engine.getOrderHistory()).length !== 0) throw new Error("expected empty history after reset");
	console.log(`reset OK: balance=${resetQuote.free} ${engine.quoteCurrency}, history empty`);
	console.log("SMOKE OK");
} finally {
	await trading.resetPaperAccount(10_000);
	await trading.close();
}
