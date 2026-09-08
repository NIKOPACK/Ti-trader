import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	resolveBundledMarketChartExtension,
	resolveBundledMarketLabExtension,
	resolveBundledMarketResearchExtension,
	resolveBundledWebSearchExtension,
	resolveBundledZhihuResearchExtension,
	resolveOptionalBundledExtensionPaths,
} from "../bundled-extensions.ts";

const OPTIONAL_ENV_KEYS = [
	"TAVILY_API_KEY",
	"ZHIHU_ACCESS_SECRET",
	"TI_ZHIHU_ACCESS_SECRET_FILE",
	"TI_MARKET_RESEARCH",
] as const;

const originalOptionalEnv: Record<(typeof OPTIONAL_ENV_KEYS)[number], string | undefined> = {
	TAVILY_API_KEY: process.env.TAVILY_API_KEY,
	ZHIHU_ACCESS_SECRET: process.env.ZHIHU_ACCESS_SECRET,
	TI_ZHIHU_ACCESS_SECRET_FILE: process.env.TI_ZHIHU_ACCESS_SECRET_FILE,
	TI_MARKET_RESEARCH: process.env.TI_MARKET_RESEARCH,
};

const temporaryDirectories: string[] = [];
let tempDir: string | undefined;

function restoreOptionalEnv(): void {
	for (const key of OPTIONAL_ENV_KEYS) {
		const value = originalOptionalEnv[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

function clearOptionalEnv(): void {
	for (const key of OPTIONAL_ENV_KEYS) delete process.env[key];
}

function optionalBasenames(): string[] {
	return resolveOptionalBundledExtensionPaths().map((path) => basename(path));
}

function isolateMissingZhihuSecretFile(): void {
	process.env.TI_ZHIHU_ACCESS_SECRET_FILE = join(tmpdir(), `ti-zhihu-missing-${process.pid}-${Date.now()}`);
}

function writeTemporarySecret(contents: string): string {
	const directory = mkdtempSync(join(tmpdir(), "ti-zhihu-secret-"));
	temporaryDirectories.push(directory);
	const secretPath = join(directory, "zhihu-access-secret");
	writeFileSync(secretPath, contents, "utf8");
	return secretPath;
}

afterEach(() => {
	restoreOptionalEnv();
	if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	tempDir = undefined;
	for (const path of temporaryDirectories.splice(0)) {
		if (existsSync(path)) rmSync(path, { recursive: true, force: true });
	}
});

describe("bundled market-lab extension", () => {
	it("resolves the source or packaged market-lab directory", () => {
		const path = resolveBundledMarketLabExtension();
		expect(basename(path)).toBe("market-lab");
		expect(existsSync(path)).toBe(true);
		expect(existsSync(`${path}/index.ts`) || existsSync(`${path}/index.js`)).toBe(true);
	});

	it("registers quant tools and commands without --extension", async () => {
		tempDir = join(tmpdir(), `ti-market-lab-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.create(tempDir, join(agentDir, "sessions"));
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir,
			settingsManager,
			resourceLoaderOptions: {
				manifestFlavor: "ti",
				noContextFiles: true,
				noSkills: true,
				noExtensions: true,
				additionalExtensionPaths: [resolveBundledMarketLabExtension()],
			},
		});
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager,
			noTools: "builtin",
			customTools: [],
		});
		try {
			const toolNames = (session.agent.state.tools ?? []).map((tool) =>
				typeof tool === "string" ? tool : tool.name,
			);
			expect(toolNames).toEqual(
				expect.arrayContaining(["calculate_indicators", "evaluate_strategy", "screen_markets", "simulate_rule"]),
			);
			expect(toolNames).not.toContain("analyze_market_structure");
			expect(toolNames).not.toContain("generate_trade_signal");
			const commands = services.resourceLoader
				.getExtensions()
				.extensions.flatMap((extension) => [...(extension.commands?.keys() ?? [])]);
			expect(commands).toEqual(expect.arrayContaining(["indicators", "signal", "screen", "replay"]));
		} finally {
			session.dispose();
		}
	});
});

describe("bundled extension resolution", () => {
	it.each([
		["market-lab", resolveBundledMarketLabExtension],
		["market-chart", resolveBundledMarketChartExtension],
		["web-search", resolveBundledWebSearchExtension],
		["zhihu-research", resolveBundledZhihuResearchExtension],
		["market-research", resolveBundledMarketResearchExtension],
	] as const)("resolves the source or packaged %s directory", (name, resolve) => {
		const path = resolve();
		expect(basename(path)).toBe(name);
		expect(existsSync(path)).toBe(true);
		expect(existsSync(`${path}/index.ts`) || existsSync(`${path}/index.js`)).toBe(true);
	});
});

describe("optional bundled extension paths", () => {
	beforeEach(() => {
		clearOptionalEnv();
		isolateMissingZhihuSecretFile();
	});

	it("loads none when opt-in env and secret file are absent", () => {
		expect(resolveOptionalBundledExtensionPaths()).toEqual([]);
	});

	it("auto-loads web-search when TAVILY_API_KEY is non-empty", () => {
		process.env.TAVILY_API_KEY = "tvly-test";
		expect(optionalBasenames()).toEqual(["web-search"]);
	});

	it("ignores a whitespace-only TAVILY_API_KEY", () => {
		process.env.TAVILY_API_KEY = "  \n";
		expect(resolveOptionalBundledExtensionPaths()).toEqual([]);
	});

	it("auto-loads zhihu-research when ZHIHU_ACCESS_SECRET is non-empty", () => {
		process.env.ZHIHU_ACCESS_SECRET = "zhihu-secret";
		expect(optionalBasenames()).toEqual(["zhihu-research"]);
	});

	it("auto-loads zhihu-research when the secret file has content", () => {
		process.env.TI_ZHIHU_ACCESS_SECRET_FILE = writeTemporarySecret(" file-secret \n");
		expect(optionalBasenames()).toEqual(["zhihu-research"]);
	});

	it("ignores an empty or whitespace-only zhihu secret file", () => {
		process.env.TI_ZHIHU_ACCESS_SECRET_FILE = writeTemporarySecret("  \n");
		expect(resolveOptionalBundledExtensionPaths()).toEqual([]);
	});

	it("ignores a missing zhihu secret file", () => {
		process.env.TI_ZHIHU_ACCESS_SECRET_FILE = join(tmpdir(), "ti-zhihu-does-not-exist");
		expect(resolveOptionalBundledExtensionPaths()).toEqual([]);
	});

	it.each(["1", "true", "yes", "TRUE", " Yes "])(
		"auto-loads market-research when TI_MARKET_RESEARCH is %j",
		(value) => {
			process.env.TI_MARKET_RESEARCH = value;
			expect(optionalBasenames()).toEqual(["market-research"]);
		},
	);

	it.each(["", "0", "false", "on", "  "])("ignores TI_MARKET_RESEARCH=%j", (value) => {
		process.env.TI_MARKET_RESEARCH = value;
		expect(resolveOptionalBundledExtensionPaths()).toEqual([]);
	});

	it("auto-loads every opted-in bundled extension in stable order", () => {
		process.env.TAVILY_API_KEY = "tvly-test";
		process.env.ZHIHU_ACCESS_SECRET = "zhihu-secret";
		process.env.TI_MARKET_RESEARCH = "1";
		expect(optionalBasenames()).toEqual(["web-search", "zhihu-research", "market-research"]);
	});
});
