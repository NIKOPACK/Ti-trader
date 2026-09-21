import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { MENU_EN, PINNED_SLASH_COMMANDS } from "../i18n.ts";
import { pinSlashSuggestions } from "../slash-autocomplete.ts";

function item(value: string, description = `${value} desc`): AutocompleteItem {
	return { value, label: `/${value}`, description };
}

describe("pinSlashSuggestions", () => {
	it("makes plans and decision evidence discoverable without hiding existing commands", () => {
		const result = pinSlashSuggestions(
			[item("orders"), item("decisions"), item("plan"), item("settings"), item("autonomous")],
			"",
		);
		expect(result.map((entry) => entry.value)).toEqual(["settings", "plan", "decisions", "autonomous", "orders"]);
		expect(result[1]?.description).toBe(MENU_EN.cmdPlan);
		expect(result[2]?.description).toBe(MENU_EN.cmdDecisions);
	});

	it("pins and localizes the autonomous command", () => {
		const result = pinSlashSuggestions([item("autonomous", "fallback"), item("settings")], "");
		expect(result.map((entry) => entry.value)).toEqual(["settings", "autonomous"]);
		expect(result[1]?.description).toBe(MENU_EN.cmdAutonomous);
	});

	it("keeps the pinned order when the prefix is empty", () => {
		const items = [item("quit"), item("copy"), item("hotkeys"), item("settings"), item("model"), item("language")];
		expect(pinSlashSuggestions(items, "").map((entry) => entry.value)).toEqual([
			...PINNED_SLASH_COMMANDS.filter((name) => items.some((entry) => entry.value === name)),
			"copy",
			"hotkeys",
			"language",
		]);
	});

	it("retains lab, monitor and extension commands without duplicating or changing the input", () => {
		const items = [item("lab"), item("settings"), item("monitor"), item("custom-extension")];
		const original = structuredClone(items);
		expect(pinSlashSuggestions(items, "").map((entry) => entry.value)).toEqual([
			"settings",
			"lab",
			"monitor",
			"custom-extension",
		]);
		expect(items).toEqual(original);
	});

	it("localizes known descriptions without dropping unpinned matches when typing", () => {
		const items = [item("settings", "Open settings menu"), item("session", "Show session info")];
		const result = pinSlashSuggestions(items, "s");
		expect(result.map((entry) => entry.value)).toEqual(["settings", "session"]);
		expect(result[0]?.description).toBe(MENU_EN.cmdSettings);
		expect(result[1]?.description).toBe(MENU_EN.cmdSession);
	});
});
