import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";

/** The shared file is deliberately extensible: unrelated sections survive every update. */
export interface AuthStore extends Record<string, unknown> {
	version?: 1;
	apiKeys?: Record<string, string>;
	codex?: unknown;
	hostId?: string;
	codexRevision?: string;
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Availability reads are snapshots. Writers must use strict reads under the lock. */
export function readAuthStore(file: string, strict = false): AuthStore {
	try {
		const value: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (
			!record(value) ||
			(value.version !== undefined && value.version !== 1) ||
			(value.apiKeys !== undefined &&
				(!record(value.apiKeys) || Object.values(value.apiKeys).some((key) => typeof key !== "string")))
		) {
			throw new Error("Invalid store shape");
		}
		return value as AuthStore;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		if (strict) throw new Error("Cannot update the authentication store: it is unreadable or corrupt.");
		return {};
	}
}

export function cancellationError(): Error {
	return new Error("ChatGPT authentication cancelled");
}

/** Detaches its listener on every outcome; does not cancel the underlying work. */
export function waitWithSignal<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return work;
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(cancellationError());
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
		work.then(
			(value) => {
				signal.removeEventListener("abort", abort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", abort);
				reject(error);
			},
		);
	});
}

export async function delayWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) throw cancellationError();
	await new Promise<void>((resolve, reject) => {
		const finish = () => {
			signal?.removeEventListener("abort", abort);
			resolve();
		};
		const timer = setTimeout(finish, ms);
		const abort = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			reject(cancellationError());
		};
		signal?.addEventListener("abort", abort, { once: true });
	});
}

export interface LockedAuthStore {
	store: AuthStore;
	/** Atomic owner-only replacement; an optional signal cancels before rename is submitted. */
	write(options?: { signal?: AbortSignal }): Promise<void>;
}

/**
 * All writers (including API keys) use the same path-based cross-process lock.
 * Locking an inode is incorrect here because an atomic rename replaces that inode.
 */
export async function withAuthStoreLock<T>(
	file: string,
	work: (locked: LockedAuthStore) => Promise<T>,
	options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
	if (options.signal?.aborted) throw cancellationError();
	const absolute = path.resolve(file);
	await mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
	// Canonicalize the directory, even for a file that does not yet exist.
	const canonical = path.join(await realpath(path.dirname(absolute)), path.basename(absolute));
	const timeoutMs = options.timeoutMs ?? 30_000;
	const deadline = Date.now() + timeoutMs;
	let compromised = false;
	let release: (() => Promise<void>) | undefined;
	while (!release) {
		if (options.signal?.aborted) throw cancellationError();
		try {
			release = await lockfile.lock(canonical, {
				realpath: false,
				retries: 0,
				stale: 60_000,
				update: 5_000,
				onCompromised: () => {
					compromised = true;
				},
			});
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ELOCKED") {
				throw new Error("Cannot lock the authentication store.");
			}
			if (Date.now() >= deadline)
				throw new Error(`Authentication store lock timed out after ${timeoutMs} ms.`);
			await delayWithSignal(Math.min(40, Math.max(1, deadline - Date.now())), options.signal);
		}
	}
	const assertLock = () => {
		if (compromised) throw new Error("Authentication store lock was lost; update refused.");
	};
	try {
		if (options.signal?.aborted) throw cancellationError();
		// Do not follow a file symlink: two aliases would otherwise use different locks.
		try {
			if (!lstatSync(canonical).isFile()) throw new Error("Unsafe authentication store path.");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				throw new Error("Authentication store must be a regular file, not a symlink or directory.");
			}
		}
		assertLock();
		const store = readAuthStore(canonical, true);
		return await work({
			store,
			async write(writeOptions = {}) {
				assertLock();
				if (writeOptions.signal?.aborted) throw cancellationError();
				const temporary = path.join(
					path.dirname(canonical),
					`.${path.basename(canonical)}.${randomUUID()}.tmp`,
				);
				let pending = true;
				try {
					const handle = await open(temporary, "wx", 0o600);
					try {
						await handle.writeFile(`${JSON.stringify({ ...store, version: 1 }, undefined, "\t")}\n`, "utf8");
						await handle.sync();
					} finally {
						await handle.close();
					}
					assertLock();
					if (writeOptions.signal?.aborted) throw cancellationError();
					// Once rename is submitted the atomic commit must finish; do not
					// report cancellation after credentials have already been replaced.
					await rename(temporary, canonical);
					pending = false;
					// Persist the rename as well as the contents on filesystems that support it.
					const directory = await open(path.dirname(canonical), "r");
					try {
						await directory.sync();
					} catch (error) {
						if (!["EINVAL", "ENOTSUP", "EBADF"].includes((error as NodeJS.ErrnoException).code ?? "")) {
							throw error;
						}
					} finally {
						await directory.close();
					}
				} finally {
					if (pending) await unlink(temporary).catch(() => {});
				}
			},
		});
	} finally {
		if (!compromised) await release();
	}
}
