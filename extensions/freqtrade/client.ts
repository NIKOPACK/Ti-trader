import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Agent } from "undici";
import {
	type FreqtradeBacktestSummary,
	type FreqtradeSignalSummary,
	summarizeBacktestResult,
	summarizePairHistory,
} from "./summarize.ts";

export const DEFAULT_FREQTRADE_URL = "http://127.0.0.1:8080";
export const DEFAULT_AUTH_PATH = join(homedir(), ".ti-trader", "agent", "freqtrade-auth.json");
export const USER_AGENT = "ti-freqtrade/0.1.0";
export const REQUEST_TIMEOUT_MS = 15_000;
export const LONG_REQUEST_TIMEOUT_MS = 60_000;
export const DEFAULT_POLL_MS = 1_000;
export const DEFAULT_BACKTEST_TIMEOUT_MS = 300_000;
export const DEFAULT_RESPONSE_BYTES = 512 * 1024;
export const BACKTEST_RESPONSE_BYTES = 4 * 1024 * 1024;

export const TIMEFRAMES = new Set([
	"1m",
	"3m",
	"5m",
	"15m",
	"30m",
	"1h",
	"2h",
	"4h",
	"6h",
	"8h",
	"12h",
	"1d",
	"3d",
	"1w",
]);

export const TIMERANGE_PATTERN = /^(?:\d{8}(?:_\d{4})?-(?:\d{8}(?:_\d{4})?)?|-\d{8}(?:_\d{4})?)$/;
export const STRATEGY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const PAIR_PATTERN = /^[A-Za-z0-9]+\/[A-Za-z0-9]+(?::[A-Za-z0-9]+)?$/;

const SIGNAL_COLUMNS = [
	"date",
	"open",
	"high",
	"low",
	"close",
	"volume",
	"enter_long",
	"exit_long",
	"enter_short",
	"exit_short",
];

export const ALLOWED_API_CALLS = new Set([
	"GET /api/v1/ping",
	"GET /api/v1/show_config",
	"GET /api/v1/version",
	"GET /api/v1/strategies",
	"GET /api/v1/available_pairs",
	"GET /api/v1/backtest",
	"POST /api/v1/backtest",
	"GET /api/v1/backtest/abort",
	"POST /api/v1/pair_history",
]);

export type FreqtradeAuth = { username: string; password: string };
export type FreqtradeRunmode = "webserver" | "dry_run";
export type FreqtradeSidecarConfig = { dryRun: boolean; runmode: FreqtradeRunmode };

export type FreqtradeStatus = {
	url: string;
	ping: string;
	runmode: FreqtradeRunmode;
	dryRun: boolean;
	version?: string;
	exchange?: string;
	strategy?: string;
	timeframe?: string;
	stakeCurrency?: string;
	strategies: string[];
	availablePairCount: number;
	availablePairsSample: string[];
};

export type FreqtradeBacktestInput = {
	strategy: string;
	timerange: string;
	timeframe?: string;
	enableProtections?: boolean;
	stakeAmount?: number;
	dryRunWallet?: number;
	maxOpenTrades?: number;
};

export type FreqtradeSignalInput = {
	strategy: string;
	pair: string;
	timeframe: string;
	timerange?: string;
	limit?: number;
};

type JsonRecord = Record<string, unknown>;

const loopbackDispatcher = new Agent();

export function resetFreqtradeClient(): void {}

export function freqtradeAuthPath(): string {
	return process.env.TI_FREQTRADE_AUTH_FILE?.trim() || DEFAULT_AUTH_PATH;
}

export function configuredFreqtradeUrl(): string | undefined {
	const value = process.env.TI_FREQTRADE_URL?.trim();
	return value || undefined;
}

function mappedIpv4(host: string): string | undefined {
	const dotted = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
	if (dotted?.[1]) return dotted[1];
	const hex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
	if (!hex?.[1] || !hex[2]) return undefined;
	const high = Number.parseInt(hex[1], 16);
	const low = Number.parseInt(hex[2], 16);
	if (!Number.isFinite(high) || !Number.isFinite(low)) return undefined;
	return `${(high >> 8) & 255}.${high & 255}.${(low >> 8) & 255}.${low & 255}`;
}

