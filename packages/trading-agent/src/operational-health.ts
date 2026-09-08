import type { TradingMode } from "@nikopack/ti-trading-engine";

export interface OperationalObservation {
	source: string;
	enabled: boolean;
	lastSuccessAt?: number;
	lastFailureAt?: number;
	/** Safe category, not a raw authenticated network error. */
	errorCode?: string;
	pendingNotifications: number;
}

export interface OperationalHealthInput {
	mode: TradingMode;
	exchange: string;
	marketType: string;
	newExposurePaused: boolean;
	maintenanceActive: boolean;
	staleRuntime: boolean;
	unresolvedExecutions: number;
	pendingReservations: number;
	observations: OperationalObservation[];
	maxObservationAgeMs: number;
}

/** This describes entry blocks and recent observations, not permission to trade. */
export function assessOperationalHealth(input: OperationalHealthInput, now = Date.now()) {
	if (!Number.isFinite(now) || !Number.isFinite(input.maxObservationAgeMs) || input.maxObservationAgeMs <= 0) {
		throw new Error("Invalid health observation clock or age limit");
	}
	for (const flag of [input.newExposurePaused, input.maintenanceActive, input.staleRuntime]) {
		if (typeof flag !== "boolean") throw new Error("Invalid health admission state");
	}
	for (const count of [input.unresolvedExecutions, input.pendingReservations]) {
		if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid health accounting count");
	}
	const blockers = [
		...(input.newExposurePaused ? ["new-exposure-paused"] : []),
		...(input.maintenanceActive ? ["account-maintenance"] : []),
		...(input.staleRuntime ? ["stale-runtime"] : []),
		...(input.unresolvedExecutions > 0 ? ["unresolved-executions"] : []),
		...(input.pendingReservations > 0 ? ["unsettled-risk-reservations"] : []),
	];
	const observations = input.observations.map((observation) => {
		if (!Number.isSafeInteger(observation.pendingNotifications) || observation.pendingNotifications < 0) {
			throw new Error("Invalid pending notification count");
		}
		for (const time of [observation.lastSuccessAt, observation.lastFailureAt]) {
			if (time !== undefined && (!Number.isFinite(time) || time < 0)) throw new Error("Invalid observation time");
		}
		const ageMs = observation.lastSuccessAt === undefined ? undefined : now - observation.lastSuccessAt;
		const failed =
			observation.lastFailureAt !== undefined &&
			(observation.lastSuccessAt === undefined || observation.lastFailureAt >= observation.lastSuccessAt);
		const status = !observation.enabled
			? "disabled"
			: failed
				? "degraded"
				: ageMs === undefined
					? "unknown"
					: ageMs < 0 || ageMs > input.maxObservationAgeMs
						? "stale"
						: "recent";
		return { ...observation, ageMs, status };
	});
	const active = observations.filter((observation) => observation.enabled);
	const connectivity =
		active.length === 0 || active.every((observation) => observation.status === "unknown")
			? "unknown"
			: active.every((observation) => observation.status === "recent")
				? "recent-observations"
				: "degraded";
	return {
		observedAt: new Date(now).toISOString(),
		mode: input.mode,
		exchange: input.exchange,
		marketType: input.marketType,
		entryBlocked: blockers.length > 0,
		staleRuntime: input.staleRuntime,
		blockers,
		unresolvedExecutions: input.unresolvedExecutions,
		pendingReservations: input.pendingReservations,
		connectivity,
		observations,
		semantics:
			"Read-only local state and recent monitor observations; not exchange acceptance or order authorization.",
	};
}
