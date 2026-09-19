import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	createReadStream,
	createWriteStream,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { arch, platform } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { getBinDir } from "../config.ts";
import { fetchWithRetry } from "./management-http.ts";

const TOOLS_DIR = getBinDir();
const DOWNLOAD_TIMEOUT_MS = 120_000;
const MANAGED_TOOL_MANIFEST_VERSION = 1;

function isOfflineModeEnabled(): boolean {
	const value = process.env.PI_OFFLINE;
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

export type ToolName = "fd" | "rg";

interface ToolAsset {
	tag: string;
	name: string;
	archiveSha256: string;
	binarySha256: string;
}

interface ToolConfig {
	name: string;
	repo: string;
	binaryName: string;
	systemBinaryNames?: string[];
	assets: Readonly<Record<string, ToolAsset>>;
}

export interface ManagedToolInstallMetadata {
	manifestVersion: typeof MANAGED_TOOL_MANIFEST_VERSION;
	tool: ToolName;
	version: string;
	asset: string;
	archiveSha256: string;
	binarySha256: string;
}

const TOOLS: Record<ToolName, ToolConfig> = {
	fd: {
		name: "fd",
		repo: "sharkdp/fd",
		binaryName: "fd",
		systemBinaryNames: ["fd", "fdfind"],
		assets: {
			"darwin/arm64": {
				tag: "v10.4.2",
				name: "fd-v10.4.2-aarch64-apple-darwin.tar.gz",
				archiveSha256: "623dc0afc81b92e4d4606b380d7bc91916ba7b97814263e554d50923a39e480a",
				binarySha256: "bbd98b652be41796406f9d793a2909a717fd871d0e0b824f72fb85c645ad5366",
			},
			"darwin/x64": {
				tag: "v10.3.0",
				name: "fd-v10.3.0-x86_64-apple-darwin.tar.gz",
				archiveSha256: "50d30f13fe3d5914b14c4fff5abcbd4d0cdab4b855970a6956f4f006c17117a3",
				binarySha256: "e3936d70c47bf8439797aa2c6c1ddff868424ff6bc418fc8501e819a2d58ccad",
			},
			"linux/arm64": {
				tag: "v10.4.2",
				name: "fd-v10.4.2-aarch64-unknown-linux-gnu.tar.gz",
				archiveSha256: "6c51f7c5446b3338b1e401ff15dc194c590bb2fa64fd43ff3278300f073adec5",
				binarySha256: "b96a9c5eb1f619efe836e7d5176a9aa15d6643f11c46cda6709ff8abb43eeed4",
			},
			"linux/x64": {
				tag: "v10.4.2",
				name: "fd-v10.4.2-x86_64-unknown-linux-gnu.tar.gz",
				archiveSha256: "def59805cd14b5651b68990855f426ad087f3b96881296d963910431ba3143c8",
				binarySha256: "0dff4a420feb3e57fd1d4402d3e29f46115aa38d962467d2f3b72e7439d3ada8",
			},
			"win32/arm64": {
				tag: "v10.4.2",
				name: "fd-v10.4.2-aarch64-pc-windows-msvc.zip",
				archiveSha256: "4f9110c2d5b33a7f760bfa5510f4c113d828109f7277d421b1053a9943c0fc92",
				binarySha256: "e5f456004d0f550b5a67a0e33415e6d40520c57d1d3860dafca9bd0e24a8f977",
			},
			"win32/x64": {
				tag: "v10.4.2",
				name: "fd-v10.4.2-x86_64-pc-windows-msvc.zip",
				archiveSha256: "b2816e506390a89941c63c9187d58a3cc10e9a55f2ef0685f9ea0eccaf7c98c8",
				binarySha256: "4c9d082ee20f0d9e44881ac4e92adf765efc314d82103c53d7f576bd78dc5761",
			},
		},
	},
	rg: {
		name: "ripgrep",
		repo: "BurntSushi/ripgrep",
		binaryName: "rg",
		assets: {
			"darwin/arm64": {
				tag: "15.2.0",
				name: "ripgrep-15.2.0-aarch64-apple-darwin.tar.gz",
				archiveSha256: "3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4",
				binarySha256: "a326a1fb48074202e9ad41e4cd1e389eeea372c8c6f7d7e80da81176d5d9430e",
			},
			"darwin/x64": {
				tag: "15.2.0",
				name: "ripgrep-15.2.0-x86_64-apple-darwin.tar.gz",
				archiveSha256: "af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1",
				binarySha256: "0c9a0066db0d26b640777db88045b0ccdd58509a746700e43e1c4ff8707a5ed0",
			},
			"linux/arm64": {
				tag: "15.2.0",
				name: "ripgrep-15.2.0-aarch64-unknown-linux-gnu.tar.gz",
				archiveSha256: "a740b91c82eaf9914cfedd353572f2791cbe0162c84101ee0951058f4dcbc90d",
				binarySha256: "e36d0eb52e70696bdf1781392722e05a21bb91d3b7b762ef5ec20e5df2ec687b",
			},
			"linux/x64": {
				tag: "15.2.0",
				name: "ripgrep-15.2.0-x86_64-unknown-linux-musl.tar.gz",
				archiveSha256: "33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c",
				binarySha256: "e62198eb19b136b88c330af83647b5a962cb99b6b1f066758568f12de1974849",
			},
			"win32/arm64": {
				tag: "15.2.0",
				name: "ripgrep-15.2.0-aarch64-pc-windows-msvc.zip",
				archiveSha256: "e4abca10c3a64ebea742667dd7009449d49403db5460dd6873e389fa2945360f",
				binarySha256: "d33a29a9ef03c9f4c03be9e8d88498e6e2d2e566d64cdbdef97f9afc8f13120c",
			},
			"win32/x64": {
				tag: "15.2.0",
				name: "ripgrep-15.2.0-x86_64-pc-windows-msvc.zip",
				archiveSha256: "71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5",
				binarySha256: "14231169855ec5205cf5a1b6f1db358ff4aed4247c86b69ce8aae647c77f6680",
			},
		},
	},
};

export function getManagedToolInstallMetadata(tool: ToolName): ManagedToolInstallMetadata | undefined {
	const asset = TOOLS[tool].assets[`${platform()}/${arch()}`];
	if (!asset) return undefined;
	return {
		manifestVersion: MANAGED_TOOL_MANIFEST_VERSION,
		tool,
		version: asset.tag,
		asset: asset.name,
		archiveSha256: asset.archiveSha256,
		binarySha256: asset.binarySha256,
	};
}

function getManagedToolPaths(tool: ToolName): { binaryPath: string; manifestPath: string } {
	const config = TOOLS[tool];
	const binaryPath = join(TOOLS_DIR, config.binaryName + (platform() === "win32" ? ".exe" : ""));
	return { binaryPath, manifestPath: `${binaryPath}.manifest.json` };
}

function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function isManagedToolManifest(value: unknown): value is ManagedToolInstallMetadata {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const manifest = value as Record<string, unknown>;
	return (
		manifest.manifestVersion === MANAGED_TOOL_MANIFEST_VERSION &&
		(manifest.tool === "fd" || manifest.tool === "rg") &&
		typeof manifest.version === "string" &&
		typeof manifest.asset === "string" &&
		typeof manifest.archiveSha256 === "string" &&
		typeof manifest.binarySha256 === "string"
	);
}

function isTrustedManagedTool(tool: ToolName, binaryPath: string, manifestPath: string): boolean {
	if (!existsSync(binaryPath) || !existsSync(manifestPath)) return false;
	const expected = getManagedToolInstallMetadata(tool);
	if (!expected) return false;

	try {
		const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf-8"));
		return (
			isManagedToolManifest(manifest) &&
			manifest.manifestVersion === expected.manifestVersion &&
			manifest.tool === expected.tool &&
			manifest.version === expected.version &&
			manifest.asset === expected.asset &&
			manifest.archiveSha256 === expected.archiveSha256 &&
			manifest.binarySha256 === expected.binarySha256 &&
			sha256File(binaryPath) === expected.binarySha256
		);
	} catch {
		return false;
	}
}

function removeUntrustedManagedTool(binaryPath: string, manifestPath: string): void {
	rmSync(binaryPath, { force: true });
	rmSync(manifestPath, { force: true });
}

// Check if a command exists in PATH by trying to run it
function commandExists(cmd: string): boolean {
	try {
		const result = spawnSync(cmd, ["--version"], { stdio: "pipe" });
		// Check for ENOENT error (command not found)
		return result.error === undefined || result.error === null;
	} catch {
		return false;
	}
}

// Get the path to a tool (system-wide or in our tools dir)
export function getToolPath(tool: ToolName): string | null {
	const config = TOOLS[tool];
	if (!config) return null;

	// Check our tools directory first
	const { binaryPath, manifestPath } = getManagedToolPaths(tool);
	if (isTrustedManagedTool(tool, binaryPath, manifestPath)) {
		return binaryPath;
	}
	if (existsSync(binaryPath) || existsSync(manifestPath)) {
		removeUntrustedManagedTool(binaryPath, manifestPath);
	}

	// Check system PATH - if found, just return the command name (it's in PATH)
	const systemBinaryNames = config.systemBinaryNames ?? [config.binaryName];
	for (const systemBinaryName of systemBinaryNames) {
		if (commandExists(systemBinaryName)) {
			return systemBinaryName;
		}
	}

	return null;
}

// Download a file from URL
export async function downloadFile(url: string, dest: string, expectedSha256: string): Promise<void> {
	try {
		const response = await fetchWithRetry(url, undefined, { timeoutMs: DOWNLOAD_TIMEOUT_MS });
		if (!response.ok) throw new Error(`Failed to download: ${response.status}`);
		if (!response.body) throw new Error("No response body");

		await pipeline(
			Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>),
			createWriteStream(dest, { flags: "wx" }),
		);
		const hash = createHash("sha256");
		for await (const chunk of createReadStream(dest)) hash.update(chunk);
		const actualSha256 = hash.digest("hex");
		if (actualSha256 !== expectedSha256) {
			throw new Error(`SHA-256 mismatch: expected ${expectedSha256}, received ${actualSha256}`);
		}
	} catch (error) {
		rmSync(dest, { force: true });
		throw error;
	}
}

