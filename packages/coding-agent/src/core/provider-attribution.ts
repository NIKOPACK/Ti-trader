import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import type { SettingsManager } from "./settings-manager.ts";
import { isInstallTelemetryEnabled } from "./telemetry.ts";

const OPENROUTER_HOST = "openrouter.ai";
const NVIDIA_NIM_HOST = "integrate.api.nvidia.com";
const CLOUDFLARE_API_HOST = "api.cloudflare.com";
const CLOUDFLARE_AI_GATEWAY_HOST = "gateway.ai.cloudflare.com";
const OPENCODE_HOST = "opencode.ai";

export interface ProviderAttribution {
	userAgent?: string;
	openRouter?: {
		referer?: string;
		title?: string;
		categories?: string;
	};
	nvidiaBillingOrigin?: string;
	cloudflareUserAgent?: string;
	openCodeClient?: string;
	openaiCodexOriginator?: string;
	xaiOAuthReferrer?: string;
}

function matchesHost(baseUrl: string, expectedHost: string): boolean {
	try {
		return new URL(baseUrl).hostname === expectedHost;
	} catch {
		return false;
	}
}

function isOpenRouterModel(model: Model<Api>): boolean {
	return model.provider === "openrouter" || model.baseUrl.includes(OPENROUTER_HOST);
}

function isNvidiaNimModel(model: Model<Api>): boolean {
	return model.provider === "nvidia" || matchesHost(model.baseUrl, NVIDIA_NIM_HOST);
}

function isCloudflareModel(model: Model<Api>): boolean {
	return (
		model.provider === "cloudflare-workers-ai" ||
		model.provider === "cloudflare-ai-gateway" ||
		matchesHost(model.baseUrl, CLOUDFLARE_API_HOST) ||
		matchesHost(model.baseUrl, CLOUDFLARE_AI_GATEWAY_HOST)
	);
}

function isOpenCodeModel(model: Model<Api>): boolean {
	return (
		model.provider === "opencode" || model.provider === "opencode-go" || matchesHost(model.baseUrl, OPENCODE_HOST)
	);
}

function isOpenAICodexModel(model: Model<Api>): boolean {
	return model.api === "openai-codex-responses" || model.provider === "openai-codex";
}

function getDefaultAttributionHeaders(
	model: Model<Api>,
	settingsManager: SettingsManager,
): Record<string, string> | undefined {
	if (!isInstallTelemetryEnabled(settingsManager)) {
		return undefined;
	}

	if (isOpenRouterModel(model)) {
		return {
			"HTTP-Referer": "https://pi.dev",
			"X-OpenRouter-Title": "pi",
			"X-OpenRouter-Categories": "cli-agent",
		};
	}

	if (isNvidiaNimModel(model)) {
		return {
			"X-BILLING-INVOKE-ORIGIN": "Pi",
		};
	}

	if (isCloudflareModel(model)) {
		return {
			"User-Agent": "pi-coding-agent",
		};
	}

	return undefined;
}

function getConfiguredAttributionHeaders(
	model: Model<Api>,
	attribution: ProviderAttribution,
): Record<string, string> | undefined {
	const headers: Record<string, string> = {};
	if (attribution.userAgent !== undefined) {
		headers["User-Agent"] = attribution.userAgent;
	}

	if (isOpenRouterModel(model)) {
		if (attribution.openRouter?.referer !== undefined) {
			headers["HTTP-Referer"] = attribution.openRouter.referer;
		}
		if (attribution.openRouter?.title !== undefined) {
			headers["X-OpenRouter-Title"] = attribution.openRouter.title;
		}
		if (attribution.openRouter?.categories !== undefined) {
			headers["X-OpenRouter-Categories"] = attribution.openRouter.categories;
		}
	}

	if (isNvidiaNimModel(model) && attribution.nvidiaBillingOrigin !== undefined) {
		headers["X-BILLING-INVOKE-ORIGIN"] = attribution.nvidiaBillingOrigin;
	}

	if (isCloudflareModel(model)) {
		const userAgent = attribution.cloudflareUserAgent ?? attribution.userAgent;
		if (userAgent !== undefined) {
			headers["User-Agent"] = userAgent;
		}
	}

	if (isOpenAICodexModel(model) && attribution.openaiCodexOriginator !== undefined) {
		headers.originator = attribution.openaiCodexOriginator;
	}

	return Object.keys(headers).length > 0 ? headers : undefined;
}

function getSessionHeaders(
	model: Model<Api>,
	sessionId: string | undefined,
	openCodeClient: string | undefined,
): Record<string, string> | undefined {
	if (!sessionId) return undefined;
	if (!isOpenCodeModel(model)) return undefined;
	return {
		"x-opencode-session": sessionId,
		...(openCodeClient !== undefined ? { "x-opencode-client": openCodeClient } : {}),
	};
}

function mergeHeaderSource(target: ProviderHeaders, source: ProviderHeaders | undefined): void {
	for (const [name, value] of Object.entries(source ?? {})) {
		const lowerName = name.toLowerCase();
		for (const existingName of Object.keys(target)) {
			if (existingName.toLowerCase() === lowerName) {
				delete target[existingName];
			}
		}
		target[name] = value;
	}
}

export function mergeProviderAttributionHeaders(
	model: Model<Api>,
	settingsManager: SettingsManager,
	sessionId: string | undefined,
	attribution: ProviderAttribution | undefined,
	...headerSources: Array<ProviderHeaders | undefined>
): ProviderHeaders | undefined {
	const merged: ProviderHeaders = {};
	mergeHeaderSource(
		merged,
		getSessionHeaders(model, sessionId, attribution === undefined ? "pi" : attribution.openCodeClient),
	);
	mergeHeaderSource(
		merged,
		attribution === undefined
			? getDefaultAttributionHeaders(model, settingsManager)
			: getConfiguredAttributionHeaders(model, attribution),
	);

	for (const headers of headerSources) {
		mergeHeaderSource(merged, headers);
	}

	return Object.keys(merged).length > 0 ? merged : undefined;
}
