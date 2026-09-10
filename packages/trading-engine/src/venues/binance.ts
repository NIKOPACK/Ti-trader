import type { Order as CcxtOrder, Exchange } from "ccxt";
import { validateBinanceSpotFilters } from "../binance-spot-filters.ts";
import {
	assertBinanceSpotTrailingOrder,
	binanceRawOrderToOrder,
	binanceReportToOrder,
	createBinanceSpotOco,
	createBinanceSpotTrailingOrder,
} from "../ccxt-binance-spot.ts";
import { finiteNumber, isOrderNotFound, validateBinanceClientOrderId } from "../ccxt-map.ts";
import type { MarketType } from "../client-types.ts";
import { contractSizeForMarket } from "../contract-size.ts";
import type { OrderSide, PlaceOrderType } from "../types.ts";
import { ALGO_ORDER_RETRY_PARAMS, CLOSE_USES_POSITION_SNAPSHOT, LIVE_ADAPTER_LIMITATIONS } from "./constants.ts";
import {
	emptyOrderListParams,
	type LiveVenueProfile,
	type VenueClientOrderRequest,
	type VenueNativeOcoRequest,
	type VenueSpotFilterRequest,
	type VenueWireContext,
	type VenueWireMapping,
} from "./types.ts";

export const BINANCE_HEDGE_REDUCTION =
	"Binance hedge mode omits reduceOnly; the opposing side plus positionSide enforces the reducing direction";
export const BINANCE_CLOSE_ALL =
	"Binance close-all triggers use closePosition and omit wire-level reduceOnly and exchange quantity";
export const BINANCE_OCO_BUY_UNSUPPORTED = "Binance Spot native OCO buy brackets are not supported safely";
export const BINANCE_QUANTITY_CLOSE_NOTE =
	"matching_position_snapshot; native Binance trigger closes may omit wire quantity";

const BINANCE_ORDER_TYPES = [
	"market",
	"limit",
	"stop",
	"stop_market",
	"take_profit",
	"take_profit_market",
	"trailing_stop_market",
] as const satisfies readonly PlaceOrderType[];

const FUTURES_TRIGGER = { trigger: true } as const;
const BINANCE_USDM_TYPE = "swap";

type ExposureMarket = {
	spot?: boolean;
	swap?: boolean;
	contract?: boolean;
	linear?: boolean;
	inverse?: boolean;
	quote?: string;
	settle?: string;
};

function privateEndpoint(
	exchange: Exchange,
	name: string,
	label: string,
): (params: Record<string, string>) => Promise<unknown> {
	const endpoint = (exchange as unknown as Record<string, unknown>)[name];
	if (typeof endpoint !== "function") throw new Error(`${label} unavailable`);
	return (endpoint as (params: Record<string, string>) => Promise<unknown>).bind(exchange);
}

function parseMarketOrder(exchange: Exchange, raw: unknown, symbol: string): CcxtOrder {
	return exchange.parseOrder(raw as Record<string, unknown>, exchange.markets[symbol]);
}

function binanceWireMapping(input: VenueWireContext): VenueWireMapping {
	const futures = input.marketFamily === "futures";
	const omitExchangeQuantity =
		futures && input.closePosition === true && (input.type === "stop_market" || input.type === "take_profit_market");
	const hedgeReduction =
		futures && input.positionMode === "hedge" && (input.reduceOnly === true || input.closePosition === true);
	return {
		omitExchangeQuantity,
		omitReduceOnly: omitExchangeQuantity || hedgeReduction,
		constraints: [
			...(hedgeReduction ? [BINANCE_HEDGE_REDUCTION] : []),
			...(omitExchangeQuantity ? [BINANCE_CLOSE_ALL] : []),
		],
	};
}

async function fetchBinanceParsedOrder(
	exchange: Exchange,
	id: string,
	symbol: string,
	marketType: MarketType,
): Promise<CcxtOrder> {
	if (marketType === "spot") {
		const raw = await privateEndpoint(
			exchange,
			"privateGetOrder",
			"Binance ccxt adapter does not expose the Spot order query endpoint",
		)({
			symbol: exchange.markets[symbol].id,
			orderId: id,
		});
		return parseMarketOrder(exchange, raw, symbol);
	}
	if (!exchange.has.fetchOrder) throw new Error("Order lookup is unsupported on binance");
	try {
		return await exchange.fetchOrder(id, symbol);
	} catch (error) {
		if (!isOrderNotFound(error)) throw error;
		return exchange.fetchOrder(id, symbol, { trigger: true });
	}
}