export function isLoopbackHostname(hostname: string): boolean {
	const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (host === "127.0.0.1" || host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
	if (isIP(host) === 6) {
		const mapped = mappedIpv4(host);
		return mapped === "127.0.0.1";
	}
	return false;
}

export function assertSafeFreqtradeUrl(raw: string): URL {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error("Invalid Freqtrade URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Freqtrade URL must be http or https");
	}
	if (url.username || url.password) {
		throw new Error("Freqtrade URL must not contain credentials");
	}
	if (url.search || url.hash) {
		throw new Error("Freqtrade URL must not contain a query or fragment");
	}
	if (url.pathname !== "/" && url.pathname !== "") {
		throw new Error("Freqtrade URL must not contain a path");
	}
	if (!isLoopbackHostname(url.hostname)) {
		throw new Error("Freqtrade URL must be 127.0.0.1 or ::1");
	}
	return url;
}

export function resolveFreqtradeBaseUrl(): URL {
	return assertSafeFreqtradeUrl(configuredFreqtradeUrl() ?? DEFAULT_FREQTRADE_URL);
}

export function assertAllowedApiCall(method: string, url: URL, base: URL): void {
	if (url.origin !== base.origin) {
		throw new Error("Freqtrade request origin does not match the configured sidecar");
	}
	if (url.username || url.password) {
		throw new Error("Freqtrade request must not contain credentials");
	}
	const key = `${method.toUpperCase()} ${url.pathname}`;
	if (!ALLOWED_API_CALLS.has(key)) {
		throw new Error(`Freqtrade API path is not allowlisted: ${key}`);
	}
}

export function assertStrategyName(value: string): string {
	const strategy = value.trim();
	if (!STRATEGY_PATTERN.test(strategy)) throw new Error("Invalid Freqtrade strategy name");
	return strategy;
}

export function assertTimerange(value: string): string {
	const timerange = value.trim();
	if (!TIMERANGE_PATTERN.test(timerange)) {
		throw new Error("Invalid Freqtrade timerange; use YYYYMMDD-YYYYMMDD, YYYYMMDD-, or -YYYYMMDD");
	}
	return timerange;
}

export function assertPair(value: string): string {
	const pair = value.trim();
	if (!PAIR_PATTERN.test(pair)) throw new Error('Invalid Freqtrade pair; use ccxt form such as "BTC/USDT"');
	return pair.toUpperCase();
}

export function assertTimeframe(value: string): string {
	const timeframe = value.trim();
	if (!TIMEFRAMES.has(timeframe)) throw new Error(`Unsupported Freqtrade timeframe: ${timeframe}`);
	return timeframe;
}

export function defaultTimerange(now = new Date()): string {
	const end = new Date(now.getTime());
	const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
	const stamp = (date: Date): string => date.toISOString().slice(0, 10).replaceAll("-", "");
	return `${stamp(start)}-${stamp(end)}`;
}

export function readFreqtradeAuth(path = freqtradeAuthPath()): FreqtradeAuth | undefined {
	const username = process.env.TI_FREQTRADE_USERNAME?.trim();
	const password = process.env.TI_FREQTRADE_PASSWORD?.trim();
	if (username || password) {
		if (!username || !password) {
			throw new Error("Both TI_FREQTRADE_USERNAME and TI_FREQTRADE_PASSWORD are required");
		}
		return { username, password };
	}
	if (!existsSync(path)) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
	} catch {
		throw new Error(`Invalid Freqtrade auth file: ${path}`);
	}
	if (!isRecord(parsed)) throw new Error(`Invalid Freqtrade auth file: ${path}`);
	const fileUser = typeof parsed.username === "string" ? parsed.username.trim() : "";
	const filePassword = typeof parsed.password === "string" ? parsed.password.trim() : "";
	if (!fileUser || !filePassword) throw new Error(`Freqtrade auth file is missing username or password: ${path}`);
	return { username: fileUser, password: filePassword };
}

