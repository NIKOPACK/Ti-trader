import type { FuturesPositionMode } from "./client-types.ts";
import type { OrderSide, OrderType } from "./types.ts";

export interface PaperOrder {
	id: string;
	symbol: string;
	side: OrderSide;
	type: OrderType;
	price?: number;
	/** Trigger price for stop / take-profit orders. */
	stopPrice?: number;
	/** Trailing distance in percent for trailing stops. */
	trailingPercent?: number;
	/** Peak (sell) or trough (buy) price observed since placement (trailing stops). */
	trailingExtreme?: number;
	/** Set once a stop/take_profit limit order's trigger has fired and it rests as a limit order. */
	triggered?: boolean;
	/** Unit price used to reserve quote funds for resting buy orders. */
	reservePrice?: number;
	/** Last time this order's trigger was evaluated against the market. */
	lastCheckedAt?: number;
	/** Orders sharing an ocoGroup form a one-cancels-the-other pair with a single shared reservation. */
	ocoGroup?: string;
	clientOrderId?: string;
	listClientOrderId?: string;
	positionSide?: "BOTH" | "LONG" | "SHORT";
	reduceOnly?: boolean;
	closePosition?: boolean;
	amount: number;
	filled: number;
	average?: number;
	cost: number;
	status: "open" | "closed" | "canceled";
	timestamp: number;
}

export interface FuturesLot {
	amount: number;
	price: number;
	leverage: number;
	marginType: "isolated" | "cross";
}

export interface FuturesEntry {
	amount: number;
	cost: number;
	/** Futures setting captured when this position entry was opened. */
	leverage?: number;
	marginType?: "isolated" | "cross";
	/** FIFO opening lots; absent only in legacy persisted entries. */
	lots?: FuturesLot[];
}

export interface PaperTrade {
	id: string;
	symbol: string;
	side: OrderSide;
	price: number;
	amount: number;
	cost: number;
	fee: number;
	realizedPnl?: number;
	positionSide?: "BOTH" | "LONG" | "SHORT";
	timestamp: number;
}

export interface PaperAccount {
	quote: string;
	/** asset -> free amount */
	balances: Record<string, number>;
	/** asset -> { amount, cost } for average-entry PnL */
	entries: Record<string, FuturesEntry>;
	orders: PaperOrder[];
	trades: PaperTrade[];
	realizedPnl: number;
	leverage?: number;
	marginType?: "isolated" | "cross";
	/** New futures settings are scoped by the canonical futures symbol. */
	leverageBySymbol?: Record<string, number>;
	marginTypeBySymbol?: Record<string, "isolated" | "cross">;
	positionMode?: FuturesPositionMode;
	createdAt: number;
}

export interface AccountTransaction {
	version: 1;
	account: PaperAccount;
	futuresAccount: PaperAccount;
}

const ORDER_SIDES = new Set<OrderSide>(["buy", "sell"]);
const ORDER_STATUSES = new Set<PaperOrder["status"]>(["open", "closed", "canceled"]);
const ORDER_TYPES = new Set<OrderType>([
	"market",
	"limit",
	"stop",
	"stop_market",
	"take_profit",
	"take_profit_market",
	"trailing_stop_market",
	"oco",
	"unknown",
]);
const POSITION_SIDES = new Set(["BOTH", "LONG", "SHORT"]);
const MARGIN_TYPES = new Set(["isolated", "cross"]);
const POSITION_MODES = new Set<FuturesPositionMode>(["one-way", "hedge"]);

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function accountError(path: string, message: string): Error {
	return new Error(`Invalid paper account in ${path}: ${message}`);
}

function finiteNumber(value: unknown, path: string, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw accountError(path, `${label} must be finite`);
	return value;
}

function nonNegativeNumber(value: unknown, path: string, label: string): number {
	const number = finiteNumber(value, path, label);
	if (number < 0) throw accountError(path, `${label} must be non-negative`);
	return number;
}

function positiveNumber(value: unknown, path: string, label: string): number {
	const number = finiteNumber(value, path, label);
	if (number <= 0) throw accountError(path, `${label} must be positive`);
	return number;
}

function optionalFinite(value: unknown, path: string, label: string): number | undefined {
	return value === undefined ? undefined : finiteNumber(value, path, label);
}

