import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	assertAllowedApiCall,
	assertResearchSidecar,
	assertSafeFreqtradeUrl,
	DEFAULT_FREQTRADE_URL,
	freqtradeAuthPath,
	getFreqtradeSignals,
	getFreqtradeStatus,
	readFreqtradeAuth,
	resetFreqtradeClient,
	resolveFreqtradeBaseUrl,
	runFreqtradeBacktest,
	saveFreqtradeAuth,
} from "../../../extensions/freqtrade/client.ts";
import freqtradeExtension, {
	FREQTRADE_TOOL_NAMES,
	parseBacktestArgs,
	parseSignalArgs,
} from "../../../extensions/freqtrade/index.ts";
import { summarizeBacktestResult, summarizePairHistory } from "../../../extensions/freqtrade/summarize.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	resetFreqtradeClient();
	delete process.env.TI_FREQTRADE_URL;
	delete process.env.TI_FREQTRADE_USERNAME;
	delete process.env.TI_FREQTRADE_PASSWORD;
	delete process.env.TI_FREQTRADE_AUTH_FILE;
	delete process.env.TI_FREQTRADE_POLL_MS;
	delete process.env.TI_FREQTRADE_TIMEOUT_MS;
	for (const path of temporaryDirectories.splice(0)) rmSync(path, { force: true, recursive: true });
});

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function hrefOf(input: Parameters<typeof fetch>[0]): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.href;
	return input.url;
}

function headerRecord(init?: RequestInit): Record<string, string> {
	const headers = init?.headers;
	if (!headers || typeof headers !== "object" || Array.isArray(headers) || headers instanceof Headers) {
		return {};
	}
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers as Record<string, string>)) {
		result[key.toLowerCase()] = value;
	}
	return result;
}

type FetchCall = [Parameters<typeof fetch>[0], (RequestInit & { dispatcher?: unknown }) | undefined];

function mockFetch(handler: (url: URL, init?: RequestInit) => Response) {
	return vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
		return Promise.resolve(handler(new URL(hrefOf(input)), init));
	});
}

function fetchCalls(spy: ReturnType<typeof mockFetch>): FetchCall[] {
	return spy.mock.calls as FetchCall[];
}

function withAuth(): void {
	process.env.TI_FREQTRADE_USERNAME = "Freqtrader";
	process.env.TI_FREQTRADE_PASSWORD = "secret-password";
}

function webserverConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		dry_run: true,
		runmode: "webserver",
		exchange: "binance",
		strategy: "SampleStrategy",
		timeframe: "5m",
		stake_currency: "USDT",
		...overrides,
	};
}

describe("freqtrade URL and path safety", () => {
	it("accepts loopback http URLs without a path", () => {
		expect(assertSafeFreqtradeUrl("http://127.0.0.1:8080").origin).toBe("http://127.0.0.1:8080");
		expect(["::1", "[::1]"]).toContain(assertSafeFreqtradeUrl("http://[::1]:8080").hostname);
		expect(resolveFreqtradeBaseUrl().href).toBe(`${DEFAULT_FREQTRADE_URL}/`);
	});

	it.each([
		"http://localhost:8080",
		"http://127.0.0.2:8080",
		"http://8.8.8.8:8080",
		"https://example.com",
		"http://127.0.0.1:8080/api/v1",
		"http://user:pass@127.0.0.1:8080",
		"http://127.0.0.1:8080/?x=1",
		"ftp://127.0.0.1:8080",
	])("rejects unsafe Freqtrade URL %s", (url) => {
		expect(() => assertSafeFreqtradeUrl(url)).toThrow();
	});

	it("accepts IPv4-mapped loopback", () => {
		expect(assertSafeFreqtradeUrl("http://[::ffff:127.0.0.1]:8080").hostname.toLowerCase()).toMatch(/127|ffff/);
		expect(assertSafeFreqtradeUrl("http://[::ffff:7f00:1]:8080").hostname.toLowerCase()).toMatch(/ffff/);
	});

	it("allowlists research paths and rejects trading control paths", () => {
		const base = assertSafeFreqtradeUrl("http://127.0.0.1:8080");
		expect(() => assertAllowedApiCall("GET", new URL("/api/v1/ping", base.origin), base)).not.toThrow();
		expect(() => assertAllowedApiCall("POST", new URL("/api/v1/backtest", base.origin), base)).not.toThrow();
		expect(() => assertAllowedApiCall("POST", new URL("/api/v1/forceenter", base.origin), base)).toThrow(
			/not allowlisted/,
		);
		expect(() => assertAllowedApiCall("POST", new URL("/api/v1/start", base.origin), base)).toThrow(
			/not allowlisted/,
		);
		expect(() => assertAllowedApiCall("GET", new URL("/api/v1/../forceenter", base.origin), base)).toThrow(
			/not allowlisted/,
		);
	});

	it("refuses live sidecars", () => {
		expect(() => assertResearchSidecar({ dry_run: false, runmode: "live" })).toThrow(/live mode/);
		expect(() => assertResearchSidecar({ dry_run: true, runmode: "live" })).toThrow(/live mode/);
		expect(assertResearchSidecar({ dry_run: true, runmode: "webserver" }).runmode).toBe("webserver");
		expect(assertResearchSidecar({ dry_run: true, runmode: "dry_run" }).runmode).toBe("dry_run");
	});
});

