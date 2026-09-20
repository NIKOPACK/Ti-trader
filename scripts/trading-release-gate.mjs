import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const MINIMUM_SOAK_MS = 7 * 24 * 60 * 60 * 1000;
export const MAXIMUM_SAMPLE_GAP_MS = 10 * 60 * 1000;
export const MINIMUM_SOAK_ACTIVITY_SUCCESSES = 1;
export const MINIMUM_SOAK_EXECUTION_OBSERVATIONS = 2;
export const MINIMUM_SOAK_ORDER_OBSERVATIONS = 2;
export const SOAK_FAULT_TYPES = ["process-crash", "storage-failure", "transport-failure"];
export const SOAK_RESTART_TYPES = ["collector-restart", "runtime-restart", "host-restart"];
export const REQUIRED_SUITES = ["repository-check", "risk", "engine", "triggers", "agent", "release-gate"];
export const REQUIRED_INSTALL_CHECKS = [
	"cleanInstall", "cliVersion", "isolatedDataDir", "paperDefault", "recoveryAfterRestart",
	"continuityAfterRestart", "evidenceTools",
];
export const REQUIRED_DRILLS = [
	"crash-before-send",
	"accepted-before-crash",
	"partial-fill",
	"oco-partial-evidence",
	"concurrent-recovery",
	"storage-failure",
	"transport-failure",
	"monitor-restart",
	"restore-from-backup",
];

const record = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.trim().length > 0;
const count = (value) => Number.isSafeInteger(value) && value >= 0;

function timestamp(value) {
	if (typeof value !== "string") return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : undefined;
}

function readArtifactBody(reference, artifactRoot) {
	if (!record(reference) || !text(reference.file) || !/^[a-f0-9]{64}$/.test(reference.sha256 ?? "")) {
		throw new Error("requires a relative artifact file and SHA-256");
	}
	if (isAbsolute(reference.file)) throw new Error("artifact paths must be relative");
	const root = realpathSync(artifactRoot);
	const path = realpathSync(resolve(root, reference.file));
	const child = relative(root, path);
	if (child === "" || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
		throw new Error("artifact must stay inside the evidence directory");
	}
	const body = readFileSync(path);
	if (createHash("sha256").update(body).digest("hex") !== reference.sha256) {
		throw new Error("artifact hash mismatch");
	}
	return body;
}

export function createArtifactReference(file, artifactRoot) {
	if (!text(file)) throw new Error("observation artifact file is required");
	const root = realpathSync(artifactRoot);
	const path = realpathSync(resolve(file));
	const child = relative(root, path);
	if (child === "" || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
		throw new Error("observation artifact must stay inside the evidence directory");
	}
	const body = readFileSync(path);
	return {
		file: child.split(sep).join("/"),
		sha256: createHash("sha256").update(body).digest("hex"),
	};
}

function readArtifact(reference, artifactRoot) {
	const body = readArtifactBody(reference, artifactRoot);
	const result = JSON.parse(body.toString("utf8"));
	if (!record(result)) throw new Error("artifact must contain a JSON object");
	return result;
}

function verifiedObservation(reference, artifactRoot) {
	try {
		readArtifactBody(reference, artifactRoot);
		return true;
	} catch {
		return false;
	}
}

