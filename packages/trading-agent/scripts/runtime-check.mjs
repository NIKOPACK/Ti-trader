// Headless verification of the full session bootstrap (no TTY, no LLM).
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const { initTrading } = await import("../dist/context.js");
const { createTradingTools } = await import("../dist/tools/index.js");
const { createTradingExtension } = await import("../dist/commands.js");
const { createOrderMonitorExtension } = await import("../dist/monitor.js");
const { buildTradingPrompt } = await import("../dist/prompt.js");
const { resolveBundledMarketLabExtension } = await import("../dist/bundled-extensions.js");

const agentDir = join(homedir(), ".ti-trader", "agent");
const cwd = process.cwd();
const safe = `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
const sessionDir = join(agentDir, "sessions", safe);
mkdirSync(sessionDir, { recursive: true });

const trading = await initTrading({ mode: "paper", exchange: "okx" });
const marketData = trading.marketData;
const engine = trading.tradingEngine;
if (marketData.id !== engine.id || marketData.mode !== engine.mode)
	throw new Error("market-data and trading-engine client identity mismatch");

const settingsManager = SettingsManager.create(cwd, agentDir);
const sessionManager = SessionManager.create(cwd, sessionDir);

const createRuntime = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
	const services = await createAgentSessionServices({
		cwd,
		agentDir,
		settingsManager,
		resourceLoaderOptions: {
			noContextFiles: true,
			noSkills: true,
			noExtensions: true,
			additionalExtensionPaths: [resolveBundledMarketLabExtension()],
			systemPrompt: buildTradingPrompt(trading.config),
			extensionFactories: [createTradingExtension(), createOrderMonitorExtension()],
		},
	});
	const created = await createAgentSessionFromServices({
		services,
		sessionManager,
		sessionStartEvent,
		noTools: "builtin",
		customTools: createTradingTools(),
	});
	return { ...created, services, diagnostics: services.diagnostics };
};

const runtime = await createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager });
const { session } = runtime;

// 1. Tools: exactly the trading tools, no coding tools
const toolList = session.agent.state.tools ?? [];
const toolNames = toolList.map((t) => t.name ?? t);
console.log("active tools:", toolNames.join(", "));
const codingTools = ["read", "bash", "edit", "write", "grep", "find", "ls"].filter((t) => toolNames.includes(t));
const tradingTools = [
	"calculate_indicators",
	"analyze_market_structure",
	"generate_trade_signal",
	"evaluate_strategy",
	"screen_markets",
	"simulate_rule",
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
];
const missing = tradingTools.filter((t) => !toolNames.includes(t));
if (codingTools.length > 0) throw new Error(`coding tools leaked: ${codingTools}`);
if (missing.length > 0) throw new Error(`missing trading tools: ${missing}`);
if (toolNames.length !== tradingTools.length)
	throw new Error(`unexpected trading tool count: expected ${tradingTools.length}, got ${toolNames.length}`);

// 2. System prompt is the trading prompt
const sp = session.agent.state.systemPrompt ?? "";
console.log("system prompt starts:", JSON.stringify(sp.slice(0, 80)));
if (!sp.includes("You are Ti")) throw new Error("trading system prompt not applied");
if (!sp.includes("calculate_indicators")) throw new Error("market-lab tools missing from trading prompt");
if (sp.includes("coding")) throw new Error("coding prompt leaked");

// 3. Extension commands registered
const exts = runtime.services.resourceLoader.getExtensions();
const commands = exts.extensions.flatMap((e) => [...(e.commands?.keys?.() ?? [])]);
console.log("registered commands:", commands.join(", "));
for (const c of [
	"language",
	"balance",
	"positions",
	"orders",
	"trades",
	"markets",
	"mode",
	"exchange",
	"market",
	"risk",
	"paper",
	"monitor",
	"indicators",
	"signal",
	"screen",
	"replay",
	"exchange-login",
]) {
	if (!commands.includes(c)) throw new Error(`command /${c} not registered`);
}

// 4. Risk layer
if (engine.risk.check("BTC/USDT", 1e9) === null) throw new Error("risk check failed to block oversized order");
if (engine.risk.check("BTC/USDT", 100) !== null) throw new Error("risk check blocked valid order");
if (!engine.risk.check("DOGE/USDT", 1e9)?.includes("maxOrderNotional")) throw new Error("unexpected risk error");

// 5. Mode/exchange state
console.log(`mode=${engine.mode} exchange=${engine.id}`);
if (engine.mode !== "paper") throw new Error("default mode must be paper");

await trading.close();
console.log("RUNTIME CHECK OK");
