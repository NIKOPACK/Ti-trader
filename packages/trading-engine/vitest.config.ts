import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const riskSourceIndex = fileURLToPath(new URL("../trading-risk/src/index.ts", import.meta.url));

export default defineConfig({
	server: {
		deps: { inline: [/^@earendil-works\/ti-trading-risk$/] },
	},
	resolve: {
		alias: [{ find: /^@earendil-works\/ti-trading-risk$/, replacement: riskSourceIndex }],
	},
});
