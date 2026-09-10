import type { FuturesPositionMode } from "./client-types.ts";
import type { MarketInfo, OrderSide, PlaceOrderInput, PlaceOrderType } from "./types.ts";
import {
	defaultWireMapping,
	LIVE_ADAPTER_LIMITATIONS,
	liveCapabilityMatrixRows,
	resolveLiveVenue,
	venueWireContextFromOrder,
} from "./venues/index.ts";

export type CapabilityStatus = "supported" | "unsupported" | "unknown";
export type CapabilityEvidenceLevel = "offline-contract" | "experimental" | "externally-verified";
export type MarketFamily = "spot" | "futures" | "mixed" | "invalid";

export interface Capability {
	readonly status: CapabilityStatus;
	readonly reason: string;
	readonly evidence: {
		readonly level: CapabilityEvidenceLevel;
		readonly references: readonly string[];
	};
	readonly constraints: readonly string[];
}

export interface TradingCapabilityContext {
	exchangeId: string;
	mode: "paper" | "live";
	marketFamily: MarketFamily;
	positionMode?: FuturesPositionMode;
	marketInfo?: MarketInfo;
	/** False when a requested market could not be read or did not match its scope. */
	metadataValid?: boolean;
	orderType?: PlaceOrderType | "oco";
}

export const ORDER_TYPES = [
	"market",
	"limit",
	"stop",
	"stop_market",
	"take_profit",
	"take_profit_market",
	"trailing_stop_market",
] as const satisfies readonly PlaceOrderType[];

export const ORDER_TYPE_ALIASES = {
	STOP_LOSS_LIMIT: "stop",
	STOP_LOSS: "stop_market",
	TAKE_PROFIT_LIMIT: "take_profit",
	TAKE_PROFIT: "take_profit_market",
	TRAILING: "trailing_stop_market",
	TRAILING_STOP: "trailing_stop_market",
} as const;

/** TAKE_PROFIT is a market trigger on Spot, but a limit trigger on USD-M. */
export function normalizedOrderTypes(info: MarketInfo | undefined): string[] | undefined {
	return info?.orderTypes?.map((type) => {
		const normalized = type.trim().replaceAll("-", "_").toUpperCase();
		if (info.marketType === "swap" && normalized === "TAKE_PROFIT") return "take_profit";
		return ORDER_TYPE_ALIASES[normalized as keyof typeof ORDER_TYPE_ALIASES] ?? normalized.toLowerCase();
	});
}

export function orderTypeFromMarketInfo(
	info: MarketInfo | undefined,
	names: readonly string[],
): CapabilityStatus | undefined {
	const types = normalizedOrderTypes(info);
	if (types === undefined) return undefined;
	return names.some((name) => {
		const normalized = name.trim().toLowerCase().replaceAll("-", "_");
		const canonical =
			normalized === "trailing" || normalized === "trailing_stop" ? "trailing_stop_market" : normalized;
		return types.includes(canonical);
	})
		? "supported"
		: "unsupported";
}

const PAPER_LIMITATIONS = [
	"Paper fills do not model partial fills, order-book slippage or live execution quality",
	"Paper futures do not simulate funding payments or exchange-specific liquidation rules",
] as const;
interface CapabilityProfile {
	readonly id: string;
	readonly label: string;
	readonly mode: "paper" | "live";
	readonly exchangeId: string;
	readonly marketFamily: "spot" | "futures";
	readonly orderTypes: readonly PlaceOrderType[];
	readonly ocoSides: readonly OrderSide[];
	readonly limitations: readonly string[];
	readonly references: readonly string[];
}

const PAPER_CAPABILITY_MATRIX = [
	{
		id: "paper-spot",
		label: "Paper spot",
		mode: "paper",
		exchangeId: "*",
		marketFamily: "spot",
		orderTypes: ORDER_TYPES,
		ocoSides: ["buy", "sell"],
		limitations: PAPER_LIMITATIONS,
		references: ["src/capabilities.test.ts", "src/paper-client.test.ts"],
	},
	{
		id: "paper-futures",
		label: "Paper futures",
		mode: "paper",
		exchangeId: "*",
		marketFamily: "futures",
		orderTypes: ["market"],
		ocoSides: [],
		limitations: PAPER_LIMITATIONS,
		references: ["src/capabilities.test.ts", "src/paper-client.test.ts"],
	},
] as const satisfies readonly CapabilityProfile[];

