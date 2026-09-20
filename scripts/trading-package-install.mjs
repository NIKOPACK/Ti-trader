import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedReadinessEnvironment } from "./trading-readiness.mjs";

export const INSTALL_PACKAGES = [
	{ key: "risk", dir: "packages/trading-risk", name: "@nikopack/ti-trading-risk" },
	{ key: "engine", dir: "packages/trading-engine", name: "@nikopack/ti-trading-engine" },
	{ key: "agent", dir: "packages/trading-agent", name: "ti-trader" },
];
export const SUPPORTING_PACKAGES = [{ dir: "packages/triggers", name: "@nikopack/ti-triggers" }];

const record = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.trim().length > 0;

export function isolatedInstallEnvironment(root, source = process.env) {
	return isolatedReadinessEnvironment(root, source);
}

export function candidateVersions(repo) {
	return Object.fromEntries(
		INSTALL_PACKAGES.map((pkg) => [pkg.key, JSON.parse(readFileSync(join(repo, pkg.dir, "package.json"), "utf8")).version]),
	);
}

export function tarballFileName(name, version) {
	return `${name.startsWith("@") ? name.slice(1).replace("/", "-") : name}-${version}.tgz`;
}

export function isInsideDirectory(child, parent) {
	const relativePath = relative(realpathSync(parent), realpathSync(child));
	return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath));
}

export function assertOutsideRepository(target, repo) {
	if (isInsideDirectory(target, repo)) {
		throw new Error("install workdir must be outside the candidate repository");
	}
}

export function parseCliVersion(output) {
	const match = /^ti (\S+)\s*$/m.exec(output);
	if (!match) throw new Error("CLI version output is not `ti <version>`");
	return match[1];
}

export function resolveInstalledPackage(installDir, name) {
	const candidates = [
		join(installDir, "node_modules", ...name.split("/")),
		join(installDir, "node_modules", "ti-trader", "node_modules", ...name.split("/")),
		join(installDir, "node_modules", "@nikopack", "ti-trading-engine", "node_modules", ...name.split("/")),
	];
	for (const path of candidates) {
		if (existsSync(join(path, "package.json"))) return path;
	}
	throw new Error(`installed package not found: ${name}`);
}

export function inspectInstalledVersions(installDir) {
	const paths = Object.fromEntries(
		INSTALL_PACKAGES.map((pkg) => [pkg.key, resolveInstalledPackage(installDir, pkg.name)]),
	);
	const manifests = Object.fromEntries(
		Object.entries(paths).map(([key, path]) => [key, JSON.parse(readFileSync(join(path, "package.json"), "utf8"))]),
	);
	return {
		paths,
		versions: Object.fromEntries(Object.entries(manifests).map(([key, pkg]) => [key, pkg.version])),
		engineRiskDependency: manifests.engine.dependencies?.["@nikopack/ti-trading-risk"],
		agentEngineDependency: manifests.agent.dependencies?.["@nikopack/ti-trading-engine"],
	};
}

export function evaluateInstallChecks(observation) {
	const checks = {
		cleanInstall: observation.cleanInstall === true,
		cliVersion: observation.cliVersion === observation.versions.agent,
		isolatedDataDir: observation.isolatedDataDir === true && observation.homeLeak !== true,
		paperDefault: observation.mode === "paper" && observation.restartMode === "paper",
		recoveryAfterRestart:
			text(observation.reservationId) && observation.reservationId === observation.restartReservationId && observation.restartReason === "package-install-probe",
		continuityAfterRestart: observation.continuityAfterRestart === true,
		evidenceTools: observation.evidenceTools === true,
	};
	return { passed: Object.values(checks).every((value) => value === true), checks };
}

function readPackage(dir) {
	return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
}

function assertBuiltPackage(dir) {
	const pkg = readPackage(dir);
	const main = pkg.main ?? "./dist/index.js";
	if (!existsSync(join(dir, main))) {
		throw new Error(`${pkg.name} is not built (${main} missing); build before packing`);
	}
}

function run(command, args, options) {
	const result = spawnSync(command, args, { encoding: "utf8", ...options });
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim() || result.status}`);
	}
	return result;
}

export function writeInstallProbe(path) {
	writeFileSync(
		path,
		`import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	createDecisionEvidenceExtension, createPlanExtension, initTrading, PlanStore, planIndex, reviewPlan,
} from "ti-trader";

