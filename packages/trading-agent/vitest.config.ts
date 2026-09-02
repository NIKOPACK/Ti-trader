import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const tuiSourceIndex = fileURLToPath(new URL("../tui/src/index.ts", import.meta.url));
const engineSourceIndex = fileURLToPath(new URL("../trading-engine/src/index.ts", import.meta.url));
const riskSourceIndex = fileURLToPath(new URL("../trading-risk/src/index.ts", import.meta.url));

// Vitest resolves externalized bare Node built-ins relative to the workspace
// package. Keep the test boundary equivalent to Node's runtime resolver.
const nodeBuiltinAliases = [
	"child_process",
	"fs",
	"fs/promises",
	"os",
	"path",
	"stream",
	"stream/promises",
].map((name) => ({ find: name, replacement: `node:${name}` }));

export default defineConfig({
	resolve: {
		alias: [
			{ find: /^@earendil-works\/pi-tui$/, replacement: tuiSourceIndex },
			{ find: /^@earendil-works\/ti-trading-engine$/, replacement: engineSourceIndex },
			{ find: /^@earendil-works\/ti-trading-risk$/, replacement: riskSourceIndex },
			...nodeBuiltinAliases,
		],
	},
});
