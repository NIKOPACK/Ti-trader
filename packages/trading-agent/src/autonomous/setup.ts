import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type AccountRiskLimits, validateAccountRiskLimits } from "@nikopack/ti-trading-engine";
import { getTrading, type ReadonlyTradingConfig } from "../context.ts";
import { t } from "../i18n.ts";
import type { TradingConfig } from "../state.ts";
import { formatTradingVenue } from "../venue.ts";
import { type AutonomousConfig, tryLoadAutonomousConfig, writeAutonomousConfig } from "./config.ts";
import { hasAutonomousManifest } from "./daemon.ts";
import { AutonomousSetupPanel } from "./setup-panel.ts";

export type AutonomousSetupState = "configured" | "manifest" | "uninitialized";

/**
 * "configured": autonomous.json loads. "manifest": the file is gone or invalid but a
 * daemon ran before (status can still render). "uninitialized": neither exists.
 */
export function autonomousSetupState(): AutonomousSetupState {
	if (tryLoadAutonomousConfig()) return "configured";
	return hasAutonomousManifest() ? "manifest" : "uninitialized";
}

export const AUTONOMOUS_TIMING_DEFAULTS = {
	pollIntervalMs: 5_000,
	modelTimeoutMs: 180_000,
	serviceTimeoutMs: 15_000,
	maxAttempts: 3,
	retryBaseMs: 2_000,
	retryMaxMs: 60_000,
	protectionAttempts: 3,
} as const;

export const AUTONOMOUS_DEFAULT_SERVICES: AutonomousConfig["services"] = ["market-lab"];

export const DEFAULT_AUTONOMOUS_OBJECTIVE =
	"Research and manage this Paper account within my hard limits. Decide when to act again; waiting is acceptable.";

export interface AutonomousModelChoice {
	provider: string;
	model: string;
	label: string;
}

export interface AutonomousSetupAnswers {
	model: AutonomousModelChoice;
	objective: string;
	accountLimits: AccountRiskLimits;
	/** Explicit operator confirmation that autonomous orders submit unattended. */
	unattendedConfirmed: boolean;
}

/** Paper preset scaled from paper.startQuote; the docs example is the 10000-USDT instance. */
export function suggestedAccountRiskLimits(config: ReadonlyTradingConfig): AccountRiskLimits {
	const scaled = (fraction: number): number =>
		Math.max(0.01, Math.round(config.paper.startQuote * fraction * 100) / 100);
	return {
		maxGrossExposure: scaled(0.1),
		maxNetExposure: scaled(0.08),
		maxAssetExposure: scaled(0.04),
		maxLeverage: Math.max(1, config.leverage),
		maxMarginUsagePct: 50,
		maxDailyLoss: scaled(0.01),
		maxDrawdown: scaled(0.02),
		maxDataAgeMs: 30_000,
		maxPriceDeviationPct: 2,
		minDepthRatio: 2,
		minLiquidationDistancePct: 10,
		minProtectionCoveragePct: 95,
		maxStopDistancePct: 10,
		cancelEntriesOnBreach: true,
		reduceOnBreach: true,
	};
}

function toChoice(provider: string, model: string): AutonomousModelChoice {
	return { provider, model, label: `${provider}/${model}` };
}

/**
 * Models the autonomous worker can actually resolve: providers with configured auth
 * in this agent directory (the worker shares it) plus whitelisted API-key env vars.
 * The current session model leads the list so it is the default selection.
 */
export function autonomousModelCandidates(
	ctx: ExtensionCommandContext,
	existing: AutonomousConfig | undefined,
): AutonomousModelChoice[] {
	const registry = ctx.modelRegistry;
	const seen = new Set<string>();
	const choices: AutonomousModelChoice[] = [];
	const push = (provider: string | undefined, model: string | undefined): void => {
		if (!provider || !model) return;
		const key = `${provider}/${model}`;
		if (seen.has(key)) return;
		const resolved = registry.find(provider, model);
		if (!resolved || !registry.hasConfiguredAuth(resolved)) return;
		seen.add(key);
		choices.push(toChoice(provider, model));
	};
	push(ctx.model?.provider, ctx.model?.id);
	const scoped = ctx.scopedModels.map((entry) => entry.model);
	for (const model of scoped.length ? scoped : registry.getAvailable()) push(model.provider, model.id);
	push(existing?.provider, existing?.model);
	if (choices.length === 0) for (const model of registry.getAll()) push(model.provider, model.id);
	return choices;
}

