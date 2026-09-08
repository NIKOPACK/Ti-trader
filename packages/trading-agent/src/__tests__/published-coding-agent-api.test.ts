import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import publishedExportsJson from "./fixtures/pi-coding-agent-0.84.3-exports.json" with { type: "json" };

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const SPECIFIER = "@earendil-works/pi-coding-agent";
const PUBLISHED_EXPORTS = new Set(publishedExportsJson);

function collectSourceFiles(directory: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== "__tests__") files.push(...collectSourceFiles(path));
			continue;
		}
		if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
			files.push(path);
		}
	}
	return files;
}

function runtimeNamedImports(source: string): string[] {
	const names: string[] = [];
	const pattern = /import\s+(type\s+)?\{([^}]+)\}\s+from\s+"@earendil-works\/pi-coding-agent"/g;
	for (const match of source.matchAll(pattern)) {
		if (match[1]) continue;
		for (const part of match[2].split(",")) {
			const spec = part.trim();
			if (!spec || spec.startsWith("type ")) continue;
			const name = spec.replace(/\s+as\s+\S+$/, "").trim();
			if (name) names.push(name);
		}
	}
	return names;
}

describe("published @earendil-works/pi-coding-agent@0.84.3 API", () => {
	it("does not runtime-import names missing from the published package", () => {
		const missing: string[] = [];
		for (const file of collectSourceFiles(SRC_DIR)) {
			for (const name of runtimeNamedImports(readFileSync(file, "utf8"))) {
				if (!PUBLISHED_EXPORTS.has(name)) {
					missing.push(`${file.slice(SRC_DIR.length + 1)}: ${name}`);
				}
			}
		}
		expect(missing).toEqual([]);
	});

	it("does not namespace-import the coding-agent package", () => {
		const namespacePattern = new RegExp(`import\\s+\\*\\s+as\\s+\\S+\\s+from\\s+"${SPECIFIER}"`);
		const offenders = collectSourceFiles(SRC_DIR).filter((file) => namespacePattern.test(readFileSync(file, "utf8")));
		expect(offenders).toEqual([]);
	});
});
