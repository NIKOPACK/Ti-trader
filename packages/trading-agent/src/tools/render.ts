import { keyText, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import { type MenuKey, t, translate } from "../i18n.ts";
import type { TradingLanguage } from "../state.ts";

type Fields = Record<string, unknown>;
type Tone = "muted" | "text" | "success" | "warning" | "error";
type Line = { text: string; tone: Tone };
type Renderers = Pick<ToolDefinition<TSchema, unknown, unknown>, "renderShell" | "renderCall" | "renderResult">;

const TITLES: Readonly<Record<string, MenuKey>> = {
	get_price: "toolPrice",
	get_order_book: "toolOrderBook",
	get_market_info: "toolMarketInfo",
	get_contract_stats: "toolContractStats",
	get_klines: "toolCandles",
	get_top_markets: "titleMarkets",
	get_trading_capabilities: "toolCapabilities",
	get_balance: "titleBalance",
	get_positions: "titlePositions",
	get_portfolio_snapshot: "toolPortfolio",
	get_open_orders: "titleOrders",
	get_order_history: "titleTrades",
	get_order_status: "toolOrderLookup",
	get_order_list_status: "toolOrderList",
	check_order: "toolPreflight",
	buy: "orderReviewBuy",
	sell: "orderReviewSell",
	place_oco: "toolOco",
	cancel_order: "toolCancel",
	cancel_order_list: "toolCancelList",
	get_risk_status: "titleRisk",
	get_funding_rate_history: "toolFunding",
	set_leverage: "toolSetLeverage",
	set_margin_mode: "toolSetMargin",
	set_multi_assets_mode: "toolSetMultiAssets",
};

function fields(value: unknown): Fields | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Fields) : undefined;
}

function records(value: unknown): Fields[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const result: Fields[] = [];
	for (const item of value) {
		const record = fields(item);
		if (!record) return undefined;
		result.push(record);
	}
	return result;
}

function valueText(value: unknown, language: TradingLanguage): string {
	if (typeof value === "string" && value.length > 0) return value;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	if (typeof value === "boolean") return t(language, value ? "yes" : "no");
	return t(language, "orderReviewUnavailable");
}

function orderState(order: Fields): { key: MenuKey; tone: Tone } {
	switch (order.status) {
		case "open":
			return typeof order.filled === "number" && Number.isFinite(order.filled) && order.filled > 0
				? { key: "toolOrderPartial", tone: "warning" }
				: { key: "toolOrderOpen", tone: "text" };
		case "closed":
			return typeof order.filled === "number" &&
				Number.isFinite(order.filled) &&
				order.filled > 0 &&
				order.remaining === 0
				? { key: "toolOrderFilled", tone: "success" }
				: { key: "toolOrderClosed", tone: "text" };
		case "canceled":
		case "cancelled":
			return { key: "toolOrderCancelled", tone: "muted" };
		case "rejected":
			return { key: "toolOrderRejected", tone: "error" };
		case "expired":
			return { key: "toolOrderExpired", tone: "warning" };
		default:
			return { key: "toolOrderUnknown", tone: "warning" };
	}
}

