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
	recordActivityBaseline,
	recordActivityResult,
	unresolvedExecutionIds,
} from "./trading-paper-soak.mjs";

const roots = [];
const observation = { file: "observation.json", sha256: "c".repeat(64) };
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

test("refuses live mode snapshots and binds controlled faults to their observation", () => {
	assert.throws(() => inspectSoakSnapshot({ config: { mode: "live" }, state: {}, paperAccounts: [] }), /refuses live mode/);
	const inspected = inspectSoakSnapshot({
		config: { mode: "paper" },
		state: { executions: { records: [{ id: "open", status: "unknown", intent: { input: { clientOrderId: "ti1" } } }] } },
		paperAccounts: [{ orders: [{ clientOrderId: "ti1" }] }],
	}, [], Date.parse("2026-01-01T00:00:00.000Z"), {
		type: "transport-failure",
		observation,
	});
	assert.equal(inspected.sample.healthy, false);
	assert.equal(inspected.sample.expectedFault, true);
	assert.deepEqual(inspected.sample.fault, {
		type: "transport-failure",
		at: "2026-01-01T00:00:00.000Z",
		observation,
	});
	assert.equal(inspected.sample.duplicateSubmissions, 0);
	assert.equal(inspected.sample.unresolvedExecutions, 1);
	assert.throws(
		() => inspectSoakSnapshot({ config: { mode: "paper" }, state: {}, paperAccounts: [] }, [], Date.now(), {
			type: "arbitrary",
			observation: { file: "observation.json", sha256: "invalid" },
		}),
		/controlled type and SHA-256/,
	);
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
	assert.equal(noteRestart(report, {
		type: "runtime-restart",
		observation,
	}, "2026-01-01T00:10:00.000Z"), 1);
	assert.deepEqual(report.restartEvents, [{
		type: "runtime-restart",
		at: "2026-01-01T00:10:00.000Z",
		observation,
	}]);
	assert.throws(() => noteRestart(report, {
		type: "arbitrary",
		observation,
	}), /controlled type, UTC time and SHA-256/);
});

test("binds reports and installed runtimes to the canonical data directory", async () => {
	const dataDir = temp();
	const installDir = temp();
	const canonicalDataDir = realpathSync(dataDir);
	const identity = dataDirIdentity(canonicalDataDir);
	const revision = "a".repeat(40);
	const report = createSoakReport(revision, identity, "2026-01-01T00:00:00.000Z");
	recordActivityBaseline(report, { config: { mode: "paper" }, state: {}, paperAccounts: [] }, Date.parse(report.startedAt));
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
	recordActivityBaseline(
		report,
		{ config: { mode: "paper" }, state: {}, paperAccounts: [] },
		Date.parse(startedAt),
	);
	recordActivityResult(report, false, startedAt);
	const failed = inspectSoakSnapshot(
		{ config: { mode: "paper" }, state: {}, paperAccounts: [] },
		[],
		Date.parse(startedAt),
		undefined,
		"failed",
	);
	appendSoakSample(report, failed.sample);

	assert.deepEqual(report.activity, {
		baseline: { at: startedAt, observedExecutions: 0, observedOrders: 0 },
		attempts: 1,
		successes: 0,
		failures: 1,
		lastSuccessAt: null,
	});
	assert.equal(failed.sample.activity, "failed");
	assert.equal(failed.sample.healthy, false);
	assert.equal(failed.sample.observedExecutions, 0);
	assert.equal(failed.sample.observedOrders, 0);

	const successAt = "2026-01-01T00:01:00.000Z";
	recordActivityResult(report, true, successAt);
	assert.deepEqual(report.activity, {
		baseline: { at: startedAt, observedExecutions: 0, observedOrders: 0 },
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
	mkdirSync(join(dataDir, "agent"), { recursive: true });
	writeFileSync(join(dataDir, "agent", "trading.json"), JSON.stringify({ mode: "paper" }));
	const packageDir = join(installDir, "node_modules", "ti-trader");
	mkdirSync(join(packageDir, "dist"), { recursive: true });
	writeFileSync(join(packageDir, "package.json"), JSON.stringify({ type: "module" }));
	writeFileSync(
		join(packageDir, "dist", "context.js"),
		`import { readFileSync } from "node:fs";
if (process.env.TI_DATA_DIR !== ${JSON.stringify(canonicalDataDir)}) throw new Error("wrong data dir");
export async function initTrading() {
	const report = JSON.parse(readFileSync(${JSON.stringify(reportPath)}, "utf8"));
	if (!report.activity?.baseline) throw new Error("activity baseline was not persisted");
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
	assert.deepEqual(report.activity, {
		baseline: { at: report.activity.baseline.at, observedExecutions: 0, observedOrders: 0 },
		attempts: 1,
		successes: 0,
		failures: 1,
		lastSuccessAt: null,
	});
	assert.equal(report.samples.length, 1);
	assert.equal(report.samples[0].activity, "failed");
	assert.equal(report.samples[0].healthy, false);
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
	const inspected = inspectSoakSnapshot(snapshot);
	assert.equal(inspected.sample.observedExecutions, 1);
	assert.equal(inspected.sample.observedOrders, 1);
});
