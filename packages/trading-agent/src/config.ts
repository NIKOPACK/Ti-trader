import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readJsonFile as readPersistedJson, writeJsonFile as writePersistedJson } from "@nikopack/ti-trading-engine";

export const APP_NAME = "ti";
/** Ti owns a separate home from pi so both applications can be installed together. */
export const CONFIG_DIR_NAME = ".ti-trader";
export interface TradingStoragePaths {
	configDir: string;
	agentDir: string;
	tradingConfigPath: string;
	tradingStatePath: string;
	keysPath: string;
	paperDir: string;
}

/**
 * Resolve all Ti-owned files from one directory so tests and smoke checks never
 * need to write into the developer's real home directory.
 *
 * TI_DATA_DIR is intentionally a path override, not a fallback: an invalid or
 * unwritable directory still fails at the first file operation.
 */
export function getTradingStoragePaths(
	rootDir = process.env.TI_DATA_DIR?.trim() || join(homedir(), CONFIG_DIR_NAME),
): TradingStoragePaths {
	const configDir = resolve(rootDir);
	const agentDir = join(configDir, "agent");
	return {
		configDir,
		agentDir,
		tradingConfigPath: join(agentDir, "trading.json"),
		tradingStatePath: join(agentDir, "trading-state.json"),
		keysPath: join(agentDir, "keys.json"),
		paperDir: join(agentDir, "paper"),
	};
}

const STORAGE_PATHS = getTradingStoragePaths();
export const CONFIG_DIR = STORAGE_PATHS.configDir;
export const AGENT_DIR = STORAGE_PATHS.agentDir;
export const TRADING_CONFIG_PATH = STORAGE_PATHS.tradingConfigPath;
export const TRADING_STATE_PATH = STORAGE_PATHS.tradingStatePath;
export const KEYS_PATH = STORAGE_PATHS.keysPath;
export const PAPER_DIR = STORAGE_PATHS.paperDir;

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