/** Evidence validation is a release gate, not a substitute for maintainer review. */
export function evaluateReleaseEvidence(evidence, artifactRoot, now = Date.now()) {
	const blockers = [];
	if (!Number.isFinite(now)) throw new Error("Invalid evaluation clock");
	if (!record(evidence) || evidence.schemaVersion !== 3) {
		return { ready: false, target: "human-confirmed-live-pilot", blockers: ["Expected evidence schemaVersion 3"] };
	}
	const revision = evidence.revision;
	if (typeof revision !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision)) {
		blockers.push("A full candidate Git revision is required");
	}
	const artifact = (key, kind) => {
		try {
			const result = readArtifact(evidence[key], artifactRoot);
			if (result.kind !== kind || result.revision !== revision) {
				throw new Error("artifact kind or candidate revision does not match");
			}
			return result;
		} catch {
			// Do not echo arbitrary artifact contents or credential-bearing parser errors.
			blockers.push(`${key}: missing, unreadable, invalid, mismatched or hash-unverified artifact`);
			return undefined;
		}
	};
	const completed = (value, label) => {
		const time = timestamp(value);
		if (time === undefined || time > now) blockers.push(`${label}: requires a valid non-future UTC timestamp`);
		return time;
	};

	const offline = artifact("offline", "offline-readiness");
	if (offline) {
		const end = completed(offline.completedAt, "offline");
		const start = timestamp(offline.startedAt);
		if (start === undefined || end === undefined || start > end) {
			blockers.push("offline: requires a valid UTC start at or before completion");
		}
		if (offline.passed !== true || offline.workingTreeClean !== true || !Array.isArray(offline.suites) ||
			offline.suites.length === 0 || offline.suites.some((suite) => !record(suite) || suite.exitCode !== 0)) {
			blockers.push("offline: all isolated suites must pass on a clean candidate");
		}
		for (const name of REQUIRED_SUITES) {
			const matches = Array.isArray(offline.suites) ? offline.suites.filter((suite) => record(suite) && suite.name === name) : [];
			if (matches.length !== 1) blockers.push(`offline: expected one ${name} suite`);
		}
	}

	const soak = artifact("soak", "paper-soak");
	if (soak) {
		const start = timestamp(soak.startedAt);
		const end = completed(soak.completedAt, "soak");
		if (
			soak.schemaVersion !== 3 ||
			!/^(?:sha256:)[a-f0-9]{64}$/.test(soak.dataDirIdentity ?? "") ||
			soak.mode !== "paper" ||
			start === undefined ||
			end === undefined ||
			end - start < MINIMUM_SOAK_MS
		) {
			blockers.push("soak: requires at least seven observed days in Paper mode");
		}
		const restartEvents = soak.restartEvents;
		const restartEvidenceValid =
			count(soak.restartCount) &&
			soak.restartCount >= 1 &&
			Array.isArray(restartEvents) &&
			restartEvents.length === soak.restartCount &&
			restartEvents.every((event) => {
				const at = record(event) ? timestamp(event.at) : undefined;
				return at !== undefined && start !== undefined && end !== undefined && at >= start && at <= end &&
					SOAK_RESTART_TYPES.includes(event.type) && verifiedObservation(event.observation, artifactRoot);
			});
		if (!restartEvidenceValid) {
			blockers.push("soak: requires a structured controlled restart observation");
		}
		const activity = soak.activity;
		const baseline = record(activity) ? activity.baseline : undefined;
		const baselineAt = record(baseline) ? timestamp(baseline.at) : undefined;
		let activityValid =
			record(activity) &&
			record(baseline) &&
			baselineAt !== undefined &&
			start !== undefined &&
			end !== undefined &&
			baselineAt >= start &&
			baselineAt <= end &&
			count(baseline.observedExecutions) &&
			count(baseline.observedOrders) &&
			count(activity.attempts) &&
			count(activity.successes) &&
			count(activity.failures) &&
			activity.attempts === activity.successes + activity.failures &&
			activity.successes >= MINIMUM_SOAK_ACTIVITY_SUCCESSES;
		const samples = soak.samples;
		let previous = start;
		let samplesValid = Array.isArray(samples) && samples.length > 1;
		let successfulActivities = 0;
		let failedActivities = 0;
		let lastSuccessAt;
		let lastFaultIndex = -1;
		let maximumSuccessfulActivityExecutions = 0;
		let maximumSuccessfulActivityOrders = 0;
		if (samplesValid) {
			for (const [index, sample] of samples.entries()) {
				const time = record(sample) ? timestamp(sample.at) : undefined;
				const fault = record(sample) ? sample.fault : undefined;
				const faultAt = record(fault) ? timestamp(fault.at) : undefined;
				const validFault =
					record(sample) &&
					sample.expectedFault === true &&
					record(fault) &&
					faultAt === time &&
					SOAK_FAULT_TYPES.includes(fault.type) &&
					verifiedObservation(fault.observation, artifactRoot);
				if (time === undefined || previous === undefined || time < previous || time > end ||
					time - previous > MAXIMUM_SAMPLE_GAP_MS || sample.duplicateSubmissions !== 0 ||
					sample.lostUnresolvedRecords !== 0 || !count(sample.unresolvedExecutions) ||
					!count(sample.observedExecutions) || !count(sample.observedOrders) ||
					(sample.activity !== undefined && sample.activity !== "succeeded" && sample.activity !== "failed") ||
					(sample.expectedFault !== undefined && sample.expectedFault !== true) ||
					((sample.expectedFault === true || sample.fault !== undefined) && !validFault) ||
					(validFault && sample.healthy !== false) ||
					(sample.activity === "failed" && sample.healthy !== false) ||
					(sample.healthy !== true && !validFault && sample.activity !== "failed")) {
					samplesValid = false;
					break;
				}
				if (sample.activity === "succeeded") {
					successfulActivities += 1;
					lastSuccessAt = sample.at;
					maximumSuccessfulActivityExecutions = Math.max(
						maximumSuccessfulActivityExecutions,
						sample.observedExecutions,
					);
					maximumSuccessfulActivityOrders = Math.max(maximumSuccessfulActivityOrders, sample.observedOrders);
				}
				if (sample.activity === "failed") failedActivities += 1;
				if (validFault) lastFaultIndex = index;
				previous = time;
			}
			const first = samples[0];
			const last = samples.at(-1);
			if (!record(first) || baselineAt === undefined || timestamp(first.at) < baselineAt ||
				previous === undefined || end === undefined || end - previous > MAXIMUM_SAMPLE_GAP_MS ||
				!record(last) || last.unresolvedExecutions !== 0 || last.healthy !== true) samplesValid = false;
		}
		activityValid =
			activityValid &&
			successfulActivities === activity.successes &&
			failedActivities === activity.failures &&
			lastSuccessAt === activity.lastSuccessAt;
		const recoveredAfterFault =
			lastFaultIndex >= 0 &&
			samples.slice(lastFaultIndex + 1).some((sample) =>
				record(sample) && sample.healthy === true && sample.unresolvedExecutions === 0 && sample.expectedFault !== true,
			);
		if (!samplesValid) {
			blockers.push("soak: requires continuous <=10-minute samples, no duplicate/lost executions, and a healthy resolved finish");
		}
		if (
			!activityValid ||
			maximumSuccessfulActivityExecutions - (baseline?.observedExecutions ?? Number.POSITIVE_INFINITY) <
				MINIMUM_SOAK_EXECUTION_OBSERVATIONS ||
			maximumSuccessfulActivityOrders - (baseline?.observedOrders ?? Number.POSITIVE_INFINITY) <
				MINIMUM_SOAK_ORDER_OBSERVATIONS
		) {
			blockers.push("soak: requires successful Paper round-trip activity observed after the run baseline");
		}
		if (!recoveredAfterFault) {
			blockers.push("soak: requires a controlled fault followed by a healthy resolved recovery sample");
		}
	}

	const drills = artifact("drills", "recovery-drills");
	if (drills) {
		completed(drills.completedAt, "drills");
		for (const name of REQUIRED_DRILLS) {
			const matches = Array.isArray(drills.cases) ? drills.cases.filter((entry) => record(entry) && entry.name === name) : [];
			if (matches.length !== 1 || matches[0].passed !== true || !text(matches[0].observation)) {
				blockers.push(`drills: missing successful evidence for ${name}`);
			}
		}
	}

	const installation = artifact("installation", "package-install");
	if (installation) {
		completed(installation.completedAt, "installation");
		if (installation.passed !== true || !Number.isInteger(installation.nodeMajor) || installation.nodeMajor < 22) {
			blockers.push("installation: clean package installation on supported Node is required");
		}
		for (const key of ["risk", "engine", "agent"]) {
			if (!record(evidence.versions) || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(evidence.versions[key] ?? "") ||
				!record(installation.versions) || installation.versions[key] !== evidence.versions[key]) {
				blockers.push(`installation: candidate ${key} version is missing or mismatched`);
			}
		}
		for (const key of REQUIRED_INSTALL_CHECKS) {
			if (!record(installation.checks) || installation.checks[key] !== true) {
				blockers.push(`installation: ${key} has not passed`);
			}
		}
	}

	const approval = evidence.pilotApproval;
	if (!record(approval) || !text(approval.reviewer) || approval.revision !== revision ||
		approval.scope !== "human-confirmed-live-pilot" || !text(approval.exchange) || !text(approval.market) ||
		!text(approval.quoteCurrency) || !Number.isFinite(approval.maxNotional) || approval.maxNotional <= 0 ||
		approval.withdrawalsDisabled !== true || approval.confirmEveryOrder !== true) {
		blockers.push("pilotApproval: explicit reviewer, candidate, exchange/market, positive cap and safety permissions are required");
	} else {
		completed(approval.approvedAt, "pilotApproval");
	}
	return { ready: blockers.length === 0, target: "human-confirmed-live-pilot", blockers };
}

