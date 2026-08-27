#!/usr/bin/env node
import { APP_NAME } from "./config.ts";
import { main } from "./main.ts";

process.title = APP_NAME;
process.emitWarning = (() => {}) as typeof process.emitWarning;

main(process.argv.slice(2)).catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
