import { afterEach, describe, expect, it, vi } from "vitest";
import {
	assertSafeUrl,
	fetchSource,
	getSearchEndpoint,
	readResponseText,
	webSearch,
} from "../../../extensions/web-search/index.ts";

const MAX_BYTES = 256 * 1024;

describe("web-search extension safety", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.TAVILY_API_KEY;
		delete process.env.TI_WEB_SEARCH_ENDPOINT;
		delete process.env.TI_WEB_SEARCH_ALLOWED_HOSTS;
	});

	it("only accepts allowlisted HTTPS port 443 URLs", () => {
		expect(() => assertSafeUrl("http://binance.com/api")).toThrow();
		expect(() => assertSafeUrl("https://binance.com:8443/api")).toThrow();
		expect(() => assertSafeUrl("https://example.com/api")).toThrow();
		expect(assertSafeUrl("https://binance.com/api").port).toBe("");
	});

	it("allows only Tavily or an explicitly configured public endpoint host", () => {
		expect(getSearchEndpoint().href).toBe("https://api.tavily.com/search");
		process.env.TI_WEB_SEARCH_ENDPOINT = "https://search.example.com/v1/search";
		expect(() => getSearchEndpoint()).toThrow("Web search endpoint host is not allowlisted");
		process.env.TI_WEB_SEARCH_ALLOWED_HOSTS = "search.example.com";
		expect(getSearchEndpoint().href).toBe("https://search.example.com/v1/search");
	});

	it.each([
		"https://localhost/search",
		"https://localhost./search",
		"https://127.0.0.1/search",
		"https://10.0.0.1/search",
		"https://169.254.1.1/search",
		"https://172.16.0.1/search",
		"https://192.168.0.1/search",
		"https://100.64.0.1/search",
		"https://[::1]/search",
		"https://[fc00::1]/search",
		"https://[fe80::1]/search",
		"https://[::ffff:127.0.0.1]/search",
	])("rejects a local or private search endpoint even when allowlisted: %s", (endpoint) => {
		process.env.TI_WEB_SEARCH_ENDPOINT = endpoint;
		process.env.TI_WEB_SEARCH_ALLOWED_HOSTS = new URL(endpoint).hostname;
		expect(() => getSearchEndpoint()).toThrow("Web search endpoint must not use a local or private host");
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

	it("rejects a whitespace-only query before reading credentials", async () => {
		await expect(webSearch({ query: " \t\n " })).rejects.toThrow("Web search query must not be empty");
	});

	it("propagates the caller AbortSignal to web search", async () => {
		process.env.TAVILY_API_KEY = "secret-key";
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
			const signal = init?.signal;
			if (!signal) return Promise.reject(new Error("Missing request signal"));
			return new Promise((_resolve, reject) => {
				const abort = (): void => reject(signal.reason);
				if (signal.aborted) abort();
				else signal.addEventListener("abort", abort, { once: true });
			});
		});
		const controller = new AbortController();
		const promise = webSearch({ query: "BTC" }, controller.signal);
		controller.abort(new Error("caller cancelled search"));
		await expect(promise).rejects.toThrow("caller cancelled search");
		const requestSignal = fetchMock.mock.calls[0]?.[1]?.signal;
		expect(requestSignal).not.toBe(controller.signal);
		expect(requestSignal?.aborted).toBe(true);
	});

	it("preserves AbortError when cancelled while reading the search response body", async () => {
		process.env.TAVILY_API_KEY = "secret-key";
		let markBodyRead: (() => void) | undefined;
		const bodyRead = new Promise<void>((resolve) => {
			markBodyRead = resolve;
		});
		vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
			const signal = init?.signal;
			if (!signal) return Promise.reject(new Error("Missing request signal"));
			let chunksProvided = 0;
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					const abort = (): void => controller.error(signal.reason);
					if (signal.aborted) abort();
					else signal.addEventListener("abort", abort, { once: true });
				},
				pull(controller) {
					if (chunksProvided === 0) {
						chunksProvided++;
						controller.enqueue(new TextEncoder().encode('{"results":'));
						return;
					}
					markBodyRead?.();
				},
			});
			return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "application/json" } }));
		});
		const controller = new AbortController();
		const promise = webSearch({ query: "BTC" }, controller.signal);
		await bodyRead;
		const abortError = new DOMException("caller cancelled search", "AbortError");
		controller.abort(abortError);
		await expect(promise).rejects.toBe(abortError);
	});

	it("reports invalid search response JSON", async () => {
		process.env.TAVILY_API_KEY = "secret-key";
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response("{not-json", { status: 200, headers: { "content-type": "application/json" } }),
		);
		await expect(webSearch({ query: "BTC" })).rejects.toThrow("Invalid web search response JSON");
	});

	it("propagates the caller AbortSignal when fetching a source", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
			const signal = init?.signal;
			if (!signal) return Promise.reject(new Error("Missing request signal"));
			return new Promise((_resolve, reject) => {
				const abort = (): void => reject(signal.reason);
				if (signal.aborted) abort();
				else signal.addEventListener("abort", abort, { once: true });
			});
		});
		const controller = new AbortController();
		const promise = fetchSource("https://binance.com/news", controller.signal);
		controller.abort(new Error("caller cancelled source fetch"));
		await expect(promise).rejects.toThrow("caller cancelled source fetch");
		const requestSignal = fetchMock.mock.calls[0]?.[1]?.signal;
		expect(requestSignal).not.toBe(controller.signal);
		expect(requestSignal?.aborted).toBe(true);
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
