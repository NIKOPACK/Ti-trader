import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
	assertOutsideRepository,
	evaluateInstallChecks,
	inspectInstalledVersions,
	isolatedInstallEnvironment,
	parseCliVersion,
	tarballFileName,
	writeInstallProbe,
} from "./trading-package-install.mjs";

const roots = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temp() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "ti-package-install-")));
	roots.push(root);
	return root;
}

test("does not inherit credentials, provider endpoints or Node startup injection", () => {
	const env = isolatedInstallEnvironment("/tmp/owned-install", {
		PATH: "/usr/bin", HOME: "/real/home", TI_DATA_DIR: "/real/trading", OPENAI_API_KEY: "test-secret",
		NPM_TOKEN: "test-secret", NODE_OPTIONS: "--require unwanted.js", HTTP_PROXY: "https://example.invalid", CI: "true",
	});
	assert.equal(env.PATH, "/usr/bin");
	assert.equal(env.CI, "true");
	assert.equal(env.HOME, "/tmp/owned-install/home");
	assert.equal(env.TI_DATA_DIR, "/tmp/owned-install/ti");
	for (const key of ["OPENAI_API_KEY", "NPM_TOKEN", "NODE_OPTIONS", "HTTP_PROXY"]) {
		assert.equal(env[key], undefined);
	}
});

test("names packed tarballs without a registry publish step", () => {
	assert.equal(tarballFileName("@nikopack/ti-trading-risk", "0.2.0"), "nikopack-ti-trading-risk-0.2.0.tgz");
	assert.equal(tarballFileName("ti-trader", "0.1.10"), "ti-trader-0.1.10.tgz");
});

test("parses the CLI version line and rejects other output", () => {
	assert.equal(parseCliVersion("ti 0.1.9\n"), "0.1.9");
	assert.throws(() => parseCliVersion("0.1.9\n"), /ti <version>/);
});

test("refuses an install workdir inside the candidate repository", () => {
	const repo = temp();
	mkdirSync(join(repo, "packages"), { recursive: true });
	assert.throws(() => assertOutsideRepository(join(repo, "packages"), repo), /outside the candidate repository/);
	assert.doesNotThrow(() => assertOutsideRepository(temp(), repo));
});

test("rejects a workspace-linked install and accepts exact packed versions", () => {
	const root = temp();
	const repoPackage = join(root, "repo", "packages", "trading-agent");
	const installDir = join(root, "install");
	mkdirSync(join(repoPackage, "dist"), { recursive: true });
	mkdirSync(join(installDir, "node_modules", "@nikopack", "ti-trading-risk"), { recursive: true });
	mkdirSync(join(installDir, "node_modules", "@nikopack", "ti-trading-engine"), { recursive: true });
	mkdirSync(join(installDir, "node_modules"), { recursive: true });
	writeFileSync(join(repoPackage, "package.json"), JSON.stringify({ name: "ti-trader", version: "0.1.10" }));
	writeFileSync(join(installDir, "node_modules", "@nikopack", "ti-trading-risk", "package.json"),
		JSON.stringify({ name: "@nikopack/ti-trading-risk", version: "0.2.0" }));
	writeFileSync(join(installDir, "node_modules", "@nikopack", "ti-trading-engine", "package.json"),
		JSON.stringify({ name: "@nikopack/ti-trading-engine", version: "0.3.0",
			dependencies: { "@nikopack/ti-trading-risk": "0.2.0" } }));
	symlinkSync(repoPackage, join(installDir, "node_modules", "ti-trader"));
	assert.equal(inspectInstalledVersions(installDir).versions.agent, "0.1.10");
	assert.equal(realpathSync(inspectInstalledVersions(installDir).paths.agent), realpathSync(repoPackage));
});

