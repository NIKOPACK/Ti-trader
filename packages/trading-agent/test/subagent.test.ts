import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

const {
	ALLOWED_CHILD_TOOLS,
	buildChildSystemPrompt,
	buildProposedOrder,
	childEnvironment,
	discoverAgents,
	extractProposedOrder,
	parseToolList,
	PER_TASK_OUTPUT_CAP,
	PROPOSE_ORDER_TOOL,
	resolveChildTools,
	resolveCodingAgentCli,
	resolveSiblingMarketLab,
	runIsolatedChild,
	runSubagent,
} = await import("../../../extensions/subagent/index.ts");

const bundledDir = fileURLToPath(new URL("../../../extensions/subagent/agents", import.meta.url));
const extensionFileUrl = new URL("../../../extensions/subagent/index.ts", import.meta.url).href;

const temporaryDirectories: string[] = [];

function tempDir(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

function writeAgent(directory: string, fileName: string, body: string): void {
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, fileName), body, "utf8");
}

function childProcess() {
	const child = new EventEmitter() as EventEmitter & {
		pid?: number;
		stdout: PassThrough;
		stderr: PassThrough;
		kill: ReturnType<typeof vi.fn>;
	};
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.kill = vi.fn();
	return child;
}

function assistantMessage(text: string): IsolatedChildMessage {
	return { role: "assistant", content: [{ type: "text", text }] };
}

type IsolatedChildMessage = {
	role: string;
	content: Array<
		{ type: "text"; text: string } | { type: "toolCall"; name: string; arguments: Record<string, unknown> }
	>;
};

function okChild(text: string) {
	return {
		exitCode: 0,
		messages: [assistantMessage(text)],
		stderr: "",
		aborted: false,
		timedOut: false,
		outputTooLarge: false,
	};
}

const baseCtx = {
	cwd: process.cwd(),
	hasUI: false,
	isProjectTrusted: () => false,
};

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	spawnMock.mockReset();
	delete process.env.PI_CODING_AGENT_DIR;
	delete process.env.TI_DATA_DIR;
	delete process.env.TI_TEST_API_KEY;
	for (const directory of temporaryDirectories.splice(0)) {
		if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
	}
});

describe("subagent allowlist", () => {
	it("accepts yaml string and array tool lists", () => {
		expect(parseToolList("calculate_indicators, evaluate_strategy")).toEqual([
			"calculate_indicators",
			"evaluate_strategy",
		]);
		expect(parseToolList(["screen_markets", "simulate_rule"])).toEqual(["screen_markets", "simulate_rule"]);
	});

	it("defaults to the full allowlist and rejects trading tools", () => {
		expect(resolveChildTools(undefined).tools).toEqual([...ALLOWED_CHILD_TOOLS]);
		expect(resolveChildTools(["buy", "calculate_indicators"])).toEqual({
			tools: ["calculate_indicators"],
			rejected: ["buy"],
		});
	});

	it("puts the hard safety rules in every child system prompt", () => {
		const prompt = buildChildSystemPrompt("Custom agent body.");
		expect(prompt).toContain("no exchange access");
		expect(prompt).toContain("propose_order queues an order for the parent");
		expect(prompt).toContain("Never claim a fill");
		expect(prompt).toContain("Custom agent body.");
	});
});

