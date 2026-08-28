import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readPiManifest } from "../src/core/pi-manifest.ts";

describe("readPiManifest", () => {
	let tempDir: string;
	let packageJsonPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-manifest-"));
		packageJsonPath = join(tempDir, "package.json");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("falls back to pi resources that are missing from the ti manifest", () => {
		writeFileSync(
			packageJsonPath,
			JSON.stringify({
				pi: {
					extensions: ["./pi.ts"],
					prompts: ["./review.md"],
					themes: ["./dark.json"],
				},
				ti: { extensions: ["./ti.ts"] },
			}),
		);

		expect(readPiManifest(packageJsonPath, "ti")).toEqual({
			extensions: ["./ti.ts"],
			prompts: ["./review.md"],
			themes: ["./dark.json"],
		});
	});

	it("keeps an explicitly empty ti resource instead of falling back", () => {
		writeFileSync(
			packageJsonPath,
			JSON.stringify({
				pi: { extensions: ["./pi.ts"], skills: ["./SKILL.md"] },
				ti: { extensions: [] },
			}),
		);

		expect(readPiManifest(packageJsonPath, "ti")).toEqual({
			extensions: [],
			skills: ["./SKILL.md"],
		});
	});
});
