import type { Order as CcxtOrder, Exchange } from "ccxt";
import type { VenueClientOrderRequest } from "./types.ts";

export async function fetchCcxtParsedOrder(
	exchange: Exchange,
	venueId: string,
	id: string,
	symbol: string,
): Promise<CcxtOrder> {
	if (!exchange.has.fetchOrder) throw new Error(`Order lookup is unsupported on ${venueId}`);
	return exchange.fetchOrder(id, symbol);
}

export async function fetchCcxtParsedOrderByClientId(
	exchange: Exchange,
	request: VenueClientOrderRequest,
): Promise<CcxtOrder> {
	const capability = exchange.has.fetchOrderWithClientOrderId;
	if (capability !== true && capability !== "emulated") {
		throw new Error(`Client id lookup is unsupported on ${request.venueId}`);
	}
	if (typeof exchange.fetchOrderWithClientOrderId !== "function") {
		throw new Error(`Client id lookup method is unavailable on ${request.venueId}`);
	}
	return exchange.fetchOrderWithClientOrderId(request.clientOrderId, request.symbol);
}
