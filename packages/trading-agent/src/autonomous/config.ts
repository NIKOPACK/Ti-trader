import { join } from "node:path";
import { AGENT_DIR, readJsonFile, writeJsonFile } from "../config.ts";

export interface AutonomousConfig {
	enabled: true;
	mode: "paper" | "live";
	exchange: string;
	marketType: "spot" | "usdm-futures" | "both";
	quoteCurrency: string;
	objective: string;
	provider: string;
	model: string;
	pollIntervalMs: number;
	modelTimeoutMs: number;
	serviceTimeoutMs: number;
	maxAttempts: number;
	retryBaseMs: number;
	retryMaxMs: number;
	protectionAttempts: number;
	services: Array<"market-lab" | "web-search" | "zhihu-research" | "freqtrade" | "market-research" | "subagent">;
}

export function validateAutonomousConfig(value: unknown): asserts value is AutonomousConfig {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("autonomous.json must explicitly configure autonomous mode");
	const config = value as Record<string, unknown>;
	if (config.enabled !== true) throw new Error("Autonomous mode requires enabled: true");
	if (
		!["paper", "live"].includes(String(config.mode)) ||
		!["spot", "usdm-futures", "both"].includes(String(config.marketType))
	)
		throw new Error("Autonomous mode/marketType must be explicit");
	for (const key of ["exchange", "quoteCurrency", "objective", "provider", "model"]) {
		if (typeof config[key] !== "string" || !config[key].trim()) throw new Error(`autonomous.${key} is required`);
	}
	for (const key of [
		"pollIntervalMs",
		"modelTimeoutMs",
		"serviceTimeoutMs",
		"maxAttempts",
		"retryBaseMs",
		"retryMaxMs",
		"protectionAttempts",
	]) {
		if (!Number.isSafeInteger(config[key]) || Number(config[key]) <= 0)
			throw new Error(`autonomous.${key} must be a positive integer`);
		if (key.endsWith("Ms") && Number(config[key]) > 2_147_483_647)
			throw new Error(`autonomous.${key} exceeds the Node timer range`);
	}
	if (Number(config.serviceTimeoutMs) * Number(config.maxAttempts) > 2_147_483_647)
		throw new Error("Autonomous startup timeout exceeds the Node timer range");
	if (Number(config.retryMaxMs) < Number(config.retryBaseMs))
		throw new Error("retryMaxMs must be at least retryBaseMs");
	if (
		!Array.isArray(config.services) ||
		config.services.some(
			(service) =>
				!["market-lab", "web-search", "zhihu-research", "freqtrade", "market-research", "subagent"].includes(
					String(service),
				),
		)
	)
		throw new Error("Only reviewed bundled research services may be loaded");
}

export const AUTONOMOUS_CONFIG_PATH = join(AGENT_DIR, "autonomous.json");

export function loadAutonomousConfig(): AutonomousConfig {
	const config = readJsonFile<unknown>(AUTONOMOUS_CONFIG_PATH);
	validateAutonomousConfig(config);
	return config;
}

/** Returns undefined for both a missing and an unreadable/invalid file. */
export function tryLoadAutonomousConfig(): AutonomousConfig | undefined {
	try {
		return loadAutonomousConfig();
	} catch {
		return undefined;
	}
}

export function writeAutonomousConfig(config: AutonomousConfig): void {
	validateAutonomousConfig(config);
	writeJsonFile(AUTONOMOUS_CONFIG_PATH, config);
}
