import { spawn } from "node:child_process";

export interface FdCapabilities {
	maxResults: boolean;
	noRequireGit: boolean;
}

export class FdCapabilityError extends Error {
	readonly name = "FdCapabilityError";
}

const HELP_LIMIT = 64 * 1024;
const HELP_TIMEOUT_MS = 2_000;
const cache = new Map<string, FdCapabilities>();

/** Pure parser used by the probe and by deterministic tests. */
export function parseFdCapabilities(helpText: string): FdCapabilities {
	return {
		maxResults: helpText.includes("--max-results"),
		noRequireGit: helpText.includes("--no-require-git"),
	};
}

/** Test seam; capability results are process-lifetime cached by PATH. */
export function clearFdCapabilitiesCache(): void {
	cache.clear();
}

function abortError(): Error {
	const error = new Error("Operation aborted");
	error.name = "AbortError";
	return error;
}

function cacheKey(fdPath: string): string {
	return `${fdPath}\0${process.env.PATH ?? ""}`;
}

/**
 * Probe `fd --help` once per PATH and cache the result. The probe is bounded
 * and abort-aware; a spawn error/timeout/nonzero exit is not cached, while a
 * parsed capability result (including maxResults=false) is cached.
 */
export function fdCapabilities(fdPath = "fd", signal?: AbortSignal): Promise<FdCapabilities> {
	if (signal?.aborted) return Promise.reject(abortError());
	const key = cacheKey(fdPath);
	const cached = cache.get(key);
	if (cached !== undefined) return Promise.resolve(cached);

	return new Promise<FdCapabilities>((resolve, reject) => {
		let settled = false;
		let stdout = "";
		let stderr = "";
		let timer: ReturnType<typeof setTimeout> | undefined;
		let child: ReturnType<typeof spawn>;
		const cleanup = () => {
			if (timer !== undefined) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		const finish = (error?: Error, caps?: FdCapabilities) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (error !== undefined) {
				reject(error);
				return;
			}
			cache.set(key, caps!);
			resolve(caps!);
		};
		const onAbort = () => {
			child.kill("SIGKILL");
			finish(abortError());
		};
		try {
			child = spawn(fdPath, ["--help"], { stdio: ["ignore", "pipe", "pipe"] });
		} catch (error) {
			finish(new FdCapabilityError(`failed to run ${fdPath} --help: ${(error as Error).message}`));
			return;
		}
		timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(new FdCapabilityError(`${fdPath} --help timed out after ${HELP_TIMEOUT_MS / 1000}s`));
		}, HELP_TIMEOUT_MS);
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) {
			onAbort();
			return;
		}
		child.stdout?.on("data", (chunk: Buffer) => {
			if (settled) return;
			if (stdout.length < HELP_LIMIT) stdout += chunk.toString().slice(0, HELP_LIMIT - stdout.length);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			if (settled) return;
			if (stderr.length < HELP_LIMIT) stderr += chunk.toString().slice(0, HELP_LIMIT - stderr.length);
		});
		child.on("error", (error) => {
			finish(new FdCapabilityError(`failed to run ${fdPath} --help: ${error.message}`));
		});
		child.on("close", (code) => {
			if (settled) return;
			if (code !== 0) {
				const detail = stderr.trim();
				finish(
					new FdCapabilityError(
						`${fdPath} --help exited with code ${code}${detail !== "" ? `: ${detail}` : ""}`,
					),
				);
				return;
			}
			if (stdout.trim() === "") {
				finish(new FdCapabilityError(`${fdPath} --help returned no output`));
				return;
			}
			finish(undefined, parseFdCapabilities(stdout));
		});
	});
}
