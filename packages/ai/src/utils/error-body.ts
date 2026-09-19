// Shared normalization for provider HTTP error objects.
//
// Endpoints behind a proxy / gateway may return a non-2xx response whose body
// the provider SDK cannot fold into `error.message`. The SDK error object still
// carries the HTTP status and the raw/parsed body, but under SDK-specific field
// names. Provider catch blocks that read only `error.message` therefore drop
// the body and surface opaque messages like `"403 status code (no body)"` or
// collapse to `"Unknown: UnknownError"`.
//
// `normalizeProviderError` probes the known SDK field shapes (Mistral,
// `openai`, `@google/genai`, AWS Bedrock) and returns a struct each provider
// composes into its display string. The `messageCarriesBody` flag captures the
// Anthropic / `@google/genai` happy path where the SDK already folded the body
// into the message, so providers can preserve it without double-printing.

export const MAX_PROVIDER_ERROR_BODY_CHARS = 4000;
const REDACTED = "[REDACTED]";
const SECRET_FIELD =
	"(?:authorization|proxy[-_ ]?authorization|x[-_ ]?api[-_ ]?key|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|auth[-_ ]?token|token|password|passwd|secret[-_ ]?access[-_ ]?key|secret|client[-_ ]?secret|private[-_ ]?key|credentials?|cookie|set[-_ ]?cookie)";
const PROVIDER_SECRET_FIELD = `(?:[a-z0-9]+[-_ ]+)*${SECRET_FIELD}`;
const SECRET_KEYS = new Set([
	"authorization",
	"proxyauthorization",
	"xapikey",
	"apikey",
	"accesstoken",
	"refreshtoken",
	"authtoken",
	"token",
	"password",
	"passwd",
	"secret",
	"secretaccesskey",
	"clientsecret",
	"privatekey",
	"credential",
	"credentials",
	"cookie",
	"setcookie",
]);

export interface NormalizedProviderError {
	/** HTTP status code, when one could be extracted from the SDK error object. */
	status?: number;
	/** HTTP body reason, already redacted, trimmed, and truncated to the cap. */
	body?: string;
	/** `error.message`, or `safeJsonStringify(error)` for a non-`Error` throw. */
	message: string;
	/** True when `message` already contains the body (no separate body to add). */
	messageCarriesBody: boolean;
}

type SdkErrorShape = Error & {
	statusCode?: unknown;
	status?: unknown;
	body?: unknown;
	error?: unknown;
	$metadata?: { httpStatusCode?: unknown };
	$response?: { statusCode?: unknown; body?: unknown };
};

export function normalizeProviderError(error: unknown): NormalizedProviderError {
	if (!(error instanceof Error)) {
		return { message: redactProviderErrorText(safeJsonStringify(error)), messageCarriesBody: false };
	}

	const sdkError = error as SdkErrorShape;
	const status = extractStatus(sdkError);
	const body = extractBody(sdkError);
	const message = redactProviderErrorText(error.message);
	const messageCarriesBody = body === undefined || message.includes(body);

	return {
		status,
		body,
		message,
		messageCarriesBody,
	} satisfies NormalizedProviderError;
}

/**
 * Probe the HTTP status, first numeric hit wins, in SDK-field order:
 * `statusCode` (Mistral) → `status` (`openai`, `@google/genai`) →
 * `$metadata.httpStatusCode` (Bedrock) → `$response.statusCode` (Bedrock).
 */
function extractStatus(error: SdkErrorShape): number | undefined {
	if (typeof error.statusCode === "number") return error.statusCode;
	if (typeof error.status === "number") return error.status;
	if (typeof error.$metadata?.httpStatusCode === "number") return error.$metadata.httpStatusCode;
	if (typeof error.$response?.statusCode === "number") return error.$response.statusCode;
	return undefined;
}

/**
 * Probe the raw body reason, first usable hit wins, in SDK-field order:
 * `body` string (Mistral) → `error` parsed JSON body object (`openai` SDK's
 * `this.error`) → `$response.body` (Bedrock). Empty objects and unread response
 * streams are treated as no body so they do not surface as `"{}"` or serialized
 * stream internals. The chosen body is redacted before it is truncated to the cap.
 */
function extractBody(error: SdkErrorShape): string | undefined {
	const bodyText = pickBodyText(error);
	if (bodyText === undefined) return undefined;
	const trimmed = bodyText.trim();
	if (trimmed.length === 0) return undefined;
	return truncateErrorText(redactProviderErrorText(trimmed), MAX_PROVIDER_ERROR_BODY_CHARS);
}

function redactTextPatterns(text: string): string {
	return text
		.replace(/^\s*((?:authorization|proxy-authorization|x-api-key|cookie|set-cookie)\s*:\s*).*$/gim, `$1${REDACTED}`)
		.replace(new RegExp(`(["']${PROVIDER_SECRET_FIELD}["']\\s*:\\s*)(["'])(.*?)\\2`, "gi"), `$1$2${REDACTED}$2`)
		.replace(/(\bauthorization\s*[:=]\s*)(?:bearer\s+|basic\s+)?(?:\[REDACTED\]|[^\s,;&}\]]+)/gi, `$1${REDACTED}`)
		.replace(
			new RegExp(`(\\b${PROVIDER_SECRET_FIELD}\\b\\s*[:=]\\s*)(?:\\[REDACTED\\]|[^\\s,;&}\\]]+)`, "gi"),
			`$1${REDACTED}`,
		)
		.replace(/(bearer\s+)[a-z0-9._~+\-/]+=*/gi, `$1${REDACTED}`)
		.replace(new RegExp(`([?&]${PROVIDER_SECRET_FIELD}=)[^&#\\s]+`, "gi"), `$1${REDACTED}`);
}