describe("subagent discovery", () => {
	it("loads bundled researcher, scanner, and reviewer", () => {
		const discovery = discoverAgents({
			cwd: tempDir("ti-subagent-empty-"),
			scope: "user",
			bundledDir,
			userDir: join(tempDir("ti-subagent-nouser-"), "missing"),
		});
		expect(discovery.agents.map((agent) => agent.name).sort()).toEqual(["researcher", "reviewer", "scanner"]);
		expect(discovery.agents.every((agent) => agent.source === "bundled")).toBe(true);
		for (const agent of discovery.agents) {
			expect(resolveChildTools(agent.tools).rejected).toEqual([]);
		}
		const byName = Object.fromEntries(discovery.agents.map((agent) => [agent.name, agent.tools ?? []]));
		expect(byName.researcher).toContain(PROPOSE_ORDER_TOOL);
		expect(byName.scanner).not.toContain(PROPOSE_ORDER_TOOL);
		expect(byName.reviewer).not.toContain(PROPOSE_ORDER_TOOL);
	});

	it("lets a user agent override a bundled name", () => {
		const userDir = tempDir("ti-subagent-user-");
		writeAgent(
			userDir,
			"researcher.md",
			"---\nname: researcher\ndescription: User override\ntools: screen_markets\n---\nUser body.\n",
		);
		const discovery = discoverAgents({
			cwd: process.cwd(),
			scope: "user",
			bundledDir,
			userDir,
		});
		const researcher = discovery.agents.find((agent) => agent.name === "researcher");
		expect(researcher?.source).toBe("user");
		expect(researcher?.description).toBe("User override");
		expect(researcher?.tools).toEqual(["screen_markets"]);
	});

	it("finds project agents under .ti-trader/agents", () => {
		const cwd = tempDir("ti-subagent-project-");
		writeAgent(
			join(cwd, ".ti-trader", "agents"),
			"local.md",
			"---\nname: local-scanner\ndescription: Project scanner\ntools: screen_markets\n---\nProject body.\n",
		);
		const discovery = discoverAgents({
			cwd,
			scope: "both",
			bundledDir,
			userDir: join(tempDir("ti-subagent-nouser-"), "missing"),
		});
		expect(discovery.projectAgentsDir).toBe(join(cwd, ".ti-trader", "agents"));
		expect(discovery.agents.some((agent) => agent.name === "local-scanner" && agent.source === "project")).toBe(true);
	});
});

