import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

const stateMocks = vi.hoisted(() => ({
	loadExchangeKeys: vi.fn(() => ({})),
	saveExchangeKeys: vi.fn(),
}));

vi.mock("../state.ts", () => stateMocks);

import { loginExchange } from "../settings-menu.ts";

describe("loginExchange", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("masks every exchange credential input", async () => {
		const input = vi
			.fn<NonNullable<ExtensionCommandContext["ui"]>["input"]>()
			.mockResolvedValueOnce("api-key")
			.mockResolvedValueOnce("api-secret")
			.mockResolvedValueOnce("passphrase");
		const notify = vi.fn();
		const ctx = { ui: { input, notify } } as unknown as ExtensionCommandContext;

		await loginExchange("binance", ctx);

		for (const call of input.mock.calls) {
			expect(call[2]).toEqual({ secret: true });
		}
		expect(stateMocks.saveExchangeKeys).toHaveBeenCalledWith({
			binance: { apiKey: "api-key", secret: "api-secret", password: "passphrase" },
		});
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Keys for binance saved"), "info");
	});
});
