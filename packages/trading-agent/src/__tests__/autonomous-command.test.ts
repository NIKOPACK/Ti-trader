import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ExecutionScope } from "@nikopack/ti-trading-engine";
import { describe, expect, it, vi } from "vitest";
import { type AutonomousCommandDependencies, createAutonomousCommandExtension } from "../autonomous/command.ts";
import { type AutonomousStatus, assertAutonomousScope } from "../autonomous/daemon.ts";
import { t } from "../i18n.ts";

const scope: ExecutionScope = {
	mode: "paper",
	exchange: "binance",
	marketType: "spot",
	quoteCurrency: "USDT",
	positionMode: "one-way",
	accountId: "fixture",
};
const status: AutonomousStatus = {
	mode: "paper",
	exchange: "binance",
	marketType: "spot",
	pid: 123,
	processAlive: true,
	control: "paused",
	heartbeat: 1000,
	pendingEvents: 2,
	coalescedEvents: 0,
	droppedEvents: 1,
	currentDecision: undefined,
	wakes: [],
	lastDecision: { id: "decision", eventId: "event", at: 1000, text: "Wait for new evidence", outcome: "completed" },
	failures: [{ at: 1000, source: "model", reason: "timeout" }],
	risk: undefined,
};

function setup() {
	const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
	const api: Pick<ExtensionAPI, "registerCommand" | "registerEntryRenderer" | "appendEntry"> = {
		registerCommand: (name, command) => {
			commands.set(name, command);
		},
		registerEntryRenderer: vi.fn(),
		appendEntry: vi.fn(),
	};
	const deps = {
		current: vi.fn<AutonomousCommandDependencies["current"]>(() => ({ scope, language: "zh-CN", stale: false })),
		execute: vi.fn<AutonomousCommandDependencies["execute"]>(async (action, options) => {
			if (action === "status") options.onStatus?.(status);
			else options.output?.("pid=123 log=/fixture/autonomous.log");
		}),
	};
	const context = {
		hasUI: true,
		mode: "tui" as ExtensionCommandContext["mode"],
		isIdle: vi.fn(() => true),
		waitForIdle: vi.fn(async () => {}),
		ui: { notify: vi.fn() },
	};
	createAutonomousCommandExtension(deps)(api);
	const command = commands.get("autonomous")!;
	const run = (args: string) => command.handler(args, context as unknown as ExtensionCommandContext);
	const transcript = () => JSON.stringify(vi.mocked(api.appendEntry).mock.calls);
	return { command, deps, api, context, run, transcript };
}

