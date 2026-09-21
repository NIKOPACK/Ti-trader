#!/usr/bin/env node
import { errorMessage } from "@nikopack/ti-trading-engine";
import { APP_NAME } from "./config.ts";
import { main } from "./main.ts";

process.title = APP_NAME;
process.emitWarning = (() => {}) as typeof process.emitWarning;

main(process.argv.slice(2)).catch((error) => {
	console.error(errorMessage(error));
	process.exit(1);
});
