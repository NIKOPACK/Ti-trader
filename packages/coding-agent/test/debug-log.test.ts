import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatDebugLog, redactDebugText, writePrivateDebugLog } from "../src/modes/interactive/debug-log.ts";

describe("debug log", () => {
	it("redacts common credential forms", () => {
		const input = [
			"Authorization: Bearer header-secret",
			"Bearer standalone-secret",
			'"apiKey": "json-secret"',
			"password=env-secret",
			"https://example.test?a=1&access_token=query-secret",
			"--client-secret cli-secret",
			"OPENAI_API_KEY=openai-env-secret",
			"ANTHROPIC_AUTH_TOKEN=anthropic-env-secret",
			'"OPENAI_API_KEY": "openai-json-secret"',
			'"AWS_SECRET_ACCESS_KEY": "aws-json-secret"',
			"AWS_BEARER_TOKEN_BEDROCK=bedrock-env-secret",
		].join("\n");

		const redacted = redactDebugText(input);

		for (const secret of [
			"header-secret",
			"standalone-secret",
			"json-secret",
			"env-secret",
			"query-secret",
			"cli-secret",
			"openai-env-secret",
			"anthropic-env-secret",
			"openai-json-secret",
			"aws-json-secret",
			"bedrock-env-secret",
		]) {
			expect(redacted).not.toContain(secret);
		}
		expect(redacted.match(/\[REDACTED\]/g)).toHaveLength(11);
	});

	it("omits message content and tool arguments", () => {
		const log = formatDebugLog({
			timestamp: new Date("2026-09-18T00:00:00.000Z"),
			width: 120,
			height: 40,
			renderedLines: [{ text: "token=screen-secret", visibleWidth: 19 }],
			messages: [
				{ role: "user", content: "private prompt" },
				{
					role: "assistant",
					content: [
						{ type: "text", text: "private answer" },
						{ type: "toolCall", name: "read", arguments: { apiKey: "tool-secret", path: "/private" } },
					],
					stopReason: "toolUse",
				},
				{
					role: "toolResult",
					toolName: "read",
					isError: false,
					content: [{ type: "text", text: "private result" }],
				},
			],
		});

		for (const secret of [
			"screen-secret",
			"private prompt",
			"private answer",
			"tool-secret",
			"/private",
			"private result",
		]) {
			expect(log).not.toContain(secret);
		}
		expect(log).toContain('"role":"assistant"');
		expect(log).toContain('"contentTypes":["text","toolCall"]');
		expect(log).toContain('"toolNames":["read"]');
		expect(log).toContain('"isError":false');
	});

	it("atomically replaces the log with private permissions", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-debug-log-"));
		const filePath = join(directory, "debug.log");
		writeFileSync(filePath, "old");
		chmodSync(filePath, 0o644);

		writePrivateDebugLog(filePath, "new");

		expect(readFileSync(filePath, "utf-8")).toBe("new");
		expect(statSync(filePath).mode & 0o777).toBe(0o600);
	});
});
