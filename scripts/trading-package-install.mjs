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
			text(observation.pauseId) && observation.pauseId === observation.restartPauseId && observation.restartReason === "package-install-probe",
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

function writeProbe(path) {
	writeFileSync(
		path,
		`import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { initTrading } from "ti-trader";
const action = process.argv[2];
const dataDir = process.env.TI_DATA_DIR;
const trading = await initTrading();
try {
	const pause = action === "pause"
		? trading.tradingEngine.risk.pauseNewExposure("package-install-probe")
		: trading.tradingEngine.risk.usage().newExposurePause;
	if (action !== "pause" && action !== "verify") throw new Error("probe action must be pause or verify");
	console.log(JSON.stringify({
		mode: trading.mode,
		exchange: trading.config.exchange,
		quoteCurrency: trading.config.quoteCurrency,
		pauseId: pause?.id,
		reason: pause?.reason,
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

function probeTrading(installDir, dataDir, env, action) {
	const result = run(process.execPath, [join(installDir, "probe.mjs"), action], {
		cwd: installDir,
		env: { ...env, TI_DATA_DIR: dataDir },
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
	const workdir = resolve(workdirIndex === -1 ? mkdtempSync(join(tmpdir(), "ti-package-install-")) : args[workdirIndex + 1]);
	mkdirSync(workdir, { recursive: true });
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
		writeProbe(join(installDir, "probe.mjs"));
		const first = probeTrading(installDir, dataDir, env, "pause");
		const second = probeTrading(installDir, dataDir, env, "verify");
		const homeLeak = first.homeLeak === true || second.homeLeak === true || existsSync(join(env.HOME, ".ti-trader"));
		const observation = {
			versions,
			cleanInstall: !linkedToRepo && exactDependencies,
			cliVersion: parseCliVersion(cli.stdout),
			isolatedDataDir: first.paperExists === true && first.stateExists === true && second.stateExists === true && !homeLeak,
			homeLeak,
			mode: first.mode,
			restartMode: second.mode,
			pauseId: first.pauseId,
			restartPauseId: second.pauseId,
			restartReason: second.reason,
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