describe("subagent runner", () => {
	it("rejects mixed modes without spawning a child", async () => {
		const runChild = vi.fn();
		const output = await runSubagent(
			{ agent: "researcher", task: "look", tasks: [{ agent: "scanner", task: "scan" }] },
			baseCtx,
			{
				bundledDir,
				userDir: join(tempDir("ti-subagent-nouser-"), "missing"),
				extensionFileUrl,
				signal: new AbortController().signal,
				runChild,
			},
		);
		expect(output.isError).toBe(true);
		expect(output.content[0].text).toContain("exactly one mode");
		expect(runChild).not.toHaveBeenCalled();
	});

	it("does not spawn when an agent asks for buy", async () => {
		const userDir = tempDir("ti-subagent-buy-");
		writeAgent(
			userDir,
			"trader.md",
			"---\nname: trader\ndescription: Unsafe\ntools: buy, calculate_indicators\n---\nTrade it.\n",
		);
		const runChild = vi.fn();
		const output = await runSubagent({ agent: "trader", task: "buy BTC" }, baseCtx, {
			bundledDir,
			userDir,
			extensionFileUrl,
			signal: new AbortController().signal,
			runChild,
		});
		expect(runChild).not.toHaveBeenCalled();
		expect(output.isError).toBe(true);
		expect(output.content[0].text).toContain("buy");
		expect(output.content[0].text).toContain("allowlist");
	});

	it("runs a single bundled agent through the injected child", async () => {
		const runChild = vi.fn(async () => okChild("bias: none"));
		const output = await runSubagent({ agent: "researcher", task: "Analyze BTC 1h" }, baseCtx, {
			bundledDir,
			userDir: join(tempDir("ti-subagent-nouser-"), "missing"),
			extensionFileUrl,
			signal: new AbortController().signal,
			runChild,
		});
		expect(output.isError).toBeUndefined();
		expect(output.content[0].text).toBe("bias: none");
		expect(runChild).toHaveBeenCalledTimes(1);
		expect(runChild).toHaveBeenCalledWith(
			expect.objectContaining({
				prompt: "Task: Analyze BTC 1h",
				tools: [...ALLOWED_CHILD_TOOLS],
				systemPrompt: expect.stringContaining("propose_order queues an order for the parent"),
				extensionPaths: expect.arrayContaining([
					expect.stringMatching(/market-lab\/index\.(ts|js)$/),
					expect.stringMatching(/child-orders\.(ts|js)$/),
				]),
			}),
		);
	});

	it("surfaces propose_order as parent-pending proposals", async () => {
		const proposal = {
			submitted: false as const,
			pendingParent: true as const,
			side: "buy" as const,
			symbol: "BTC/USDT",
			type: "market" as const,
			quoteAmount: 100,
		};
		const runChild = vi.fn(async () => ({ ...okChild("queued"), proposals: [proposal] }));
		const output = await runSubagent({ agent: "researcher", task: "Propose a BTC buy" }, baseCtx, {
			bundledDir,
			userDir: join(tempDir("ti-subagent-nouser-"), "missing"),
			extensionFileUrl,
			signal: new AbortController().signal,
			runChild,
		});
		expect(output.isError).toBeUndefined();
		expect(output.content[0].text).toContain("queued");
		expect(output.content[0].text).toContain("not submitted");
		expect(output.content[0].text).toContain("buy BTC/USDT market quoteAmount=100");
		expect(output.details.proposals).toEqual([proposal]);
	});

	it("does not load propose_order or child-orders for scanner", async () => {
		const runChild = vi.fn(async () => okChild("scan"));
		await runSubagent({ agent: "scanner", task: "Screen USDT spots" }, baseCtx, {
			bundledDir,
			userDir: join(tempDir("ti-subagent-nouser-"), "missing"),
			extensionFileUrl,
			signal: new AbortController().signal,
			runChild,
		});
		expect(runChild).toHaveBeenCalledWith(
			expect.objectContaining({
				tools: expect.not.arrayContaining([PROPOSE_ORDER_TOOL]),
				extensionPaths: expect.not.arrayContaining([expect.stringMatching(/child-orders\.(ts|js)$/)]),
			}),
		);
	});

	it("keeps earlier propose_order in parent content after a reviewer chain step", async () => {
		const proposal = {
			submitted: false as const,
			pendingParent: true as const,
			side: "buy" as const,
			symbol: "BTC/USDT",
			type: "market" as const,
			quoteAmount: 100,
		};
		const runChild = vi.fn(async (request: { prompt: string }) => {
			if (request.prompt === "Task: first") return { ...okChild("researched"), proposals: [proposal] };
			return okChild("looks weak");
		});
		const output = await runSubagent(
			{
				chain: [
					{ agent: "researcher", task: "first" },
					{ agent: "reviewer", task: "review {previous}" },
				],
			},
			baseCtx,
			{
				bundledDir,
				userDir: join(tempDir("ti-subagent-nouser-"), "missing"),
				extensionFileUrl,
				signal: new AbortController().signal,
				runChild,
			},
		);
		expect(output.isError).toBeUndefined();
		expect(output.content[0].text).toContain("looks weak");
		expect(output.content[0].text).toContain("not submitted");
		expect(output.content[0].text).toContain("buy BTC/USDT market quoteAmount=100");
		expect(output.details.proposals).toEqual([proposal]);
	});

	it("includes child token usage in the parent tool content", async () => {
		const runChild = vi.fn(async () => ({
			...okChild("bias: none"),
			messages: [
				{
					role: "assistant",
					content: [{ type: "text" as const, text: "bias: none" }],
					usage: { input: 12, output: 4, cost: { total: 0.01 } },
				},
			],
		}));
		const output = await runSubagent({ agent: "researcher", task: "Analyze BTC 1h" }, baseCtx, {
			bundledDir,
			userDir: join(tempDir("ti-subagent-nouser-"), "missing"),
			extensionFileUrl,
			signal: new AbortController().signal,
			runChild,
		});
		expect(output.content[0].text).toContain("bias: none");
		expect(output.content[0].text).toContain("in:12");
		expect(output.content[0].text).toContain("out:4");
		expect(output.content[0].text).toContain("$0.0100");
	});

	it("substitutes {previous} in a chain and stops on failure", async () => {
		const runChild = vi.fn(async (request: { prompt: string }) => {
			if (request.prompt === "Task: first") return okChild("first-report");
			return {
				exitCode: 1,
				messages: [],
				stderr: "boom",
				aborted: false,
				timedOut: false,
				outputTooLarge: false,
				error: "boom",
			};
		});
		const output = await runSubagent(
			{
				chain: [
					{ agent: "scanner", task: "first" },
					{ agent: "reviewer", task: "review {previous}" },
				],
			},
			baseCtx,
			{
				bundledDir,
				userDir: join(tempDir("ti-subagent-nouser-"), "missing"),
				extensionFileUrl,
				signal: new AbortController().signal,
				runChild,
			},
		);
		expect(output.isError).toBe(true);
		expect(output.content[0].text).toContain("Chain stopped at step 2");
		expect(runChild).toHaveBeenCalledTimes(2);
		expect(runChild).toHaveBeenNthCalledWith(2, expect.objectContaining({ prompt: "Task: review first-report" }));
	});

	it("caps parallel fan-out", async () => {
		const runChild = vi.fn();
		const output = await runSubagent(
			{
				tasks: [
					{ agent: "scanner", task: "a" },
					{ agent: "scanner", task: "b" },
					{ agent: "scanner", task: "c" },
					{ agent: "scanner", task: "d" },
					{ agent: "scanner", task: "e" },
				],
			},
			baseCtx,
			{
				bundledDir,
				userDir: join(tempDir("ti-subagent-nouser-"), "missing"),
				extensionFileUrl,
				signal: new AbortController().signal,
				runChild,
			},
		);
		expect(output.isError).toBe(true);
		expect(output.content[0].text).toContain("Too many parallel tasks");
		expect(runChild).not.toHaveBeenCalled();
	});

	it("refuses untrusted project agents when no UI is available", async () => {
		const cwd = tempDir("ti-subagent-untrusted-");
		writeAgent(
			join(cwd, ".ti-trader", "agents"),
			"local.md",
			"---\nname: local-scanner\ndescription: Project scanner\ntools: screen_markets\n---\nProject body.\n",
		);
		const runChild = vi.fn();
		const output = await runSubagent(
			{ agent: "local-scanner", task: "scan", agentScope: "both" },
			{ ...baseCtx, cwd },
			{
				bundledDir,
				userDir: join(tempDir("ti-subagent-nouser-"), "missing"),
				extensionFileUrl,
				signal: new AbortController().signal,
				runChild,
			},
		);
		expect(runChild).not.toHaveBeenCalled();
		expect(output.content[0].text).toContain("project-local agents require confirmation");
	});

	it("ignores confirmProjectAgents=false for untrusted project agents", async () => {
		const cwd = tempDir("ti-subagent-force-confirm-");
		writeAgent(
			join(cwd, ".ti-trader", "agents"),
			"local.md",
			"---\nname: local-scanner\ndescription: Project scanner\ntools: screen_markets\n---\nProject body.\n",
		);
		const runChild = vi.fn();
		const output = await runSubagent(
			{ agent: "local-scanner", task: "scan", agentScope: "both", confirmProjectAgents: false },
			{ ...baseCtx, cwd },
			{
				bundledDir,
				userDir: join(tempDir("ti-subagent-nouser-"), "missing"),
				extensionFileUrl,
				signal: new AbortController().signal,
				runChild,
			},
		);
		expect(runChild).not.toHaveBeenCalled();
		expect(output.isError).toBe(true);
		expect(output.content[0].text).toContain("project-local agents require confirmation");
	});

	it("runs trusted project agents without a confirmation prompt", async () => {
		const cwd = tempDir("ti-subagent-trusted-");
		writeAgent(
			join(cwd, ".ti-trader", "agents"),
			"local.md",
			"---\nname: local-scanner\ndescription: Project scanner\ntools: screen_markets\n---\nProject body.\n",
		);
		const confirm = vi.fn();
		const runChild = vi.fn(async () => okChild("ok"));
		const output = await runSubagent(
			{ agent: "local-scanner", task: "scan", agentScope: "both" },
			{ cwd, hasUI: true, isProjectTrusted: () => true, confirm },
			{
				bundledDir,
				userDir: join(tempDir("ti-subagent-nouser-"), "missing"),
				extensionFileUrl,
				signal: new AbortController().signal,
				runChild,
			},
		);
		expect(confirm).not.toHaveBeenCalled();
		expect(runChild).toHaveBeenCalledTimes(1);
		expect(output.isError).toBeUndefined();
	});

	it("caps chain {previous} substitution", async () => {
		const huge = "x".repeat(PER_TASK_OUTPUT_CAP + 80);
		let secondPrompt = "";
		const runChild = vi.fn(async (request: { prompt: string }) => {
			if (request.prompt === "Task: first") return okChild(huge);
			secondPrompt = request.prompt;
			return okChild("reviewed");
		});
		await runSubagent(
			{
				chain: [
					{ agent: "scanner", task: "first" },
					{ agent: "reviewer", task: "review {previous}" },
				],
			},
			baseCtx,
			{
				bundledDir,
				userDir: join(tempDir("ti-subagent-nouser-"), "missing"),
				extensionFileUrl,
				signal: new AbortController().signal,
				runChild,
			},
		);
		expect(runChild).toHaveBeenCalledTimes(2);
		expect(secondPrompt.startsWith("Task: review ")).toBe(true);
		expect(Buffer.byteLength(secondPrompt, "utf8")).toBeLessThan(Buffer.byteLength(`Task: review ${huge}`, "utf8"));
	});
});

