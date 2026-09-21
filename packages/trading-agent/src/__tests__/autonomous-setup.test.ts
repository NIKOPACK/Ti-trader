import { type ExtensionCommandContext, initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { validateAccountRiskLimits } from "@nikopack/ti-trading-engine";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type AutonomousConfig, validateAutonomousConfig } from "../autonomous/config.ts";
import {
	AUTONOMOUS_TIMING_DEFAULTS,
	type AutonomousSetupAnswers,
	autonomousModelCandidates,
	buildAutonomousConfig,
	DEFAULT_AUTONOMOUS_OBJECTIVE,
	suggestedAccountRiskLimits,
} from "../autonomous/setup.ts";
import { AutonomousSetupPanel } from "../autonomous/setup-panel.ts";
import { t } from "../i18n.ts";
import { DEFAULT_CONFIG, type TradingConfig } from "../state.ts";

type TestModel = NonNullable<ExtensionCommandContext["model"]>;

const model = (provider: string, id: string): TestModel => ({ provider, id }) as unknown as TestModel;

function context(options: {
	model?: TestModel;
	scoped?: TestModel[];
	available?: TestModel[];
	all?: TestModel[];
	authenticated?: string[];
}): ExtensionCommandContext {
	const catalogue = options.all ?? options.available ?? options.scoped ?? [];
	const available = options.available ?? options.scoped ?? [];
	const authenticated = new Set(options.authenticated ?? catalogue.map((entry) => entry.provider));
	const modelRegistry = {
		find: (provider: string, id: string) => catalogue.find((entry) => entry.provider === provider && entry.id === id),
		hasConfiguredAuth: (entry: TestModel) => authenticated.has(entry.provider),
		getAvailable: () => available,
		getAll: () => catalogue,
	};
	return {
		model: options.model,
		scopedModels: (options.scoped ?? []).map((entry) => ({ model: entry })),
		modelRegistry,
	} as unknown as ExtensionCommandContext;
}

function answers(overrides: Partial<Parameters<typeof buildAutonomousConfig>[1]> = {}) {
	return {
		model: { provider: "openai", model: "gpt-test", label: "openai/gpt-test" },
		objective: "  manage this account  ",
		accountLimits: suggestedAccountRiskLimits(DEFAULT_CONFIG),
		unattendedConfirmed: true,
		...overrides,
	};
}

describe("suggestedAccountRiskLimits", () => {
	it("scales the paper preset from startQuote and passes validation", () => {
		const limits = suggestedAccountRiskLimits(DEFAULT_CONFIG);
		expect(limits.maxGrossExposure).toBe(1000);
		expect(limits.maxNetExposure).toBe(800);
		expect(limits.maxAssetExposure).toBe(400);
		expect(limits.maxDailyLoss).toBe(100);
		expect(limits.maxDrawdown).toBe(200);
		expect(limits.maxLeverage).toBe(1);
		expect(() => validateAccountRiskLimits(limits)).not.toThrow();
	});

	it("stays valid on tiny paper accounts", () => {
		const tiny: TradingConfig = {
			...DEFAULT_CONFIG,
			paper: { ...DEFAULT_CONFIG.paper, startQuote: 3 },
		};
		const limits = suggestedAccountRiskLimits(tiny);
		expect(limits.maxGrossExposure).toBeGreaterThan(0);
		expect(() => validateAccountRiskLimits(limits)).not.toThrow();
	});
});

describe("buildAutonomousConfig", () => {
	it("derives scope from the trading config and validates", () => {
		const trading: TradingConfig = {
			...DEFAULT_CONFIG,
			exchange: "binance",
			quoteCurrency: "USDC",
		};
		const config = buildAutonomousConfig(trading, answers(), undefined);
		expect(config).toMatchObject({
			enabled: true,
			mode: trading.mode,
			exchange: "binance",
			marketType: trading.marketType,
			quoteCurrency: "USDC",
			objective: "manage this account",
			provider: "openai",
			model: "gpt-test",
			...AUTONOMOUS_TIMING_DEFAULTS,
			services: ["market-lab"],
		});
		expect(() => validateAutonomousConfig(config)).not.toThrow();
	});

	it("preserves operator-tuned timings and services on reconfigure", () => {
		const existing: AutonomousConfig = {
			enabled: true,
			mode: "paper",
			exchange: "okx",
			marketType: "spot",
			quoteCurrency: "USDT",
			objective: "old",
			provider: "old",
			model: "old",
			pollIntervalMs: 9000,
			modelTimeoutMs: 60000,
			serviceTimeoutMs: 5000,
			maxAttempts: 5,
			retryBaseMs: 1000,
			retryMaxMs: 10000,
			protectionAttempts: 2,
			services: ["market-lab", "web-search"],
		};
		const config = buildAutonomousConfig(DEFAULT_CONFIG, answers(), existing);
		expect(config.pollIntervalMs).toBe(9000);
		expect(config.maxAttempts).toBe(5);
		expect(config.services).toEqual(["market-lab", "web-search"]);
		expect(config.objective).toBe("manage this account");
		expect(() => validateAutonomousConfig(config)).not.toThrow();
	});
});

