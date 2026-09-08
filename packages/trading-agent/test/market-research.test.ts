import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

const { invokeResearch, resolveCodingAgentCli } = await import("../../../extensions/market-research/index.ts");

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

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	spawnMock.mockReset();
	delete process.env.PI_CODING_AGENT_DIR;
	delete process.env.TI_TEST_API_KEY;
	delete process.env.TI_TEST_PUBLIC_VALUE;
});

describe("market research subagent", () => {
	it("resolves the coding-agent CLI from the source workspace layout", () => {
		const cli = resolveCodingAgentCli();
		expect(existsSync(cli)).toBe(true);
		expect(cli).toMatch(/coding-agent\/(?:dist\/(?:bundle\/)?cli\.js|src\/cli\.ts)$/);
	});

	it("does not spawn when the request was already cancelled", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(invokeResearch({ cwd: process.cwd() }, { question: "Analyze" }, controller.signal)).rejects.toThrow(
			"Research was cancelled",
		);
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it("spawns an isolated process with only market-lab tools and filtered secrets", async () => {
		const child = childProcess();
		spawnMock.mockReturnValue(child);
		process.env.TI_TEST_API_KEY = "should-not-leak";
		process.env.TI_TEST_PUBLIC_VALUE = "also-should-not-leak";
		process.env.PI_CODING_AGENT_DIR = "/tmp/ti-research-auth";
		const promise = invokeResearch(
			{ cwd: process.cwd(), model: { provider: "test", id: "model" }, thinkingLevel: "medium" },
			{ question: "Analyze risk", symbol: "BTC/USDT", timeframe: "1h" },
			new AbortController().signal,
		);
		child.stdout.write(
			`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "safe report" }] } })}\n`,
		);
		child.emit("close", 0);
		expect(await promise).toBe("safe report");
		const [command, args, options] = spawnMock.mock.calls[0];
		expect(command).toBe(process.execPath);
		expect(args[0]).toContain("coding-agent");
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
				"--extension",
				"--tools",
				"calculate_indicators,evaluate_strategy,screen_markets,simulate_rule",
				"--model",
				"test/model",
				"--thinking",
				"medium",
			]),
		);
		expect(args.at(-2)).toBe("--");
		expect(args.at(-1)).toContain("Research question: Analyze risk");
		expect(args.join(" ")).not.toContain("buy");
		expect(options.shell).toBe(false);
		expect(options.detached).toBe(process.platform !== "win32");
		const allowedEnvironment = new Set([
			"HOME",
			"PATH",
			"TMPDIR",
			"TMP",
			"TEMP",
			"LANG",
			"LC_ALL",
			"LC_CTYPE",
			"TZ",
			"SSL_CERT_FILE",
			"SSL_CERT_DIR",
			"PI_CODING_AGENT_DIR",
		]);
		expect(Object.keys(options.env).every((name) => allowedEnvironment.has(name))).toBe(true);
		expect(options.env.PI_CODING_AGENT_DIR).toBe("/tmp/ti-research-auth");
		expect(options.env.TI_TEST_API_KEY).toBeUndefined();
		expect(options.env.TI_TEST_PUBLIC_VALUE).toBeUndefined();
	});

	it("escalates cancellation from SIGTERM to SIGKILL and rejects only after close", async () => {
		vi.useFakeTimers();
		const child = childProcess();
		child.pid = 43_210;
		spawnMock.mockReturnValue(child);
		const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
		const controller = new AbortController();
		const promise = invokeResearch({ cwd: process.cwd() }, { question: "Analyze" }, controller.signal);
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
		expect(killSpy).toHaveBeenCalledWith(-43_210, "SIGTERM");
		await Promise.resolve();
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1_999);
		expect(killSpy).not.toHaveBeenCalledWith(-43_210, "SIGKILL");
		await vi.advanceTimersByTimeAsync(1);
		expect(killSpy).toHaveBeenCalledWith(-43_210, "SIGKILL");
		expect(settled).toBe(false);
		child.emit("close", null, "SIGKILL");
		await expect(promise).rejects.toThrow("Research was cancelled");
	});

	it("escalates a timeout and reports it only after the process closes", async () => {
		vi.useFakeTimers();
		const child = childProcess();
		child.pid = 43_211;
		spawnMock.mockReturnValue(child);
		const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
		const promise = invokeResearch({ cwd: process.cwd() }, { question: "Analyze" }, new AbortController().signal);
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
		expect(killSpy).toHaveBeenCalledWith(-43_211, "SIGTERM");
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(killSpy).toHaveBeenCalledWith(-43_211, "SIGKILL");
		expect(settled).toBe(false);
		child.emit("close", null, "SIGKILL");
		await expect(promise).rejects.toThrow("Research subagent timed out");
	});
});
