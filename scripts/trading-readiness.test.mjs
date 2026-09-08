import assert from "node:assert/strict";
import { test } from "node:test";
import { isolatedReadinessEnvironment, readinessCommands, READINESS_TESTS } from "./trading-readiness.mjs";

test("does not inherit credentials, provider endpoints, home paths or Node startup injection", () => {
	const env = isolatedReadinessEnvironment("/tmp/owned-readiness", {
		PATH: "/usr/bin", HOME: "/real/home", TI_DATA_DIR: "/real/trading", OPENAI_API_KEY: "test-secret",
		AWS_ACCESS_KEY_ID: "test-secret", BINANCE_SECRET: "test-secret", NODE_OPTIONS: "--require unwanted.js",
		OPENAI_BASE_URL: "https://example.invalid", HTTP_PROXY: "https://example.invalid", CI: "true",
	});
	assert.equal(env.PATH, "/usr/bin");
	assert.equal(env.CI, "true");
	assert.equal(env.HOME, "/tmp/owned-readiness/home");
	assert.equal(env.TI_DATA_DIR, "/tmp/owned-readiness/ti");
	assert.equal(env.NPM_CONFIG_UPDATE_NOTIFIER, "false");
	for (const key of ["OPENAI_API_KEY", "AWS_ACCESS_KEY_ID", "BINANCE_SECRET", "NODE_OPTIONS", "OPENAI_BASE_URL", "HTTP_PROXY"]) {
		assert.equal(env[key], undefined);
	}
});

test("runs explicit offline test selectors rather than a full provider/e2e suite", () => {
	const commands = readinessCommands("/repo", "linux");
	assert.deepEqual(commands.map((command) => command.name), ["repository-check", "risk", "engine", "agent", "release-gate"]);
	assert.deepEqual(commands[0].args, ["run", "check"]);
	for (const files of Object.values(READINESS_TESTS)) {
		assert.ok(files.length > 0);
		assert.ok(files.every((file) => file.endsWith(".test.ts") && !file.includes("*") && !file.includes("e2e")));
	}
	for (const command of commands.slice(1, 4)) {
		assert.equal(command.args[1], "--run");
		assert.ok(command.args.length > 2);
	}
	assert.ok(READINESS_TESTS.engine.includes("src/execution-recovery.test.ts"));
	assert.ok(READINESS_TESTS.engine.includes("src/paper-durability.test.ts"));
	assert.ok(READINESS_TESTS.agent.includes("src/__tests__/execution-runtime.test.ts"));
	assert.ok(READINESS_TESTS.agent.includes("src/__tests__/paper-reset-durability.test.ts"));
	assert.ok(READINESS_TESTS.agent.includes("src/__tests__/health.test.ts"));
	assert.ok(READINESS_TESTS.agent.includes("src/__tests__/published-coding-agent-api.test.ts"));
	assert.ok(READINESS_TESTS.agent.includes("src/__tests__/project-trust.test.ts"));
	assert.ok(commands.at(-1).args.includes("scripts/trading-package-install.test.mjs"));
	assert.ok(commands.at(-1).args.includes("scripts/trading-paper-soak.test.mjs"));
});

test("launches the fixed npm command through the Windows interpreter without autorun", () => {
	const command = readinessCommands("/repo", "win32")[0];
	assert.equal(command.command, "cmd.exe");
	assert.deepEqual(command.args, ["/d", "/s", "/c", "npm run check"]);
});
