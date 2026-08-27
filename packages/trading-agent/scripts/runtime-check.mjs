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

const agentDir = join(homedir(), ".ti-trader", "agent");
const cwd = process.cwd();
const safe = `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
const sessionDir = join(agentDir, "sessions", safe);
mkdirSync(sessionDir, { recursive: true });

const trading = await initTrading({ mode: "paper", exchange: "okx" });

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
	"get_price",
	"get_order_book",
	"get_market_info",
	"get_contract_stats",
	"get_klines",
	"get_balance",
	"get_positions",
	"get_open_orders",
	"get_order_history",
	"buy",
	"sell",
	"place_oco",
	"cancel_order",
];
const missing = tradingTools.filter((t) => !toolNames.includes(t));
if (codingTools.length > 0) throw new Error(`coding tools leaked: ${codingTools}`);
if (missing.length > 0) throw new Error(`missing trading tools: ${missing}`);

// 2. System prompt is the trading prompt
const sp = session.agent.state.systemPrompt ?? "";
console.log("system prompt starts:", JSON.stringify(sp.slice(0, 80)));
if (!sp.includes("You are Ti")) throw new Error("trading system prompt not applied");
if (sp.includes("coding")) throw new Error("coding prompt leaked");

// 3. Extension commands registered
const exts = runtime.services.resourceLoader.getExtensions();
const commands = exts.extensions.flatMap((e) => [...(e.commands?.keys?.() ?? [])]);
console.log("registered commands:", commands.join(", "));
for (const c of ["balance", "positions", "orders", "markets", "mode", "exchange", "risk", "language", "monitor", "paper"]) {
	if (!commands.includes(c)) throw new Error(`command /${c} not registered`);
}

// 4. Risk layer
if (trading.checkRisk("BTC/USDT", 1e9) === null) throw new Error("risk check failed to block oversized order");
if (trading.checkRisk("BTC/USDT", 100) !== null) throw new Error("risk check blocked valid order");
if (!trading.checkRisk("DOGE/USDT", 1e9)?.includes("maxOrderNotional")) throw new Error("unexpected risk error");

// 5. Mode/exchange state
console.log(`mode=${trading.mode} exchange=${trading.config.exchange}`);
if (trading.mode !== "paper") throw new Error("default mode must be paper");

await trading.close();
console.log("RUNTIME CHECK OK");