test("requires every install check, including restart recovery of the probe reservation", () => {
	const versions = { risk: "0.2.0", engine: "0.3.0", agent: "0.1.10" };
	const reservationId = "res-1";
	assert.deepEqual(evaluateInstallChecks({
		versions, cleanInstall: true, cliVersion: "0.1.10", isolatedDataDir: true, homeLeak: false,
		mode: "paper", restartMode: "paper", reservationId, restartReservationId: reservationId, restartReason: "package-install-probe",
		continuityAfterRestart: true, evidenceTools: true,
	}), {
		passed: true,
		checks: { cleanInstall: true, cliVersion: true, isolatedDataDir: true, paperDefault: true,
			recoveryAfterRestart: true, continuityAfterRestart: true, evidenceTools: true },
	});
	assert.equal(evaluateInstallChecks({
		versions, cleanInstall: true, cliVersion: "0.1.10", isolatedDataDir: true, homeLeak: false,
		mode: "paper", restartMode: "paper", reservationId, restartReservationId: "other", restartReason: "package-install-probe",
		continuityAfterRestart: true, evidenceTools: true,
	}).passed, false);
	assert.equal(evaluateInstallChecks({
		versions, cleanInstall: true, cliVersion: "0.1.9", isolatedDataDir: true, homeLeak: false,
		mode: "paper", restartMode: "paper", reservationId, restartReservationId: reservationId, restartReason: "package-install-probe",
		continuityAfterRestart: true, evidenceTools: true,
	}).passed, false);
});

for (const key of ["continuityAfterRestart", "evidenceTools"]) {
	test(`requires explicit ${key} evidence, not legacy or truthy observations`, () => {
		for (const value of [undefined, false, "true", 1]) {
			const observation = {
				versions: { agent: "0.1.10" }, cleanInstall: true, cliVersion: "0.1.10",
				isolatedDataDir: true, homeLeak: false, mode: "paper", restartMode: "paper",
				reservationId: "res-1", restartReservationId: "res-1", restartReason: "package-install-probe",
				continuityAfterRestart: true, evidenceTools: true,
			};
			if (value === undefined) delete observation[key];
			else observation[key] = value;
			const result = evaluateInstallChecks(observation);
			assert.equal(result.passed, false);
			assert.equal(result.checks[key], false);
			assert.equal(Object.values(result.checks).filter((check) => check === false).length, 1);
		}
	});
}

