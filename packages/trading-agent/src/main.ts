import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	hasTrustRequiringProjectResources,
	InteractiveMode,
	initTheme,
	ProjectTrustStore,
	runPrintMode,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { parseTradingArgs, printHelp } from "./args.ts";
import {
	optionalBundledResearchToolNames,
	resolveBundledMarketChartExtension,
	resolveBundledMarketLabExtension,
	resolveOptionalBundledExtensionPaths,
} from "./bundled-extensions.ts";
import { createTradingExtension } from "./commands.ts";
import { AGENT_DIR, APP_NAME, CONFIG_DIR_NAME, ensureAgentDir } from "./config.ts";
import { getTrading, initTrading } from "./context.ts";
import { createOperationalHealthExtension } from "./health.ts";
import { localizeDescription } from "./i18n.ts";
import { installMarketLabSessionBridge } from "./market-lab-bridge.ts";
import { createOrderMonitorExtension } from "./monitor.ts";
import { createProjectTrustContext, resolveProjectTrusted } from "./project-trust.ts";
import {
	buildTradingPrompt,
	collectTradingPromptTools,
	DEFAULT_TRADING_PROMPT_TOOLS,
	extraToolGuidelines,
} from "./prompt.ts";
import { createTradingTools } from "./tools/index.ts";
import { createTriggerMonitorExtension } from "./trigger-monitor.ts";

function readPackageVersion(): string {
	const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
	const pkg: unknown = JSON.parse(readFileSync(pkgPath, "utf8"));
	if (
		typeof pkg !== "object" ||
		pkg === null ||
		!("version" in pkg) ||
		typeof pkg.version !== "string" ||
		pkg.version.length === 0
	) {
		throw new Error(`Invalid version in ${pkgPath}`);
	}
	return pkg.version;
}

const VERSION = readPackageVersion();
const CHANGELOG_PATH = fileURLToPath(new URL("../CHANGELOG.md", import.meta.url));

