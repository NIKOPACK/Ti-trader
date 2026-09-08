import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { MAXIMUM_SAMPLE_GAP_MS } from "./trading-release-gate.mjs";
import {
	appendSoakSample,
	countDuplicateSubmissions,
	countLostUnresolvedRecords,
	createSoakReport,
	inspectSoakSnapshot,
	loadSoakSnapshot,
	noteRestart,
	unresolvedExecutionIds,
} from "./trading-paper-soak.mjs";

const roots = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
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

test("refuses live mode snapshots and records expected faults without dropping duplicate/lost counters", () => {
	assert.throws(() => inspectSoakSnapshot({ config: { mode: "live" }, state: {}, paperAccounts: [] }), /refuses live mode/);
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
	const report = createSoakReport("a".repeat(40), new Date(start).toISOString());
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
