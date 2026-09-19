#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const codingAgentDir = join(repoRoot, "packages/coding-agent");
const rootLockfilePath = join(repoRoot, "package-lock.json");
const shrinkwrapPath = join(codingAgentDir, "npm-shrinkwrap.json");
const internalPackagePrefix = "@earendil-works/pi-";
const internalPackageNames = new Set(["@earendil-works/chord"]);
const allowedInstallScriptPackages = new Map([
	["@google/genai@2.21.0", "preinstall is a no-op in the published package"],
	["protobufjs@7.6.5", "postinstall only warns about protobufjs version scheme mismatches"],
]);
const workspaceLockFields = [
	"name",
	"version",
	"license",
	"dependencies",
	"optionalDependencies",
	"peerDependencies",
	"peerDependenciesMeta",
	"bin",
	"devDependencies",
	"engines",
	"os",
	"cpu",
];

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function packageDependencies(entry) {
	return {
		...(entry.dependencies ?? {}),
		...(entry.optionalDependencies ?? {}),
	};
}

export function compareCodePoints(left, right) {
	let leftIndex = 0;
	let rightIndex = 0;
	while (leftIndex < left.length && rightIndex < right.length) {
		const leftPoint = left.codePointAt(leftIndex);
		const rightPoint = right.codePointAt(rightIndex);
		if (leftPoint !== rightPoint) return leftPoint - rightPoint;
		leftIndex += leftPoint > 0xffff ? 2 : 1;
		rightIndex += rightPoint > 0xffff ? 2 : 1;
	}
	return leftIndex === left.length && rightIndex === right.length ? 0 : leftIndex === left.length ? -1 : 1;
}

function sortedObject(object) {
	return Object.fromEntries(Object.entries(object).sort(([left], [right]) => compareCodePoints(left, right)));
}

function normalizedJson(value) {
	if (Array.isArray(value)) return value.map(normalizedJson);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([left], [right]) => compareCodePoints(left, right))
				.map(([key, entry]) => [key, normalizedJson(entry)]),
		);
	}
	return value;
}

export function assertWorkspaceLockMatchesPackageJson(packageJson, workspaceLock) {
	if (!workspaceLock) throw new Error("package-lock.json is missing the packages/coding-agent workspace entry");

	const mismatches = workspaceLockFields.filter(
		(field) => JSON.stringify(normalizedJson(packageJson[field])) !== JSON.stringify(normalizedJson(workspaceLock[field])),
	);
	if (mismatches.length > 0) {
		throw new Error(
			`packages/coding-agent/package.json does not match its package-lock.json workspace entry: ${mismatches.join(", ")}. Run: npm install --package-lock-only --ignore-scripts`,
		);
	}
}

function sortedPackageEntry(entry) {
	const fieldOrder = [
		"name",
		"version",
		"resolved",
		"integrity",
		"license",
		"dependencies",
		"optionalDependencies",
		"peerDependencies",
		"peerDependenciesMeta",
		"bin",
		"engines",
		"os",
		"cpu",
		"libc",
		"optional",
		"hasInstallScript",
		"deprecated",
		"funding",
	];
	const sorted = {};

	for (const field of fieldOrder) {
		if (entry[field] !== undefined) sorted[field] = entry[field];
	}
	for (const [field, value] of Object.entries(entry).sort(([left], [right]) => compareCodePoints(left, right))) {
		if (sorted[field] === undefined) sorted[field] = value;
	}
	return sorted;
}

function copyLockEntry(entry) {
	const copied = { ...entry };
	delete copied.dev;
	delete copied.devOptional;
	delete copied.extraneous;
	delete copied.link;
	return sortedPackageEntry(copied);
}

function copyPackageJsonEntry(packageJson, options) {
	const entry = options.includeName
		? { name: packageJson.name, version: packageJson.version }
		: { version: packageJson.version };

	for (const field of [
		"license",
		"dependencies",
		"optionalDependencies",
		"peerDependencies",
		"peerDependenciesMeta",
		"bin",
		"engines",
		"os",
		"cpu",
		"libc",
	]) {
		if (packageJson[field] !== undefined) entry[field] = packageJson[field];
	}

	return sortedPackageEntry(entry);
}

function packageNameFromLockPath(lockPath) {
	const marker = "node_modules/";
	const index = lockPath.lastIndexOf(marker);
	if (index === -1) return undefined;

	const parts = lockPath.slice(index + marker.length).split("/");
	if (parts[0]?.startsWith("@")) return `${parts[0]}/${parts[1]}`;
	return parts[0];
}

function registryTarballUrl(packageName, version) {
	const tarballName = packageName.startsWith("@") ? packageName.split("/")[1] : packageName;
	return `https://registry.npmjs.org/${packageName}/-/${tarballName}-${version}.tgz`;
}

