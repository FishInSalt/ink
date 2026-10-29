import { stat } from "node:fs/promises";
import { normalizePath, resolveToCwd } from "./path-resolve.js";
import type { ToolExecuteResult } from "./types.js";

/** Normalize a search path once, then resolve it without normalizing again.
 * The double-normalization guard matters for `@@foo`-style paths: the child
 * process receives `childPath`, and the stat/error path must resolve exactly
 * the same spelling. */
export interface SearchPath {
	childPath: string;
	resolvedPath: string;
}

export function resolveSearchPath(rawPath: unknown, cwd: string): SearchPath {
	const raw = typeof rawPath === "string" && rawPath !== "" ? rawPath : ".";
	const normalized = normalizePath(raw, {
		normalizeUnicodeSpaces: true,
		stripAtPrefix: true,
	});
	const childPath = normalized === "" ? "." : normalized;
	const resolvedPath = resolveToCwd(childPath, cwd, {
		normalizeUnicodeSpaces: false,
		stripAtPrefix: false,
		expandTilde: false,
	});
	return { childPath, resolvedPath };
}

/** Keep model-facing path errors on one line even when the path contains
 * control characters or newlines. */
export function escapePathForError(value: string): string {
	let escaped = "";
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code > 0x1f && (code < 0x7f || code > 0x9f)) {
			escaped += character;
			continue;
		}
		switch (character) {
			case "\n":
				escaped += "\\n";
				break;
			case "\r":
				escaped += "\\r";
				break;
			case "\t":
				escaped += "\\t";
				break;
			default:
				escaped += `\\u${code.toString(16).padStart(4, "0")}`;
		}
	}
	return escaped;
}

export const SEARCH_ABORTED: ToolExecuteResult = {
	output: "Error: search aborted by user.",
	isError: true,
};

export type SearchPathStat = { kind: "file" | "directory" | "other" } | { error: ToolExecuteResult };

/** Stat a resolved search path before spawning rg/fd. Path errors are
 * deliberate tool results, not raw child stderr. Abort wins over a stat
 * failure that happens during cancellation. */
export async function statSearchPath(resolvedPath: string, signal: AbortSignal): Promise<SearchPathStat> {
	if (signal.aborted) return { error: SEARCH_ABORTED };
	try {
		const info = await stat(resolvedPath);
		if (signal.aborted) return { error: SEARCH_ABORTED };
		if (info.isFile()) return { kind: "file" };
		if (info.isDirectory()) return { kind: "directory" };
		return { kind: "other" };
	} catch (error) {
		if (signal.aborted) return { error: SEARCH_ABORTED };
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") {
			return {
				error: {
					output: `Error: path not found: ${escapePathForError(resolvedPath)}`,
					isError: true,
				},
			};
		}
		const message = error instanceof Error ? error.message : String(error);
		return {
			error: {
				output: `Error: cannot access path: ${escapePathForError(resolvedPath)}: ${escapePathForError(message)}`,
				isError: true,
			},
		};
	}
}