function optionalBoolean(value: unknown, path: string, label: string): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") throw accountError(path, `${label} must be a boolean`);
	return value;
}

function optionalString(value: unknown, path: string, label: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw accountError(path, `${label} must be a string`);
	return value;
}

function orderSide(value: unknown, path: string, label: string): OrderSide {
	if (typeof value !== "string" || !ORDER_SIDES.has(value as OrderSide)) {
		throw accountError(path, `${label} must be buy or sell`);
	}
	return value as OrderSide;
}

function positionSide(value: unknown, path: string, label: string): PaperOrder["positionSide"] {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !POSITION_SIDES.has(value)) {
		throw accountError(path, `${label} must be BOTH, LONG or SHORT`);
	}
	return value as PaperOrder["positionSide"];
}

function marginType(value: unknown, path: string, label: string): "isolated" | "cross" {
	if (typeof value !== "string" || !MARGIN_TYPES.has(value)) {
		throw accountError(path, `${label} must be isolated or cross`);
	}
	return value as "isolated" | "cross";
}

function parseLot(value: unknown, path: string, label: string): FuturesLot {
	if (!isRecord(value)) throw accountError(path, `${label} must be an object`);
	const leverage = finiteNumber(value.leverage, path, `${label}.leverage`);
	if (!Number.isInteger(leverage) || leverage < 1 || leverage > 125) {
		throw accountError(path, `${label}.leverage must be an integer from 1 to 125`);
	}
	return {
		amount: positiveNumber(value.amount, path, `${label}.amount`),
		price: positiveNumber(value.price, path, `${label}.price`),
		leverage,
		marginType: marginType(value.marginType, path, `${label}.marginType`),
	};
}

function parseEntry(value: unknown, path: string, label: string): FuturesEntry {
	if (!isRecord(value)) throw accountError(path, `${label} must be an object`);
	const leverage = optionalFinite(value.leverage, path, `${label}.leverage`);
	if (leverage !== undefined && (!Number.isInteger(leverage) || leverage < 1 || leverage > 125)) {
		throw accountError(path, `${label}.leverage must be an integer from 1 to 125`);
	}
	let lots: FuturesLot[] | undefined;
	if (value.lots !== undefined) {
		if (!Array.isArray(value.lots)) throw accountError(path, `${label}.lots must be an array`);
		lots = value.lots.map((lot, index) => parseLot(lot, path, `${label}.lots[${index}]`));
	}
	const amount = finiteNumber(value.amount, path, `${label}.amount`);
	const cost = nonNegativeNumber(value.cost, path, `${label}.cost`);
	if (amount === 0 && cost !== 0) throw accountError(path, `${label}.cost must be zero when amount is zero`);
	if (lots !== undefined) {
		const lotAmount = lots.reduce((sum, lot) => sum + lot.amount, 0);
		const lotCost = lots.reduce((sum, lot) => sum + lot.amount * lot.price, 0);
		const tolerance = Math.max(1e-12, Math.abs(amount) * 1e-9, cost * 1e-9);
		if (Math.abs(lotAmount - Math.abs(amount)) > tolerance) {
			throw accountError(path, `${label}.lots amounts must equal the absolute entry amount`);
		}
		if (Math.abs(lotCost - cost) > tolerance) {
			throw accountError(path, `${label}.lots cost must equal the entry cost`);
		}
	}
	return {
		amount,
		cost,
		leverage,
		marginType:
			value.marginType === undefined ? undefined : marginType(value.marginType, path, `${label}.marginType`),
		lots,
	};
}

