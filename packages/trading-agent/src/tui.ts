import { keyText, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type MenuKey, t } from "./i18n.ts";
import type { TradingLanguage } from "./state.ts";

const TI_STEM = "    ██     ██";
const TI_LOGO = [" ████████  ██", TI_STEM, TI_STEM, TI_STEM] as const;
const TI_LOGO_WIDTH = visibleWidth(TI_LOGO[0]);
const LOGO_GAP = "   ";
const LOGO_GRAY = "\x1b[38;2;128;128;128m";

function paintGray(text: string): string {
	return `${LOGO_GRAY}${text}\x1b[39m`;
}

const EXPANDED_SHORTCUTS = [
	["app.interrupt", "headerInterrupt"],
	["app.clear", "headerClear"],
	["app.exit", "headerExitEmpty"],
	["app.suspend", "headerSuspend"],
	["tui.editor.deleteToLineEnd", "headerDeleteToEnd"],
	["app.thinking.cycle", "headerCycleThinking"],
	["app.model.cycleForward", "headerNextModel"],
	["app.model.cycleBackward", "headerPreviousModel"],
	["app.model.select", "cmdModel"],
	["app.tools.expand", "headerExpandTools"],
	["app.thinking.toggle", "headerExpandThinking"],
	["app.editor.external", "headerExternalEditor"],
	["app.message.followUp", "headerFollowUp"],
	["app.message.dequeue", "headerDequeue"],
	["app.clipboard.pasteImage", "headerPasteImage"],
] as const satisfies ReadonlyArray<readonly [string, MenuKey]>;

function wrapItems(items: readonly string[], separator: string, width: number): string[] {
	const lines: string[] = [];
	let row = "";
	for (const item of items) {
		const next = row ? row + separator + item : item;
		if (row && visibleWidth(next) > width) {
			lines.push(row);
			row = item;
		} else {
			row = next;
		}
	}
	if (row) lines.push(row);
	return lines;
}

export class TradingHeader implements Component {
	private expanded = false;
	private readonly version: string;
	private readonly getAppearance: () => { language: TradingLanguage; theme: Pick<Theme, "fg" | "bold"> };

	constructor(version: string, getAppearance: () => { language: TradingLanguage; theme: Pick<Theme, "fg" | "bold"> }) {
		this.version = version;
		this.getAppearance = getAppearance;
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}

	isExpanded(): boolean {
		return this.expanded;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (width <= 0) return [];
		const { language, theme } = this.getAppearance();
		const separator = theme.fg("dim", "  ·  ");
		const title =
			theme.bold(theme.fg("accent", "Ti")) +
			theme.fg("muted", `  v${this.version}`) +
			separator +
			theme.fg("muted", t(language, "headerWorkspace"));
		const hint = (key: string, description: string) => `${theme.fg("text", key)} ${theme.fg("muted", description)}`;
		const showLogo = width >= 64;
		const contentWidth = Math.max(1, width - 2 - (showLogo ? TI_LOGO_WIDTH + LOGO_GAP.length : 0));
		const content: string[] = [title];
		if (this.expanded) {
			const clearKey = keyText("app.clear");
			content.push(
				// Pad past the logo rows plus one blank line so the list starts below the mark.
				...new Array<string>(showLogo ? TI_LOGO.length : 1).fill(""),
				...EXPANDED_SHORTCUTS.map(([action, label]) => hint(keyText(action), t(language, label))),
				hint(`${clearKey} ${t(language, "headerTwice")}`, t(language, "headerExit")),
				hint("/", t(language, "headerCommands")),
				hint(t(language, "headerDropFiles"), t(language, "headerAttach")),
			);
		} else {
			content.push(
				...wrapItems(
					[
						hint("/", t(language, "headerCommands")),
						hint(keyText("app.interrupt"), t(language, "headerInterrupt")),
						hint(keyText("app.tools.expand"), t(language, "headerMore")),
					],
					separator,
					contentWidth,
				),
			);
		}
		const lines: string[] = [];
		if (showLogo) {
			for (const [index, row] of TI_LOGO.entries()) {
				const mark = paintGray(row);
				const cell = content[index];
				lines.push(cell ? `${mark}${LOGO_GAP}${cell}` : mark);
			}
			lines.push(...content.slice(TI_LOGO.length));
		} else {
			lines.push(...content);
		}
		return new Text(lines.join("\n"), 1, 0).render(width).map((line) => truncateToWidth(line, width));
	}
}
