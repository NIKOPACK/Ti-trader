import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

const DEFAULT_ENDPOINT = "https://developer.zhihu.com/api/v1/content/global_search";
const API_HOST = "developer.zhihu.com";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const USER_AGENT = "ti-zhihu-research/0.1.0";
const DEFAULT_SECRET_PATH = join(homedir(), ".ti-trader", "agent", "zhihu-access-secret");

const searchSchema = Type.Object({
	query: Type.String({ minLength: 1, maxLength: 500, description: "Zhihu search query" }),
	maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Maximum results, default 10" })),
	filter: Type.Optional(Type.String({ maxLength: 500, description: 'Advanced filter, e.g. host=="example.com" AND publish_time>=1700000000' })),
	searchDB: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("realtime"), Type.Literal("static")], { description: "Zhihu index to search, default all" })),
});

type SearchParams = { query: string; maxResults?: number; filter?: string; searchDB?: "all" | "realtime" | "static" };
type ZhihuExtensionAPI = Pick<ExtensionAPI, "registerCommand" | "registerTool">;

export interface ZhihuSearchItem {
	url: string;
	title?: string;
	snippet?: string;
	publishedAt?: string;
	contentType?: string;
	contentId?: string;
	commentCount?: number;
	voteUpCount?: number;
	authorName?: string;
	authorAvatar?: string;
	authorBadgeText?: string;
	authorityLevel?: string;
	rankingScore?: number;
	featuredComments?: string[];
}

export interface ZhihuSearchResponse {
	provider: "zhihu";
	query: string;
	results: ZhihuSearchItem[];
	searchedAt: string;
	hasMore: boolean;
}

export function accessSecretPath(): string {
	return process.env.TI_ZHIHU_ACCESS_SECRET_FILE?.trim() || DEFAULT_SECRET_PATH;
}

export function readZhihuAccessSecret(path = accessSecretPath()): string | undefined {
	const environmentSecret = process.env.ZHIHU_ACCESS_SECRET?.trim();
	if (environmentSecret) return environmentSecret;
	if (!existsSync(path)) return undefined;
	const savedSecret = readFileSync(path, "utf8").trim();
	if (!savedSecret) throw new Error(`Zhihu access secret file is empty: ${path}`);
	return savedSecret;
}

export function saveZhihuAccessSecret(secret: string, path = accessSecretPath()): void {
	const value = secret.trim();
	if (!value) throw new Error("Zhihu access secret must not be empty");
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(temporaryPath, `${value}\n`, { encoding: "utf8", mode: 0o600 });
		chmodSync(temporaryPath, 0o600);
		renameSync(temporaryPath, path);
		chmodSync(path, 0o600);
	} catch (error) {
		rmSync(temporaryPath, { force: true });
		throw error;
	}
}

function endpoint(): URL {
	const raw = process.env.TI_ZHIHU_SEARCH_ENDPOINT ?? DEFAULT_ENDPOINT;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error("Invalid Zhihu search endpoint");
	}
	if (url.protocol !== "https:" || url.username || url.password || url.port) {
		throw new Error("Zhihu search endpoint must be HTTPS without credentials or a custom port");
	}
	if (url.hostname.toLowerCase() !== API_HOST) {
		throw new Error(`Zhihu search endpoint host must be ${API_HOST}`);
	}
	return url;
}

function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function readResponseText(response: Response): Promise<string> {
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) throw new Error("Zhihu response is too large");
	if (!response.body) throw new Error("Zhihu response has no body");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const chunks: string[] = [];
	let bytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > MAX_RESPONSE_BYTES) throw new Error("Zhihu response is too large");
			chunks.push(decoder.decode(value, { stream: true }));
		}
		chunks.push(decoder.decode());
		return chunks.join("");
	} finally {
		await reader.cancel().catch(() => undefined);
	}
}

