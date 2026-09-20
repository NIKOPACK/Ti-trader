import type { RiskSupervisionReport } from "@nikopack/ti-trading-engine";
import { type Condition, evaluateCondition } from "@nikopack/ti-triggers";
import { describe, expect, it, vi } from "vitest";
import type { AutonomousConfig } from "../autonomous/config.ts";
import { AutonomousRuntime } from "../autonomous/runtime.ts";
import { AutonomousStore } from "../autonomous/state.ts";
import { createMemoryMonitoringStore } from "../monitoring-state.ts";
import { prepareTriggerFacts } from "../trigger-facts.ts";

const NOW = Date.parse("2026-01-01T00:00:00Z");
const config: AutonomousConfig = {
	enabled: true,
	mode: "paper",
	exchange: "binance",
	marketType: "spot",
	quoteCurrency: "USDT",
	objective: "Fixture only",
	provider: "fixture",
	model: "fixture",
	pollIntervalMs: 5000,
	modelTimeoutMs: 1000,
	serviceTimeoutMs: 1000,
	maxAttempts: 2,
	retryBaseMs: 100,
	retryMaxMs: 1000,
	protectionAttempts: 2,
	services: [],
};

describe("autonomous trigger history integration", () => {
	it("shares window history with ordinary monitors and restores it after runtime restart", async () => {
		let now = NOW;
		let price = 100;
		let tickerTime: number | undefined;
		const store = createMemoryMonitoringStore();
		const state = new AutonomousStore(
			store,
			{
				mode: "paper",
				exchange: "binance",
				marketType: "spot",
				quoteCurrency: "USDT",
				accountId: "fixture",
			},
			() => now,
		);
		state.mutate((state) => {
			state.control = "paused";
		});
		const condition: Condition = {
			kind: "change",
			fact: { key: "price:BTC/USDT" },
			windowSec: 60,
			operator: "gte",
			value: 10,
			unit: "percent",
		};
		state.schedule({
			id: "window",
			name: "window",
			when: condition,
			// biome-ignore lint/suspicious/noThenProperty: public trigger action field.
			then: { kind: "wake_agent", message: "review" },
			policy: { mode: "once" },
		});
		const model = { run: vi.fn(async () => "No trade."), stop: vi.fn(async () => {}) };
		const dependencies = {
			state,
			config,
			model,
			supervise: async (): Promise<RiskSupervisionReport> => ({ at: now, reasons: [], actions: [] }),
			ticker: async () => ({ last: price, timestamp: tickerTime ?? now }),
			block: vi.fn(),
			recover: async () => {},
			now: () => now,
		};
		const first = new AutonomousRuntime(dependencies);
		await first.initialize();
		await first.tick();
		now += 5000;
		price = 110;
		await first.tick();
		expect(state.read().events).toEqual([]);
		expect(store.read().scopes[0].factHistory?.[0].samples).toEqual([{ value: 100, observedAt: NOW }]);
		await first.stop();
		// The interactive path must not shorten history needed by an autonomous wake.
		for (now = NOW + 10_000; now < NOW + 60_000; now += 5000) {
			store.transact((root) => {
				prepareTriggerFacts(root.scopes[0], { "price:BTC/USDT": { value: 110, observedAt: now } }, now, 300_000);
			});
		}
		price = 120;
		const restarted = new AutonomousRuntime(dependencies);
		await restarted.initialize();
		await restarted.tick();
		expect(state.read().events).toMatchObject([{ kind: "condition", message: "review" }]);
		expect(store.read().scopes[0].triggers[0].state.status).toBe("fired");
		state.schedule({
			id: "repeat",
			name: "repeat",
			when: { kind: "compare", fact: { key: "price:BTC/USDT" }, operator: "gt", value: 100 },
			// biome-ignore lint/suspicious/noThenProperty: public trigger action field.
			then: { kind: "wake_agent", message: "repeat" },
			policy: { mode: "while_true" },
		});
		now += 5000;
		tickerTime = now;
		await restarted.tick();
		expect(state.read().events).toHaveLength(2);
		now += 5000;
		await restarted.tick();
		expect(state.read().events).toHaveLength(2);
		expect(model.run).not.toHaveBeenCalled();
		await restarted.stop();
	});

	it("accepts explicit hedge-side futures wake facts", () => {
		const state = new AutonomousStore(
			createMemoryMonitoringStore(),
			{
				mode: "paper",
				exchange: "binance",
				marketType: "usdm-futures",
				quoteCurrency: "USDT",
				accountId: "fixture",
			},
			() => NOW,
		);
		state.mutate((current) => {
			current.control = "paused";
		});
		expect(() =>
			state.schedule({
				id: "side",
				name: "side",
				when: { kind: "compare", fact: { key: "position_pnl_pct:BTC/USDT:USDT:LONG" }, operator: "lt", value: -2 },
				// biome-ignore lint/suspicious/noThenProperty: public trigger action field.
				then: { kind: "notify", message: "review" },
			}),
		).not.toThrow();
		expect(
			evaluateCondition(
				state.store.read().scopes[0].triggers[0].definition.when,
				{ "position_pnl_pct:BTC/USDT:USDT:LONG": { value: -3, observedAt: NOW } },
				NOW,
			).state,
		).toBe("true");
	});
});
