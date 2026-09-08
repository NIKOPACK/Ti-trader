import { readFileSync } from "node:fs";
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

const extensionNames = ["market-lab", "market-chart", "market-research", "web-search", "zhihu-research"] as const;
const publishedExtensions = extensionNames.map((name) => `./dist/${name}/index.js`);

function readManifest(relativeUrl: string): PackageManifest {
	return JSON.parse(readFileSync(fileURLToPath(new URL(relativeUrl, import.meta.url)), "utf8")) as PackageManifest;
}

describe("extension packaging", () => {
	it("publishes ti-trader as a Pi package with all extension resources", () => {
		const manifest = readManifest("../package.json");

		expect(manifest.keywords).toContain("pi-package");
		expect(manifest.pi).toEqual({
			extensions: publishedExtensions,
			skills: ["./dist/market-research/SKILL.md"],
		});
		expect(manifest.ti).toEqual(manifest.pi);
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
});
