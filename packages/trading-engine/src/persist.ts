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
import { hostname } from "node:os";
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
	reclaimDeadOwner?: boolean;
	timeoutMs?: number;
	staleMs?: number;
	retryMs?: number;
	timeoutMessage?: (path: string) => string;
}

export type DurableWritePhase = "directory" | "write" | "file-fsync" | "rename" | "directory-fsync";
export type DurableWritePublication = "not-published" | "possibly-published";

export class DurableWriteError extends Error {
	readonly path: string;
	readonly phase: DurableWritePhase;
	readonly publication: DurableWritePublication;

	constructor(path: string, phase: DurableWritePhase, publication: DurableWritePublication, cause: unknown) {
		super(
			`Durable write failed during ${phase}; target is ${publication}: ${cause instanceof Error ? cause.message : String(cause)}`,
			{ cause },
		);
		this.name = "DurableWriteError";
		this.path = path;
		this.phase = phase;
		this.publication = publication;
	}
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
	try {
		ensureDirectoryDurable(dirname(path));
	} catch (error) {
		throw new DurableWriteError(path, "directory", "not-published", error);
	}

	const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	const body = `${JSON.stringify(data, null, "\t")}\n`;
	try {
		if (mode === undefined) writeFileSync(temporaryPath, body);
		else {
			writeFileSync(temporaryPath, body, { encoding: "utf8", mode });
			chmodSync(temporaryPath, mode);
		}
	} catch (error) {
		try {
			unlinkSync(temporaryPath);
		} catch {
			// Preserve the write failure that determines publication status.
		}
		throw new DurableWriteError(path, "write", "not-published", error);
	}

	try {
		syncPath(temporaryPath);
	} catch (error) {
		try {
			unlinkSync(temporaryPath);
		} catch {
			// Preserve the fsync failure that determines publication status.
		}
		throw new DurableWriteError(path, "file-fsync", "not-published", error);
	}

	try {
		renameSync(temporaryPath, path);
	} catch (error) {
		try {
			unlinkSync(temporaryPath);
		} catch {
			// Preserve the rename failure that determines publication status.
		}
		throw new DurableWriteError(path, "rename", "not-published", error);
	}

	try {
		// Syncing all ancestors also repairs directories left unflushed by an earlier failed creation.
		syncDirectoryTree(dirname(path));
	} catch (error) {
		throw new DurableWriteError(path, "directory-fsync", "possibly-published", error);
	}
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
	reclaimDeadOwner: boolean;
} {
	return {
		reclaimDeadOwner: options.reclaimDeadOwner ?? false,
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
		writeFileSync(fd, JSON.stringify({ pid: process.pid, host: hostname() }));
		fsyncSync(fd);
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

function reclaimDeadOwner(path: string): boolean {
	let gate: FileLock;
	try {
		gate = tryCreateLock(`${path}.reclaim`);
	} catch (error) {
		if (fsErrorCode(error) === "EEXIST") return false;
		throw error;
	}
	try {
		let owner: unknown;
		try {
			owner = readJsonFile(path);
		} catch (error) {
			if (error instanceof SyntaxError || fsErrorCode(error) === "ENOENT") return false;
			throw error;
		}
		if (
			!owner ||
			typeof owner !== "object" ||
			!("host" in owner) ||
			owner.host !== hostname() ||
			!("pid" in owner) ||
			typeof owner.pid !== "number" ||
			!Number.isSafeInteger(owner.pid) ||
			owner.pid <= 0
		)
			return false;
		try {
			process.kill(owner.pid, 0);
			return false;
		} catch (error) {
			if (fsErrorCode(error) !== "ESRCH") throw error;
		}
		removeFileDurable(path);
		return true;
	} finally {
		releaseFileLock(gate);
	}
}

function reclaimStaleLock(path: string, staleMs: number): boolean {
	if (!isStaleLock(path, staleMs)) return false;
	// Serialize reclaimers through the same gate as dead-owner recovery.
	// Without the gate, two waiters that both observe a stale lock can race:
	// the first reclaims and installs a fresh lock, and the second waiter's
	// unlink then removes that live replacement, leaving two lock owners.
	let gate: FileLock;
	try {
		gate = tryCreateLock(`${path}.reclaim`);
	} catch (error) {
		// Another reclaimer owns the gate; it will finish the reclamation, so
		// wait for the next loop iteration instead of touching the lock file.
		if (fsErrorCode(error) === "EEXIST") return false;
		throw error;
	}
	try {
		// Re-check under the gate: the other reclaimer may have already removed
		// the stale lock and installed a fresh one while we waited for the gate.
		// A fresh lock is not stale and must never be unlinked here.
		if (!isStaleLock(path, staleMs)) return false;
		try {
			unlinkSync(path);
		} catch (unlinkError) {
			if (fsErrorCode(unlinkError) !== "ENOENT") throw unlinkError;
		}
		return true;
	} finally {
		releaseFileLock(gate);
	}
}

function reclaimOrWaitForLock(
	path: string,
	options: ReturnType<typeof resolvedLockOptions>,
	deadline: number,
): "retry" | "wait" {
	if (options.reclaimDeadOwner && reclaimDeadOwner(path)) return "retry";
	if (reclaimStaleLock(path, options.staleMs)) return "retry";
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