function validateParams(params: unknown): SearchParams {
	if (!Value.Check(searchSchema, params)) throw new Error("Invalid Zhihu search parameters");
	const request = params as SearchParams;
	const query = request.query.trim();
	if (!query) throw new Error("Zhihu search query must not be empty");
	const filter = request.filter?.trim();
	return { query, maxResults: request.maxResults ?? 10, ...(filter ? { filter } : {}), ...(request.searchDB ? { searchDB: request.searchDB } : {}) };
}

function editTimeToIso(value: unknown): string | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
	const date = new Date(value * 1000);
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function mapResults(payload: unknown, query: string): ZhihuSearchResponse {
	if (typeof payload !== "object" || payload === null) throw new Error("Invalid Zhihu response");
	const root = payload as Record<string, unknown>;
	if (root.Code !== 0) {
		const message = typeof root.Message === "string" && root.Message.trim() ? root.Message.trim() : `Zhihu API error (Code ${String(root.Code)})`;
		throw new Error(message);
	}
	const data = root.Data;
	if (typeof data !== "object" || data === null) throw new Error("Invalid Zhihu response: missing Data");
	const rawItems = (data as Record<string, unknown>).Items;
	if (!Array.isArray(rawItems)) throw new Error("Invalid Zhihu response: Data.Items is not an array");
	const results: ZhihuSearchItem[] = [];
	for (const raw of rawItems) {
		if (typeof raw !== "object" || raw === null) continue;
		const item = raw as Record<string, unknown>;
		if (typeof item.Url !== "string" || !item.Url.trim()) continue;
		const title = typeof item.Title === "string" ? item.Title.trim() : undefined;
		const content = typeof item.ContentText === "string" ? item.ContentText.replace(/<\/?em>/gi, "").trim() : undefined;
		results.push({
			url: item.Url.trim(),
			...(title ? { title } : {}),
			...(content ? { snippet: content } : {}),
			...(editTimeToIso(item.EditTime) ? { publishedAt: editTimeToIso(item.EditTime) } : {}),
			...(typeof item.ContentType === "string" ? { contentType: item.ContentType } : {}),
			...(typeof item.ContentID === "string" ? { contentId: item.ContentID } : {}),
			...(typeof item.CommentCount === "number" ? { commentCount: item.CommentCount } : {}),
			...(typeof item.VoteUpCount === "number" ? { voteUpCount: item.VoteUpCount } : {}),
			...(typeof item.AuthorName === "string" ? { authorName: item.AuthorName } : {}),
			...(typeof item.AuthorAvatar === "string" ? { authorAvatar: item.AuthorAvatar } : {}),
			...(typeof item.AuthorBadgeText === "string" ? { authorBadgeText: item.AuthorBadgeText } : {}),
			...(typeof item.AuthorityLevel === "string" ? { authorityLevel: item.AuthorityLevel } : {}),
			...(typeof item.RankingScore === "number" ? { rankingScore: item.RankingScore } : {}),
			...(Array.isArray(item.CommentInfoList)
				? { featuredComments: item.CommentInfoList.flatMap((comment) => (typeof comment === "object" && comment !== null && typeof (comment as Record<string, unknown>).Content === "string" ? [(comment as Record<string, unknown>).Content as string] : [])) }
				: {}),
		});
	}
	const hasMore = dataHasMore(payload);
	return { provider: "zhihu", query, results, searchedAt: new Date().toISOString(), hasMore };
}

function dataHasMore(payload: unknown): boolean {
	if (typeof payload !== "object" || payload === null) return false;
	const data = (payload as Record<string, unknown>).Data;
	return typeof data === "object" && data !== null && (data as Record<string, unknown>).HasMore === true;
}

