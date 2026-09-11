import { stripVTControlCharacters } from "node:util";
import { keyText } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getThemeByName } from "../../../coding-agent/src/modes/interactive/theme/theme.ts";
import type { TradingLanguage } from "../state.ts";
import { TradingHeader } from "../tui.ts";

vi.mock("@earendil-works/pi-coding-agent", () => ({ keyText: vi.fn() }));

const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

function renderPlain(header: TradingHeader, width: number): string[] {
	return header.render(width).map((line) => stripVTControlCharacters(line).trimEnd());
}

describe("Ti startup header", () => {
	beforeEach(() => {
		vi.mocked(keyText).mockImplementation((action) => {
			const keys: Record<string, string> = {
				"app.interrupt": "escape",
				"app.clear": "ctrl+c",
				"app.exit": "ctrl+d",
				"app.tools.expand": "ctrl+o",
			};
			return keys[action] ?? action;
		});
	});

	it("shows a drawn Ti wordmark and a compact command row", () => {
		const header = new TradingHeader("0.2.1", () => ({ language: "en-US", theme: plainTheme }));
		const lines = renderPlain(header, 100);
		expect(lines).toHaveLength(5);
		expect(lines[0]).toContain("_______");
		expect(lines[0]).toContain("Ti  v0.2.1");
		expect(lines[1]).toContain("Trading workspace");
		expect(lines[3]).toContain("/settings   /model   /health");
		expect(lines[4]).toContain("escape interrupt");
		expect(lines[4]).toContain("ctrl+o more");
	});

	it("uses a compact wordmark on narrow terminals without losing command hints", () => {
		const header = new TradingHeader("0.2.1", () => ({ language: "en-US", theme: plainTheme }));
		const text = renderPlain(header, 40).join("\n");
		expect(text).not.toContain("_______");
		expect(text).toContain("Ti  v0.2.1");
		for (const command of ["/settings", "/model", "/health"]) expect(text).toContain(command);
		expect(text).toContain("ctrl+o more");
	});

	it("reads current keybindings instead of hardcoding shortcut labels", () => {
		vi.mocked(keyText).mockImplementation((action) => (action === "app.tools.expand" ? "ctrl+g" : "f2"));
		const header = new TradingHeader("0.2.1", () => ({ language: "en-US", theme: plainTheme }));
		const text = renderPlain(header, 100).join("\n");
		expect(text).toContain("ctrl+g more");
		expect(text).toContain("f2 interrupt");
		expect(text).not.toContain("ctrl+o");
	});

	it("preserves expandable startup help and can collapse it again", () => {
		const header = new TradingHeader("0.2.1", () => ({ language: "en-US", theme: plainTheme }));
		const compact = renderPlain(header, 100);
		header.setExpanded(true);
		expect(header.isExpanded()).toBe(true);
		const expanded = renderPlain(header, 100).join("\n");
		expect(expanded).toContain("external editor");
		expect(expanded).toContain("ctrl+c twice exit");
		expect(expanded).toContain("drop files attach files");
		expect(expanded).toContain("ctrl+o expand tools and startup details");
		expect(expanded).not.toContain("run bash");
		header.setExpanded(false);
		expect(header.isExpanded()).toBe(false);
		expect(renderPlain(header, 100)).toEqual(compact);
	});

	it("reads language and theme changes on the next render", () => {
		let language: TradingLanguage = "en-US";
		let theme = getThemeByName("dark");
		if (!theme) throw new Error("Missing dark theme");
		const header = new TradingHeader("0.2.1", () => {
			if (!theme) throw new Error("Missing theme");
			return { language, theme };
		});
		const before = header.render(100).join("\n");
		language = "zh-CN";
		theme = getThemeByName("light");
		header.invalidate();
		const after = header.render(100).join("\n");
		expect(after).not.toEqual(before);
		expect(stripVTControlCharacters(after)).toContain("\u4ea4\u6613\u5de5\u4f5c\u53f0");
		expect(stripVTControlCharacters(after)).not.toContain("Trading workspace");
	});

	it.each(["light", "dark"])("stays within terminal columns using the %s theme", (name) => {
		const theme = getThemeByName(name);
		if (!theme) throw new Error(`Missing theme: ${name}`);
		for (const language of ["en-US", "zh-CN"] as const) {
			const header = new TradingHeader("0.2.1", () => ({ language, theme }));
			for (const expanded of [false, true]) {
				header.setExpanded(expanded);
				for (const width of [1, 2, 20, 40, 63, 64, 80, 140]) {
					for (const line of header.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				}
			}
			expect(header.render(0)).toEqual([]);
		}
	});
});
