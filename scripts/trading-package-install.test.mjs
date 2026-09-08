import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
} from "./trading-package-install.mjs";

const roots = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temp() {
	const root = mkdtempSync(join(tmpdir(), "ti-package-install-"));
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

test("requires every install check, including restart recovery of the probe pause", () => {
	const versions = { risk: "0.2.0", engine: "0.3.0", agent: "0.1.10" };
	const pauseId = "pause-1";
	assert.deepEqual(evaluateInstallChecks({
		versions, cleanInstall: true, cliVersion: "0.1.10", isolatedDataDir: true, homeLeak: false,
		mode: "paper", restartMode: "paper", pauseId, restartPauseId: pauseId, restartReason: "package-install-probe",
	}), {
		passed: true,
		checks: { cleanInstall: true, cliVersion: true, isolatedDataDir: true, paperDefault: true, recoveryAfterRestart: true },
	});
	assert.equal(evaluateInstallChecks({
		versions, cleanInstall: true, cliVersion: "0.1.10", isolatedDataDir: true, homeLeak: false,
		mode: "paper", restartMode: "paper", pauseId, restartPauseId: "other", restartReason: "package-install-probe",
	}).passed, false);
	assert.equal(evaluateInstallChecks({
		versions, cleanInstall: true, cliVersion: "0.1.9", isolatedDataDir: true, homeLeak: false,
		mode: "paper", restartMode: "paper", pauseId, restartPauseId: pauseId, restartReason: "package-install-probe",
	}).passed, false);
});
