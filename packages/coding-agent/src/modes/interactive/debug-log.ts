import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const REDACTED = "[REDACTED]";
const SECRET_SUFFIX =
	"(?:secret[-_ ]?access[-_ ]?key|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|auth[-_ ]?token|bearer[-_ ]?token|client[-_ ]?secret|private[-_ ]?key|token|password|passwd|secret|credentials?)";
const SECRET_NAME = `(?:[a-z0-9]+[-_])*${SECRET_SUFFIX}(?:[-_][a-z0-9]+)*`;

type DebugLine = {
	text: string;
	visibleWidth: number;
};

type DebugLogInput = {
	timestamp: Date;
	width: number;
	height: number;
	renderedLines: readonly DebugLine[];
	messages: readonly unknown[];
};

type MessageSummary = {
	index: number;
	role: string;
	contentTypes: string[];
	blocks: number;
	characters: number;
	toolNames?: string[];
	status?: string;
	isError?: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function safeLabel(value: unknown, fallback: string): string {
	return typeof value === "string" ? redactDebugText(value).slice(0, 128) : fallback;
}

function characterCount(value: unknown): number {
	if (typeof value === "string") return value.length;
	if (Array.isArray(value)) return value.reduce<number>((total, item) => total + characterCount(item), 0);

	const record = asRecord(value);
	return record ? Object.values(record).reduce<number>((total, item) => total + characterCount(item), 0) : 0;
}

function summarizeMessage(message: unknown, index: number): MessageSummary {
	const record = asRecord(message);
	const content = record?.content;
	const blocks = Array.isArray(content) ? content : content === undefined ? [] : [content];
	const contentTypes = blocks.map((block) => {
		if (typeof block === "string") return "text";
		return safeLabel(asRecord(block)?.type, typeof block);
	});
	const toolNames = blocks
		.map((block) => asRecord(block))
		.filter((block) => block?.type === "toolCall")
		.map((block) => safeLabel(block?.name, "unknown"));
	const directToolName = record?.toolName;
	if (typeof directToolName === "string") toolNames.push(safeLabel(directToolName, "unknown"));

	const summary: MessageSummary = {
		index,
		role: safeLabel(record?.role ?? record?.type, "unknown"),
		contentTypes,
		blocks: blocks.length,
		characters: characterCount(content),
	};
	if (toolNames.length > 0) summary.toolNames = [...new Set(toolNames)];
	if (typeof record?.stopReason === "string") summary.status = safeLabel(record.stopReason, "unknown");
	if (typeof record?.isError === "boolean") summary.isError = record.isError;
	return summary;
}

export function redactDebugText(text: string): string {
	return text
		.replace(new RegExp(`(["']${SECRET_NAME}["']\\s*:\\s*)(["'])(.*?)\\2`, "gi"), `$1$2${REDACTED}$2`)
		.replace(new RegExp(`(\\b${SECRET_NAME}\\b\\s*[:=]\\s*)([^\\s,;&}\\]]+)`, "gi"), `$1${REDACTED}`)
		.replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;&]+/gi, `$1${REDACTED}`)
		.replace(/(bearer\s+)[a-z0-9._~+\-/]+=*/gi, `$1${REDACTED}`)
		.replace(new RegExp(`([?&]${SECRET_NAME}=)[^&#\\s]+`, "gi"), `$1${REDACTED}`)
		.replace(
			new RegExp(`(--${SECRET_NAME.replaceAll("[-_ ]?", "[-_]?")}\\s+)(?:["'][^"']*["']|\\S+)`, "gi"),
			`$1${REDACTED}`,
		);
}

export function formatDebugLog(input: DebugLogInput): string {
	return [
		`Debug output at ${input.timestamp.toISOString()}`,
		`Terminal: ${input.width}x${input.height}`,
		`Total lines: ${input.renderedLines.length}`,
		"",
		"=== Rendered lines (redacted; may still contain user content) ===",
		...input.renderedLines.map(
			(line, index) => `[${index}] (w=${line.visibleWidth}) ${JSON.stringify(redactDebugText(line.text))}`,
		),
		"",
		"=== Agent message metadata (content omitted) ===",
		...input.messages.map((message, index) => JSON.stringify(summarizeMessage(message, index))),
		"",
	].join("\n");
}

export function writePrivateDebugLog(filePath: string, data: string): void {
	mkdirSync(dirname(filePath), { recursive: true });
	const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;

	try {
		writeFileSync(temporaryPath, data, { encoding: "utf-8", flag: "wx", mode: 0o600 });
		chmodSync(temporaryPath, 0o600);
		renameSync(temporaryPath, filePath);
	} finally {
		rmSync(temporaryPath, { force: true });
	}
}
