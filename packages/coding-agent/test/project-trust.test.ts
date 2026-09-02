import { beforeEach, describe, expect, it, vi } from "vitest";

const startupUiMocks = vi.hoisted(() => ({
	showStartupInput: vi.fn(async () => "input"),
	showStartupSelector: vi.fn(async () => "Trust"),
}));

vi.mock("../src/cli/startup-ui.ts", () => startupUiMocks);

import { createProjectTrustContext } from "../src/cli/project-trust.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("createProjectTrustContext", () => {
	beforeEach(() => {
		startupUiMocks.showStartupInput.mockClear();
		startupUiMocks.showStartupSelector.mockClear();
	});

	it("passes the caller's agent directory to startup UI prompts", async () => {
		const settingsManager = SettingsManager.inMemory();
		const agentDir = "/tmp/ti-trader-agent";
		const context = createProjectTrustContext({
			cwd: "/tmp/ti-project",
			mode: "interactive",
			settingsManager,
			hasUI: true,
			agentDir,
		});

		await context.ui.select("Trust project", ["Trust", "Do not trust"]);
		await context.ui.confirm("Trust project", "Execute project extensions?");
		await context.ui.input("Project name", "name");

		expect(startupUiMocks.showStartupSelector).toHaveBeenNthCalledWith(
			1,
			settingsManager,
			"Trust project",
			[
				{ label: "Trust", value: "Trust" },
				{ label: "Do not trust", value: "Do not trust" },
			],
			agentDir,
		);
		expect(startupUiMocks.showStartupSelector).toHaveBeenNthCalledWith(
			2,
			settingsManager,
			"Trust project\nExecute project extensions?",
			[
				{ label: "Yes", value: true },
				{ label: "No", value: false },
			],
			agentDir,
		);
		expect(startupUiMocks.showStartupInput).toHaveBeenCalledWith(settingsManager, "Project name", "name", agentDir);
	});
});
