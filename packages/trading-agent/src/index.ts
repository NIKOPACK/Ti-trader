// Library entry: trading tools, exchange layer and runtime for programmatic use.

export type {
	Balance,
	ContractStats,
	ContractType,
	ExchangeClient,
	FundingRateRecord,
	Kline,
	MarketDataClient,
	MarketInfo,
	Order,
	OrderBook,
	OrderBookLevel,
	OrderList,
	OrderSide,
	OrderStatus,
	OrderType,
	PlaceOcoOrderInput,
	PlaceOcoOrderResult,
	PlaceOrderInput,
	PlaceOrderResult,
	PlaceOrderType,
	Position,
	Ticker,
} from "@nikopack/ti-trading-engine";
export { createTradingExtension } from "./commands.ts";
export {
	AGENT_DIR,
	APP_NAME,
	CONFIG_DIR,
	CONFIG_DIR_NAME,
	KEYS_PATH,
	PAPER_DIR,
	TRADING_CONFIG_PATH,
} from "./config.ts";
export {
	AccountSwitchConfirmationRequired,
	type AccountSwitchOptions,
	getTrading,
	initTrading,
	TradingRuntime,
	UnattendedTradingConfirmationRequired,
} from "./context.ts";
export { evaluateActualExecutions } from "./decisions/evaluation.ts";
export type { DecisionClaim, DecisionEvidence, DecisionTurn } from "./decisions/evidence.ts";
export { DecisionStore, evaluateDecisions, validateDecisionEvidence } from "./decisions/evidence.ts";
export { createDecisionEvidenceExtension } from "./decisions/extension.ts";
export { createOperationalHealthExtension, readOperationalHealth } from "./health.ts";
export { main } from "./main.ts";
export {
	assessOperationalHealth,
	type OperationalHealthInput,
	type OperationalObservation,
} from "./operational-health.ts";
export { createPlanExtension } from "./plans/extension.ts";
export type { PlanContent, PlanObservation, TradePlan } from "./plans/model.ts";
export { PlanMonitor, planIndex, reviewPlan } from "./plans/runtime.ts";
export { PlanStore } from "./plans/store.ts";
export { buildTradingPrompt } from "./prompt.ts";
export {
	DEFAULT_CONFIG,
	type ExchangeCredentials,
	type FuturesMarginType,
	type FuturesPositionMode,
	loadExchangeKeyEntry,
	loadExchangeKeys,
	loadTradingConfig,
	type MarketType,
	mutateExchangeKeys,
	type OrderApprovalMode,
	type RiskLimits,
	saveExchangeKeys,
	saveTradingConfig,
	type TradingConfig,
	type TradingMode,
} from "./state.ts";
export {
	marketFamilyForTradingType,
	markTradingSpanAborted,
	setTradingSpanAttributes,
	startTradingSpan,
	TRADING_TELEMETRY_SCHEMA,
	type TradingSpanEndAttributes,
	type TradingSpanName,
	type TradingSpanStartAttributes,
	type TradingTelemetryErrorType,
	type TradingTelemetrySpan,
} from "./telemetry.ts";
export {
	createBuyTool,
	createCancelOrderListTool,
	createCancelOrderTool,
	createCheckOrderTool,
	createGetBalanceTool,
	createGetContractStatsTool,
	createGetFundingRateHistoryTool,
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
} from "./tools/index.ts";