describe("isolated subagent child", () => {
	it("resolves the coding-agent CLI and sibling market-lab", () => {
		const cli = resolveCodingAgentCli();
		expect(existsSync(cli)).toBe(true);
		expect(cli).toMatch(/coding-agent\/(?:dist\/(?:bundle\/)?cli\.js|src\/cli\.ts)$/);
		const lab = resolveSiblingMarketLab(
			fileURLToPath(new URL("../../../extensions/subagent/index.ts", import.meta.url)),
		);
		expect(lab).toMatch(/market-lab\/index\.(ts|js)$/);
		expect(existsSync(lab)).toBe(true);
	});

	it("does not spawn when the request was already cancelled", async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await runIsolatedChild({
			cwd: process.cwd(),
			prompt: "Task: x",
			systemPrompt: "safe",
			tools: [...ALLOWED_CHILD_TOOLS],
			extensionPaths: ["lab"],
			signal: controller.signal,
		});
		expect(result.aborted).toBe(true);
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it("escalates in-flight cancellation from SIGTERM to SIGKILL and settles only after close", async () => {
		vi.useFakeTimers();
		const child = childProcess();
		child.pid = 43_302;
		spawnMock.mockReturnValue(child);
		const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
		const controller = new AbortController();
		const promise = runIsolatedChild({
			cwd: process.cwd(),
			prompt: "Task: x",
			systemPrompt: "safe",
			tools: [...ALLOWED_CHILD_TOOLS],
			extensionPaths: ["lab"],
			signal: controller.signal,
		});
		let settled = false;
		void promise.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		controller.abort();
		expect(killSpy).toHaveBeenCalledWith(-43_302, "SIGTERM");
		await Promise.resolve();
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1_999);
		expect(killSpy).not.toHaveBeenCalledWith(-43_302, "SIGKILL");
		await vi.advanceTimersByTimeAsync(1);
		expect(killSpy).toHaveBeenCalledWith(-43_302, "SIGKILL");
		expect(settled).toBe(false);
		child.emit("close", null, "SIGKILL");
		const result = await promise;
		expect(result.aborted).toBe(true);
		expect(result.error).toBe("Subagent was cancelled");
	});

	it("spawns a coding-agent child with filtered secrets and no trading tools", async () => {
		const child = childProcess();
		spawnMock.mockReturnValue(child);
		process.env.TI_TEST_API_KEY = "should-not-leak";
		process.env.PI_CODING_AGENT_DIR = "/tmp/ti-subagent-auth";
		const promise = runIsolatedChild({
			cwd: process.cwd(),
			prompt: "Task: Analyze risk",
			systemPrompt: "safe",
			tools: [...ALLOWED_CHILD_TOOLS],
			extensionPaths: ["/tmp/market-lab/index.ts"],
			model: "test/model",
			thinkingLevel: "medium",
			signal: new AbortController().signal,
		});
		child.stdout.write(
			`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "safe report" }] } })}\n`,
		);
		child.emit("close", 0);
		const result = await promise;
		expect(result.error).toBeUndefined();
		expect(result.messages.at(-1)?.content).toEqual([{ type: "text", text: "safe report" }]);
		const [command, args, options] = spawnMock.mock.calls[0] as [
			string,
			string[],
			{ env: NodeJS.ProcessEnv; shell: boolean; detached: boolean },
		];
		expect(command).toBe(process.execPath);
		expect(args[0]).toMatch(/cli\.(?:js|ts)$/);
		expect(args).toEqual(
			expect.arrayContaining([
				"--mode",
				"json",
				"--print",
				"--no-session",
				"--no-extensions",
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--no-context-files",
				"--no-builtin-tools",
				"--system-prompt",
				"--extension",
				"/tmp/market-lab/index.ts",
				"--tools",
				ALLOWED_CHILD_TOOLS.join(","),
				"--model",
				"test/model",
				"--thinking",
				"medium",
			]),
		);
		expect(args.at(-2)).toBe("--");
		expect(args.at(-1)).toBe("Task: Analyze risk");
		expect(args.join(" ")).not.toContain("buy");
		expect(options.shell).toBe(false);
		expect(options.detached).toBe(process.platform !== "win32");
		expect(Object.keys(options.env).every((name) => name !== "TI_TEST_API_KEY")).toBe(true);
		expect(options.env.PI_CODING_AGENT_DIR).toBe("/tmp/ti-subagent-auth");
		expect(options.env.TI_TEST_API_KEY).toBeUndefined();
	});

	it("reuses Ti auth via PI_CODING_AGENT_DIR and does not forward arbitrary env", () => {
		process.env.TI_DATA_DIR = "/tmp/ti-data";
		delete process.env.PI_CODING_AGENT_DIR;
		process.env.TI_TEST_API_KEY = "secret";
		const env = childEnvironment();
		expect(env.PI_CODING_AGENT_DIR).toBe(join("/tmp/ti-data", "agent"));
		expect(env.TI_TEST_API_KEY).toBeUndefined();
		expect(env.TI_DATA_DIR).toBeUndefined();
	});

	it("escalates a timeout and reports it only after the process closes", async () => {
		vi.useFakeTimers();
		const child = childProcess();
		child.pid = 43_301;
		spawnMock.mockReturnValue(child);
		const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
		const promise = runIsolatedChild({
			cwd: process.cwd(),
			prompt: "Task: x",
			systemPrompt: "safe",
			tools: [...ALLOWED_CHILD_TOOLS],
			extensionPaths: ["lab"],
			timeoutMs: 60_000,
			signal: new AbortController().signal,
		});
		let settled = false;
		void promise.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(killSpy).toHaveBeenCalledWith(-43_301, "SIGTERM");
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(killSpy).toHaveBeenCalledWith(-43_301, "SIGKILL");
		expect(settled).toBe(false);
		child.emit("close", null, "SIGKILL");
		const result = await promise;
		expect(result.timedOut).toBe(true);
		expect(result.error).toBe("Subagent timed out");
	});

	it("extracts propose_order from child JSON tool_execution_end and ignores failed calls", async () => {
		const child = childProcess();
		spawnMock.mockReturnValue(child);
		const accepted = buildProposedOrder({
			side: "buy",
			symbol: "BTC/USDT",
			type: "market",
			quoteAmount: 100,
		});
		const promise = runIsolatedChild({
			cwd: process.cwd(),
			prompt: "Task: x",
			systemPrompt: "safe",
			tools: [...ALLOWED_CHILD_TOOLS],
			extensionPaths: ["lab"],
			signal: new AbortController().signal,
		});
		child.stdout.write(
			`${JSON.stringify({
				type: "tool_execution_end",
				toolName: PROPOSE_ORDER_TOOL,
				isError: true,
				result: { details: accepted },
			})}\n`,
		);
		child.stdout.write(
			`${JSON.stringify({
				type: "tool_execution_end",
				toolName: PROPOSE_ORDER_TOOL,
				isError: false,
				result: { content: [{ type: "text", text: "queued" }], details: accepted },
			})}\n`,
		);
		child.stdout.write(
			`${JSON.stringify({
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "filled the buy" }] },
			})}\n`,
		);
		child.emit("close", 0);
		const result = await promise;
		expect(result.proposals).toEqual([accepted]);
		expect(result.messages.at(-1)?.content).toEqual([{ type: "text", text: "filled the buy" }]);
	});
});

describe("propose_order", () => {
	it("is parent-pending only and extractProposedOrder rejects fills", () => {
		const proposal = buildProposedOrder({
			side: "buy",
			symbol: "btc/usdt",
			type: "market",
			quoteAmount: 100,
		});
		expect(proposal).toMatchObject({ submitted: false, pendingParent: true, symbol: "BTC/USDT" });
		expect(extractProposedOrder({ details: proposal })).toEqual(proposal);
		expect(extractProposedOrder(proposal)).toEqual(proposal);
		expect(extractProposedOrder({ ...proposal, submitted: true })).toBeUndefined();
		expect(extractProposedOrder({ ...proposal, pendingParent: false })).toBeUndefined();
		expect(() => buildProposedOrder({ side: "buy", symbol: "BTCUSDT", type: "market", quoteAmount: 1 })).toThrow(
			/ccxt format/,
		);
		expect(() => buildProposedOrder({ side: "buy", symbol: "BTC/USDT", type: "market" })).toThrow(
			/amount or quoteAmount/,
		);
		expect(() => buildProposedOrder({ side: "buy", symbol: "BTC/USDT", type: "limit", amount: 1 })).toThrow(
			/requires price/,
		);
	});
});
