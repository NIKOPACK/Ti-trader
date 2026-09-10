import type { Order as CcxtOrder, Exchange } from "ccxt";
import type { FuturesPositionMode, MarketType } from "../client-types.ts";
import type { Order, OrderSide, PlaceOcoOrderResult, PlaceOrderInput, PlaceOrderType } from "../types.ts";

export type CredentialPasswordPolicy = "required" | "optional" | "unused";
export type OrderHistoryMode = "closed-and-canceled" | "fetch-orders-by-symbol";
export type ClientOrderIdParam = "clientOrderId" | "newClientOrderId";

export interface VenueLiveCapability {
	readonly id: string;
	readonly label: string;
	readonly marketFamily: "spot" | "futures";
	readonly orderTypes: readonly PlaceOrderType[];
	readonly ocoSides: readonly OrderSide[];
	readonly limitations: readonly string[];
	readonly references: readonly string[];
}

export interface VenueCapabilityMatrixRow extends VenueLiveCapability {
	readonly mode: "live";
	readonly exchangeId: string;
}

export interface VenueWireMapping {
	readonly omitExchangeQuantity: boolean;
	readonly omitReduceOnly: boolean;
	readonly constraints: readonly string[];
}

export interface VenueOrderListParams {
	readonly open: readonly Record<string, unknown>[];
	readonly history: readonly Record<string, unknown>[];
	readonly closed: readonly Record<string, unknown>[];
	readonly canceled: readonly Record<string, unknown>[];
}

export interface VenueWireContext {
	readonly marketFamily: "spot" | "futures" | "mixed" | "invalid";
	readonly positionMode?: FuturesPositionMode;
	readonly type: PlaceOrderType;
	readonly reduceOnly?: boolean;
	readonly closePosition?: boolean;
}

export interface VenueClientOrderRequest {
	readonly venueId: string;
	readonly clientOrderId: string;
	readonly symbol: string;
	readonly marketType: MarketType;
	readonly conditional?: boolean;
}

export interface VenueNativeOcoRequest {
	readonly symbol: string;
	readonly side: "buy" | "sell";
	readonly amount: number;
	readonly stopLossPrice: number;
	readonly takeProfitPrice: number;
	readonly listClientOrderId: string;
	readonly aboveClientOrderId: string;
	readonly belowClientOrderId: string;
	readonly marketId: string;
}

export interface VenueSpotFilterRequest {
	readonly marketInfo: unknown;
	readonly type: PlaceOrderType | "oco";
	readonly amount: number;
	readonly price?: number;
	readonly stopPrice?: number;
	readonly stopLossPrice?: number;
	readonly takeProfitPrice?: number;
	readonly last?: number;
}

/** Live venue policy and exchange operations behind CcxtExchangeClient. Unknown ids use the experimental profile. */
export interface LiveVenueProfile {
	readonly id: string;
	readonly password: CredentialPasswordPolicy;
	readonly liveCapabilities: readonly VenueLiveCapability[];
	readonly orderHistoryMode: OrderHistoryMode;
	readonly orderHistoryRequiresSymbol: boolean;
	readonly skipGenericSpotAmountCostLimits: boolean;
	ccxtOptions(marketType: MarketType): Record<string, unknown>;
	extraOrderListParams(marketType: MarketType): VenueOrderListParams;
	cancelRetryParams(): readonly Record<string, unknown>[];
	clientOrderIdParam(marketType: MarketType): ClientOrderIdParam;
	supportsNativeOrderList(marketType: MarketType): boolean;
	validateClientOrderId?(value: string, label: string): void;
	wireMapping(input: VenueWireContext): VenueWireMapping;
	futuresNativeIdAmbiguous(orderType: PlaceOrderType | "oco" | undefined): boolean;
	clientIdLookupNotes(marketFamily: "spot" | "futures" | "mixed" | "invalid"): readonly string[];
	closePositionQuantityConstraint(
		marketFamily: "spot" | "futures" | "mixed" | "invalid",
		type: PlaceOrderType,
	): string;
	hedgeReductionConstraint(positionMode: FuturesPositionMode | undefined): string | undefined;
	trailingSpotConstraints(): readonly string[];
	orderTypeMetadataNames(
		marketFamily: "spot" | "futures" | "mixed" | "invalid",
		type: PlaceOrderType,
	): readonly string[];
	unsupportedOcoSideReason(side: OrderSide): string | undefined;
	quantityClosePositionNote(): string;
	fetchParsedOrder(exchange: Exchange, id: string, symbol: string, marketType: MarketType): Promise<CcxtOrder>;
	fetchParsedOrderByClientId(exchange: Exchange, request: VenueClientOrderRequest): Promise<CcxtOrder>;
	fetchNativeOrderList?(exchange: Exchange, query: Record<string, string>): Promise<Record<string, unknown>>;
	cancelNativeOrderList?(exchange: Exchange, orderListId: string, symbol: string): Promise<void>;
	validateSpotPlacement?(request: VenueSpotFilterRequest): void;
	assertNativeSpotTrailing?(exchange: Exchange, symbol: string, side: "buy" | "sell", trailingPercent: number): void;
	placeNativeSpotTrailing?(
		exchange: Exchange,
		request: {
			symbol: string;
			side: "buy" | "sell";
			amount: number;
			trailingPercent: number;
			stopPrice?: number;
			clientOrderId: string;
		},
	): Promise<Order>;
	placeNativeSpotOco?(exchange: Exchange, request: VenueNativeOcoRequest): Promise<PlaceOcoOrderResult>;
	probeOppositeWallet?(
		exchange: Exchange,
		request: { marketType: MarketType; quoteCurrency: string },
	): Promise<boolean>;
	setMultiAssetsMargin?(exchange: Exchange, enabled: boolean): Promise<void>;
	closeAllPlaceholderAmount?(
		exchange: Exchange,
		symbol: string,
		amount: number,
		market: { contract?: boolean; linear?: boolean; contractSize?: number; limits?: { amount?: { min?: number } } },
	): number;
}

export function emptyOrderListParams(): VenueOrderListParams {
	return { open: [], history: [], closed: [], canceled: [] };
}

export function defaultWireMapping(): VenueWireMapping {
	return { omitExchangeQuantity: false, omitReduceOnly: false, constraints: [] };
}

export function venueWireContextFromOrder(
	marketFamily: VenueWireContext["marketFamily"],
	positionMode: FuturesPositionMode | undefined,
	input: Pick<PlaceOrderInput, "type" | "reduceOnly" | "closePosition">,
): VenueWireContext {
	return {
		marketFamily,
		positionMode,
		type: input.type,
		reduceOnly: input.reduceOnly,
		closePosition: input.closePosition,
	};
}
