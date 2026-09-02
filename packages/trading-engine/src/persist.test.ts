import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireFileLockSync, readJsonFile, releaseFileLock, withFileLockSync, writeJsonFile } from "./persist.ts";

describe("persist", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ti-persist-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("round-trips JSON through an atomic write", () => {
		const path = join(dir, "state.json");
		writeJsonFile(path, { quote: "USDT", value: 1 });
		expect(readJsonFile(path)).toEqual({ quote: "USDT", value: 1 });
	});

	it("returns undefined when the JSON file is absent", () => {
		expect(readJsonFile(join(dir, "missing.json"))).toBeUndefined();
	});

	it("throws SyntaxError for invalid JSON", () => {
		const path = join(dir, "broken.json");
		writeFileSync(path, "{");
		expect(() => readJsonFile(path)).toThrow(SyntaxError);
	});

	it("times out with a custom lock message", () => {
		const lockPath = join(dir, "state.lock");
		writeFileSync(lockPath, "");
		expect(() =>
			acquireFileLockSync(lockPath, {
				timeoutMs: 30,
				staleMs: 60_000,
				timeoutMessage: (path) => `Timed out waiting for paper account lock ${path}`,
			}),
		).toThrow(`Timed out waiting for paper account lock ${lockPath}`);
	});

	it("reclaims a stale lock without waiting for the timeout", () => {
		const lockPath = join(dir, "state.lock");
		writeFileSync(lockPath, "");
		const past = new Date(Date.now() - 120_000);
		utimesSync(lockPath, past, past);
		const lock = acquireFileLockSync(lockPath, { timeoutMs: 200, staleMs: 60_000 });
		releaseFileLock(lock);
	});

	it("prefers the operation error when the locked callback throws", () => {
		const lockPath = join(dir, "state.lock");
		expect(() =>
			withFileLockSync(lockPath, () => {
				throw new Error("mutator failed");
			}),
		).toThrow("mutator failed");
		const lock = acquireFileLockSync(lockPath, { timeoutMs: 200 });
		releaseFileLock(lock);
	});
});