function registration() {
	const tools = new Map();
	const commands = new Map();
	const events = new Map();
	const renderers = new Map();
	return {
		tools, commands, events, renderers,
		api: {
			registerTool(tool) {
				assert.equal(tools.has(tool.name), false, "duplicate tool");
				assert.equal(typeof tool.execute, "function");
				assert.equal(typeof tool.parameters, "object");
				tools.set(tool.name, tool);
			},
			registerCommand(name, command) {
				assert.equal(commands.has(name), false, "duplicate command");
				assert.equal(typeof command.handler, "function");
				commands.set(name, command);
			},
			registerEntryRenderer(name, renderer) {
				assert.equal(renderers.has(name), false, "duplicate renderer");
				assert.equal(typeof renderer, "function");
				renderers.set(name, renderer);
			},
			on(name, handler) {
				assert.equal(typeof handler, "function");
				const handlers = events.get(name) ?? [];
				handlers.push(handler);
				events.set(name, handlers);
			},
		},
	};
}

const action = process.argv[2];
if (action !== "pause" && action !== "verify") throw new Error("probe action must be pause or verify");
const dataDir = process.env.TI_DATA_DIR;
const trading = await initTrading();
try {
	assert.equal(trading.mode, "paper", "install probe must remain in Paper mode");
	const scope = trading.tradingEngine.getExecutionScope();
	assert.equal(scope.mode, "paper");
	const store = new PlanStore(join(dataDir, "agent"));
	const plans = registration();
	const decisions = registration();
	await createPlanExtension(() => trading, store)(plans.api);
	await createDecisionEvidenceExtension(() => trading)(decisions.api);
	assert.deepEqual([...plans.tools.keys()].sort(), [
		"append_plan_note", "create_plan", "get_plan_review", "list_plans", "read_plan", "revise_plan",
	]);
	assert.deepEqual([...decisions.tools.keys()].sort(), ["get_decision_evaluation", "record_decision"]);
	assert.deepEqual([...plans.commands.keys()], ["plan"]);
	assert.deepEqual([...decisions.commands.keys()], ["decisions"]);
	assert.deepEqual([...plans.renderers.keys()], ["trading:plan"]);
	for (const name of ["before_agent_start", "session_start", "session_shutdown"])
		assert.equal(plans.events.get(name)?.length, 1, "missing plan lifecycle hook: " + name);
	for (const name of ["before_agent_start", "tool_call", "tool_result", "agent_end", "session_shutdown"])
		assert.equal(decisions.events.get(name)?.length, 1, "missing decision evidence hook: " + name);

	let continuity;
	if (action === "pause") {
		assert.equal(store.list(scope).length, 0, "probe requires fresh isolated plan storage");
		const now = Date.now();
		const content = {
			symbol: "BTC/" + scope.quoteCurrency,
			timeframe: "1h",
			direction: "observe",
			thesis: "Original install-probe rationale; research only, never order authorization.",
			entry: [{ fact: "price", operator: "gt", value: 100 }],
			invalidation: [{ fact: "price", operator: "lt", value: 80 }],
			expiresAt: new Date(now + 86400000).toISOString(),
			reviewAt: new Date(now + 3600000).toISOString(),
			risk: "Offline continuity probe; no orders or market observations.",
			evidence: [{ source: "package-install-probe", observedAt: new Date(now).toISOString(),
				summary: "Synthetic research, not observed market evidence." }],
		};
		const created = store.create(scope, content);
		assert.equal(created.status, "draft");
		assert.equal(created.activeVersion, null);
		assert.equal(created.versions.length, 1);
		assert.deepEqual(created.versions[0].content, content);
		const originalVersion = structuredClone(created.versions[0]);
		const activated = store.activate(created.id, scope, created.revision);
		assert.equal(activated.status, "tracking");
		assert.equal(activated.activeVersion, 1);
		const revisedContent = { ...content, thesis: "Revised install-probe rationale; unapproved v2 research." };
		const revised = store.revise(created.id, scope, activated.revision, revisedContent);
		assert.deepEqual(revised.versions[0], originalVersion, "revision rewrote the original rationale");
		assert.equal(revised.versions.length, 2);
		assert.deepEqual(revised.versions[1].content, revisedContent);
		assert.equal(revised.activeVersion, 1, "revision silently activated the new draft");
		assert.equal(revised.status, "tracking");
		const note = "Install-probe research note; not a fill, account fact or trading permission.";
		store.note(created.id, scope, note);
		const saved = store.read(created.id, scope);
		assert.equal(saved.notes.length, 1);
		assert.equal(saved.notes[0].text, note);
		assert.equal(saved.notes[0].author, "model");
		assert.deepEqual(saved.versions, revised.versions);
		assert.equal(saved.activeVersion, 1);
		assert.equal(saved.status, "tracking");
		assert.deepEqual(saved.intents, []);
		assert.deepEqual(saved.executions, []);
		// Enough real stored drafts to exercise truncation, not just a short one-plan index.
		for (let index = 1; index < 32; index++)
			store.create(scope, { ...content, thesis: "Install-probe index capacity draft " + index });
		continuity = { pid: process.pid, plan: saved, planIds: store.list(scope).map((plan) => plan.id) };
	} else {
		continuity = JSON.parse(readFileSync(0, "utf8"));
		assert.notEqual(continuity.pid, process.pid, "continuity must be checked in a second process");
		assert.deepEqual(continuity.plan.scope, scope, "execution scope changed across restart");
		const reopened = store.read(continuity.plan.id, scope);
		assert.deepEqual(reopened, continuity.plan, "saved plan evidence changed across restart");
		assert.deepEqual(store.list(scope).map((plan) => plan.id), continuity.planIds);
		assert.equal(reopened.activeVersion, 1, "restart activated the unapproved draft");
		assert.equal(reopened.versions.length, 2);
		assert.equal(reopened.status, "tracking");
	}
	const saved = store.read(continuity.plan.id, scope);
	assert.deepEqual(saved.intents, []);
	assert.deepEqual(saved.executions, []);
	const review = reviewPlan(saved);
	assert.equal(review.result.status, "insufficient_evidence", "no fills cannot establish a trading result");
	assert.equal(review.result.netQuoteCashFlow, null);
	assert.ok(review.result.gaps.some((gap) => /no attributed fills/i.test(gap)));
	assert.deepEqual(review.versions, saved.versions);
	assert.deepEqual(review.notes, saved.notes);
	const index = planIndex(store, scope);
	assert.ok(Buffer.byteLength(index, "utf8") <= 4096, "startup index exceeds 4 KiB");
	assert.match(index, /non-authoritative research/i);
	assert.match(index, /recheck current account facts/i);
	assert.match(index, /read_plan/);
	assert.match(index, /More plans omitted; call list_plans\\./);
	assert.ok(index.includes(saved.id + " v1 tracking"));
	assert.match(index, /draft=v2/);
	assert.equal(index.includes(saved.versions[0].content.thesis), false, "index leaked full research");
	assert.equal(index.includes(saved.notes[0].text), false, "index leaked research notes");
	// Only the plan's read-only context hook runs; no monitor or decision/model lifecycle starts.
	const startup = await plans.events.get("before_agent_start")[0]();
	assert.equal(startup.message.customType, "trade-plan-context");
	assert.equal(startup.message.display, false);
	assert.equal(startup.message.content, index);
	const reservation = action === "pause"
		? trading.tradingEngine.risk.reserve("BTC/USDT", 1)
		: trading.tradingEngine.risk.listPendingReservations()[0];
	console.log(JSON.stringify({
		continuity,
		continuityAfterRestart: action === "verify",
		evidenceTools: true,
		mode: trading.mode,
		exchange: trading.config.exchange,
		quoteCurrency: trading.config.quoteCurrency,
		reservationId: reservation?.id,
		reason: "package-install-probe",
		paperExists: existsSync(join(dataDir, "agent", "paper", \`\${trading.config.exchange}-\${trading.config.quoteCurrency}.json\`)),
		stateExists: existsSync(join(dataDir, "agent", "trading-state.json")),
		homeLeak: existsSync(join(homedir(), ".ti-trader")),
	}));
} finally {
	await trading.close();
}
`,
	);
}

function probeTrading(installDir, dataDir, env, action, continuity) {
	const result = run(process.execPath, [join(installDir, "probe.mjs"), action], {
		cwd: installDir,
		env: { ...env, TI_DATA_DIR: dataDir },
		input: continuity === undefined ? undefined : JSON.stringify(continuity),
		timeout: 120_000,
	});
	const parsed = JSON.parse(result.stdout.trim());
	if (!record(parsed)) throw new Error("install probe returned a non-object");
	return parsed;
}

function main(args) {
	const reportIndex = args.indexOf("--report");
	if (reportIndex === -1 || !args[reportIndex + 1]) {
		throw new Error(
			"Usage: node scripts/trading-package-install.mjs --report /path/to/installation.json [--workdir DIR] [--tarball-dir DIR] [--skip-pack]",
		);
	}
	const reportPath = resolve(args[reportIndex + 1]);
	const workdirIndex = args.indexOf("--workdir");
	const tarballIndex = args.indexOf("--tarball-dir");
	const skipPack = args.includes("--skip-pack");
	const repo = fileURLToPath(new URL("../", import.meta.url));
	const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
	const versions = candidateVersions(repo);
	const ownedWorkdir = workdirIndex === -1;
	const requestedWorkdir = resolve(workdirIndex === -1 ? mkdtempSync(join(tmpdir(), "ti-package-install-")) : args[workdirIndex + 1]);
	mkdirSync(requestedWorkdir, { recursive: true });
	// Private plan storage rejects symlink ancestors, including macOS's /var temporary-directory alias.
	const workdir = realpathSync(requestedWorkdir);
	assertOutsideRepository(workdir, repo);
	const tarballDir = resolve(tarballIndex === -1 ? join(workdir, "tarballs") : args[tarballIndex + 1]);
	const installDir = join(workdir, "install");
	const dataDir = join(workdir, "ti");
	const isolationRoot = join(workdir, "isolation");
	mkdirSync(tarballDir, { recursive: true });
	mkdirSync(installDir, { recursive: true });
	mkdirSync(dataDir, { recursive: true });
	const env = isolatedInstallEnvironment(isolationRoot);
	for (const path of [env.HOME, env.TI_DATA_DIR, env.TMPDIR, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME]) {
		mkdirSync(path, { recursive: true });
	}
	for (const path of [env.NPM_CONFIG_USERCONFIG, env.NPM_CONFIG_GLOBALCONFIG, env.GIT_CONFIG_GLOBAL]) {
		writeFileSync(path, "", { mode: 0o600 });
	}
	const report = {
		schemaVersion: 1,
		kind: "package-install",
		revision,
		nodeMajor: Number.parseInt(process.versions.node.split(".")[0], 10),
		versions,
		checks: {
			cleanInstall: false,
			cliVersion: false,
			isolatedDataDir: false,
			paperDefault: false,
			recoveryAfterRestart: false,
			continuityAfterRestart: false,
			evidenceTools: false,
		},
		passed: false,
	};
	try {
		if (!skipPack) {
			for (const pkg of [...INSTALL_PACKAGES, ...SUPPORTING_PACKAGES]) {
				assertBuiltPackage(join(repo, pkg.dir));
				run("npm", ["pack", "--pack-destination", tarballDir], {
					cwd: join(repo, pkg.dir),
					env,
					timeout: 120_000,
				});
			}
		}
		const tarballs = [
			...INSTALL_PACKAGES.map((pkg) => join(tarballDir, tarballFileName(pkg.name, versions[pkg.key]))),
			join(tarballDir, tarballFileName("@nikopack/ti-triggers", readPackage(join(repo, "packages/triggers")).version)),
		];
		for (const tarball of tarballs) {
			if (!existsSync(tarball)) throw new Error(`missing packed tarball ${tarball}`);
		}
		writeFileSync(join(installDir, "package.json"), `${JSON.stringify({ name: "ti-candidate-install", private: true, type: "module" }, null, 2)}\n`);
		run("npm", ["install", "--ignore-scripts", "--omit=dev", ...tarballs], {
			cwd: installDir,
			env,
			timeout: 5 * 60_000,
		});
		const installed = inspectInstalledVersions(installDir);
		const linkedToRepo = Object.values(installed.paths).some((path) => isInsideDirectory(path, repo));
		const exactDependencies =
			installed.versions.risk === versions.risk &&
			installed.versions.engine === versions.engine &&
			installed.versions.agent === versions.agent &&
			installed.engineRiskDependency === versions.risk &&
			installed.agentEngineDependency === versions.engine;
		const cli = run(process.execPath, [join(installed.paths.agent, "dist/cli.js"), "--version"], {
			cwd: installDir,
			env: { ...env, TI_DATA_DIR: dataDir },
			timeout: 30_000,
		});
		writeInstallProbe(join(installDir, "probe.mjs"));
		const first = probeTrading(installDir, dataDir, env, "pause");
		const second = probeTrading(installDir, dataDir, env, "verify", first.continuity);
		const homeLeak = first.homeLeak === true || second.homeLeak === true || existsSync(join(env.HOME, ".ti-trader"));
		const observation = {
			versions,
			cleanInstall: !linkedToRepo && exactDependencies,
			cliVersion: parseCliVersion(cli.stdout),
			isolatedDataDir: first.paperExists === true && first.stateExists === true && second.stateExists === true && !homeLeak,
			homeLeak,
			mode: first.mode,
			restartMode: second.mode,
			reservationId: first.reservationId,
			restartReservationId: second.reservationId,
			restartReason: second.reason,
			continuityAfterRestart: second.continuityAfterRestart === true,
			evidenceTools: first.evidenceTools === true && second.evidenceTools === true,
		};
		const evaluated = evaluateInstallChecks(observation);
		report.checks = evaluated.checks;
		report.passed = evaluated.passed;
	} finally {
		report.completedAt = new Date().toISOString();
		mkdirSync(dirname(reportPath), { recursive: true });
		writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
		if (ownedWorkdir) rmSync(workdir, { recursive: true, force: true });
	}
	console.log(`Install report: ${reportPath}`);
	if (!report.passed) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		main(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : "Package installation verification failed");
		process.exitCode = 1;
	}
}