function parseOrder(value: unknown, path: string, label: string): PaperOrder {
	if (!isRecord(value)) throw accountError(path, `${label} must be an object`);
	if (typeof value.id !== "string" || value.id.length === 0) throw accountError(path, `${label}.id must be a string`);
	if (typeof value.symbol !== "string" || value.symbol.length === 0) {
		throw accountError(path, `${label}.symbol must be a string`);
	}
	if (typeof value.type !== "string" || !ORDER_TYPES.has(value.type as OrderType)) {
		throw accountError(path, `${label}.type is not a supported order type`);
	}
	if (typeof value.status !== "string" || !ORDER_STATUSES.has(value.status as PaperOrder["status"])) {
		throw accountError(path, `${label}.status must be open, closed or canceled`);
	}
	const amount = positiveNumber(value.amount, path, `${label}.amount`);
	const filled = nonNegativeNumber(value.filled, path, `${label}.filled`);
	if (filled > amount) throw accountError(path, `${label}.filled cannot exceed amount`);
	const price = optionalFinite(value.price, path, `${label}.price`);
	const stopPrice = optionalFinite(value.stopPrice, path, `${label}.stopPrice`);
	const trailingPercent = optionalFinite(value.trailingPercent, path, `${label}.trailingPercent`);
	const trailingExtreme = optionalFinite(value.trailingExtreme, path, `${label}.trailingExtreme`);
	const reservePrice = optionalFinite(value.reservePrice, path, `${label}.reservePrice`);
	const average = optionalFinite(value.average, path, `${label}.average`);
	if (price !== undefined && price <= 0) throw accountError(path, `${label}.price must be positive`);
	if (stopPrice !== undefined && stopPrice <= 0) throw accountError(path, `${label}.stopPrice must be positive`);
	if (trailingPercent !== undefined && (trailingPercent <= 0 || trailingPercent >= 100)) {
		throw accountError(path, `${label}.trailingPercent must be between 0 and 100`);
	}
	if (trailingExtreme !== undefined && trailingExtreme <= 0)
		throw accountError(path, `${label}.trailingExtreme must be positive`);
	if (reservePrice !== undefined && reservePrice <= 0)
		throw accountError(path, `${label}.reservePrice must be positive`);
	if (average !== undefined && average <= 0) throw accountError(path, `${label}.average must be positive`);
	return {
		id: value.id,
		symbol: value.symbol,
		side: orderSide(value.side, path, `${label}.side`),
		type: value.type as OrderType,
		price,
		stopPrice,
		trailingPercent,
		trailingExtreme,
		triggered: optionalBoolean(value.triggered, path, `${label}.triggered`),
		reservePrice,
		lastCheckedAt: optionalFinite(value.lastCheckedAt, path, `${label}.lastCheckedAt`),
		ocoGroup: optionalString(value.ocoGroup, path, `${label}.ocoGroup`),
		clientOrderId: optionalString(value.clientOrderId, path, `${label}.clientOrderId`),
		listClientOrderId: optionalString(value.listClientOrderId, path, `${label}.listClientOrderId`),
		positionSide: positionSide(value.positionSide, path, `${label}.positionSide`),
		reduceOnly: optionalBoolean(value.reduceOnly, path, `${label}.reduceOnly`),
		closePosition: optionalBoolean(value.closePosition, path, `${label}.closePosition`),
		amount,
		filled,
		average,
		cost: nonNegativeNumber(value.cost, path, `${label}.cost`),
		status: value.status as PaperOrder["status"],
		timestamp: finiteNumber(value.timestamp, path, `${label}.timestamp`),
	};
}

function parseTrade(value: unknown, path: string, label: string): PaperTrade {
	if (!isRecord(value)) throw accountError(path, `${label} must be an object`);
	if (typeof value.id !== "string" || value.id.length === 0) throw accountError(path, `${label}.id must be a string`);
	if (typeof value.symbol !== "string" || value.symbol.length === 0) {
		throw accountError(path, `${label}.symbol must be a string`);
	}
	const price = positiveNumber(value.price, path, `${label}.price`);
	const amount = positiveNumber(value.amount, path, `${label}.amount`);
	const cost = nonNegativeNumber(value.cost, path, `${label}.cost`);
	const fee = nonNegativeNumber(value.fee, path, `${label}.fee`);
	return {
		id: value.id,
		symbol: value.symbol,
		side: orderSide(value.side, path, `${label}.side`),
		price,
		amount,
		cost,
		fee,
		realizedPnl: optionalFinite(value.realizedPnl, path, `${label}.realizedPnl`),
		positionSide: positionSide(value.positionSide, path, `${label}.positionSide`),
		timestamp: finiteNumber(value.timestamp, path, `${label}.timestamp`),
	};
}