function summarize(tool: string, data: Fields, language: TradingLanguage): Line[] {
	const lines: Line[] = [];
	const add = (text: string, tone: Tone = "text") => lines.push({ text, tone });
	const field = (key: MenuKey, value: unknown, unit?: unknown) => {
		const suffix = typeof unit === "string" && unit.length > 0 ? ` ${unit}` : "";
		add(`${t(language, key)}: ${valueText(value, language)}${suffix}`);
	};
	const scope = [data.mode, data.exchange, data.marketType, data.symbol, data.time ?? data.asOf].filter(
		(value): value is string => typeof value === "string" && value.length > 0,
	);
	if (scope.length) add(scope.join(" · "), data.mode === "live" ? "warning" : "muted");

	if (tool === "check_order") {
		const status: { key: MenuKey; tone: Tone } =
			data.status === "ok"
				? { key: "toolPreflightPassed", tone: "success" }
				: data.status === "ok_with_warnings"
					? { key: "toolPreflightWarnings", tone: "warning" }
					: data.status === "rejected"
						? { key: "toolPreflightRejected", tone: "error" }
						: { key: "toolPreflightUnknown", tone: "warning" };
		add(t(language, status.key), status.tone);
		const resolution = fields(data.resolution);
		if (resolution) {
			field("colAmount", resolution.amount, typeof data.symbol === "string" ? data.symbol.split("/")[0] : undefined);
			field("orderReviewNotional", resolution.estimatedNotional, resolution.quoteCurrency);
			field("orderReviewReference", resolution.referencePrice, resolution.quoteCurrency);
			field("orderReviewReferenceTime", resolution.referenceTime);
		}
		add(t(language, "toolPreflightNotice"), "muted");
	} else if (data.status === "cancelled") {
		add(t(language, "toolCancelled"), "muted");
	} else if (
		tool === "buy" ||
		tool === "sell" ||
		tool === "place_oco" ||
		tool === "get_order_status" ||
		tool === "get_order_list_status"
	) {
		const order = fields(data.order);
		const orderList = fields(data.orderList);
		const orders = order ? [order] : (records(orderList?.orders ?? data.orders) ?? []);
		if (orders.length === 0) {
			add(
				t(
					language,
					tool === "buy" || tool === "sell" || tool === "place_oco" ? "toolSubmissionUnknown" : "toolOrderUnknown",
				),
				"warning",
			);
		}
		for (const item of orders) {
			const state = orderState(item);
			add(`${valueText(item.symbol, language)} · ${t(language, state.key)}`, state.tone);
			if (state.key === "toolOrderUnknown" && (tool === "buy" || tool === "sell" || tool === "place_oco")) {
				add(t(language, "toolSubmissionUnknown"), "warning");
			}
			const base = typeof item.symbol === "string" ? item.symbol.split("/")[0] : undefined;
			field("colOrderId", item.id);
			field(
				"colSide",
				item.side === "buy"
					? t(language, "orderReviewBuy")
					: item.side === "sell"
						? t(language, "orderReviewSell")
						: item.side,
			);
			field("colType", item.type);
			if (item.positionSide !== undefined) field("orderReviewPositionSide", item.positionSide);
			field("colFilled", item.filled, base);
			field("colRemaining", item.remaining, base);
			if (item.closePosition === true) {
				add(t(language, "orderReviewClosePosition"), "warning");
				field("colAmount", item.requestedAmount, base);
			} else {
				field("colAmount", item.amount, base);
			}
			for (const [name, label] of [
				["price", "colPrice"],
				["average", "toolAveragePrice"],
				["stopPrice", "colTrigger"],
				["trailingPercent", "colTrailing"],
			] as const) {
				if (item[name] !== undefined) field(label, item[name], name === "trailingPercent" ? "%" : undefined);
			}
			if (item.reduceOnly !== undefined) field("orderReviewReduceOnly", item.reduceOnly);
		}
		if (data.executionId !== undefined) field("toolExecutionId", data.executionId);
		if (data.fee !== undefined) field("toolFee", data.fee);
	} else {
		if (!tool.startsWith("get_")) add(t(language, "toolRequestComplete"), "muted");
		switch (tool) {
			case "get_price":
				add(
					`${t(language, "colPrice")}: ${valueText(data.last, language)} · ${t(language, "toolBid")}: ${valueText(data.bid, language)} · ${t(language, "toolAsk")}: ${valueText(data.ask, language)}`,
				);
				break;
			case "get_order_book":
				field("toolSpread", data.spread);
				add(
					`${t(language, "toolBidLevels")}: ${valueText(records(data.bids)?.length, language)} · ${t(language, "toolAskLevels")}: ${valueText(records(data.asks)?.length, language)}`,
				);
				break;
			case "get_market_info":
				if (data.active === false) {
					add(t(language, "toolMarketInactive"), "error");
				} else {
					field("colStatus", data.status ?? (data.active === true ? t(language, "toolMarketActive") : undefined));
				}
				field("toolMinimumAmount", data.minAmount, data.amountUnit);
				field("toolMinimumNotional", data.minNotional, data.quote);
				break;
			case "get_contract_stats":
				field("toolMarkPrice", data.markPrice);
				field("toolIndexPrice", data.indexPrice);
				break;
			case "get_klines": {
				const candles = records(data.candles);
				add(
					`${valueText(data.timeframe, language)} · ${translate(language, "toolRecordCount", { count: valueText(candles?.length, language) })}`,
				);
				const last = candles?.at(-1);
				if (last) {
					field("colTime", last.time);
					add(
						t(
							language,
							last.closed === true
								? "toolCandleClosed"
								: last.closed === false
									? "toolCandleForming"
									: "toolCandleUnknown",
						),
						last.closed === true ? "muted" : "warning",
					);
				}
				break;
			}
			case "get_balance":
				field("totalValuation", data.totalQuoteValue, data.quoteCurrency);
				add(
					translate(language, "toolRecordCount", { count: valueText(records(data.balances)?.length, language) }),
					"muted",
				);
				break;
			case "get_portfolio_snapshot": {
				const account = fields(data.account);
				field("totalValuation", account?.estimatedEquity, data.quoteCurrency);
				field("toolExposure", account?.grossExposure, data.quoteCurrency);
				field("colPnl", account?.unrealizedPnl, data.quoteCurrency);
				break;
			}
			case "get_positions":
			case "get_open_orders":
			case "get_order_history":
			case "get_top_markets":
			case "get_funding_rate_history": {
				const items = records(data.positions ?? data.orders ?? data.markets ?? data.records);
				add(translate(language, "toolRecordCount", { count: valueText(items?.length, language) }), "muted");
				let hidden = 0;
				items?.forEach((item, index) => {
					const state = tool === "get_open_orders" || tool === "get_order_history" ? orderState(item) : undefined;
					if (index >= 3 && state?.tone !== "error" && state?.tone !== "warning") {
						hidden++;
						return;
					}
					const parts = [valueText(item.symbol ?? data.symbol, language)];
					if (state) parts.push(t(language, state.key));
					if (item.closePosition === true) parts.push(t(language, "orderReviewClosePosition"));
					if (
						item.positionSide !== undefined ||
						(tool === "get_positions" && typeof item.symbol === "string" && item.symbol.includes(":"))
					) {
						parts.push(`${t(language, "orderReviewPositionSide")}: ${valueText(item.positionSide, language)}`);
					}
					for (const [name, label] of [
						["amount", "colAmount"],
						["filled", "colFilled"],
						["last", "colPrice"],
						["unrealizedPnl", "colPnl"],
						["rate", "toolFunding"],
					] as const) {
						if (item[name] !== undefined) {
							const value = name === "amount" && item.closePosition === true ? item.requestedAmount : item[name];
							parts.push(`${t(language, label)}: ${valueText(value, language)}`);
						}
					}
					if (item.id !== undefined) parts.push(`${t(language, "colOrderId")}: ${valueText(item.id, language)}`);
					add(parts.join(" · "), state?.tone ?? "text");
				});
				if (hidden > 0) add(translate(language, "toolMoreRecords", { count: hidden }), "muted");
				break;
			}
			case "get_trading_capabilities":
				add(
					t(
						language,
						data.overallStatus === "ready"
							? "toolCapabilitiesReady"
							: data.overallStatus === "unsupported"
								? "toolCapabilitiesUnsupported"
								: "toolCapabilitiesUnknown",
					),
					data.overallStatus === "ready" ? "muted" : data.overallStatus === "unsupported" ? "error" : "warning",
				);
				break;
			case "get_risk_status": {
				const usage = fields(data.usage);
				field("riskUsed", usage?.used, data.quoteCurrency);
				field("riskMaxNotional", usage?.limit, data.quoteCurrency);
				add(
					translate(language, "riskReservedLine", {
						value: valueText(usage?.reserved, language),
						quote: valueText(data.quoteCurrency, language),
					}),
				);
				break;
			}
			case "cancel_order":
			case "cancel_order_list":
				field("colOrderId", data.cancelled ?? data.cancelledOrderListId);
				add(t(language, "toolCancellationNotice"), "warning");
				break;
			case "set_leverage":
				field("leverage", data.leverage);
				break;
			case "set_margin_mode":
			case "set_multi_assets_mode":
				field("marginType", data.marginType);
				break;
		}
	}

	const warnings = new Set<string>();
	for (const source of [data, fields(data.preflight)]) {
		if (!source) continue;
		for (const key of ["reason", "error", "blockingReasons", "unknownReasons", "nonBlockingWarnings", "warnings"]) {
			const value = source[key];
			if (typeof value === "string" && value.length > 0) warnings.add(value);
			if (Array.isArray(value))
				for (const item of value) if (typeof item === "string" && item.length > 0) warnings.add(item);
		}
	}
	const constraints = fields(data.executionConstraints);
	if (typeof constraints?.exchangeConstraint === "string") warnings.add(constraints.exchangeConstraint);
	const quality = fields(data.dataQuality);
	if (quality) {
		const unavailable = Object.entries(quality)
			.filter(
				([, value]) =>
					value === false ||
					value === null ||
					value === "partial" ||
					value === "unavailable" ||
					value === "unknown",
			)
			.map(([name]) => name);
		if (unavailable.length)
			warnings.add(translate(language, "toolDataUnavailable", { fields: unavailable.join(", ") }));
	}
	for (const warning of warnings) add(`${t(language, "toolWarnings")}: ${warning}`, "warning");
	return lines;
}

