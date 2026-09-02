import { describe, expect, it, vi } from "vitest";
import {
	createBuyTool,
	createCancelOrderListTool,
	createCancelOrderTool,
	createCheckOrderTool,
	createGetBalanceTool,
	createGetContractStatsTool,
	createGetFundingRateHistoryTool,
	createGetFundingRateTool,
	createGetFuturesPositionsTool,
	createGetKlinesTool,
	createGetMarketInfoTool,
	createGetOpenOrdersTool,
	createGetOrderBookTool,
	createGetOrderHistoryTool,
	createGetOrderListStatusTool,
	createGetOrderStatusTool,
	createGetPortfolioSnapshotTool,
	createGetPositionsTool,
	createGetPriceTool,
	createGetRiskStatusTool,
	createGetTopMarketsTool,
	createGetTradingCapabilitiesTool,
	createPlaceOcoTool,
	createSellTool,
	createSetLeverageTool,
	createSetMarginModeTool,
	createSetMultiAssetsModeTool,
	createTradingTools,
	type TradingProvider,
} from "../index.ts";

describe("package api", () => {
	it("exports every trading tool factory from the package root", () => {
		// Static references keep the export surface compile-checked (a missing root
		// export fails type-checking) and runtime-verified (each value is a function).
		const exportFactories = [
			createBuyTool,
			createCancelOrderListTool,
			createCancelOrderTool,
			createCheckOrderTool,
			createGetBalanceTool,
			createGetContractStatsTool,
			createGetFundingRateHistoryTool,
			createGetFundingRateTool,
			createGetFuturesPositionsTool,
			createGetKlinesTool,
			createGetMarketInfoTool,
			createGetOpenOrdersTool,
			createGetOrderBookTool,
			createGetOrderHistoryTool,
			createGetOrderListStatusTool,
			createGetOrderStatusTool,
			createGetPortfolioSnapshotTool,
			createGetPositionsTool,
			createGetPriceTool,
			createGetRiskStatusTool,
			createGetTopMarketsTool,
			createGetTradingCapabilitiesTool,
			createPlaceOcoTool,
			createSellTool,
			createSetLeverageTool,
			createSetMarginModeTool,
			createSetMultiAssetsModeTool,
			createTradingTools,
		] as const;

		expect(exportFactories).toHaveLength(28);

		for (const factory of exportFactories) {
			expect(typeof factory).toBe("function");
		}
	});

	it("keeps the default registry at 25 names without touching the singleton", () => {
		const provider: TradingProvider = vi.fn(() => {
			throw new Error("provider should not be called while building the registry");
		});

		const names = createTradingTools(provider).map((tool) => tool.name);

		expect(names).toHaveLength(25);
		expect(new Set(names)).toHaveLength(25);
	});
});