export function saveFreqtradeAuth(auth: FreqtradeAuth, path = freqtradeAuthPath()): void {
	const username = auth.username.trim();
	const password = auth.password.trim();
	if (!username || !password) throw new Error("Freqtrade username and password must not be empty");
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(temporaryPath, `${JSON.stringify({ username, password }, null, "\t")}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		chmodSync(temporaryPath, 0o600);
		renameSync(temporaryPath, path);
		chmodSync(path, 0o600);
	} catch (error) {
		rmSync(temporaryPath, { force: true });
		throw error;
	}
}

export function assertResearchSidecar(config: { dry_run?: unknown; runmode?: unknown }): FreqtradeSidecarConfig {
	const runmode = typeof config.runmode === "string" ? config.runmode.trim().toLowerCase() : "";
	if (config.dry_run === false || runmode === "live") {
		throw new Error(
			"Freqtrade sidecar is in live mode; refuse to connect. Point TI_FREQTRADE_URL at `freqtrade webserver` without live keys.",
		);
	}
	if (runmode !== "webserver" && runmode !== "dry_run") {
		throw new Error(`Freqtrade sidecar runmode ${runmode || "unknown"} is not allowed; use webserver or dry_run.`);
	}
	return { dryRun: config.dry_run !== false, runmode };
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function basicAuthHeader(auth: FreqtradeAuth): string {
	return `Basic ${Buffer.from(`${auth.username}:${auth.password}`, "utf8").toString("base64")}`;
}

function requestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function pollMs(): number {
	const raw = Number(process.env.TI_FREQTRADE_POLL_MS);
	return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_POLL_MS;
}

function backtestTimeoutMs(): number {
	const raw = Number(process.env.TI_FREQTRADE_TIMEOUT_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BACKTEST_TIMEOUT_MS;
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) {
		if (signal?.aborted) throw signal.reason ?? new Error("Freqtrade request was cancelled");
		return;
	}
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(signal?.reason ?? new Error("Freqtrade request was cancelled"));
		};
		if (signal?.aborted) {
			clearTimeout(timer);
			onAbort();
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export async function readResponseText(response: Response, maxBytes = DEFAULT_RESPONSE_BYTES): Promise<string> {
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
		throw new Error("Freqtrade response is too large");
	}
	if (!response.body) throw new Error("Freqtrade response has no body");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const chunks: string[] = [];
	let bytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > maxBytes) throw new Error("Freqtrade response is too large");
			chunks.push(decoder.decode(value, { stream: true }));
		}
		chunks.push(decoder.decode());
		return chunks.join("");
	} finally {
		await reader.cancel().catch(() => undefined);
	}
}

function httpErrorMessage(status: number, body: string, path: string): string {
	if (status === 401 || status === 403) return "Freqtrade API authentication failed";
	if (status === 404 && path.includes("/backtest")) {
		return "Freqtrade backtest API is unavailable; start `freqtrade webserver`";
	}
	try {
		const parsed = JSON.parse(body) as unknown;
		if (isRecord(parsed) && typeof parsed.detail === "string" && parsed.detail.trim()) {
			return `Freqtrade API error (${status}): ${parsed.detail.trim()}`;
		}
	} catch {
		// use the generic message
	}
	return `Freqtrade API failed with HTTP ${status}`;
}

type FreqtradeRequestOptions = {
	method: "GET" | "POST";
	path: string;
	query?: Record<string, string>;
	body?: unknown;
	auth?: boolean;
	timeoutMs?: number;
	maxBytes?: number;
	signal?: AbortSignal;
};

export async function freqtradeRequest(options: FreqtradeRequestOptions): Promise<unknown> {
	const base = resolveFreqtradeBaseUrl();
	const url = new URL(options.path, base.origin);
	for (const [key, value] of Object.entries(options.query ?? {})) {
		url.searchParams.set(key, value);
	}
	assertAllowedApiCall(options.method, url, base);
	const headers: Record<string, string> = {
		accept: "application/json",
		"user-agent": USER_AGENT,
	};
	if (options.auth !== false) {
		const auth = readFreqtradeAuth();
		if (!auth) {
			throw new Error(
				"Freqtrade API credentials are not configured; set TI_FREQTRADE_USERNAME and TI_FREQTRADE_PASSWORD or run /ft-login",
			);
		}
		headers.authorization = basicAuthHeader(auth);
	}
	let serialized: string | undefined;
	if (options.body !== undefined) {
		serialized = JSON.stringify(options.body);
		headers["content-type"] = "application/json";
	}
	let response: Response;
	try {
		const init: RequestInit = {
			method: options.method,
			redirect: "error",
			headers,
			body: serialized,
			signal: requestSignal(options.timeoutMs ?? REQUEST_TIMEOUT_MS, options.signal),
		};
		Object.assign(init, { dispatcher: loopbackDispatcher });
		response = await fetch(url, init);
	} catch (error) {
		if (options.signal?.aborted) throw new Error("Freqtrade request was cancelled", { cause: error });
		throw new Error("Freqtrade sidecar is unavailable", { cause: error });
	}
	const text = await readResponseText(response, options.maxBytes ?? DEFAULT_RESPONSE_BYTES);
	if (!response.ok) throw new Error(httpErrorMessage(response.status, text, url.pathname));
	if (!text) return undefined;
	const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
	if (!contentType.includes("json")) throw new Error("Freqtrade response must be JSON");
	try {
		return JSON.parse(text) as unknown;
	} catch (error) {
		throw new Error("Invalid Freqtrade response JSON", { cause: error });
	}
}

async function ensureSidecar(signal?: AbortSignal): Promise<FreqtradeSidecarConfig> {
	const payload = await freqtradeRequest({
		method: "GET",
		path: "/api/v1/show_config",
		signal,
	});
	if (!isRecord(payload)) throw new Error("Invalid Freqtrade show_config response");
	return assertResearchSidecar(payload);
}

async function abortBacktest(): Promise<void> {
	await freqtradeRequest({
		method: "GET",
		path: "/api/v1/backtest/abort",
	}).catch(() => undefined);
}

export async function getFreqtradeStatus(signal?: AbortSignal): Promise<FreqtradeStatus> {
	const pingPayload = await freqtradeRequest({
		method: "GET",
		path: "/api/v1/ping",
		auth: false,
		signal,
	});
	const ping = isRecord(pingPayload) && typeof pingPayload.status === "string" ? pingPayload.status : "pong";
	const showConfig = await freqtradeRequest({ method: "GET", path: "/api/v1/show_config", signal });
	if (!isRecord(showConfig)) throw new Error("Invalid Freqtrade show_config response");
	const config = assertResearchSidecar(showConfig);
	const [versionPayload, strategiesPayload, pairsPayload] = await Promise.all([
		freqtradeRequest({ method: "GET", path: "/api/v1/version", signal }).catch(() => undefined),
		freqtradeRequest({ method: "GET", path: "/api/v1/strategies", signal }).catch(() => undefined),
		freqtradeRequest({ method: "GET", path: "/api/v1/available_pairs", signal }).catch(() => undefined),
	]);
	const configRecord = showConfig;
	const strategies =
		isRecord(strategiesPayload) && Array.isArray(strategiesPayload.strategies)
			? strategiesPayload.strategies.filter((name): name is string => typeof name === "string").slice(0, 50)
			: [];
	const pairs =
		isRecord(pairsPayload) && Array.isArray(pairsPayload.pairs)
			? pairsPayload.pairs.filter((name): name is string => typeof name === "string")
			: [];
	return {
		url: resolveFreqtradeBaseUrl().origin,
		ping,
		runmode: config.runmode,
		dryRun: config.dryRun,
		...(isRecord(versionPayload) && typeof versionPayload.version === "string"
			? { version: versionPayload.version }
			: {}),
		...(typeof configRecord.exchange === "string" ? { exchange: configRecord.exchange } : {}),
		...(typeof configRecord.strategy === "string" ? { strategy: configRecord.strategy } : {}),
		...(typeof configRecord.timeframe === "string" ? { timeframe: configRecord.timeframe } : {}),
		...(typeof configRecord.stake_currency === "string" ? { stakeCurrency: configRecord.stake_currency } : {}),
		strategies,
		availablePairCount:
			typeof pairsPayload === "object" && pairsPayload && "length" in pairsPayload
				? asCount(pairsPayload.length, pairs.length)
				: pairs.length,
		availablePairsSample: pairs.slice(0, 12),
	};
}

function asCount(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export async function runFreqtradeBacktest(
	input: FreqtradeBacktestInput,
	signal?: AbortSignal,
): Promise<FreqtradeBacktestSummary> {
	const strategy = assertStrategyName(input.strategy);
	const timerange = assertTimerange(input.timerange);
	const config = await ensureSidecar(signal);
	if (config.runmode !== "webserver") {
		throw new Error("freqtrade_backtest requires `freqtrade webserver` (current runmode is dry_run)");
	}
	const body: JsonRecord = {
		strategy,
		timerange,
		enable_protections: input.enableProtections === true,
	};
	if (input.timeframe) body.timeframe = assertTimeframe(input.timeframe);
	if (input.stakeAmount !== undefined) body.stake_amount = input.stakeAmount;
	if (input.dryRunWallet !== undefined) body.dry_run_wallet = input.dryRunWallet;
	if (input.maxOpenTrades !== undefined) body.max_open_trades = input.maxOpenTrades;
	await freqtradeRequest({
		method: "POST",
		path: "/api/v1/backtest",
		body,
		timeoutMs: LONG_REQUEST_TIMEOUT_MS,
		signal,
	});
	const timeoutMs = backtestTimeoutMs();
	const started = Date.now();
	try {
		while (true) {
			if (signal?.aborted) throw new Error("Freqtrade backtest was cancelled");
			const snapshot = await freqtradeRequest({
				method: "GET",
				path: "/api/v1/backtest",
				maxBytes: BACKTEST_RESPONSE_BYTES,
				signal,
			});
			if (isRecord(snapshot) && snapshot.running === true) {
				if (Date.now() - started >= timeoutMs) throw new Error("Freqtrade backtest timed out");
				await sleep(pollMs(), signal);
				continue;
			}
			if (isRecord(snapshot) && snapshot.status === "error") {
				const message = typeof snapshot.status_msg === "string" ? snapshot.status_msg : "Freqtrade backtest failed";
				throw new Error(message);
			}
			return summarizeBacktestResult(snapshot);
		}
	} catch (error) {
		await abortBacktest();
		if (signal?.aborted) throw new Error("Freqtrade backtest was cancelled", { cause: error });
		throw error;
	}
}

export async function getFreqtradeSignals(
	input: FreqtradeSignalInput,
	signal?: AbortSignal,
): Promise<FreqtradeSignalSummary> {
	const strategy = assertStrategyName(input.strategy);
	const pair = assertPair(input.pair);
	const timeframe = assertTimeframe(input.timeframe);
	const timerange = assertTimerange(input.timerange ?? defaultTimerange());
	await ensureSidecar(signal);
	const payload = await freqtradeRequest({
		method: "POST",
		path: "/api/v1/pair_history",
		body: {
			strategy,
			pair,
			timeframe,
			timerange,
			columns: SIGNAL_COLUMNS,
		},
		timeoutMs: LONG_REQUEST_TIMEOUT_MS,
		maxBytes: BACKTEST_RESPONSE_BYTES,
		signal,
	});
	return summarizePairHistory(payload, input.limit);
}
