import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { approvalPayload, signApproval } from "./release-approval.mjs";
import {
	evaluateCandidateEvidence,
	evaluateReleaseEvidence,
	EVIDENCE_SCHEMA_VERSION,
	MAXIMUM_SAMPLE_GAP_MS,
	MINIMUM_SOAK_ACTIVITY_SUCCESSES,
	MINIMUM_SOAK_MS,
	REQUIRED_DRILLS,
	REQUIRED_INSTALL_CHECKS,
	REQUIRED_SUITES,
} from "./trading-release-gate.mjs";

const revision = "a".repeat(40);
const versions = { risk: "0.1.1", engine: "0.1.2", agent: "0.1.8" };
const start = Date.parse("2026-01-01T00:00:00.000Z");
const end = start + MINIMUM_SOAK_MS;
const dataDirIdentity = `sha256:${"b".repeat(64)}`;
const roots = [];
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const testReviewer = {
	id: "maintainer",
	keyId: "maintainer-ed25519-1",
	publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
	status: "active",
};
const testPrivateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const revokedReviewer = { ...testReviewer, status: "revoked" };

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function soakSamples(mutate) {
	const samples = Array.from({ length: MINIMUM_SOAK_MS / MAXIMUM_SAMPLE_GAP_MS + 1 }, (_, index) => ({
		at: new Date(start + index * MAXIMUM_SAMPLE_GAP_MS).toISOString(),
		duplicateSubmissions: 0,
		lostUnresolvedRecords: 0,
		unresolvedExecutions: index === 5 ? 1 : 0,
		healthy: index !== 5,
		activity: index === 5 ? "failed" : "succeeded",
		...(index === 5 ? { expectedFault: true } : {}),
	}));
	return mutate ? mutate(samples) : samples;
}

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "ti-release-gate-"));
	roots.push(root);
	const samples = soakSamples();
	const artifacts = {
		offline: { kind: "offline-readiness", revision, startedAt: new Date(start).toISOString(),
			completedAt: new Date(end).toISOString(), passed: true,
			workingTreeClean: true, suites: REQUIRED_SUITES.map((name) => ({ name, exitCode: 0 })) },
		soak: {
			schemaVersion: 2, kind: "paper-soak", revision, mode: "paper", dataDirIdentity,
			startedAt: new Date(start).toISOString(), completedAt: new Date(end).toISOString(), restartCount: 1,
			samples,
			activity: {
				attempts: samples.length, successes: samples.length - 1, failures: 1,
				lastSuccessAt: samples.at(-1).at,
			},
		},
		drills: { kind: "recovery-drills", revision, completedAt: new Date(end).toISOString(),
			cases: REQUIRED_DRILLS.map((name) => ({ name, passed: true, observation: "Fixture observation" })) },
		installation: { kind: "package-install", revision, completedAt: new Date(end).toISOString(), passed: true,
			nodeMajor: 22, versions,
			checks: Object.fromEntries(REQUIRED_INSTALL_CHECKS.map((key) => [key, true])) },
		liveCapabilities: {
			schemaVersion: 1, kind: "live-capabilities", revision, completedAt: new Date(end).toISOString(),
			ccxtVersion: "4.5.77",
			paths: [{
				exchange: "binance", marketFamily: "spot", positionMode: "one-way", orderType: "market",
				quoteCurrency: "USDT", environment: "testnet", submit: "passed", query: "passed",
				cancel: "passed", recovery: "passed", evidenceLevel: "externally-verified",
				observation: "Isolated testnet submit/query/cancel/recovery without account identifiers",
			}],
		},
	};
	const evidence = { schemaVersion: EVIDENCE_SCHEMA_VERSION, revision, versions, pilotApproval: {
		reviewer: "maintainer", revision, scope: "human-confirmed-live-pilot", exchange: "binance", market: "spot",
		quoteCurrency: "USDT", maxNotional: 10, withdrawalsDisabled: true, confirmEveryOrder: true,
		approvedAt: new Date(end).toISOString(),
	} };
	const persist = (reviewers = [testReviewer]) => {
		for (const [key, data] of Object.entries(artifacts)) {
			const body = JSON.stringify(data);
			writeFileSync(join(root, `${key}.json`), body);
			evidence[key] = { file: `${key}.json`, sha256: createHash("sha256").update(body).digest("hex") };
		}
		evidence.pilotApproval.signature = {
			alg: "ed25519",
			keyId: testReviewer.keyId,
			value: signApproval(approvalPayload(evidence), testPrivateKeyPem),
		};
		return evaluateReleaseEvidence(evidence, root, end + 1, { reviewers });
	};
	return { root, artifacts, evidence, persist };
}

