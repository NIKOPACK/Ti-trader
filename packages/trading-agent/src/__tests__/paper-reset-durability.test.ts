import type * as Fs from "node:fs";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { writeJsonFile } from "@nikopack/ti-trading-engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TradingRuntime } from "../context.ts";
import { DEFAULT_CONFIG, saveTradingConfig } from "../state.ts";

const fixtures = vi.hoisted(() => ({
	path: `.paper-reset-durability-${process.pid}-${Date.now()}`,
	handles: new Map<number, string>(),
	fail: false,
}));
vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof Fs>();
	return {
		...fs,
		openSync: (...args: Parameters<typeof Fs.openSync>) => {
			const fd = fs.openSync(...args);
			fixtures.handles.set(fd, String(args[0]));
			return fd;
		},
		fsyncSync: (fd: number) => {
			if (fixtures.fail && fixtures.handles.get(fd)?.endsWith("binance-USDT-futures.json"))
				throw new Error("injected Paper snapshot sync failure");
			fs.fsyncSync(fd);
		},
		closeSync: (fd: number) => {
			fixtures.handles.delete(fd);
			fs.closeSync(fd);
		},
	};
});
vi.mock("../config.ts", () => ({
	KEYS_PATH: `${fixtures.path}/keys.json`,
	PAPER_DIR: `${fixtures.path}/paper`,
	TRADING_CONFIG_PATH: `${fixtures.path}/trading.json`,
	TRADING_STATE_PATH: `${fixtures.path}/state.json`,
	readJsonFile: (path: string) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined),
	writeJsonFile: (path: string, state: unknown) => writeJsonFile(path, state, 0o600),
}));

afterEach(() => {
	fixtures.fail = false;
	rmSync(fixtures.path, { recursive: true, force: true });
});

describe("Paper reset durability before risk and admission", () => {
	it("preserves quota and maintenance when either account snapshot cannot be flushed", async () => {
		saveTradingConfig({ ...DEFAULT_CONFIG, exchange: "binance", marketType: "both" });
		const runtime = await TradingRuntime.init();
		runtime.tradingEngine.risk.record(100);
		fixtures.fail = true;
		await expect(runtime.resetPaperAccount(2000, { confirmExposure: true })).rejects.toThrow(/snapshot sync failure/);
		expect(runtime.tradingEngine.risk.usage().used).toBe(100);
		const maintenance = runtime.getExecutionStatus().maintenance!;
		expect(maintenance.action).toBe("paper-reset");
		expect(existsSync(`${fixtures.path}/paper/binance-USDT.transaction.json`)).toBe(true);
		fixtures.fail = false;
		await runtime.close();
		const restarted = await TradingRuntime.init();
		expect(restarted.getExecutionStatus().maintenance?.id).toBe(maintenance.id);
		expect(restarted.tradingEngine.risk.usage().used).toBe(100);
		for (const file of ["binance-USDT.json", "binance-USDT-futures.json"]) {
			expect(JSON.parse(readFileSync(`${fixtures.path}/paper/${file}`, "utf8"))).toMatchObject({
				balances: { USDT: 2000 },
			});
		}
		expect(existsSync(`${fixtures.path}/paper/binance-USDT.transaction.json`)).toBe(false);
		restarted.resolveMaintenance(maintenance.id, "independently-verified-account");
		expect(restarted.getExecutionStatus().admission.stale).toBe(true);
		await restarted.close();
	});

	it("only clears quota and advances admission after both durable account snapshots complete", async () => {
		saveTradingConfig({ ...DEFAULT_CONFIG, exchange: "binance", marketType: "both" });
		const runtime = await TradingRuntime.init();
		runtime.tradingEngine.risk.record(100);
		const accountId = runtime.getExecutionScope().accountId;
		await runtime.resetPaperAccount(2000, { confirmExposure: true });
		expect(runtime.tradingEngine.risk.usage().used).toBe(0);
		expect(runtime.getExecutionStatus()).toMatchObject({
			accountId,
			maintenance: undefined,
			admission: { generation: 1, currentGeneration: 1, stale: false },
		});
		await runtime.close();
		const restarted = await TradingRuntime.init();
		expect(restarted.tradingEngine.risk.usage().used).toBe(0);
		expect(restarted.config.paper.startQuote).toBe(2000);
		expect(restarted.getExecutionStatus().admission.stale).toBe(false);
		await restarted.close();
	});
});
