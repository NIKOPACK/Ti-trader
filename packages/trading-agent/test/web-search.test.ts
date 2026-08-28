import { afterEach, describe, expect, it, vi } from "vitest";
import { assertSafeUrl, readResponseText, webSearch } from "../../../extensions/web-search/index.ts";

const MAX_BYTES = 256 * 1024;

describe("web-search extension safety", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.TAVILY_API_KEY;
		delete process.env.TI_WEB_SEARCH_ENDPOINT;
	});

	it("only accepts allowlisted HTTPS port 443 URLs", () => {
		expect(() => assertSafeUrl("http://binance.com/api")).toThrow();
		expect(() => assertSafeUrl("https://binance.com:8443/api")).toThrow();
		expect(() => assertSafeUrl("https://example.com/api")).toThrow();
		expect(assertSafeUrl("https://binance.com/api").port).toBe("");
	});

	it("enforces the response limit while reading chunks", async () => {
		let chunksProvided = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				chunksProvided++;
				if (chunksProvided === 1) controller.enqueue(new Uint8Array(MAX_BYTES));
				else if (chunksProvided === 2) controller.enqueue(new Uint8Array(1));
				else controller.close();
			},
		});
		await expect(readResponseText(new Response(body))).rejects.toThrow("Response is too large");
		expect(chunksProvided).toBeGreaterThanOrEqual(2);
	});

	it("searches Tavily and returns structured untrusted results without exposing the key", async () => {
		process.env.TAVILY_API_KEY = "secret-key";
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					results: [
						{
							title: "BTC news",
							url: "https://binance.com/news",
							content: "A snippet",
							published_date: "2026-08-27",
						},
					],
				}),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			),
		);
		const result = await webSearch({ query: "BTC", maxResults: 3, domains: ["binance.com"], recencyDays: 7 });
		expect(result.provider).toBe("tavily");
		expect(result.results[0]).toEqual({
			title: "BTC news",
			url: "https://binance.com/news",
			snippet: "A snippet",
			publishedAt: "2026-08-27",
			source: "tavily",
		});
		expect(JSON.stringify(result)).not.toContain("secret-key");
		expect(fetchMock.mock.calls[0]?.[1]?.body).toContain('"api_key":"secret-key"');
	});

	it("rejects search when the API key is missing", async () => {
		await expect(webSearch({ query: "BTC" })).rejects.toThrow("TAVILY_API_KEY is not configured");
	});

	it("rejects malformed provider responses and provider errors", async () => {
		process.env.TAVILY_API_KEY = "secret-key";
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
		);
		await expect(webSearch({ query: "BTC" })).rejects.toThrow("Invalid web search response");
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response("failure", { status: 429, headers: { "content-type": "application/json" } }),
		);
		await expect(webSearch({ query: "BTC" })).rejects.toThrow("HTTP 429");
	});
});
