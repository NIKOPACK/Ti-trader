// Library entry: trading tools, exchange layer and runtime for programmatic use.
export { createTradingExtension } from "./commands.ts";
export { AGENT_DIR, APP_NAME, CONFIG_DIR, KEYS_PATH, PAPER_DIR, TRADING_CONFIG_PATH } from "./config.ts";
export { getTrading, initTrading, TradingRuntime } from "./context.ts";
export { CcxtExchangeClient } from "./exchange/ccxt-client.ts";
export { PaperExchangeClient } from "./exchange/paper-client.ts";
export type {
	Balance,
	ExchangeClient,
	Kline,
	Order,
	PlaceOrderInput,
	PlaceOrderResult,
	Position,
	Ticker,
} from "./exchange/types.ts";
export { main } from "./main.ts";
export { buildTradingPrompt } from "./prompt.ts";
export {
	DEFAULT_CONFIG,
	type ExchangeCredentials,
	type FuturesMarginType,
	type FuturesPositionMode,
	loadExchangeKeys,
	loadTradingConfig,
	type MarketType,
	type RiskLimits,
	saveExchangeKeys,
	saveTradingConfig,
	type TradingConfig,
	type TradingMode,
} from "./state.ts";
export { createTradingTools } from "./tools/index.ts";
