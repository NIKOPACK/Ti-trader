#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");
const manifestNames = ["pi", "ti"];

function isObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createPublishedManifest(sourceManifest) {
	if (!isObject(sourceManifest)) throw new Error("Extension package.json must contain an object");
	const publishedManifest = structuredClone(sourceManifest);
	for (const name of manifestNames) {
		if (!isObject(publishedManifest[name])) continue;
		publishedManifest[name] = { ...publishedManifest[name], extensions: ["./index.js"] };
	}
	return publishedManifest;
}

export function packageTradingExtension(extensionName) {
	if (!/^[a-z0-9-]+$/.test(extensionName)) throw new Error(`Invalid extension name: ${extensionName}`);

	const sourceDir = join(repoRoot, "extensions", extensionName);
	const compiledDir = join(sourceDir, "dist");
	const targetDir = join(repoRoot, "packages", "trading-agent", "dist", extensionName);
	const packageJsonPath = join(sourceDir, "package.json");
	if (!existsSync(packageJsonPath)) throw new Error(`Missing extension package.json: ${extensionName}`);
	if (!existsSync(compiledDir)) throw new Error(`Missing compiled extension directory: ${extensionName}`);

	const compiledFiles = readdirSync(compiledDir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
		.map((entry) => entry.name)
		.sort();
	if (!compiledFiles.includes("index.js")) throw new Error(`Missing compiled extension entry: ${extensionName}/index.js`);
	const testFiles = compiledFiles.filter((file) => /(?:^|\.)test\.js$/.test(file));
	if (testFiles.length > 0) throw new Error(`Compiled extension contains test modules: ${testFiles.join(", ")}`);

	rmSync(targetDir, { force: true, recursive: true });
	mkdirSync(targetDir, { recursive: true });
	for (const file of compiledFiles) copyFileSync(join(compiledDir, file), join(targetDir, file));
	for (const file of ["README.md", "SKILL.md"]) {
		const sourcePath = join(sourceDir, file);
		if (existsSync(sourcePath)) copyFileSync(sourcePath, join(targetDir, file));
	}
	const agentsDir = join(sourceDir, "agents");
	if (existsSync(agentsDir)) {
		const agentFiles = readdirSync(agentsDir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
			.map((entry) => entry.name)
			.sort();
		if (agentFiles.length > 0) {
			const targetAgentsDir = join(targetDir, "agents");
			mkdirSync(targetAgentsDir, { recursive: true });
			for (const file of agentFiles) copyFileSync(join(agentsDir, file), join(targetAgentsDir, file));
		}
	}

	const sourceManifest = JSON.parse(readFileSync(packageJsonPath, "utf8"));
	const publishedManifest = createPublishedManifest(sourceManifest);
	writeFileSync(join(targetDir, "package.json"), `${JSON.stringify(publishedManifest, null, "\t")}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
	const extensionName = process.argv[2];
	if (!extensionName || process.argv.length !== 3) {
		throw new Error("Usage: node scripts/package-trading-extension.mjs <extension-name>");
	}
	packageTradingExtension(extensionName);
}
