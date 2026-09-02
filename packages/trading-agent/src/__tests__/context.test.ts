import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTrading, TradingRuntime } from "../context.ts";

/**
 * Deterministic replacement tests: the engine package's client/engine classes
 * are replaced with in-memory doubles so switching exchanges never touches the
 * network, the real paper account directory, or the process singleton.
 */
const engineMocks = vi.hoisted(() => {
	class CapturingExchangeClient {
		readonly id: string;
		readonly mode = "paper";
		readonly quoteCurrency = "USDT";
		readonly close = vi.fn(async () => {});
		constructor(id: string, ..._args: unknown[]) {
			this.id = id;
		}
	}
	class StubTradingEngine {
		readonly config: unknown;
		readonly client: CapturingExchangeClient;
		readonly stateStore: unknown;
		readonly close = vi.fn(async () => {});
		constructor(config: unknown, client: CapturingExchangeClient, stateStore: unknown) {
			this.config = config;
			this.client = client;
			this.stateStore = stateStore;
		}
		get id(): string {
			return this.client.id;
		}
	}
	const createMarketDataView = (client: CapturingExchangeClient) =>
		Object.freeze({ id: client.id, mode: client.mode, quoteCurrency: client.quoteCurrency });
	return { CapturingExchangeClient, StubTradingEngine, createMarketDataView };
});

const stateMocks = vi.hoisted(() => {
	const baseConfig = {
		language: "zh-CN",
		mode: "paper",
		marketType: "spot",
		leverage: 1,
		marginType: "isolated",
		positionMode: "one-way",
		exchange: "okx",
		quoteCurrency: "USDT",
		confirmLiveOrders: true,
		risk: { maxOrderNotional: 500, maxDailyNotional: 2000, allowedSymbols: [] },
		paper: { startQuote: 10_000, feeRate: 0.001 },
		monitor: {
			enabled: true,
			intervalSec: 30,
			wakeAgent: true,
			guardPositions: true,
			alertLossPct: 5,
			alertCooldownSec: 900,
			protectionCoveragePct: 95,
		},
	};
	const loadTradingConfig = vi.fn(() => structuredClone(baseConfig));
	const saveTradingConfig = vi.fn();
	const loadTradingState = vi.fn(() => ({}));
	const saveTradingState = vi.fn();
	const loadExchangeKeys = vi.fn(() => ({}));
	const validateTradingConfig = vi.fn();
	return {
		loadTradingConfig,
		saveTradingConfig,
		loadTradingState,
		saveTradingState,
		loadExchangeKeys,
		validateTradingConfig,
	};
});

vi.mock("../state.ts", () => ({
	loadTradingConfig: stateMocks.loadTradingConfig,
	saveTradingConfig: stateMocks.saveTradingConfig,
	loadTradingState: stateMocks.loadTradingState,
	saveTradingState: stateMocks.saveTradingState,
	loadExchangeKeys: stateMocks.loadExchangeKeys,
	validateTradingConfig: stateMocks.validateTradingConfig,
}));

vi.mock("@earendil-works/ti-trading-engine", () => ({
	CcxtExchangeClient: engineMocks.CapturingExchangeClient,
	PaperExchangeClient: engineMocks.CapturingExchangeClient,
	TradingEngine: engineMocks.StubTradingEngine,
	createMarketDataView: engineMocks.createMarketDataView,
}));

beforeEach(() => {
	vi.clearAllMocks();
});