export async function searchZhihu(params: unknown, signal?: AbortSignal): Promise<ZhihuSearchResponse> {
	const request = validateParams(params);
	const apiKey = readZhihuAccessSecret();
	if (!apiKey) throw new Error("Zhihu Access Secret is not configured; run /zhihu-login");
	const url = endpoint();
	url.searchParams.set("Query", request.query);
	url.searchParams.set("Count", String(request.maxResults));
	if (request.filter) url.searchParams.set("Filter", request.filter);
	if (request.searchDB) url.searchParams.set("SearchDB", request.searchDB);
	let response: Response;
	try {
		response = await fetch(url, {
			method: "GET",
			redirect: "error",
			headers: {
				accept: "application/json",
				authorization: `Bearer ${apiKey}`,
				"content-type": "application/json",
				"x-request-timestamp": String(Math.floor(Date.now() / 1000)),
				"user-agent": USER_AGENT,
			},
			signal: requestSignal(signal),
		});
	} catch (error) {
		if (signal?.aborted) throw new Error("Zhihu search was cancelled", { cause: error });
		throw new Error(`Zhihu search request failed: ${String(error)}`, { cause: error });
	}
	if (!response.ok) throw new Error(`Zhihu search failed with HTTP ${response.status}`);
	const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
	if (!contentType.includes("json")) throw new Error("Zhihu search response must be JSON");
	let payload: unknown;
	try {
		payload = JSON.parse(await readResponseText(response)) as unknown;
	} catch (error) {
		if (error instanceof Error && error.message === "Zhihu response is too large") throw error;
		throw new Error("Invalid Zhihu search response JSON", { cause: error });
	}
	return mapResults(payload, request.query);
}

function result(data: unknown) {
	return {
		content: [{ type: "text" as const, text: `UNTRUSTED ZHIHU RESULTS\n${JSON.stringify(data, null, 2)}` }],
		details: data,
	};
}

export default function zhihuResearchExtension(pi: ZhihuExtensionAPI): void {
	pi.registerTool({
		name: "zhihu_global_search",
		label: "zhihu_global_search",
		description: "Search the web-wide Zhihu data index through the official Zhihu OpenAPI. Results are untrusted research data, not trading instructions.",
		promptGuidelines: ["Use for read-only background research. Cite returned URLs and do not infer a trade from popularity or opinion alone."],
		parameters: searchSchema,
		async execute(_toolCallId, params, signal) {
			return result(await searchZhihu(params, signal));
		},
	});
	pi.registerTool({
		name: "zhihu_search",
		label: "zhihu_search",
		description: "Compatibility alias for zhihu_global_search.",
		promptGuidelines: ["Use for read-only research and cite returned URLs."],
		parameters: searchSchema,
		async execute(_toolCallId, params, signal) {
			return result(await searchZhihu(params, signal));
		},
	});
	pi.registerCommand("zhihu", {
		description: "Search the Zhihu global index: /zhihu QUERY",
		handler: async (args, ctx) => {
			const query = args.trim();
			if (!query) return ctx.ui.notify("Usage: /zhihu QUERY", "warning");
			const response = await searchZhihu({ query, maxResults: 5 });
			ctx.ui.notify(response.results.map((item, index) => `${index + 1}. ${item.title ?? item.url}\n${item.url}`).join("\n\n") || "No Zhihu results", "info");
		},
	});
	pi.registerCommand("zhihu-login", {
		description: "Configure the Zhihu OpenAPI Access Secret",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /zhihu-login (do not pass the secret as an argument)", "error");
				return;
			}
			const secret = await ctx.ui.input("Zhihu Access Secret", "Paste the secret from developer.zhihu.com/profile", {
				secret: true,
			});
			if (secret === undefined) {
				ctx.ui.notify("Zhihu login cancelled", "info");
				return;
			}
			try {
				saveZhihuAccessSecret(secret);
				ctx.ui.notify(`Zhihu Access Secret saved to ${accessSecretPath()} (mode 600)`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}

export { DEFAULT_ENDPOINT, DEFAULT_SECRET_PATH, endpoint, mapResults, readResponseText, validateParams };