describe("autonomous TUI command", () => {
	it("registers without starting anything and completes only TUI control actions", async () => {
		const { command, deps } = setup();
		expect(deps.execute).not.toHaveBeenCalled();
		expect(await command.getArgumentCompletions?.("")).toEqual(
			["start", "status", "pause", "resume", "stop"].map((value) => ({ value, label: value })),
		);
		expect(await command.getArgumentCompletions?.("sta")).toEqual([
			{ value: "start", label: "start" },
			{ value: "status", label: "status" },
		]);
	});

	it("defaults to status and writes localized non-model transcript entries", async () => {
		const { run, deps, api, transcript } = setup();
		await run("");
		expect(deps.execute).toHaveBeenCalledWith("status", expect.objectContaining({ expectedScope: scope }));
		expect(api.appendEntry).toHaveBeenCalledWith(
			"trading:autonomous",
			expect.objectContaining({ title: "自主交易" }),
		);
		expect(transcript()).toContain("Wait for new evidence");
		expect(transcript()).toContain("model: timeout");
		expect(transcript()).toContain(t("zh-CN", "autonomousEvents"));
	});

	it.each(["start", "status", "pause", "resume", "stop"] as const)(
		"routes %s to the account-bound controller",
		async (action) => {
			const { run, deps } = setup();
			await run(` ${action} `);
			expect(deps.execute).toHaveBeenCalledExactlyOnceWith(
				action,
				expect.objectContaining({ expectedScope: scope }),
			);
		},
	);

	it.each(["start", "resume"] as const)("waits for idle before %s", async (action) => {
		const { run, deps, context } = setup();
		context.isIdle.mockReturnValue(false);
		let unblock: (() => void) | undefined;
		context.waitForIdle.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					unblock = resolve;
				}),
		);
		const pending = run(action);
		expect(context.waitForIdle).toHaveBeenCalledOnce();
		expect(deps.execute).not.toHaveBeenCalled();
		unblock!();
		await pending;
		expect(deps.execute).toHaveBeenCalledOnce();
	});

	it.each(["pause", "stop", "status"] as const)("does not wait for model idle before %s", async (action) => {
		const { run, deps, context } = setup();
		context.isIdle.mockReturnValue(false);
		deps.current.mockReturnValue({
			scope,
			language: "zh-CN",
			get stale(): boolean {
				throw new Error("Do not inspect admission");
			},
		});
		await run(action);
		expect(context.waitForIdle).not.toHaveBeenCalled();
		expect(deps.execute).toHaveBeenCalledOnce();
	});

	it.each(["run", "start extra", "enable"])("rejects unsupported syntax %s", async (args) => {
		const { run, deps, context } = setup();
		await run(args);
		expect(deps.execute).not.toHaveBeenCalled();
		expect(context.ui.notify).toHaveBeenCalledWith(t("zh-CN", "autonomousUsage"), "warning");
	});

	it.each(["print", "rpc"] as const)("does not expose operator controls in %s mode", async (mode) => {
		const { run, deps, context } = setup();
		context.mode = mode;
		await run("resume");
		expect(deps.execute).not.toHaveBeenCalled();
		expect(context.ui.notify).toHaveBeenCalledWith(t("zh-CN", "autonomousTuiOnly"), "error");
	});

	it("rejects a context without a UI", async () => {
		const { run, deps, context } = setup();
		context.hasUI = false;
		await run("start");
		expect(deps.execute).not.toHaveBeenCalled();
	});

	it("does not start another account after the idle wait", async () => {
		const { run, deps, context, transcript } = setup();
		context.isIdle.mockReturnValue(false);
		context.waitForIdle.mockImplementation(async () => {
			deps.current.mockReturnValue({ scope: { ...scope, accountId: "another-account" }, language: "zh-CN" });
		});
		await run("start");
		expect(deps.execute).not.toHaveBeenCalled();
		expect(transcript()).toContain("Autonomous account differs");
	});

	it.each(["start", "resume"] as const)("refuses %s with stale admission", async (action) => {
		const { run, deps, transcript } = setup();
		deps.current.mockReturnValue({ scope, language: "zh-CN", stale: true });
		await run(action);
		expect(deps.execute).not.toHaveBeenCalled();
		expect(transcript()).toContain(t("zh-CN", "healthStaleRuntime"));
	});

	it("reports configuration errors without claiming success", async () => {
		const { run, deps, context, transcript } = setup();
		deps.execute.mockRejectedValue(new Error("autonomous.json is missing"));
		await run("start");
		expect(transcript()).toContain("autonomous.json is missing");
		expect(transcript()).toContain(t("zh-CN", "autonomousConfigHint"));
		expect(transcript()).not.toContain(t("zh-CN", "autonomousStarted"));
		expect(context.ui.notify).toHaveBeenCalledWith(t("zh-CN", "autonomousFailed"), "error");
	});

	it("explains detached startup and stop without closing positions", async () => {
		const { run, transcript } = setup();
		await run("start");
		expect(transcript()).toContain(t("zh-CN", "autonomousStarted"));
		expect(transcript()).toContain("/fixture/autonomous.log");
		await run("stop");
		expect(transcript()).toContain(t("zh-CN", "autonomousStopped"));
	});
});

describe("autonomous account fence", () => {
	it("accepts the same canonical account scope", () => {
		expect(() => assertAutonomousScope(scope, { ...scope })).not.toThrow();
	});
	it.each<Partial<ExecutionScope>>([
		{ accountId: "other" },
		{ mode: "live" },
		{ exchange: "okx" },
		{ marketType: "usdm-futures" },
		{ quoteCurrency: "USDC" },
		{ positionMode: "hedge" },
	])("rejects a different scope %j", (changed) => {
		expect(() => assertAutonomousScope(scope, { ...scope, ...changed })).toThrow("Autonomous account differs");
	});
});
