import type * as ChildProcess from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithRetry } from "../src/utils/management-http.ts";
import {
	downloadFile,
	ensureTool,
	getManagedToolInstallMetadata,
	getToolPath,
	type ToolStatus,
} from "../src/utils/tools-manager.ts";

const originalOffline = process.env.PI_OFFLINE;
const managedBinDir = vi.hoisted(() => `${process.env.TMPDIR ?? "/tmp"}/ti-tools-manager-${process.pid}`);

vi.mock("../src/config.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/config.ts")>();
	return {
		...actual,
		getBinDir: () => managedBinDir,
	};
});

vi.mock("child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof ChildProcess>();
	return {
		...actual,
		spawnSync: vi.fn(() => ({ error: new Error("not found") })),
	};
});

vi.mock("../src/utils/management-http.ts", () => ({ fetchWithRetry: vi.fn() }));

const fetchMock = vi.mocked(fetchWithRetry);
const tempDirs: string[] = [];

function sha256(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

async function tempPath(fileName: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "ti-tools-manager-"));
	tempDirs.push(directory);
	return join(directory, fileName);
}

afterEach(async () => {
	if (originalOffline === undefined) delete process.env.PI_OFFLINE;
	else process.env.PI_OFFLINE = originalOffline;
	fetchMock.mockReset();
	await rm(managedBinDir, { recursive: true, force: true });
	await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function writeManagedTool(tool: "fd" | "rg", content: string, manifestOverride?: Record<string, unknown>): string {
	const metadata = getManagedToolInstallMetadata(tool);
	if (!metadata) throw new Error("Unsupported test platform");
	const binaryName = `${tool}${platform() === "win32" ? ".exe" : ""}`;
	const binaryPath = join(managedBinDir, binaryName);
	mkdirSync(managedBinDir, { recursive: true });
	writeFileSync(binaryPath, content);
	writeFileSync(`${binaryPath}.manifest.json`, JSON.stringify({ ...metadata, ...manifestOverride }));
	return binaryPath;
}

describe("ensureTool", () => {
	it("reports status through a callback without writing to the console", async () => {
		process.env.PI_OFFLINE = "1";
		const statuses: ToolStatus[] = [];
		const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

		const result = await ensureTool("fd", (status) => statuses.push(status));

		expect(result).toBeUndefined();
		expect(statuses).toEqual([
			{
				type: "warning",
				message: "fd not found. Offline mode enabled, skipping download.",
			},
		]);
		expect(consoleLog).not.toHaveBeenCalled();
		consoleLog.mockRestore();
	});

	it("removes a legacy managed binary without an install manifest", () => {
		const binaryPath = writeManagedTool("fd", "legacy binary");
		rmSync(`${binaryPath}.manifest.json`);

		expect(getToolPath("fd")).toBeNull();
		expect(existsSync(binaryPath)).toBe(false);
	});

	it("rejects a forged binary even when its manifest copies trusted metadata", () => {
		const binaryPath = writeManagedTool("rg", "forged binary");

		expect(getToolPath("rg")).toBeNull();
		expect(existsSync(binaryPath)).toBe(false);
	});

	it("rejects a forged manifest that vouches for forged binary bytes", () => {
		const content = "forged binary";
		const binaryPath = writeManagedTool("fd", content, { binarySha256: sha256(content) });

		expect(getToolPath("fd")).toBeNull();
		expect(existsSync(binaryPath)).toBe(false);
		expect(existsSync(`${binaryPath}.manifest.json`)).toBe(false);
	});
});

describe("downloadFile", () => {
	it("writes a download only when its SHA-256 matches", async () => {
		const content = "verified archive";
		const destination = await tempPath("tool.tar.gz");
		fetchMock.mockResolvedValue(new Response(content));

		await downloadFile("https://example.test/tool.tar.gz", destination, sha256(content));

		expect(await readFile(destination, "utf8")).toBe(content);
	});

	it("removes a download when its SHA-256 does not match", async () => {
		const destination = await tempPath("tool.tar.gz");
		fetchMock.mockResolvedValue(new Response("tampered archive"));

		await expect(
			downloadFile("https://example.test/tool.tar.gz", destination, sha256("verified archive")),
		).rejects.toThrow(/SHA-256 mismatch/);
		await expect(access(destination)).rejects.toThrow();
	});

	it("rejects and removes a truncated download", async () => {
		const complete = "complete archive bytes";
		const destination = await tempPath("tool.tar.gz");
		fetchMock.mockResolvedValue(new Response(complete.slice(0, 8)));

		await expect(downloadFile("https://example.test/tool.tar.gz", destination, sha256(complete))).rejects.toThrow(
			/SHA-256 mismatch/,
		);
		await expect(access(destination)).rejects.toThrow();
	});

	it("keeps concurrent downloads isolated", async () => {
		const downloads = new Map([
			["https://example.test/fd.tar.gz", "fd archive"],
			["https://example.test/rg.tar.gz", "rg archive"],
		]);
		fetchMock.mockImplementation(async (url) => new Response(downloads.get(String(url))));
		const fdPath = await tempPath("fd.tar.gz");
		const rgPath = await tempPath("rg.tar.gz");

		await Promise.all([
			downloadFile("https://example.test/fd.tar.gz", fdPath, sha256("fd archive")),
			downloadFile("https://example.test/rg.tar.gz", rgPath, sha256("rg archive")),
		]);

		expect(await readFile(fdPath, "utf8")).toBe("fd archive");
		expect(await readFile(rgPath, "utf8")).toBe("rg archive");
	});
});
