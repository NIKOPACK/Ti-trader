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