function acceptedResult() {
	return { ready: true, target: "human-confirmed-live-pilot", assuranceLevel: "signed-active-verified", blockers: [] };
}

test("accepts complete, revision-bound evidence for a human-confirmed pilot only", () => {
	const data = fixture();
	assert.deepEqual(data.persist(), acceptedResult());
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
			const evaluated = data.persist();
			assert.equal(evaluated.ready, false);
			assert.deepEqual(evaluated.blockers, [`installation: ${key} has not passed`]);
		}
	});
}

test("never treats missing evidence or a short run as release readiness", () => {
	assert.equal(evaluateReleaseEvidence({}, tmpdir(), end).ready, false);
	const data = fixture();
	data.artifacts.soak.startedAt = new Date(end - 60_000).toISOString();
	assert.equal(data.persist().ready, false);
});

test("rejects evidence schemaVersion 1", () => {
	const data = fixture();
	data.evidence.schemaVersion = 1;
	assert.deepEqual(data.persist(), {
		ready: false,
		target: "human-confirmed-live-pilot",
		assuranceLevel: "blocked",
		blockers: ["Expected evidence schemaVersion 2"],
	});
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

test("blocks an idle seven-day soak with no Paper trading activity", () => {
	const data = fixture();
	for (const sample of data.artifacts.soak.samples) delete sample.activity;
	data.artifacts.soak.activity = { attempts: 0, successes: 0, failures: 0, lastSuccessAt: null };
	const evaluated = data.persist();
	assert.equal(evaluated.ready, false);
	assert.equal(evaluated.blockers.includes("soak: requires schemaVersion 2, directory identity, and successful Paper trading activity"), true);
});

test("blocks soak activity below the minimum successful round-trips", () => {
	const data = fixture();
	data.artifacts.soak.activity.successes = MINIMUM_SOAK_ACTIVITY_SUCCESSES - 1;
	data.artifacts.soak.activity.attempts = data.artifacts.soak.activity.successes + data.artifacts.soak.activity.failures;
	let kept = 0;
	for (const sample of data.artifacts.soak.samples) {
		if (sample.activity === "succeeded") {
			if (kept >= MINIMUM_SOAK_ACTIVITY_SUCCESSES - 1) delete sample.activity;
			else kept += 1;
		}
	}
	const evaluated = data.persist();
	assert.equal(evaluated.ready, false);
	assert.equal(evaluated.blockers.includes("soak: requires schemaVersion 2, directory identity, and successful Paper trading activity"), true);
});

test("blocks a soak that never injects a controlled fault", () => {
	const data = fixture();
	data.artifacts.soak.samples = soakSamples((samples) =>
		samples.map((sample) => {
			const next = { ...sample, unresolvedExecutions: 0, healthy: true, activity: "succeeded" };
			delete next.expectedFault;
			return next;
		}),
	);
	data.artifacts.soak.activity = {
		attempts: data.artifacts.soak.samples.length,
		successes: data.artifacts.soak.samples.length,
		failures: 0,
		lastSuccessAt: data.artifacts.soak.samples.at(-1).at,
	};
	const evaluated = data.persist();
	assert.equal(evaluated.ready, false);
	assert.equal(evaluated.blockers.includes("soak: requires a controlled fault and a later healthy recovery sample"), true);
});

test("blocks a soak whose controlled fault never recovers", () => {
	const data = fixture();
	const last = data.artifacts.soak.samples.at(-1);
	last.healthy = false;
	last.expectedFault = true;
	last.unresolvedExecutions = 1;
	last.activity = "failed";
	data.artifacts.soak.activity.failures += 1;
	data.artifacts.soak.activity.successes -= 1;
	assert.equal(data.persist().ready, false);
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
	assert.equal(evaluateReleaseEvidence(data.evidence, data.root, end + 1, { reviewers: [testReviewer] }).ready, false);
	data.persist();
	const outside = fixture();
	outside.persist();
	symlinkSync(join(outside.root, "offline.json"), join(data.root, "outside.json"));
	data.evidence.offline.file = "outside.json";
	assert.equal(evaluateReleaseEvidence(data.evidence, data.root, end + 1, { reviewers: [testReviewer] }).ready, false);
});

test("binds evidence to the actual checkout revision, package versions and clean state", () => {
	const data = fixture();
	data.persist();
	const candidate = { revision, workingTreeClean: true, versions };
	const options = { reviewers: [testReviewer] };
	assert.equal(evaluateCandidateEvidence(data.evidence, data.root, candidate, end + 1, options).ready, true);
	for (const changed of [
		{ ...candidate, revision: "b".repeat(40) },
		{ ...candidate, workingTreeClean: false },
		{ ...candidate, versions: { ...versions, agent: "0.0.1" } },
	]) {
		assert.equal(evaluateCandidateEvidence(data.evidence, data.root, changed, end + 1, options).ready, false);
	}
	assert.equal(evaluateCandidateEvidence(null, data.root, candidate, end + 1, options).ready, false);
});

test("rejects live capability artifacts that are only mock or offline-contract evidence", () => {
	const data = fixture();
	data.artifacts.liveCapabilities.paths[0].evidenceLevel = "offline-contract";
	const evaluated = data.persist();
	assert.equal(evaluated.ready, false);
	assert.equal(
		evaluated.blockers.includes("liveCapabilities: mock, offline-contract or experimental evidence cannot satisfy a live path"),
		true,
	);
});

test("rejects a pilot scope outside the externally verified live paths", () => {
	const data = fixture();
	data.evidence.pilotApproval.market = "futures";
	const evaluated = data.persist();
	assert.equal(evaluated.ready, false);
	assert.equal(
		evaluated.blockers.includes("pilotApproval: scope is not a subset of externally verified live capabilities"),
		true,
	);
});

test("rejects an unsigned approval even when every artifact is present", () => {
	const data = fixture();
	data.persist();
	delete data.evidence.pilotApproval.signature;
	const evaluated = evaluateReleaseEvidence(data.evidence, data.root, end + 1, { reviewers: [testReviewer] });
	assert.equal(evaluated.ready, false);
	assert.equal(evaluated.blockers.includes("pilotApproval: Ed25519 signature is required"), true);
});

test("rejects an unknown reviewer", () => {
	const data = fixture();
	data.evidence.pilotApproval.reviewer = "stranger";
	const evaluated = data.persist();
	assert.equal(evaluated.ready, false);
	assert.equal(evaluated.blockers.includes("pilotApproval: reviewer is not a trusted active key"), true);
});

test("rejects a revoked reviewer key", () => {
	const other = generateKeyPairSync("ed25519");
	const otherReviewer = {
		id: "other",
		keyId: "other-ed25519-1",
		publicKeyPem: other.publicKey.export({ type: "spki", format: "pem" }).toString(),
		status: "active",
	};
	const data = fixture();
	const evaluated = data.persist([revokedReviewer, otherReviewer]);
	assert.equal(evaluated.ready, false);
	assert.equal(evaluated.blockers.includes("pilotApproval: reviewer is not a trusted active key"), true);
});

test("rejects a tampered approval payload that keeps the original signature", () => {
	const data = fixture();
	data.persist();
	data.evidence.pilotApproval.maxNotional = 10_000;
	const evaluated = evaluateReleaseEvidence(data.evidence, data.root, end + 1, { reviewers: [testReviewer] });
	assert.equal(evaluated.ready, false);
	assert.equal(
		evaluated.blockers.includes("pilotApproval: signature does not match the canonical candidate and scope"),
		true,
	);
});

test("rejects a signature bound to a different candidate revision", () => {
	const data = fixture();
	data.persist();
	data.evidence.pilotApproval.revision = "c".repeat(40);
	const evaluated = evaluateReleaseEvidence(data.evidence, data.root, end + 1, { reviewers: [testReviewer] });
	assert.equal(evaluated.ready, false);
});
