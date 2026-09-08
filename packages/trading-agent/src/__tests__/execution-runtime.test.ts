import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { resolve } from "node:path";
import type { ExchangeClient, Order, PlaceOrderInput } from "@earendil-works/ti-trading-engine";
import * as EngineModule from "@earendil-works/ti-trading-engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as StateDurability from "../state-durability.ts";

const fixtures = vi.hoisted(() => {
	const path = `.execution-runtime-${process.pid}-${Date.now()}`;
	const placed = new Map<string, Order>();
	const clients: FakePaper[] = [];
	let failResponse = true;
	class FakePaper {
		readonly id: string;
		readonly quoteCurrency: string;
		readonly mode: "paper" | "live" = "paper";
		readonly close = vi.fn(async () => {});
		readonly resetAccount = vi.fn(async () => {});
		readonly hasAnyAccountExposure = vi.fn(async () => false);
		readonly getOpenOrders = vi.fn(async () => []);
		readonly getPositions = vi.fn(async () => []);
		constructor(id: string, quote: string) {
			this.id = id;
			this.quoteCurrency = quote;
			clients.push(this);
		}
		getTicker = async (symbol: string) => ({ symbol, last: 100, timestamp: Date.now() });
		getMarketInfo = async (symbol: string) => ({
			symbol,
			base: "BTC",
			quote: "USDT",
			marketType: "spot",
			contract: false,
			active: true,
		});
		getBalances = async () => [
			{ asset: "USDT", free: 1000, used: 0, total: 1000 },
			{ asset: "BTC", free: 2, used: 0, total: 2 },
		];
		placeOrder = vi.fn(async (input: PlaceOrderInput) => {
			const order: Order = {
				...input,
				id: "accepted-1",
				filled: input.amount,
				remaining: 0,
				cost: input.amount * 100,
				status: "closed",
				timestamp: Date.now(),
			};
			placed.set(input.clientOrderId as string, order);
			if (failResponse) throw new Error("secret=NOT-PERSISTED timeout");
			return { order };
		});
		getOrderByClientId = vi.fn(async (id: string) => {
			const order = placed.get(id);
			if (!order) throw new Error("not found");
			return structuredClone(order);
		});
	}
	class FakeLive extends FakePaper {
		override readonly mode = "live" as const;
	}
	return {
		path,
		placed,
		clients,
		FakePaper,
		FakeLive,
		setResponseFailure: (fail: boolean) => {
			failResponse = fail;
		},
	};
});

vi.mock("@earendil-works/ti-trading-engine", async (importOriginal) => ({
	...(await importOriginal<typeof EngineModule>()),
	PaperExchangeClient: fixtures.FakePaper,
	CcxtExchangeClient: fixtures.FakeLive,
}));
vi.mock("../config.ts", () => ({
	KEYS_PATH: `${fixtures.path}/keys.json`,
	PAPER_DIR: `${fixtures.path}/paper`,
	TRADING_CONFIG_PATH: `${fixtures.path}/trading.json`,
	TRADING_STATE_PATH: `${fixtures.path}/state.json`,
	readJsonFile: (path: string) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined),
	writeJsonFile: (path: string, state: unknown) => EngineModule.writeJsonFile(path, state, 0o600),
}));

import { initTrading, TradingRuntime } from "../context.ts";
import {
	DEFAULT_CONFIG,
	loadTradingConfig,
	loadTradingState,
	saveExchangeKeys,
	saveTradingConfig,
	type TradingConfig,
} from "../state.ts";

afterEach(() => {
	vi.restoreAllMocks();
	rmSync(fixtures.path, { recursive: true, force: true });
	fixtures.placed.clear();
	fixtures.clients.length = 0;
	fixtures.setResponseFailure(true);
});

