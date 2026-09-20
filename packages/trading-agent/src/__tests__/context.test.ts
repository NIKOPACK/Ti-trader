import { InMemoryTelemetryContext, NOOP_TELEMETRY_CONTEXT } from "@earendil-works/pi-telemetry";
import type { Order, Position } from "@nikopack/ti-trading-engine";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { validateLiveVenueCredentials } from "../../../trading-engine/src/venues/index.ts";
import { getTrading, TradingRuntime, UnattendedTradingConfirmationRequired } from "../context.ts";
import { TRADING_TELEMETRY_SCHEMA } from "../telemetry.ts";

/**
 * Deterministic replacement tests: the engine package's client/engine classes
 * are replaced with in-memory doubles so switching exchanges never touches the
 * network, the real paper account directory, or the process singleton.
 */
const engineMocks = vi.hoisted(() => {
	let tradingEngineConstructorError: Error | undefined;
	const createdClients: CapturingExchangeClient[] = [];
	class CapturingExchangeClient {
		readonly id: string;
		readonly mode = "paper";
		readonly quoteCurrency = "USDT";
		readonly close = vi.fn(async () => {});
		readonly openOrders: Order[] = [];
		readonly positions: Position[] = [];
		readonly hasAnyAccountExposure = vi.fn(async () => this.openOrders.length > 0 || this.positions.length > 0);
		constructor(id: string, ..._args: unknown[]) {
			this.id = id;
			createdClients.push(this);
		}
		readonly getOpenOrders = vi.fn(async (_symbol?: string): Promise<Order[]> => [...this.openOrders]);
		readonly getPositions = vi.fn(async (): Promise<Position[]> => [...this.positions]);
	}
	class StubTradingEngine {
		readonly recoverExecutions = vi.fn(async () => ({ examined: 0, reconciled: 0, unresolved: 0, issues: [] }));
		readonly getExecutionStatus = vi.fn(() => ({
			configured: true,
			accountId: "fixture",
			unresolved: [] as Array<{ id: string }>,
		}));
		readonly recordConfigurationChange = vi.fn();
		readonly beginMaintenance = vi.fn(() => ({ id: "maintenance-1", nextGeneration: 1 }));
		readonly cancelMaintenance = vi.fn();
		readonly completeMaintenance = vi.fn();
		readonly retireSubmissions = vi.fn();
		config: unknown;
		readonly client: CapturingExchangeClient;
		readonly stateStore: unknown;
		readonly close = vi.fn(async () => {});
		readonly risk = {
			listPendingReservations: vi.fn(() => [] as Array<{ id: string }>),
		};
		readonly setConfig = vi.fn((config: unknown) => {
			this.config = config;
		});
		constructor(config: unknown, client: CapturingExchangeClient, stateStore: unknown) {
			if (tradingEngineConstructorError) throw tradingEngineConstructorError;
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
	return {
		CapturingExchangeClient,
		StubTradingEngine,
		createMarketDataView,
		createdClients,
		reset: () => {
			tradingEngineConstructorError = undefined;
			createdClients.length = 0;
		},
		setTradingEngineConstructorError: (error: Error | undefined) => {
			tradingEngineConstructorError = error;
		},
	};
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
		orderApproval: "confirm" as const,
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
	const loadExchangeKeys = vi.fn((): Record<string, { apiKey: string; secret: string; password?: string }> => ({}));
	const loadExchangeKeyEntry = vi.fn(
		(exchange: string): { apiKey: string; secret: string; password?: string } | undefined =>
			loadExchangeKeys()[exchange],
	);
	const validateTradingConfig = vi.fn();
	const normalizeTradingConfig = vi.fn((config: typeof baseConfig) => ({
		...config,
		risk: { ...config.risk, allowedSymbols: [...config.risk.allowedSymbols] },
		paper: { ...config.paper },
		monitor: { ...config.monitor },
	}));
	return {
		loadTradingConfig,
		saveTradingConfig,
		loadTradingState,
		saveTradingState,
		loadExchangeKeys,
		loadExchangeKeyEntry,
		validateTradingConfig,
		normalizeTradingConfig,
		defaultOrderApproval: (mode: "paper" | "live") => (mode === "live" ? "confirm" : "unattended"),
	};
});

vi.mock("../state.ts", () => ({
	loadTradingConfig: stateMocks.loadTradingConfig,
	saveTradingConfig: stateMocks.saveTradingConfig,
	loadTradingState: stateMocks.loadTradingState,
	saveTradingState: stateMocks.saveTradingState,
	loadExchangeKeys: stateMocks.loadExchangeKeys,
	loadExchangeKeyEntry: stateMocks.loadExchangeKeyEntry,
	validateTradingConfig: stateMocks.validateTradingConfig,
	normalizeTradingConfig: stateMocks.normalizeTradingConfig,
	defaultOrderApproval: stateMocks.defaultOrderApproval,
}));

const venueMocks = vi.hoisted(() => ({
	validateLiveVenueCredentials: vi.fn(),
}));

vi.mock("@nikopack/ti-trading-engine", () => ({
	CcxtExchangeClient: engineMocks.CapturingExchangeClient,
	PaperExchangeClient: engineMocks.CapturingExchangeClient,
	TradingEngine: engineMocks.StubTradingEngine,
	createMarketDataView: engineMocks.createMarketDataView,
	validateLiveVenueCredentials: venueMocks.validateLiveVenueCredentials,
}));

beforeEach(() => {
	vi.clearAllMocks();
	engineMocks.reset();
	venueMocks.validateLiveVenueCredentials.mockImplementation(validateLiveVenueCredentials);
});

describe("TradingRuntime client replacement", () => {
	const clientOf = (runtime: TradingRuntime): CapturingClient =>
		(runtime.tradingEngine as unknown as { client: CapturingClient }).client;
	type CapturingClient = {
		id: string;
		close: () => Promise<void>;
		openOrders: Order[];
		positions: Position[];
		hasAnyAccountExposure: () => Promise<boolean>;
		getOpenOrders: (symbol?: string) => Promise<Order[]>;
		getPositions: () => Promise<Position[]>;
	};

	it("keeps the process singleton uninitialized in this suite", () => {
		expect(() => getTrading()).toThrow("Trading runtime not initialized");
	});

	it("uses the shared NOOP telemetry context by default", async () => {
		const runtime = await TradingRuntime.init({ mode: "paper", exchange: "binance" });

		expect(runtime.telemetry).toBe(NOOP_TELEMETRY_CONTEXT);
		expect(runtime.getExecutionStatus().recovery).toMatchObject({ examined: 0, unresolved: 0 });
		await runtime.close();
	});

	it("runs recovery before publishing both initial and replacement engines", async () => {
		const runtime = await TradingRuntime.init({ mode: "paper", exchange: "binance" });
		const initial = runtime.tradingEngine as unknown as InstanceType<typeof engineMocks.StubTradingEngine>;
		expect(initial.recoverExecutions).toHaveBeenCalledOnce();
		await runtime.setExchange("bybit");
		const replacement = runtime.tradingEngine as unknown as InstanceType<typeof engineMocks.StubTradingEngine>;
		expect(replacement).not.toBe(initial);
		expect(replacement.recoverExecutions).toHaveBeenCalledOnce();
		expect(runtime.getExecutionStatus().recovery).toMatchObject({ unresolved: 0, examined: 0 });
	});

	it("records runtime and recovery spans with a parent relationship", async () => {
		const telemetryContext = new InMemoryTelemetryContext();
		const runtime = await TradingRuntime.init({ mode: "paper", exchange: "binance" }, undefined, telemetryContext);

		const spans = telemetryContext.getSpans();
		const runtimeSpan = spans.find((span) => span.name === "ti.trading.runtime.init");
		const recoverySpan = spans.find((span) => span.name === "ti.trading.execution.recovery");
		expect(runtimeSpan).toMatchObject({
			parentId: null,
			status: { status: "ok" },
			attributes: {
				"ti.trading.mode": "paper",
				"ti.trading.market_family": "spot",
				"ti.trading.unresolved_count": 0,
			},
		});
		expect(recoverySpan).toMatchObject({
			parentId: runtimeSpan?.id,
			status: { status: "ok" },
			attributes: {
				"ti.trading.examined_count": 0,
				"ti.trading.reconciled_count": 0,
				"ti.trading.unresolved_count": 0,
			},
		});
		const allowedAttributes = new Set([
			"ti.trading.mode",
			"ti.trading.market_family",
			"ti.trading.duration_ms",
			"ti.trading.error_type",
			"ti.trading.examined_count",
			"ti.trading.reconciled_count",
			"ti.trading.unresolved_count",
		]);
		for (const span of spans) {
			expect(Object.keys(span.attributes).every((key) => allowedAttributes.has(key))).toBe(true);
		}
		await runtime.close();
	});

	it("blocks even confirmed replacement when an unresolved reducing execution has no claim", async () => {
		const runtime = await TradingRuntime.init({ mode: "paper", exchange: "binance" });
		const engine = runtime.tradingEngine as unknown as InstanceType<typeof engineMocks.StubTradingEngine>;
		engine.getExecutionStatus.mockReturnValue({
			configured: true,
			accountId: "fixture",
			unresolved: [{ id: "exit-unknown" }],
		});
		await expect(runtime.patchConfig({ exchange: "bybit", confirmAccountSwitch: true })).rejects.toThrow(
			/unresolved executions/,
		);
		await expect(runtime.patchConfig({ leverage: 2 })).rejects.toThrow(/unresolved executions/);
		expect(engineMocks.createdClients).toHaveLength(1);
	});

	it("closes the initial client when engine initialization fails", async () => {
		const engineError = new Error("risk state is corrupted");
		engineMocks.setTradingEngineConstructorError(engineError);

		await expect(TradingRuntime.init({ mode: "paper", exchange: "binance" })).rejects.toBe(engineError);

		expect(engineMocks.createdClients).toHaveLength(1);
		expect(engineMocks.createdClients[0].close).toHaveBeenCalledTimes(1);
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

	it("serializes configuration mutations and evaluates queued patches on the latest runtime", async () => {
		const runtime = await TradingRuntime.init({ mode: "paper", exchange: "binance" });
		const oldClient = clientOf(runtime);
		let releaseInspection!: () => void;
		const inspection = new Promise<void>((resolve) => {
			releaseInspection = resolve;
		});
		vi.spyOn(oldClient, "hasAnyAccountExposure").mockImplementationOnce(async () => {
			await inspection;
			return false;
		});

		const switchExchange = runtime.setExchange("bybit");
		const updateMonitor = runtime.patchConfig({ monitor: { enabled: false } });
		await Promise.resolve();
		expect(runtime.config.exchange).toBe("binance");
		expect(runtime.config.monitor.enabled).toBe(true);

		releaseInspection();
		await Promise.all([switchExchange, updateMonitor]);
		expect(runtime.config.exchange).toBe("bybit");
		expect(runtime.config.monitor.enabled).toBe(false);
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

	it("retries failed shutdowns while sharing concurrent close attempts", async () => {
		const runtime = await TradingRuntime.init({ mode: "paper", exchange: "binance" });
		const closeError = new Error("temporary close failure");
		const engineClose = vi.spyOn(runtime.tradingEngine, "close").mockRejectedValueOnce(closeError);

		expect(await Promise.allSettled([runtime.close(), runtime.close()])).toEqual([
			{ status: "rejected", reason: closeError },
			{ status: "rejected", reason: closeError },
		]);
		expect(engineClose).toHaveBeenCalledTimes(1);

		await Promise.all([runtime.close(), runtime.close()]);
		await runtime.close();
		expect(engineClose).toHaveBeenCalledTimes(2);
	});

	it("can close a replacement engine after an earlier shutdown failed", async () => {
		const runtime = await TradingRuntime.init({ mode: "paper", exchange: "binance" });
		const closeError = new Error("temporary close failure");
		const oldEngineClose = vi.spyOn(runtime.tradingEngine, "close").mockRejectedValueOnce(closeError);
		await expect(runtime.close()).rejects.toBe(closeError);

		await runtime.setExchange("bybit");
		const newEngineClose = vi.spyOn(runtime.tradingEngine, "close");
		await runtime.close();

		expect(oldEngineClose).toHaveBeenCalledTimes(1);
		expect(newEngineClose).toHaveBeenCalledTimes(1);
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

	it("rejects live OKX keys that are missing a passphrase", async () => {
		stateMocks.loadExchangeKeys.mockReturnValue({ okx: { apiKey: "k", secret: "s" } });
		const runtime = await TradingRuntime.init({ exchange: "okx" });
		await expect(runtime.setMode("live")).rejects.toThrow(/passphrase/);
	});

	it("requires explicit confirmation to switch live order approval to unattended", async () => {
		stateMocks.loadExchangeKeys.mockReturnValue({ binance: { apiKey: "k", secret: "s" } });
		const runtime = await TradingRuntime.init({ mode: "paper", exchange: "binance" });

		await runtime.patchConfig({ orderApproval: "unattended" });
		expect(runtime.config.orderApproval).toBe("unattended");
		await runtime.setMode("live");
		expect(runtime.config.mode).toBe("live");
		expect(runtime.config.orderApproval).toBe("confirm");

		await expect(runtime.patchConfig({ orderApproval: "unattended" })).rejects.toBeInstanceOf(
			UnattendedTradingConfirmationRequired,
		);
		expect(runtime.config.orderApproval).toBe("confirm");

		await runtime.patchConfig({ orderApproval: "unattended", confirmUnattendedTrading: true });
		expect(runtime.config.orderApproval).toBe("unattended");
		await runtime.patchConfig({ orderApproval: "confirm" });
		expect(runtime.config.orderApproval).toBe("confirm");
	});

	it("rejects paper unattended switching to live unattended without confirmation", async () => {
		stateMocks.loadExchangeKeys.mockReturnValue({ binance: { apiKey: "k", secret: "s" } });
		const runtime = await TradingRuntime.init({ mode: "paper", exchange: "binance" });
		await runtime.patchConfig({ orderApproval: "unattended" });

		await expect(runtime.patchConfig({ mode: "live", orderApproval: "unattended" })).rejects.toBeInstanceOf(
			UnattendedTradingConfirmationRequired,
		);
		expect(runtime.config.mode).toBe("paper");
		expect(runtime.config.orderApproval).toBe("unattended");

		await runtime.patchConfig({
			mode: "live",
			orderApproval: "unattended",
			confirmUnattendedTrading: true,
		});
		expect(runtime.config.mode).toBe("live");
		expect(runtime.config.orderApproval).toBe("unattended");
	});

	it("patches monitor config without replacing the exchange client", async () => {
		const runtime = await TradingRuntime.init({ mode: "paper", exchange: "binance" });
		const oldClose = vi.spyOn(clientOf(runtime), "close");

		await runtime.patchConfig({ monitor: { enabled: false, intervalSec: 15 } });

		expect(oldClose).not.toHaveBeenCalled();
		expect(runtime.config.monitor.enabled).toBe(false);
		expect(runtime.config.monitor.intervalSec).toBe(15);
		expect(runtime.config.monitor.wakeAgent).toBe(true);
		expect((runtime.tradingEngine as unknown as { config: unknown }).config).toEqual(
			expect.objectContaining({ mode: "paper", marketType: "spot", quoteCurrency: "USDT" }),
		);
		expect(stateMocks.saveTradingConfig).toHaveBeenCalledWith(
			expect.objectContaining({
				exchange: "binance",
				monitor: expect.objectContaining({ enabled: false, intervalSec: 15, wakeAgent: true }),
			}),
		);
	});

	it("records manual recovery as a root span allowed by the schema", async () => {
		const telemetryContext = new InMemoryTelemetryContext();
		const runtime = await TradingRuntime.init({ mode: "paper", exchange: "binance" }, undefined, telemetryContext);

		await runtime.recoverExecutions();

		const recovery = telemetryContext.getSpans().filter((span) => span.name === "ti.trading.execution.recovery");
		expect(recovery).toHaveLength(2);
		expect(recovery[1]).toMatchObject({
			parentId: null,
			settled: true,
			status: { status: "ok" },
			attributes: { "ti.trading.examined_count": 0, "ti.trading.unresolved_count": 0 },
		});
		expect(TRADING_TELEMETRY_SCHEMA.spans["ti.trading.execution.recovery"].parents).toEqual({ kind: "any" });
		await runtime.close();
	});

	it("records manual recovery failures without serializing the original error", async () => {
		const telemetryContext = new InMemoryTelemetryContext();
		const runtime = await TradingRuntime.init({ mode: "paper", exchange: "binance" }, undefined, telemetryContext);
		const engine = runtime.tradingEngine as unknown as InstanceType<typeof engineMocks.StubTradingEngine>;
		const error = new Error("credential=secret-recovery-token");
		engine.recoverExecutions.mockRejectedValueOnce(error);

		await expect(runtime.recoverExecutions()).rejects.toBe(error);

		const recovery = telemetryContext.getSpans().filter((span) => span.name === "ti.trading.execution.recovery");
		expect(recovery[1]).toMatchObject({
			parentId: null,
			settled: true,
			status: { status: "error" },
			attributes: { "ti.trading.error_type": "recovery" },
		});
		expect(JSON.stringify(telemetryContext.getSpans())).not.toContain("secret-recovery-token");
		await runtime.close();
	});

	it("records initialization failures with only a safe error category", async () => {
		const telemetryContext = new InMemoryTelemetryContext();
		const error = new Error("credential=secret-init-token");
		engineMocks.setTradingEngineConstructorError(error);

		await expect(
			TradingRuntime.init({ mode: "paper", exchange: "binance" }, undefined, telemetryContext),
		).rejects.toBe(error);

		expect(telemetryContext.getSpans()).toEqual([
			expect.objectContaining({
				name: "ti.trading.runtime.init",
				settled: true,
				status: { status: "error" },
				attributes: expect.objectContaining({ "ti.trading.error_type": "runtime" }),
			}),
		]);
		expect(JSON.stringify(telemetryContext.getSpans())).not.toContain("secret-init-token");
		expect(engineMocks.createdClients[0].close).toHaveBeenCalledOnce();
	});

	it("records replacement failures and preserves the original runtime", async () => {
		const telemetryContext = new InMemoryTelemetryContext();
		const runtime = await TradingRuntime.init({ mode: "paper", exchange: "binance" }, undefined, telemetryContext);
		const original = runtime.tradingEngine;
		const error = new Error("credential=secret-replacement-token");
		engineMocks.setTradingEngineConstructorError(error);

		await expect(runtime.setExchange("bybit")).rejects.toBe(error);

		const replacement = telemetryContext.getSpans().find((span) => span.name === "ti.trading.runtime.replace");
		expect(replacement).toMatchObject({
			parentId: null,
			settled: true,
			status: { status: "error" },
			attributes: { "ti.trading.error_type": "runtime" },
		});
		expect(runtime.tradingEngine).toBe(original);
		expect(JSON.stringify(telemetryContext.getSpans())).not.toContain("secret-replacement-token");
		await runtime.close();
	});

	it("installs risk config on a fresh engine without replacing the client", async () => {
		const runtime = await TradingRuntime.init({ mode: "paper", exchange: "binance" });
		const oldClient = clientOf(runtime);
		const oldEngine = runtime.tradingEngine;

		await runtime.patchConfig({ risk: { maxOrderNotional: 250 } });

		expect(clientOf(runtime)).toBe(oldClient);
		expect(runtime.tradingEngine).not.toBe(oldEngine);
		expect(oldEngine.retireSubmissions).toHaveBeenCalledOnce();
		expect((runtime.tradingEngine as unknown as { config: unknown }).config).toEqual(
			expect.objectContaining({ risk: expect.objectContaining({ maxOrderNotional: 250 }) }),
		);
		expect(
			(runtime.tradingEngine as unknown as { config: { risk: { maxOrderNotional: number } } }).config.risk
				.maxOrderNotional,
		).toBe(250);
	});

	it("rejects an account switch while open orders are present", async () => {
		const runtime = await TradingRuntime.init({ mode: "paper", exchange: "binance" });
		const oldClient = clientOf(runtime);
		oldClient.openOrders.push({} as Order);

		await expect(runtime.patchConfig({ exchange: "bybit" })).rejects.toThrow(/existing orders or positions/);

		expect(runtime.config.exchange).toBe("binance");
		expect(clientOf(runtime)).toBe(oldClient);
	});

	it("rejects an account switch while positions are present", async () => {
		const runtime = await TradingRuntime.init({ mode: "paper", exchange: "binance" });
		const oldClient = clientOf(runtime);
		oldClient.positions.push({} as Position);

		await expect(runtime.patchConfig({ exchange: "bybit" })).rejects.toThrow(/existing orders or positions/);

		expect(runtime.config.exchange).toBe("binance");
		expect(clientOf(runtime)).toBe(oldClient);
	});

	it("rejects an account switch while a risk reservation is unsettled", async () => {
		const runtime = await TradingRuntime.init({ mode: "paper", exchange: "binance" });
		const oldClient = clientOf(runtime);
		(
			runtime.tradingEngine as unknown as { risk: { listPendingReservations: ReturnType<typeof vi.fn> } }
		).risk.listPendingReservations.mockReturnValue([{ id: "reservation-1" }]);

		await expect(runtime.patchConfig({ exchange: "bybit", confirmAccountSwitch: true })).rejects.toThrow(
			/reconcile it with \/risk reconcile/,
		);

		expect(runtime.config.exchange).toBe("binance");
		expect(clientOf(runtime)).toBe(oldClient);
	});

	it("allows an account switch when confirmAccountSwitch is explicit", async () => {
		const runtime = await TradingRuntime.init({ mode: "paper", exchange: "binance" });
		const oldClient = clientOf(runtime);
		oldClient.openOrders.push({} as Order);
		oldClient.positions.push({} as Position);

		await runtime.patchConfig({ exchange: "bybit", confirmAccountSwitch: true });

		expect(runtime.config.exchange).toBe("bybit");
		expect(clientOf(runtime)).not.toBe(oldClient);
		expect(oldClient.close).toHaveBeenCalledTimes(1);
	});

	it("checks both paper account families before switching market type", async () => {
		const runtime = await TradingRuntime.init({ mode: "paper", exchange: "binance" });
		const client = clientOf(runtime);
		vi.spyOn(client, "hasAnyAccountExposure").mockResolvedValueOnce(true);

		await expect(runtime.setMarketType("usdm-futures")).rejects.toThrow(/hide existing orders or positions/);
		expect(runtime.config.marketType).toBe("spot");
		expect(engineMocks.createdClients).toHaveLength(1);
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

	it("keeps the old runtime and closes the replacement client when engine initialization fails", async () => {
		const runtime = await TradingRuntime.init({ mode: "paper", exchange: "binance" });
		const oldClient = clientOf(runtime);
		const engineError = new Error("risk state is corrupted");
		engineMocks.setTradingEngineConstructorError(engineError);

		await expect(runtime.setExchange("bybit")).rejects.toBe(engineError);

		expect(runtime.config.exchange).toBe("binance");
		expect(clientOf(runtime)).toBe(oldClient);
		expect(oldClient.close).not.toHaveBeenCalled();
		expect(stateMocks.saveTradingConfig).not.toHaveBeenCalled();
		const replacementClient = engineMocks.createdClients[1];
		expect(replacementClient).toBeDefined();
		expect(replacementClient.close).toHaveBeenCalledTimes(1);
	});

	it("replaces the paper client when its fee rate changes", async () => {
		const runtime = await TradingRuntime.init({ mode: "paper", exchange: "binance" });
		const oldClient = clientOf(runtime);

		await runtime.patchConfig({ paper: { feeRate: 0.002 } });

		expect(clientOf(runtime)).not.toBe(oldClient);
		expect(oldClient.close).toHaveBeenCalledTimes(1);
		expect(runtime.config.paper.feeRate).toBe(0.002);
	});

	it("blocks a paper fee-rate change while a position is open", async () => {
		const runtime = await TradingRuntime.init({ mode: "paper", exchange: "binance" });
		const client = clientOf(runtime);
		client.positions.push({ symbol: "BTC/USDT", asset: "BTC", amount: 1, quoteValue: 100 });

		await expect(runtime.patchConfig({ paper: { feeRate: 0.002 } })).rejects.toThrow(
			/open orders, positions, or unsettled risk reservations/,
		);
		expect(clientOf(runtime)).toBe(client);
		expect(client.close).not.toHaveBeenCalled();
	});
});