function findBinaryRecursively(rootDir: string, binaryFileName: string): string | null {
	const stack: string[] = [rootDir];

	while (stack.length > 0) {
		const currentDir = stack.pop();
		if (!currentDir) continue;

		const entries = readdirSync(currentDir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = join(currentDir, entry.name);
			if (entry.isFile() && entry.name === binaryFileName) {
				return fullPath;
			}
			if (entry.isDirectory()) {
				stack.push(fullPath);
			}
		}
	}

	return null;
}

function formatSpawnFailure(result: SpawnSyncReturns<Buffer>): string {
	if (result.error?.message) {
		return result.error.message;
	}
	const stderr = result.stderr?.toString().trim();
	if (stderr) {
		return stderr;
	}
	const stdout = result.stdout?.toString().trim();
	if (stdout) {
		return stdout;
	}
	return `exit status ${result.status ?? "unknown"}`;
}

function runExtractionCommand(command: string, args: string[]): string | null {
	const result = spawnSync(command, args, { stdio: "pipe" });
	if (!result.error && result.status === 0) {
		return null;
	}
	return `${command}: ${formatSpawnFailure(result)}`;
}

function extractTarGzArchive(archivePath: string, extractDir: string, assetName: string): void {
	const failure = runExtractionCommand("tar", ["xzf", archivePath, "-C", extractDir]);
	if (failure) {
		throw new Error(`Failed to extract ${assetName}: ${failure}`);
	}
}

