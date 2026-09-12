import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { getTrading } from "./context.ts";
import { PINNED_SLASH_COMMANDS, SLASH_DESCRIPTION_KEYS, t } from "./i18n.ts";
import type { TradingLanguage } from "./state.ts";

export { PINNED_SLASH_COMMANDS };

export function currentMenuLanguage(): TradingLanguage {
	try {
		return getTrading().config.language;
	} catch {
		return "en-US";
	}
}

export function localizeSlashItem(
	item: AutocompleteItem,
	language: TradingLanguage = currentMenuLanguage(),
): AutocompleteItem {
	const key = SLASH_DESCRIPTION_KEYS[item.value];
	if (!key) return item;
	return { ...item, description: t(language, key) };
}

export function pinSlashSuggestions(items: AutocompleteItem[], prefix: string): AutocompleteItem[] {
	const language = currentMenuLanguage();
	if (prefix.length > 0) return items.map((item) => localizeSlashItem(item, language));
	const byValue = new Map(items.map((item) => [item.value, item]));
	const pinned = PINNED_SLASH_COMMANDS.map((name) => byValue.get(name)).filter(
		(item): item is AutocompleteItem => item !== undefined,
	);
	const pinnedValues = new Set(pinned.map((item) => item.value));
	return [...pinned, ...items.filter((item) => !pinnedValues.has(item.value))].map((item) =>
		localizeSlashItem(item, language),
	);
}

function isSlashCommandNameQuery(
	lines: string[],
	cursorLine: number,
	cursorCol: number,
): { prefix: string } | undefined {
	const currentLine = lines[cursorLine] ?? "";
	const textBeforeCursor = currentLine.slice(0, cursorCol);
	if (!textBeforeCursor.startsWith("/") || textBeforeCursor.includes(" ")) return undefined;
	return { prefix: textBeforeCursor.slice(1) };
}

export function wrapTradingAutocomplete(inner: AutocompleteProvider): AutocompleteProvider {
	const wrapped: AutocompleteProvider = {
		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const result = await inner.getSuggestions(lines, cursorLine, cursorCol, options);
			if (!result) return null;
			const query = isSlashCommandNameQuery(lines, cursorLine, cursorCol);
			if (!query) return result;
			const items = pinSlashSuggestions(result.items, query.prefix);
			return items.length > 0 ? { ...result, items } : result;
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return inner.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},
	};
	if (inner.shouldTriggerFileCompletion) {
		wrapped.shouldTriggerFileCompletion = (lines, cursorLine, cursorCol) =>
			inner.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? false;
	}
	if (inner.triggerCharacters) wrapped.triggerCharacters = inner.triggerCharacters;
	return wrapped;
}
