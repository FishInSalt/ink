import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, sep } from "node:path";
import { normalizePath } from "./path-resolve.js";
import type { ToolExecuteResult } from "./types.js";

/** Normalize once for both stat and the child, including `@@foo`-style paths.
 * Keep symlink/.. components and trailing separators intact so preflight
 * traverses the same filesystem target as the child. */
export interface SearchPath {
	childPath: string;
	resolvedPath: string;
}

export function resolveSearchPath(rawPath: unknown, cwd: string): SearchPath {
	const raw = typeof rawPath === "string" && rawPath !== "" ? rawPath : ".";
	const normalized = normalizePath(raw, {
		normalizeUnicodeSpaces: true,
		stripAtPrefix: true,
		expandTilde: false,
	});
	// Shared tilde expansion uses path.join, which would collapse symlink/.. components.
	const expanded =
		normalized === "~" || normalized.startsWith("~/") ? homedir() + normalized.slice(1) : normalized;
	const childPath = expanded === "" ? "." : expanded;
	const base = isAbsolute(cwd) ? cwd : `${process.cwd()}${sep}${cwd}`;
	const resolvedPath = isAbsolute(childPath)
		? childPath
		: `${base}${base.endsWith(sep) ? "" : sep}${childPath}`;
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