describe("freqtrade summaries", () => {
	it("strips trades and keeps compact metrics", () => {
		const summary = summarizeBacktestResult({
			status: "ended",
			status_msg: "Backtest ended",
			backtest_result: {
				strategy: {
					SampleStrategy: {
						strategy_name: "SampleStrategy",
						total_trades: 12,
						profit_total: 0.08,
						max_drawdown: 0.12,
						winrate: 0.5,
						trades: [{ pair: "BTC/USDT", profit: 1 }],
						results_per_pair: [
							{ key: "ETH/USDT", trades: 2, profit_total_abs: 1 },
							{ key: "BTC/USDT", trades: 10, profit_total_abs: 9 },
						],
					},
				},
			},
		});
		expect(summary.strategies[0]?.metrics.total_trades).toBe(12);
		expect(summary.strategies[0]?.topPairs.map((row) => row.pair)).toEqual(["BTC/USDT", "ETH/USDT"]);
		expect(JSON.stringify(summary)).not.toContain('"profit":1');
	});

	it("extracts recent signal rows from pair history", () => {
		const summary = summarizePairHistory({
			strategy: "SampleStrategy",
			pair: "BTC/USDT",
			timeframe: "1h",
			enter_long_signals: 2,
			exit_long_signals: 1,
			enter_short_signals: 0,
			exit_short_signals: 0,
			buy_signals: 2,
			sell_signals: 1,
			columns: ["date", "close", "enter_long", "exit_long", "enter_short", "exit_short"],
			data: [
				["2024-01-01", 100, 0, 0, 0, 0],
				["2024-01-02", 110, 1, 0, 0, 0],
				["2024-01-03", 105, 0, 1, 0, 0],
			],
		});
		expect(summary.enterLong).toBe(2);
		expect(summary.recentSignals).toEqual([
			{ time: "2024-01-02", close: 110, enterLong: true, exitLong: false, enterShort: false, exitShort: false },
			{ time: "2024-01-03", close: 105, enterLong: false, exitLong: true, enterShort: false, exitShort: false },
		]);
	});
});

