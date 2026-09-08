import { describe, expect, it } from "vitest";
import {
	RiskCommitError,
	RiskLedger,
	RiskReservationStateError,
	RiskStatePersistenceError,
	type TradingRiskState,
} from "./risk.ts";

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

describe("RiskLedger new exposure pause", () => {
	function sharedLedgers() {
		let state: TradingRiskState = {
			paper: { date: "2026-01-01", usedDailyNotional: 200, reservedDailyNotional: 0, reservations: {} },
			live: { date: "2026-01-01", usedDailyNotional: 300, reservedDailyNotional: 0, reservations: {} },
		};
		let now = new Date("2026-01-01T00:00:00Z");
		let failWrites = false;
		let transactions = 0;
		const store = {
			load: () => state,
			save: (next: TradingRiskState) => {
				if (failWrites) throw new Error("disk full");
				state = next;
			},
			transact: <T>(mutator: (next: TradingRiskState) => T): T => {
				transactions += 1;
				const next = structuredClone(state);
				const result = mutator(next);
				store.save(next);
				return result;
			},
		};
		return {
			store,
			state: () => state,
			transactions: () => transactions,
			setNow: (value: Date) => {
				now = value;
			},
			setWriteFailure: (value: boolean) => {
				failWrites = value;
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

	it("persists one pause across existing and reconstructed ledgers without changing quota or claims", () => {
		const shared = sharedLedgers();
		const first = shared.createLedger();
		const second = shared.createLedger();
		first.reserve("BTC/USDT", 100);
		const before = structuredClone(shared.state());
		const transactions = shared.transactions();

		const pause = first.pauseNewExposure("  Verify exchange balances  ");

		expect(shared.transactions()).toBe(transactions + 1);
		expect(pause).toEqual({
			id: expect.stringMatching(/^[0-9a-f-]{36}$/),
			reason: "Verify exchange balances",
			pausedAt: "2026-01-01T00:00:00.000Z",
		});
		expect(shared.state()).toEqual({
			...before,
			paper: { ...before.paper, newExposurePause: pause },
			audit: { version: 1, events: [expect.objectContaining({ kind: "risk-pause", mode: "paper" })] },
		});
		for (const risk of [first, second, shared.createLedger()]) {
			expect(risk.usage().newExposurePause).toEqual(pause);
			expect(() => risk.assertNewExposureAllowed()).toThrow("New exposure is paused: Verify exchange balances");
			expect(risk.check("BTC/USDT", 100)).toBe("New exposure is paused: Verify exchange balances");
			expect(() => risk.reserve("BTC/USDT", 100)).toThrow("New exposure is paused: Verify exchange balances");
		}
	});

	it("checks the pause inside the atomic reservation transaction", () => {
		const shared = sharedLedgers();
		const first = shared.createLedger();
		const second = shared.createLedger();
		expect(second.check("BTC/USDT", 100)).toBeNull();
		const transact = shared.store.transact;
		let pauseBeforeReservation = true;
		shared.store.transact = <T>(mutator: (next: TradingRiskState) => T): T => {
			if (pauseBeforeReservation) {
				pauseBeforeReservation = false;
				first.pauseNewExposure("Concurrent pause");
			}
			return transact(mutator);
		};

		expect(() => second.reserve("BTC/USDT", 100)).toThrow("New exposure is paused: Concurrent pause");
		expect(second.usage()).toMatchObject({ used: 200, reserved: 0 });
		expect(second.listPendingReservations()).toEqual([]);
	});

	it("allows protective orders during a pause while retaining all non-daily validations", () => {
		const shared = sharedLedgers();
		const risk = shared.createLedger("paper", ["BTC/USDT"]);
		risk.record(800);
		const pause = risk.pauseNewExposure("Investigating");
		const options = { countTowardsDailyLimit: false };

		expect(risk.check("BTC/USDT", 100, options)).toBeNull();
		risk.reserve("BTC/USDT", 100, options).commit();
		risk.reserve("BTC/USDT", 100, options).release();
		for (const [symbol, notional, error] of [
			["BTC/USDC", 100, /quote currency/],
			["ETH/USDT", 100, /allowedSymbols/],
			["BTC/USDT", 501, /maxOrderNotional/],
			["BTC/USDT", 0, /positive finite/],
			["BTC/USDT", Number.NaN, /positive finite/],
			["BTC/USDT", Number.POSITIVE_INFINITY, /positive finite/],
		] as const) {
			expect(risk.check(symbol, notional, options)).toMatch(error);
			expect(() => risk.reserve(symbol, notional, options)).toThrow(error);
		}
		expect(risk.usage()).toMatchObject({ used: 1_000, reserved: 0, newExposurePause: pause });
		expect(risk.listPendingReservations()).toEqual([]);
		risk.resumeNewExposure(pause.id);
		expect(risk.usage()).toMatchObject({ used: 1_000, reserved: 0, newExposurePause: undefined });
	});

	it("permits recording and settlement of older claims without clearing the pause", () => {
		const { createLedger } = sharedLedgers();
		const risk = createLedger();
		const committed = risk.reserve("BTC/USDT", 100);
		const released = risk.reserve("BTC/USDT", 50);
		const reconciledCommit = risk.reserve("BTC/USDT", 25);
		const reconciledRelease = risk.reserve("BTC/USDT", 30);
		const pause = risk.pauseNewExposure("Settle previous submissions");

		risk.record(10);
		committed.commit(80);
		released.release();
		risk.reconcileReservation(reconciledCommit.id, "commit", 20);
		risk.reconcileReservation(reconciledRelease.id, "release");

		expect(risk.usage()).toMatchObject({ used: 310, reserved: 0, newExposurePause: pause });
		risk.resumeNewExposure(pause.id);
		expect(risk.usage()).toMatchObject({ used: 310, reserved: 0, newExposurePause: undefined });
	});

	it.each(["paper", "live"] as const)("retains the %s pause when resetting quota", (mode) => {
		const shared = sharedLedgers();
		const risk = shared.createLedger(mode);
		const pause = risk.pauseNewExposure("Manual review");
		risk.reset();
		expect(risk.usage()).toMatchObject({ used: 0, reserved: 0, newExposurePause: pause });
		expect(shared.createLedger(mode).check("BTC/USDT", 100)).toContain("New exposure is paused");
	});

	it("does not roll live quota over just to pause or resume", () => {
		const shared = sharedLedgers();
		const risk = shared.createLedger("live");
		shared.setNow(new Date("2026-01-02T00:00:00Z"));
		const before = structuredClone(shared.state());

		const pause = risk.pauseNewExposure("Review at midnight");
		expect(shared.state()).toMatchObject({ ...before, live: { ...before.live, newExposurePause: pause } });
		risk.resumeNewExposure(pause.id);
		expect(shared.state()).toMatchObject(before);
		expect(shared.state().live.newExposurePause).toBeUndefined();
		expect(shared.state().audit?.events.map((event) => event.kind)).toEqual(["risk-pause", "risk-resume"]);
	});

	it("carries the live pause and pending claims across UTC midnight", () => {
		const shared = sharedLedgers();
		shared.setNow(new Date("2026-01-02T00:59:59+01:00"));
		const risk = shared.createLedger("live");
		const claim = risk.reserve("BTC/USDT", 100);
		const pause = risk.pauseNewExposure("Review before midnight");
		expect(pause.pausedAt).toBe("2026-01-01T23:59:59.000Z");
		shared.setNow(new Date("2026-01-02T01:00:00+01:00"));

		expect(risk.usage()).toMatchObject({
			date: "2026-01-02",
			used: 0,
			reserved: 100,
			newExposurePause: pause,
		});
		expect(() => risk.resumeNewExposure(pause.id)).toThrow(/reservations are in flight/);
		claim.commit(75);
		expect(risk.usage()).toMatchObject({ used: 75, reserved: 0, newExposurePause: pause });
		expect(shared.createLedger("live").usage().newExposurePause).toEqual(pause);
	});

	it("isolates pauses and resume prerequisites by mode", () => {
		const shared = sharedLedgers();
		const paper = shared.createLedger();
		const live = shared.createLedger("live");
		const paperPause = paper.pauseNewExposure("Paper review");
		expect(() => live.assertNewExposureAllowed()).not.toThrow();
		expect(live.check("BTC/USDT", 100)).toBeNull();
		const liveClaim = live.reserve("BTC/USDT", 100);
		const livePause = live.pauseNewExposure("Live review");

		paper.resumeNewExposure(paperPause.id);
		expect(paper.usage().newExposurePause).toBeUndefined();
		expect(() => paper.assertNewExposureAllowed()).not.toThrow();
		expect(live.usage().newExposurePause).toEqual(livePause);
		expect(() => live.resumeNewExposure(livePause.id)).toThrow(/reservations are in flight/);
		liveClaim.release();
		live.resumeNewExposure(livePause.id);
		expect(live.usage()).toMatchObject({ used: 300, reserved: 0, newExposurePause: undefined });
	});

	it("rejects missing, empty, wrong, and superseded pause ids", () => {
		const shared = sharedLedgers();
		const first = shared.createLedger();
		const second = shared.createLedger();
		expect(() => first.resumeNewExposure("missing")).toThrow(/not paused/);
		const pause = first.pauseNewExposure("Initial review");
		for (const id of ["", " \t", "wrong-id"]) {
			expect(() => second.resumeNewExposure(id)).toThrow(/pause id/);
			expect(second.usage().newExposurePause).toEqual(pause);
		}
		const replacement = first.pauseNewExposure("Updated review");
		expect(replacement.id).not.toBe(pause.id);
		expect(() => second.resumeNewExposure(pause.id)).toThrow(/does not match/);
		expect(second.usage().newExposurePause).toEqual(replacement);

		const before = structuredClone(shared.state());
		second.resumeNewExposure(replacement.id);
		delete before.paper.newExposurePause;
		expect(shared.state().paper).toEqual(before.paper);
		expect(shared.state().live).toEqual(before.live);
		expect(shared.state().audit?.events.at(-1)?.kind).toBe("risk-resume");
		expect(first.usage().newExposurePause).toBeUndefined();
		expect(first.check("BTC/USDT", 100)).toBeNull();
		first.reserve("BTC/USDT", 100).release();
	});

	it("cannot clear a new pause created during an older confirmation", () => {
		const shared = sharedLedgers();
		const first = shared.createLedger();
		const second = shared.createLedger();
		const pause = first.pauseNewExposure("Initial pause");
		const transact = shared.store.transact;
		let pauseBeforeResume = true;
		shared.store.transact = <T>(mutator: (next: TradingRiskState) => T): T => {
			if (pauseBeforeResume) {
				pauseBeforeResume = false;
				first.pauseNewExposure("Concurrent replacement");
			}
			return transact(mutator);
		};

		expect(() => second.resumeNewExposure(pause.id)).toThrow(/does not match/);
		expect(second.usage().newExposurePause?.reason).toBe("Concurrent replacement");
	});

	it("requires settlement before resuming and preserves used quota afterwards", () => {
		const shared = sharedLedgers();
		const first = shared.createLedger();
		const claim = first.reserve("BTC/USDT", 100);
		const pause = first.pauseNewExposure("Uncertain submission");
		const restarted = shared.createLedger();
		const before = structuredClone(shared.state());

		expect(() => restarted.resumeNewExposure(pause.id)).toThrow(/reservations are in flight/);
		expect(shared.state()).toEqual(before);
		restarted.reconcileReservation(claim.id, "commit");
		restarted.resumeNewExposure(pause.id);
		expect(first.usage()).toMatchObject({ used: 300, reserved: 0, newExposurePause: undefined });
	});

	it.each(["", " \n\t ", "x".repeat(501)])("rejects invalid pause reasons", (reason) => {
		const shared = sharedLedgers();
		const risk = shared.createLedger();
		const before = structuredClone(shared.state());
		expect(() => risk.pauseNewExposure(reason)).toThrow(/reason.*1 to 500/);
		expect(shared.transactions()).toBe(0);
		expect(shared.state()).toEqual(before);
	});

	it("accepts a trimmed reason of exactly 500 characters", () => {
		const { createLedger } = sharedLedgers();
		const risk = createLedger();
		expect(risk.pauseNewExposure(` ${"x".repeat(500)} `).reason).toBe("x".repeat(500));
	});

	it.each([new Date(Number.NaN), "2026-01-01" as unknown as Date])("rejects an invalid risk clock", (now) => {
		const shared = sharedLedgers();
		const risk = shared.createLedger();
		const before = structuredClone(shared.state());
		shared.setNow(now);
		expect(() => risk.pauseNewExposure("Review")).toThrow(/invalid date/);
		expect(shared.state()).toEqual(before);
		expect(risk.usage().newExposurePause).toBeUndefined();
	});

	it.each([
		null,
		[],
		{},
		{ reason: "Review", pausedAt: "2026-01-01T00:00:00.000Z" },
		{ id: " ", reason: "Review", pausedAt: "2026-01-01T00:00:00.000Z" },
		{ id: "pause", reason: "", pausedAt: "2026-01-01T00:00:00.000Z" },
		{ id: "pause", reason: " \t", pausedAt: "2026-01-01T00:00:00.000Z" },
		{ id: "pause", reason: 123, pausedAt: "2026-01-01T00:00:00.000Z" },
		{ id: "pause", reason: "x".repeat(501), pausedAt: "2026-01-01T00:00:00.000Z" },
		{ id: "pause", reason: "Review" },
		{ id: "pause", reason: "Review", pausedAt: [] },
		{ id: "pause", reason: "Review", pausedAt: "not-a-date" },
		{ id: "pause", reason: "Review", pausedAt: "2026-01-01" },
		{ id: "pause", reason: "Review", pausedAt: "January 1, 2026 00:00:00 UTC" },
		{ id: "pause", reason: "Review", pausedAt: "2026-02-30T00:00:00.000Z" },
		{ id: "pause", reason: "Review", pausedAt: "2026-01-01T01:00:00.000+01:00" },
	])("fails closed on invalid persisted pause metadata %#", (pause) => {
		const shared = sharedLedgers();
		const risk = shared.createLedger();
		Object.assign(shared.state().paper, { newExposurePause: pause });
		const before = structuredClone(shared.state());

		expect(() => shared.createLedger()).toThrow(/newExposurePause/);
		expect(() => risk.usage()).toThrow(/newExposurePause/);
		expect(() => risk.assertNewExposureAllowed()).toThrow(/newExposurePause/);
		expect(() => risk.check("BTC/USDT", 100)).toThrow(/newExposurePause/);
		expect(() => risk.reserve("BTC/USDT", 100)).toThrow(/newExposurePause/);
		expect(() => risk.pauseNewExposure("Replacement")).toThrow(/newExposurePause/);
		expect(() => risk.resumeNewExposure("pause")).toThrow(/newExposurePause/);
		expect(() => risk.reset()).toThrow(/newExposurePause/);
		expect(shared.state()).toEqual(before);
	});

	it("does not report successful pause or resume when persistence fails", () => {
		const shared = sharedLedgers();
		const risk = shared.createLedger();
		const before = structuredClone(shared.state());
		shared.setWriteFailure(true);

		expect(() => risk.pauseNewExposure("Review")).toThrow(RiskStatePersistenceError);
		expect(shared.state()).toEqual(before);
		expect(() => risk.assertNewExposureAllowed()).not.toThrow();

		shared.setWriteFailure(false);
		const pause = risk.pauseNewExposure("Persisted review");
		const pausedState = structuredClone(shared.state());
		shared.setWriteFailure(true);

		expect(() => risk.resumeNewExposure(pause.id)).toThrow(RiskStatePersistenceError);
		expect(shared.state()).toEqual(pausedState);
		expect(risk.usage().newExposurePause).toEqual(pause);
		expect(() => risk.assertNewExposureAllowed()).toThrow("New exposure is paused: Persisted review");
	});

	it("does not use cached pause state when a fresh read fails", () => {
		const shared = sharedLedgers();
		const risk = shared.createLedger();
		shared.store.load = () => {
			throw new Error("state read failed");
		};
		expect(() => risk.assertNewExposureAllowed()).toThrow("state read failed");
		expect(() => risk.check("BTC/USDT", 100)).toThrow("state read failed");
		expect(() => risk.usage()).toThrow("state read failed");
	});

	it("returns detached pause metadata even when the store returns its own state reference", () => {
		const shared = sharedLedgers();
		const risk = shared.createLedger();
		const pause = risk.pauseNewExposure("Original reason");
		const expected = { ...pause };
		pause.id = "changed";
		pause.reason = "changed";
		pause.pausedAt = "changed";
		const observed = risk.usage().newExposurePause;
		expect(observed).toEqual(expected);
		if (observed === undefined) throw new Error("Expected a persisted pause");
		observed.id = "changed again";
		observed.reason = "changed again";
		observed.pausedAt = "changed again";
		risk.record(10);

		expect(shared.state().paper.newExposurePause).toEqual(expected);
		expect(shared.createLedger().usage().newExposurePause).toEqual(expected);
		expect(risk.check("BTC/USDT", 100)).toBe("New exposure is paused: Original reason");
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
