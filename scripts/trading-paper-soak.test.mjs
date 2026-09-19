import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { MAXIMUM_SAMPLE_GAP_MS } from "./trading-release-gate.mjs";
import {
	appendSoakSample,
	countDuplicateSubmissions,
	countLostUnresolvedRecords,
	createSoakReport,
	dataDirIdentity,
	inspectSoakSnapshot,
	loadInstalledInit,
	loadReport,
	loadSoakSnapshot,
	noteRestart,
	placePaperRoundTrip,
	recordActivityResult,
	unresolvedExecutionIds,
} from "./trading-paper-soak.mjs";

const roots = [];
const originalDataDir = process.env.TI_DATA_DIR;
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	if (originalDataDir === undefined) delete process.env.TI_DATA_DIR;
	else process.env.TI_DATA_DIR = originalDataDir;
});

function temp() {
	const root = mkdtempSync(join(tmpdir(), "ti-paper-soak-"));
	roots.push(root);
	return root;
}

test("counts a second journal or paper order with the same client id as a duplicate submission", () => {
	const records = [
		{ id: "e1", status: "acknowledged", intent: { input: { clientOrderId: "tiabc" } } },
		{ id: "e2", status: "acknowledged", intent: { input: { clientOrderId: "tiabc" } } },
	];
	assert.equal(countDuplicateSubmissions(records, []), 1);
	assert.equal(countDuplicateSubmissions([records[0]], [{ clientOrderId: "tiabc" }, { clientOrderId: "tiabc" }]), 1);
	assert.equal(countDuplicateSubmissions([records[0]], [{ clientOrderId: "tiabc" }]), 0);
});

test("treats a missing previously unresolved record as lost, including after terminal settlement is absent", () => {
	const previous = unresolvedExecutionIds([
		{ id: "open", status: "unknown" },
		{ id: "done", status: "acknowledged" },
	]);
	assert.deepEqual(previous, ["open"]);
	assert.equal(countLostUnresolvedRecords(previous, [{ id: "open", status: "reconciled" }]), 0);
	assert.equal(countLostUnresolvedRecords(previous, [{ id: "done", status: "acknowledged" }]), 1);
});

test("accepts only Paper mode snapshots and records expected faults without dropping duplicate/lost counters", () => {
	for (const config of [{}, { mode: "live" }, { mode: "papre" }]) {
		assert.throws(
			() => inspectSoakSnapshot({ config, state: {}, paperAccounts: [] }),
			/requires a Paper mode/,
		);
	}
	const inspected = inspectSoakSnapshot({
		config: { mode: "paper" },
		state: { executions: { records: [{ id: "open", status: "unknown", intent: { input: { clientOrderId: "ti1" } } }] } },
		paperAccounts: [{ orders: [{ clientOrderId: "ti1" }] }],
	}, [], Date.parse("2026-01-01T00:00:00.000Z"), true);
	assert.equal(inspected.sample.healthy, false);
	assert.equal(inspected.sample.expectedFault, true);
	assert.equal(inspected.sample.duplicateSubmissions, 0);
	assert.equal(inspected.sample.unresolvedExecutions, 1);
});

test("rejects a sample gap over ten minutes so a stalled collector cannot be patched later", () => {
	const start = Date.parse("2026-01-01T00:00:00.000Z");
	const report = createSoakReport("a".repeat(40), "sha256:test", new Date(start).toISOString());
	appendSoakSample(report, {
		at: new Date(start).toISOString(), duplicateSubmissions: 0, lostUnresolvedRecords: 0,
		unresolvedExecutions: 0, healthy: true,
	});
	assert.throws(() => appendSoakSample(report, {
		at: new Date(start + MAXIMUM_SAMPLE_GAP_MS + 1).toISOString(), duplicateSubmissions: 0,
		lostUnresolvedRecords: 0, unresolvedExecutions: 0, healthy: true,
	}), /start a new candidate soak/);
	appendSoakSample(report, {
		at: new Date(start + MAXIMUM_SAMPLE_GAP_MS).toISOString(), duplicateSubmissions: 0,
		lostUnresolvedRecords: 0, unresolvedExecutions: 0, healthy: true,
	});
	assert.equal(noteRestart(report), 1);
});

test("binds reports and installed runtimes to the canonical data directory", async () => {
	const dataDir = temp();
	const installDir = temp();
	const canonicalDataDir = realpathSync(dataDir);
	const identity = dataDirIdentity(canonicalDataDir);
	const revision = "a".repeat(40);
	const report = createSoakReport(revision, identity, "2026-01-01T00:00:00.000Z");
	const reportPath = join(temp(), "soak.json");
	writeFileSync(reportPath, `${JSON.stringify(report)}\n`);

	assert.match(identity, /^sha256:[a-f0-9]{64}$/);
	assert.equal(JSON.stringify(report).includes(canonicalDataDir), false);
	assert.equal(loadReport(reportPath, revision, identity).dataDirIdentity, identity);
	assert.throws(() => loadReport(reportPath, revision, dataDirIdentity(temp())), /data directory/);

	const packageDir = join(installDir, "node_modules", "ti-trader");
	mkdirSync(join(packageDir, "dist"), { recursive: true });
	writeFileSync(join(packageDir, "package.json"), JSON.stringify({ type: "module" }));
	writeFileSync(
		join(packageDir, "dist", "context.js"),
		`if (process.env.TI_DATA_DIR !== ${JSON.stringify(canonicalDataDir)}) throw new Error("wrong data dir");\nexport async function initTrading() {}\n`,
	);
	const initTrading = await loadInstalledInit(installDir, dataDir);
	assert.equal(typeof initTrading, "function");
	assert.equal(process.env.TI_DATA_DIR, canonicalDataDir);
});

