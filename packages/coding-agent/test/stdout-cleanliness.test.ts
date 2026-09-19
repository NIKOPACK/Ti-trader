import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { main } from "../src/main.ts";
import { allowNetwork } from "./test-network-env.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");

const tempDirs: string[] = [];

beforeEach(() => {
	allowNetwork();
});

afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-stdout-clean-"));
	tempDirs.push(dir);
	return dir;
}

async function runCli(
	args: string[],
	env: NodeJS.ProcessEnv = {},
): Promise<{ stdout: string; stderr: string; code: number | null }> {
	const tempRoot = createTempDir();
	const agentDir = join(tempRoot, "agent");
	const projectDir = join(tempRoot, "project");
	const projectConfigDir = join(projectDir, ".pi");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(projectConfigDir, { recursive: true });

	const fakeNpmPath = join(tempRoot, "fake-npm.mjs");
	writeFileSync(
		fakeNpmPath,
		[
			'console.log("changed 1 package in 471ms");',
			'console.log("found 0 vulnerabilities");',
			"process.exit(0);",
		].join("\n"),
		"utf-8",
	);

	writeFileSync(
		join(projectConfigDir, "settings.json"),
		JSON.stringify(
			{
				packages: ["npm:fake-package"],
				npmCommand: [process.execPath, fakeNpmPath],
			},
			null,
			2,
		),
		"utf-8",
	);

	return await new Promise((resolvePromise, reject) => {
		const child = spawn(process.execPath, [cliPath, ...args], {
			cwd: projectDir,
			env: {
				...process.env,
				...env,
				[ENV_AGENT_DIR]: agentDir,
				TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
			},
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => {
			resolvePromise({ stdout, stderr, code });
		});
	});
}

describe("stdout cleanliness in non-interactive modes", () => {
	it("rejects TTY credential output before creating the credential runtime", async () => {
		const originalExitCode = process.exitCode;
		const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		const create = vi.spyOn(ModelRuntime, "create");
		const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			process.exitCode = undefined;
			Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
			await main(["auth", "print-api-key", "--provider", "openai"]);
			expect(create).not.toHaveBeenCalled();
			expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Refusing to print credentials to a terminal"));
			expect(process.exitCode).toBe(1);
		} finally {
			process.exitCode = originalExitCode;
			if (originalIsTTY) Object.defineProperty(process.stdout, "isTTY", originalIsTTY);
			else Reflect.deleteProperty(process.stdout, "isTTY");
		}
	});

	it("prints plain --help to stdout when stdout is redirected", async () => {
		const result = await runCli(["--help"]);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Usage:");
		expect(result.stderr).not.toContain("Usage:");
		expect(result.stderr).not.toContain("changed 1 package in 471ms");
		expect(result.stderr).not.toContain("found 0 vulnerabilities");
	});

	it("keeps stdout empty for --mode json --help while routing trusted startup chatter to stderr", async () => {
		const result = await runCli(["--mode", "json", "--help", "--approve"]);

		expect(result.code).toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("changed 1 package in 471ms");
		expect(result.stderr).toContain("found 0 vulnerabilities");
		expect(result.stderr).toContain("Usage:");
	});

	it("writes credentials to a new file without writing stdout", async () => {
		const secret = "stdout-cleanliness-secret";
		const outputPath = join(createTempDir(), "openai-key");
		const result = await runCli(["auth", "print-api-key", "--provider", "openai", "--output-file", outputPath], {
			OPENAI_API_KEY: secret,
		});

		expect(result.code).toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).not.toContain(secret);
		expect(readFileSync(outputPath, "utf8")).toBe(`${secret}\n`);
	});

	it("never includes a resolved credential when file creation fails", async () => {
		const secret = "failed-output-secret";
		const outputPath = join(createTempDir(), "existing-key");
		writeFileSync(outputPath, "occupied", "utf8");
		const result = await runCli(["auth", "print-api-key", "--provider", "openai", "--output-file", outputPath], {
			OPENAI_API_KEY: secret,
		});

		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("Failed to resolve credential");
		expect(result.stderr).not.toContain(secret);
		expect(readFileSync(outputPath, "utf8")).toBe("occupied");
	});
});
