import assert from "node:assert/strict";
import test from "node:test";
import { assertWorkspaceLockMatchesPackageJson, compareCodePoints } from "./generate-coding-agent-shrinkwrap.mjs";

const manifest = {
	name: "@earendil-works/pi-coding-agent",
	version: "0.84.3",
	license: "MIT",
	dependencies: { chalk: "6.0.0", diff: "8.0.4" },
	optionalDependencies: { clipboard: "0.3.9" },
	devDependencies: { typescript: "5.9.3" },
	bin: { pi: "dist/bundle/cli.js" },
	engines: { node: ">=22.19.0" },
};

test("accepts a coding-agent workspace lock entry matching package.json", () => {
	const lockEntry = structuredClone(manifest);
	lockEntry.dependencies = { diff: "8.0.4", chalk: "6.0.0" };
	assert.doesNotThrow(() => assertWorkspaceLockMatchesPackageJson(manifest, lockEntry));
});

test("rejects dependency drift between package.json and the workspace lock entry", () => {
	const lockEntry = structuredClone(manifest);
	lockEntry.dependencies.chalk = "5.6.2";
	assert.throws(
		() => assertWorkspaceLockMatchesPackageJson(manifest, lockEntry),
		/package-lock\.json workspace entry: dependencies/,
	);
});

test("sorts strings by Unicode code point without locale-dependent collation", () => {
	assert.deepEqual(["\u{10000}", "\ue000", "ä", "z", "a"].sort(compareCodePoints), ["a", "z", "ä", "\ue000", "\u{10000}"]);
});