export function createTradingToolRenderers(tool: string, getLanguage: () => TradingLanguage): Renderers {
	return {
		renderShell: "self",
		renderCall(args: unknown, theme, context) {
			const language = getLanguage();
			const params = fields(args);
			const titleKey = TITLES[tool];
			const title = titleKey ? `${t(language, titleKey)} (${tool})` : tool;
			const subject = [params?.symbol, params?.timeframe].filter(
				(value): value is string => typeof value === "string",
			);
			const status = context.isPartial
				? ` · ${t(language, context.executionStarted ? "toolRunning" : "toolPreparing")}`
				: tool.startsWith("get_") && !context.isError
					? ` · ${t(language, "toolReadComplete")}`
					: "";
			const lines = [theme.bold(theme.fg("toolTitle", [title, ...subject].join(" · "))) + theme.fg("muted", status)];
			if (context.expanded && args !== undefined) {
				lines.push(theme.fg("muted", t(language, "toolArguments")), JSON.stringify(args, null, 2));
			}
			return new Text(lines.join("\n"), 1, 0);
		},
		renderResult(result, options, theme, context) {
			const language = getLanguage();
			const output = result.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			if (context.isError) {
				return new Text(theme.fg("error", `${t(language, "toolFailed")}\n${output}`), 1, 0);
			}
			const data = fields(result.details);
			if (!data) {
				return new Text(`${theme.fg("warning", t(language, "toolNoDetails"))}\n${output}`, 1, 0);
			}
			const lines = options.isPartial
				? [theme.fg("muted", t(language, "toolRunning")), output]
				: summarize(tool, data, language).map((line) => theme.fg(line.tone, line.text));
			if (options.expanded && !options.isPartial && output) {
				lines.push(theme.fg("muted", t(language, "toolRawResult")), output);
			} else if (!options.isPartial && output) {
				lines.push(theme.fg("muted", translate(language, "toolDetailsHint", { key: keyText("app.tools.expand") })));
			}
			return new Text(lines.join("\n"), 1, 0);
		},
	};
}
