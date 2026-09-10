import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
	assertPair,
	assertStrategyName,
	assertTimeframe,
	assertTimerange,
	type FreqtradeBacktestInput,
	type FreqtradeSignalInput,
	freqtradeAuthPath,
	getFreqtradeSignals,
	getFreqtradeStatus,
	readFreqtradeAuth,
	runFreqtradeBacktest,
	saveFreqtradeAuth,
	TIMEFRAMES,
} from "./client.ts";

const timeframeList = [...TIMEFRAMES].join(", ");
const timeframeSchema = Type.Optional(Type.String({ description: `Candle timeframe. One of ${timeframeList}.` }));

const backtestSchema = Type.Object({
	strategy: Type.String({ description: "Freqtrade strategy class name, e.g. SampleStrategy." }),
	timerange: Type.String({
		description: "Freqtrade timerange: YYYYMMDD-YYYYMMDD, YYYYMMDD-, or -YYYYMMDD.",
	}),
	timeframe: timeframeSchema,
	enableProtections: Type.Optional(
		Type.Boolean({ description: "Forward Freqtrade --enable-protections. Default false." }),
	),
	stakeAmount: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "Stake amount in quote currency." })),
	dryRunWallet: Type.Optional(
		Type.Number({ exclusiveMinimum: 0, description: "Starting dry-run wallet for the backtest." }),
	),
	maxOpenTrades: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Max concurrent trades." })),
});

const signalSchema = Type.Object({
	strategy: Type.String({ description: "Freqtrade strategy class name, e.g. SampleStrategy." }),
	pair: Type.String({ description: 'ccxt pair, e.g. "BTC/USDT" or "BTC/USDT:USDT".' }),
	timeframe: Type.String({ description: `Candle timeframe. One of ${timeframeList}.` }),
	timerange: Type.Optional(
		Type.String({
			description: "Freqtrade timerange. Default is the last 30 UTC days.",
		}),
	),
	limit: Type.Optional(
		Type.Integer({ minimum: 1, maximum: 20, description: "Recent signal rows to return. Default 10." }),
	),
});

type FreqtradeExtensionAPI = Pick<ExtensionAPI, "registerCommand" | "registerTool">;

export const FREQTRADE_TOOL_NAMES = ["freqtrade_status", "freqtrade_backtest", "freqtrade_signals"] as const;

const BACKTEST_GUIDELINES = [
	"Read-only Freqtrade webserver sidecar. Never treat a backtest or signal as permission to trade.",
	"Do not call buy/sell from these results; use check_order then native buy/sell.",
	"simulate_rule is not a backtest. Use freqtrade_backtest when historical fees and trade counts matter.",
];

function jsonResult(label: string, data: unknown) {
	return {
		content: [{ type: "text" as const, text: `${label}\n${JSON.stringify(data, null, 2)}` }],
		details: data,
	};
}

function validateBacktestParams(params: unknown): FreqtradeBacktestInput {
	if (!Value.Check(backtestSchema, params)) throw new Error("Invalid Freqtrade backtest parameters");
	const request = params as FreqtradeBacktestInput;
	return {
		strategy: assertStrategyName(request.strategy),
		timerange: assertTimerange(request.timerange),
		...(request.timeframe ? { timeframe: assertTimeframe(request.timeframe) } : {}),
		...(request.enableProtections !== undefined ? { enableProtections: request.enableProtections } : {}),
		...(request.stakeAmount !== undefined ? { stakeAmount: request.stakeAmount } : {}),
		...(request.dryRunWallet !== undefined ? { dryRunWallet: request.dryRunWallet } : {}),
		...(request.maxOpenTrades !== undefined ? { maxOpenTrades: request.maxOpenTrades } : {}),
	};
}

function validateSignalParams(params: unknown): FreqtradeSignalInput {
	if (!Value.Check(signalSchema, params)) throw new Error("Invalid Freqtrade signal parameters");
	const request = params as FreqtradeSignalInput;
	return {
		strategy: assertStrategyName(request.strategy),
		pair: assertPair(request.pair),
		timeframe: assertTimeframe(request.timeframe),
		...(request.timerange ? { timerange: assertTimerange(request.timerange) } : {}),
		...(request.limit !== undefined ? { limit: request.limit } : {}),
	};
}

