import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MAXIMUM_SAMPLE_GAP_MS } from "./trading-release-gate.mjs";

export const DEFAULT_SAMPLE_INTERVAL_MS = 8 * 60 * 1000;
const UNRESOLVED = new Set(["prepared", "submission-started", "unknown"]);

const record = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.trim().length > 0;

function readJson(path) {
	if (!existsSync(path)) return undefined;
	return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export function createSoakReport(revision, startedAt = new Date().toISOString()) {
	return {
		schemaVersion: 1,
		kind: "paper-soak",
		revision,
		mode: "paper",
		startedAt,
		restartCount: 0,
		samples: [],
		collector: { unresolvedIds: [] },
	};
}

export function clientOrderIds(entry) {
	const ids = [];
	const push = (value) => {
		if (text(value)) ids.push(value);
	};
	if (record(entry)) {
		push(entry.clientOrderId);
		push(entry.listClientOrderId);
		const intent = record(entry.intent) ? entry.intent.input : undefined;
		if (record(intent)) {
			push(intent.clientOrderId);
			push(intent.listClientOrderId);
			push(intent.aboveClientOrderId);
			push(intent.belowClientOrderId);
		}
		const orders = record(entry.evidence) && Array.isArray(entry.evidence.orders) ? entry.evidence.orders : [];
		for (const order of orders) {
			if (record(order)) {
				push(order.clientOrderId);
				push(order.listClientOrderId);
			}
		}
	}
	return ids;
}

export function paperOrdersFromAccounts(accounts) {
	const orders = [];
	for (const account of accounts) {
		if (!record(account) || !Array.isArray(account.orders)) continue;
		for (const order of account.orders) {
			if (record(order)) orders.push(order);
		}
	}
	return orders;
}

export function countDuplicateSubmissions(records, paperOrders) {
	const counts = new Map();
	const add = (id) => counts.set(id, (counts.get(id) ?? 0) + 1);
	for (const entry of records) {
		if (!record(entry) || entry.status === "prepared") continue;
		for (const id of new Set(clientOrderIds(entry))) add(`execution:${id}`);
	}
	for (const order of paperOrders) {
		if (text(order.clientOrderId)) add(`paper:${order.clientOrderId}`);
	}
	let duplicates = 0;
	for (const count of counts.values()) {
		if (count > 1) duplicates += count - 1;
	}
	return duplicates;
}

export function unresolvedExecutionIds(records) {
	return records.filter((entry) => record(entry) && text(entry.id) && UNRESOLVED.has(entry.status)).map((entry) => entry.id);
}

export function countLostUnresolvedRecords(previousIds, records) {
	const current = new Set(Array.isArray(records) ? records.filter((entry) => record(entry) && text(entry.id)).map((entry) => entry.id) : []);
	return previousIds.filter((id) => !current.has(id)).length;
}

export function loadSoakSnapshot(dataDir) {
	const agent = join(dataDir, "agent");
	const config = readJson(join(agent, "trading.json")) ?? {};
	const state = readJson(join(agent, "trading-state.json")) ?? {};
	const paperDir = join(agent, "paper");
	const paperAccounts = [];
	if (existsSync(paperDir)) {
		for (const name of readdirSync(paperDir)) {
			if (!name.endsWith(".json") || name.endsWith(".transaction.json")) continue;
			const account = readJson(join(paperDir, name));
			if (record(account)) paperAccounts.push(account);
		}
	}
	return { config, state, paperAccounts };
}

export function inspectSoakSnapshot(snapshot, previousIds = [], now = Date.now(), expectedFault = false) {
	if (!record(snapshot) || !record(snapshot.config) || !record(snapshot.state)) {
		throw new Error("soak snapshot must include config and state objects");
	}
	if (snapshot.config.mode === "live") throw new Error("Paper soak collector refuses live mode data directories");
	const records = Array.isArray(snapshot.state.executions?.records) ? snapshot.state.executions.records : [];
	const paperOrders = paperOrdersFromAccounts(snapshot.paperAccounts ?? []);
	const duplicateSubmissions = countDuplicateSubmissions(records, paperOrders);
	const lostUnresolvedRecords = countLostUnresolvedRecords(previousIds, records);
	const unresolvedIds = unresolvedExecutionIds(records);
	const healthy = duplicateSubmissions === 0 && lostUnresolvedRecords === 0;
	return {
		sample: {
			at: new Date(now).toISOString(),
			duplicateSubmissions,
			lostUnresolvedRecords,
			unresolvedExecutions: unresolvedIds.length,
			healthy: expectedFault ? false : healthy,
			...(expectedFault ? { expectedFault: true } : {}),
		},
		unresolvedIds,
	};
}

export function appendSoakSample(report, sample) {
	if (!record(report) || report.kind !== "paper-soak" || report.mode !== "paper") {
		throw new Error("soak report must be a paper-soak artifact");
	}
	if (!record(sample) || typeof sample.at !== "string") throw new Error("soak sample requires an ISO timestamp");
	const previous = report.samples.at(-1);
	if (previous) {
		const gap = Date.parse(sample.at) - Date.parse(previous.at);
		if (!Number.isFinite(gap) || gap < 0 || gap > MAXIMUM_SAMPLE_GAP_MS) {
			throw new Error("soak sample gap exceeds 10 minutes; start a new candidate soak");
		}
	} else {
		const startGap = Date.parse(sample.at) - Date.parse(report.startedAt);
		if (!Number.isFinite(startGap) || startGap < 0 || startGap > MAXIMUM_SAMPLE_GAP_MS) {
			throw new Error("first soak sample must be within 10 minutes of startedAt");
		}
	}
	report.samples.push(sample);
	return report;
}

export function noteRestart(report) {
	if (!record(report) || !Number.isSafeInteger(report.restartCount) || report.restartCount < 0) {
		throw new Error("soak report restartCount is invalid");
	}
	report.restartCount += 1;
	return report.restartCount;
}

export async function placePaperRoundTrip(initTrading) {
	const trading = await initTrading({ mode: "paper" });
	try {
		if (trading.mode !== "paper") throw new Error("soak activity requires Paper mode");
		const ticker = await trading.marketData.getTicker("BTC/USDT");
		if (!Number.isFinite(ticker.last) || ticker.last <= 0) throw new Error("soak activity missing BTC/USDT price");
		const notional = Math.min(25, trading.config.risk.maxOrderNotional * 0.05);
		const buy = await trading.tradingEngine.prepareOrder("buy", {
			symbol: "BTC/USDT",
			type: "market",
			quoteAmount: notional,
		});
		const bought = await trading.tradingEngine.placeOrder(buy);
		const sell = await trading.tradingEngine.prepareOrder("sell", {
			symbol: "BTC/USDT",
			type: "market",
			amount: bought.order.filled,
		});
		await trading.tradingEngine.placeOrder(sell);
	} finally {
		await trading.close();
	}
}

function loadReport(path, revision) {
	if (!existsSync(path)) return createSoakReport(revision);
	const report = readJson(path);
	if (!record(report) || report.kind !== "paper-soak" || report.revision !== revision) {
		throw new Error("existing soak report does not match this candidate revision");
	}
	if (!record(report.collector)) report.collector = { unresolvedIds: [] };
	return report;
}

function parseArgs(args) {
	const options = { intervalMs: DEFAULT_SAMPLE_INTERVAL_MS, expectedFault: false, complete: false };
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		const next = () => {
			const value = args[++index];
			if (!value) throw new Error(`${arg} requires a value`);
			return value;
		};
		switch (arg) {
			case "--report":
				options.reportPath = resolve(next());
				break;
			case "--data-dir":
				options.dataDir = resolve(next());
				break;
			case "--install-dir":
				options.installDir = resolve(next());
				break;
			case "--interval-ms":
				options.intervalMs = Number(next());
				break;
			case "--once":
				options.once = true;
				break;
			case "--run":
				options.run = true;
				break;
			case "--activity":
				options.activity = true;
				break;
			case "--note-restart":
				options.noteRestart = true;
				break;
			case "--expected-fault":
				options.expectedFault = true;
				break;
			case "--complete":
				options.complete = true;
				break;
			default:
				throw new Error(`Unknown option: ${arg}`);
		}
	}
	if (!options.reportPath || !options.dataDir) {
		throw new Error(
			"Usage: node scripts/trading-paper-soak.mjs --report FILE --data-dir DIR [--install-dir DIR] [--interval-ms MS] [--once|--run] [--activity] [--note-restart] [--expected-fault] [--complete]",
		);
	}
	if (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0 || options.intervalMs > MAXIMUM_SAMPLE_GAP_MS) {
		throw new Error("interval must be a positive duration no greater than 10 minutes");
	}
	if (options.once && options.run) throw new Error("choose either --once or --run");
	if (options.activity && !options.installDir) throw new Error("--activity requires --install-dir pointing at the isolated candidate install");
	return options;
}

