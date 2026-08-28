import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import zhihuResearchExtension, {
	endpoint,
	mapResults,
	readZhihuAccessSecret,
	saveZhihuAccessSecret,
	searchZhihu,
} from "../../../extensions/zhihu-research/index.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	delete process.env.ZHIHU_ACCESS_SECRET;
	delete process.env.TI_ZHIHU_ACCESS_SECRET_FILE;
	delete process.env.TI_ZHIHU_SEARCH_ENDPOINT;
	for (const path of temporaryDirectories.splice(0)) rmSync(path, { force: true, recursive: true });
});

function temporarySecretPath(): string {
	const directory = mkdtempSync(join(tmpdir(), "ti-zhihu-research-"));
	temporaryDirectories.push(directory);
	return join(directory, "zhihu-access-secret");
}

describe("zhihu global search extension", () => {
	it("maps official global-search fields and strips highlight tags", () => {
		const result = mapResults(
			{
				Code: 0,
				Data: {
					HasMore: true,
					Items: [
						{
							Title: "<em>Bitcoin</em> outlook",
							ContentType: "Article",
							ContentID: "abc",
							ContentText: "A <em>market</em> summary",
							Url: "https://example.com/article",
							CommentCount: 4,
							VoteUpCount: 12,
							AuthorName: "Author",
							AuthorAvatar: "https://picx.zhimg.com/a.jpg",
							AuthorBadgeText: "认证作者",
							AuthorityLevel: "3",
							RankingScore: 0.98,
							CommentInfoList: [{ Content: "Useful comment" }],
							EditTime: 1_700_000_000,
						},
					],
				},
			},
			"Bitcoin",
		);
		expect(result.hasMore).toBe(true);
		expect(result.results[0]).toMatchObject({
			title: "<em>Bitcoin</em> outlook",
			snippet: "A market summary",
			contentType: "Article",
			contentId: "abc",
			commentCount: 4,
			voteUpCount: 12,
			authorityLevel: "3",
			authorAvatar: "https://picx.zhimg.com/a.jpg",
			authorBadgeText: "认证作者",
			rankingScore: 0.98,
			featuredComments: ["Useful comment"],
			publishedAt: "2023-11-14T22:13:20.000Z",
		});
	});

	it("sends encoded global-search parameters and never returns the secret", async () => {
		process.env.ZHIHU_ACCESS_SECRET = "test-secret";
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ Code: 0, Data: { HasMore: false, Items: [] } }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		const response = await searchZhihu({
			query: "btc 监管",
			maxResults: 20,
			filter: 'host=="example.com" AND publish_time>=1700000000',
			searchDB: "realtime",
		});
		const request = fetchMock.mock.calls[0];
		const requestUrl = String(request?.[0]);
		const requestInit = request?.[1];
		expect(new URL(requestUrl).searchParams.get("Query")).toBe("btc 监管");
		expect(new URL(requestUrl).searchParams.get("Filter")).toBe('host=="example.com" AND publish_time>=1700000000');
		expect(new URL(requestUrl).searchParams.get("SearchDB")).toBe("realtime");
		expect(requestInit?.headers).toMatchObject({
			authorization: "Bearer test-secret",
			"content-type": "application/json",
		});
		expect(JSON.stringify(response)).not.toContain("test-secret");
	});

	it("saves a private secret file and uses it when the environment is unset", async () => {
		const secretPath = temporarySecretPath();
		process.env.TI_ZHIHU_ACCESS_SECRET_FILE = secretPath;
		saveZhihuAccessSecret("file-secret");
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ Code: 0, Data: { HasMore: false, Items: [] } }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);

		await searchZhihu({ query: "BTC", maxResults: 1 });

		expect(readFileSync(secretPath, "utf8")).toBe("file-secret\n");
		expect(statSync(secretPath).mode & 0o777).toBe(0o600);
		expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: "Bearer file-secret" });
	});

	it("registers a masked zhihu-login command that persists the secret", async () => {
		const secretPath = temporarySecretPath();
		process.env.TI_ZHIHU_ACCESS_SECRET_FILE = secretPath;
		const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
		const registerTool = vi.fn() as unknown as ExtensionAPI["registerTool"];
		const registerCommand = vi.fn((name, command) => commands.set(name, command)) as ExtensionAPI["registerCommand"];
		zhihuResearchExtension({ registerTool, registerCommand });
		const input = vi.fn().mockResolvedValue("command-secret");
		const notify = vi.fn();

		await commands.get("zhihu-login")?.handler("", { ui: { input, notify } } as unknown as ExtensionCommandContext);

		expect(input).toHaveBeenCalledWith(expect.any(String), expect.any(String), { secret: true });
		expect(readZhihuAccessSecret()).toBe("command-secret");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("mode 600"), "info");
	});

	it("rejects invalid endpoint hosts and business errors", async () => {
		process.env.TI_ZHIHU_SEARCH_ENDPOINT = "https://example.com/search";
		expect(() => endpoint()).toThrow("developer.zhihu.com");
		expect(() => mapResults({ Code: 20001, Message: "Authorization failed", Data: null }, "x")).toThrow(
			"Authorization failed",
		);
	});

	it("fails clearly when the secret is missing", async () => {
		await expect(searchZhihu({ query: "BTC" })).rejects.toThrow("run /zhihu-login");
	});
});
