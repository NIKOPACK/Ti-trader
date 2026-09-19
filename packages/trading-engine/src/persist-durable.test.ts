import type * as Fs from "node:fs";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DurableWriteError, readJsonFile, writeJsonFileDurable } from "./persist.ts";

type Fault = "write" | "file-fsync" | "rename" | "directory-fsync";

const faults = vi.hoisted(() => ({
	directory: "",
	fail: undefined as Fault | undefined,
	handles: new Map<number, string>(),
	events: [] as string[],
}));

vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof Fs>();
	return {
		...fs,
		writeFileSync: (...args: Parameters<typeof Fs.writeFileSync>) => {
			const path = resolve(String(args[0]));
			faults.events.push(`write:${path}`);
			if (faults.fail === "write" && path.endsWith(".tmp")) throw new Error("injected write failure");
			return fs.writeFileSync(...args);
		},
		openSync: (...args: Parameters<typeof Fs.openSync>) => {
			const fd = fs.openSync(...args);
			faults.handles.set(fd, resolve(String(args[0])));
			return fd;
		},
		fsyncSync: (fd: number) => {
			const path = faults.handles.get(fd)!;
			faults.events.push(`fsync:${path}`);
			if (faults.fail === "file-fsync" && path.endsWith(".tmp")) throw new Error("injected file fsync failure");
			if (faults.fail === "directory-fsync" && path === faults.directory) {
				throw new Error("injected directory fsync failure");
			}
			fs.fsyncSync(fd);
		},
		closeSync: (fd: number) => {
			faults.handles.delete(fd);
			fs.closeSync(fd);
		},
		renameSync: (...args: Parameters<typeof Fs.renameSync>) => {
			const source = resolve(String(args[0]));
			const target = resolve(String(args[1]));
			faults.events.push(`rename:${source}->${target}`);
			if (faults.fail === "rename") throw new Error("injected rename failure");
			fs.renameSync(...args);
		},
	};
});

describe("durable JSON writes", () => {
	let directory: string;
	let path: string;

	beforeEach(() => {
		directory = resolve(mkdtempSync(join(tmpdir(), "ti-durable-write-")));
		faults.directory = directory;
		path = join(directory, "state.json");
		writeJsonFileDurable(path, { revision: 1 });
		faults.events.length = 0;
	});

	afterEach(() => {
		faults.fail = undefined;
		faults.events.length = 0;
		rmSync(directory, { recursive: true, force: true });
	});

	it("flushes the temporary file before publishing and then flushes the parent directory", () => {
		writeJsonFileDurable(path, { revision: 2 });
		const temporaryPath = faults.events.find((event) => event.startsWith("write:"))!.slice("write:".length);
		expect(faults.events.slice(0, 4)).toEqual([
			`write:${temporaryPath}`,
			`fsync:${temporaryPath}`,
			`rename:${temporaryPath}->${resolve(path)}`,
			`fsync:${directory}`,
		]);
	});

	it.each([
		["write", "write", "not-published", 1],
		["file-fsync", "file-fsync", "not-published", 1],
		["rename", "rename", "not-published", 1],
		["directory-fsync", "directory-fsync", "possibly-published", 2],
	] as const)(
		"reports %s failure publication and recovers the observable state after restart",
		(fault, phase, publication, revision) => {
			faults.fail = fault;
			let failure: unknown;
			try {
				writeJsonFileDurable(path, { revision: 2 });
			} catch (error) {
				failure = error;
			}
			expect(failure).toBeInstanceOf(DurableWriteError);
			expect(failure).toMatchObject({ phase, publication, path });
			faults.fail = undefined;
			expect(readJsonFile(path)).toEqual({ revision });
			expect(readdirSync(directory).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
		},
	);
});