async function fetchBinanceParsedOrderByClientId(
	exchange: Exchange,
	request: VenueClientOrderRequest,
): Promise<CcxtOrder> {
	const isFutures = request.marketType === "usdm-futures";
	const lookup = async (isConditional: boolean): Promise<CcxtOrder> => {
		const endpointName = isFutures
			? isConditional
				? "fapiPrivateGetAlgoOrder"
				: "fapiPrivateGetOrder"
			: "privateGetOrder";
		const label = `Binance ${isFutures ? (isConditional ? "futures Algo" : "futures") : "Spot"} order query endpoint unavailable`;
		const raw = await privateEndpoint(
			exchange,
			endpointName,
			label,
		)({
			symbol: exchange.markets[request.symbol].id,
			...(isFutures
				? isConditional
					? { clientAlgoId: request.clientOrderId }
					: { origClientOrderId: request.clientOrderId }
				: { origClientOrderId: request.clientOrderId }),
		});
		return parseMarketOrder(exchange, raw, request.symbol);
	};
	if (!isFutures || request.conditional === true) return lookup(request.conditional === true);
	try {
		return await lookup(false);
	} catch (error) {
		if (!isOrderNotFound(error)) throw error;
		return lookup(true);
	}
}

function exposureRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function matchingSpotMarket(exchange: Exchange, quoteCurrency: string, symbol: unknown): boolean | undefined {
	if (typeof symbol !== "string") return undefined;
	const market = exchange.markets[symbol] as ExposureMarket | undefined;
	if (!market) return undefined;
	if (market.spot !== true || typeof market.quote !== "string") return undefined;
	return market.quote === quoteCurrency;
}

function matchingLinearFuturesMarket(exchange: Exchange, quoteCurrency: string, symbol: unknown): boolean | undefined {
	if (typeof symbol !== "string") return undefined;
	const market = exchange.markets[symbol] as ExposureMarket | undefined;
	if (!market) return undefined;
	if (
		market.contract !== true ||
		market.swap !== true ||
		typeof market.linear !== "boolean" ||
		typeof market.inverse !== "boolean" ||
		typeof market.quote !== "string" ||
		typeof market.settle !== "string"
	)
		return undefined;
	if (!market.linear || market.inverse) return false;
	return market.quote === quoteCurrency && market.settle === quoteCurrency;
}

function hasMatchingExposureOrder(order: unknown, marketMatch: (symbol: unknown) => boolean | undefined): boolean {
	const record = exposureRecord(order);
	if (!record) return true;
	const match = marketMatch(record.symbol);
	return match === undefined || match;
}

async function hasBinanceSpotExposure(exchange: Exchange, quoteCurrency: string): Promise<boolean> {
	await exchange.loadMarkets();
	const openOrders = await exchange.fetchOpenOrders(undefined, undefined, undefined, { type: "spot" });
	if (
		openOrders.some((order) =>
			hasMatchingExposureOrder(order, (symbol) => matchingSpotMarket(exchange, quoteCurrency, symbol)),
		)
	) {
		return true;
	}
	const balance = await exchange.fetchBalance({ type: "spot" });
	const total = exposureRecord((balance as { total?: unknown }).total);
	if (!total) return true;
	for (const [asset, rawAmount] of Object.entries(total)) {
		const amount = finiteNumber(rawAmount);
		if (amount === undefined) return true;
		if (asset !== quoteCurrency && amount !== 0) return true;
	}
	return false;
}

async function hasBinanceFuturesExposure(exchange: Exchange, quoteCurrency: string): Promise<boolean> {
	await exchange.loadMarkets();
	const match = (symbol: unknown) => matchingLinearFuturesMarket(exchange, quoteCurrency, symbol);
	const openOrders = await exchange.fetchOpenOrders(undefined, undefined, undefined, { type: BINANCE_USDM_TYPE });
	if (openOrders.some((order) => hasMatchingExposureOrder(order, match))) return true;
	const conditionalOrders = await exchange.fetchOpenOrders(undefined, undefined, undefined, {
		type: BINANCE_USDM_TYPE,
		trigger: true,
	});
	if (conditionalOrders.some((order) => hasMatchingExposureOrder(order, match))) return true;
	const positions = await exchange.fetchPositions(undefined, { type: BINANCE_USDM_TYPE });
	for (const position of positions) {
		const record = exposureRecord(position);
		if (!record) return true;
		const matches = match(record.symbol);
		if (matches === false) continue;
		if (matches === undefined) return true;
		const info = exposureRecord(record.info);
		const rawContracts = [record.contracts, info?.positionAmt, info?.contracts].filter(
			(value) => value !== undefined,
		);
		if (rawContracts.length === 0) return true;
		for (const rawContract of rawContracts) {
			const contracts = finiteNumber(rawContract);
			if (contracts === undefined) return true;
			if (contracts !== 0) return true;
		}
	}
	return false;
}

