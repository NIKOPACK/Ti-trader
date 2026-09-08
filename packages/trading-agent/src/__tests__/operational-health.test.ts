import { describe, expect, it } from "vitest";
import { assessOperationalHealth, type OperationalHealthInput } from "../operational-health.ts";

const input: OperationalHealthInput = {
	mode: "paper",
	exchange: "okx",
	marketType: "spot",
	newExposurePaused: false,
	maintenanceActive: false,
	staleRuntime: false,
	unresolvedExecutions: 0,
	pendingReservations: 0,
	observations: [],
	maxObservationAgeMs: 60_000,
};

describe("operational health", () => {
	it("never reports unobserved connectivity as healthy", () => {
		expect(assessOperationalHealth(input)).toMatchObject({ connectivity: "unknown", entryBlocked: false });
	});

	it("separates recent connectivity from permission to trade", () => {
		expect(
			assessOperationalHealth(
				{
					...input,
					newExposurePaused: true,
					unresolvedExecutions: 2,
					pendingReservations: 1,
					observations: [{ source: "orders", enabled: true, lastSuccessAt: 1000, pendingNotifications: 0 }],
				},
				2000,
			),
		).toMatchObject({
			entryBlocked: true,
			connectivity: "recent-observations",
			blockers: ["new-exposure-paused", "unresolved-executions", "unsettled-risk-reservations"],
		});
	});

	it.each([
		{ lastSuccessAt: 1, expected: "stale" },
		{ lastSuccessAt: 100_001, expected: "stale" },
		{ lastSuccessAt: 90_000, lastFailureAt: 95_000, expected: "degraded" },
		{ lastSuccessAt: 95_000, lastFailureAt: 90_000, expected: "recent" },
		{ expected: "unknown" },
	])("classifies stale, future, recovered and failed observations: %j", ({ expected, ...times }) => {
		const health = assessOperationalHealth(
			{
				...input,
				observations: [{ source: "triggers", enabled: true, pendingNotifications: 1, ...times }],
			},
			100_000,
		);
		expect(health.observations[0]).toMatchObject({ status: expected, pendingNotifications: 1 });
	});

	it("does not use a disabled monitor to imply current connectivity", () => {
		expect(
			assessOperationalHealth(
				{
					...input,
					observations: [{ source: "orders", enabled: false, lastSuccessAt: 1000, pendingNotifications: 0 }],
				},
				2000,
			),
		).toMatchObject({ connectivity: "unknown" });
	});

	it("reports a durable account-maintenance fence as an entry block", () => {
		expect(assessOperationalHealth({ ...input, maintenanceActive: true })).toMatchObject({
			entryBlocked: true,
			blockers: ["account-maintenance"],
		});
	});

	it("keeps a stale runtime blocked even after maintenance has completed", () => {
		expect(assessOperationalHealth({ ...input, staleRuntime: true })).toMatchObject({
			entryBlocked: true,
			staleRuntime: true,
			blockers: ["stale-runtime"],
		});
	});

	it("rejects corrupt metrics instead of presenting a reassuring default", () => {
		expect(() => assessOperationalHealth({ ...input, unresolvedExecutions: Number.NaN })).toThrow();
		expect(() =>
			assessOperationalHealth({
				...input,
				observations: [{ source: "orders", enabled: true, lastSuccessAt: Number.NaN, pendingNotifications: 0 }],
			}),
		).toThrow();
	});
});
