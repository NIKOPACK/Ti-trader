import type { Order, Position } from "./types.ts";

export function reduceSide(position: Position): "buy" | "sell" {
	return position.positionSide === "SHORT" || position.amount < 0 ? "buy" : "sell";
}

function hasStopComponent(order: Order): boolean {
	return order.type === "oco" || order.type.includes("stop");
}

export function protectionCoverage(
	order: Order,
	position: Position,
	coveragePct = 95,
	positionMode: "one-way" | "hedge" = "one-way",
): "protected" | "partial" | "none" {
	if (positionMode === "hedge" && order.positionSide !== position.positionSide) return "none";
	if (order.symbol !== position.symbol || order.side !== reduceSide(position) || !hasStopComponent(order))
		return "none";
	const amount = Math.abs(position.amount);
	if (amount <= 0) return "none";
	if (order.closePosition === true) return "protected";
	const remaining = Math.max(0, Math.abs(order.amount) - Math.max(0, order.filled));
	if (remaining <= 0) return "none";
	return remaining >= amount * (coveragePct / 100) ? "protected" : "partial";
}

export function isProtection(
	order: Order,
	position: Position,
	coveragePct = 95,
	positionMode: "one-way" | "hedge" = "one-way",
): boolean {
	return protectionCoverage(order, position, coveragePct, positionMode) === "protected";
}