export function evaluateCandidateEvidence(evidence, artifactRoot, candidate, now = Date.now()) {
	const result = evaluateReleaseEvidence(evidence, artifactRoot, now);
	if (!record(evidence) || evidence.revision !== candidate.revision) {
		result.blockers.push("Candidate does not match the current checkout");
	}
	if (!candidate.workingTreeClean) result.blockers.push("Release checkout is not clean");
	for (const key of ["risk", "engine", "agent"]) {
		if (!record(evidence?.versions) || evidence.versions[key] !== candidate.versions[key]) {
			result.blockers.push(`Candidate ${key} version does not match the current checkout`);
		}
	}
	result.ready = result.blockers.length === 0;
	return result;
}

function main(args) {
	if (args.length !== 1) throw new Error("Usage: node scripts/trading-release-gate.mjs /path/to/evidence.json");
	const path = resolve(args[0]);
	const evidence = JSON.parse(readFileSync(path, "utf8"));
	const repo = fileURLToPath(new URL("../", import.meta.url));
	const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
	const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim();
	const versions = Object.fromEntries(["risk", "engine", "agent"].map((key) => [
		key, JSON.parse(readFileSync(resolve(repo, "packages", `trading-${key}`, "package.json"), "utf8")).version,
	]));
	const result = evaluateCandidateEvidence(evidence, dirname(path), { revision, workingTreeClean: dirty === "", versions });
	console.log(JSON.stringify(result, null, 2));
	if (!result.ready) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		main(process.argv.slice(2));
	} catch {
		console.error("Cannot evaluate release evidence; provide a readable manifest and run from the candidate repository.");
		process.exitCode = 1;
	}
}
