const STRATEGY_SUMMARY_KEYS = [
	"strategy_name",
	"timeframe",
	"stake_currency",
	"stake_amount",
	"max_open_trades",
	"starting_balance",
	"final_balance",
	"total_trades",
	"trade_count_long",
	"trade_count_short",
	"wins",
	"losses",
	"draws",
	"winrate",
	"profit_total",
	"profit_total_abs",
	"profit_mean",
	"max_drawdown",
	"max_drawdown_account",
	"max_drawdown_abs",
	"max_drawdown_start",
	"max_drawdown_end",
	"sharpe",
	"sortino",
	"calmar",
	"sqn",
	"profit_factor",
	"cagr",
	"expectancy",
	"expectancy_ratio",
	"backtest_start",
	"backtest_end",
	"backtest_days",
	"enable_protections",
] as const;

const PAIR_SUMMARY_LIMIT = 8;
const RECENT_SIGNAL_LIMIT = 10;

export type FreqtradePairSummary = {
	pair: string;
	trades?: number;
	profitTotal?: number;
	profitTotalAbs?: number;
};

export type FreqtradeStrategySummary = {
	strategy: string;
	metrics: Record<string, string | number | boolean>;
	topPairs: FreqtradePairSummary[];
};

export type FreqtradeBacktestSummary = {
	status: string;
	statusMsg?: string;
	strategies: FreqtradeStrategySummary[];
};

export type FreqtradeSignalRow = {
	time?: string;
	close?: number;
	enterLong: boolean;
	exitLong: boolean;
	enterShort: boolean;
	exitShort: boolean;
};

