import type * as Fs from "node:fs";
import { existsSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PaperExchangeClient } from "./paper-client.ts";
import { readJsonFile, writeJsonFileDurable } from "./persist.ts";

const faults = vi.hoisted(() => ({
	handles: new Map<number, string>(),
	events: [] as string[],
	fail: undefined as ((path: string) => boolean) | undefined,
}));
vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof Fs>();
	return {
		...fs,
		openSync: (...args: Parameters<typeof Fs.openSync>) => {
			const fd = fs.openSync(...args);
			faults.handles.set(fd, resolve(String(args[0])));
			return fd;
		},
		fsyncSync: (fd: number) => {
			const path = faults.handles.get(fd)!;
			faults.events.push(`sync:${path}`);
			if (faults.fail?.(path)) throw new Error("injected durable sync failure");
			fs.fsyncSync(fd);
		},
		closeSync: (fd: number) => {
			faults.handles.delete(fd);
			fs.closeSync(fd);
		},
		unlinkSync: (path: Fs.PathLike) => {
			faults.events.push(`remove:${resolve(String(path))}`);
			fs.unlinkSync(path);
		},
	};
});

const root = `.paper-durability-${process.pid}-${Date.now()}`;
const directory = join(root, "accounts");
const spot = resolve(directory, "binance-USDT.json");
const futures = resolve(directory, "binance-USDT-futures.json");
const marker = resolve(directory, "binance-USDT.transaction.json");
const createClient = () => new PaperExchangeClient("binance", "USDT", 1000, 0.001, directory, "both");

afterEach(() => {
	vi.restoreAllMocks();
	faults.fail = undefined;
	faults.events.length = 0;
	rmSync(root, { recursive: true, force: true });
});

describe("durable Paper transaction protocol", () => {
	it("never takes over an old account lock while its writer might still resume", async () => {
		const client = createClient();
		await client.close();
		const lock = join(directory, "binance-USDT.lock");
		writeFileSync(lock, "");
		utimesSync(lock, new Date("2000-01-01"), new Date("2000-01-01"));
		const inode = statSync(lock).ino;
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => {
			now += 11_000;
			return now;
		});
		expect(createClient).toThrow(/Timed out waiting for paper account lock/);
		expect(statSync(lock).ino).toBe(inode);
	});

	it("flushes the redo marker, both snapshots, and marker removal in order", async () => {
		const client = createClient();
		faults.events.length = 0;
		await client.resetAccount(2000);
		const relevant = new Set([spot, futures, marker, resolve(directory)]);
		expect(faults.events.filter((event) => relevant.has(event.slice(event.indexOf(":") + 1)))).toEqual([
			`sync:${marker}`,
			`sync:${resolve(directory)}`,
			`sync:${spot}`,
			`sync:${resolve(directory)}`,
			`sync:${futures}`,
			`sync:${resolve(directory)}`,
			`remove:${marker}`,
			`sync:${resolve(directory)}`,
		]);
		await client.close();
	});

	it.each(["marker", "spot", "futures", "removal"] as const)(
		"fails closed at %s durability and recovers both snapshots on restart",
		async (boundary) => {
			const client = createClient();
			faults.fail = (path) =>
				boundary === "removal"
					? path === resolve(directory) && !existsSync(marker)
					: path === { marker, spot, futures }[boundary];
			await expect(client.resetAccount(2000)).rejects.toThrow(/injected durable sync failure/);
			expect(existsSync(marker)).toBe(boundary !== "removal");
			faults.fail = undefined;
			await client.close();
			const recovered = createClient();
			expect(readJsonFile(spot)).toMatchObject({ balances: { USDT: 2000 } });
			expect(readJsonFile(futures)).toMatchObject({ balances: { USDT: 2000 } });
			expect(existsSync(marker)).toBe(false);
			await recovered.close();
		},
	);

	it("retains the redo marker when a recovery snapshot cannot be flushed", async () => {
		const client = createClient();
		faults.fail = (path) => path === spot;
		await expect(client.resetAccount(2000)).rejects.toThrow(/sync failure/);
		await client.close();
		faults.fail = (path) => path === futures;
		expect(createClient).toThrow(/sync failure/);
		expect(existsSync(marker)).toBe(true);
		faults.fail = undefined;
		const recovered = createClient();
		expect(readJsonFile(spot)).toMatchObject({ balances: { USDT: 2000 } });
		expect(readJsonFile(futures)).toMatchObject({ balances: { USDT: 2000 } });
		expect(existsSync(marker)).toBe(false);
		await recovered.close();
	});

	it("flushes ancestor directory entries even after a failed directory creation left them present", () => {
		const path = join(root, "fresh", "nested", "state.json");
		faults.fail = (path) => path === resolve(root);
		expect(() => writeJsonFileDurable(path, { value: 1 })).toThrow(/sync failure/);
		faults.fail = undefined;
		faults.events.length = 0;
		writeJsonFileDurable(path, { value: 2 });
		expect(readJsonFile(path)).toEqual({ value: 2 });
		expect(faults.events).toContain(`sync:${resolve(root)}`);
		expect(faults.events).toContain(`sync:${resolve(root, "fresh")}`);
		expect(faults.events).toContain(`sync:${resolve(root, "fresh", "nested")}`);
	});
});
