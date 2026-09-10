import type { ExchangeCredentials } from "../client-types.ts";
import { fetchCcxtParsedOrder, fetchCcxtParsedOrderByClientId } from "./ccxt-lookups.ts";
import { ALGO_ORDER_RETRY_PARAMS, CLOSE_USES_POSITION_SNAPSHOT } from "./constants.ts";
import {
	defaultWireMapping,
	emptyOrderListParams,
	type LiveVenueProfile,
	type VenueLiveCapability,
	type VenueOrderListParams,
} from "./types.ts";

export function experimentalLiveVenue(
	id: string,
	overrides: {
		password?: LiveVenueProfile["password"];
		liveCapabilities?: readonly VenueLiveCapability[];
		extraOrderListParams?: LiveVenueProfile["extraOrderListParams"];
	} = {},
): LiveVenueProfile {
	return {
		id,
		password: overrides.password ?? "optional",
		liveCapabilities: overrides.liveCapabilities ?? [],
		orderHistoryMode: "closed-and-canceled",
		orderHistoryRequiresSymbol: false,
		skipGenericSpotAmountCostLimits: false,
		ccxtOptions: () => ({}),
		extraOrderListParams: overrides.extraOrderListParams ?? ((): VenueOrderListParams => emptyOrderListParams()),
		cancelRetryParams: () => ALGO_ORDER_RETRY_PARAMS,
		clientOrderIdParam: () => "clientOrderId",
		supportsNativeOrderList: () => false,
		wireMapping: () => defaultWireMapping(),
		futuresNativeIdAmbiguous: () => false,
		clientIdLookupNotes: () => [],
		closePositionQuantityConstraint: () => CLOSE_USES_POSITION_SNAPSHOT,
		hedgeReductionConstraint: () => undefined,
		trailingSpotConstraints: () => [],
		orderTypeMetadataNames: (_family, type) => [type],
		unsupportedOcoSideReason: () => undefined,
		quantityClosePositionNote: () => "matching_position_snapshot; native trigger closes may omit wire quantity",
		fetchParsedOrder: (exchange, orderId, symbol) => fetchCcxtParsedOrder(exchange, id, orderId, symbol),
		fetchParsedOrderByClientId: (exchange, request) => fetchCcxtParsedOrderByClientId(exchange, request),
	};
}

export function missingApiKeyOrSecret(exchangeId: string, credentials: ExchangeCredentials): string | undefined {
	if (!credentials.apiKey.trim() || !credentials.secret.trim()) {
		return `Credentials for ${exchangeId} must include non-empty apiKey and secret`;
	}
	return undefined;
}
