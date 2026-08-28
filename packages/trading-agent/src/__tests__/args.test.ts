import { describe, expect, it } from "vitest";
import { assertSafeUrl } from "../../../../extensions/web-search/index.ts";
import { parseTradingArgs } from "../args.ts";

describe("extension arguments", () => {
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