describe("default runtime durable execution integration", () => {
	it("exposes a stable nonsecret account scope without allowing caller mutation", async () => {
		saveTradingConfig({ ...DEFAULT_CONFIG, exchange: "binance" });
		const first = await TradingRuntime.init();
		const second = await TradingRuntime.init();
		const scope = first.getExecutionScope();
		expect(scope).toEqual({
			accountId: createHash("sha256")
				.update(`paper:${resolve(fixtures.path, "paper", "binance-USDT.json")}`)
				.digest("hex"),
			exchange: "binance",
			mode: "paper",
			marketType: "spot",
			quoteCurrency: "USDT",
			positionMode: "one-way",
		});
		expect(second.getExecutionScope()).toEqual(scope);
		expect(first.getMonitoringScope()).toEqual({
			accountId: scope.accountId,
			exchange: scope.exchange,
			mode: scope.mode,
			marketType: scope.marketType,
			quoteCurrency: scope.quoteCurrency,
		});
		scope.accountId = "caller-mutated";
		expect(first.getExecutionScope()).toEqual(second.getExecutionScope());
		expect(first.getExecutionScope().accountId).toBe(first.getExecutionStatus().accountId);
		await first.close();
		await second.close();
	});

	it("keeps captured monitoring identity available when the execution journal becomes unreadable", async () => {
		saveTradingConfig({ ...DEFAULT_CONFIG, exchange: "binance" });
		const runtime = await TradingRuntime.init();
		const scope = runtime.getMonitoringScope();
		EngineModule.writeJsonFile(`${fixtures.path}/state.json`, { executions: { version: 99 } });
		expect(() => runtime.getExecutionStatus()).toThrow(/Invalid trading risk state/);
		expect(runtime.getMonitoringScope()).toEqual(scope);
		await runtime.close();
	});

	it("never reclaims an old state lock by TTL while its writer might still be alive", () => {
		const lockPath = `${fixtures.path}/state.json.lock`;
		EngineModule.writeJsonFile(lockPath, {});
		utimesSync(lockPath, new Date("2000-01-01"), new Date("2000-01-01"));
		const inode = statSync(lockPath).ino;
		const now = Date.now();
		vi.spyOn(Date, "now")
			.mockReturnValueOnce(now)
			.mockReturnValue(now + 11_000);
		expect(() => loadTradingState()).toThrow(/Timed out waiting for trading state lock/);
		expect(statSync(lockPath).ino).toBe(inode);
	});

	it("fences reset across concurrent runtimes and requires explicit cleanup after reset failure", async () => {
		saveTradingConfig({ ...DEFAULT_CONFIG, exchange: "binance" });
		const first = await TradingRuntime.init();
		const second = await TradingRuntime.init();
		const plan = await second.tradingEngine.prepareOrder("sell", { symbol: "BTC/USDT", type: "market", amount: 1 });
		fixtures.clients[0].resetAccount.mockImplementationOnce(async () => {
			await expect(second.tradingEngine.placeOrder(plan)).rejects.toThrow(/maintenance blocks all/);
			throw new Error("reset outcome uncertain");
		});
		await expect(first.resetPaperAccount(1000, { confirmExposure: true })).rejects.toThrow("reset outcome uncertain");
		const maintenance = second.getExecutionStatus().maintenance;
		expect(maintenance).toMatchObject({ action: "paper-reset" });
		await second.recoverExecutions();
		expect(second.getExecutionStatus().maintenance?.id).toBe(maintenance?.id);
		expect(() => second.resolveMaintenance("stale-id", "verified-account")).toThrow(/changed/);
		second.resolveMaintenance(maintenance!.id, "verified-account");
		expect(second.getExecutionStatus().maintenance).toBeUndefined();
		expect(second.listAuditEvents().at(-1)).toMatchObject({
			action: "maintenance-manually-released",
			evidenceReference: "verified-account",
		});
		expect(fixtures.clients[1].placeOrder).not.toHaveBeenCalled();
		await first.close();
		await second.close();
	});

	it("rejects a stale engine plan after a successful replacement and records the transition", async () => {
		saveTradingConfig({ ...DEFAULT_CONFIG, exchange: "binance" });
		const runtime = await TradingRuntime.init();
		const old = runtime.tradingEngine;
		const plan = await old.prepareOrder("sell", { symbol: "BTC/USDT", type: "market", amount: 1 });
		await runtime.setExchange("okx");
		await expect(old.placeOrder(plan)).rejects.toThrow(/was replaced/);
		expect(runtime.getExecutionStatus().maintenance).toBeUndefined();
		expect(runtime.listAuditEvents().at(-1)?.action).toBe("runtime-replacement-completed");
		await runtime.close();
	});

	it("never sends after a durable state sync failure and reconciles the persisted preparation", async () => {
		saveTradingConfig({ ...DEFAULT_CONFIG, exchange: "binance" });
		const runtime = await TradingRuntime.init();
		const plan = await runtime.tradingEngine.prepareOrder("sell", { symbol: "BTC/USDT", type: "market", amount: 1 });
		vi.spyOn(StateDurability, "syncTradingStateFile").mockImplementationOnce(() => {
			throw new Error("sync failed");
		});
		await expect(runtime.tradingEngine.placeOrder(plan)).rejects.toThrow(/sync failed/);
		expect(fixtures.clients[0].placeOrder).not.toHaveBeenCalled();
		expect(runtime.getExecutionStatus().unresolved[0]?.status).toBe("prepared");
		await runtime.recoverExecutions();
		expect(runtime.getExecutionStatus().unresolved).toEqual([]);
		await runtime.close();
	});
	it("recovers accepted-before-response from disk at startup without a second placement", async () => {
		saveTradingConfig({ ...DEFAULT_CONFIG, exchange: "binance" });
		const first = await TradingRuntime.init();
		const plan = await first.tradingEngine.prepareOrder("buy", { symbol: "BTC/USDT", type: "market", amount: 1 });
		await expect(first.tradingEngine.placeOrder(plan)).rejects.toThrow(/unknown/);
		expect(first.getExecutionStatus().unresolved).toHaveLength(1);
		await first.close();
		const second = await TradingRuntime.init();
		expect(second.getExecutionStatus()).toMatchObject({ unresolved: [], recovery: { reconciled: 1 } });
		expect(second.tradingEngine.risk.usage()).toMatchObject({ used: 100, reserved: 0 });
		expect(fixtures.clients[0].placeOrder).toHaveBeenCalledOnce();
		expect(fixtures.clients[1].placeOrder).not.toHaveBeenCalled();
		expect(readFileSync(`${fixtures.path}/state.json`, "utf8")).not.toContain("NOT-PERSISTED");
		await second.close();
	});

	it("blocks confirmed account switches and paper reset for an unknown reduction with no quota claim", async () => {
		saveTradingConfig({ ...DEFAULT_CONFIG, exchange: "binance" });
		const runtime = await TradingRuntime.init();
		await expect(
			runtime.tradingEngine.placeOrder(
				await runtime.tradingEngine.prepareOrder("sell", { symbol: "BTC/USDT", type: "market", amount: 1 }),
			),
		).rejects.toThrow(/unknown/);
		expect(runtime.tradingEngine.risk.usage().reserved).toBe(0);
		await expect(runtime.setExchange("okx", { confirmAccountSwitch: true })).rejects.toThrow(/unresolved executions/);
		await expect(runtime.resetPaperAccount(1000, { confirmExposure: true })).rejects.toThrow(/unresolved executions/);
		expect(fixtures.clients[0].resetAccount).not.toHaveBeenCalled();
		await runtime.close();
	});

	it("never looks up unknown live orders with rotated credentials or stores credentials", async () => {
		saveTradingConfig({ ...DEFAULT_CONFIG, mode: "live", exchange: "binance", confirmLiveOrders: false });
		saveExchangeKeys({ binance: { apiKey: "MOCK-KEY-A", secret: "MOCK-SECRET" } });
		const first = await TradingRuntime.init();
		await expect(
			first.tradingEngine.placeOrder(
				await first.tradingEngine.prepareOrder("buy", { symbol: "BTC/USDT", type: "market", amount: 1 }),
				{ allowUnconfirmedLive: true },
			),
		).rejects.toThrow(/unknown/);
		const originalMonitoringScope = first.getMonitoringScope();
		saveExchangeKeys({ binance: { apiKey: "MOCK-KEY-B", secret: "MOCK-SECRET" } });
		expect(first.getMonitoringScope()).toEqual(originalMonitoringScope);
		await first.close();
		const second = await TradingRuntime.init();
		expect(second.getExecutionStatus().recovery?.issues[0].issue).toBe("account-mismatch");
		expect(fixtures.clients[1].getOrderByClientId).not.toHaveBeenCalled();
		expect(loadTradingState().live.reservedDailyNotional).toBe(100);
		const serialized = readFileSync(`${fixtures.path}/state.json`, "utf8");
		expect(serialized).not.toMatch(/MOCK-KEY|MOCK-SECRET|NOT-PERSISTED/);
		await second.close();
	});

	it("rejects corrupted journal state before publishing the runtime", async () => {
		saveTradingConfig({ ...DEFAULT_CONFIG, exchange: "binance" });
		EngineModule.writeJsonFile(`${fixtures.path}/state.json`, {
			paper: { date: "2026-01-01", usedDailyNotional: 0 },
			live: { date: "2026-01-01", usedDailyNotional: 0 },
			executions: { version: 99, records: [] },
		});
		await expect(TradingRuntime.init()).rejects.toThrow(/Invalid trading risk state/);
		expect(fixtures.clients).toHaveLength(0);
	});

	it.each(["switch", "reset"] as const)(
		"fences a second writer before the asynchronous %s exposure snapshot",
		async (operation) => {
			saveTradingConfig({ ...DEFAULT_CONFIG, exchange: "binance" });
			fixtures.setResponseFailure(false);
			const first = await TradingRuntime.init();
			const second = await TradingRuntime.init();
			const plan = await second.tradingEngine.prepareOrder("buy", { symbol: "BTC/USDT", type: "market", amount: 1 });
			fixtures.clients[0].hasAnyAccountExposure.mockImplementationOnce(async () => {
				const snapshot = fixtures.placed.size > 0;
				await expect(second.tradingEngine.placeOrder(plan)).rejects.toThrow(/maintenance blocks all/);
				return snapshot;
			});
			if (operation === "switch") await first.setExchange("okx");
			else await first.resetPaperAccount();
			expect(fixtures.clients[1].placeOrder).not.toHaveBeenCalled();
			expect(first.getExecutionStatus().maintenance).toBeUndefined();
			await first.close();
			await second.close();
		},
	);

	it.each(["switch", "reset"] as const)(
		"keeps already acknowledged exposure visible to %s confirmation and cancels the fence",
		async (operation) => {
			saveTradingConfig({ ...DEFAULT_CONFIG, exchange: "binance" });
			fixtures.setResponseFailure(false);
			const first = await TradingRuntime.init();
			const second = await TradingRuntime.init();
			await second.tradingEngine.placeOrder(
				await second.tradingEngine.prepareOrder("buy", { symbol: "BTC/USDT", type: "market", amount: 1 }),
			);
			fixtures.clients[0].hasAnyAccountExposure.mockImplementationOnce(async () => fixtures.placed.size > 0);
			await expect(operation === "switch" ? first.setExchange("okx") : first.resetPaperAccount()).rejects.toThrow(
				/hide existing|delete existing/,
			);
			expect(first.getExecutionStatus()).toMatchObject({
				maintenance: undefined,
				unresolved: [],
				admission: { generation: 0, currentGeneration: 0, stale: false },
			});
			expect(first.tradingEngine.risk.usage()).toMatchObject({ used: 100, reserved: 0 });
			expect(fixtures.clients[0].resetAccount).not.toHaveBeenCalled();
			expect(first.config.exchange).toBe("binance");
			await first.close();
			await second.close();
		},
	);

	it("keeps the fence if persisting an inspection cancellation fails", async () => {
		saveTradingConfig({ ...DEFAULT_CONFIG, exchange: "binance" });
		const runtime = await TradingRuntime.init();
		fixtures.clients[0].hasAnyAccountExposure.mockImplementationOnce(async () => {
			vi.spyOn(EngineModule, "writeJsonFile").mockImplementationOnce(() => {
				throw new Error("disk failed");
			});
			return true;
		});
		await expect(runtime.resetPaperAccount()).rejects.toThrow(/fence cancellation failed/);
		expect(runtime.getExecutionStatus().maintenance?.action).toBe("paper-reset");
		expect(fixtures.clients[0].resetAccount).not.toHaveBeenCalled();
		await runtime.close();
	});

	it("requires independent and during-fence runtimes to reinitialize after a Paper reset", async () => {
		saveTradingConfig({ ...DEFAULT_CONFIG, exchange: "binance" });
		fixtures.setResponseFailure(false);
		const owner = await TradingRuntime.init();
		const stale = await TradingRuntime.init();
		const oldPlan = await stale.tradingEngine.prepareOrder("buy", { symbol: "BTC/USDT", type: "market", amount: 1 });
		let during: TradingRuntime | undefined;
		fixtures.clients[0].resetAccount.mockImplementationOnce(async () => {
			during = await TradingRuntime.init();
		});
		await owner.resetPaperAccount(undefined, { confirmExposure: true });
		await expect(stale.tradingEngine.placeOrder(oldPlan)).rejects.toThrow(/admission generation/);
		await expect(
			during!.tradingEngine.placeOrder(
				await during!.tradingEngine.prepareOrder("buy", { symbol: "BTC/USDT", type: "market", amount: 1 }),
			),
		).rejects.toThrow(/admission generation/);
		expect(during!.getExecutionStatus().admission).toEqual({ generation: 0, currentGeneration: 1, stale: true });
		expect(during!.getExecutionStatus()).toMatchObject({ configured: true, staleRuntime: true });
		const fresh = await TradingRuntime.init();
		expect(fresh.getExecutionScope()).toEqual(stale.getExecutionScope());
		expect(owner.getExecutionStatus().admission).toEqual({ generation: 1, currentGeneration: 1, stale: false });
		expect(owner.getExecutionStatus().staleRuntime).toBe(false);
		await owner.tradingEngine.placeOrder(
			await owner.tradingEngine.prepareOrder("buy", { symbol: "BTC/USDT", type: "market", amount: 1 }),
		);
		await fresh.tradingEngine.placeOrder(
			await fresh.tradingEngine.prepareOrder("buy", { symbol: "BTC/USDT", type: "market", amount: 1 }),
		);
		expect(owner.tradingEngine.risk.usage().used).toBe(200);
		await Promise.all([owner.close(), stale.close(), during!.close(), fresh.close()]);
	});

	it("invalidates old plans and stale full-config writes after a same-account fee and limit change", async () => {
		saveTradingConfig({ ...DEFAULT_CONFIG, exchange: "binance" });
		fixtures.setResponseFailure(false);
		const owner = await TradingRuntime.init();
		const stale = await TradingRuntime.init();
		const oldPlan = await stale.tradingEngine.prepareOrder("buy", { symbol: "BTC/USDT", type: "market", amount: 1 });
		await owner.patchConfig({ risk: { maxOrderNotional: 50 }, paper: { feeRate: 0.002 } });
		expect(owner.getExecutionScope()).toEqual(stale.getExecutionScope());
		await expect(stale.tradingEngine.placeOrder(oldPlan)).rejects.toThrow(/admission generation/);
		await expect(stale.setLanguage("en-US")).rejects.toThrow(/admission generation/);
		expect(loadTradingConfig()).toMatchObject({ risk: { maxOrderNotional: 50 }, paper: { feeRate: 0.002 } });
		const fresh = await TradingRuntime.init();
		await expect(
			fresh.tradingEngine.placeOrder(
				await fresh.tradingEngine.prepareOrder("buy", { symbol: "BTC/USDT", type: "market", amount: 1 }),
			),
		).rejects.toThrow(/maxOrderNotional/);
		await owner.tradingEngine.placeOrder(
			await owner.tradingEngine.prepareOrder("buy", { symbol: "BTC/USDT", type: "market", amount: 0.4 }),
		);
		expect(owner.tradingEngine.risk.usage().used).toBe(40);
		await Promise.all([owner.close(), stale.close(), fresh.close()]);
	});

	it("does not bind asynchronously constructed clients and old config to a newly completed admission generation", async () => {
		saveTradingConfig({ ...DEFAULT_CONFIG, exchange: "binance" });
		const owner = await TradingRuntime.init();
		let entered!: () => void;
		let release!: () => void;
		const constructing = new Promise<void>((done) => {
			entered = done;
		});
		const gate = new Promise<void>((done) => {
			release = done;
		});
		const factory = TradingRuntime.prototype as unknown as {
			createClient(config: TradingConfig): Promise<ExchangeClient>;
		};
		const original = factory.createClient;
		vi.spyOn(factory, "createClient").mockImplementationOnce(async function (this: TradingRuntime, config) {
			const client = await original.call(this, config);
			entered();
			await gate;
			return client;
		});
		const starting = TradingRuntime.init();
		await constructing;
		await owner.patchConfig({ risk: { maxOrderNotional: 50 }, paper: { feeRate: 0.002 } });
		release();
		await expect(starting).rejects.toThrow(/admission generation changed during initialization/);
		expect(fixtures.clients[1].close).toHaveBeenCalledOnce();
		const fresh = await TradingRuntime.init();
		expect(fresh.config.risk.maxOrderNotional).toBe(50);
		expect(fresh.getExecutionStatus().admission).toEqual({ generation: 1, currentGeneration: 1, stale: false });
		await Promise.all([owner.close(), fresh.close()]);
	});

	it("retires a candidate runtime if completion reports failure after its state write", async () => {
		saveTradingConfig({ ...DEFAULT_CONFIG, exchange: "binance" });
		const runtime = await TradingRuntime.init();
		const complete = EngineModule.TradingEngine.prototype.completeMaintenance;
		vi.spyOn(EngineModule.TradingEngine.prototype, "completeMaintenance").mockImplementationOnce(function (
			this: EngineModule.TradingEngine,
			id,
		) {
			complete.call(this, id);
			throw new Error("completion acknowledgement lost");
		});
		await expect(runtime.resetPaperAccount(undefined, { confirmExposure: true })).rejects.toThrow(
			/acknowledgement lost/,
		);
		expect(runtime.getExecutionStatus()).toMatchObject({
			maintenance: undefined,
			configured: true,
			staleRuntime: true,
			admission: { currentGeneration: 1, stale: true },
		});
		await expect(
			runtime.tradingEngine.placeOrder(
				await runtime.tradingEngine.prepareOrder("sell", { symbol: "BTC/USDT", type: "market", amount: 1 }),
			),
		).rejects.toThrow(/was replaced/);
		await runtime.close();
	});

	it("never grants a future generation from a publicly observed maintenance marker", async () => {
		saveTradingConfig({ ...DEFAULT_CONFIG, exchange: "binance" });
		const owner = await TradingRuntime.init();
		const maintenance = owner.tradingEngine.beginMaintenance("runtime-replacement");
		await expect(TradingRuntime.init({}, maintenance)).rejects.toThrow(/reserved for the maintenance owner/);
		owner.tradingEngine.cancelMaintenance(maintenance.id);
		await owner.close();
	});

	it("also fences and recovers process singleton replacement without allowing stale engines or unresolved switches", async () => {
		saveTradingConfig({ ...DEFAULT_CONFIG, exchange: "binance" });
		const first = await initTrading();
		const oldEngine = first.tradingEngine;
		const oldPlan = await oldEngine.prepareOrder("sell", { symbol: "BTC/USDT", type: "market", amount: 1 });
		const second = await initTrading({ exchange: "okx" });
		expect(second.getExecutionStatus()).toMatchObject({ maintenance: undefined, recovery: { examined: 0 } });
		await expect(oldEngine.placeOrder(oldPlan)).rejects.toThrow(/was replaced/);
		await expect(
			second.tradingEngine.placeOrder(
				await second.tradingEngine.prepareOrder("sell", { symbol: "BTC/USDT", type: "market", amount: 1 }),
			),
		).rejects.toThrow(/unknown/);
		await expect(initTrading({ exchange: "binance" })).rejects.toThrow(/unresolved executions/);
		expect(fixtures.clients).toHaveLength(2);
		await second.close();
	});
});
