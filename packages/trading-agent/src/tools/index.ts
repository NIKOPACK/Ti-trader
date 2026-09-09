import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getTrading } from "../context.ts";
import { createGetBalanceTool, createGetPortfolioSnapshotTool, createGetPositionsTool } from "./account.ts";
import {
	createGetFundingRateHistoryTool,
	createGetRiskStatusTool,
	createSetLeverageTool,
	createSetMarginModeTool,
	createSetMultiAssetsModeTool,
} from "./manage.ts";
import {
	createGetContractStatsTool,
	createGetKlinesTool,
	createGetMarketInfoTool,
	createGetOrderBookTool,
	createGetPriceTool,
	createGetTopMarketsTool,
	createGetTradingCapabilitiesTool,
} from "./market.ts";
import {
	createBuyTool,
	createCancelOrderListTool,
	createCancelOrderTool,
	createCheckOrderTool,
	createGetOpenOrdersTool,
	createGetOrderHistoryTool,
	createGetOrderListStatusTool,
	createGetOrderStatusTool,
	createPlaceOcoTool,
	createSellTool,
} from "./orders.ts";
import type { TradingProvider } from "./shared.ts";

export {
	createGetBalanceTool,
	createGetPortfolioSnapshotTool,
	createGetPositionsTool,
} from "./account.ts";
export {
	createGetFundingRateHistoryTool,
	createGetFundingRateTool,
	createGetFuturesPositionsTool,
	createGetRiskStatusTool,
	createSetLeverageTool,
	createSetMarginModeTool,
	createSetMultiAssetsModeTool,
} from "./manage.ts";
export {
	createGetContractStatsTool,
	createGetKlinesTool,
	createGetMarketInfoTool,
	createGetOrderBookTool,
	createGetPriceTool,
	createGetTopMarketsTool,
	createGetTradingCapabilitiesTool,
} from "./market.ts";
export {
	createBuyTool,
	createCancelOrderListTool,
	createCancelOrderTool,
	createCheckOrderTool,
	createGetOpenOrdersTool,
	createGetOrderHistoryTool,
	createGetOrderListStatusTool,
	createGetOrderStatusTool,
	createPlaceOcoTool,
	createSellTool,
} from "./orders.ts";
export type { TradingProvider } from "./shared.ts";

/** Native trading tools registered on every Ti session. Order matches `createTradingTools`. */
export const NATIVE_TRADING_TOOL_NAMES = [
	"get_price",
	"get_order_book",
	"get_market_info",
	"get_contract_stats",
	"get_klines",
	"get_top_markets",
	"get_trading_capabilities",
	"get_balance",
	"get_positions",
	"get_portfolio_snapshot",
	"get_open_orders",
	"get_order_history",
	"get_order_status",
	"get_order_list_status",
	"check_order",
	"buy",
	"sell",
	"place_oco",
	"cancel_order",
	"cancel_order_list",
	"get_risk_status",
	"get_funding_rate_history",
	"set_leverage",
	"set_margin_mode",
	"set_multi_assets_mode",
] as const;

export function createTradingTools(provider: TradingProvider = getTrading): ToolDefinition[] {
	return [
		createGetPriceTool(provider),
		createGetOrderBookTool(provider),
		createGetMarketInfoTool(provider),
		createGetContractStatsTool(provider),
		createGetKlinesTool(provider),
		createGetTopMarketsTool(provider),
		createGetTradingCapabilitiesTool(provider),
		createGetBalanceTool(provider),
		createGetPositionsTool(provider),
		createGetPortfolioSnapshotTool(provider),
		createGetOpenOrdersTool(provider),
		createGetOrderHistoryTool(provider),
		createGetOrderStatusTool(provider),
		createGetOrderListStatusTool(provider),
		createCheckOrderTool(provider),
		createBuyTool(provider),
		createSellTool(provider),
		createPlaceOcoTool(provider),
		createCancelOrderTool(provider),
		createCancelOrderListTool(provider),
		createGetRiskStatusTool(provider),
		createGetFundingRateHistoryTool(provider),
		createSetLeverageTool(provider),
		createSetMarginModeTool(provider),
		createSetMultiAssetsModeTool(provider),
	];
}
