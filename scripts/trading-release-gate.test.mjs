import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
	evaluateCandidateEvidence,
	evaluateReleaseEvidence,
	MAXIMUM_SAMPLE_GAP_MS,
	MINIMUM_SOAK_ACTIVITY_SUCCESSES,
	MINIMUM_SOAK_EXECUTION_OBSERVATIONS,
	MINIMUM_SOAK_MS,
	MINIMUM_SOAK_ORDER_OBSERVATIONS,
	REQUIRED_DRILLS,
	REQUIRED_INSTALL_CHECKS,
	REQUIRED_SUITES,
} from "./trading-release-gate.mjs";

const revision = "a".repeat(40);
const versions = { risk: "0.1.1", engine: "0.1.2", agent: "0.1.8" };
const start = Date.parse("2026-01-01T00:00:00.000Z");
const end = start + MINIMUM_SOAK_MS;
const baselineExecutions = 40;
const baselineOrders = 60;
const roots = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeObservation(root, file, value) {
	const body = JSON.stringify(value);
	writeFileSync(join(root, file), body);
	return { file, sha256: createHash("sha256").update(body).digest("hex") };
}

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "ti-release-gate-"));
	roots.push(root);
	const restartObservation = writeObservation(root, "restart-observation.json", { result: "runtime recovered" });
	const faultObservation = writeObservation(root, "fault-observation.json", { result: "transport failed as expected" });
	const artifacts = {
		offline: { kind: "offline-readiness", revision, startedAt: new Date(start).toISOString(),
			completedAt: new Date(end).toISOString(), passed: true,
			workingTreeClean: true, suites: REQUIRED_SUITES.map((name) => ({ name, exitCode: 0 })) },
		soak: { schemaVersion: 3, kind: "paper-soak", revision, mode: "paper", dataDirIdentity: `sha256:${"b".repeat(64)}`,
			startedAt: new Date(start).toISOString(),
			completedAt: new Date(end).toISOString(), restartCount: 1,
			restartEvents: [{
				type: "runtime-restart",
				at: new Date(start + MAXIMUM_SAMPLE_GAP_MS).toISOString(),
				observation: restartObservation,
			}],
			activity: {
				baseline: {
					at: new Date(start).toISOString(),
					observedExecutions: baselineExecutions,
					observedOrders: baselineOrders,
				},
				attempts: 2,
				successes: 1,
				failures: 1,
				lastSuccessAt: new Date(end).toISOString(),
			},
			samples: Array.from({ length: MINIMUM_SOAK_MS / MAXIMUM_SAMPLE_GAP_MS + 1 }, (_, index) => ({
				at: new Date(start + index * MAXIMUM_SAMPLE_GAP_MS).toISOString(),
				duplicateSubmissions: 0, lostUnresolvedRecords: 0, unresolvedExecutions: 0,
				observedExecutions: baselineExecutions,
				observedOrders: baselineOrders, healthy: true,
			})) },
		drills: { kind: "recovery-drills", revision, completedAt: new Date(end).toISOString(),
			cases: REQUIRED_DRILLS.map((name) => ({ name, passed: true, observation: "Fixture observation" })) },
		installation: { kind: "package-install", revision, completedAt: new Date(end).toISOString(), passed: true,
			nodeMajor: 22, versions,
			checks: Object.fromEntries(REQUIRED_INSTALL_CHECKS.map((key) => [key, true])) },
	};
	artifacts.soak.samples[4] = {
		...artifacts.soak.samples[4],
		healthy: false,
		activity: "failed",
	};
	artifacts.soak.samples[5] = {
		...artifacts.soak.samples[5],
		healthy: false,
		expectedFault: true,
		unresolvedExecutions: 1,
		fault: {
			type: "transport-failure",
			at: artifacts.soak.samples[5].at,
			observation: faultObservation,
		},
	};
	Object.assign(artifacts.soak.samples.at(-1), {
		activity: "succeeded",
		observedExecutions: baselineExecutions + MINIMUM_SOAK_EXECUTION_OBSERVATIONS,
		observedOrders: baselineOrders + MINIMUM_SOAK_ORDER_OBSERVATIONS,
	});
	const evidence = { schemaVersion: 3, revision, versions, pilotApproval: {
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
	return { root, artifacts, evidence, persist, restartObservation, faultObservation };
}

test("accepts complete, revision-bound evidence for a human-confirmed pilot only", () => {
	const data = fixture();
	assert.deepEqual(data.persist(), { ready: true, target: "human-confirmed-live-pilot", blockers: [] });
});

test("retains existing install gates and requires continuity and evidence registration", () => {
	assert.deepEqual(REQUIRED_INSTALL_CHECKS, [
		"cleanInstall", "cliVersion", "isolatedDataDir", "paperDefault", "recoveryAfterRestart",
		"continuityAfterRestart", "evidenceTools",
	]);
});

for (const key of REQUIRED_INSTALL_CHECKS) {
	test(`blocks installation artifacts without explicit ${key} success even when passed is true`, () => {
		const data = fixture();
		for (const value of [undefined, false, "true", 1]) {
			if (value === undefined) delete data.artifacts.installation.checks[key];
			else data.artifacts.installation.checks[key] = value;
			const result = data.persist();
			assert.equal(result.ready, false);
			assert.deepEqual(result.blockers, [`installation: ${key} has not passed`]);
		}
	});
}

test("never treats missing evidence or a short run as release readiness", () => {
	assert.equal(evaluateReleaseEvidence({}, tmpdir(), end).ready, false);
	const data = fixture();
	data.artifacts.soak.startedAt = new Date(end - 60_000).toISOString();
	assert.equal(data.persist().ready, false);
});

test("rejects legacy or idle soak evidence", () => {
	for (const mutate of [
		(data) => { data.evidence.schemaVersion = 2; },
		(data) => { data.artifacts.soak.schemaVersion = 2; },
		(data) => { data.artifacts.soak.activity.successes = 0; },
		(data) => { data.artifacts.soak.samples.at(-1).observedExecutions = baselineExecutions; },
		(data) => { data.artifacts.soak.samples.at(-1).observedOrders = baselineOrders; },
		(data) => {
			data.artifacts.soak.activity.baseline.observedExecutions =
				data.artifacts.soak.samples.at(-1).observedExecutions;
		},
	]) {
		const data = fixture();
		mutate(data);
		assert.equal(data.persist().ready, false);
	}
});

test("requires a controlled fault followed by a healthy recovery sample", () => {
	const withoutFault = fixture();
	withoutFault.artifacts.soak.samples[5] = {
		...withoutFault.artifacts.soak.samples[5],
		healthy: true,
		unresolvedExecutions: 0,
	};
	delete withoutFault.artifacts.soak.samples[5].expectedFault;
	delete withoutFault.artifacts.soak.samples[5].fault;
	assert.equal(withoutFault.persist().ready, false);

	const withoutRecovery = fixture();
	withoutRecovery.artifacts.soak.samples.splice(6);
	withoutRecovery.artifacts.soak.completedAt = withoutRecovery.artifacts.soak.samples.at(-1).at;
	assert.equal(withoutRecovery.persist().ready, false);
});

test("requires structured controlled fault and restart observations", () => {
	for (const mutate of [
		(data) => { data.artifacts.soak.restartCount = 2; },
		(data) => { data.artifacts.soak.restartEvents[0].type = "arbitrary"; },
		(data) => { data.artifacts.soak.restartEvents[0].observation = { file: "missing.json", sha256: "c".repeat(64) }; },
	]) {
		const data = fixture();
		mutate(data);
		assert.ok(data.persist().blockers.includes("soak: requires a structured controlled restart observation"));
	}

	for (const mutate of [
		(data) => { data.artifacts.soak.samples[5].fault.type = "arbitrary"; },
		(data) => { data.artifacts.soak.samples[5].fault.at = data.artifacts.soak.samples[6].at; },
		(data) => { data.artifacts.soak.samples[5].fault.observation = { file: "missing.json", sha256: "c".repeat(64) }; },
	]) {
		const data = fixture();
		mutate(data);
		assert.ok(data.persist().blockers.includes(
			"soak: requires continuous <=10-minute samples, no duplicate/lost executions, and a healthy resolved finish",
		));
	}
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

test("activity evidence counters must be internally consistent", () => {
	for (const mutate of [
		(data) => { data.artifacts.soak.activity.attempts = 0; },
		(data) => { data.artifacts.soak.activity.successes = MINIMUM_SOAK_ACTIVITY_SUCCESSES - 1; },
		(data) => { data.artifacts.soak.activity.failures = 2; },
		(data) => { data.artifacts.soak.activity.lastSuccessAt = null; },
		(data) => { delete data.artifacts.soak.activity.baseline; },
		(data) => { data.artifacts.soak.activity.baseline.at = new Date(start - 1).toISOString(); },
	]) {
		const data = fixture();
		mutate(data);
		assert.equal(data.persist().ready, false);
	}
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

	const tamperedFault = fixture();
	tamperedFault.persist();
	writeFileSync(join(tamperedFault.root, tamperedFault.faultObservation.file), '{"result":"forged"}');
	assert.equal(evaluateReleaseEvidence(tamperedFault.evidence, tamperedFault.root, end + 1).ready, false);

	const tamperedRestart = fixture();
	tamperedRestart.persist();
	writeFileSync(join(tamperedRestart.root, tamperedRestart.restartObservation.file), '{"result":"forged"}');
	assert.equal(evaluateReleaseEvidence(tamperedRestart.evidence, tamperedRestart.root, end + 1).ready, false);
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
