import { describe, expect, it, vi } from "vitest";
import { assertSafeUrl } from "../../../../extensions/web-search/index.ts";
import { parseTradingArgs, printHelp } from "../args.ts";

describe("extension arguments", () => {
	it("documents recovery, health and persistent monitoring in CLI help", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			printHelp();
			const help = log.mock.calls[0]?.[0];
			expect(help).toContain("/recovery");
			expect(help).toContain("/audit");
			expect(help).toContain("/health");
			expect(help).toContain("Persistent experimental monitor");
			expect(help).not.toContain("in-memory monitor");
		} finally {
			log.mockRestore();
		}
	});

	it("accepts repeatable extension paths", () => {
		expect(parseTradingArgs(["--extension", "a.ts", "--extension=b.ts"]).extensions).toEqual(["a.ts", "b.ts"]);
	});

	it("requires an extension path", () => {
		expect(() => parseTradingArgs(["--extension"])).toThrow("--extension requires a path");
	});

	it("rejects unsafe web source URLs", () => {
		expect(() => assertSafeUrl("http://binance.com/a")).toThrow("Only HTTPS URLs are allowed");
		expect(() => assertSafeUrl("https://example.com/a")).toThrow("URL host is not allowlisted");
		expect(() => assertSafeUrl("https://user:pass@binance.com/a")).toThrow("URL credentials are not allowed");
	});
});