function getWindowsTarCommand(): string {
	const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
	if (systemRoot) {
		const systemTar = join(systemRoot, "System32", "tar.exe");
		if (existsSync(systemTar)) {
			return systemTar;
		}
	}
	return "tar.exe";
}

function extractZipArchive(archivePath: string, extractDir: string, assetName: string): void {
	const failures: string[] = [];

	if (platform() === "win32") {
		// Windows ships bsdtar as tar.exe, which supports zip files. Prefer the
		// System32 binary over Git Bash's GNU tar, which does not handle zip archives.
		const tarFailure = runExtractionCommand(getWindowsTarCommand(), ["xf", archivePath, "-C", extractDir]);
		if (!tarFailure) return;
		failures.push(tarFailure);

		const script =
			"& { param($archive, $destination) $ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force }";
		const powershellFailure = runExtractionCommand("powershell.exe", [
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
			script,
			archivePath,
			extractDir,
		]);
		if (!powershellFailure) return;
		failures.push(powershellFailure);
	} else {
		const unzipFailure = runExtractionCommand("unzip", ["-q", archivePath, "-d", extractDir]);
		if (!unzipFailure) return;
		failures.push(unzipFailure);

		const tarFailure = runExtractionCommand("tar", ["xf", archivePath, "-C", extractDir]);
		if (!tarFailure) return;
		failures.push(tarFailure);
	}

	throw new Error(`Failed to extract ${assetName}: ${failures.join("; ")}`);
}

