import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { resolveBundledMarketLabExtension } from "../bundled-extensions.ts";

describe("bundled market-lab extension", () => {
	let tempDir: string | undefined;

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

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
				expect.arrayContaining([
					"calculate_indicators",
					"analyze_market_structure",
					"generate_trade_signal",
					"evaluate_strategy",
					"screen_markets",
					"simulate_rule",
				]),
			);
			const commands = services.resourceLoader
				.getExtensions()
				.extensions.flatMap((extension) => [...(extension.commands?.keys() ?? [])]);
			expect(commands).toEqual(expect.arrayContaining(["indicators", "signal", "screen", "replay"]));
		} finally {
			session.dispose();
		}
	});
});