/** Supported adapter contracts, not a list of certified live integrations. */
export const TRADING_CAPABILITY_MATRIX: readonly CapabilityProfile[] = [
	...PAPER_CAPABILITY_MATRIX,
	...liveCapabilityMatrixRows(),
];

export function capability(
	status: CapabilityStatus,
	reason: string,
	level: CapabilityEvidenceLevel = "experimental",
	references: readonly string[] = [],
	constraints: readonly string[] = [],
): Capability {
	return { status, reason, evidence: { level, references }, constraints };
}

export function unavailableMarketCapability(
	family: MarketFamily,
	metadataValid: boolean,
	marketInfo?: MarketInfo,
): Capability | undefined {
	if (family === "invalid")
		return capability("unsupported", "The symbol is not enabled by the configured market type or quote currency");
	if (marketInfo?.active === false) return capability("unsupported", `Market ${marketInfo.symbol} is inactive`);
	if (!metadataValid)
		return capability("unknown", "Market metadata is unavailable or does not match the requested symbol");
	return undefined;
}

export function getTradingCapabilities(context: TradingCapabilityContext) {
	const { marketFamily: family } = context;
	const liveVenue = context.mode === "live" ? resolveLiveVenue(context.exchangeId) : undefined;
	const profile: CapabilityProfile | undefined = TRADING_CAPABILITY_MATRIX.find(
		(row) =>
			row.mode === context.mode &&
			row.marketFamily === family &&
			(row.exchangeId === "*" || row.exchangeId === context.exchangeId),
	);
	const constraints =
		profile?.limitations ?? (context.mode === "paper" ? PAPER_LIMITATIONS : LIVE_ADAPTER_LIMITATIONS);
	const contract = (status: CapabilityStatus, reason: string, extra: readonly string[] = []): Capability =>
		capability(status, reason, profile ? "offline-contract" : "experimental", profile?.references ?? [], [
			...constraints,
			...extra,
		]);
	const unavailable = unavailableMarketCapability(family, context.metadataValid !== false, context.marketInfo);
	const unresolvedFamily =
		family === "mixed" ? contract("unknown", "Specify a symbol to distinguish spot and futures support") : undefined;
	const experimental = contract(
		"unknown",
		`Live ${context.exchangeId} ${family} remains experimental; market metadata alone does not prove adapter support`,
	);
	const submission = (type: PlaceOrderType): Capability => {
		if (family === "invalid") return unavailable!;
		if (profile && !profile.orderTypes.includes(type))
			return contract("unsupported", `Paper futures currently accept market orders only; ${type} is unsupported`);
		if (unavailable || unresolvedFamily) return (unavailable ?? unresolvedFamily)!;
		const metadataTypes = liveVenue?.orderTypeMetadataNames(family, type) ?? [type];
		if (orderTypeFromMarketInfo(context.marketInfo, metadataTypes) === "unsupported")
			return contract("unsupported", `The exchange market metadata does not support ${type} orders`);
		return profile
			? contract("supported", `${profile.label} ${type} submission has offline adapter contract coverage`, [
					...(type === "trailing_stop_market" && context.mode === "paper"
						? ["Paper trailing stops accept trailingPercent only, not activation stopPrice"]
						: []),
					...(type === "trailing_stop_market" && family === "spot"
						? (liveVenue?.trailingSpotConstraints() ?? [])
						: []),
				])
			: experimental;
	};
	const oco = (side: OrderSide): Capability => {
		if (family === "invalid") return unavailable!;
		if (family === "futures") return contract("unsupported", "OCO orders are supported only for spot markets");
		if (profile && !profile.ocoSides.includes(side))
			return contract(
				"unsupported",
				liveVenue?.unsupportedOcoSideReason(side) ?? `OCO ${side} orders are not supported`,
			);
		if (unavailable || unresolvedFamily) return (unavailable ?? unresolvedFamily)!;
		// Native lists are not individual order types in Binance exchangeInfo.
		if (!profile && orderTypeFromMarketInfo(context.marketInfo, ["oco"]) === "unsupported")
			return contract("unsupported", "The exchange market metadata does not support OCO orders");
		return profile
			? contract("supported", `${profile.label} ${side} OCO has offline contract coverage`)
			: experimental;
	};
	const readContract = (list: boolean, operation: string): Capability => {
		if (family === "invalid") return unavailable!;
		if (unresolvedFamily) return unresolvedFamily;
		if (list && family === "futures")
			return contract("unsupported", `Futures order-list ${operation} is not implemented`);
		if (list && liveVenue && !liveVenue.supportsNativeOrderList("spot"))
			return contract("unsupported", `Live ${context.exchangeId} order-list ${operation} is not implemented`);
		return profile
			? contract("supported", `${profile.label} ${operation} has offline correlated adapter contract coverage`, [
					"Only the persisted native/client ID and original symbol/account scope establish identity",
					"Not-found, missing, conflicting or incomplete evidence never proves a submission was rejected",
				])
			: experimental;
	};
	const positionControls =
		family === "spot"
			? contract("unsupported", "reduceOnly, positionSide and closePosition are futures-only parameters")
			: (unavailable ??
				unresolvedFamily ??
				(profile
					? contract("supported", `${profile.label} validates matching position reductions`)
					: experimental));
	const hedgeConstraint = liveVenue?.hedgeReductionConstraint(context.positionMode);
	const hedgeReductionConstraints = hedgeConstraint ? [hedgeConstraint] : [];
	const closePosition = (type: PlaceOrderType) => {
		if (type !== "market" && type !== "stop_market" && type !== "take_profit_market")
			return contract(
				"unsupported",
				"closePosition is supported only for market, stop_market or take_profit_market orders",
			);
		const order = submission(type);
		const result =
			positionControls.status === "unsupported" || order.status === "supported" ? positionControls : order;
		return {
			...result,
			constraints: [
				...result.constraints,
				"closePosition omits user amount/quoteAmount and requires a matching open position",
				liveVenue?.closePositionQuantityConstraint(family, type) ??
					"Close uses the matching position snapshot as an explicit base quantity",
			],
		};
	};
	const ambiguousFuturesNativeId =
		family === "futures" && (liveVenue?.futuresNativeIdAmbiguous(context.orderType) ?? false);
	const nativeIdCapability = (operation: string) =>
		ambiguousFuturesNativeId
			? capability(
					"unknown",
					`${context.exchangeId} futures ${operation} by native ID cannot distinguish overlapping ordinary/Algo ID spaces without order-type routing`,
					"experimental",
					["src/ccxt-client.ts"],
					["Use correlated client-ID lookup for recovery; conditional native-ID cancellation is not proven"],
				)
			: readContract(false, operation);
	return {
		profile: profile?.id ?? "experimental",
		orderTypes: Object.fromEntries(ORDER_TYPES.map((type) => [type, submission(type)])) as Record<
			PlaceOrderType,
			Capability
		>,
		oco: { buy: oco("buy"), sell: oco("sell") },
		queryOrderById: nativeIdCapability("native order-ID lookup"),
		queryOrderByClientId: {
			...readContract(false, "client order-ID lookup"),
			constraints: [
				...readContract(false, "client order-ID lookup").constraints,
				...(liveVenue?.clientIdLookupNotes(family) ?? []),
			],
		},
		queryOrderListById: readContract(true, "native list-ID lookup"),
		queryOrderListByClientId: readContract(true, "client list-ID lookup"),
		cancelOrder: {
			...nativeIdCapability("cancellation"),
			constraints: [
				...constraints,
				"Cancellation applies only to an open order; an already filled order cannot be recalled",
			],
		},
		cancelOrderList: readContract(true, "cancellation"),
		positionModes: {
			"one-way": {
				...positionControls,
				constraints: [...positionControls.constraints, "positionSide must be BOTH or omitted"],
			},
			hedge: {
				...positionControls,
				constraints: [
					...positionControls.constraints,
					"positionSide LONG or SHORT is required; reductions use the opposing order side",
				],
			},
		},
		reduceOnly: {
			...positionControls,
			constraints: [
				...positionControls.constraints,
				"Reduction amount cannot exceed the matching open position",
				...hedgeReductionConstraints,
			],
		},
		closePosition: Object.fromEntries(ORDER_TYPES.map((type) => [type, closePosition(type)])) as Record<
			PlaceOrderType,
			Capability
		>,
		quantity: {
			inputUnit: "base" as const,
			exchangeUnit: family === "futures" ? ("contracts" as const) : family === "spot" ? ("base" as const) : null,
			quoteAmount: "reference_price_conversion_not_fixed_spend" as const,
			futuresConversion: "base_amount_divided_by_confirmed_contract_size" as const,
			closePosition:
				liveVenue?.quantityClosePositionNote() ??
				"matching_position_snapshot; native trigger closes may omit wire quantity",
		},
		fundingRates:
			family === "spot"
				? contract("unsupported", "Funding rates are unavailable for spot markets")
				: (unavailable ??
					unresolvedFamily ??
					(context.mode === "paper"
						? contract("unknown", "Paper futures do not simulate funding; no market rate is observed")
						: contract("unknown", "Live funding availability requires an exchange observation"))),
		limitations: constraints,
	};
}

