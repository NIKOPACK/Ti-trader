import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ZHIHU_ACCESS_SECRET_PATH = join(homedir(), ".ti-trader", "agent", "zhihu-access-secret");

function resolveBundledExtension(extensionName: string): string {
	const distDir = join(HERE, extensionName);
	if (existsSync(join(distDir, "index.js"))) return distDir;
	const sourceDir = join(HERE, "..", "..", "..", "extensions", extensionName);
	if (existsSync(join(sourceDir, "index.ts"))) return sourceDir;
	throw new Error(
		`Bundled ${extensionName} extension is missing. Rebuild ti-trader or pass --extension ./extensions/${extensionName}`,
	);
}

function envHasNonEmptyValue(name: string): boolean {
	return Boolean(process.env[name]?.trim());
}

function envIsTruthyFlag(name: string): boolean {
	const value = process.env[name]?.trim().toLowerCase();
	return value === "1" || value === "true" || value === "yes";
}

function zhihuAccessSecretPath(): string {
	return process.env.TI_ZHIHU_ACCESS_SECRET_FILE?.trim() || DEFAULT_ZHIHU_ACCESS_SECRET_PATH;
}

function hasZhihuAccessSecret(): boolean {
	if (envHasNonEmptyValue("ZHIHU_ACCESS_SECRET")) return true;
	const path = zhihuAccessSecretPath();
	if (!existsSync(path)) return false;
	try {
		return readFileSync(path, "utf8").trim().length > 0;
	} catch {
		return false;
	}
}

/** Resolve the bundled market-lab extension directory. */
export function resolveBundledMarketLabExtension(): string {
	return resolveBundledExtension("market-lab");
}

/** Resolve the bundled market-chart extension directory. */
export function resolveBundledMarketChartExtension(): string {
	return resolveBundledExtension("market-chart");
}

/** Resolve the bundled web-search extension directory. */
export function resolveBundledWebSearchExtension(): string {
	return resolveBundledExtension("web-search");
}

/** Resolve the bundled zhihu-research extension directory. */
export function resolveBundledZhihuResearchExtension(): string {
	return resolveBundledExtension("zhihu-research");
}

/** Resolve the bundled market-research extension directory. */
export function resolveBundledMarketResearchExtension(): string {
	return resolveBundledExtension("market-research");
}

/**
 * Extra bundled extension directories to auto-load when their opt-in
 * credentials or flags are present. Does not include market-lab or market-chart.
 */
export function resolveOptionalBundledExtensionPaths(): string[] {
	const paths: string[] = [];
	if (envHasNonEmptyValue("TAVILY_API_KEY")) {
		paths.push(resolveBundledWebSearchExtension());
	}
	if (hasZhihuAccessSecret()) {
		paths.push(resolveBundledZhihuResearchExtension());
	}
	if (envIsTruthyFlag("TI_MARKET_RESEARCH")) {
		paths.push(resolveBundledMarketResearchExtension());
	}
	return paths;
}
