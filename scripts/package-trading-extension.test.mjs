import assert from "node:assert/strict";
import test from "node:test";
import { createPublishedManifest } from "./package-trading-extension.mjs";

test("published extension manifests point to the compiled entry", () => {
	const sourceManifest = {
		name: "example-extension",
		pi: { extensions: ["./index.ts"], skills: ["./SKILL.md"] },
		ti: { extensions: ["./index.ts"] },
	};

	assert.deepEqual(createPublishedManifest(sourceManifest), {
		name: "example-extension",
		pi: { extensions: ["./index.js"], skills: ["./SKILL.md"] },
		ti: { extensions: ["./index.js"] },
	});
	assert.deepEqual(sourceManifest.pi.extensions, ["./index.ts"]);
});