const TI_ATTRIBUTION = {
	userAgent: `ti/${VERSION}`,
	openRouter: {
		referer: "https://github.com/NIKOPACK/Ti",
		title: "Ti",
		categories: "cli-agent",
	},
	nvidiaBillingOrigin: "Ti",
	cloudflareUserAgent: "ti-trader",
	openCodeClient: "ti",
	openaiCodexOriginator: "ti",
	xaiOAuthReferrer: "ti",
};

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
	// Start from an untrusted project state. Project-local settings and extensions
	// are loaded only after the trust resolver has made an explicit decision.
	const startupSettingsManager = SettingsManager.create(cwd, agentDir, {
		projectTrusted: false,
		projectConfigDirName: CONFIG_DIR_NAME,
	});
	const trustStore = new ProjectTrustStore(agentDir);
	const projectTrustByCwd = new Map<string, boolean>();

	// Trading runtime: config + exchange client (paper by default, live needs keys).
	const trading = await initTrading({ mode: parsed.mode, exchange: parsed.exchange });
	installMarketLabSessionBridge();

	const sessionManager = SessionManager.create(cwd, getTradingSessionDir(cwd, agentDir));

	const createRuntime: CreateAgentSessionRuntimeFactory = async ({
		cwd: runtimeCwd,
		agentDir: runtimeAgentDir,
		sessionManager: runtimeSessionManager,
		sessionStartEvent,
		projectTrustContext,
	}) => {
		const isInitialRuntime = sessionStartEvent === undefined;
		const cachedProjectTrust = projectTrustByCwd.get(runtimeCwd);
		const hasTrustRequiringResources = hasTrustRequiringProjectResources(runtimeCwd, {
			projectConfigDirName: CONFIG_DIR_NAME,
		});
		const shouldResolveProjectTrust = cachedProjectTrust === undefined && hasTrustRequiringResources;
		const projectTrusted = shouldResolveProjectTrust
			? false
			: (cachedProjectTrust ?? (!hasTrustRequiringResources || trustStore.get(runtimeCwd) === true));
		const runtimeSettingsManager = SettingsManager.create(runtimeCwd, runtimeAgentDir, {
			projectTrusted,
			projectConfigDirName: CONFIG_DIR_NAME,
		});
		const services = await createAgentSessionServices({
			cwd: runtimeCwd,
			agentDir: runtimeAgentDir,
			settingsManager: runtimeSettingsManager,
			modelRuntimeOptions: {
				enableModelNetwork: false,
			},
			providerAttribution: TI_ATTRIBUTION,
			resourceLoaderReloadOptions: shouldResolveProjectTrust
				? {
						resolveProjectTrust: async () => {
							const trusted = await resolveProjectTrusted({
								cwd: runtimeCwd,
								trustStore,
								projectConfigDirName: CONFIG_DIR_NAME,
								defaultProjectTrust: startupSettingsManager.getDefaultProjectTrust(),
								projectTrustContext:
									projectTrustContext ??
									createProjectTrustContext({
										cwd: runtimeCwd,
										mode: isInitialRuntime ? (parsed.print ? "print" : "interactive") : "interactive",
										hasUI: isInitialRuntime && !parsed.print,
									}),
							});
							projectTrustByCwd.set(runtimeCwd, trusted);
							return trusted;
						},
					}
				: undefined,
			resourceLoaderOptions: {
				manifestFlavor: "ti",
				noContextFiles: true,
				noSkills: true,
				noPromptTemplates: true,
				noExtensions: parsed.noExtensions,
				// Bundled by path so trading-agent's build rootDir stays src/.
				additionalExtensionPaths: [
					...parsed.extensions,
					resolveBundledMarketLabExtension(),
					resolveBundledMarketChartExtension(),
					...resolveOptionalBundledExtensionPaths(),
				],
				systemPrompt: buildTradingPrompt(trading.config, {
					tools: collectTradingPromptTools({
						fallbackTools: [...DEFAULT_TRADING_PROMPT_TOOLS, ...optionalBundledResearchToolNames()],
					}),
				}),
				extensionFactories: [
					{
						name: "ti-system",
						hidden: true,
						factory: (pi) => {
							pi.on("before_agent_start", async (event) => {
								const tools = collectTradingPromptTools({
									selectedTools: event.systemPromptOptions.selectedTools,
									activeTools: pi.getActiveTools(),
									fallbackTools: [...DEFAULT_TRADING_PROMPT_TOOLS, ...optionalBundledResearchToolNames()],
								});
								return {
									systemPrompt: buildTradingPrompt(getTrading().config, {
										tools,
										toolGuidelines: extraToolGuidelines(tools, pi.getAllTools()),
									}),
								};
							});
						},
					},
					{ name: "ti-trading", hidden: true, factory: createTradingExtension() },
					{ name: "ti-health", hidden: true, factory: createOperationalHealthExtension() },
					{ name: "ti-order-monitor", hidden: true, factory: createOrderMonitorExtension() },
					{ name: "ti-trigger-monitor", hidden: true, factory: createTriggerMonitorExtension() },
				],
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
			providerAttribution: TI_ATTRIBUTION,
		});
		return { ...created, services, diagnostics: services.diagnostics };
	};

	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd,
		agentDir,
		sessionManager,
	});

	initTheme(runtime.session.settingsManager.getTheme(), !parsed.print, join(agentDir, "themes"));

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
		changelogPath: CHANGELOG_PATH,
		allowUserBash: false,
		ensureManagedTools: false,
		checkForUpdates: false,
		sendInstallTelemetry: false,
		enableSessionShare: false,
		branding: {
			appName: APP_NAME,
			appTitle: APP_NAME,
			version: VERSION,
			startupAssistantText: "",
		},
		descriptionLocalizer: (key, fallback, params) =>
			localizeDescription(getTrading().config.language, key, fallback, params),
	});
	await interactiveMode.run();
	await getTrading().close();
}
