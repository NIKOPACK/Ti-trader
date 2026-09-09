/**
 * Child-only order proposal tools. They never create an exchange client or
 * submit. The parent must check_order then buy/sell to actually place.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const PROPOSE_ORDER_TOOL = "propose_order";

const orderTypes = [
	"market",
	"limit",
	"stop",
	"stop_market",
	"take_profit",
	"take_profit_market",
	"trailing_stop_market",
] as const;

export type ProposedOrderType = (typeof orderTypes)[number];

export type ProposedOrder = {
	submitted: false;
	pendingParent: true;
	side: "buy" | "sell";
	symbol: string;
	type: ProposedOrderType;
	amount?: number;
	quoteAmount?: number;
	price?: number;
	stopPrice?: number;
	trailingPercent?: number;
	reduceOnly?: boolean;
	positionSide?: "BOTH" | "LONG" | "SHORT";
	closePosition?: boolean;
	rationale?: string;
};

const parameters = Type.Object({
	side: Type.Union([Type.Literal("buy"), Type.Literal("sell")], {
		description: "Order direction. Queued for the parent; not submitted.",
	}),
	symbol: Type.String({ minLength: 3, description: "ccxt symbol, e.g. BTC/USDT" }),
	type: Type.Union(
		[
			Type.Literal("market"),
			Type.Literal("limit"),
			Type.Literal("stop"),
			Type.Literal("stop_market"),
			Type.Literal("take_profit"),
			Type.Literal("take_profit_market"),
			Type.Literal("trailing_stop_market"),
		],
		{ description: "Order type. Parent re-validates before submission." },
	),
	amount: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "Base amount, e.g. 0.01 BTC" })),
	quoteAmount: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "Quote amount, e.g. 100 USDT" })),
	price: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "Limit price when required" })),
	stopPrice: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "Trigger price when required" })),
	trailingPercent: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 99 })),
	reduceOnly: Type.Optional(Type.Boolean()),
	positionSide: Type.Optional(Type.Union([Type.Literal("BOTH"), Type.Literal("LONG"), Type.Literal("SHORT")])),
	closePosition: Type.Optional(Type.Boolean()),
	rationale: Type.Optional(Type.String({ maxLength: 400, description: "Why the parent should consider this order" })),
});

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function optionalFinite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function buildProposedOrder(params: {
	side: "buy" | "sell";
	symbol: string;
	type: ProposedOrderType;
	amount?: number;
	quoteAmount?: number;
	price?: number;
	stopPrice?: number;
	trailingPercent?: number;
	reduceOnly?: boolean;
	positionSide?: "BOTH" | "LONG" | "SHORT";
	closePosition?: boolean;
	rationale?: string;
}): ProposedOrder {
	const symbol = params.symbol.trim().toUpperCase();
	if (!symbol.includes("/")) throw new Error("symbol must be ccxt format, e.g. BTC/USDT");
	if (params.amount === undefined && params.quoteAmount === undefined) {
		throw new Error("propose_order requires amount or quoteAmount");
	}
	if (
		(params.type === "limit" || params.type === "stop" || params.type === "take_profit") &&
		params.price === undefined
	) {
		throw new Error(`${params.type} requires price`);
	}
	return {
		submitted: false,
		pendingParent: true,
		side: params.side,
		symbol,
		type: params.type,
		amount: params.amount,
		quoteAmount: params.quoteAmount,
		price: params.price,
		stopPrice: params.stopPrice,
		trailingPercent: params.trailingPercent,
		reduceOnly: params.reduceOnly,
		positionSide: params.positionSide,
		closePosition: params.closePosition,
		rationale: params.rationale?.trim() || undefined,
	};
}

export function extractProposedOrder(result: unknown): ProposedOrder | undefined {
	const record = asRecord(result);
	if (!record) return undefined;
	const details = asRecord(record.details) ?? record;
	if (details.submitted !== false || details.pendingParent !== true) return undefined;
	if (details.side !== "buy" && details.side !== "sell") return undefined;
	if (typeof details.symbol !== "string" || typeof details.type !== "string") return undefined;
	if (!(orderTypes as readonly string[]).includes(details.type)) return undefined;
	try {
		return buildProposedOrder({
			side: details.side,
			symbol: details.symbol,
			type: details.type as ProposedOrderType,
			amount: optionalFinite(details.amount),
			quoteAmount: optionalFinite(details.quoteAmount),
			price: optionalFinite(details.price),
			stopPrice: optionalFinite(details.stopPrice),
			trailingPercent: optionalFinite(details.trailingPercent),
			reduceOnly: typeof details.reduceOnly === "boolean" ? details.reduceOnly : undefined,
			positionSide:
				details.positionSide === "BOTH" || details.positionSide === "LONG" || details.positionSide === "SHORT"
					? details.positionSide
					: undefined,
			closePosition: typeof details.closePosition === "boolean" ? details.closePosition : undefined,
			rationale: typeof details.rationale === "string" ? details.rationale : undefined,
		});
	} catch {
		return undefined;
	}
}

export function formatProposedOrders(proposals: readonly ProposedOrder[]): string {
	if (proposals.length === 0) return "";
	const lines = proposals.map((proposal, index) => {
		const qty = proposal.amount !== undefined ? `amount=${proposal.amount}` : `quoteAmount=${proposal.quoteAmount}`;
		const price = proposal.price !== undefined ? ` price=${proposal.price}` : "";
		return `${index + 1}. ${proposal.side} ${proposal.symbol} ${proposal.type} ${qty}${price} [not submitted]`;
	});
	return [
		"",
		"Proposed orders (not submitted). Parent must check_order then buy/sell to place them.",
		"Paper/unattended: parent buy/sell is the approval. Live/confirm: buy/sell waits for the operator.",
		...lines,
	].join("\n");
}

export default function childOrderExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: PROPOSE_ORDER_TOOL,
		label: "Propose Order",
		description:
			"Queue an order for the parent Ti agent. Does not submit, fill, reserve quota, or touch the exchange.",
		parameters,
		promptGuidelines: [
			"propose_order is not a fill. The parent must check_order then buy/sell.",
			"Never claim an order was placed or filled.",
		],
		async execute(_id, params) {
			const proposal = buildProposedOrder(params);
			return {
				content: [{ type: "text" as const, text: JSON.stringify(proposal, null, 2) }],
				details: proposal,
			};
		},
	});
}