export function buildAutonomousConfig(
	trading: TradingConfig | ReadonlyTradingConfig,
	answers: AutonomousSetupAnswers,
	existing: AutonomousConfig | undefined,
): AutonomousConfig {
	return {
		enabled: true,
		mode: trading.mode,
		exchange: trading.exchange,
		marketType: trading.marketType,
		quoteCurrency: trading.quoteCurrency,
		objective: answers.objective.trim(),
		provider: answers.model.provider,
		model: answers.model.model,
		pollIntervalMs: existing?.pollIntervalMs ?? AUTONOMOUS_TIMING_DEFAULTS.pollIntervalMs,
		modelTimeoutMs: existing?.modelTimeoutMs ?? AUTONOMOUS_TIMING_DEFAULTS.modelTimeoutMs,
		serviceTimeoutMs: existing?.serviceTimeoutMs ?? AUTONOMOUS_TIMING_DEFAULTS.serviceTimeoutMs,
		maxAttempts: existing?.maxAttempts ?? AUTONOMOUS_TIMING_DEFAULTS.maxAttempts,
		retryBaseMs: existing?.retryBaseMs ?? AUTONOMOUS_TIMING_DEFAULTS.retryBaseMs,
		retryMaxMs: existing?.retryMaxMs ?? AUTONOMOUS_TIMING_DEFAULTS.retryMaxMs,
		protectionAttempts: existing?.protectionAttempts ?? AUTONOMOUS_TIMING_DEFAULTS.protectionAttempts,
		services: existing?.services ?? AUTONOMOUS_DEFAULT_SERVICES,
	};
}

export function autonomousRuntimeDefaultsLine(existing: AutonomousConfig | undefined): string {
	const seconds = (ms: number): string => `${Math.round(ms / 1000)}s`;
	const timing = { ...AUTONOMOUS_TIMING_DEFAULTS, ...existing };
	return [
		`poll ${seconds(timing.pollIntervalMs)}`,
		`model ${seconds(timing.modelTimeoutMs)}`,
		`service ${seconds(timing.serviceTimeoutMs)}`,
		`attempts ${timing.maxAttempts}`,
		`services ${(existing?.services ?? AUTONOMOUS_DEFAULT_SERVICES).join(",")}`,
	].join(" · ");
}

/**
 * Guided first-run setup behind bare `/autonomous` and `/autonomous start`. Collects
 * the only operator-owned choices (model, objective, hard limits, unattended approval),
 * derives scope and timings from the active account, then persists both files and lets
 * the caller proceed to start. Returns false when setup did not complete.
 */
export async function runAutonomousSetup(ctx: ExtensionCommandContext): Promise<boolean> {
	const trading = getTrading();
	const language = trading.config.language;
	if (trading.config.mode === "live") {
		ctx.ui.notify(t(language, "autonomousSetupLive"), "error");
		return false;
	}
	const existing = tryLoadAutonomousConfig();
	const models = autonomousModelCandidates(ctx, existing);
	if (models.length === 0) {
		ctx.ui.notify(t(language, "autonomousSetupNoModels"), "error");
		return false;
	}
	const venue = formatTradingVenue({
		language,
		mode: trading.config.mode,
		exchangeId: trading.config.exchange,
		marketType: trading.config.marketType,
		quoteCurrency: trading.config.quoteCurrency,
	});
	const answers = await ctx.ui.custom<AutonomousSetupAnswers | undefined>(
		(_tui, theme, _keybindings, done) =>
			new AutonomousSetupPanel(theme, ctx, done, {
				language,
				models,
				modelIndex: Math.max(
					0,
					models.findIndex((model) => model.provider === existing?.provider && model.model === existing?.model),
				),
				objective: existing?.objective ?? DEFAULT_AUTONOMOUS_OBJECTIVE,
				accountLimits: trading.config.risk.account ?? suggestedAccountRiskLimits(trading.config),
				unattended: false,
				accountLine: venue.identity,
				runtimeLine: autonomousRuntimeDefaultsLine(existing),
			}),
	);
	if (!answers) {
		ctx.ui.notify(t(language, "cancelled"), "info");
		return false;
	}
	if (!answers.unattendedConfirmed) throw new Error("Unattended approval was not confirmed");
	validateAccountRiskLimits(answers.accountLimits);
	const config = buildAutonomousConfig(trading.config, answers, existing);
	await trading.patchConfig({
		orderApproval: "unattended",
		risk: { account: answers.accountLimits },
		confirmUnattendedTrading: true,
	});
	writeAutonomousConfig(config);
	ctx.ui.notify(t(language, "autonomousSetupSaved"), "info");
	return true;
}
