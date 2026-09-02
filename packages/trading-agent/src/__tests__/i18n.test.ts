import { describe, expect, it } from "vitest";
import { MENU_EN, MENU_ZH, PINNED_SLASH_COMMANDS, SLASH_DESCRIPTION_KEYS, t } from "../i18n.ts";

describe("menu i18n", () => {
	it("has a Chinese string for every English key", () => {
		expect(Object.keys(MENU_ZH).sort()).toEqual(Object.keys(MENU_EN).sort());
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
});
