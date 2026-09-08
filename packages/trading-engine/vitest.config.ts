import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const riskSourceIndex = fileURLToPath(new URL("../trading-risk/src/index.ts", import.meta.url));

export default defineConfig({
	server: {
		deps: { inline: [/^@nikopack\/ti-trading-risk$/] },
	},
	resolve: {
		alias: [{ find: /^@nikopack\/ti-trading-risk$/, replacement: riskSourceIndex }],
	},
});
