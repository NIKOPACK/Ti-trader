import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

function resolveBundledExtension(extensionName: string): string {
	const distDir = join(HERE, extensionName);
	if (existsSync(join(distDir, "index.js"))) return distDir;
	const sourceDir = join(HERE, "..", "..", "..", "extensions", extensionName);
	if (existsSync(join(sourceDir, "index.ts"))) return sourceDir;
	throw new Error(
		`Bundled ${extensionName} extension is missing. Rebuild ti-trader or pass --extension ./extensions/${extensionName}`,
	);
}

/** Resolve the bundled market-lab extension directory. */
export function resolveBundledMarketLabExtension(): string {
	return resolveBundledExtension("market-lab");
}

/** Resolve the bundled market-chart extension directory. */
export function resolveBundledMarketChartExtension(): string {
	return resolveBundledExtension("market-chart");
}