function validateBinanceSpotPlacement(request: VenueSpotFilterRequest): void {
	const ordinaryMarket = request.type === "market";
	if (request.type === "oco") {
		validateBinanceSpotFilters(request.marketInfo, request.amount, "lot", [
			{ label: "stopLossPrice", value: request.stopLossPrice ?? 0, notionalReference: true },
			{ label: "takeProfitPrice", value: request.takeProfitPrice ?? 0, notionalReference: true },
		]);
		return;
	}
	validateBinanceSpotFilters(
		request.marketInfo,
		request.amount,
		ordinaryMarket ? "market" : "lot",
		[
			...(request.price !== undefined ? [{ label: "Price", value: request.price, notionalReference: true }] : []),
			...(request.stopPrice !== undefined ? [{ label: "stopPrice", value: request.stopPrice }] : []),
		],
		{ marketOrder: ordinaryMarket, marketReference: request.last },
	);
}

export const BINANCE_LIVE_VENUE: LiveVenueProfile = {
	id: "binance",
	password: "unused",
	liveCapabilities: [
		{
			id: "binance-spot",
			label: "Binance Spot",
			marketFamily: "spot",
			orderTypes: BINANCE_ORDER_TYPES,
			ocoSides: ["sell"],
			limitations: LIVE_ADAPTER_LIMITATIONS,
			references: ["src/capabilities.test.ts", "src/ccxt-client.test.ts", "src/ccxt-binance-spot.ts"],
		},
		{
			id: "binance-usdm",
			label: "Binance USDⓈ-M futures",
			marketFamily: "futures",
			orderTypes: BINANCE_ORDER_TYPES,
			ocoSides: [],
			limitations: LIVE_ADAPTER_LIMITATIONS,
			references: ["src/capabilities.test.ts", "src/ccxt-client.test.ts", "src/contract-size.test.ts"],
		},
	],
	orderHistoryMode: "fetch-orders-by-symbol",
	orderHistoryRequiresSymbol: true,
	skipGenericSpotAmountCostLimits: true,
	ccxtOptions: () => ({ adjustForTimeDifference: true, recvWindow: 10_000 }),
	extraOrderListParams: (marketType: MarketType) =>
		marketType === "usdm-futures"
			? { open: [FUTURES_TRIGGER], history: [FUTURES_TRIGGER], closed: [], canceled: [] }
			: emptyOrderListParams(),
	cancelRetryParams: () => ALGO_ORDER_RETRY_PARAMS,
	clientOrderIdParam: (marketType) => (marketType === "spot" ? "newClientOrderId" : "clientOrderId"),
	supportsNativeOrderList: (marketType) => marketType === "spot",
	validateClientOrderId: validateBinanceClientOrderId,
	wireMapping: binanceWireMapping,
	futuresNativeIdAmbiguous: (orderType) => orderType !== "market" && orderType !== "limit",
	clientIdLookupNotes: (marketFamily) =>
		marketFamily === "futures"
			? [
					"Ordinary orders use origClientOrderId; conditional/trailing Algo orders use clientAlgoId",
					"Offline Algo lookup contracts cover correlated parent orders, not terminal child fills; missing fill evidence must remain unresolved",
				]
			: [],
	closePositionQuantityConstraint: (marketFamily, type) =>
		marketFamily === "futures" && type !== "market" ? BINANCE_CLOSE_ALL : CLOSE_USES_POSITION_SNAPSHOT,
	hedgeReductionConstraint: (positionMode) => (positionMode === "hedge" ? BINANCE_HEDGE_REDUCTION : undefined),
	trailingSpotConstraints: () => [
		"Binance trailingPercent must convert to integer BIPS within the market TRAILING_DELTA filter",
	],
	orderTypeMetadataNames: (marketFamily, type) =>
		marketFamily === "spot" && type === "trailing_stop_market"
			? ["trailing_stop_market", "take_profit_market"]
			: [type],
	unsupportedOcoSideReason: (side: OrderSide) => (side === "buy" ? BINANCE_OCO_BUY_UNSUPPORTED : undefined),
	quantityClosePositionNote: () => BINANCE_QUANTITY_CLOSE_NOTE,
	fetchParsedOrder: fetchBinanceParsedOrder,
	fetchParsedOrderByClientId: fetchBinanceParsedOrderByClientId,
	fetchNativeOrderList: async (exchange, query) => {
		const raw = await privateEndpoint(
			exchange,
			"privateGetOrderList",
			"Binance ccxt adapter does not expose the Spot order-list query endpoint",
		)(query);
		return raw as Record<string, unknown>;
	},
	cancelNativeOrderList: async (exchange, orderListId, symbol) => {
		const methods = exchange as unknown as Record<string, unknown>;
		const endpoint = methods.privateDeleteOrderList ?? methods.privateDeleteOrderOco;
		if (typeof endpoint !== "function")
			throw new Error("Binance ccxt adapter does not expose a Spot order-list cancellation endpoint");
		await (endpoint as (params: Record<string, string>) => Promise<unknown>).call(exchange, {
			symbol: exchange.markets[symbol].id,
			orderListId,
		});
	},
	validateSpotPlacement: validateBinanceSpotPlacement,
	assertNativeSpotTrailing: assertBinanceSpotTrailingOrder,
	placeNativeSpotTrailing: async (exchange, request) => {
		assertBinanceSpotTrailingOrder(exchange, request.symbol, request.side, request.trailingPercent);
		const raw = await createBinanceSpotTrailingOrder(
			exchange,
			request.symbol,
			request.side,
			request.amount,
			request.trailingPercent,
			request.stopPrice,
			request.clientOrderId,
		);
		return binanceRawOrderToOrder(
			raw,
			request.symbol,
			request.side,
			request.amount,
			request.trailingPercent,
			request.clientOrderId,
		);
	},
	placeNativeSpotOco: async (exchange, request: VenueNativeOcoRequest) => {
		const raw = await createBinanceSpotOco(
			exchange,
			request.symbol,
			request.side,
			request.amount,
			request.stopLossPrice,
			request.takeProfitPrice,
			request.listClientOrderId,
			request.aboveClientOrderId,
			request.belowClientOrderId,
		);
		const reports = Array.isArray(raw?.orderReports) ? raw.orderReports : [];
		if (reports.length !== 2 || reports.some((report) => !report || typeof report !== "object")) {
			throw new Error("Binance Spot OCO response must contain exactly two orderReports");
		}
		const orderListId = raw?.orderListId;
		if (orderListId === undefined || String(orderListId) === "-1") {
			throw new Error("Binance Spot OCO response is missing a valid orderListId");
		}
		if (
			raw.listClientOrderId !== request.listClientOrderId ||
			new Set(reports.map((report) => (report as Record<string, unknown>).clientOrderId)).size !== 2 ||
			reports.some((value) => {
				const report = value as Record<string, unknown>;
				return (
					![request.aboveClientOrderId, request.belowClientOrderId].includes(String(report.clientOrderId)) ||
					(report.symbol !== undefined && report.symbol !== request.marketId) ||
					(report.side !== undefined && report.side !== request.side.toUpperCase()) ||
					(report.origQty !== undefined && Number(report.origQty) !== request.amount) ||
					(report.orderListId !== undefined && String(report.orderListId) !== String(orderListId))
				);
			})
		)
			throw new Error("Binance Spot OCO response contains conflicting list or leg evidence");
		const ocoGroup = String(orderListId);
		const listStatus = typeof raw?.listOrderStatus === "string" ? raw.listOrderStatus : undefined;
		return {
			orders: reports.map((report) => ({
				...binanceReportToOrder(report, request.symbol, request.side, request.amount, ocoGroup, listStatus),
				listClientOrderId: request.listClientOrderId,
			})),
		};
	},
	probeOppositeWallet: async (exchange, request) =>
		request.marketType === "spot"
			? hasBinanceFuturesExposure(exchange, request.quoteCurrency)
			: hasBinanceSpotExposure(exchange, request.quoteCurrency),
	setMultiAssetsMargin: async (exchange, enabled) => {
		const binancePrivate = exchange as Exchange & {
			fapiPrivatePostMultiAssetsMargin(params: { multiAssetsMargin: "true" | "false" }): Promise<unknown>;
		};
		await binancePrivate.fapiPrivatePostMultiAssetsMargin({ multiAssetsMargin: enabled ? "true" : "false" });
	},
	closeAllPlaceholderAmount: (exchange, symbol, amount, market) => {
		const contractSize = contractSizeForMarket(market);
		const requestedContracts = market.contract ? amount / contractSize : amount;
		if (!Number.isFinite(requestedContracts) || requestedContracts <= 0) {
			throw new Error(`Amount ${amount} cannot produce a positive close-all placeholder for ${symbol}`);
		}
		const requestedPrecision = Number(exchange.amountToPrecision(symbol, requestedContracts));
		if (Number.isFinite(requestedPrecision) && requestedPrecision > 0) return requestedPrecision;
		const candidates = [market.limits?.amount?.min, 1];
		for (const candidate of candidates) {
			if (candidate === undefined || !Number.isFinite(candidate) || candidate <= 0) continue;
			const precise = Number(exchange.amountToPrecision(symbol, candidate));
			if (Number.isFinite(precise) && precise > 0) return precise;
		}
		throw new Error(`No positive exchange amount placeholder is available for Binance close-all trigger ${symbol}`);
	},
};