export type FreqtradeSignalSummary = {
	strategy: string;
	pair: string;
	timeframe: string;
	dataStart?: string;
	dataStop?: string;
	lastAnalyzed?: string;
	enterLong: number;
	exitLong: number;
	enterShort: number;
	exitShort: number;
	buySignals: number;
	sellSignals: number;
	recentSignals: FreqtradeSignalRow[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickMetrics(record: Record<string, unknown>): Record<string, string | number | boolean> {
	const metrics: Record<string, string | number | boolean> = {};
	for (const key of STRATEGY_SUMMARY_KEYS) {
		const value = record[key];
		if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
			metrics[key] = value;
		}
	}
	return metrics;
}

function asFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function pairSummaries(value: unknown): FreqtradePairSummary[] {
	if (!Array.isArray(value)) return [];
	const rows: FreqtradePairSummary[] = [];
	for (const item of value) {
		if (!isRecord(item)) continue;
		const pair = typeof item.pair === "string" ? item.pair : typeof item.key === "string" ? item.key : undefined;
		if (!pair) continue;
		const trades = asFiniteNumber(item.trades) ?? asFiniteNumber(item.trade_count);
		const profitTotal = asFiniteNumber(item.profit_total);
		const profitTotalAbs = asFiniteNumber(item.profit_total_abs);
		rows.push({
			pair,
			...(trades !== undefined ? { trades } : {}),
			...(profitTotal !== undefined ? { profitTotal } : {}),
			...(profitTotalAbs !== undefined ? { profitTotalAbs } : {}),
		});
	}
	rows.sort(
		(left, right) =>
			(right.profitTotalAbs ?? right.profitTotal ?? 0) - (left.profitTotalAbs ?? left.profitTotal ?? 0),
	);
	return rows.slice(0, PAIR_SUMMARY_LIMIT);
}

export function summarizeBacktestResult(payload: unknown): FreqtradeBacktestSummary {
	if (!isRecord(payload)) throw new Error("Invalid Freqtrade backtest response");
	const status = typeof payload.status === "string" ? payload.status : "unknown";
	const statusMsg = typeof payload.status_msg === "string" ? payload.status_msg : undefined;
	const result = isRecord(payload.backtest_result) ? payload.backtest_result : undefined;
	const strategyMap = result && isRecord(result.strategy) ? result.strategy : {};
	const strategies: FreqtradeStrategySummary[] = [];
	for (const [name, raw] of Object.entries(strategyMap)) {
		if (!isRecord(raw)) continue;
		strategies.push({
			strategy: name,
			metrics: pickMetrics(raw),
			topPairs: pairSummaries(raw.results_per_pair),
		});
	}
	return { status, ...(statusMsg ? { statusMsg } : {}), strategies };
}

function columnIndex(columns: string[], names: string[]): number {
	for (const name of names) {
		const index = columns.indexOf(name);
		if (index >= 0) return index;
	}
	return -1;
}

function cell(row: unknown, columns: string[], index: number): unknown {
	if (Array.isArray(row)) return index >= 0 ? row[index] : undefined;
	if (isRecord(row) && index >= 0) return row[columns[index] ?? ""];
	return undefined;
}

function isTruthySignal(value: unknown): boolean {
	return value === true || value === 1 || value === "1";
}

export function summarizePairHistory(payload: unknown, recentLimit = RECENT_SIGNAL_LIMIT): FreqtradeSignalSummary {
	if (!isRecord(payload)) throw new Error("Invalid Freqtrade pair history response");
	const strategy = typeof payload.strategy === "string" ? payload.strategy : "";
	const pair = typeof payload.pair === "string" ? payload.pair : "";
	const timeframe = typeof payload.timeframe === "string" ? payload.timeframe : "";
	const columns = Array.isArray(payload.columns)
		? payload.columns.filter((column): column is string => typeof column === "string")
		: [];
	const dateIndex = columnIndex(columns, ["date", "Date"]);
	const closeIndex = columnIndex(columns, ["close", "Close"]);
	const enterLongIndex = columnIndex(columns, ["enter_long", "buy"]);
	const exitLongIndex = columnIndex(columns, ["exit_long", "sell"]);
	const enterShortIndex = columnIndex(columns, ["enter_short"]);
	const exitShortIndex = columnIndex(columns, ["exit_short"]);
	const data = Array.isArray(payload.data) ? payload.data : [];
	const recentSignals: FreqtradeSignalRow[] = [];
	for (let index = data.length - 1; index >= 0 && recentSignals.length < recentLimit; index--) {
		const row = data[index];
		const enterLong = isTruthySignal(cell(row, columns, enterLongIndex));
		const exitLong = isTruthySignal(cell(row, columns, exitLongIndex));
		const enterShort = isTruthySignal(cell(row, columns, enterShortIndex));
		const exitShort = isTruthySignal(cell(row, columns, exitShortIndex));
		if (!enterLong && !exitLong && !enterShort && !exitShort) continue;
		const timeValue = cell(row, columns, dateIndex);
		const close = asFiniteNumber(cell(row, columns, closeIndex));
		recentSignals.push({
			...(typeof timeValue === "string" ? { time: timeValue } : {}),
			...(close !== undefined ? { close } : {}),
			enterLong,
			exitLong,
			enterShort,
			exitShort,
		});
	}
	recentSignals.reverse();
	return {
		strategy,
		pair,
		timeframe,
		...(typeof payload.data_start === "string" ? { dataStart: payload.data_start } : {}),
		...(typeof payload.data_stop === "string" ? { dataStop: payload.data_stop } : {}),
		...(typeof payload.last_analyzed === "string" ? { lastAnalyzed: payload.last_analyzed } : {}),
		enterLong: asFiniteNumber(payload.enter_long_signals) ?? 0,
		exitLong: asFiniteNumber(payload.exit_long_signals) ?? 0,
		enterShort: asFiniteNumber(payload.enter_short_signals) ?? 0,
		exitShort: asFiniteNumber(payload.exit_short_signals) ?? 0,
		buySignals: asFiniteNumber(payload.buy_signals) ?? 0,
		sellSignals: asFiniteNumber(payload.sell_signals) ?? 0,
		recentSignals,
	};
}