describe("TradingRuntime client replacement", () => {
	const clientOf = (runtime: TradingRuntime): { id: string; close: () => Promise<void> } =>
		(runtime.tradingEngine as unknown as { client: { id: string; close: () => Promise<void> } }).client;

	it("keeps the process singleton uninitialized in this suite", () => {
		expect(() => getTrading()).toThrow("Trading runtime not initialized");
	});

	it("propagates the old client close rejection after installing the new runtime", async () => {
		const runtime = await TradingRuntime.init({ mode: "paper", exchange: "binance" });
		const oldClient = clientOf(runtime);
		const oldClose = vi.spyOn(oldClient, "close");
		const closeError = new Error("old client close failed");
		oldClose.mockRejectedValueOnce(closeError);

		await expect(runtime.setExchange("bybit")).rejects.toBe(closeError);

		// The new runtime is fully active: config swapped, persisted, and the new
		// client/engine installed, all before the old close failure propagated.
		expect(runtime.config.exchange).toBe("bybit");
		expect(stateMocks.saveTradingConfig).toHaveBeenCalledWith(
			expect.objectContaining({ exchange: "bybit", mode: "paper" }),
		);
		const newClient = clientOf(runtime);
		expect(newClient.id).toBe("bybit");
		expect(newClient).not.toBe(oldClient);
		expect(runtime.tradingEngine.id).toBe("bybit");
		expect(oldClose).toHaveBeenCalledTimes(1);
		const newClientClose = vi.spyOn(newClient, "close");
		expect(newClientClose).not.toHaveBeenCalled();
	});

	it("closes the old client after a successful exchange switch", async () => {
		const runtime = await TradingRuntime.init({ mode: "paper", exchange: "binance" });
		const oldClient = clientOf(runtime);
		const oldClose = vi.spyOn(oldClient, "close");

		await runtime.setExchange("bybit");

		expect(oldClose).toHaveBeenCalledTimes(1);
		expect(runtime.config.exchange).toBe("bybit");
		expect(runtime.marketData.id).toBe("bybit");
		expect(runtime.marketData).not.toBe(oldClient);
	});

	it("short-circuits when the exchange does not change", async () => {
		const runtime = await TradingRuntime.init({ mode: "paper", exchange: "binance" });
		const oldClose = vi.spyOn(clientOf(runtime), "close");

		await runtime.setExchange("binance");

		expect(oldClose).not.toHaveBeenCalled();
		expect(runtime.marketData.id).toBe("binance");
	});

	it("closes the active engine on runtime close", async () => {
		const runtime = await TradingRuntime.init({ mode: "paper", exchange: "binance" });
		const engineClose = vi.spyOn(runtime.tradingEngine, "close");

		await runtime.close();

		expect(engineClose).toHaveBeenCalledTimes(1);
	});

	it("keeps the published configuration deeply immutable", async () => {
		const runtime = await TradingRuntime.init({ mode: "paper", exchange: "binance" });

		expect(Object.isFrozen(runtime.config)).toBe(true);
		expect(Object.isFrozen(runtime.config.risk)).toBe(true);
		expect(Object.isFrozen(runtime.config.risk.allowedSymbols)).toBe(true);
		expect(() => Object.defineProperty(runtime.config.risk.allowedSymbols, "0", { value: "BTC/USDT" })).toThrow(
			TypeError,
		);
	});

	it("patches monitor config without replacing the exchange client", async () => {
		const runtime = await TradingRuntime.init({ mode: "paper", exchange: "binance" });
		const oldClose = vi.spyOn(clientOf(runtime), "close");

		await runtime.patchConfig({ monitor: { enabled: false, intervalSec: 15 } });

		expect(oldClose).not.toHaveBeenCalled();
		expect(runtime.config.monitor.enabled).toBe(false);
		expect(runtime.config.monitor.intervalSec).toBe(15);
		expect(runtime.config.monitor.wakeAgent).toBe(true);
		expect(stateMocks.saveTradingConfig).toHaveBeenCalledWith(
			expect.objectContaining({
				exchange: "binance",
				monitor: expect.objectContaining({ enabled: false, intervalSec: 15, wakeAgent: true }),
			}),
		);
	});

	it("replaces the client when patching quote currency", async () => {
		const runtime = await TradingRuntime.init({ mode: "paper", exchange: "binance" });
		const oldClient = clientOf(runtime);

		await runtime.patchConfig({ quoteCurrency: "USDC" });

		expect(runtime.config.quoteCurrency).toBe("USDC");
		expect(clientOf(runtime)).not.toBe(oldClient);
		expect(oldClient.close).toHaveBeenCalledTimes(1);
	});

	it("keeps the old runtime when persisting an exchange switch fails", async () => {
		const runtime = await TradingRuntime.init({ mode: "paper", exchange: "binance" });
		const oldClient = clientOf(runtime);
		const saveError = new Error("cannot write config");
		stateMocks.saveTradingConfig.mockImplementationOnce(() => {
			throw saveError;
		});

		await expect(runtime.setExchange("bybit")).rejects.toBe(saveError);

		expect(runtime.config.exchange).toBe("binance");
		expect(clientOf(runtime)).toBe(oldClient);
		expect(oldClient.close).not.toHaveBeenCalled();
	});
});