function isSecretKey(key: string): boolean {
	const normalized = key.replace(/[^a-z0-9]/giu, "").toLowerCase();
	return [...SECRET_KEYS].some((secret) => normalized.endsWith(secret));
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
	if (typeof value === "string") return redactTextPatterns(value);
	if (typeof value !== "object" || value === null) return value;
	if (seen.has(value)) return "[Circular]";
	seen.add(value);

	if (Array.isArray(value)) return value.map((item) => redactValue(item, seen));
	if (!isPlainObject(value)) return redactTextPatterns(String(value));

	const redacted: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		redacted[key] = isSecretKey(key) ? REDACTED : redactValue(item, seen);
	}
	return redacted;
}

export function redactProviderErrorValue(value: unknown): unknown {
	return redactValue(value, new WeakSet());
}

export function sanitizeProviderErrorCause(value: unknown): unknown {
	if (!(value instanceof Error)) return redactProviderErrorValue(value);
	const source = value as Error & {
		cause?: unknown;
		code?: unknown;
		status?: unknown;
		statusCode?: unknown;
	};
	const cause = source.cause === undefined ? undefined : sanitizeProviderErrorCause(source.cause);
	const sanitized = new Error(
		redactProviderErrorText(value.message || value.name),
		cause === undefined ? undefined : { cause },
	);
	sanitized.name = redactProviderErrorText(value.name || "Error");
	for (const key of ["code", "status", "statusCode"] as const) {
		const field = source[key];
		if (typeof field === "number") Object.assign(sanitized, { [key]: field });
		if (typeof field === "string") Object.assign(sanitized, { [key]: redactProviderErrorText(field) });
	}
	return sanitized;
}

export function redactProviderErrorText(text: string): string {
	try {
		return redactTextPatterns(JSON.stringify(redactProviderErrorValue(JSON.parse(text))));
	} catch {
		return redactTextPatterns(text);
	}
}

function pickBodyText(error: SdkErrorShape): string | undefined {
	if (typeof error.body === "string") return error.body;
	if (isPlainNonEmptyObject(error.error)) return safeJsonStringify(error.error);
	const responseBody = error.$response?.body;
	if (typeof responseBody === "string") return responseBody;
	if (isReadableStreamLike(responseBody)) return undefined;
	if (isPlainNonEmptyObject(responseBody)) return safeJsonStringify(responseBody);
	return undefined;
}

function isReadableStreamLike(value: unknown): boolean {
	return typeof value === "object" && value !== null && "pipe" in value && typeof value.pipe === "function";
}

/**
 * Only a PLAIN object counts as an HTTP body. SDK error fields can hold class
 * instances instead of parsed bodies — AWS SDK v3's `$response.body` is an
 * HTTP stream/response wrapper object, and stringifying one produced garbage
 * like `{"_events":...}` as the "body", which then REPLACED `error.message`
 * in the composed display string. `error.message` is where the SDK puts the
 * real deserialized exception text ("Input is too long...", schema validation
 * details, ...), so the one useful string was discarded for noise. A class
 * instance yields no body, `messageCarriesBody` stays true, and the real
 * message survives. Complements the `pipe` sniffing above: web
 * ReadableStreams (pipeTo/pipeThrough, no `pipe`) and non-stream SDK wrapper
 * classes fail the prototype check, while parsed JSON bodies (plain objects
 * by construction) still pass.
 */
function isPlainNonEmptyObject(value: unknown): boolean {
	return isPlainObject(value) && Object.keys(value).length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/**
 * Compose a display string from a normalized error. When the message already
 * carries the body (Anthropic / `@google/genai` happy path) or no body/status
 * was extracted, the message is returned unchanged. Otherwise the status and
 * body are surfaced, with an optional provider prefix.
 *
 * - no prefix: `"<status>: <body>"`
 * - prefix:    `"<prefix> (<status>): <body>"`
 */
export function formatProviderError(norm: NormalizedProviderError, prefix?: string): string {
	if (norm.messageCarriesBody || norm.status === undefined || norm.body === undefined) {
		const message =
			prefix !== undefined && norm.status !== undefined
				? `${prefix} (${norm.status}): ${norm.message}`
				: norm.message;
		return redactProviderErrorText(message);
	}
	const message = prefix !== undefined ? `${prefix} (${norm.status}): ${norm.body}` : `${norm.status}: ${norm.body}`;
	return redactProviderErrorText(message);
}

export function truncateErrorText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}... [truncated ${text.length - maxChars} chars]`;
}

export function safeJsonStringify(value: unknown): string {
	try {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? String(value) : serialized;
	} catch {
		return String(value);
	}
}