function getInternalWorkspaces(lockPackages) {
	const workspaces = new Map();

	for (const [lockPath, entry] of Object.entries(lockPackages)) {
		if (!lockPath.startsWith("packages/") || lockPath.includes("/node_modules/") || !entry.name || !entry.version) {
			continue;
		}
		if (!entry.name.startsWith(internalPackagePrefix) && !internalPackageNames.has(entry.name)) continue;
		const packageJsonPath = join(repoRoot, lockPath, "package.json");
		if (!existsSync(packageJsonPath)) continue;

		workspaces.set(entry.name, {
			lockPath,
			packageJson: readJson(packageJsonPath),
		});
	}

	return workspaces;
}

function resolveExternalDependency(lockPackages, packageName, fromLockPath) {
	const candidateDirs = [];
	let current = fromLockPath;

	while (current) {
		candidateDirs.push(current);
		const parent = posix.dirname(current);
		if (parent === "." || parent === current) break;
		current = parent;
	}
	candidateDirs.push("");

	const tried = new Set();
	for (const directory of candidateDirs) {
		const candidate = directory ? `${directory}/node_modules/${packageName}` : `node_modules/${packageName}`;
		if (tried.has(candidate)) continue;
		tried.add(candidate);

		const entry = lockPackages[candidate];
		if (entry && !entry.link) return candidate;
	}

	const suffix = `node_modules/${packageName}`;
	const matches = Object.entries(lockPackages)
		.filter(([lockPath, entry]) => !entry.link && (lockPath === suffix || lockPath.endsWith(`/${suffix}`)))
		.map(([lockPath]) => lockPath);

	if (matches.length === 1) return matches[0];

	throw new Error(
		`Cannot resolve ${packageName} from ${fromLockPath || "root"}. ` +
			(matches.length > 1 ? `Matches: ${matches.join(", ")}` : "No matching lockfile entry found."),
	);
}

function addInternalWorkspace(shrinkwrapPackages, addedPaths, queue, name, workspace) {
	const packageJson = workspace.packageJson;
	const outputPath = `node_modules/${name}`;
	const entry = copyPackageJsonEntry(packageJson, { includeName: false });
	entry.resolved = registryTarballUrl(name, packageJson.version);

	shrinkwrapPackages[outputPath] = sortedPackageEntry(entry);
	addedPaths.add(outputPath);

	for (const dependencyName of Object.keys(packageDependencies(packageJson))) {
		queue.push({
			name: dependencyName,
			sourceFrom: workspace.lockPath,
			sourceBase: workspace.lockPath,
			outputBase: outputPath,
		});
	}
}

function addExternalPackage(lockPackages, shrinkwrapPackages, addedPaths, queue, item) {
	const sourceLockPath = resolveExternalDependency(lockPackages, item.name, item.sourceFrom);
	const outputLockPath =
		item.sourceBase && sourceLockPath.startsWith(`${item.sourceBase}/`)
			? [item.outputBase, sourceLockPath.slice(item.sourceBase.length + 1)].filter(Boolean).join("/")
			: sourceLockPath;
	if (addedPaths.has(outputLockPath)) return;

	const entry = lockPackages[sourceLockPath];
	shrinkwrapPackages[outputLockPath] = copyLockEntry(entry);
	addedPaths.add(outputLockPath);

	for (const dependencyName of Object.keys(packageDependencies(entry))) {
		queue.push({
			name: dependencyName,
			sourceFrom: sourceLockPath,
			sourceBase: item.sourceBase,
			outputBase: item.outputBase,
		});
	}
}