export type TradingCapabilities = ReturnType<typeof getTradingCapabilities>;

export function supportsCorrelatedLookup(value: Capability): boolean {
	return (
		value.status === "supported" && value.evidence.level !== "experimental" && value.evidence.references.length > 0
	);
}

export function evaluateOrderCapability(
	context: TradingCapabilityContext,
	input: Pick<PlaceOrderInput, "type" | "side" | "reduceOnly" | "closePosition" | "positionSide">,
) {
	const matrix = getTradingCapabilities(context);
	const futures = context.marketFamily === "futures";
	let result = matrix.orderTypes[input.type];
	const unsupported = (reason: string) => {
		result = { ...result, status: "unsupported", reason };
	};
	if (
		!futures &&
		(input.reduceOnly !== undefined || input.closePosition !== undefined || input.positionSide !== undefined)
	)
		unsupported("reduceOnly, positionSide and closePosition are futures-only parameters");
	if (input.closePosition && matrix.closePosition[input.type].status === "unsupported")
		unsupported(matrix.closePosition[input.type].reason);
	if (input.closePosition && input.reduceOnly === false) unsupported("closePosition is always reduceOnly");
	if (futures && context.positionMode === "hedge") {
		if (!input.positionSide || input.positionSide === "BOTH")
			unsupported("Hedge mode futures orders require positionSide LONG or SHORT");
		if (
			(input.reduceOnly || input.closePosition) &&
			((input.positionSide === "LONG" && input.side !== "sell") ||
				(input.positionSide === "SHORT" && input.side !== "buy"))
		)
			unsupported(
				`Hedge mode ${input.reduceOnly ? "reduceOnly" : "closePosition"} orders must use the opposing side for positionSide ${input.positionSide}`,
			);
	}
	if (futures && context.positionMode === "one-way" && input.positionSide && input.positionSide !== "BOTH")
		unsupported("One-way mode futures orders must use positionSide BOTH or omit it");
	const liveVenue = context.mode === "live" ? resolveLiveVenue(context.exchangeId) : undefined;
	const mapping = liveVenue
		? liveVenue.wireMapping(venueWireContextFromOrder(context.marketFamily, context.positionMode, input))
		: defaultWireMapping();
	return {
		capability: result,
		omitExchangeQuantity: mapping.omitExchangeQuantity,
		omitReduceOnly: mapping.omitReduceOnly,
		constraints: mapping.constraints,
	};
}
