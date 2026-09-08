import { describe, expect, it } from "vitest";
import { localizeDescription, MENU_EN, MENU_ZH, PINNED_SLASH_COMMANDS, SLASH_DESCRIPTION_KEYS, t } from "../i18n.ts";

describe("menu i18n", () => {
	it("has a Chinese string for every English key", () => {
		expect(Object.keys(MENU_ZH).sort()).toEqual(Object.keys(MENU_EN).sort());
	});

	it("uses the same placeholders in every locale", () => {
		const placeholders = (value: string) =>
			[...value.matchAll(/\{([A-Za-z0-9_-]+)\}/g)].map((match) => match[1]).sort();
		for (const key of Object.keys(MENU_EN) as Array<keyof typeof MENU_EN>) {
			expect(placeholders(MENU_ZH[key]), key).toEqual(placeholders(MENU_EN[key]));
		}
	});

	it("returns the requested language", () => {
		expect(t("en-US", "settingsTitle")).toBe("Settings");
		expect(t("zh-CN", "settingsTitle")).toBe("设置");
	});

	it("maps pinned slash commands to description keys", () => {
		for (const name of PINNED_SLASH_COMMANDS) {
			expect(SLASH_DESCRIPTION_KEYS[name]).toBeDefined();
		}
	});

	it("covers host, trading, and bundled extension commands", () => {
		const commands = [
			"settings",
			"tui-settings",
			"model",
			"tree",
			"thinking",
			"scoped-models",
			"export",
			"import",
			"share",
			"copy",
			"name",
			"session",
			"changelog",
			"hotkeys",
			"fork",
			"clone",
			"trust",
			"login",
			"logout",
			"new",
			"compact",
			"resume",
			"reload",
			"quit",
			"language",
			"balance",
			"positions",
			"orders",
			"trades",
			"markets",
			"mode",
			"exchange",
			"market",
			"risk",
			"recovery",
			"audit",
			"health",
			"paper",
			"monitor",
			"exchange-login",
			"indicators",
			"signal",
			"screen",
			"replay",
			"trigger",
			"zhihu",
			"zhihu-login",
		];
		for (const name of commands) expect(SLASH_DESCRIPTION_KEYS[name], name).toBeDefined();
	});

	it("localizes host settings descriptions while preserving fallback text", () => {
		expect(localizeDescription("zh-CN", "settings.auto-compact", "fallback")).toBe("上下文过大时自动压缩");
		expect(localizeDescription("zh-CN", "settings.unknown", "fallback")).toBe("fallback");
		expect(localizeDescription("zh-CN", "settings.model-thinking.clear", "fallback", { thinkingLevel: "off" })).toBe(
			"恢复为全局默认值（off）",
		);
	});
});
