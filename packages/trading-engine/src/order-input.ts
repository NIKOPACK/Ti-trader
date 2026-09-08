import type { PlaceOrderInput } from "./types.ts";

export interface ValidatedOrderInput {
	isLimitExecution: boolean;
	isTrigger: boolean;
}

/** Validate exchange-independent order fields before loading exchange metadata. */
export function validateOrderInput(input: PlaceOrderInput): ValidatedOrderInput {
	if (input.side !== "buy" && input.side !== "sell") throw new Error("Order side must be buy or sell");
	if (
		!["market", "limit", "stop", "stop_market", "take_profit", "take_profit_market", "trailing_stop_market"].includes(
			input.type as string,
		)
	) {
		throw new Error(`Unsupported order type: ${String(input.type)}`);
	}
	if (!Number.isFinite(input.amount) || input.amount <= 0) throw new Error("Amount must be finite and positive");
	const isLimitExecution = input.type === "limit" || input.type === "stop" || input.type === "take_profit";
	const isTrigger =
		input.type === "stop" ||
		input.type === "stop_market" ||
		input.type === "take_profit" ||
		input.type === "take_profit_market";
	if (isLimitExecution && (input.price === undefined || !Number.isFinite(input.price) || input.price <= 0))
		throw new Error(`${input.type} orders require a finite positive price`);
	if (isTrigger && (input.stopPrice === undefined || !Number.isFinite(input.stopPrice) || input.stopPrice <= 0))
		throw new Error(`${input.type} orders require a finite positive stopPrice`);
	if (
		input.type === "trailing_stop_market" &&
		input.stopPrice !== undefined &&
		(!Number.isFinite(input.stopPrice) || input.stopPrice <= 0)
	)
		throw new Error("trailing_stop_market stopPrice must be finite and positive when provided");
	if (
		input.type === "trailing_stop_market" &&
		(input.trailingPercent === undefined ||
			!Number.isFinite(input.trailingPercent) ||
			input.trailingPercent <= 0 ||
			input.trailingPercent >= 100)
	)
		throw new Error("trailing_stop_market orders require a finite trailingPercent between 0 and 100");
	return { isLimitExecution, isTrigger };
}