describe("freqtrade client", () => {
	it("pings the sidecar and lists strategies without leaking the password", async () => {
		withAuth();
		const fetchMock = mockFetch((url) => {
			if (url.pathname === "/api/v1/ping") return jsonResponse({ status: "pong" });
			if (url.pathname === "/api/v1/show_config") return jsonResponse(webserverConfig());
			if (url.pathname === "/api/v1/version") return jsonResponse({ version: "2026.9" });
			if (url.pathname === "/api/v1/strategies") return jsonResponse({ strategies: ["SampleStrategy"] });
			if (url.pathname === "/api/v1/available_pairs") {
				return jsonResponse({ length: 2, pairs: ["BTC/USDT", "ETH/USDT"] });
			}
			return jsonResponse({ detail: "unexpected" }, 404);
		});
		const status = await getFreqtradeStatus();
		expect(status).toMatchObject({
			ping: "pong",
			runmode: "webserver",
			dryRun: true,
			version: "2026.9",
			strategies: ["SampleStrategy"],
			availablePairCount: 2,
		});
		expect(JSON.stringify(status)).not.toContain("secret-password");
		const pingCall = fetchCalls(fetchMock).find((call) => hrefOf(call[0]).includes("/ping"));
		expect(headerRecord(pingCall?.[1]).authorization).toBeUndefined();
		expect(pingCall?.[1]?.dispatcher).toBeDefined();
		const configCall = fetchCalls(fetchMock).find((call) => hrefOf(call[0]).includes("/show_config"));
		expect(headerRecord(configCall?.[1]).authorization).toMatch(/^Basic /);
		expect(configCall?.[1]?.dispatcher).toBeDefined();
	});

	it("refuses a live sidecar before listing strategies", async () => {
		withAuth();
		mockFetch((url) => {
			if (url.pathname === "/api/v1/ping") return jsonResponse({ status: "pong" });
			if (url.pathname === "/api/v1/show_config") return jsonResponse({ dry_run: false, runmode: "live" });
			return jsonResponse({ strategies: ["ShouldNotLoad"] });
		});
		await expect(getFreqtradeStatus()).rejects.toThrow(/live mode/);
	});

	it("runs a webserver backtest, polls, and omits trade rows", async () => {
		withAuth();
		process.env.TI_FREQTRADE_POLL_MS = "0";
		let backtestGets = 0;
		const fetchMock = mockFetch((url, init) => {
			if (url.pathname === "/api/v1/show_config") return jsonResponse(webserverConfig());
			if (url.pathname === "/api/v1/backtest" && init?.method === "POST") {
				const body = JSON.parse(String(init.body)) as { enable_protections: boolean; strategy: string };
				expect(body).toMatchObject({ strategy: "SampleStrategy", enable_protections: false });
				return jsonResponse({ status: "running", running: true });
			}
			if (url.pathname === "/api/v1/backtest" && (init?.method === "GET" || init?.method === undefined)) {
				backtestGets += 1;
				if (backtestGets === 1) return jsonResponse({ status: "running", running: true, progress: 0.2 });
				return jsonResponse({
					status: "ended",
					running: false,
					status_msg: "Backtest ended",
					backtest_result: {
						strategy: {
							SampleStrategy: {
								total_trades: 4,
								profit_total: 0.02,
								trades: [{ secret: "should-not-leak" }],
							},
						},
					},
				});
			}
			return jsonResponse({ detail: "unexpected" }, 404);
		});
		const summary = await runFreqtradeBacktest({ strategy: "SampleStrategy", timerange: "20240101-20240201" });
		expect(summary.strategies[0]?.metrics.total_trades).toBe(4);
		expect(JSON.stringify(summary)).not.toContain("should-not-leak");
		expect(fetchCalls(fetchMock).some((call) => hrefOf(call[0]).includes("/forceenter"))).toBe(false);
	});

	it("re-checks show_config so a later live sidecar is refused", async () => {
		withAuth();
		let configs = 0;
		mockFetch((url, init) => {
			if (url.pathname === "/api/v1/show_config") {
				configs += 1;
				if (configs === 1) return jsonResponse(webserverConfig());
				return jsonResponse({ dry_run: false, runmode: "live" });
			}
			if (url.pathname === "/api/v1/pair_history" && init?.method === "POST") {
				return jsonResponse({
					strategy: "SampleStrategy",
					pair: "BTC/USDT",
					timeframe: "1h",
					enter_long_signals: 0,
					exit_long_signals: 0,
					enter_short_signals: 0,
					exit_short_signals: 0,
					buy_signals: 0,
					sell_signals: 0,
					columns: ["date", "close", "enter_long", "exit_long", "enter_short", "exit_short"],
					data: [],
				});
			}
			if (url.pathname === "/api/v1/backtest") return jsonResponse({ status: "running", running: true });
			return jsonResponse({ detail: "unexpected" }, 404);
		});
		await getFreqtradeSignals({
			strategy: "SampleStrategy",
			pair: "BTC/USDT",
			timeframe: "1h",
			timerange: "20240101-20240201",
		});
		await expect(
			runFreqtradeBacktest({ strategy: "SampleStrategy", timerange: "20240101-20240201" }),
		).rejects.toThrow(/live mode/);
		expect(configs).toBe(2);
	});

	it("rejects backtest against a dry-run trade bot", async () => {
		withAuth();
		mockFetch((url) => {
			if (url.pathname === "/api/v1/show_config") {
				return jsonResponse(webserverConfig({ runmode: "dry_run" }));
			}
			return jsonResponse({ status: "running" });
		});
		await expect(
			runFreqtradeBacktest({ strategy: "SampleStrategy", timerange: "20240101-20240201" }),
		).rejects.toThrow(/webserver/);
	});

	it("reads pair-history signals", async () => {
		withAuth();
		mockFetch((url, init) => {
			if (url.pathname === "/api/v1/show_config") return jsonResponse(webserverConfig());
			if (url.pathname === "/api/v1/pair_history" && init?.method === "POST") {
				const body = JSON.parse(String(init.body)) as { pair: string; strategy: string };
				expect(body.pair).toBe("BTC/USDT");
				expect(body.strategy).toBe("SampleStrategy");
				return jsonResponse({
					strategy: "SampleStrategy",
					pair: "BTC/USDT",
					timeframe: "1h",
					enter_long_signals: 1,
					exit_long_signals: 0,
					enter_short_signals: 0,
					exit_short_signals: 0,
					buy_signals: 1,
					sell_signals: 0,
					columns: ["date", "close", "enter_long", "exit_long", "enter_short", "exit_short"],
					data: [["2024-01-02", 110, 1, 0, 0, 0]],
				});
			}
			return jsonResponse({ detail: "unexpected" }, 404);
		});
		const signals = await getFreqtradeSignals({
			strategy: "SampleStrategy",
			pair: "btc/usdt",
			timeframe: "1h",
			timerange: "20240101-20240201",
		});
		expect(signals.enterLong).toBe(1);
		expect(signals.recentSignals).toHaveLength(1);
	});

	it("propagates cancellation while polling a backtest", async () => {
		withAuth();
		process.env.TI_FREQTRADE_POLL_MS = "20";
		const controller = new AbortController();
		const abortSignals: Array<boolean | undefined> = [];
		mockFetch((url, init) => {
			if (url.pathname === "/api/v1/show_config") return jsonResponse(webserverConfig());
			if (url.pathname === "/api/v1/backtest" && init?.method === "POST") {
				return jsonResponse({ status: "running", running: true });
			}
			if (url.pathname === "/api/v1/backtest/abort") {
				abortSignals.push(init?.signal?.aborted);
				return jsonResponse({ status: "stopping", running: false });
			}
			if (url.pathname === "/api/v1/backtest") {
				queueMicrotask(() => controller.abort(new Error("caller cancelled")));
				return jsonResponse({ status: "running", running: true });
			}
			return jsonResponse({ detail: "unexpected" }, 404);
		});
		await expect(
			runFreqtradeBacktest({ strategy: "SampleStrategy", timerange: "20240101-20240201" }, controller.signal),
		).rejects.toThrow(/cancelled/);
		expect(abortSignals).toEqual([false]);
	});

	it("aborts a timed-out backtest without the caller signal", async () => {
		withAuth();
		process.env.TI_FREQTRADE_POLL_MS = "5";
		process.env.TI_FREQTRADE_TIMEOUT_MS = "1";
		const abortSignals: Array<boolean | undefined> = [];
		mockFetch((url, init) => {
			if (url.pathname === "/api/v1/show_config") return jsonResponse(webserverConfig());
			if (url.pathname === "/api/v1/backtest" && init?.method === "POST") {
				return jsonResponse({ status: "running", running: true });
			}
			if (url.pathname === "/api/v1/backtest/abort") {
				abortSignals.push(init?.signal?.aborted);
				return jsonResponse({ status: "stopping", running: false });
			}
			if (url.pathname === "/api/v1/backtest") {
				return jsonResponse({ status: "running", running: true, progress: 0.1 });
			}
			return jsonResponse({ detail: "unexpected" }, 404);
		});
		await expect(
			runFreqtradeBacktest({ strategy: "SampleStrategy", timerange: "20240101-20240201" }),
		).rejects.toThrow(/timed out/);
		expect(abortSignals).toEqual([false]);
	});

	it("requires credentials before calling authenticated endpoints", async () => {
		mockFetch(() => jsonResponse({ status: "pong" }));
		await expect(getFreqtradeStatus()).rejects.toThrow(/credentials are not configured/);
	});
});

