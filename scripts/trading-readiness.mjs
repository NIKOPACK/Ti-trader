import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const READINESS_TESTS = {
	risk: ["src/risk.test.ts"],
	engine: [
		"src/engine.test.ts", "src/capabilities.test.ts", "src/ccxt-client.test.ts", "src/paper-client.test.ts",
		"src/paper-account.test.ts", "src/persist.test.ts",
		"src/paper-durability.test.ts",
		"src/execution-recovery.test.ts",
	],
	agent: [
		"src/__tests__/commands.test.ts", "src/__tests__/context.test.ts", "src/__tests__/trading.test.ts",
		"src/__tests__/monitor.test.ts", "src/__tests__/trigger-monitor.test.ts",
		"src/__tests__/tools.test.ts", "src/__tests__/i18n.test.ts",
		"src/__tests__/capabilities.test.ts", "src/__tests__/operational-health.test.ts",
		"src/__tests__/health.test.ts",
		"src/__tests__/args.test.ts", "src/__tests__/package-api.test.ts",
		"src/__tests__/published-coding-agent-api.test.ts", "src/__tests__/project-trust.test.ts",
		"src/__tests__/execution-runtime.test.ts", "src/__tests__/monitoring-state.test.ts",
		"src/__tests__/paper-reset-durability.test.ts",
		"src/__tests__/durable-trigger-monitor.test.ts", "src/__tests__/tool-availability.test.ts",
	],
};

export function isolatedReadinessEnvironment(root, source = process.env) {
	const env = {
		HOME: join(root, "home"),
		USERPROFILE: join(root, "home"),
		TI_DATA_DIR: join(root, "ti"),
		TMPDIR: join(root, "tmp"),
		TMP: join(root, "tmp"),
		TEMP: join(root, "tmp"),
		XDG_CONFIG_HOME: join(root, "home", ".config"),
		XDG_CACHE_HOME: join(root, "cache"),
		NPM_CONFIG_USERCONFIG: join(root, "npm-userconfig"),
		NPM_CONFIG_GLOBALCONFIG: join(root, "npm-globalconfig"),
		NPM_CONFIG_CACHE: join(root, "cache", "npm"),
		NPM_CONFIG_UPDATE_NOTIFIER: "false",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
		GIT_TERMINAL_PROMPT: "0",
		PI_NO_LOCAL_LLM: "1",
		AWS_EC2_METADATA_DISABLED: "true",
		TZ: "UTC",
		LANG: "C",
		LC_ALL: "C",
		NO_COLOR: "1",
	};
	for (const key of ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "CI", "GITHUB_ACTIONS"]) {
		if (source[key] !== undefined) env[key] = source[key];
	}
	return env;
}

export function readinessCommands(repo, platform = process.platform) {
	const vitest = join(repo, "node_modules", "vitest", "dist", "cli.js");
	return [
		{ name: "repository-check", command: platform === "win32" ? "cmd.exe" : "npm",
			args: platform === "win32" ? ["/d", "/s", "/c", "npm run check"] : ["run", "check"], cwd: repo },
		...Object.entries(READINESS_TESTS).map(([name, files]) => ({
			name, command: process.execPath, args: [vitest, "--run", ...files], cwd: join(repo, "packages", `trading-${name}`),
		})),
		{ name: "release-gate", command: process.execPath,
			args: ["--test", "scripts/trading-release-gate.test.mjs", "scripts/trading-readiness.test.mjs",
				"scripts/trading-package-install.test.mjs", "scripts/trading-paper-soak.test.mjs"], cwd: repo },
	];
}

function main(args) {
	if (args.length !== 2 || args[0] !== "--report") {
		throw new Error("Usage: node scripts/trading-readiness.mjs --report /path/to/offline.json");
	}
	const reportPath = resolve(args[1]);
	const repo = fileURLToPath(new URL("../", import.meta.url));
	const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
	const initialStatus = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim();
	const root = mkdtempSync(join(tmpdir(), "ti-readiness-"));
	const report = { schemaVersion: 1, kind: "offline-readiness", revision, startedAt: new Date().toISOString(),
		workingTreeClean: initialStatus === "", suites: [], passed: false };
	try {
		const env = isolatedReadinessEnvironment(root);
		for (const path of [env.HOME, env.TI_DATA_DIR, env.TMPDIR, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME]) {
			mkdirSync(path, { recursive: true });
		}
		for (const path of [env.NPM_CONFIG_USERCONFIG, env.NPM_CONFIG_GLOBALCONFIG, env.GIT_CONFIG_GLOBAL]) {
			writeFileSync(path, "", { mode: 0o600 });
		}
		for (const command of readinessCommands(repo)) {
			console.log(`Readiness: ${command.name}`);
			const result = spawnSync(command.command, command.args, {
				cwd: command.cwd, env, stdio: "inherit", timeout: 10 * 60_000,
			});
			report.suites.push({ name: command.name, exitCode: result.status ?? 1,
				...(READINESS_TESTS[command.name] ? { files: READINESS_TESTS[command.name] } : {}),
				...(result.error ? { errorCode: result.error.code ?? "PROCESS_FAILURE" } : {}) });
			if (result.error || result.status !== 0) break;
		}
		report.passed = report.suites.length === readinessCommands(repo).length &&
			report.suites.every((suite) => suite.exitCode === 0);
		const finalRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
		const finalStatus = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim();
		report.workingTreeClean &&= finalRevision === revision && finalStatus === "";
	} finally {
		report.completedAt = new Date().toISOString();
		try {
			mkdirSync(dirname(reportPath), { recursive: true });
			writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}
	console.log(`Readiness report: ${reportPath}`);
	if (!report.passed) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		main(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : "Readiness runner failed");
		process.exitCode = 1;
	}
}
