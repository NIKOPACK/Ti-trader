import { describe, expect, it } from "vitest";
import { lazyStream } from "../src/api/lazy.ts";
import type { AssistantMessageEvent, Model } from "../src/types.ts";

const model: Model<"faux"> = {
	id: "faux-1",
	name: "Faux",
	api: "faux",
	provider: "faux",
	baseUrl: "http://localhost:0",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1024,
	maxTokens: 128,
};

describe("lazy provider errors", () => {
	it("redacts setup failures before creating the terminal message", async () => {
		const stream = lazyStream(model, async () => {
			throw new Error("module load failed; Authorization: Bearer lazy-secret");
		});
		const events: AssistantMessageEvent[] = [];

		for await (const event of stream) events.push(event);

		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			type: "error",
			error: { stopReason: "error", errorMessage: "module load failed; Authorization: [REDACTED]" },
		});
		expect(JSON.stringify(events)).not.toContain("lazy-secret");
	});
});
