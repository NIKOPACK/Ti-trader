import {
	closeSync,
	existsSync,
	fstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import ccxt, { type Ticker as CcxtTicker, type Exchange } from "ccxt";
import type { FuturesPositionMode } from "./client-types.ts";
import {
	type Balance,
	type ContractStats,
	type ExchangeClient,
	type FundingRateRecord,
	type Kline,
	type MarketInfo,
	type Order,
	type OrderBook,
	type OrderList,
	type OrderType,
	type PlaceOcoOrderInput,
	type PlaceOcoOrderResult,
	type PlaceOrderInput,
	type PlaceOrderResult,
	type Position,
	type Ticker,
	timeframeDurationMs,
} from "./types.ts";

const PAPER_DIR = join(homedir(), ".ti-trader", "agent", "paper");
const ACCOUNT_LOCK_TIMEOUT_MS = 10_000;
const ACCOUNT_LOCK_STALE_MS = 60_000;
const ACCOUNT_LOCK_RETRY_MS = 10;

function readJsonFile<T>(path: string): T | undefined {
	if (!existsSync(path)) return undefined;
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

function writeJsonFile(path: string, data: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(temporaryPath, `${JSON.stringify(data, null, "\t")}\n`, "utf8");
	renameSync(temporaryPath, path);
}

interface PaperOrder {
	id: string;
	symbol: string;
	side: "buy" | "sell";
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

interface FuturesLot {
	amount: number;
	price: number;
	leverage: number;
	marginType: "isolated" | "cross";
}

interface FuturesEntry {
	amount: number;
	cost: number;
	/** Futures setting captured when this position entry was opened. */
	leverage?: number;
	marginType?: "isolated" | "cross";
	/** FIFO opening lots; absent only in legacy persisted entries. */
	lots?: FuturesLot[];
}

interface PaperAccount {
	quote: string;
	/** asset -> free amount */
	balances: Record<string, number>;
	/** asset -> { amount, cost } for average-entry PnL */
	entries: Record<string, FuturesEntry>;
	orders: PaperOrder[];
	trades: Array<{
		id: string;
		symbol: string;
		side: "buy" | "sell";
		price: number;
		amount: number;
		cost: number;
		fee: number;
		realizedPnl?: number;
		positionSide?: "BOTH" | "LONG" | "SHORT";
		timestamp: number;
	}>;
	realizedPnl: number;
	leverage?: number;
	marginType?: "isolated" | "cross";
	/** New futures settings are scoped by the canonical futures symbol. */
	leverageBySymbol?: Record<string, number>;
	marginTypeBySymbol?: Record<string, "isolated" | "cross">;
	positionMode?: FuturesPositionMode;
	createdAt: number;
}

interface AccountLock {
	fd: number;
	path: string;
	device: number;
	inode: number;
}

interface AccountTransaction {
	version: 1;
	account: PaperAccount;
	futuresAccount: PaperAccount;
}

function baseAsset(symbol: string, quote: string): string {
	const suffix = `/${quote}`;
	if (!symbol.endsWith(suffix)) {
		throw new Error(`Symbol "${symbol}" is not a ${quote} market`);
	}
	return symbol.slice(0, -suffix.length);
}

const TRIGGER_TYPES = ["stop", "stop_market", "take_profit", "take_profit_market"] as const;
type TriggerType = (typeof TRIGGER_TYPES)[number];

function isTriggerType(type: OrderType): type is TriggerType {
	return (TRIGGER_TYPES as readonly string[]).includes(type);
}

/**
 * Whether a stop/take-profit trigger fires at the given price.
 * stop: fires when the price moves against the position (sell: fall to trigger,
 * buy: rise to trigger). take_profit: fires when the price moves favourably
 * (sell: rise to trigger, buy: fall to trigger).
 */
function triggerFires(type: TriggerType, side: "buy" | "sell", price: number, stopPrice: number): boolean {
	const fallTo = type.startsWith("stop") ? side === "sell" : side === "buy";
	return fallTo ? price <= stopPrice : price >= stopPrice;
}

/** Current stop level of a trailing stop given its extreme price. */
function trailingStopLevel(side: "buy" | "sell", extreme: number, trailingPercent: number): number {
	return side === "sell" ? extreme * (1 - trailingPercent / 100) : extreme * (1 + trailingPercent / 100);
}

/**
 * A price-range segment of the market path since an order was last checked:
 * one kline (high/low) or the final ticker reading (a single point).
 */
interface PathSegment {
	high: number;
	low: number;
	/** True for the final single-price ticker segment. */
	tick?: boolean;
}

interface MarketPath {
	segments: PathSegment[];
	/** Latest timestamp through which the returned path is known to cover. */
	checkedAt: number;
}

/** Where along a path an order fired, and the price it fills at. */
interface PathFire {
	index: number;
	price: number;
}

type PriceLookup = { price: number } | { reason: string };

function isFinitePositive(value: number | undefined): value is number {
	return value !== undefined && Number.isFinite(value) && value > 0;
}

function fsErrorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

function isStaleAccountLock(path: string): boolean {
	try {
		return Date.now() - statSync(path).mtimeMs > ACCOUNT_LOCK_STALE_MS;
	} catch (error) {
		if (fsErrorCode(error) === "ENOENT") return false;
		throw error;
	}
}

function acquireAccountLockSync(path: string): AccountLock {
	mkdirSync(dirname(path), { recursive: true });
	const deadline = Date.now() + ACCOUNT_LOCK_TIMEOUT_MS;
	for (;;) {
		try {
			const fd = openSync(path, "wx", 0o600);
			try {
				const stats = fstatSync(fd);
				return { fd, path, device: stats.dev, inode: stats.ino };
			} catch (error) {
				try {
					closeSync(fd);
				} finally {
					try {
						unlinkSync(path);
					} catch {
						// Preserve the original fstat failure.
					}
				}
				throw error;
			}
		} catch (error) {
			if (fsErrorCode(error) !== "EEXIST") throw error;
			if (isStaleAccountLock(path)) {
				try {
					unlinkSync(path);
				} catch (unlinkError) {
					if (fsErrorCode(unlinkError) !== "ENOENT") throw unlinkError;
				}
				continue;
			}
			if (Date.now() >= deadline) throw new Error(`Timed out waiting for paper account lock ${path}`);
			const signal = new Int32Array(new SharedArrayBuffer(4));
			Atomics.wait(signal, 0, 0, ACCOUNT_LOCK_RETRY_MS);
		}
	}
}

async function acquireAccountLock(path: string): Promise<AccountLock> {
	mkdirSync(dirname(path), { recursive: true });
	const deadline = Date.now() + ACCOUNT_LOCK_TIMEOUT_MS;
	for (;;) {
		try {
			const fd = openSync(path, "wx", 0o600);
			try {
				const stats = fstatSync(fd);
				return { fd, path, device: stats.dev, inode: stats.ino };
			} catch (error) {
				try {
					closeSync(fd);
				} finally {
					try {
						unlinkSync(path);
					} catch {
						// Preserve the original fstat failure.
					}
				}
				throw error;
			}
		} catch (error) {
			if (fsErrorCode(error) !== "EEXIST") throw error;
			if (isStaleAccountLock(path)) {
				try {
					unlinkSync(path);
				} catch (unlinkError) {
					if (fsErrorCode(unlinkError) !== "ENOENT") throw unlinkError;
				}
				continue;
			}
			if (Date.now() >= deadline) throw new Error(`Timed out waiting for paper account lock ${path}`);
			await new Promise<void>((resolve) => setTimeout(resolve, ACCOUNT_LOCK_RETRY_MS));
		}
	}
}

function releaseAccountLock(lock: AccountLock): void {
	let failure: unknown;
	try {
		closeSync(lock.fd);
	} catch (error) {
		failure = error;
	}
	try {
		const stats = statSync(lock.path);
		if (stats.dev === lock.device && stats.ino === lock.inode) unlinkSync(lock.path);
	} catch (error) {
		if (fsErrorCode(error) !== "ENOENT" && failure === undefined) failure = error;
	}
	if (failure !== undefined) throw failure;
}

function touchAccountLock(lock: AccountLock): void {
	try {
		const stats = statSync(lock.path);
		if (stats.dev !== lock.device || stats.ino !== lock.inode) return;
		const now = new Date();
		utimesSync(lock.path, now, now);
	} catch {
		// The owner check in releaseAccountLock prevents deleting a lock that was
		// replaced by another process. A failed heartbeat is therefore handled by
		// the normal operation/release error path.
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePaperAccount(value: unknown, path: string): PaperAccount {
	if (!isRecord(value)) throw new Error(`Invalid paper account in ${path}: expected an object`);
	if (typeof value.quote !== "string" || value.quote.length === 0) {
		throw new Error(`Invalid paper account in ${path}: quote is missing`);
	}
	if (
		!isRecord(value.balances) ||
		Object.values(value.balances).some((amount) => typeof amount !== "number" || !Number.isFinite(amount))
	) {
		throw new Error(`Invalid paper account in ${path}: balances must contain finite numbers`);
	}
	if (!isRecord(value.entries) || !Array.isArray(value.orders) || !Array.isArray(value.trades)) {
		throw new Error(`Invalid paper account in ${path}: entries, orders and trades are required`);
	}
	if (typeof value.realizedPnl !== "number" || !Number.isFinite(value.realizedPnl)) {
		throw new Error(`Invalid paper account in ${path}: realizedPnl must be finite`);
	}
	if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) {
		throw new Error(`Invalid paper account in ${path}: createdAt must be finite`);
	}
	return structuredClone(value) as unknown as PaperAccount;
}

function freshSpotAccount(quote: string, startQuote: number): PaperAccount {
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

function freshFuturesAccount(
	quote: string,
	startQuote: number,
	leverage: number,
	marginType: "isolated" | "cross",
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
		marginType,
		positionMode,
		createdAt: Date.now(),
	};
}

function maxPersistedOrderId(accounts: PaperAccount[]): number {
	let max = 0;
	for (const account of accounts) {
		for (const record of [...account.orders, ...account.trades]) {
			const id = typeof record.id === "string" ? Number(record.id) : NaN;
			if (!Number.isFinite(id) || !Number.isSafeInteger(id) || id < 0) continue;
			max = Math.max(max, id);
		}
	}
	return max + 1;
}

/**
 * Simulated spot account backed by live public market data.
 * Market orders fill at the last trade price; resting limit, stop, take-profit
 * and trailing stop orders fill lazily (checked on every account read) once the
 * market price crosses their limit/trigger level.
 */
export class PaperExchangeClient implements ExchangeClient {
	readonly mode = "paper" as const;
	readonly id: string;
	readonly quoteCurrency: string;
	readonly feeRate: number;

	private readonly exchange: Exchange;
	private readonly futuresExchange: Exchange;
	private readonly marketType: "spot" | "usdm-futures" | "both";
	private readonly accountPath: string;
	private readonly futuresAccountPath: string;
	private readonly accountLockPath: string;
	private readonly transactionPath: string;
	private readonly initialStartQuote: number;
	private account: PaperAccount;
	private futuresAccount: PaperAccount;
	private nextOrderId: number;
	private futuresLeverage = 1;
	private futuresMarginType: "isolated" | "cross" = "isolated";
	private readonly positionMode: FuturesPositionMode;
	/**
	 * Account reads and writes share one queue so lazy settlement cannot run
	 * concurrently with another operation in this client. A file lock below
	 * extends the same invariant across separate Ti processes.
	 */
	private accountOperationQueue: Promise<void> = Promise.resolve();

	constructor(
		id: string,
		quoteCurrency: string,
		startQuote: number,
		feeRate: number,
		accountDir: string = PAPER_DIR,
		marketType: "spot" | "usdm-futures" | "both" = "spot",
		leverage = 1,
		marginType: "isolated" | "cross" = "isolated",
		positionMode: FuturesPositionMode = "one-way",
	) {
		this.id = id;
		this.quoteCurrency = quoteCurrency;
		this.feeRate = feeRate;
		this.marketType = marketType;
		this.positionMode = positionMode;
		this.initialStartQuote = startQuote;
		this.futuresLeverage = leverage;
		this.futuresMarginType = marginType;
		const ExchangeClass = (ccxt as unknown as Record<string, new (cfg: object) => Exchange>)[id];
		if (!ExchangeClass) {
			throw new Error(`Unknown exchange "${id}". Check https://docs.ccxt.com for supported ids.`);
		}
		this.exchange = new ExchangeClass({ enableRateLimit: true });
		this.futuresExchange = new ExchangeClass({ enableRateLimit: true, options: { defaultType: "swap" } });
		this.accountPath = join(accountDir, `${id}-${quoteCurrency}.json`);
		this.futuresAccountPath = join(accountDir, `${id}-${quoteCurrency}-futures.json`);
		this.accountLockPath = join(accountDir, `${id}-${quoteCurrency}.lock`);
		this.transactionPath = join(accountDir, `${id}-${quoteCurrency}.transaction.json`);

		const lock = acquireAccountLockSync(this.accountLockPath);
		try {
			this.recoverTransactionUnlocked();
			const stored = readJsonFile<unknown>(this.accountPath);
			const storedAccount = stored === undefined ? undefined : parsePaperAccount(stored, this.accountPath);
			// A file containing another quote belongs to a different account. Leave it
			// untouched until an explicit mutation chooses to replace it; startup must
			// never destroy data merely because the active quote changed.
			const accountNeedsPersist = storedAccount === undefined || storedAccount.quote !== quoteCurrency;
			const accountFileNeedsPersist = storedAccount === undefined;
			this.account = accountNeedsPersist ? freshSpotAccount(quoteCurrency, startQuote) : storedAccount;

			// A mismatched futures file is treated as absent and left untouched at
			// startup. It cannot be safely adopted under the configured quote.
			const storedFutures = readJsonFile<unknown>(this.futuresAccountPath);
			const parsedFutures =
				storedFutures === undefined ? undefined : parsePaperAccount(storedFutures, this.futuresAccountPath);
			const futuresNeedsPersist = parsedFutures === undefined || parsedFutures.quote !== quoteCurrency;
			const futuresFileNeedsPersist = parsedFutures === undefined;
			this.futuresAccount = futuresNeedsPersist
				? freshFuturesAccount(quoteCurrency, startQuote, leverage, marginType, positionMode)
				: parsedFutures;
			this.applyLoadedFuturesState(positionMode, leverage, marginType);
			this.nextOrderId = maxPersistedOrderId([this.account, this.futuresAccount]);

			if (accountFileNeedsPersist && futuresFileNeedsPersist && marketType !== "spot") this.persistAllUnlocked();
			else if (accountFileNeedsPersist) this.persistAccountsUnlocked(true, false);
			else if (futuresFileNeedsPersist && marketType !== "spot") this.persistAccountsUnlocked(false, true);
		} finally {
			releaseAccountLock(lock);
		}
	}

	private isFuturesSymbol(symbol: string): boolean {
		return symbol.endsWith(`/${this.quoteCurrency}:${this.quoteCurrency}`);
	}
	private exchangeFor(symbol: string): Exchange {
		const futures = this.isFuturesSymbol(symbol);
		if ((this.marketType === "spot" && futures) || (this.marketType === "usdm-futures" && !futures)) {
			throw new Error(`${futures ? "Futures" : "Spot"} markets are disabled in ${this.marketType} mode`);
		}
		return futures ? this.futuresExchange : this.exchange;
	}
	private accountForSymbol(symbol: string): PaperAccount {
		const futures = this.isFuturesSymbol(symbol);
		if (futures) {
			if (this.marketType === "spot") throw new Error("Futures markets are disabled in spot mode");
			baseAsset(symbol, `${this.quoteCurrency}:${this.quoteCurrency}`);
			return this.futuresAccount;
		}
		if (this.marketType === "usdm-futures") throw new Error("Spot markets are disabled in futures mode");
		baseAsset(symbol, this.quoteCurrency);
		return this.account;
	}
	private enabledAccounts(): PaperAccount[] {
		return this.marketType === "spot"
			? [this.account]
			: this.marketType === "usdm-futures"
				? [this.futuresAccount]
				: [this.account, this.futuresAccount];
	}

	private applyLoadedFuturesState(
		positionMode: FuturesPositionMode,
		defaultLeverage: number,
		defaultMarginType: "isolated" | "cross",
	): void {
		const storedPositionMode = this.futuresAccount.positionMode ?? "one-way";
		if (
			storedPositionMode !== positionMode &&
			Object.values(this.futuresAccount.entries).some((entry) => entry.amount !== 0)
		) {
			throw new Error(
				`Paper futures account contains ${storedPositionMode} positions; reset it before switching to ${positionMode} mode`,
			);
		}
		this.futuresLeverage = this.futuresAccount.leverage ?? defaultLeverage;
		this.futuresMarginType = this.futuresAccount.marginType ?? defaultMarginType;
		this.futuresAccount.positionMode = positionMode;
		// Legacy entries are upgraded in memory only. Persisting this snapshot is
		// deferred until an explicit account mutation, so startup remains read-only.
		for (const entry of Object.values(this.futuresAccount.entries)) {
			if (entry.amount === 0 || entry.lots !== undefined) continue;
			entry.lots = this.snapshotFuturesLots(entry);
		}
	}

	private reloadAccountsUnlocked(): void {
		this.recoverTransactionUnlocked();
		const stored = readJsonFile<unknown>(this.accountPath);
		if (stored === undefined) throw new Error(`Paper account state is missing: ${this.accountPath}`);
		const account = parsePaperAccount(stored, this.accountPath);
		if (account.quote !== this.quoteCurrency) {
			this.account = freshSpotAccount(this.quoteCurrency, this.account.balances[this.quoteCurrency] ?? 0);
			this.nextOrderId = maxPersistedOrderId([this.account, this.futuresAccount]);
			return;
		}
		const storedFutures = readJsonFile<unknown>(this.futuresAccountPath);
		if (storedFutures === undefined) {
			if (this.marketType !== "spot") {
				this.futuresAccount = freshFuturesAccount(
					this.quoteCurrency,
					this.initialStartQuote,
					this.futuresLeverage,
					this.futuresMarginType,
					this.positionMode,
				);
				this.applyLoadedFuturesState(this.positionMode, this.futuresLeverage, this.futuresMarginType);
			}
			this.account = account;
			this.nextOrderId = maxPersistedOrderId([this.account, this.futuresAccount]);
			return;
		}
		const futuresAccount = parsePaperAccount(storedFutures, this.futuresAccountPath);
		if (futuresAccount.quote !== this.quoteCurrency) {
			if (this.marketType !== "spot") {
				this.futuresAccount = freshFuturesAccount(
					this.quoteCurrency,
					this.initialStartQuote,
					this.futuresLeverage,
					this.futuresMarginType,
					this.positionMode,
				);
				this.applyLoadedFuturesState(this.positionMode, this.futuresLeverage, this.futuresMarginType);
			}
			this.account = account;
			this.nextOrderId = maxPersistedOrderId([this.account, this.futuresAccount]);
			return;
		}
		this.account = account;
		this.futuresAccount = futuresAccount;
		this.applyLoadedFuturesState(this.positionMode, this.futuresLeverage, this.futuresMarginType);
		this.nextOrderId = maxPersistedOrderId([this.account, this.futuresAccount]);
	}

	private recoverTransactionUnlocked(): void {
		if (!existsSync(this.transactionPath)) return;
		const raw = readJsonFile<unknown>(this.transactionPath);
		if (!isRecord(raw) || raw.version !== 1) {
			throw new Error(`Invalid paper account transaction in ${this.transactionPath}; manual recovery is required`);
		}
		const account = parsePaperAccount(raw.account, this.accountPath);
		const futuresAccount = parsePaperAccount(raw.futuresAccount, this.futuresAccountPath);
		if (account.quote !== this.quoteCurrency || futuresAccount.quote !== this.quoteCurrency) {
			throw new Error(`Paper account transaction quote does not match configured ${this.quoteCurrency}`);
		}
		// The journal is written before either target file. Replaying both snapshots
		// makes a crash between the two renames recoverable on the next operation.
		writeJsonFile(this.accountPath, account);
		writeJsonFile(this.futuresAccountPath, futuresAccount);
		unlinkSync(this.transactionPath);
	}

	private persistAccountsUnlocked(spot: boolean, futures: boolean): void {
		if (!spot && !futures) return;
		if (spot && futures) {
			const transaction: AccountTransaction = {
				version: 1,
				account: structuredClone(this.account),
				futuresAccount: structuredClone(this.futuresAccount),
			};
			// Keep the journal until both account files are durable. If the second
			// write fails, the next locked operation replays this exact snapshot.
			writeJsonFile(this.transactionPath, transaction);
			writeJsonFile(this.accountPath, this.account);
			writeJsonFile(this.futuresAccountPath, this.futuresAccount);
			unlinkSync(this.transactionPath);
			return;
		}
		if (spot) writeJsonFile(this.accountPath, this.account);
		if (futures) writeJsonFile(this.futuresAccountPath, this.futuresAccount);
	}

	private persistAllUnlocked(): void {
		this.persistAccountsUnlocked(true, true);
	}

	private runAccountOperation<T>(operation: () => Promise<T> | T): Promise<T> {
		const result = this.accountOperationQueue.then(async () => {
			const lock = await acquireAccountLock(this.accountLockPath);
			const heartbeat = setInterval(() => touchAccountLock(lock), ACCOUNT_LOCK_STALE_MS / 3);
			let operationResult: { completed: true; value: T } | { completed: false; error: unknown };
			try {
				this.reloadAccountsUnlocked();
				operationResult = { completed: true, value: await operation() };
			} catch (error) {
				operationResult = { completed: false, error };
			}
			clearInterval(heartbeat);
			let releaseError: unknown;
			try {
				releaseAccountLock(lock);
			} catch (error) {
				releaseError = error;
			}
			if (!operationResult.completed) {
				if (releaseError !== undefined) {
					throw new AggregateError(
						[operationResult.error, releaseError],
						"Paper account operation and lock release both failed",
					);
				}
				throw operationResult.error;
			}
			if (releaseError !== undefined) throw releaseError;
			return operationResult.value;
		});
		this.accountOperationQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
	private async validateFuturesMarket(symbol: string): Promise<void> {
		if (!this.isFuturesSymbol(symbol)) throw new Error("Futures settings require a futures symbol");
		this.accountForSymbol(symbol);
		await this.futuresExchange.loadMarkets();
		const market = this.futuresExchange.markets[symbol];
		if (
			!market ||
			market.quote !== this.quoteCurrency ||
			market.settle !== this.quoteCurrency ||
			market.swap !== true ||
			market.active !== true ||
			market.contract !== true ||
			market.linear !== true ||
			market.inverse === true
		) {
			throw new Error(`Unsupported futures market: ${symbol}`);
		}
		this.contractSizeForMarket(market);
	}

	private legacyFuturesSettings(): { leverage: number; marginType: "isolated" | "cross" } {
		return {
			leverage: this.futuresAccount.leverage ?? this.futuresLeverage,
			marginType: this.futuresAccount.marginType ?? this.futuresMarginType,
		};
	}

	private snapshotFuturesLots(entry: FuturesEntry): FuturesLot[] {
		if (entry.lots !== undefined) return entry.lots;
		if (entry.amount === 0) return [];
		const settings = this.legacyFuturesSettings();
		return [
			{
				amount: Math.abs(entry.amount),
				price: entry.cost / Math.abs(entry.amount),
				leverage: entry.leverage ?? settings.leverage,
				marginType: entry.marginType ?? settings.marginType,
			},
		];
	}

	/**
	 * Settings a position reports when every opening lot agrees on leverage and
	 * margin mode. A mixed position (same-direction adds or reversals executed
	 * under different settings) reports neither field rather than misquoting the
	 * first lot as if it applied to the whole position. The per-lot margin is
	 * always computed from each lot's own settings, so an omitted leverage or
	 * marginType never implies the position is risk-free or uniform.
	 */
	private uniformFuturesLotSettings(lots: FuturesLot[]): { leverage?: number; marginType?: "isolated" | "cross" } {
		if (lots.length === 0) return {};
		const firstLot = lots[0];
		if (
			lots.every((lot) => lot.leverage === firstLot.leverage) &&
			lots.every((lot) => lot.marginType === firstLot.marginType)
		) {
			return { leverage: firstLot.leverage, marginType: firstLot.marginType };
		}
		// Mixed positions intentionally report no leverage/margin mode instead of
		// pretending the first lot applies to the whole position.
		return {};
	}

	private futuresSettings(symbol: string): { leverage: number; marginType: "isolated" | "cross" } {
		return {
			leverage:
				this.futuresAccount.leverageBySymbol?.[symbol] ?? this.futuresAccount.leverage ?? this.futuresLeverage,
			marginType:
				this.futuresAccount.marginTypeBySymbol?.[symbol] ??
				this.futuresAccount.marginType ??
				this.futuresMarginType,
		};
	}

	private contractSizeForMarket(
		market: { contract?: boolean; linear?: boolean; contractSize?: number } | undefined,
	): number {
		if (!market?.contract) return 1;
		if (market.linear !== true) {
			throw new Error("Paper futures support only linear USDⓈ-M contracts");
		}
		const contractSize = market.contractSize;
		if (contractSize === undefined || !Number.isFinite(contractSize) || contractSize <= 0) {
			throw new Error("Futures market contractSize is unavailable; refusing to guess the amount unit");
		}
		return contractSize;
	}
	private baseAmountToContracts(
		symbol: string,
		amount: number,
		market: { contract?: boolean; linear?: boolean; contractSize?: number },
		exchange: Exchange,
	): { contracts: number; baseAmount: number } {
		const contractSize = this.contractSizeForMarket(market);
		if (!market.contract) return { contracts: amount, baseAmount: amount };
		const contracts = amount / contractSize;
		if (!Number.isFinite(contracts) || contracts <= 0) {
			throw new Error(`Amount ${amount} cannot be represented for ${symbol}`);
		}
		const preciseContracts = Number(exchange.amountToPrecision(symbol, contracts));
		if (!Number.isFinite(preciseContracts) || preciseContracts <= 0) {
			throw new Error(`Amount ${amount} rounds to zero contracts for ${symbol}`);
		}
		const baseAmount = preciseContracts * contractSize;
		const tolerance = Math.max(1e-12, Math.abs(amount) * 1e-9);
		if (Math.abs(baseAmount - amount) > tolerance) {
			throw new Error(
				`Amount ${amount} base units cannot be represented exactly as ${preciseContracts} contracts for ${symbol} (contractSize ${contractSize})`,
			);
		}
		return { contracts: preciseContracts, baseAmount };
	}
	private persistAll(): void {
		this.persistAllUnlocked();
	}

	private async normalizeOrderInput(input: PlaceOrderInput): Promise<PlaceOrderInput> {
		const exchange = this.exchangeFor(input.symbol);
		await exchange.loadMarkets();
		const market = exchange.markets[input.symbol];
		const futures = this.isFuturesSymbol(input.symbol);
		if (
			!market ||
			market.quote !== this.quoteCurrency ||
			(futures ? market.swap !== true : market.spot !== true) ||
			market.active === false
		) {
			throw new Error(`Unsupported ${futures ? "futures" : "spot"} market: ${input.symbol}`);
		}
		if (futures && market.contract !== true)
			throw new Error(`Futures market metadata is not a contract: ${input.symbol}`);
		const converted = futures
			? this.baseAmountToContracts(input.symbol, input.amount, market, exchange)
			: (() => {
					const baseAmount = Number(exchange.amountToPrecision(input.symbol, input.amount));
					return { contracts: baseAmount, baseAmount };
				})();
		const amount = converted.baseAmount;
		const exchangeAmount = converted.contracts;
		if (!Number.isFinite(amount) || amount <= 0) {
			throw new Error(`Amount ${input.amount} rounds to zero for ${input.symbol}`);
		}
		if (!Number.isFinite(exchangeAmount) || exchangeAmount <= 0) {
			throw new Error(`Amount ${input.amount} rounds to zero contracts for ${input.symbol}`);
		}
		const price =
			input.price === undefined ? undefined : Number(exchange.priceToPrecision(input.symbol, input.price));
		const stopPrice =
			input.stopPrice === undefined ? undefined : Number(exchange.priceToPrecision(input.symbol, input.stopPrice));
		const minAmount = market.limits?.amount?.min;
		const maxAmount = market.limits?.amount?.max;
		if (minAmount !== undefined && exchangeAmount < minAmount) {
			throw new Error(
				`${futures ? "Contract amount" : "Amount"} ${exchangeAmount} is below minimum ${minAmount} for ${input.symbol}`,
			);
		}
		if (maxAmount !== undefined && exchangeAmount > maxAmount) {
			throw new Error(
				`${futures ? "Contract amount" : "Amount"} ${exchangeAmount} exceeds maximum ${maxAmount} for ${input.symbol}`,
			);
		}
		const tickerPrice = (await exchange.fetchTicker(input.symbol)).last;
		const referencePrice = price ?? stopPrice ?? tickerPrice;
		if (referencePrice === undefined || !Number.isFinite(referencePrice) || referencePrice <= 0) {
			throw new Error(`No price available for ${input.symbol}`);
		}
		const cost = amount * referencePrice;
		const minCost = market.limits?.cost?.min;
		const maxCost = market.limits?.cost?.max;
		if (minCost !== undefined && cost < minCost) {
			throw new Error(`Order cost ${cost} is below minimum ${minCost} for ${input.symbol}`);
		}
		if (maxCost !== undefined && cost > maxCost) {
			throw new Error(`Order cost ${cost} exceeds maximum ${maxCost} for ${input.symbol}`);
		}
		return { ...input, amount, price, stopPrice };
	}

	async getTicker(symbol: string): Promise<Ticker> {
		if (this.marketType === "spot" && this.isFuturesSymbol(symbol))
			throw new Error("Futures markets are disabled in spot mode");
		if (this.marketType === "usdm-futures" && !this.isFuturesSymbol(symbol))
			throw new Error("Spot markets are disabled in futures mode");
		return toTicker(await this.exchangeFor(symbol).fetchTicker(symbol));
	}

	async getOrderBook(symbol: string, limit = 20): Promise<OrderBook> {
		const book = await this.exchangeFor(symbol).fetchOrderBook(symbol, limit);
		const bids = book.bids.flatMap(([price, amount]) =>
			price !== undefined && amount !== undefined ? [{ price, amount }] : [],
		);
		const asks = book.asks.flatMap(([price, amount]) =>
			price !== undefined && amount !== undefined ? [{ price, amount }] : [],
		);
		const bestBid = bids[0]?.price;
		const bestAsk = asks[0]?.price;
		const spread = bestBid !== undefined && bestAsk !== undefined ? bestAsk - bestBid : undefined;
		return {
			symbol,
			timestamp: book.timestamp ?? Date.now(),
			bids,
			asks,
			spread,
			spreadPct: spread !== undefined && bestBid ? (spread / bestBid) * 100 : undefined,
			bidDepth: bids.reduce((sum, level) => sum + level.amount, 0),
			askDepth: asks.reduce((sum, level) => sum + level.amount, 0),
		};
	}

	async getMarketInfo(symbol: string): Promise<MarketInfo> {
		const exchange = this.exchangeFor(symbol);
		await exchange.loadMarkets();
		const market = exchange.markets[symbol];
		const futures = this.isFuturesSymbol(symbol);
		if (
			(this.marketType === "spot" && futures) ||
			(this.marketType === "usdm-futures" && !futures) ||
			!market ||
			market.quote !== this.quoteCurrency ||
			(futures ? market.swap !== true : market.swap === true)
		)
			throw new Error(`Unsupported market: ${symbol}`);
		if (futures) {
			if (market.contract !== true) throw new Error(`Futures market metadata is not a contract: ${symbol}`);
			this.contractSizeForMarket(market);
		}
		return {
			symbol: market.symbol,
			base: market.base,
			quote: market.quote,
			settle: market.settle,
			marketType: market.swap ? "swap" : "spot",
			contract: market.contract,
			linear: market.linear,
			inverse: market.inverse,
			active: market.active,
			amountUnit: futures ? "contracts" : "base",
			contractSize: market.contractSize,
			pricePrecision: market.precision?.price,
			amountPrecision: market.precision?.amount,
			minAmount: market.limits?.amount?.min,
			minNotional: market.limits?.cost?.min,
			limits: market.limits,
		};
	}

	async getContractStats(symbol: string): Promise<ContractStats> {
		if (!this.isFuturesSymbol(symbol)) throw new Error("Contract stats require a futures symbol");
		this.accountForSymbol(symbol);
		const exchange = this.futuresExchange;
		await exchange.loadMarkets();
		const market = exchange.markets[symbol];
		if (!market || market.contract !== true || market.swap !== true) {
			throw new Error(`Unsupported futures market: ${symbol}`);
		}
		this.contractSizeForMarket(market);
		const ticker = await this.futuresExchange.fetchTicker(symbol);
		const info = ticker.info as Record<string, unknown> | undefined;
		const markPrice = Number(info?.markPrice ?? NaN);
		const indexPrice = Number(info?.indexPrice ?? NaN);
		return {
			symbol,
			lastPrice: ticker.last ?? undefined,
			markPrice: Number.isFinite(markPrice) ? markPrice : undefined,
			indexPrice: Number.isFinite(indexPrice) ? indexPrice : undefined,
		};
	}

	async getKlines(symbol: string, timeframe: string, limit: number): Promise<Kline[]> {
		const ohlcv = await this.exchangeFor(symbol).fetchOHLCV(symbol, timeframe, undefined, limit);
		const duration = timeframeDurationMs(timeframe);
		return ohlcv.map((k) => ({
			timestamp: k[0] ?? 0,
			closed: k[0] !== undefined && duration !== undefined ? k[0] + duration <= Date.now() : undefined,
			open: k[1] ?? 0,
			high: k[2] ?? 0,
			low: k[3] ?? 0,
			close: k[4] ?? 0,
			volume: k[5] ?? 0,
		}));
	}

	async getBalances(): Promise<Balance[]> {
		return this.runAccountOperation(async () => {
			await this.settleOpenOrdersUnlocked();
			if (this.marketType === "usdm-futures") return this.futuresBalances();
			const result: Balance[] = [];
			for (const [asset, free] of Object.entries(this.account.balances)) {
				const used = this.reservedAmount(asset);
				if (free <= 0 && used <= 0) continue;
				result.push({
					asset,
					free,
					used,
					total: free + used,
					quoteValue: await this.estimateQuoteValue(asset, free + used),
				});
			}
			if (this.marketType === "both") {
				for (const balance of await this.futuresBalances()) {
					result.push({ ...balance, asset: `futures:${balance.asset}` });
				}
			}
			return result;
		});
	}

	async getPositions(): Promise<Position[]> {
		return this.runAccountOperation(async () => {
			await this.settleOpenOrdersUnlocked();
			if (this.marketType === "usdm-futures") return this.futuresPositions();
			const result: Position[] = [];
			for (const [asset, entry] of Object.entries(this.account.entries)) {
				const held = (this.account.balances[asset] ?? 0) + this.reservedAmount(asset);
				if (held <= 0) continue;
				const avgEntryPrice = entry.amount > 0 ? entry.cost / entry.amount : undefined;
				const symbol = `${asset}/${this.quoteCurrency}`;
				const valuation = await this.tryPrice(asset);
				if ("reason" in valuation) {
					// The ledger is authoritative for whether a position exists. A
					// missing/invalid public mark only makes its derived values
					// unknown; it must not make the holding disappear.
					result.push({
						symbol,
						asset,
						amount: held,
						avgEntryPrice,
						valuationStatus: "unavailable",
						valuationReason: valuation.reason,
					});
					continue;
				}
				const quoteValue = held * valuation.price;
				if (!Number.isFinite(quoteValue)) {
					result.push({
						symbol,
						asset,
						amount: held,
						avgEntryPrice,
						valuationStatus: "unavailable",
						valuationReason: `Quote valuation for ${symbol} is not finite`,
					});
					continue;
				}
				const unrealizedPnl = avgEntryPrice !== undefined ? (valuation.price - avgEntryPrice) * held : undefined;
				result.push({
					symbol,
					asset,
					amount: held,
					quoteValue,
					avgEntryPrice,
					unrealizedPnl,
					unrealizedPnlPct:
						avgEntryPrice !== undefined && avgEntryPrice > 0
							? (valuation.price / avgEntryPrice - 1) * 100
							: undefined,
					valuationStatus: "complete",
				});
			}
			if (this.marketType === "both") result.push(...(await this.futuresPositions()));
			return result;
		});
	}

	async getOpenOrders(symbol?: string): Promise<Order[]> {
		return this.runAccountOperation(async () => {
			const account = symbol === undefined ? undefined : this.accountForSymbol(symbol);
			await this.settleOpenOrdersUnlocked();
			const accounts = account === undefined ? this.enabledAccounts() : [account];
			return accounts
				.flatMap((account) => account.orders)
				.filter((order) => order.status === "open" && (!symbol || order.symbol === symbol))
				.map(toOrder);
		});
	}

	async getOrderHistory(symbol?: string, limit = 50): Promise<Order[]> {
		return this.runAccountOperation(async () => {
			const account = symbol === undefined ? undefined : this.accountForSymbol(symbol);
			await this.settleOpenOrdersUnlocked();
			const accounts = account === undefined ? this.enabledAccounts() : [account];
			return accounts
				.flatMap((account) => account.orders)
				.filter((order) => order.status !== "open" && (!symbol || order.symbol === symbol))
				.sort((a, b) => b.timestamp - a.timestamp)
				.slice(0, limit)
				.map(toOrder);
		});
	}

	async getOrderByClientId(clientOrderId: string, symbol: string): Promise<Order> {
		return this.runAccountOperation(async () => {
			const account = this.accountForSymbol(symbol);
			await this.settleOpenOrdersUnlocked();
			const order = account.orders.find(
				(candidate) => candidate.clientOrderId === clientOrderId && candidate.symbol === symbol,
			);
			if (!order) throw new Error(`Order client id ${clientOrderId} on ${symbol} not found`);
			return toOrder(order);
		});
	}

	async getOrder(id: string, symbol: string): Promise<Order> {
		return this.runAccountOperation(async () => {
			const account = this.accountForSymbol(symbol);
			await this.settleOpenOrdersUnlocked();
			const order = account.orders.find((candidate) => candidate.id === id && candidate.symbol === symbol);
			if (!order) throw new Error(`Order ${id} on ${symbol} not found`);
			return toOrder(order);
		});
	}

	async getOrderListByClientId(listClientOrderId: string): Promise<OrderList> {
		return this.runAccountOperation(async () => {
			await this.settleOpenOrdersUnlocked();
			const orders = this.enabledAccounts()
				.flatMap((account) => account.orders)
				.filter((order) => order.listClientOrderId === listClientOrderId);
			if (orders.length === 0) throw new Error(`Order list ${listClientOrderId} not found`);
			return this.orderListFromOrders(listClientOrderId, orders);
		});
	}

	async getOrderList(orderListId: string): Promise<OrderList> {
		return this.runAccountOperation(async () => {
			await this.settleOpenOrdersUnlocked();
			const orders = this.enabledAccounts()
				.flatMap((account) => account.orders)
				.filter((order) => order.ocoGroup === orderListId);
			if (orders.length === 0) throw new Error(`Order list ${orderListId} not found`);
			return this.orderListFromOrders(orderListId, orders);
		});
	}

	private orderListFromOrders(orderListId: string, orders: PaperOrder[]): OrderList {
		const mapped = orders.map(toOrder);
		const status = mapped.some((order) => order.status === "open")
			? "open"
			: mapped.some((order) => order.status === "closed")
				? "closed"
				: "canceled";
		return {
			id: orderListId,
			listOrderStatus: status === "open" ? "EXECUTING" : "ALL_DONE",
			status,
			orders: mapped,
		};
	}

	async placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
		return this.runAccountOperation(async () => {
			await this.settleOpenOrdersUnlocked();
			if (this.isFuturesSymbol(input.symbol)) {
				if (this.marketType === "spot") throw new Error("Futures markets are disabled in spot mode");
				return this.placeFuturesMarketOrder(await this.normalizeOrderInput(input));
			}
			if (this.marketType === "usdm-futures") throw new Error("Spot markets are disabled in futures mode");
			input = await this.normalizeOrderInput(input);
			input = { ...input, clientOrderId: input.clientOrderId ?? `paper-${this.nextOrderId}` };
			baseAsset(input.symbol, this.quoteCurrency); // validates market
			if (input.amount <= 0) throw new Error("Amount must be positive");
			if (input.reduceOnly !== undefined || input.positionSide !== undefined || input.closePosition !== undefined) {
				throw new Error("reduceOnly, positionSide and closePosition are futures-only parameters");
			}

			if (input.type === "market") {
				const ticker = await this.exchange.fetchTicker(input.symbol);
				const price = ticker.last;
				if (!isFinitePositive(price)) throw new Error(`No finite positive price available for ${input.symbol}`);
				const fill = this.executeFill(input.symbol, input.side, input.amount, price, input.clientOrderId);
				return {
					order: toOrder(fill.order),
					fee: fill.fee,
				};
			}

			const order: PaperOrder = {
				id: String(this.nextOrderId),
				clientOrderId: input.clientOrderId,
				symbol: input.symbol,
				side: input.side,
				type: input.type,
				amount: input.amount,
				filled: 0,
				cost: 0,
				status: "open",
				timestamp: Date.now(),
			};

			if (input.type === "limit") {
				if (input.price === undefined || input.price <= 0) {
					throw new Error("Limit orders require a positive price");
				}
				order.price = input.price;
				order.reservePrice = input.price;
			} else if (isTriggerType(input.type)) {
				if (input.stopPrice === undefined || input.stopPrice <= 0) {
					throw new Error(`${input.type} orders require a positive stopPrice`);
				}
				const isLimit = input.type === "stop" || input.type === "take_profit";
				if (isLimit && (input.price === undefined || input.price <= 0)) {
					throw new Error(`${input.type} orders require a positive limit price`);
				}
				const last = await this.lastPrice(input.symbol);
				if (triggerFires(input.type, input.side, last, input.stopPrice)) {
					throw new Error(
						`Order would trigger immediately: ${input.side} ${input.type} at trigger ${input.stopPrice} with last price ${last}`,
					);
				}
				order.stopPrice = input.stopPrice;
				if (isLimit) order.price = input.price;
				// Market-trigger fills happen at the trigger price; limit variants at the limit price.
				order.reservePrice = isLimit ? input.price : input.stopPrice;
			} else if (input.type === "trailing_stop_market") {
				const percent = input.trailingPercent;
				if (percent === undefined || !Number.isFinite(percent) || percent <= 0 || percent >= 100) {
					throw new Error("trailing_stop_market orders require trailingPercent in (0, 100)");
				}
				if (input.stopPrice !== undefined) {
					throw new Error(
						"Activation stopPrice for trailing stops is not supported in paper mode; use trailingPercent only",
					);
				}
				const last = await this.lastPrice(input.symbol);
				order.trailingPercent = percent;
				order.trailingExtreme = last;
				// A buy trailing stop level only falls as the trough falls, so the
				// level at placement is the maximum possible fill price.
				order.reservePrice = trailingStopLevel(input.side, last, percent);
			} else {
				throw new Error(`Unsupported order type: ${input.type}`);
			}

			// Reserve funds/assets up-front so concurrent orders cannot overspend.
			this.reserve(input.side, input.symbol, input.amount, order.reservePrice ?? 0);
			order.lastCheckedAt = order.timestamp;
			this.nextOrderId++;
			this.account.orders.push(order);
			this.persist();
			return { order: toOrder(order) };
		});
	}

	async placeOcoOrder(input: PlaceOcoOrderInput): Promise<PlaceOcoOrderResult> {
		return this.runAccountOperation(async () => {
			await this.settleOpenOrdersUnlocked();
			if (this.isFuturesSymbol(input.symbol))
				throw new Error("Paper futures OCO orders are not supported; use market orders");
			baseAsset(input.symbol, this.quoteCurrency); // validates market
			if (input.amount <= 0) throw new Error("Amount must be positive");
			const normalized = await this.normalizeOrderInput({
				symbol: input.symbol,
				side: input.side,
				type: "market",
				amount: input.amount,
			});
			const amount = normalized.amount;
			const stopLossPrice = Number(this.exchange.priceToPrecision(input.symbol, input.stopLossPrice));
			const takeProfitPrice = Number(this.exchange.priceToPrecision(input.symbol, input.takeProfitPrice));
			if (!Number.isFinite(stopLossPrice) || stopLossPrice <= 0) throw new Error("stopLossPrice must be positive");
			if (!Number.isFinite(takeProfitPrice) || takeProfitPrice <= 0)
				throw new Error("takeProfitPrice must be positive");
			const last = await this.lastPrice(input.symbol);
			if (input.side === "sell") {
				if (stopLossPrice >= last)
					throw new Error(`Sell OCO stopLossPrice ${stopLossPrice} must be below the last price ${last}`);
				if (takeProfitPrice <= last)
					throw new Error(`Sell OCO takeProfitPrice ${takeProfitPrice} must be above the last price ${last}`);
			} else {
				if (stopLossPrice <= last)
					throw new Error(`Buy OCO stopLossPrice ${stopLossPrice} must be above the last price ${last}`);
				if (takeProfitPrice >= last)
					throw new Error(`Buy OCO takeProfitPrice ${takeProfitPrice} must be below the last price ${last}`);
			}

			const group = `oco-${this.nextOrderId}`;
			const listClientOrderId = input.listClientOrderId ?? `paper-list-${this.nextOrderId}`;
			const now = Date.now();
			// Buys reserve quote at the worst-case (higher) trigger; sells reserve base once.
			const reservePrice = Math.max(stopLossPrice, takeProfitPrice);
			const makeLeg = (type: OrderType, stopPrice: number, clientOrderId?: string): PaperOrder => ({
				id: String(this.nextOrderId++),
				clientOrderId,
				listClientOrderId,
				symbol: input.symbol,
				side: input.side,
				type,
				stopPrice,
				reservePrice,
				ocoGroup: group,
				amount,
				filled: 0,
				cost: 0,
				status: "open",
				timestamp: now,
				lastCheckedAt: now,
			});
			// Stop-loss leg first: on a candle that crosses both triggers, the
			// conservative (loss) leg wins.
			const stopLeg = makeLeg("stop_market", stopLossPrice, input.belowClientOrderId);
			const profitLeg = makeLeg("take_profit_market", takeProfitPrice, input.aboveClientOrderId);
			this.reserve(input.side, input.symbol, amount, reservePrice);
			this.account.orders.push(stopLeg, profitLeg);
			this.persist();
			return { orders: [toOrder(stopLeg), toOrder(profitLeg)] };
		});
	}

	private async placeFuturesMarketOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
		if (input.type !== "market") throw new Error("Paper futures currently support market orders only");
		if (input.amount <= 0) throw new Error("Amount must be positive");
		if (input.closePosition && input.reduceOnly === false) throw new Error("closePosition is always reduceOnly");
		const ticker = await this.futuresExchange.fetchTicker(input.symbol);
		const price = ticker.last;
		if (!isFinitePositive(price)) throw new Error(`No finite positive price available for ${input.symbol}`);
		const account = this.futuresAccount;
		const asset = baseAsset(input.symbol, `${this.quoteCurrency}:${this.quoteCurrency}`);
		const positionSide = this.resolveFuturesPositionSide(input.positionSide);
		const entryKey = this.futuresEntryKey(asset, positionSide);
		const current = account.entries[entryKey] ?? { amount: 0, cost: 0 };
		const currentQty = Math.abs(current.amount);
		const currentLots = this.snapshotFuturesLots(current);
		const currentSettings = this.futuresSettings(input.symbol);
		const requested = input.closePosition ? currentQty : input.amount;
		const signed = input.side === "buy" ? requested : -requested;
		const reducing = currentQty > 0 && Math.sign(signed) !== Math.sign(current.amount);
		if (input.closePosition && (!reducing || currentQty === 0)) {
			throw new Error("closePosition requires an open position and the matching reduce side");
		}
		if (input.reduceOnly) {
			if (currentQty === 0) throw new Error("reduceOnly order requires an open futures position");
			if (!reducing) throw new Error("reduceOnly order cannot increase the position");
			if (requested > currentQty) throw new Error("reduceOnly order amount exceeds the open position");
		}
		if (this.positionMode === "hedge") {
			const openingSide = positionSide === "LONG" ? "buy" : "sell";
			if (currentQty === 0 && input.side !== openingSide) {
				throw new Error(`${input.side} cannot open a ${positionSide} position in hedge mode`);
			}
			if (reducing && requested > currentQty) {
				throw new Error(`Order amount exceeds the open ${positionSide} position`);
			}
		}
		const closing = reducing ? Math.min(currentQty, requested) : 0;
		const notional = requested * price;
		const fee = notional * this.feeRate;
		let remainingToClose = closing;
		let releasedMargin = 0;
		let pnl = 0;
		const remainingLots: FuturesLot[] = [];
		for (const lot of currentLots) {
			const closedFromLot = Math.min(lot.amount, remainingToClose);
			if (closedFromLot > 0) {
				releasedMargin += (closedFromLot * lot.price) / lot.leverage;
				pnl += closedFromLot * (price - lot.price) * Math.sign(current.amount);
				remainingToClose -= closedFromLot;
			}
			if (lot.amount > closedFromLot) remainingLots.push({ ...lot, amount: lot.amount - closedFromLot });
		}
		const remaining = current.amount + signed;
		const opening = requested - closing;
		const openingMargin = (opening * price) / currentSettings.leverage;
		const available = account.balances[this.quoteCurrency] ?? 0;
		if (available + releasedMargin + pnl < fee + openingMargin) throw new Error("Insufficient futures margin");
		account.balances[this.quoteCurrency] = available + releasedMargin + pnl - fee - openingMargin;
		if (opening > 0) {
			remainingLots.push({ amount: opening, price, ...currentSettings });
		}
		if (remaining === 0) delete account.entries[entryKey];
		else {
			const cost = remainingLots.reduce((sum, lot) => sum + lot.amount * lot.price, 0);
			const settings = this.uniformFuturesLotSettings(remainingLots);
			account.entries[entryKey] = {
				amount: remaining,
				cost,
				...settings,
				lots: remainingLots,
			};
		}
		account.realizedPnl += pnl;
		// Futures market orders get the same deterministic default client order id
		// as the spot path (`paper-<order id>`); an explicit id is preserved.
		const clientOrderId = input.clientOrderId ?? `paper-${this.nextOrderId}`;
		const order: PaperOrder = {
			id: String(this.nextOrderId++),
			clientOrderId,
			symbol: input.symbol,
			side: input.side,
			type: "market",
			positionSide,
			reduceOnly: input.reduceOnly,
			closePosition: input.closePosition,
			amount: requested,
			filled: requested,
			average: price,
			cost: notional,
			status: "closed",
			timestamp: Date.now(),
		};
		account.orders.push(order);
		account.trades.push({
			id: order.id,
			symbol: input.symbol,
			side: input.side,
			price,
			amount: requested,
			cost: notional,
			fee,
			realizedPnl: pnl,
			positionSide,
			timestamp: order.timestamp,
		});
		this.persistAll();
		return { order: toOrder(order), fee };
	}

	private resolveFuturesPositionSide(positionSide: PlaceOrderInput["positionSide"]): "BOTH" | "LONG" | "SHORT" {
		if (this.positionMode === "hedge") {
			if (positionSide !== "LONG" && positionSide !== "SHORT") {
				throw new Error("Hedge mode futures orders require positionSide LONG or SHORT");
			}
			return positionSide;
		}
		if (positionSide !== undefined && positionSide !== "BOTH") {
			throw new Error("One-way mode futures orders must use positionSide BOTH or omit it");
		}
		return "BOTH";
	}

	private futuresEntryKey(asset: string, positionSide: "BOTH" | "LONG" | "SHORT"): string {
		return this.positionMode === "hedge" ? `${asset}:${positionSide}` : asset;
	}

	async cancelOrder(id: string, symbol: string): Promise<void> {
		return this.runAccountOperation(async () => {
			const account = this.accountForSymbol(symbol);
			await this.settleOpenOrdersUnlocked();
			const order = account.orders.find((o) => o.id === id && o.symbol === symbol && o.status === "open");
			if (!order) throw new Error(`Open order ${id} on ${symbol} not found`);
			order.status = "canceled";
			this.releaseReservation(order);
			// Cancelling one OCO leg cancels the whole group; the shared
			// reservation was already released above.
			if (order.ocoGroup) {
				for (const sibling of account.orders) {
					if (sibling.ocoGroup === order.ocoGroup && sibling.status === "open") sibling.status = "canceled";
				}
			}
			this.persistAll();
		});
	}

	async cancelOrderList(orderListId: string, symbol: string): Promise<void> {
		return this.runAccountOperation(async () => {
			const account = this.accountForSymbol(symbol);
			await this.settleOpenOrdersUnlocked();
			const orders = account.orders.filter(
				(order) => order.ocoGroup === orderListId && order.symbol === symbol && order.status === "open",
			);
			if (orders.length === 0) throw new Error(`Open order list ${orderListId} on ${symbol} not found`);
			this.releaseReservation(orders[0]);
			for (const order of orders) order.status = "canceled";
			this.persistAll();
		});
	}

	async getFundingRateHistory(symbol: string, _limit = 20): Promise<FundingRateRecord[]> {
		if (!this.isFuturesSymbol(symbol) || this.marketType === "spot")
			throw new Error("Paper futures funding requires a futures symbol");
		this.accountForSymbol(symbol);
		return [];
	}

	async getFundingRate(symbol: string): Promise<{ symbol: string; rate: number; nextFundingTime?: number }> {
		if (!this.isFuturesSymbol(symbol) || this.marketType === "spot")
			throw new Error("Paper futures funding requires a futures symbol");
		this.accountForSymbol(symbol);
		return { symbol, rate: 0, nextFundingTime: undefined };
	}

	async setLeverage(symbol: string, leverage: number): Promise<void> {
		return this.runAccountOperation(async () => {
			if (!Number.isInteger(leverage) || leverage < 1 || leverage > 125) throw new Error("Invalid leverage");
			await this.validateFuturesMarket(symbol);
			this.futuresAccount.leverageBySymbol = { ...this.futuresAccount.leverageBySymbol, [symbol]: leverage };
			this.persistAll();
		});
	}

	async setMultiAssetsMode(_enabled: boolean): Promise<void> {
		throw new Error("Multi-Assets mode is available only for live Binance USDⓈ-M futures");
	}

	async setMarginMode(symbol: string, marginType: "isolated" | "cross"): Promise<void> {
		return this.runAccountOperation(async () => {
			if (marginType !== "isolated" && marginType !== "cross") throw new Error("Invalid margin mode");
			await this.validateFuturesMarket(symbol);
			this.futuresAccount.marginTypeBySymbol = { ...this.futuresAccount.marginTypeBySymbol, [symbol]: marginType };
			this.persistAll();
		});
	}

	async getTopMarkets(limit: number): Promise<Ticker[]> {
		const fetchFamily = async (exchange: Exchange, futures: boolean): Promise<Ticker[]> => {
			const tickers = await exchange.fetchTickers();
			const suffix = futures ? `/${this.quoteCurrency}:${this.quoteCurrency}` : `/${this.quoteCurrency}`;
			return Object.values(tickers)
				.filter((ticker) => ticker.symbol.endsWith(suffix) && (futures || !ticker.symbol.includes(":")))
				.map(toTicker);
		};
		const families =
			this.marketType === "spot"
				? [fetchFamily(this.exchange, false)]
				: this.marketType === "usdm-futures"
					? [fetchFamily(this.futuresExchange, true)]
					: [fetchFamily(this.exchange, false), fetchFamily(this.futuresExchange, true)];
		const tickers = (await Promise.all(families)).flat();
		return tickers.sort((a, b) => (b.quoteVolume24h ?? 0) - (a.quoteVolume24h ?? 0)).slice(0, limit);
	}

	async close(): Promise<void> {
		await this.accountOperationQueue;
		await this.exchange.close();
		if (this.futuresExchange !== this.exchange) await this.futuresExchange.close();
	}

	/** Wipe the simulated account and start over with the given quote balance. */
	resetAccount(startQuote: number): Promise<void> {
		return this.runAccountOperation(() => {
			if (!Number.isFinite(startQuote) || startQuote <= 0) {
				throw new Error("startQuote must be a positive number");
			}
			this.account = {
				quote: this.quoteCurrency,
				balances: { [this.quoteCurrency]: startQuote },
				entries: {},
				orders: [],
				trades: [],
				realizedPnl: 0,
				createdAt: Date.now(),
			};
			this.futuresAccount = {
				quote: this.quoteCurrency,
				balances: { [this.quoteCurrency]: startQuote },
				entries: {},
				orders: [],
				trades: [],
				realizedPnl: 0,
				leverage: this.futuresLeverage,
				marginType: this.futuresMarginType,
				leverageBySymbol: {},
				marginTypeBySymbol: {},
				positionMode: this.positionMode,
				createdAt: Date.now(),
			};
			this.nextOrderId = 1;
			this.persistAll();
		});
	}

	// --- internals -----------------------------------------------------------

	private futuresBalances(): Promise<Balance[]> {
		const free = this.futuresAccount.balances[this.quoteCurrency] ?? 0;
		return Promise.resolve([{ asset: this.quoteCurrency, free, used: 0, total: free, quoteValue: free }]);
	}

	private async futuresPositions(): Promise<Position[]> {
		await this.futuresExchange.loadMarkets();
		const result: Position[] = [];
		for (const [entryKey, entry] of Object.entries(this.futuresAccount.entries)) {
			if (entry.amount === 0) continue;
			const separator = entryKey.lastIndexOf(":");
			const positionSide =
				this.positionMode === "hedge" && separator > 0
					? (entryKey.slice(separator + 1) as "LONG" | "SHORT")
					: entry.amount > 0
						? "LONG"
						: "SHORT";
			const asset = this.positionMode === "hedge" && separator > 0 ? entryKey.slice(0, separator) : entryKey;
			const symbol = `${asset}/${this.quoteCurrency}:${this.quoteCurrency}`;
			const market = this.futuresExchange.markets[symbol];
			if (!market || market.contract !== true || market.swap !== true) {
				throw new Error(`Unsupported futures market: ${symbol}`);
			}
			this.contractSizeForMarket(market);
			const lots = this.snapshotFuturesLots(entry);
			const settings = this.uniformFuturesLotSettings(lots);
			const avg = entry.cost / Math.abs(entry.amount);
			const margin = lots.reduce((sum, lot) => sum + (lot.amount * lot.price) / lot.leverage, 0);
			const basePosition: Position = {
				symbol,
				asset,
				amount: Math.abs(entry.amount),
				positionSide,
				leverage: settings.leverage,
				marginType: settings.marginType,
				margin,
				avgEntryPrice: Number.isFinite(avg) ? avg : undefined,
			};
			let ticker: CcxtTicker;
			try {
				ticker = await this.futuresExchange.fetchTicker(symbol);
			} catch (error) {
				result.push({
					...basePosition,
					valuationStatus: "unavailable",
					valuationReason: `Ticker unavailable for ${symbol}: ${error instanceof Error ? error.message : String(error)}`,
				});
				continue;
			}
			const mark = ticker.last;
			if (mark === undefined || !Number.isFinite(mark) || mark <= 0) {
				result.push({
					...basePosition,
					valuationStatus: "unavailable",
					valuationReason: `Ticker for ${symbol} did not provide a finite positive last price`,
				});
				continue;
			}
			const quoteValue = Math.abs(entry.amount) * mark;
			if (!Number.isFinite(quoteValue)) {
				result.push({
					...basePosition,
					valuationStatus: "unavailable",
					valuationReason: `Quote valuation for ${symbol} is not finite`,
				});
				continue;
			}
			const pnl = Number.isFinite(avg) ? (mark - avg) * entry.amount : undefined;
			result.push({
				...basePosition,
				quoteValue,
				markPrice: mark,
				unrealizedPnl: pnl,
				unrealizedPnlPct:
					pnl !== undefined && Math.abs(entry.amount) * avg > 0
						? (pnl / (Math.abs(entry.amount) * avg)) * 100
						: undefined,
				valuationStatus: "complete",
			});
		}
		return result;
	}

	private reservedAmount(asset: string): number {
		let used = 0;
		const seenGroups = new Set<string>();
		for (const o of this.account.orders) {
			if (o.status !== "open") continue;
			// OCO legs share one reservation; count each group once.
			if (o.ocoGroup) {
				if (seenGroups.has(o.ocoGroup)) continue;
				seenGroups.add(o.ocoGroup);
			}
			const unitPrice = o.reservePrice ?? o.price;
			if (o.side === "buy" && asset === this.quoteCurrency && unitPrice !== undefined) {
				used += (o.amount - o.filled) * unitPrice * (1 + this.feeRate);
			} else if (o.side === "sell" && baseAsset(o.symbol, this.quoteCurrency) === asset) {
				used += o.amount - o.filled;
			}
		}
		return used;
	}

	private reserve(side: "buy" | "sell", symbol: string, amount: number, unitPrice: number): void {
		if (side === "buy") {
			if (unitPrice <= 0) throw new Error("Cannot reserve quote funds without a positive reserve price");
			const cost = amount * unitPrice * (1 + this.feeRate);
			const free = this.account.balances[this.quoteCurrency] ?? 0;
			if (free < cost) {
				throw new Error(
					`Insufficient ${this.quoteCurrency}: need ${cost.toFixed(2)}, have ${free.toFixed(2)} (paper account)`,
				);
			}
			this.account.balances[this.quoteCurrency] = free - cost;
		} else {
			const asset = baseAsset(symbol, this.quoteCurrency);
			const free = this.account.balances[asset] ?? 0;
			if (free < amount) {
				throw new Error(`Insufficient ${asset}: need ${amount}, have ${free} (paper account)`);
			}
			this.account.balances[asset] = free - amount;
		}
	}

	private releaseReservation(order: PaperOrder): void {
		const remaining = order.amount - order.filled;
		if (order.side === "buy") {
			const unitPrice = order.reservePrice ?? order.price;
			if (unitPrice === undefined) return;
			this.credit(this.quoteCurrency, remaining * unitPrice * (1 + this.feeRate));
		} else {
			this.credit(baseAsset(order.symbol, this.quoteCurrency), remaining);
		}
	}

	private credit(asset: string, amount: number): void {
		this.account.balances[asset] = (this.account.balances[asset] ?? 0) + amount;
	}

	/** Fill a (market) order immediately at the given price. */
	private executeFill(
		symbol: string,
		side: "buy" | "sell",
		amount: number,
		price: number,
		clientOrderId?: string,
		persist = true,
	) {
		const asset = baseAsset(symbol, this.quoteCurrency);
		const notional = amount * price;
		const fee = notional * this.feeRate;
		let realizedPnl: number | undefined;

		if (side === "buy") {
			const totalCost = notional + fee;
			const free = this.account.balances[this.quoteCurrency] ?? 0;
			if (free < totalCost) {
				throw new Error(
					`Insufficient ${this.quoteCurrency}: need ${totalCost.toFixed(2)} (incl. fee), have ${free.toFixed(2)} (paper account)`,
				);
			}
			this.account.balances[this.quoteCurrency] = free - totalCost;
			this.credit(asset, amount);
			const entry = this.account.entries[asset] ?? { amount: 0, cost: 0 };
			entry.amount += amount;
			entry.cost += totalCost;
			this.account.entries[asset] = entry;
		} else {
			const free = this.account.balances[asset] ?? 0;
			if (free < amount) {
				throw new Error(`Insufficient ${asset}: need ${amount}, have ${free} (paper account)`);
			}
			this.account.balances[asset] = free - amount;
			this.credit(this.quoteCurrency, notional - fee);
			const entry = this.account.entries[asset];
			if (entry && entry.amount > 0) {
				const entryPrice = entry.cost / entry.amount;
				const closing = Math.min(amount, entry.amount);
				realizedPnl = (price - entryPrice) * closing - fee;
				this.account.realizedPnl += realizedPnl;
				entry.amount -= closing;
				entry.cost -= entryPrice * closing;
				if (entry.amount <= 1e-12) delete this.account.entries[asset];
			}
		}

		const order: PaperOrder = {
			id: String(this.nextOrderId++),
			clientOrderId,
			symbol,
			side,
			type: "market",
			amount,
			filled: amount,
			average: price,
			cost: notional,
			status: "closed",
			timestamp: Date.now(),
		};
		this.account.orders.push(order);
		this.account.trades.push({
			id: order.id,
			symbol,
			side,
			price,
			amount,
			cost: notional,
			fee,
			realizedPnl,
			timestamp: order.timestamp,
		});
		if (persist) this.persist();
		return { order, fee };
	}

	/**
	 * Lazily settle resting orders: fill limit orders whose price has been
	 * crossed, fire stop/take-profit triggers, and advance trailing stops.
	 * Between account reads the market path is reconstructed from klines, so
	 * spikes that fall inside the gap still count for every resting order.
	 */
	private async settleOpenOrdersUnlocked(): Promise<void> {
		// Paper futures currently have no resting orders. Never settle the
		// persisted spot ledger while futures-only mode is active.
		if (this.marketType === "usdm-futures") return;
		const open = this.account.orders.filter((o) => o.status === "open");
		if (open.length === 0) return;
		const accountBeforeSettlement = structuredClone(this.account);
		const nextOrderIdBeforeSettlement = this.nextOrderId;
		const now = Date.now();
		const tickers = new Map<string, CcxtTicker>();
		const candleCache = new Map<string, Kline[]>();
		// One kline fetch per symbol covers all its orders: use the earliest gap.
		const minSince = new Map<string, number>();
		for (const o of open) {
			const since = o.lastCheckedAt ?? o.timestamp;
			minSince.set(o.symbol, Math.min(minSince.get(o.symbol) ?? since, since));
		}
		let dirty = false;
		for (const order of open) {
			if (order.status !== "open") continue; // cancelled as an OCO sibling earlier in this pass
			try {
				let ticker = tickers.get(order.symbol);
				if (!ticker) {
					ticker = await this.exchange.fetchTicker(order.symbol);
					tickers.set(order.symbol, ticker);
				}
				const last = ticker.last;
				if (!isFinitePositive(last)) {
					throw new Error(`Ticker for ${order.symbol} did not provide a finite positive last price`);
				}
				const marketPath = await this.marketPath(order, last, now, minSince, candleCache);
				const path = marketPath.segments;

				if (order.ocoGroup) {
					// Evaluate all legs of the group against the same path and fill
					// the leg that fired earliest (ties go to the stop-loss leg,
					// which is placed first).
					const legs = open.filter((o) => o.ocoGroup === order.ocoGroup && o.status === "open");
					let winner: { leg: PaperOrder; fire: PathFire } | undefined;
					for (const leg of legs) {
						const fire = this.evaluatePath(leg, path);
						this.advanceCheckedAt(leg, marketPath.checkedAt);
						if (fire && (!winner || fire.index < winner.fire.index)) winner = { leg, fire };
					}
					dirty = true;
					if (winner) this.fillRestingOrder(winner.leg, winner.fire.price);
					continue;
				}

				const fire = this.evaluatePath(order, path);
				this.advanceCheckedAt(order, marketPath.checkedAt);
				dirty = true;
				if (fire) this.fillRestingOrder(order, fire.price);
			} catch (error) {
				// Settlement can touch several orders (and an OCO sibling) before a
				// later market read fails. Roll the whole pass back so a retry never
				// sees a half-released reservation or a half-filled group.
				this.account = accountBeforeSettlement;
				this.nextOrderId = nextOrderIdBeforeSettlement;
				throw new Error(
					`Failed to settle paper order ${order.id} on ${order.symbol}: ${error instanceof Error ? error.message : String(error)}`,
					{ cause: error },
				);
			}
		}
		if (dirty) this.persist();
	}

	/**
	 * Build the market path since the order was last checked: gap klines
	 * (when the gap exceeds two minutes) followed by the current ticker price.
	 */
	private async marketPath(
		order: PaperOrder,
		last: number,
		now: number,
		minSince: Map<string, number>,
		candleCache: Map<string, Kline[]>,
	): Promise<MarketPath> {
		const since = order.lastCheckedAt ?? order.timestamp;
		const path: PathSegment[] = [];
		let checkedAt = now;
		if ((now - since) / 60_000 > 2) {
			const fetchSince = minSince.get(order.symbol) ?? since;
			const gapMinutes = (now - fetchSince) / 60_000;
			const timeframe = gapMinutes <= 400 ? "1m" : gapMinutes <= 6000 ? "15m" : "1h";
			const minutesPerCandle = timeframe === "1m" ? 1 : timeframe === "15m" ? 15 : 60;
			const candleDurationMs = minutesPerCandle * 60_000;
			checkedAt = since;
			let candles = candleCache.get(order.symbol);
			if (!candles) {
				const limit = Math.min(Math.ceil(gapMinutes / minutesPerCandle) + 2, 500);
				const ohlcv = await this.exchange.fetchOHLCV(order.symbol, timeframe, fetchSince, limit);
				candles = ohlcv.map((k) => ({
					timestamp: k[0] ?? 0,
					open: k[1] ?? 0,
					high: k[2] ?? 0,
					low: k[3] ?? 0,
					close: k[4] ?? 0,
					volume: k[5] ?? 0,
				}));
				candleCache.set(order.symbol, candles);
			}
			const validCandles = candles
				.filter(
					(k) =>
						Number.isFinite(k.timestamp) &&
						k.timestamp >= since &&
						k.timestamp <= now &&
						Number.isFinite(k.high) &&
						Number.isFinite(k.low) &&
						k.high > 0 &&
						k.low > 0,
				)
				.sort((a, b) => a.timestamp - b.timestamp);
			let previousTimestamp: number | undefined;
			for (const k of validCandles) {
				// The first exchange candle may begin up to one timeframe after an
				// arbitrary order timestamp. Once a candle is accepted, every later
				// candle must start no later than the end of the preceding one. A
				// sparse response therefore contributes only its continuous prefix;
				// candles after a gap are retried on a later read instead of being
				// evaluated out of chronological order.
				const latestAllowedStart =
					previousTimestamp === undefined ? since + candleDurationMs : previousTimestamp + candleDurationMs;
				if (k.timestamp > latestAllowedStart) break;
				if (previousTimestamp === k.timestamp) continue;
				path.push({ high: k.high, low: k.low });
				previousTimestamp = k.timestamp;
				checkedAt = Math.min(now, k.timestamp + candleDurationMs);
			}
			checkedAt = Math.max(since, checkedAt);
		}
		path.push({ high: last, low: last, tick: true });
		return { segments: path, checkedAt };
	}

	private advanceCheckedAt(order: PaperOrder, checkedAt: number): void {
		const current = order.lastCheckedAt ?? order.timestamp;
		if (Number.isFinite(checkedAt) && checkedAt > current) order.lastCheckedAt = checkedAt;
	}

	/**
	 * Walk an order along the market path and return where it fills.
	 * Mutates trigger/trailing state (`triggered`, `trailingExtreme`) so
	 * partial progress survives even when the order does not fill.
	 */
	private evaluatePath(order: PaperOrder, path: PathSegment[]): PathFire | undefined {
		for (let index = 0; index < path.length; index++) {
			const seg = path[index];

			if (order.type === "trailing_stop_market") {
				const percent = order.trailingPercent;
				if (percent === undefined) return undefined;
				const extreme = order.trailingExtreme ?? seg.low;
				// Check against the extreme from previous segments first: a
				// candle's own high must not tighten the stop for its own low.
				const level = trailingStopLevel(order.side, extreme, percent);
				if ((order.side === "sell" && seg.low <= level) || (order.side === "buy" && seg.high >= level)) {
					return { index, price: level };
				}
				order.trailingExtreme = order.side === "sell" ? Math.max(extreme, seg.high) : Math.min(extreme, seg.low);
				continue;
			}

			if (isTriggerType(order.type) && !order.triggered && order.stopPrice !== undefined) {
				const fallTo = order.type.startsWith("stop") ? order.side === "sell" : order.side === "buy";
				const fires = fallTo ? seg.low <= order.stopPrice : seg.high >= order.stopPrice;
				if (!fires) continue;
				if (order.type === "stop_market" || order.type === "take_profit_market") {
					return { index, price: order.stopPrice };
				}
				// stop / take_profit: rest as a limit order. Within one candle the
				// trigger-then-cross sequence is ambiguous, so the limit check
				// starts at the next segment; a tick is a single price and may
				// satisfy both at once.
				order.triggered = true;
				if (!seg.tick) continue;
			}

			if (order.price === undefined) continue;
			if (isTriggerType(order.type) && !order.triggered) continue;
			const crossed = order.side === "buy" ? seg.low <= order.price : seg.high >= order.price;
			if (crossed) return { index, price: order.price };
		}
		return undefined;
	}

	/** Fill an open resting order at the given price, keeping its original id in history. */
	private fillRestingOrder(order: PaperOrder, fillPrice: number): void {
		this.releaseReservation(order);
		// One-cancels-the-other: the sibling leg dies with this fill. Its share
		// of the group reservation was released above (legs share one).
		if (order.ocoGroup) {
			for (const sibling of this.account.orders) {
				if (sibling.ocoGroup === order.ocoGroup && sibling.id !== order.id && sibling.status === "open") {
					sibling.status = "canceled";
				}
			}
		}
		// Resting-order settlement is one ledger mutation. Do not persist the
		// temporary market-order record created by executeFill: a crash at that
		// point would leave the original resting order open and fill it twice after
		// restart. The canonical order replacement below is the only commit.
		const fill = this.executeFill(order.symbol, order.side, order.amount - order.filled, fillPrice, undefined, false);
		// executeFill creates the canonical trade and a temporary closed order;
		// retain the original order id in order history instead.
		this.account.orders = this.account.orders.filter((o) => o.id !== fill.order.id);
		order.filled = order.amount;
		order.average = fill.order.average;
		order.cost = fill.order.cost;
		order.status = "closed";
		this.account.orders = this.account.orders.filter((o) => o.id !== order.id);
		this.account.orders.push(order);
	}

	private async lastPrice(symbol: string): Promise<number> {
		const ticker = await this.exchange.fetchTicker(symbol);
		if (!isFinitePositive(ticker.last)) throw new Error(`No finite positive price available for ${symbol}`);
		return ticker.last;
	}

	private async tryPrice(asset: string): Promise<PriceLookup> {
		if (asset === this.quoteCurrency) return { price: 1 };
		const symbol = `${asset}/${this.quoteCurrency}`;
		try {
			const ticker = await this.exchange.fetchTicker(symbol);
			if (ticker.last === undefined || !Number.isFinite(ticker.last) || ticker.last <= 0)
				return { reason: `Ticker for ${symbol} did not provide a finite positive last price` };
			return { price: ticker.last };
		} catch (error) {
			return {
				reason: `Ticker unavailable for ${symbol}: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	private async estimateQuoteValue(asset: string, amount: number): Promise<number | undefined> {
		const valuation = await this.tryPrice(asset);
		if (!("price" in valuation)) return undefined;
		const quoteValue = amount * valuation.price;
		return Number.isFinite(quoteValue) ? quoteValue : undefined;
	}

	private persist(): void {
		this.persistAccountsUnlocked(true, false);
	}
}

function toTicker(t: CcxtTicker): Ticker {
	return {
		symbol: t.symbol,
		last: t.last ?? undefined,
		bid: t.bid ?? undefined,
		ask: t.ask ?? undefined,
		high24h: t.high,
		low24h: t.low,
		changePct24h: t.percentage,
		volume24h: t.baseVolume,
		quoteVolume24h: t.quoteVolume,
		timestamp: t.timestamp ?? Date.now(),
	};
}

function toOrder(o: PaperOrder): Order {
	return {
		id: o.id,
		clientOrderId: o.clientOrderId,
		listClientOrderId: o.listClientOrderId,
		symbol: o.symbol,
		side: o.side,
		type: o.type,
		price: o.price,
		stopPrice: o.stopPrice,
		trailingPercent: o.trailingPercent,
		ocoGroup: o.ocoGroup,
		orderListId: o.ocoGroup,
		listOrderStatus: o.ocoGroup ? (o.status === "open" ? "EXECUTING" : "ALL_DONE") : undefined,
		positionSide: o.positionSide,
		reduceOnly: o.reduceOnly,
		closePosition: o.closePosition,
		amount: o.amount,
		filled: o.filled,
		remaining: o.amount - o.filled,
		average: o.average,
		cost: o.cost,
		status: o.status,
		timestamp: o.timestamp,
	};
}