describe("freqtrade auth file", () => {
	it("writes mode 600 and reads the saved credentials", () => {
		const directory = mkdtempSync(join(tmpdir(), "ti-freqtrade-auth-"));
		temporaryDirectories.push(directory);
		const path = join(directory, "freqtrade-auth.json");
		process.env.TI_FREQTRADE_AUTH_FILE = path;
		saveFreqtradeAuth({ username: "Freqtrader", password: "saved-secret" });
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(readFreqtradeAuth()).toEqual({ username: "Freqtrader", password: "saved-secret" });
		expect(freqtradeAuthPath()).toBe(path);
	});
});

describe("freqtrade extension surface", () => {
	it("registers research tools and commands, never forceenter", () => {
		const tools: string[] = [];
		const commands: string[] = [];
		freqtradeExtension({
			registerTool: (tool: { name: string }) => {
				tools.push(tool.name);
			},
			registerCommand: (name: string) => {
				commands.push(name);
			},
		} as unknown as ExtensionAPI);
		expect(tools).toEqual([...FREQTRADE_TOOL_NAMES]);
		expect(commands).toEqual(["ft-status", "ft-backtest", "ft-signal", "ft-login"]);
		expect(tools.join(" ")).not.toMatch(/forceenter|forceexit|buy|sell/);
	});

	it("parses slash command arguments", () => {
		expect(parseBacktestArgs("SampleStrategy 20240101-20240201")).toEqual({
			strategy: "SampleStrategy",
			timerange: "20240101-20240201",
		});
		expect(parseBacktestArgs("oops")).toEqual({ error: "Usage: /ft-backtest STRATEGY TIMERANGE" });
		expect(parseSignalArgs("SampleStrategy BTC/USDT 1h")).toEqual({
			strategy: "SampleStrategy",
			pair: "BTC/USDT",
			timeframe: "1h",
		});
		expect(parseSignalArgs("SampleStrategy")).toEqual({
			error: "Usage: /ft-signal STRATEGY PAIR TIMEFRAME [TIMERANGE]",
		});
	});
});
