import { describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import { AssistantMessageEventStream, EventStream } from "../src/utils/event-stream.ts";

describe("AssistantMessageEventStream", () => {
	it("rejects result when the source ends without a terminal event", async () => {
		const stream = new AssistantMessageEventStream();
		stream.push({ type: "start", partial: fauxAssistantMessage("") });
		stream.end();

		await expect(stream.result()).rejects.toThrow("ended before a final result");
	});

	it("allows iteration to finish when no final result is requested", async () => {
		const stream = new AssistantMessageEventStream();
		stream.end();

		const events = [];
		for await (const event of stream) events.push(event);
		expect(events).toEqual([]);
	});

	it("rejects result when extracting a terminal event fails", async () => {
		const stream = new EventStream<{ done: true }, string>(
			() => true,
			() => {
				throw new Error("malformed terminal event");
			},
		);

		expect(() => stream.push({ done: true })).toThrow("malformed terminal event");
		await expect(stream.result()).rejects.toThrow("malformed terminal event");
	});
});