export function parseBacktestArgs(args: string): { strategy: string; timerange: string } | { error: string } {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	if (parts.length !== 2) return { error: "Usage: /ft-backtest STRATEGY TIMERANGE" };
	try {
		return { strategy: assertStrategyName(parts[0] ?? ""), timerange: assertTimerange(parts[1] ?? "") };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

export function parseSignalArgs(
	args: string,
): { strategy: string; pair: string; timeframe: string; timerange?: string } | { error: string } {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	if (parts.length < 3 || parts.length > 4) {
		return { error: "Usage: /ft-signal STRATEGY PAIR TIMEFRAME [TIMERANGE]" };
	}
	try {
		return {
			strategy: assertStrategyName(parts[0] ?? ""),
			pair: assertPair(parts[1] ?? ""),
			timeframe: assertTimeframe(parts[2] ?? ""),
			...(parts[3] ? { timerange: assertTimerange(parts[3]) } : {}),
		};
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

function formatStatus(status: Awaited<ReturnType<typeof getFreqtradeStatus>>): string {
	const strategies = status.strategies.length > 0 ? status.strategies.join(", ") : "(none)";
	const pairs =
		status.availablePairCount > 0 ? `${status.availablePairCount} (${status.availablePairsSample.join(", ")})` : "0";
	return [
		`Freqtrade ${status.runmode} at ${status.url}`,
		`dry_run=${status.dryRun}${status.version ? ` version=${status.version}` : ""}`,
		status.exchange ? `exchange=${status.exchange}` : undefined,
		`strategies: ${strategies}`,
		`pairs: ${pairs}`,
	]
		.filter((line): line is string => Boolean(line))
		.join("\n");
}

function formatBacktest(summary: Awaited<ReturnType<typeof runFreqtradeBacktest>>): string {
	if (summary.strategies.length === 0) return summary.statusMsg ?? summary.status;
	return summary.strategies
		.map((item) => {
			const metrics = item.metrics;
			const trades = metrics.total_trades ?? "?";
			const profit = metrics.profit_total ?? metrics.profit_total_abs ?? "?";
			const drawdown = metrics.max_drawdown ?? metrics.max_drawdown_account ?? "?";
			const winrate = metrics.winrate ?? "?";
			return `${item.strategy}: trades=${trades} profit=${profit} drawdown=${drawdown} winrate=${winrate}`;
		})
		.join("\n");
}

function formatSignals(summary: Awaited<ReturnType<typeof getFreqtradeSignals>>): string {
	const latest = summary.recentSignals.at(-1);
	const latestText = latest
		? ` latest=${latest.time ?? "n/a"} enterLong=${latest.enterLong} exitLong=${latest.exitLong}`
		: "";
	return `${summary.strategy} ${summary.pair} ${summary.timeframe}: enterLong=${summary.enterLong} exitLong=${summary.exitLong} enterShort=${summary.enterShort} exitShort=${summary.exitShort}${latestText}`;
}

export default function freqtradeExtension(pi: FreqtradeExtensionAPI): void {
	pi.registerTool({
		name: "freqtrade_status",
		label: "freqtrade_status",
		description:
			"Ping a local Freqtrade webserver sidecar and list strategies and downloaded pairs. Read-only; not an order.",
		promptGuidelines: BACKTEST_GUIDELINES,
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, signal) {
			return jsonResult("UNTRUSTED FREQTRADE RESULTS", await getFreqtradeStatus(signal));
		},
	});
	pi.registerTool({
		name: "freqtrade_backtest",
		label: "freqtrade_backtest",
		description:
			"Run a Freqtrade webserver backtest and return compact metrics (trades, profit, drawdown). Not an order.",
		promptGuidelines: BACKTEST_GUIDELINES,
		parameters: backtestSchema,
		async execute(_toolCallId, params, signal) {
			return jsonResult(
				"UNTRUSTED FREQTRADE RESULTS",
				await runFreqtradeBacktest(validateBacktestParams(params), signal),
			);
		},
	});
	pi.registerTool({
		name: "freqtrade_signals",
		label: "freqtrade_signals",
		description: "Ask Freqtrade for recent strategy entry/exit signals on one pair. Not an order and not a fill.",
		promptGuidelines: BACKTEST_GUIDELINES,
		parameters: signalSchema,
		async execute(_toolCallId, params, signal) {
			return jsonResult(
				"UNTRUSTED FREQTRADE RESULTS",
				await getFreqtradeSignals(validateSignalParams(params), signal),
			);
		},
	});
	pi.registerCommand("ft-status", {
		description: "Show the local Freqtrade sidecar status",
		handler: async (_args, ctx) => {
			try {
				ctx.ui.notify(formatStatus(await getFreqtradeStatus()), "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
	pi.registerCommand("ft-backtest", {
		description: "Run a Freqtrade webserver backtest",
		handler: async (args, ctx) => {
			const parsed = parseBacktestArgs(args);
			if ("error" in parsed) return ctx.ui.notify(parsed.error, "warning");
			try {
				ctx.ui.notify(formatBacktest(await runFreqtradeBacktest(parsed)), "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
	pi.registerCommand("ft-signal", {
		description: "Show recent Freqtrade strategy signals",
		handler: async (args, ctx) => {
			const parsed = parseSignalArgs(args);
			if ("error" in parsed) return ctx.ui.notify(parsed.error, "warning");
			try {
				ctx.ui.notify(formatSignals(await getFreqtradeSignals(parsed)), "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
	pi.registerCommand("ft-login", {
		description: "Save local Freqtrade REST username and password",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /ft-login (do not pass the password as an argument)", "error");
				return;
			}
			const username = await ctx.ui.input("Freqtrade username", "REST API username from api_server.username");
			if (username === undefined) {
				ctx.ui.notify("Freqtrade login cancelled", "info");
				return;
			}
			const password = await ctx.ui.input("Freqtrade password", "REST API password from api_server.password", {
				secret: true,
			});
			if (password === undefined) {
				ctx.ui.notify("Freqtrade login cancelled", "info");
				return;
			}
			try {
				saveFreqtradeAuth({ username, password });
				ctx.ui.notify(`Freqtrade credentials saved to ${freqtradeAuthPath()} (mode 600)`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}

export { readFreqtradeAuth, saveFreqtradeAuth };