function sampleReport(report, dataDir, expectedFault, now = Date.now()) {
	const inspected = inspectSoakSnapshot(loadSoakSnapshot(dataDir), report.collector.unresolvedIds, now, expectedFault);
	appendSoakSample(report, inspected.sample);
	report.collector.unresolvedIds = inspected.unresolvedIds;
	return inspected.sample;
}

async function loadInstalledInit(installDir) {
	const module = await import(pathToFileURL(join(installDir, "node_modules", "ti-trader", "dist", "context.js")).href);
	if (typeof module.initTrading !== "function") throw new Error("installed ti-trader does not export initTrading");
	return module.initTrading;
}

function delay(ms, signal) {
	return new Promise((resolveDelay, reject) => {
		const timer = setTimeout(resolveDelay, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason instanceof Error ? signal.reason : new Error("soak stopped"));
		};
		if (signal?.aborted) {
			onAbort();
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function main(args) {
	const options = parseArgs(args);
	const repo = fileURLToPath(new URL("../", import.meta.url));
	const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
	const existing = existsSync(options.reportPath);
	const report = loadReport(options.reportPath, revision);
	if (options.noteRestart || (options.run && existing)) noteRestart(report);
	const persist = () => writeJson(options.reportPath, report);
	const sample = () => {
		const result = sampleReport(report, options.dataDir, options.expectedFault);
		persist();
		return result;
	};
	if (!options.run) {
		const result = sample();
		if (options.complete) report.completedAt = new Date().toISOString();
		persist();
		console.log(JSON.stringify(result));
		return;
	}
	const controller = new AbortController();
	const stop = () => controller.abort();
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	const initTrading = options.activity ? await loadInstalledInit(options.installDir) : undefined;
	try {
		while (!controller.signal.aborted) {
			sample();
			if (options.activity && initTrading) {
				try {
					await placePaperRoundTrip((overrides) => initTrading(overrides));
					sample();
				} catch (error) {
					console.error(error instanceof Error ? error.message : "soak activity failed");
				}
			}
			if (options.complete) break;
			try {
				await delay(options.intervalMs, controller.signal);
			} catch {
				break;
			}
		}
	} finally {
		if (options.complete) report.completedAt = new Date().toISOString();
		persist();
		console.log(`Soak report: ${options.reportPath}`);
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		await main(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : "Paper soak collector failed");
		process.exitCode = 1;
	}
}
