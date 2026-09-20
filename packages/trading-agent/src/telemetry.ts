import type {
	ExactTelemetryAttributes,
	SchemaTelemetrySpan,
	TelemetryContext,
	TelemetrySchemaDefinition,
	TelemetrySchemaSpanEndAttributes,
	TelemetrySchemaSpanName,
	TelemetrySchemaSpanStartAttributes,
	TelemetrySpan,
} from "@earendil-works/pi-telemetry";

const ERROR_TYPES = ["runtime", "recovery", "poll", "delivery", "aborted"] as const;

const RUNTIME_SPAN = {
	description: "Trading runtime initialization or replacement",
	parents: { kind: "root_or_external" },
	startAttributes: {
		"ti.trading.mode": {
			type: "string",
			values: ["paper", "live"],
			required: true,
			description: "Trading execution mode",
		},
		"ti.trading.market_family": {
			type: "string",
			values: ["spot", "futures", "mixed"],
			required: true,
			description: "Configured market family",
		},
	},
	endAttributes: {
		"ti.trading.duration_ms": { type: "number", description: "Elapsed operation time" },
		"ti.trading.error_type": { type: "string", values: ERROR_TYPES, description: "Safe failure category" },
		"ti.trading.examined_count": { type: "number", description: "Recovery records examined" },
		"ti.trading.reconciled_count": { type: "number", description: "Recovery records reconciled" },
		"ti.trading.unresolved_count": { type: "number", description: "Recovery records unresolved" },
	},
	status: { default: "ok", errorWhen: "Runtime initialization or replacement fails" },
} as const;

export const TRADING_TELEMETRY_SCHEMA = {
	version: 1,
	spans: {
		"ti.trading.runtime.init": RUNTIME_SPAN,
		"ti.trading.runtime.replace": RUNTIME_SPAN,
		"ti.trading.execution.recovery": {
			description: "Durable execution recovery",
			parents: { kind: "any" },
			startAttributes: {
				"ti.trading.mode": {
					type: "string",
					values: ["paper", "live"],
					required: true,
					description: "Trading execution mode",
				},
				"ti.trading.market_family": {
					type: "string",
					values: ["spot", "futures", "mixed"],
					required: true,
					description: "Configured market family",
				},
			},
			endAttributes: {
				"ti.trading.duration_ms": { type: "number", description: "Elapsed operation time" },
				"ti.trading.error_type": { type: "string", values: ERROR_TYPES, description: "Safe failure category" },
				"ti.trading.examined_count": { type: "number", description: "Recovery records examined" },
				"ti.trading.reconciled_count": { type: "number", description: "Recovery records reconciled" },
				"ti.trading.unresolved_count": { type: "number", description: "Recovery records unresolved" },
			},
			status: { default: "ok", errorWhen: "Execution recovery fails" },
		},
		"ti.trading.monitor.poll": {
			description: "One order monitor poll",
			parents: { kind: "root_or_external" },
			startAttributes: {
				"ti.trading.mode": {
					type: "string",
					values: ["paper", "live"],
					required: true,
					description: "Trading execution mode",
				},
				"ti.trading.market_family": {
					type: "string",
					values: ["spot", "futures", "mixed"],
					required: true,
					description: "Configured market family",
				},
			},
			endAttributes: {
				"ti.trading.duration_ms": { type: "number", description: "Elapsed operation time" },
				"ti.trading.error_type": { type: "string", values: ERROR_TYPES, description: "Safe failure category" },
				"ti.trading.open_order_count": { type: "number", description: "Observed open orders" },
				"ti.trading.unresolved_count": { type: "number", description: "Unresolved monitored orders" },
			},
			status: { default: "ok", errorWhen: "Monitor polling fails" },
		},
		"ti.trading.monitor.delivery": {
			description: "One order monitor notification delivery pass",
			parents: { kind: "spans", spans: ["ti.trading.monitor.poll"] },
			startAttributes: {
				"ti.trading.mode": {
					type: "string",
					values: ["paper", "live"],
					required: true,
					description: "Trading execution mode",
				},
				"ti.trading.market_family": {
					type: "string",
					values: ["spot", "futures", "mixed"],
					required: true,
					description: "Configured market family",
				},
			},
			endAttributes: {
				"ti.trading.duration_ms": { type: "number", description: "Elapsed operation time" },
				"ti.trading.error_type": { type: "string", values: ERROR_TYPES, description: "Safe failure category" },
				"ti.trading.attempted_count": { type: "number", description: "Notifications attempted" },
				"ti.trading.delivered_count": { type: "number", description: "Notifications delivered" },
				"ti.trading.failure_count": { type: "number", description: "Notification delivery failures" },
			},
			status: { default: "ok", errorWhen: "Monitor notification delivery fails" },
		},
	},
} as const satisfies TelemetrySchemaDefinition;

export type TradingSpanName = TelemetrySchemaSpanName<typeof TRADING_TELEMETRY_SCHEMA>;
export type TradingSpanStartAttributes<Name extends TradingSpanName> = TelemetrySchemaSpanStartAttributes<
	typeof TRADING_TELEMETRY_SCHEMA,
	Name
>;
export type TradingSpanEndAttributes<Name extends TradingSpanName> = TelemetrySchemaSpanEndAttributes<
	typeof TRADING_TELEMETRY_SCHEMA,
	Name
>;
export type TradingTelemetrySpan<Name extends TradingSpanName> = SchemaTelemetrySpan<
	typeof TRADING_TELEMETRY_SCHEMA,
	Name
>;
export type TradingTelemetryErrorType = (typeof ERROR_TYPES)[number];

export function marketFamilyForTradingType(marketType: "spot" | "usdm-futures" | "both"): "spot" | "futures" | "mixed" {
	return marketType === "spot" ? "spot" : marketType === "usdm-futures" ? "futures" : "mixed";
}

export function startTradingSpan<
	Name extends TradingSpanName,
	const Attributes extends TradingSpanStartAttributes<Name>,
	Result,
>(
	telemetryContext: TelemetryContext,
	name: Name,
	attributes: ExactTelemetryAttributes<TradingSpanStartAttributes<Name>, Attributes>,
	errorType: TradingTelemetryErrorType | (() => TradingTelemetryErrorType),
	callback: (span: TradingTelemetrySpan<Name>) => Result | Promise<Result>,
): Promise<Result> {
	const startedAt = Date.now();
	return telemetryContext.startSpan({ name, attributes }, async (span) => {
		try {
			return await callback(span as TradingTelemetrySpan<Name>);
		} catch (error) {
			span.setAttributes({ "ti.trading.error_type": typeof errorType === "function" ? errorType() : errorType });
			span.setStatus({ status: "error" });
			throw error;
		} finally {
			span.setAttributes({ "ti.trading.duration_ms": Math.max(0, Date.now() - startedAt) });
		}
	});
}

export function setTradingSpanAttributes<
	Name extends TradingSpanName,
	const Attributes extends TradingSpanEndAttributes<Name>,
>(
	span: TradingTelemetrySpan<Name>,
	attributes: ExactTelemetryAttributes<TradingSpanEndAttributes<Name>, Attributes>,
): void {
	span.setAttributes(attributes);
}

export function markTradingSpanAborted<Name extends TradingSpanName>(span: TradingTelemetrySpan<Name>): void {
	(span as TelemetrySpan).setAttributes({ "ti.trading.error_type": "aborted" });
	span.setStatus({ status: "error" });
}
