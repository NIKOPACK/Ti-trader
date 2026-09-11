import { keyText, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type MenuKey, t } from "./i18n.ts";
import type { TradingLanguage } from "./state.ts";

const TI_LOGO = [" _______  _ ", "|__   __|(_)", "   | |   | |", "   |_|   |_|"];

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
		const separator = "   ";
		const title = theme.bold(theme.fg("accent", "Ti")) + theme.fg("muted", `  v${this.version}`);
		const commands = ["/settings", "/model", "/health"].map((command) => theme.fg("text", command)).join(separator);
		const details = [title, theme.fg("muted", t(language, "headerWorkspace")), "", commands];
		const lines =
			width >= 64
				? TI_LOGO.map((line, index) => `${theme.fg("accent", line)}   ${details[index]}`)
				: [title, theme.fg("muted", t(language, "headerWorkspace")), commands];
		const hint = (key: string, description: string) => `${theme.fg("text", key)} ${theme.fg("muted", description)}`;
		const clearKey = keyText("app.clear");
		if (this.expanded) {
			lines.push(
				"",
				...EXPANDED_SHORTCUTS.map(([action, label]) => hint(keyText(action), t(language, label))),
				hint(`${clearKey} ${t(language, "headerTwice")}`, t(language, "headerExit")),
				hint("/", t(language, "headerCommands")),
				hint(t(language, "headerDropFiles"), t(language, "headerAttach")),
			);
		} else {
			const hints = [
				hint("/", t(language, "headerCommands")),
				hint(keyText("app.interrupt"), t(language, "headerInterrupt")),
				hint(`${clearKey}/${keyText("app.exit")}`, t(language, "headerClearExit")),
				hint(keyText("app.tools.expand"), t(language, "headerMore")),
			];
			let row = "";
			for (const item of hints) {
				if (row && visibleWidth(row + separator + item) > width - 2) {
					lines.push(row);
					row = item;
				} else {
					row = row ? row + separator + item : item;
				}
			}
			lines.push(row);
		}
		return new Text(lines.join("\n"), 1, 0).render(width).map((line) => truncateToWidth(line, width));
	}
}