// This deliberately small fake package tests the generated probe's assertions, not install acceptance.
const fixturePackage = `
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const fault = process.env.INSTALL_PROBE_FAULT;
const scope = { accountId: "fixture", mode: "paper", exchange: "binance",
	marketType: "spot", quoteCurrency: "USDT", positionMode: "one-way" };
export class PlanStore {
	constructor(agentDir) {
		mkdirSync(agentDir, { recursive: true });
		this.path = join(agentDir, "fixture-plans.json");
	}
	all() { return existsSync(this.path) ? JSON.parse(readFileSync(this.path, "utf8")) : []; }
	save(plans) { writeFileSync(this.path, JSON.stringify(plans)); }
	list(currentScope) {
		return this.all().filter((plan) => JSON.stringify(plan.scope) === JSON.stringify(currentScope));
	}
	read(id, currentScope) {
		const plan = this.list(currentScope).find((plan) => plan.id === id);
		if (!plan) throw new Error("fixture plan missing");
		return plan;
	}
	create(currentScope, content) {
		const plans = this.all();
		const plan = { id: "fixture-plan-" + plans.length, scope: currentScope, revision: 1,
			status: "draft", activeVersion: null, notes: [], intents: [], executions: [],
			versions: [{ version: 1, at: "2026-01-01T00:00:00.000Z", epoch: 0, content }] };
		plans.push(plan);
		this.save(plans);
		return plan;
	}
	update(id, currentScope, revision, mutate) {
		const plans = this.all();
		const plan = plans.find((plan) => plan.id === id);
		if (plan.revision !== revision || JSON.stringify(plan.scope) !== JSON.stringify(currentScope))
			throw new Error("fixture revision or scope mismatch");
		mutate(plan);
		this.save(plans);
		return plan;
	}
	activate(id, currentScope, revision) {
		return this.update(id, currentScope, revision, (plan) => {
			plan.activeVersion = plan.versions.length;
			plan.status = "tracking";
			plan.revision++;
		});
	}
	revise(id, currentScope, revision, content) {
		return this.update(id, currentScope, revision, (plan) => {
			plan.versions.push({ version: plan.versions.length + 1,
				at: "2026-01-01T00:00:01.000Z", epoch: 0, content });
			if (fault === "auto-activate") plan.activeVersion = plan.versions.length;
			if (fault === "rewrite-rationale") plan.versions[0].content = content;
			plan.revision++;
		});
	}
	note(id, currentScope, text) {
		const plan = this.read(id, currentScope);
		this.update(id, currentScope, plan.revision, (saved) => {
			if (fault !== "drop-note") saved.notes.push({ at: "2026-01-01T00:00:02.000Z", author: "model", text });
		});
	}
}
export function planIndex(store, currentScope) {
	if (fault === "oversized-index") return "x".repeat(4097);
	const plans = store.list(currentScope);
	const plan = plans[0];
	return (fault === "authoritative-index" ? "Saved plans authorize trading."
		: "Saved plans are non-authoritative research. Recheck current account facts. Use read_plan for details.") +
		"\\n" + plan.id + " v" + plan.activeVersion + " tracking draft=v" + plan.versions.length +
		(fault === "leaked-note" ? "\\n" + plan.notes[0].text : "") +
		"\\nMore plans omitted; call list_plans.";
}
export function reviewPlan(plan) {
	return { versions: plan.versions, notes: plan.notes, result: {
		status: fault === "false-profit" ? "complete_paper_or_recorded_cash_flow" : "insufficient_evidence",
		netQuoteCashFlow: fault === "false-profit" ? 0 : null,
		gaps: ["No attributed fills; no trading-result evidence"],
	} };
}
function forbidden() { throw new Error("fixture forbids trading, monitoring, model work or command execution"); }
function tool(api, name) { api.registerTool({ name, parameters: {}, execute: forbidden }); }
export function createPlanExtension(provider, store) {
	return (api) => {
		provider();
		for (const name of ["append_plan_note", "create_plan", "get_plan_review", "list_plans", "read_plan", "revise_plan"])
			if (fault !== "missing-plan-tool" || name !== "read_plan") tool(api, name);
		api.registerCommand("plan", { handler: forbidden });
		api.registerEntryRenderer("trading:plan", forbidden);
		api.on("before_agent_start", () => ({ message: {
			customType: "trade-plan-context", display: false,
			content: fault === "wrong-startup" ? "wrong context" : planIndex(store, provider().tradingEngine.getExecutionScope()),
		} }));
		api.on("session_start", forbidden);
		api.on("session_shutdown", forbidden);
	};
}
export function createDecisionEvidenceExtension(provider) {
	return (api) => {
		provider();
		for (const name of ["get_decision_evaluation", "record_decision"])
			if (fault !== "missing-decision-tool" || name !== "record_decision") tool(api, name);
		if (fault !== "missing-decision-command") api.registerCommand("decisions", { handler: forbidden });
		for (const name of ["before_agent_start", "tool_call", "tool_result", "agent_end", "session_shutdown"])
			if (fault !== "missing-decision-hook" || name !== "tool_result") api.on(name, forbidden);
	};
}
export async function initTrading() {
	const dir = join(process.env.TI_DATA_DIR, "agent");
	mkdirSync(join(dir, "paper"), { recursive: true });
	const pausePath = join(dir, "trading-state.json");
	writeFileSync(join(dir, "paper", "binance-USDT.json"), "{}");
	return {
		mode: "paper", config: { exchange: "binance", quoteCurrency: "USDT", language: "en" },
		tradingEngine: {
			getExecutionScope: () => scope,
			risk: {
				reserve(_symbol, _notional) {
					const reservation = { id: "fixture-pause" };
					writeFileSync(pausePath, JSON.stringify(reservation));
					return reservation;
				},
				listPendingReservations() {
					return [JSON.parse(readFileSync(pausePath, "utf8"))];
				},
			},
		},
		async close() { writeFileSync(join(dir, "fixture-closed-" + process.argv[2]), "closed"); },
	};
}
`;

function probeFixture() {
	const root = temp();
	const packageDir = join(root, "node_modules", "ti-trader");
	mkdirSync(packageDir, { recursive: true });
	writeFileSync(join(packageDir, "package.json"), JSON.stringify({
		name: "ti-trader", private: true, type: "module", exports: "./index.mjs",
	}));
	writeFileSync(join(packageDir, "index.mjs"), fixturePackage);
	writeInstallProbe(join(root, "probe.mjs"));
	const env = isolatedInstallEnvironment(root);
	mkdirSync(env.HOME, { recursive: true });
	const invoke = (action, continuity, fault) => spawnSync(process.execPath, [join(root, "probe.mjs"), action], {
		cwd: root, encoding: "utf8", timeout: 10_000,
		env: { ...env, ...(fault ? { INSTALL_PROBE_FAULT: fault } : {}) },
		input: continuity === undefined ? undefined : JSON.stringify(continuity),
	});
	return { root, env, invoke, statePath: join(env.TI_DATA_DIR, "agent", "fixture-plans.json") };
}

