import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const tuiSourceIndex = fileURLToPath(new URL("../tui/src/index.ts", import.meta.url));

export default defineConfig({
	resolve: {
		alias: [{ find: /^@earendil-works\/pi-tui$/, replacement: tuiSourceIndex }],
	},
});
