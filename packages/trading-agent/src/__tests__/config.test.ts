import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getTradingStoragePaths } from "../config.ts";

describe("trading storage paths", () => {
	it("derives every runtime file from one isolated directory", () => {
		const root = mkdtempSync(join(tmpdir(), "ti-trading-"));
		try {
			const paths = getTradingStoragePaths(root);
			expect(paths).toEqual({
				configDir: root,
				agentDir: join(root, "agent"),
				tradingConfigPath: join(root, "agent", "trading.json"),
				tradingStatePath: join(root, "agent", "trading-state.json"),
				keysPath: join(root, "agent", "keys.json"),
				paperDir: join(root, "agent", "paper"),
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("resolves relative roots consistently", () => {
		const paths = getTradingStoragePaths("./.ti-test-data");
		expect(paths.configDir).toMatch(/\/\.ti-test-data$/);
		expect(paths.paperDir).toBe(join(paths.agentDir, "paper"));
	});
});
