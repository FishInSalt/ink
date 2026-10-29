import { realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import { detectBinary } from "./bin-detect.js";
import { type FdCapabilities, fdCapabilities } from "./fd-capabilities.js";
import { clampInt, runSearch } from "./grep.js";
import { findPresentation } from "./presentation.js";
import { escapePathForError, resolveSearchPath, statSearchPath } from "./search-path.js";
import type { Tool } from "./types.js";

const DEFAULT_LIMIT = 1000;
const DEFAULT_TIMEOUT_MS = 30;
const MAX_HELP_DETAIL = 500;

const findSchema = Type.Object({
	pattern: Type.String({
		description:
			"Glob pattern for file/dir names, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'. Use '*' to list everything.",
	}),
	path: Type.Optional(Type.String({ description: "Directory to search (default: current directory)" })),
	type: Type.Optional(Type.String({ description: "Restrict to 'file' or 'directory' (default: both)" })),
	limit: Type.Optional(Type.Number({ description: `Max results (default: ${DEFAULT_LIMIT}, max: 1000)` })),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default: 30)" })),
});

export interface FindToolOptions {
	cwd?: string;
}

export interface FindArgvOptions {
	pattern: string;
	childPath: string;
	type: string;
	limit: number;
	capabilities: FdCapabilities;
	insideGitRepo: boolean;
}

/** fd --glob matches the basename unless --full-path is set. For path-shaped
 * patterns, strip a leading ./ or / and add the double-star slash prefix so
 * the pattern can match below the search root. A leading double-star slash
 * deliberately matches any depth. */
export function resolveFindPattern(pattern: string): { effectivePattern: string; fullPath: boolean } {
	if (!pattern.includes("/")) return { effectivePattern: pattern, fullPath: false };
	let effectivePattern = pattern.replace(/^(?:\.\/)+/, "").replace(/^\/+/, "");
	if (effectivePattern === "") effectivePattern = "**";
	else if (!effectivePattern.startsWith("**/") && effectivePattern !== "**")
		effectivePattern = `**/${effectivePattern}`;
	return { effectivePattern, fullPath: true };
}

/** Pure argv builder; exported so tests can pin every feature flag. */
export function buildFindArgv(options: FindArgvOptions): string[] {
	const argv = ["--color", "never", "--hidden", "--glob"];
	if (options.type === "file") argv.push("--type", "file");
	else if (options.type === "directory") argv.push("--type", "directory");
	if (!options.insideGitRepo && options.capabilities.noRequireGit) argv.push("--no-require-git");
	argv.push("--max-results", String(options.limit));
	const { effectivePattern, fullPath } = resolveFindPattern(options.pattern);
	if (fullPath) argv.push("--full-path");
	argv.push("--", effectivePattern, options.childPath);
	return argv;
}

async function pathExists(candidate: string): Promise<boolean> {
	try {
		await stat(candidate);
		return true;
	} catch {
		return false;
	}
}

/** Walk from the real search path to the filesystem root. An unreadable
 * ancestor is treated as "no .git" so a permissions problem cannot reject the
 * whole search. */
async function insideGitRepo(searchPath: string): Promise<boolean> {
	let current = searchPath;
	for (;;) {
		if (await pathExists(join(current, ".git"))) return true;
		const parent = dirname(current);
		if (parent === current) return false;
		current = parent;
	}
}

function fdCapabilityFailure(error: unknown): string {
	const detail = error instanceof Error ? error.message : String(error);
	const bounded = detail.length > MAX_HELP_DETAIL ? `${detail.slice(0, MAX_HELP_DETAIL)}…` : detail;
	return `Error: failed to inspect fd capabilities: ${escapePathForError(bounded)}`;
}

export function createFindTool(options: FindToolOptions = {}): Tool {
	const cwd = options.cwd ?? process.cwd();
	return {
		name: "find",
		// #readonly-parallel: read-only tool, safe for sliding-window
		// concurrency (see docs/design/readonly-parallel-design.md §2.1).
		concurrencySafe: true,
		presentation: findPresentation,
		promptSnippet: "find files by name glob (respects .gitignore in Git repos) — prefer over bash find.",
		description:
			"Find files and directories by name (backed by fd; respects .gitignore inside Git repositories, " +
			"includes hidden files; non-Git .gitignore requires fd 8.7+). Pattern is a glob, including path-shaped " +
			"patterns such as 'src/**/*.ts'. Paths keep the relative/absolute shape of the path argument; " +
			"results are truncated to the first 1000 results / 50KB — " +
			"narrow with path/pattern instead of raising the limit. This is the right tool for 'where is the X file'.",
		parameters: findSchema,
		async execute(args, signal) {
			const available = await detectBinary("fd");
			if (signal.aborted) return { output: "Error: search aborted by user.", isError: true };
			if (!available) {
				return {
					output: "Error: fd is not installed. Install it first: brew install fd (or apt install fd-find).",
					isError: true,
				};
			}

			const pattern = String(args.pattern ?? "");
			if (pattern === "") return { output: "Error: empty pattern", isError: true };
			const limit = clampInt(args.limit, DEFAULT_LIMIT, 1, 1000);
			const timeoutMs = clampInt(args.timeout, DEFAULT_TIMEOUT_MS, 1, 600) * 1000;

			const { childPath, resolvedPath } = resolveSearchPath(args.path, cwd);
			const pathStat = await statSearchPath(resolvedPath, signal);
			if ("error" in pathStat) return pathStat.error;
			if (pathStat.kind !== "directory") {
				return {
					output: `Error: not a directory: ${escapePathForError(resolvedPath)}`,
					isError: true,
				};
			}
			if (signal.aborted) return { output: "Error: search aborted by user.", isError: true };

			let capabilities: FdCapabilities;
			try {
				capabilities = await fdCapabilities("fd", signal);
			} catch (error) {
				if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
					return { output: "Error: search aborted by user.", isError: true };
				}
				return { output: fdCapabilityFailure(error), isError: true };
			}
			if (signal.aborted) return { output: "Error: search aborted by user.", isError: true };
			if (!capabilities.maxResults) {
				return {
					output: "Error: fd is too old for find: --max-results is unavailable. Install fd 8.7.0 or later.",
					isError: true,
				};
			}

			const realSearchPath = await realpath(resolvedPath).catch(() => resolvedPath);
			if (signal.aborted) return { output: "Error: search aborted by user.", isError: true };
			const insideGit = await insideGitRepo(realSearchPath);
			if (signal.aborted) return { output: "Error: search aborted by user.", isError: true };

			const argv = buildFindArgv({
				pattern,
				childPath,
				type: String(args.type ?? ""),
				limit,
				capabilities,
				insideGitRepo: insideGit,
			});
			return runSearch("fd", argv, cwd, {
				limit,
				context: 0,
				timeoutMs,
				label: pattern,
				signal,
				resultLimit: limit,
			});
		},
	};
}
