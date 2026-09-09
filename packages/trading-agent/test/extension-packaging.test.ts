import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface ResourceManifest {
	extensions?: string[];
	skills?: string[];
}

interface PackageManifest {
	keywords?: string[];
	peerDependencies?: Record<string, string>;
	pi?: ResourceManifest;
	ti?: ResourceManifest;
}

const extensionNames = [
	"market-lab",
	"market-chart",
	"market-research",
	"web-search",
	"zhihu-research",
	"subagent",
] as const;
const defaultAutoloadExtensions = ["./dist/market-lab/index.js", "./dist/market-chart/index.js"];

function readManifest(relativeUrl: string): PackageManifest {
	return JSON.parse(readFileSync(fileURLToPath(new URL(relativeUrl, import.meta.url)), "utf8")) as PackageManifest;
}

describe("extension packaging", () => {
	it("publishes ti-trader with default lab and chart autoload only", () => {
		const manifest = readManifest("../package.json");

		expect(manifest.keywords).toContain("pi-package");
		expect(manifest.pi).toEqual({
			extensions: defaultAutoloadExtensions,
		});
		expect(manifest.ti).toEqual(manifest.pi);
		expect(manifest.pi?.skills).toBeUndefined();
		expect(manifest.ti?.skills).toBeUndefined();
	});

	it.each(extensionNames)("keeps the %s source package on one TypeScript entry", (name) => {
		const manifest = readManifest(`../../../extensions/${name}/package.json`);

		expect(manifest.pi?.extensions).toEqual(["./index.ts"]);
		expect(manifest.ti?.extensions).toEqual(["./index.ts"]);
		expect(manifest.peerDependencies).toMatchObject({
			"@earendil-works/pi-coding-agent": "*",
			typebox: "*",
		});
	});

	it("declares the market research skill in both source manifests", () => {
		const manifest = readManifest("../../../extensions/market-research/package.json");

		expect(manifest.pi?.skills).toEqual(["./SKILL.md"]);
		expect(manifest.ti?.skills).toEqual(["./SKILL.md"]);
	});

	it("declares the subagent skill in both source manifests", () => {
		const manifest = readManifest("../../../extensions/subagent/package.json");

		expect(manifest.pi?.skills).toEqual(["./SKILL.md"]);
		expect(manifest.ti?.skills).toEqual(["./SKILL.md"]);
	});

	it("ships bundled subagent definitions next to the extension entry", () => {
		const agentsDir = fileURLToPath(new URL("../../../extensions/subagent/agents", import.meta.url));
		expect(readdirSync(agentsDir).sort()).toEqual(["researcher.md", "reviewer.md", "scanner.md"]);
	});
});
