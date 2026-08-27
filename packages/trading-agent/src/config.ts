import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const APP_NAME = "ti";
/** Ti owns a separate home from pi so both applications can be installed together. */
export const CONFIG_DIR = join(homedir(), ".ti-trader");
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
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch (error) {
		throw new Error(`Invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function writeJsonFile(path: string, data: unknown, mode?: number): void {
	mkdirSync(join(path, ".."), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(temporaryPath, `${JSON.stringify(data, null, "\t")}\n`, { encoding: "utf8", mode: mode ?? 0o600 });
	if (mode !== undefined) chmodSync(temporaryPath, mode);
	renameSync(temporaryPath, path);
	if (mode !== undefined) chmodSync(path, mode);
}
