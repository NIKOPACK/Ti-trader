import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { evaluateCandidateEvidence, evaluateReleaseEvidence, MAXIMUM_SAMPLE_GAP_MS, MINIMUM_SOAK_MS, REQUIRED_DRILLS, REQUIRED_SUITES } from "./trading-release-gate.mjs";

const revision = "a".repeat(40);
const versions = { risk: "0.1.1", engine: "0.1.2", agent: "0.1.8" };
const start = Date.parse("2026-01-01T00:00:00.000Z");
const end = start + MINIMUM_SOAK_MS;
const roots = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "ti-release-gate-"));
	roots.push(root);
	const artifacts = {
		offline: { kind: "offline-readiness", revision, startedAt: new Date(start).toISOString(),
			completedAt: new Date(end).toISOString(), passed: true,
			workingTreeClean: true, suites: REQUIRED_SUITES.map((name) => ({ name, exitCode: 0 })) },
		soak: { kind: "paper-soak", revision, mode: "paper", startedAt: new Date(start).toISOString(),
			completedAt: new Date(end).toISOString(), restartCount: 1,
			samples: Array.from({ length: MINIMUM_SOAK_MS / MAXIMUM_SAMPLE_GAP_MS + 1 }, (_, index) => ({
				at: new Date(start + index * MAXIMUM_SAMPLE_GAP_MS).toISOString(),
				duplicateSubmissions: 0, lostUnresolvedRecords: 0, unresolvedExecutions: 0, healthy: true,
			})) },
		drills: { kind: "recovery-drills", revision, completedAt: new Date(end).toISOString(),
			cases: REQUIRED_DRILLS.map((name) => ({ name, passed: true, observation: "Fixture observation" })) },
		installation: { kind: "package-install", revision, completedAt: new Date(end).toISOString(), passed: true,
			nodeMajor: 22, versions,
			checks: { cleanInstall: true, cliVersion: true, isolatedDataDir: true, paperDefault: true, recoveryAfterRestart: true } },
	};
	const evidence = { schemaVersion: 1, revision, versions, pilotApproval: {
		reviewer: "maintainer", revision, scope: "human-confirmed-live-pilot", exchange: "binance", market: "spot",
		quoteCurrency: "USDT", maxNotional: 10, withdrawalsDisabled: true, confirmEveryOrder: true,
		approvedAt: new Date(end).toISOString(),
	} };
	const persist = () => {
		for (const [key, data] of Object.entries(artifacts)) {
			const body = JSON.stringify(data);
			writeFileSync(join(root, `${key}.json`), body);
			evidence[key] = { file: `${key}.json`, sha256: createHash("sha256").update(body).digest("hex") };
		}
		return evaluateReleaseEvidence(evidence, root, end + 1);
	};
	return { root, artifacts, evidence, persist };
}

test("accepts complete, revision-bound evidence for a human-confirmed pilot only", () => {
	const data = fixture();
	assert.deepEqual(data.persist(), { ready: true, target: "human-confirmed-live-pilot", blockers: [] });
});

test("never treats missing evidence or a short run as release readiness", () => {
	assert.equal(evaluateReleaseEvidence({}, tmpdir(), end).ready, false);
	const data = fixture();
	data.artifacts.soak.startedAt = new Date(end - 60_000).toISOString();
	assert.equal(data.persist().ready, false);
});

for (const scenario of ["gap", "duplicate", "lost", "pending", "future", "unhealthy", "no-restart"]) {
	test(`blocks a soak with ${scenario}`, () => {
		const data = fixture();
		const soak = data.artifacts.soak;
		if (scenario === "gap") soak.samples.splice(1, 2);
		if (scenario === "duplicate") soak.samples[5].duplicateSubmissions = 1;
		if (scenario === "lost") soak.samples[5].lostUnresolvedRecords = 1;
		if (scenario === "pending") soak.samples.at(-1).unresolvedExecutions = 1;
		if (scenario === "future") soak.completedAt = new Date(end + 60_000).toISOString();
		if (scenario === "unhealthy") soak.samples.at(-1).healthy = false;
		if (scenario === "no-restart") soak.restartCount = 0;
		assert.equal(data.persist().ready, false);
	});
}

test("fault injection may be observed mid-soak but must end resolved and healthy", () => {
	const data = fixture();
	data.artifacts.soak.samples[5] = { ...data.artifacts.soak.samples[5],
		healthy: false, expectedFault: true, unresolvedExecutions: 1 };
	assert.equal(data.persist().ready, true);
});

test("rejects dirty, failing or differently-versioned evidence", () => {
	for (const mutate of [
		(data) => { data.artifacts.offline.workingTreeClean = false; },
		(data) => { data.artifacts.offline.suites[0].exitCode = 1; },
		(data) => { data.artifacts.offline.suites.pop(); },
		(data) => { data.artifacts.offline.startedAt = new Date(end + 1).toISOString(); },
		(data) => { delete data.artifacts.offline.startedAt; },
		(data) => { data.artifacts.soak.samples = [null, null]; },
		(data) => { data.artifacts.drills.revision = "b".repeat(40); },
		(data) => { data.artifacts.installation.versions = { ...versions, risk: "0.0.1" }; },
		(data) => { data.artifacts.drills.cases.pop(); },
		(data) => { data.evidence.pilotApproval.confirmEveryOrder = false; },
	]) {
		const data = fixture();
		mutate(data);
		assert.equal(data.persist().ready, false);
	}
});

test("requires hash-verified artifacts and blocks symlinks outside the evidence root", () => {
	const data = fixture();
	data.persist();
	writeFileSync(join(data.root, "offline.json"), "{}");
	assert.equal(evaluateReleaseEvidence(data.evidence, data.root, end + 1).ready, false);
	data.persist();
	const outside = fixture();
	outside.persist();
	symlinkSync(join(outside.root, "offline.json"), join(data.root, "outside.json"));
	data.evidence.offline.file = "outside.json";
	assert.equal(evaluateReleaseEvidence(data.evidence, data.root, end + 1).ready, false);
});

test("binds evidence to the actual checkout revision, package versions and clean state", () => {
	const data = fixture();
	data.persist();
	const candidate = { revision, workingTreeClean: true, versions };
	assert.equal(evaluateCandidateEvidence(data.evidence, data.root, candidate, end + 1).ready, true);
	for (const changed of [
		{ ...candidate, revision: "b".repeat(40) },
		{ ...candidate, workingTreeClean: false },
		{ ...candidate, versions: { ...versions, agent: "0.0.1" } },
	]) {
		assert.equal(evaluateCandidateEvidence(data.evidence, data.root, changed, end + 1).ready, false);
	}
	assert.equal(evaluateCandidateEvidence(null, data.root, candidate, end + 1).ready, false);
});
