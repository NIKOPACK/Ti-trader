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
		positionMode: "one-way" as const,
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
			positionMode: "one-way" as const,
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
				positionMode: "one-way",
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
			positionMode: "one-way" as const,
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
						positionMode: "one-way",
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
			positionMode: "one-way" as const,
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
				positionMode: "one-way",
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
