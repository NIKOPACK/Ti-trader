import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { MENU_EN, PINNED_SLASH_COMMANDS } from "../i18n.ts";
import { pinSlashSuggestions } from "../slash-autocomplete.ts";

function item(value: string, description = `${value} desc`): AutocompleteItem {
	return { value, label: `/${value}`, description };
}

describe("pinSlashSuggestions", () => {
	it("keeps the pinned order when the prefix is empty", () => {
		const items = [item("quit"), item("balance"), item("hotkeys"), item("settings"), item("model"), item("language")];
		expect(pinSlashSuggestions(items, "").map((entry) => entry.value)).toEqual(
			PINNED_SLASH_COMMANDS.filter((name) => items.some((entry) => entry.value === name)),
		);
	});

	it("localizes known descriptions without dropping unpinned matches when typing", () => {
		const items = [item("settings", "Open settings menu"), item("session", "Show session info")];
		const result = pinSlashSuggestions(items, "s");
		expect(result.map((entry) => entry.value)).toEqual(["settings", "session"]);
		expect(result[0]?.description).toBe(MENU_EN.cmdSettings);
		expect(result[1]?.description).toBe("Show session info");
	});
});