test("generated probe statically imports only Node and installed ti-trader APIs and parses", () => {
	const root = temp();
	const path = join(root, "probe.mjs");
	writeInstallProbe(path);
	const source = readFileSync(path, "utf8");
	const checked = spawnSync(process.execPath, ["--check", path], { encoding: "utf8", timeout: 10_000 });
	assert.equal(checked.status, 0, checked.stderr);
	assert.doesNotMatch(source, /import\s*\(/);
	assert.deepEqual([...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1]),
		["node:assert/strict", "node:fs", "node:os", "node:path", "ti-trader"]);
});

test("probe fixture saves and reopens research across two exited processes without executing tools", () => {
	const fixture = probeFixture();
	const first = fixture.invoke("pause");
	assert.equal(first.status, 0, first.stderr);
	const written = JSON.parse(first.stdout);
	assert.equal(written.continuityAfterRestart, false);
	assert.equal(written.evidenceTools, true);
	assert.equal(written.continuity.planIds.length, 32);
	assert.equal(readFileSync(join(fixture.env.TI_DATA_DIR, "agent", "fixture-closed-pause"), "utf8"), "closed");
	const before = readFileSync(fixture.statePath, "utf8");
	const second = fixture.invoke("verify", written.continuity);
	assert.equal(second.status, 0, second.stderr);
	const reopened = JSON.parse(second.stdout);
	assert.equal(reopened.continuityAfterRestart, true);
	assert.equal(reopened.evidenceTools, true);
	assert.equal(reopened.reservationId, written.reservationId);
	assert.equal(reopened.reason, "package-install-probe");
	assert.deepEqual(reopened.continuity, written.continuity);
	assert.equal(readFileSync(fixture.statePath, "utf8"), before);
	assert.equal(readFileSync(join(fixture.env.TI_DATA_DIR, "agent", "fixture-closed-verify"), "utf8"), "closed");
});

for (const [fault, diagnostic] of [
	["auto-activate", /revision silently activated/],
	["rewrite-rationale", /revision rewrote the original rationale/],
	["drop-note", /AssertionError/],
	["false-profit", /no fills cannot establish a trading result/],
	["oversized-index", /startup index exceeds 4 KiB/],
	["authoritative-index", /non-authoritative research/],
	["leaked-note", /index leaked research notes/],
	["wrong-startup", /AssertionError/],
	["missing-plan-tool", /read_plan/],
	["missing-decision-tool", /record_decision/],
	["missing-decision-command", /decisions/],
	["missing-decision-hook", /missing decision evidence hook: tool_result/],
]) {
	test(`probe fixture rejects ${fault} rather than printing successful evidence`, () => {
		const fixture = probeFixture();
		const result = fixture.invoke("pause", undefined, fault);
		assert.equal(result.status, 1, result.stderr);
		assert.equal(result.stdout, "");
		assert.match(result.stderr, diagnostic);
		assert.equal(readFileSync(join(fixture.env.TI_DATA_DIR, "agent", "fixture-closed-pause"), "utf8"), "closed");
	});
}

for (const scenario of ["rationale", "tracked-version", "note", "scope", "lost-plan"]) {
	test(`probe fixture rejects ${scenario} loss or corruption after restart`, () => {
		const fixture = probeFixture();
		const first = fixture.invoke("pause");
		assert.equal(first.status, 0, first.stderr);
		const continuity = JSON.parse(first.stdout).continuity;
		const plans = JSON.parse(readFileSync(fixture.statePath, "utf8"));
		if (scenario === "rationale") plans[0].versions[0].content.thesis = "Rewritten original";
		if (scenario === "tracked-version") plans[0].activeVersion = 2;
		if (scenario === "note") plans[0].notes = [];
		if (scenario === "scope") plans[0].scope.accountId = "other-account";
		if (scenario === "lost-plan") plans.pop();
		writeFileSync(fixture.statePath, JSON.stringify(plans));
		const second = fixture.invoke("verify", continuity);
		assert.equal(second.status, 1, second.stderr);
		assert.equal(second.stdout, "");
		assert.match(second.stderr, /AssertionError|fixture plan missing/);
		assert.equal(readFileSync(join(fixture.env.TI_DATA_DIR, "agent", "fixture-closed-verify"), "utf8"), "closed");
	});
}

test("probe fixture rejects restart without the first process's evidence", () => {
	const fixture = probeFixture();
	const result = fixture.invoke("verify");
	assert.equal(result.status, 1, result.stderr);
	assert.equal(result.stdout, "");
	assert.match(result.stderr, /SyntaxError/);
});
