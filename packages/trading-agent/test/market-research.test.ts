import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

const { invokeResearch } = await import("../../../extensions/market-research/index.ts");

function childProcess() {
	const child = new EventEmitter() as EventEmitter & {
		stdout: PassThrough;
		stderr: PassThrough;
		kill: ReturnType<typeof vi.fn>;
	};
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.kill = vi.fn();
	return child;
}

afterEach(() => spawnMock.mockReset());

describe("market research subagent", () => {
	it("spawns an isolated process with only market-lab tools and filtered secrets", async () => {
		const child = childProcess();
		spawnMock.mockReturnValue(child);
		process.env.TI_TEST_API_KEY = "should-not-leak";
		const promise = invokeResearch(
			{ cwd: process.cwd(), model: { provider: "test", id: "model" } },
			{ question: "Analyze risk", symbol: "BTC/USDT", timeframe: "1h" },
			new AbortController().signal,
		);
		child.stdout.write(
			`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "safe report" }] } })}\n`,
		);
		child.emit("close", 0);
		expect(await promise).toBe("safe report");
		const [, args, options] = spawnMock.mock.calls[0];
		expect(args).toContain("calculate_indicators,analyze_market_structure,generate_trade_signal");
		expect(args.join(" ")).not.toContain("buy");
		expect(options.shell).toBe(false);
		expect(options.env.TI_TEST_API_KEY).toBeUndefined();
		delete process.env.TI_TEST_API_KEY;
	});

	it("kills and rejects a cancelled research process", async () => {
		const child = childProcess();
		spawnMock.mockReturnValue(child);
		const controller = new AbortController();
		const promise = invokeResearch({ cwd: process.cwd() }, { question: "Analyze" }, controller.signal);
		controller.abort();
		expect(child.kill).toHaveBeenCalledWith("SIGTERM");
		child.emit("close", null);
		await expect(promise).rejects.toThrow("Research was cancelled");
	});
});