// Download and install a tool
async function downloadTool(tool: ToolName): Promise<string> {
	const config = TOOLS[tool];
	const plat = platform();
	const architecture = arch();
	const asset = config.assets[`${plat}/${architecture}`];
	if (!asset) throw new Error(`Unsupported platform: ${plat}/${architecture}`);

	mkdirSync(TOOLS_DIR, { recursive: true });
	const installDir = mkdtempSync(join(TOOLS_DIR, `.install-${config.binaryName}-`));
	const archivePath = join(installDir, asset.name);
	const extractDir = join(installDir, "extract");
	const binaryExt = plat === "win32" ? ".exe" : "";
	const { binaryPath, manifestPath } = getManagedToolPaths(tool);
	const downloadUrl = `https://github.com/${config.repo}/releases/download/${asset.tag}/${asset.name}`;

	try {
		await downloadFile(downloadUrl, archivePath, asset.archiveSha256);
		mkdirSync(extractDir);
		if (asset.name.endsWith(".tar.gz")) {
			extractTarGzArchive(archivePath, extractDir, asset.name);
		} else if (asset.name.endsWith(".zip")) {
			extractZipArchive(archivePath, extractDir, asset.name);
		} else {
			throw new Error(`Unsupported archive format: ${asset.name}`);
		}

		const binaryFileName = config.binaryName + binaryExt;
		const extractedDir = join(extractDir, asset.name.replace(/\.(tar\.gz|zip)$/, ""));
		const extractedBinary =
			[join(extractedDir, binaryFileName), join(extractDir, binaryFileName)].find((candidate) =>
				existsSync(candidate),
			) ?? findBinaryRecursively(extractDir, binaryFileName);
		if (!extractedBinary) {
			throw new Error(`Binary not found in archive: expected ${binaryFileName} under ${extractDir}`);
		}

		const binarySha256 = sha256File(extractedBinary);
		if (binarySha256 !== asset.binarySha256) {
			throw new Error(
				`SHA-256 mismatch for extracted ${binaryFileName}: expected ${asset.binarySha256}, received ${binarySha256}`,
			);
		}
		if (plat !== "win32") chmodSync(extractedBinary, 0o755);
		const manifest: ManagedToolInstallMetadata = {
			manifestVersion: MANAGED_TOOL_MANIFEST_VERSION,
			tool,
			version: asset.tag,
			asset: asset.name,
			archiveSha256: asset.archiveSha256,
			binarySha256: asset.binarySha256,
		};
		const stagedManifest = join(installDir, "manifest.json");
		writeFileSync(stagedManifest, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });

		const trustedPath = isTrustedManagedTool(tool, binaryPath, manifestPath) ? binaryPath : undefined;
		if (trustedPath) return trustedPath;
		removeUntrustedManagedTool(binaryPath, manifestPath);
		renameSync(extractedBinary, binaryPath);
		renameSync(stagedManifest, manifestPath);
		return binaryPath;
	} finally {
		rmSync(installDir, { recursive: true, force: true });
	}
}

const activeDownloads = new Map<ToolName, Promise<string>>();

async function downloadToolOnce(tool: ToolName): Promise<string> {
	const active = activeDownloads.get(tool);
	if (active) return active;

	const download = downloadTool(tool);
	activeDownloads.set(tool, download);
	try {
		return await download;
	} finally {
		if (activeDownloads.get(tool) === download) activeDownloads.delete(tool);
	}
}

// Termux package names for tools
const TERMUX_PACKAGES: Record<string, string> = {
	fd: "fd",
	rg: "ripgrep",
};

export interface ToolStatus {
	type: "info" | "warning";
	message: string;
}

/**
 * Ensure a tool is available, downloading if necessary.
 * Reports progress through `onStatus`; status messages are otherwise silent.
 * Returns the tool path, or undefined if unavailable.
 */
export async function ensureTool(tool: ToolName, onStatus?: (status: ToolStatus) => void): Promise<string | undefined> {
	const existingPath = getToolPath(tool);
	if (existingPath) {
		return existingPath;
	}

	const config = TOOLS[tool];
	if (!config) return undefined;

	if (isOfflineModeEnabled()) {
		onStatus?.({ type: "warning", message: `${config.name} not found. Offline mode enabled, skipping download.` });
		return undefined;
	}

	// On Android/Termux, Linux binaries don't work due to Bionic libc incompatibility.
	// Users must install via pkg.
	if (platform() === "android") {
		const pkgName = TERMUX_PACKAGES[tool] ?? tool;
		onStatus?.({ type: "warning", message: `${config.name} not found. Install with: pkg install ${pkgName}` });
		return undefined;
	}

	// Tool not found - download it
	onStatus?.({ type: "info", message: `${config.name} not found. Downloading...` });

	try {
		const path = await downloadToolOnce(tool);
		onStatus?.({ type: "info", message: `${config.name} installed to ${path}` });
		return path;
	} catch (e) {
		onStatus?.({
			type: "warning",
			message: `Failed to download ${config.name}: ${e instanceof Error ? e.message : e}`,
		});
		return undefined;
	}
}
