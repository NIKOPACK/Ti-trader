import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	readJsonFile as readPersistedJson,
	writeJsonFile as writePersistedJson,
} from "@earendil-works/ti-trading-engine";

export const APP_NAME = "ti";
/** Ti owns a separate home from pi so both applications can be installed together. */
export const CONFIG_DIR_NAME = ".ti-trader";
export const CONFIG_DIR = join(homedir(), CONFIG_DIR_NAME);
export const AGENT_DIR = join(CONFIG_DIR, "agent");
export const TRADING_CONFIG_PATH = join(AGENT_DIR, "trading.json");
export const TRADING_STATE_PATH = join(AGENT_DIR, "trading-state.json");
export const KEYS_PATH = join(AGENT_DIR, "keys.json");
export const PAPER_DIR = join(AGENT_DIR, "paper");

export function ensureAgentDir(): void {
	mkdirSync(AGENT_DIR, { recursive: true });
	mkdirSync(PAPER_DIR, { recursive: true });
}

export function readJsonFile<T>(path: string): T | undefined {
	try {
		return readPersistedJson(path) as T | undefined;
	} catch (error) {
		throw new Error(`Invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function writeJsonFile(path: string, data: unknown, mode?: number): void {
	writePersistedJson(path, data, mode ?? 0o600);
}