function validateShrinkwrap(shrinkwrap, internalNames) {
	const errors = [];
	const includedPaths = new Set(Object.keys(shrinkwrap.packages));
	const includedPackageNames = new Set();
	const seenAllowedInstallScriptPackages = new Set();

	for (const [lockPath, entry] of Object.entries(shrinkwrap.packages)) {
		const packageName = packageNameFromLockPath(lockPath);
		if (packageName) includedPackageNames.add(packageName);
		if (entry.link) errors.push(`${lockPath} is a link entry`);
		if (typeof entry.resolved === "string" && /^(file:|link:|workspace:|\.\.?\/|\/)/.test(entry.resolved)) {
			errors.push(`${lockPath} has a local resolved value: ${entry.resolved}`);
		}
		if (entry.hasInstallScript) {
			if (!packageName || !entry.version) {
				errors.push(`${lockPath || "root"} has install scripts but no package name/version`);
			} else {
				const packageId = `${packageName}@${entry.version}`;
				if (allowedInstallScriptPackages.has(packageId)) {
					seenAllowedInstallScriptPackages.add(packageId);
				} else {
					errors.push(
						`${lockPath} has install scripts (${packageId}). Review it and add it to allowedInstallScriptPackages if intentional.`,
					);
				}
			}
		}
	}

	for (const packageId of allowedInstallScriptPackages.keys()) {
		if (!seenAllowedInstallScriptPackages.has(packageId)) {
			errors.push(`allowed install-script package ${packageId} is no longer present; remove it from the allowlist`);
		}
	}

	for (const name of internalNames) {
		if (!includedPackageNames.has(name)) errors.push(`internal dependency ${name} is missing`);
	}

	for (const [lockPath, entry] of Object.entries(shrinkwrap.packages)) {
		for (const dependencyName of Object.keys(packageDependencies(entry))) {
			const dependencyIncluded = [...includedPaths].some(
				(candidate) => candidate === `node_modules/${dependencyName}` || candidate.endsWith(`/node_modules/${dependencyName}`),
			);
			if (!dependencyIncluded) errors.push(`${lockPath || "root"} dependency ${dependencyName} is missing`);
		}
	}

	const platformPackageCount = Object.values(shrinkwrap.packages).filter((entry) => entry.os || entry.cpu || entry.libc).length;
	if (platformPackageCount === 0) errors.push("no platform-specific optional dependency entries found");

	if (errors.length > 0) {
		throw new Error(`Generated shrinkwrap failed validation:\n${errors.map((error) => `  - ${error}`).join("\n")}`);
	}
}

export function generateShrinkwrap() {
	const rootLock = readJson(rootLockfilePath);
	if (rootLock.lockfileVersion !== 3 || !rootLock.packages) {
		throw new Error("package-lock.json must be lockfileVersion 3 and contain a packages map");
	}

	const lockPackages = rootLock.packages;
	const codingAgentPackage = readJson(join(codingAgentDir, "package.json"));
	assertWorkspaceLockMatchesPackageJson(codingAgentPackage, lockPackages["packages/coding-agent"]);
	const internalWorkspaces = getInternalWorkspaces(lockPackages);
	const shrinkwrapPackages = {
		"": copyPackageJsonEntry(codingAgentPackage, { includeName: true }),
	};
	const addedPaths = new Set([""]);
	const internalNames = new Set();
	const queue = Object.keys(packageDependencies(codingAgentPackage)).map((name) => ({
		name,
		sourceFrom: "packages/coding-agent",
		sourceBase: "packages/coding-agent",
		outputBase: "",
	}));

	while (queue.length > 0) {
		const item = queue.shift();
		if (!item) break;

		const workspace = internalWorkspaces.get(item.name);
		if (workspace) {
			const outputPath = `node_modules/${item.name}`;
			internalNames.add(item.name);
			if (!addedPaths.has(outputPath)) {
				addInternalWorkspace(shrinkwrapPackages, addedPaths, queue, item.name, workspace);
			}
			continue;
		}

		addExternalPackage(lockPackages, shrinkwrapPackages, addedPaths, queue, item);
	}

	const shrinkwrap = {
		name: codingAgentPackage.name,
		version: codingAgentPackage.version,
		lockfileVersion: 3,
		requires: true,
		packages: sortedObject(shrinkwrapPackages),
	};

	validateShrinkwrap(shrinkwrap, internalNames);
	return shrinkwrap;
}

function main(argv) {
	const args = new Set(argv);
	const checkOnly = args.has("--check");

	for (const arg of args) {
		if (arg !== "--check") throw new Error(`Unknown argument: ${arg}`);
	}

	const shrinkwrap = generateShrinkwrap();
	const content = `${JSON.stringify(shrinkwrap, null, "\t")}\n`;

	if (checkOnly) {
		if (!existsSync(shrinkwrapPath)) {
			throw new Error("packages/coding-agent/npm-shrinkwrap.json is missing.\nRun: npm run shrinkwrap:coding-agent");
		}
		const current = readFileSync(shrinkwrapPath, "utf8");
		if (current !== content) {
			throw new Error("packages/coding-agent/npm-shrinkwrap.json is out of date.\nRun: npm run shrinkwrap:coding-agent");
		}
		console.log("packages/coding-agent/npm-shrinkwrap.json is up to date.");
		return;
	}

	writeFileSync(shrinkwrapPath, content);
	const packageCount = Object.keys(shrinkwrap.packages).length - 1;
	const platformPackageCount = Object.values(shrinkwrap.packages).filter((entry) => entry.os || entry.cpu || entry.libc).length;
	console.log(
		`Wrote packages/coding-agent/npm-shrinkwrap.json (${packageCount} packages, ${platformPackageCount} platform-specific).`,
	);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		main(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
