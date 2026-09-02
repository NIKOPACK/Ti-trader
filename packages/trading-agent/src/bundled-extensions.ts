import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the bundled market-lab extension directory.
 * Published builds copy it next to this file; source runs use the repo extension.
 */
export function resolveBundledMarketLabExtension(): string {
	const distDir = join(HERE, "market-lab");
	if (existsSync(join(distDir, "index.js"))) return distDir;
	const sourceDir = join(HERE, "..", "..", "..", "extensions", "market-lab");
	if (existsSync(join(sourceDir, "index.ts"))) return sourceDir;
	throw new Error(
		"Bundled market-lab extension is missing. Rebuild ti-trader or pass --extension ./extensions/market-lab",
	);
}
