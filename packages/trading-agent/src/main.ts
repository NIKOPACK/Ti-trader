import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	InteractiveMode,
	initTheme,
	runPrintMode,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { parseTradingArgs, printHelp } from "./args.ts";
import { createTradingExtension } from "./commands.ts";
import { AGENT_DIR, ensureAgentDir } from "./config.ts";
import { getTrading, initTrading } from "./context.ts";
import { createOrderMonitorExtension } from "./monitor.ts";
import { buildTradingPrompt } from "./prompt.ts";
import { createTradingTools } from "./tools/index.ts";

const VERSION = "0.1.3";

/** Mirror pi's session-dir encoding, rooted at our own agent dir. */
function getTradingSessionDir(cwd: string, agentDir: string): string {
	const resolvedCwd = resolve(cwd);
	const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	const sessionDir = join(agentDir, "sessions", safePath);
	if (!existsSync(sessionDir)) {
		mkdirSync(sessionDir, { recursive: true });
	}
	return sessionDir;
}

export async function main(argv: string[]): Promise<void> {
	const parsed = parseTradingArgs(argv);
	if (parsed.help) {
		printHelp();
		return;
	}
	if (parsed.version) {
		console.log(`ti ${VERSION}`);
		return;
	}

	ensureAgentDir();
	const cwd = process.cwd();
	const agentDir = AGENT_DIR;

	// Trading runtime: config + exchange client (paper by default, live needs keys).
	const trading = await initTrading({ mode: parsed.mode, exchange: parsed.exchange });

	const settingsManager = SettingsManager.create(cwd, agentDir);
	const sessionManager = SessionManager.create(cwd, getTradingSessionDir(cwd, agentDir));

	const createRuntime: CreateAgentSessionRuntimeFactory = async ({
		cwd: runtimeCwd,
		agentDir: runtimeAgentDir,
		sessionManager: runtimeSessionManager,
		sessionStartEvent,
	}) => {
		const services = await createAgentSessionServices({
			cwd: runtimeCwd,
			agentDir: runtimeAgentDir,
			settingsManager,
			resourceLoaderOptions: {
				noContextFiles: true,
				noSkills: true,
				noExtensions: parsed.noExtensions,
				systemPrompt: buildTradingPrompt(trading.config),
				extensionFactories: [createTradingExtension(), createOrderMonitorExtension()],
			},
		});
		const created = await createAgentSessionFromServices({
			services,
			sessionManager: runtimeSessionManager,
			sessionStartEvent,
			// Coding tools (read/bash/edit/write/grep/find/ls) are disabled;
			// the agent only gets the native trading tools.
			noTools: "builtin",
			customTools: createTradingTools(),
		});
		return { ...created, services, diagnostics: services.diagnostics };
	};

	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd,
		agentDir,
		sessionManager,
	});

	initTheme(runtime.session.settingsManager.getTheme(), !parsed.print);

	if (parsed.print) {
		if (!runtime.session.model) {
			console.error("No model available. Run ti interactively and use /login to configure a model provider first.");
			await trading.close();
			process.exit(1);
		}
		const exitCode = await runPrintMode(runtime, {
			mode: "text",
			initialMessage: parsed.message,
		});
		await trading.close();
		if (exitCode !== 0) process.exitCode = exitCode;
		return;
	}

	const interactiveMode = new InteractiveMode(runtime, {
		initialMessage: parsed.message,
		verbose: parsed.verbose,
	});
	await interactiveMode.run();
	await getTrading().close();
}