test("records activity attempts and marks failed activity samples unhealthy", () => {
	const startedAt = "2026-01-01T00:00:00.000Z";
	const report = createSoakReport("a".repeat(40), "sha256:test", startedAt);
	recordActivityResult(report, false, startedAt);
	const failed = inspectSoakSnapshot(
		{ config: { mode: "paper" }, state: {}, paperAccounts: [] },
		[],
		Date.parse(startedAt),
		false,
		"failed",
	);
	appendSoakSample(report, failed.sample);

	assert.deepEqual(report.activity, {
		attempts: 1,
		successes: 0,
		failures: 1,
		lastSuccessAt: null,
	});
	assert.equal(failed.sample.activity, "failed");
	assert.equal(failed.sample.healthy, false);

	const successAt = "2026-01-01T00:01:00.000Z";
	recordActivityResult(report, true, successAt);
	assert.deepEqual(report.activity, {
		attempts: 2,
		successes: 1,
		failures: 1,
		lastSuccessAt: successAt,
	});
});

test("persists a failed activity sample while binding the CLI runtime to --data-dir", () => {
	const dataDir = temp();
	const installDir = temp();
	const reportPath = join(temp(), "soak.json");
	const canonicalDataDir = realpathSync(dataDir);
	const packageDir = join(installDir, "node_modules", "ti-trader");
	mkdirSync(join(packageDir, "dist"), { recursive: true });
	writeFileSync(join(packageDir, "package.json"), JSON.stringify({ type: "module" }));
	writeFileSync(
		join(packageDir, "dist", "context.js"),
		`if (process.env.TI_DATA_DIR !== ${JSON.stringify(canonicalDataDir)}) throw new Error("wrong data dir");
export async function initTrading() {
	return {
		mode: "paper",
		marketData: { getTicker: async () => { throw new Error("simulated activity failure"); } },
		close: async () => {},
	};
}
`,
	);

	const result = spawnSync(
		process.execPath,
		[
			join(dirname(fileURLToPath(import.meta.url)), "trading-paper-soak.mjs"),
			"--report",
			reportPath,
			"--data-dir",
			dataDir,
			"--install-dir",
			installDir,
			"--once",
			"--activity",
		],
		{
			encoding: "utf-8",
			env: { ...process.env, TI_DATA_DIR: join(temp(), "wrong-data-dir") },
		},
	);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stderr, /simulated activity failure/);
	const report = JSON.parse(readFileSync(reportPath, "utf-8"));
	assert.equal(report.dataDirIdentity, dataDirIdentity(dataDir));
	assert.deepEqual(report.activity, { attempts: 1, successes: 0, failures: 1, lastSuccessAt: null });
	assert.equal(report.samples.length, 1);
	assert.equal(report.samples[0].activity, "failed");
	assert.equal(report.samples[0].healthy, false);
});

test("rejects an existing Live configuration before Paper activity", () => {
	const dataDir = temp();
	const installDir = temp();
	const reportPath = join(temp(), "soak.json");
	const agent = join(dataDir, "agent");
	mkdirSync(agent, { recursive: true });
	writeFileSync(join(agent, "trading.json"), JSON.stringify({ mode: "live" }));

	const result = spawnSync(
		process.execPath,
		[
			join(dirname(fileURLToPath(import.meta.url)), "trading-paper-soak.mjs"),
			"--report",
			reportPath,
			"--data-dir",
			dataDir,
			"--install-dir",
			installDir,
			"--once",
			"--activity",
		],
		{ encoding: "utf-8" },
	);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /configured for Paper mode/);
});

test("sizes Paper activity with quoteAmount and sells the filled lot", async () => {
	const calls = [];
	await placePaperRoundTrip(async () => ({
		mode: "paper",
		config: { risk: { maxOrderNotional: 500 } },
		marketData: { getTicker: async () => ({ last: 108_234.56 }) },
		tradingEngine: {
			prepareOrder: async (side, intent) => {
				calls.push({ side, intent });
				return { side, intent };
			},
			placeOrder: async (plan) => {
				if (plan.side === "buy") return { order: { filled: 0.0002 } };
				return { order: { filled: plan.intent.amount } };
			},
		},
		close: async () => {},
	}));
	assert.equal(calls[0].side, "buy");
	assert.equal(calls[0].intent.quoteAmount, 25);
	assert.equal(calls[0].intent.amount, undefined);
	assert.equal(calls[1].side, "sell");
	assert.equal(calls[1].intent.amount, 0.0002);
});

test("reads durable journal and paper ledgers from the isolated data directory", () => {
	const dataDir = temp();
	const agent = join(dataDir, "agent");
	mkdirSync(join(agent, "paper"), { recursive: true });
	writeFileSync(join(agent, "trading.json"), JSON.stringify({ mode: "paper", exchange: "okx" }));
	writeFileSync(join(agent, "trading-state.json"), JSON.stringify({
		paper: { date: "2026-01-01", usedDailyNotional: 0 },
		live: { date: "2026-01-01", usedDailyNotional: 0 },
		executions: { version: 1, records: [{ id: "e1", status: "unknown" }] },
	}));
	writeFileSync(join(agent, "paper", "okx-USDT.json"), JSON.stringify({ quote: "USDT", orders: [{ id: "1", clientOrderId: "ti1" }] }));
	const snapshot = loadSoakSnapshot(dataDir);
	assert.equal(snapshot.config.mode, "paper");
	assert.equal(snapshot.state.executions.records[0].id, "e1");
	assert.equal(snapshot.paperAccounts[0].orders[0].clientOrderId, "ti1");
});
