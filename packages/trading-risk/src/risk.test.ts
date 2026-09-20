import { describe, expect, it } from "vitest";
import { RiskCommitError, RiskLedger, RiskReservationStateError, type TradingRiskState } from "./risk.ts";

function ledger(mode: "paper" | "live" = "paper", initial = 0, date = "2026-01-01") {
	let state: TradingRiskState = {
		paper: { date, usedDailyNotional: initial },
		live: { date, usedDailyNotional: initial },
	};
	const store = {
		load: () => structuredClone(state),
		save: (next: TradingRiskState) => {
			state = structuredClone(next);
		},
		transact: <T>(mutator: (next: TradingRiskState) => T): T => {
			const next = structuredClone(state);
			const result = mutator(next);
			state = structuredClone(next);
			return result;
		},
	};
	const config = {
		mode,
		marketType: "spot" as const,
		quoteCurrency: "USDT",
		risk: { maxOrderNotional: 500, maxDailyNotional: 1_000, allowedSymbols: [] },
	};
	return { risk: new RiskLedger(config, store, { now: () => new Date("2026-01-01T00:00:00Z") }), state: () => state };
}

describe("RiskLedger", () => {
	it("reserves quota and commits exactly once", () => {
		const { risk, state } = ledger();
		const reservation = risk.reserve("BTC/USDT", 400);
		expect(reservation.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(risk.usage()).toMatchObject({ used: 0, reserved: 400 });
		reservation.commit();
		reservation.commit();
		expect(state().paper.usedDailyNotional).toBe(400);
		expect(risk.usage().reserved).toBe(0);
		expect(risk.listPendingReservations()).toEqual([]);
	});

	it("does not count protective reservations toward daily quota", () => {
		const { risk } = ledger("paper", 900);
		expect(risk.check("BTC/USDT", 100, { countTowardsDailyLimit: false })).toBeNull();
		const reservation = risk.reserve("BTC/USDT", 100, { countTowardsDailyLimit: false });
		reservation.commit();
		expect(risk.usage()).toMatchObject({ used: 900, reserved: 0 });
	});

	it("rolls live counters over using the injected clock", () => {
		const { risk, state } = ledger("live", 200, "2025-12-31");
		expect(risk.usage()).toMatchObject({ date: "2026-01-01", used: 0 });
		expect(state().live.usedDailyNotional).toBe(0);
	});

	it("does not oversubscribe a shared daily quota across ledger instances", () => {
		let state: TradingRiskState = {
			paper: { date: "2026-01-01", usedDailyNotional: 0 },
			live: { date: "2026-01-01", usedDailyNotional: 0 },
		};
		const store = {
			load: () => structuredClone(state),
			save: (next: TradingRiskState) => {
				state = structuredClone(next);
			},
			transact: <T>(mutator: (next: TradingRiskState) => T): T => {
				const next = structuredClone(state);
				const result = mutator(next);
				state = structuredClone(next);
				return result;
			},
		};
		const config = {
			mode: "paper" as const,
			marketType: "spot" as const,
			quoteCurrency: "USDT",
			risk: { maxOrderNotional: 500, maxDailyNotional: 500, allowedSymbols: [] },
		};
		const first = new RiskLedger(config, store, { now: () => new Date("2026-01-01T00:00:00Z") });
		const second = new RiskLedger(config, store, { now: () => new Date("2026-01-01T00:00:00Z") });

		first.reserve("BTC/USDT", 400);

		expect(() => second.reserve("BTC/USDT", 200)).toThrow(/maxDailyNotional/);
		expect(state.paper.usedDailyNotional).toBe(0);
		expect(state.paper.reservedDailyNotional).toBe(400);
	});

	it("persists reservation identities and reconciles using the persisted notional", () => {
		const first = ledger();
		const reservation = first.risk.reserve("BTC/USDT", 125);
		expect(first.risk.listPendingReservations()).toEqual([
			{ id: reservation.id, mode: "paper", symbol: "BTC/USDT", notional: 125 },
		]);

		const second = new RiskLedger(
			{
				mode: "paper",
				marketType: "spot",
				quoteCurrency: "USDT",
				risk: { maxOrderNotional: 500, maxDailyNotional: 1_000, allowedSymbols: [] },
			},
			{
				load: () => structuredClone(first.state()),
				save: (next) => Object.assign(first, { state: () => structuredClone(next) }),
				transact: (mutator) => {
					const next = structuredClone(first.state());
					const result = mutator(next);
					Object.assign(first, { state: () => structuredClone(next) });
					return result;
				},
			},
			{ now: () => new Date("2026-01-01T00:00:00Z") },
		);
		second.reconcileReservation(reservation.id, "release");
		expect(second.listPendingReservations()).toEqual([]);
		expect(second.usage()).toMatchObject({ used: 0, reserved: 0 });
	});

	it("rejects invalid recorded notionals", () => {
		const { risk } = ledger();
		for (const notional of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			expect(() => risk.record(notional)).toThrow(/non-negative finite/);
		}
	});

	it("rejects non-finite risk limits before loading state", () => {
		const base = {
			mode: "paper" as const,
			marketType: "spot" as const,
			quoteCurrency: "USDT",
			risk: { maxOrderNotional: 500, maxDailyNotional: 1_000, allowedSymbols: [] },
		};
		const store = {
			load: () => ({
				paper: { date: "2026-01-01", usedDailyNotional: 0 },
				live: { date: "2026-01-01", usedDailyNotional: 0 },
			}),
			save: () => {},
			transact: <T>(_mutator: (next: TradingRiskState) => T): T => {
				throw new Error("not reached");
			},
		};
		for (const field of ["maxOrderNotional", "maxDailyNotional"] as const) {
			for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
				expect(() => new RiskLedger({ ...base, risk: { ...base.risk, [field]: value } }, store)).toThrow(
					new RegExp(`${field}.*finite`),
				);
			}
		}
	});

	it("fails closed when the state store has no atomic transaction", () => {
		let state: TradingRiskState = {
			paper: { date: "2026-01-01", usedDailyNotional: 0 },
			live: { date: "2026-01-01", usedDailyNotional: 0 },
		};
		const store = {
			load: () => state,
			save: (next: TradingRiskState) => {
				state = next;
			},
		};
		expect(
			() =>
				new RiskLedger(
					{
						mode: "paper",
						marketType: "spot",
						quoteCurrency: "USDT",
						risk: { maxOrderNotional: 500, maxDailyNotional: 1_000, allowedSymbols: [] },
					},
					store,
				),
		).toThrow(/must implement transact/);
		expect(state.paper.usedDailyNotional).toBe(0);
	});

	it("rejects arithmetic overflow without publishing a draft", () => {
		const { risk, state } = ledger("paper", Number.MAX_VALUE);
		const before = structuredClone(state());
		expect(() => risk.record(Number.MAX_VALUE)).toThrow(RiskReservationStateError);
		expect(state()).toEqual(before);
	});

	it("normalizes tiny floating-point reservation residuals to zero", () => {
		const { risk } = ledger();
		const first = risk.reserve("BTC/USDT", 0.1);
		const second = risk.reserve("BTC/USDT", 0.2);
		first.release();
		second.release();
		expect(risk.usage()).toMatchObject({ reserved: 0 });
	});

	it("classifies unknown and already-settled reservation ids as state errors", () => {
		const { risk } = ledger();
		expect(() => risk.reconcileReservation("missing", "commit")).toThrow(RiskReservationStateError);
		const reservation = risk.reserve("BTC/USDT", 100);
		reservation.commit();
		expect(() => risk.reconcileReservation(reservation.id, "release")).toThrow(RiskReservationStateError);
	});

	it("marks a commit persistence failure as an unknown submission and keeps the claim", () => {
		let state: TradingRiskState = {
			paper: { date: "2026-01-01", usedDailyNotional: 0 },
			live: { date: "2026-01-01", usedDailyNotional: 0 },
		};
		let saves = 0;
		const store = {
			load: () => structuredClone(state),
			save: (next: TradingRiskState) => {
				saves += 1;
				if (saves === 2) throw new Error("disk full");
				state = structuredClone(next);
			},
			transact: <T>(mutator: (next: TradingRiskState) => T): T => {
				const next = structuredClone(state);
				const result = mutator(next);
				// The second transaction is the post-submission settlement. Make the
				// persistence failure observable while leaving the old claim intact.
				store.save(next);
				state = structuredClone(next);
				return result;
			},
		};
		const config = {
			mode: "paper" as const,
			marketType: "spot" as const,
			quoteCurrency: "USDT",
			risk: { maxOrderNotional: 500, maxDailyNotional: 1_000, allowedSymbols: [] },
		};
		const risk = new RiskLedger(config, store, { now: () => new Date("2026-01-01T00:00:00Z") });
		const reservation = risk.reserve("BTC/USDT", 100);

		let failure: unknown;
		try {
			reservation.commit();
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(RiskCommitError);
		expect(failure).toMatchObject({
			submissionStatus: "unknown",
			retryable: false,
			errorCategory: "RISK_SETTLEMENT_PERSISTENCE",
			reconciliation: { reservationId: reservation.id, symbol: "BTC/USDT", mode: "paper", notional: 100 },
		});
		expect(state.paper).toMatchObject({ usedDailyNotional: 0, reservedDailyNotional: 100 });
		expect(state.paper.reservations?.[reservation.id]).toMatchObject({ id: reservation.id, notional: 100 });
		expect(risk.usage()).toMatchObject({ used: 0, reserved: 100 });
	});

	it("does not publish a failed mutator", () => {
		let state: TradingRiskState = {
			paper: { date: "2026-01-01", usedDailyNotional: 0 },
			live: { date: "2026-01-01", usedDailyNotional: 0 },
		};
		const store = {
			load: () => structuredClone(state),
			save: (next: TradingRiskState) => {
				state = structuredClone(next);
			},
			transact: <T>(mutator: (next: TradingRiskState) => T): T => {
				const next = structuredClone(state);
				const result = mutator(next);
				state = structuredClone(next);
				return result;
			},
		};
		const risk = new RiskLedger(
			{
				mode: "paper",
				marketType: "spot",
				quoteCurrency: "USDT",
				risk: { maxOrderNotional: 500, maxDailyNotional: 1_000, allowedSymbols: [] },
			},
			store,
		);
		const before = structuredClone(state);
		expect(() =>
			store.transact((draft) => {
				draft.paper.usedDailyNotional = 123;
				throw new Error("mutator failed");
			}),
		).toThrow("mutator failed");
		expect(state).toEqual(before);
		expect(risk.usage().used).toBe(0);
	});
});

describe("RiskLedger leftover pause metadata", () => {
	function sharedLedgers() {
		let state: TradingRiskState = {
			paper: { date: "2026-01-01", usedDailyNotional: 200, reservedDailyNotional: 0, reservations: {} },
			live: { date: "2026-01-01", usedDailyNotional: 300, reservedDailyNotional: 0, reservations: {} },
		};
		let now = new Date("2026-01-01T00:00:00Z");
		const store = {
			load: () => state,
			save: (next: TradingRiskState) => {
				state = next;
			},
			transact: <T>(mutator: (next: TradingRiskState) => T): T => {
				const next = structuredClone(state);
				const result = mutator(next);
				store.save(next);
				return result;
			},
		};
		return {
			store,
			state: () => state,
			setNow: (value: Date) => {
				now = value;
			},
			createLedger: (mode: "paper" | "live" = "paper", allowedSymbols: string[] = []) =>
				new RiskLedger(
					{
						mode,
						marketType: "spot",
						quoteCurrency: "USDT",
						risk: { maxOrderNotional: 500, maxDailyNotional: 1_000, allowedSymbols },
					},
					store,
					{ now: () => now },
				),
		};
	}

	it("ignores leftover pause records and drops them on the next write", () => {
		const shared = sharedLedgers();
		Object.assign(shared.state().paper as unknown as Record<string, unknown>, {
			newExposurePause: {
				id: "pause-1",
				reason: "upgrade to ti-trader 0.2.1",
				pausedAt: "2026-01-01T00:00:00.000Z",
			},
		});
		const risk = shared.createLedger();
		expect(risk.check("BTC/USDT", 100)).toBeNull();
		expect(() => risk.assertNewExposureAllowed()).not.toThrow();
		expect(risk.usage()).toEqual({
			date: "2026-01-01",
			used: 200,
			reserved: 0,
			limit: 1_000,
			resetPolicy: "manual",
		});
		risk.record(10);
		expect(shared.state().paper).toEqual({
			date: "2026-01-01",
			usedDailyNotional: 210,
			reservedDailyNotional: 0,
			reservations: {},
		});
	});

	it.each([
		null,
		[],
		{},
		{ reason: "Review", pausedAt: "2026-01-01T00:00:00.000Z" },
		{ id: "pause", reason: "Review", pausedAt: "not-a-date" },
	])("drops invalid leftover pause metadata %#", (pause) => {
		const shared = sharedLedgers();
		Object.assign(shared.state().paper as unknown as Record<string, unknown>, { newExposurePause: pause });
		const risk = shared.createLedger();
		expect(risk.check("BTC/USDT", 100)).toBeNull();
		risk.record(1);
		expect((shared.state().paper as unknown as Record<string, unknown>).newExposurePause).toBeUndefined();
	});

	it("allows engine-verified reductions despite opening limits while retaining symbol and numeric validation", () => {
		const shared = sharedLedgers();
		const risk = shared.createLedger("paper", ["BTC/USDT"]);
		risk.record(800);
		const options = { countTowardsDailyLimit: false };

		expect(risk.check("BTC/USDT", 100, options)).toBeNull();
		risk.reserve("BTC/USDT", 100, options).commit();
		risk.reserve("BTC/USDT", 100, options).release();
		for (const [symbol, notional] of [
			["ETH/USDT", 100],
			["BTC/USDT", 501],
		] as const) {
			expect(risk.check(symbol, notional, options)).toBeNull();
			risk.reserve(symbol, notional, options).commit();
		}
		for (const [symbol, notional, error] of [
			["BTC/USDC", 100, /quote currency/],
			["BTC/USDT", 0, /positive finite/],
			["BTC/USDT", Number.NaN, /positive finite/],
			["BTC/USDT", Number.POSITIVE_INFINITY, /positive finite/],
		] as const) {
			expect(risk.check(symbol, notional, options)).toMatch(error);
			expect(() => risk.reserve(symbol, notional, options)).toThrow(error);
		}
		expect(risk.usage()).toMatchObject({ used: 1_000, reserved: 0 });
		expect(risk.listPendingReservations()).toEqual([]);
	});

	it.each([new Date(Number.NaN), "2026-01-01" as unknown as Date])("rejects an invalid risk clock", (now) => {
		const shared = sharedLedgers();
		const risk = shared.createLedger("live");
		const before = structuredClone(shared.state());
		shared.setNow(now);
		expect(() => risk.usage()).toThrow(/invalid date/);
		expect(shared.state()).toEqual(before);
	});

	it("does not use cached state when a fresh read fails", () => {
		const shared = sharedLedgers();
		const risk = shared.createLedger();
		shared.store.load = () => {
			throw new Error("state read failed");
		};
		expect(() => risk.assertNewExposureAllowed()).toThrow("state read failed");
		expect(() => risk.check("BTC/USDT", 100)).toThrow("state read failed");
		expect(() => risk.usage()).toThrow("state read failed");
	});
});

describe("RiskLedger allowedSymbols", () => {
	function store() {
		let state: TradingRiskState = {
			paper: { date: "2026-01-01", usedDailyNotional: 0 },
			live: { date: "2026-01-01", usedDailyNotional: 0 },
		};
		return {
			load: () => structuredClone(state),
			save: (next: TradingRiskState) => {
				state = structuredClone(next);
			},
			transact: <T>(mutator: (next: TradingRiskState) => T): T => {
				const next = structuredClone(state);
				const result = mutator(next);
				state = structuredClone(next);
				return result;
			},
		};
	}

	const base = {
		mode: "paper" as const,
		quoteCurrency: "USDT",
		risk: { maxOrderNotional: 500, maxDailyNotional: 1_000, allowedSymbols: [] as string[] },
	};

	it("accepts an empty allowlist", () => {
		expect(
			() => new RiskLedger({ ...base, marketType: "spot", risk: { ...base.risk, allowedSymbols: [] } }, store()),
		).not.toThrow();
	});

	it("accepts matching spot and futures symbols", () => {
		expect(
			() =>
				new RiskLedger(
					{ ...base, marketType: "spot", risk: { ...base.risk, allowedSymbols: ["BTC/USDT"] } },
					store(),
				),
		).not.toThrow();
		expect(
			() =>
				new RiskLedger(
					{ ...base, marketType: "usdm-futures", risk: { ...base.risk, allowedSymbols: ["BTC/USDT:USDT"] } },
					store(),
				),
		).not.toThrow();
		expect(
			() =>
				new RiskLedger(
					{
						...base,
						marketType: "both",
						risk: { ...base.risk, allowedSymbols: ["BTC/USDT", "ETH/USDT:USDT"] },
					},
					store(),
				),
		).not.toThrow();
	});

	it("rejects symbols that do not match the quote and market family", () => {
		expect(
			() =>
				new RiskLedger(
					{ ...base, marketType: "spot", risk: { ...base.risk, allowedSymbols: ["BTC/USDT:USDT"] } },
					store(),
				),
		).toThrow(/risk.allowedSymbols must contain USDT symbols/);
		expect(
			() =>
				new RiskLedger(
					{ ...base, marketType: "usdm-futures", risk: { ...base.risk, allowedSymbols: ["BTC/USDT"] } },
					store(),
				),
		).toThrow(/risk.allowedSymbols must contain USDT symbols/);
		expect(
			() =>
				new RiskLedger(
					{ ...base, marketType: "spot", risk: { ...base.risk, allowedSymbols: ["BTC/USDC"] } },
					store(),
				),
		).toThrow(/risk.allowedSymbols must contain USDT symbols/);
	});
});
