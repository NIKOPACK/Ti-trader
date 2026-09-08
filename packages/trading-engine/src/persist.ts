import {
	chmodSync,
	closeSync,
	existsSync,
	fstatSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

export const DEFAULT_FILE_LOCK = {
	timeoutMs: 10_000,
	staleMs: 60_000,
	retryMs: 10,
} as const;

export interface FileLock {
	fd: number;
	path: string;
	device: number;
	inode: number;
}

export interface FileLockOptions {
	timeoutMs?: number;
	staleMs?: number;
	retryMs?: number;
	timeoutMessage?: (path: string) => string;
}

function fsErrorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

export function readJsonFile(path: string): unknown | undefined {
	if (!existsSync(path)) return undefined;
	return JSON.parse(readFileSync(path, "utf8"));
}

export function writeJsonFile(path: string, data: unknown, mode?: number): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	const body = `${JSON.stringify(data, null, "\t")}\n`;
	if (mode === undefined) {
		writeFileSync(temporaryPath, body);
		renameSync(temporaryPath, path);
		return;
	}

	writeFileSync(temporaryPath, body, { encoding: "utf8", mode });
	chmodSync(temporaryPath, mode);
	renameSync(temporaryPath, path);
	chmodSync(path, mode);
}

function syncPath(path: string): void {
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function ensureDirectoryDurable(path: string): void {
	const missing = !existsSync(path);
	mkdirSync(path, { recursive: true });
	if (missing) syncDirectoryTree(path);
}

function syncDirectoryTree(path: string): void {
	for (let directory = resolve(path); ; directory = dirname(directory)) {
		syncPath(directory);
		if (dirname(directory) === directory) return;
	}
}

/** Commit both file contents and the renamed directory entry before dependent state may advance. */
export function syncFileAndDirectory(path: string): void {
	syncPath(path);
	// Ancestors also cover directories left present but unflushed by an earlier failed creation.
	syncDirectoryTree(dirname(path));
}

export function writeJsonFileDurable(path: string, data: unknown, mode?: number): void {
	ensureDirectoryDurable(dirname(path));
	writeJsonFile(path, data, mode);
	syncFileAndDirectory(path);
}

export function removeFileDurable(path: string): void {
	unlinkSync(path);
	syncDirectoryTree(dirname(path));
}

function resolvedLockOptions(options: FileLockOptions = {}): {
	timeoutMs: number;
	staleMs: number;
	retryMs: number;
	timeoutMessage: (path: string) => string;
} {
	return {
		timeoutMs: options.timeoutMs ?? DEFAULT_FILE_LOCK.timeoutMs,
		staleMs: options.staleMs ?? DEFAULT_FILE_LOCK.staleMs,
		retryMs: options.retryMs ?? DEFAULT_FILE_LOCK.retryMs,
		timeoutMessage: options.timeoutMessage ?? ((path) => `Timed out waiting for file lock ${path}`),
	};
}

function isStaleLock(path: string, staleMs: number): boolean {
	try {
		return Date.now() - statSync(path).mtimeMs > staleMs;
	} catch (error) {
		if (fsErrorCode(error) === "ENOENT") return false;
		throw error;
	}
}

function tryCreateLock(path: string): FileLock {
	const fd = openSync(path, "wx", 0o600);
	try {
		const stats = fstatSync(fd);
		return { fd, path, device: stats.dev, inode: stats.ino };
	} catch (error) {
		try {
			closeSync(fd);
		} finally {
			try {
				unlinkSync(path);
			} catch {
				// Preserve the original fstat failure.
			}
		}
		throw error;
	}
}

function reclaimOrWaitForLock(
	path: string,
	options: ReturnType<typeof resolvedLockOptions>,
	deadline: number,
): "retry" | "wait" {
	if (isStaleLock(path, options.staleMs)) {
		try {
			unlinkSync(path);
		} catch (unlinkError) {
			if (fsErrorCode(unlinkError) !== "ENOENT") throw unlinkError;
		}
		return "retry";
	}
	if (Date.now() >= deadline) throw new Error(options.timeoutMessage(path));
	return "wait";
}

export function acquireFileLockSync(path: string, options: FileLockOptions = {}): FileLock {
	const resolved = resolvedLockOptions(options);
	ensureDirectoryDurable(dirname(path));
	const deadline = Date.now() + resolved.timeoutMs;
	for (;;) {
		try {
			return tryCreateLock(path);
		} catch (error) {
			if (fsErrorCode(error) !== "EEXIST") throw error;
			if (reclaimOrWaitForLock(path, resolved, deadline) === "retry") continue;
			const signal = new Int32Array(new SharedArrayBuffer(4));
			Atomics.wait(signal, 0, 0, resolved.retryMs);
		}
	}
}

export async function acquireFileLock(path: string, options: FileLockOptions = {}): Promise<FileLock> {
	const resolved = resolvedLockOptions(options);
	ensureDirectoryDurable(dirname(path));
	const deadline = Date.now() + resolved.timeoutMs;
	for (;;) {
		try {
			return tryCreateLock(path);
		} catch (error) {
			if (fsErrorCode(error) !== "EEXIST") throw error;
			if (reclaimOrWaitForLock(path, resolved, deadline) === "retry") continue;
			await new Promise<void>((resolve) => setTimeout(resolve, resolved.retryMs));
		}
	}
}

export function releaseFileLock(lock: FileLock): void {
	let failure: unknown;
	try {
		closeSync(lock.fd);
	} catch (error) {
		failure = error;
	}
	try {
		const stats = statSync(lock.path);
		if (stats.dev === lock.device && stats.ino === lock.inode) unlinkSync(lock.path);
	} catch (error) {
		if (fsErrorCode(error) !== "ENOENT" && failure === undefined) failure = error;
	}
	if (failure !== undefined) throw failure;
}

export function touchFileLock(lock: FileLock): void {
	try {
		const stats = statSync(lock.path);
		if (stats.dev !== lock.device || stats.ino !== lock.inode) return;
		const now = new Date();
		utimesSync(lock.path, now, now);
	} catch {
		// The owner check in releaseFileLock prevents deleting a lock that was
		// replaced by another process. A failed heartbeat is therefore handled by
		// the normal operation/release error path.
	}
}

export function withFileLockSync<T>(path: string, operation: () => T, options: FileLockOptions = {}): T {
	const lock = acquireFileLockSync(path, options);
	let operationResult: { completed: true; result: T } | { completed: false; error: unknown };
	try {
		operationResult = { completed: true, result: operation() };
	} catch (error) {
		operationResult = { completed: false, error };
	}
	try {
		releaseFileLock(lock);
	} catch (error) {
		if (!operationResult.completed) throw operationResult.error;
		throw error;
	}
	if (!operationResult.completed) throw operationResult.error;
	return operationResult.result;
}