function parseNumberRecord(value: unknown, path: string, label: string): Record<string, number> {
	if (
		!isRecord(value) ||
		Object.values(value).some((amount) => typeof amount !== "number" || !Number.isFinite(amount))
	) {
		throw accountError(path, `${label} must contain finite numbers`);
	}
	return Object.fromEntries(Object.entries(value).map(([key, amount]) => [key, amount as number]));
}

function parseLeverageBySymbol(value: unknown, path: string): Record<string, number> | undefined {
	if (value === undefined) return undefined;
	const record = parseNumberRecord(value, path, "leverageBySymbol");
	for (const [symbol, leverage] of Object.entries(record)) {
		if (!Number.isInteger(leverage) || leverage < 1 || leverage > 125) {
			throw accountError(path, `leverageBySymbol.${symbol} must be an integer from 1 to 125`);
		}
	}
	return record;
}

function parseMarginTypeBySymbol(value: unknown, path: string): Record<string, "isolated" | "cross"> | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw accountError(path, "marginTypeBySymbol must be an object");
	return Object.fromEntries(
		Object.entries(value).map(([symbol, type]) => [symbol, marginType(type, path, `marginTypeBySymbol.${symbol}`)]),
	);
}

/** Validate a persisted paper ledger. Unknown extra fields are dropped. */
export function parsePaperAccount(value: unknown, path: string): PaperAccount {
	if (!isRecord(value)) throw accountError(path, "expected an object");
	if (typeof value.quote !== "string" || value.quote.length === 0) throw accountError(path, "quote is missing");
	if (!isRecord(value.entries) || !Array.isArray(value.orders) || !Array.isArray(value.trades)) {
		throw accountError(path, "entries, orders and trades are required");
	}
	const leverage = optionalFinite(value.leverage, path, "leverage");
	if (leverage !== undefined && (!Number.isInteger(leverage) || leverage < 1 || leverage > 125)) {
		throw accountError(path, "leverage must be an integer from 1 to 125");
	}
	if (value.positionMode !== undefined) {
		if (typeof value.positionMode !== "string" || !POSITION_MODES.has(value.positionMode as FuturesPositionMode)) {
			throw accountError(path, "positionMode must be one-way or hedge");
		}
	}
	return {
		quote: value.quote,
		balances: parseNumberRecord(value.balances, path, "balances"),
		entries: Object.fromEntries(
			Object.entries(value.entries).map(([asset, entry]) => [asset, parseEntry(entry, path, `entries.${asset}`)]),
		),
		orders: value.orders.map((order, index) => parseOrder(order, path, `orders[${index}]`)),
		trades: value.trades.map((trade, index) => parseTrade(trade, path, `trades[${index}]`)),
		realizedPnl: finiteNumber(value.realizedPnl, path, "realizedPnl"),
		leverage,
		marginType: value.marginType === undefined ? undefined : marginType(value.marginType, path, "marginType"),
		leverageBySymbol: parseLeverageBySymbol(value.leverageBySymbol, path),
		marginTypeBySymbol: parseMarginTypeBySymbol(value.marginTypeBySymbol, path),
		positionMode: value.positionMode as FuturesPositionMode | undefined,
		createdAt: finiteNumber(value.createdAt, path, "createdAt"),
	};
}

export function freshSpotAccount(quote: string, startQuote: number): PaperAccount {
	return {
		quote,
		balances: { [quote]: startQuote },
		entries: {},
		orders: [],
		trades: [],
		realizedPnl: 0,
		createdAt: Date.now(),
	};
}

export function freshFuturesAccount(
	quote: string,
	startQuote: number,
	leverage: number,
	marginTypeValue: "isolated" | "cross",
	positionMode: FuturesPositionMode,
): PaperAccount {
	return {
		quote,
		balances: { [quote]: startQuote },
		entries: {},
		orders: [],
		trades: [],
		realizedPnl: 0,
		leverage,
		marginType: marginTypeValue,
		positionMode,
		createdAt: Date.now(),
	};
}

export function maxPersistedOrderId(accounts: PaperAccount[]): number {
	let max = 0;
	for (const account of accounts) {
		for (const record of [...account.orders, ...account.trades]) {
			const id = typeof record.id === "string" ? Number(record.id) : Number.NaN;
			if (!Number.isFinite(id) || !Number.isSafeInteger(id) || id < 0) continue;
			max = Math.max(max, id);
		}
	}
	return max + 1;
}