describe("autonomousModelCandidates", () => {
	it("leads with the current session model and dedupes the scope", () => {
		const session = model("openai", "gpt-a");
		const ctx = context({
			model: session,
			scoped: [session, model("anthropic", "claude-a")],
		});
		const candidates = autonomousModelCandidates(ctx, undefined);
		expect(candidates.map((entry) => entry.label)).toEqual(["openai/gpt-a", "anthropic/claude-a"]);
	});

	it("excludes providers without configured auth and models the registry cannot resolve", () => {
		const ctx = context({
			scoped: [model("openai", "gpt-a")],
			available: [model("openai", "gpt-a"), model("gemini", "g-a")],
			all: [model("openai", "gpt-a"), model("gemini", "g-a"), model("ghost", "unlisted")],
			authenticated: ["openai"],
		});
		// "gemini" is in the catalogue but unauthenticated; "ghost" is unauthenticated too.
		const candidates = autonomousModelCandidates(ctx, {
			...buildAutonomousConfig(DEFAULT_CONFIG, answers(), undefined),
			provider: "ghost",
			model: "unlisted",
		});
		expect(candidates.map((entry) => entry.label)).toEqual(["openai/gpt-a"]);
	});

	it("appends the configured model when it is outside the session scope", () => {
		const ctx = context({
			scoped: [model("openai", "gpt-a")],
			all: [model("openai", "gpt-a"), model("anthropic", "claude-b")],
		});
		const existing = {
			...buildAutonomousConfig(DEFAULT_CONFIG, answers(), undefined),
			provider: "anthropic",
			model: "claude-b",
		};
		const candidates = autonomousModelCandidates(ctx, existing);
		expect(candidates.map((entry) => entry.label)).toEqual(["openai/gpt-a", "anthropic/claude-b"]);
	});

	it("falls back to the full catalogue when session scoping yields nothing authenticated", () => {
		const ctx = context({
			model: model("unauthed", "m"),
			available: [],
			all: [model("unauthed", "m"), model("openai", "gpt-a")],
			authenticated: ["openai"],
		});
		const candidates = autonomousModelCandidates(ctx, undefined);
		expect(candidates.map((entry) => entry.label)).toEqual(["openai/gpt-a"]);
	});

	it("returns empty when nothing is authenticated", () => {
		const ctx = context({ all: [model("unauthed", "m")], authenticated: [] });
		expect(autonomousModelCandidates(ctx, undefined)).toEqual([]);
	});
});

describe("DEFAULT_AUTONOMOUS_OBJECTIVE", () => {
	it("is a non-empty standing instruction", () => {
		expect(DEFAULT_AUTONOMOUS_OBJECTIVE.trim().length).toBeGreaterThan(0);
	});
});

describe("AutonomousSetupPanel", () => {
	const down = "\x1b[B";
	const up = "\x1b[A";
	const enter = "\r";
	const esc = "\x1b";

	function panelFixture(overrides: { models?: ReturnType<typeof autonomousModelCandidates> } = {}) {
		const ctx = { ui: { notify: vi.fn() } } as unknown as ExtensionCommandContext;
		const theme = {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		} as unknown as Theme;
		const done = vi.fn<(answers?: AutonomousSetupAnswers) => void>();
		const panel = new AutonomousSetupPanel(theme, ctx, done, {
			language: "en-US",
			models: overrides.models ?? [{ provider: "openai", model: "gpt-test", label: "openai/gpt-test" }],
			modelIndex: 0,
			objective: DEFAULT_AUTONOMOUS_OBJECTIVE,
			accountLimits: suggestedAccountRiskLimits(DEFAULT_CONFIG),
			unattended: false,
			accountLine: "Paper  okx  Spot  USDT",
			runtimeLine: "poll 5s",
		});
		return { ctx, done, panel };
	}

	beforeEach(() => {
		initTheme("dark", false);
	});

	it("renders the title, account and decision rows", () => {
		const { panel } = panelFixture();
		const text = panel.render(100).join("\n");
		expect(text).toContain(t("en-US", "autonomousSetupTitle"));
		expect(text).toContain("Paper  okx  Spot  USDT");
		expect(text).toContain("openai/gpt-test");
		expect(text).toContain(t("en-US", "autonomousSetupApproval"));
		expect(text).toContain(t("en-US", "autonomousSetupCreate"));
	});

	it("resolves undefined on escape", () => {
		const { done, panel } = panelFixture();
		panel.handleInput(esc);
		expect(done).toHaveBeenCalledExactlyOnceWith();
	});

	it("refuses to create the configuration before unattended approval is confirmed", () => {
		const { ctx, done, panel } = panelFixture();
		for (let index = 0; index < 6; index++) panel.handleInput(down);
		panel.handleInput(enter);
		expect(done).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(t("en-US", "autonomousSetupApprovalRequired"), "warning");
	});

	it("collects model, objective, limits and confirmation on create", () => {
		const { done, panel } = panelFixture();
		for (let index = 0; index < 5; index++) panel.handleInput(down);
		panel.handleInput(enter);
		// The approval submenu preselects "keep per-order confirmation"; move to "allow".
		panel.handleInput(up);
		panel.handleInput(enter);
		panel.handleInput(down);
		panel.handleInput(enter);
		expect(done).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				model: { provider: "openai", model: "gpt-test", label: "openai/gpt-test" },
				objective: DEFAULT_AUTONOMOUS_OBJECTIVE,
				unattendedConfirmed: true,
			}),
		);
		const answers = done.mock.calls[0][0] as AutonomousSetupAnswers;
		expect(() => validateAccountRiskLimits(answers.accountLimits)).not.toThrow();
	});
});
