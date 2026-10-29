import { execFileSync, execSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { detectBinary } from "../src/core/tools/bin-detect.js";
import { fdCapabilities } from "../src/core/tools/fd-capabilities.js";
import { createFindTool } from "../src/core/tools/find.js";
import { createGrepTool } from "../src/core/tools/grep.js";
import { mkTempDirAsync } from "./helpers/mktemp.js";

const signal = new AbortController().signal;

// Top-level await: describe.skipIf is evaluated at collection time, before beforeAll.
const hasRg = await detectBinary("rg");
const hasFd = await detectBinary("fd");
const fdCaps = hasFd ? await fdCapabilities("fd").catch(() => undefined) : undefined;
const hasFind = Boolean(fdCaps?.maxResults);
if (process.env.CI_REQUIRE_SEARCH_TOOLS === "1") {
	const missing = [!hasRg && "rg", !hasFd && "fd"].filter(Boolean);
	if (missing.length > 0) {
		throw new Error(`Required search test binaries missing: ${missing.join(", ")}`);
	}
}

let dir: string;

beforeEach(async () => {
	dir = await mkTempDirAsync("ink-search-");
	// A tiny "project": git repo with an ignored file and hidden fixtures.
	execSync("git init -q", { cwd: dir });
	await writeFile(path.join(dir, ".gitignore"), "ignored.txt\n.secret.txt\n");
	await writeFile(path.join(dir, "ignored.txt"), "needle in ignored file\n");
	await writeFile(path.join(dir, "keep.ts"), "line1\nconst needle = 1;\nline3\n");
	await mkdir(path.join(dir, "sub"));
	await writeFile(path.join(dir, "sub", "other.ts"), "NEEDLE upper\nneedle lower\n");
	await writeFile(path.join(dir, ".hidden.ts"), "hidden-file-probe\n");
	await writeFile(path.join(dir, ".secret.txt"), "hidden-ignored-probe\n");
	await mkdir(path.join(dir, ".github"));
	await writeFile(path.join(dir, ".github", "ci.yml"), "hidden-github-probe\n");
	await mkdir(path.join(dir, ".svn"));
	await writeFile(path.join(dir, ".svn", "probe.txt"), "vcs-svn-probe\n");
	await writeFile(path.join(dir, ".git", "ink-probe.txt"), "vcs-git-probe\n");
});

describe.skipIf(!hasRg)("grep tool (requires rg)", () => {
	it("finds matches with path:line:text", async () => {
		const tool = createGrepTool({ cwd: dir });
		const result = await tool.execute({ pattern: "needle", path: "." }, signal);
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("keep.ts");
		expect(result.output).toMatch(/keep\.ts:2:const needle = 1;/);
		expect(result.output).toContain("sub/other.ts");
		// .gitignore respected
		expect(result.output).not.toContain("ignored.txt");
	});

	it("ignoreCase and glob narrow results", async () => {
		const tool = createGrepTool({ cwd: dir });
		const result = await tool.execute({ pattern: "needle", ignoreCase: true, glob: "*.ts" }, signal);
		expect(result.output).toContain("NEEDLE upper");
		expect(result.output).not.toContain("ignored");
	});

	it("literal mode treats regex chars as text", async () => {
		const tool = createGrepTool({ cwd: dir });
		await writeFile(path.join(dir, "regex.txt"), "a.b (dot)\naxb\n");
		const result = await tool.execute({ pattern: "a.b", literal: true, glob: "regex.txt" }, signal);
		expect(result.output).toContain("a.b (dot)");
		expect(result.output).not.toMatch(/axb/);
	});

	it("context lines are included", async () => {
		const tool = createGrepTool({ cwd: dir });
		const result = await tool.execute({ pattern: "needle", glob: "keep.ts", context: 1 }, signal);
		expect(result.output).toContain("line1");
		expect(result.output).toContain("line3");
	});

	it("no matches is not an error", async () => {
		const tool = createGrepTool({ cwd: dir });
		const result = await tool.execute({ pattern: "zzz-no-such-thing" }, signal);
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("No matches");
	});

	it("truncates with a teaching note at the limit", async () => {
		const tool = createGrepTool({ cwd: dir });
		const result = await tool.execute({ pattern: "line", glob: "keep.ts", limit: 1 }, signal);
		expect(result.output).toContain("[Truncated: showing first 1 of");
		expect(result.output).toContain("Narrow the search");
	});

	it("includes the filename for a single-file search", async () => {
		const tool = createGrepTool({ cwd: dir });
		const result = await tool.execute({ pattern: "needle", path: "keep.ts" }, signal);
		expect(result.output).toMatch(/keep\.ts:2:const needle = 1;/);
	});

	it("includes hidden working-tree files but excludes VCS metadata", async () => {
		const tool = createGrepTool({ cwd: dir });
		const hidden = await tool.execute({ pattern: "hidden-file-probe" }, signal);
		expect(hidden.output).toContain(".hidden.ts");

		const github = await tool.execute({ pattern: "hidden-github-probe" }, signal);
		expect(github.output).toContain(".github/ci.yml");

		const ignored = await tool.execute({ pattern: "hidden-ignored-probe" }, signal);
		expect(ignored.output).toContain("No matches");

		await mkdir(path.join(dir, "nested", ".git"), { recursive: true });
		await writeFile(path.join(dir, "nested", ".git", "probe.txt"), "nested-vcs-probe\n");
		for (const glob of ["*", "**/*"]) {
			const broad = await tool.execute({ pattern: "vcs-", glob }, signal);
			expect(broad.output, glob).not.toContain(".git/");
			expect(broad.output, glob).not.toContain(".svn/");
			const broadHidden = await tool.execute({ pattern: "hidden-github-probe", glob }, signal);
			expect(broadHidden.output, glob).toContain(".github/ci.yml");
		}
		const nested = await tool.execute({ pattern: "nested-vcs-probe" }, signal);
		expect(nested.output).toContain("No matches");

		const explicitGit = await tool.execute({ pattern: "vcs-git-probe", path: ".git" }, signal);
		expect(explicitGit.output).toContain(".git/ink-probe.txt");
		const explicitGitFile = await tool.execute(
			{ pattern: "vcs-git-probe", path: ".git/ink-probe.txt" },
			signal,
		);
		expect(explicitGitFile.output).toContain(".git/ink-probe.txt:1");
	});

	it("ignores ambient ripgrep configuration", async () => {
		const config = path.join(dir, "ripgreprc");
		const previous = process.env.RIPGREP_CONFIG_PATH;
		await writeFile(config, "--fixed-strings\n");
		await writeFile(path.join(dir, "config.txt"), "a.b\naxb\n");
		process.env.RIPGREP_CONFIG_PATH = config;
		try {
			const tool = createGrepTool({ cwd: dir });
			const result = await tool.execute({ pattern: "a.b", glob: "config.txt" }, signal);
			expect(result.output).toContain("axb");
		} finally {
			if (previous === undefined) delete process.env.RIPGREP_CONFIG_PATH;
			else process.env.RIPGREP_CONFIG_PATH = previous;
		}
	});

	it("normalizes @ and Unicode-space path variants", async () => {
		const tool = createGrepTool({ cwd: dir });
		await mkdir(path.join(dir, "space dir"));
		await writeFile(path.join(dir, "space dir", "file.ts"), "space-probe\n");
		await writeFile(path.join(dir, "@keep.ts"), "at-probe\n");
		const at = await tool.execute({ pattern: "needle", path: "@keep.ts" }, signal);
		expect(at.output).toMatch(/keep\.ts:2:/);
		const atAt = await tool.execute({ pattern: "at-probe", path: "@@keep.ts" }, signal);
		expect(atAt.output).toContain("@keep.ts:1:at-probe");
		const unicode = await tool.execute({ pattern: "space-probe", path: "space\u00A0dir" }, signal);
		expect(unicode.output).toContain("space dir/file.ts");
	});

	it("normalizes ~ paths", async () => {
		const previous = process.env.HOME;
		process.env.HOME = dir;
		try {
			const tool = createGrepTool({ cwd: dir });
			const result = await tool.execute({ pattern: "needle", path: "~/keep.ts" }, signal);
			expect(result.output).toMatch(/keep\.ts:2:/);
		} finally {
			if (previous === undefined) delete process.env.HOME;
			else process.env.HOME = previous;
		}
	});

	it("reports missing paths without raw rg stderr", async () => {
		const tool = createGrepTool({ cwd: dir });
		const result = await tool.execute({ pattern: "needle", path: "does-not-exist" }, signal);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("Error: path not found:");
		expect(result.output).not.toContain("rg exited");
		expect(result.output).not.toContain("stderr:");
	});

	it("escapes control characters in path errors", async () => {
		const tool = createGrepTool({ cwd: dir });
		const result = await tool.execute({ pattern: "needle", path: "bad\npath" }, signal);
		expect(result.output).toContain("\\n");
		expect(result.output.split("\n")).toHaveLength(1);
	});

	it("returns cancellation before a missing-path error", async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await createGrepTool({ cwd: dir }).execute(
			{ pattern: "needle", path: "does-not-exist" },
			controller.signal,
		);
		expect(result.output).toBe("Error: search aborted by user.");
	});

	it.skipIf(process.platform === "win32")("rejects a FIFO without blocking", async () => {
		const fifo = path.join(dir, "gate.fifo");
		execFileSync("mkfifo", [fifo]);
		const result = await createGrepTool({ cwd: dir }).execute({ pattern: "needle", path: fifo }, signal);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("path is not a file or directory");
	});
});

describe.skipIf(!hasFind)("find tool (requires fd with --max-results)", () => {
	it("finds files by glob", async () => {
		const tool = createFindTool({ cwd: dir });
		const result = await tool.execute({ pattern: "*.ts" }, signal);
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("keep.ts");
		expect(result.output).toContain("other.ts");
		expect(result.output).not.toContain("ignored.txt");
	});

	it("type filter works", async () => {
		const tool = createFindTool({ cwd: dir });
		const result = await tool.execute({ pattern: "sub", type: "directory" }, signal);
		expect(result.output).toContain("sub");
	});

	it("no matches is not an error", async () => {
		const tool = createFindTool({ cwd: dir });
		const result = await tool.execute({ pattern: "zzz-*" }, signal);
		expect(result.output).toContain("No matches");
	});

	it("supports path-shaped globs with the documented widening", async () => {
		await mkdir(path.join(dir, "a", "sub"), { recursive: true });
		await writeFile(path.join(dir, "a", "sub", "nested.ts"), "needle\n");
		const tool = createFindTool({ cwd: dir });
		for (const pattern of ["sub/*.ts", "./sub/*.ts", "/sub/*.ts", "**/sub/*.ts"]) {
			const result = await tool.execute({ pattern }, signal);
			expect(result.output, pattern).toContain("sub/other.ts");
			expect(result.output, pattern).toContain("a/sub/nested.ts");
		}
	});

	it("normalizes @, Unicode-space, and ~ paths", async () => {
		await mkdir(path.join(dir, "space dir"));
		await writeFile(path.join(dir, "space dir", "file.ts"), "x\n");
		const tool = createFindTool({ cwd: dir });
		const at = await tool.execute({ pattern: "*.ts", path: "@sub" }, signal);
		expect(at.output).toContain("sub/other.ts");
		const unicode = await tool.execute({ pattern: "*.ts", path: "space\u00A0dir" }, signal);
		expect(unicode.output).toContain("space dir/file.ts");

		const previous = process.env.HOME;
		process.env.HOME = dir;
		try {
			const home = await tool.execute({ pattern: "keep.ts", path: "~" }, signal);
			expect(home.output).toContain("keep.ts");
		} finally {
			if (previous === undefined) delete process.env.HOME;
			else process.env.HOME = previous;
		}
	});

	it("reports missing paths and file paths as tool errors", async () => {
		const tool = createFindTool({ cwd: dir });
		const missing = await tool.execute({ pattern: "*.ts", path: "does-not-exist" }, signal);
		expect(missing.isError).toBe(true);
		expect(missing.output).toContain("Error: path not found:");
		expect(missing.output).not.toContain("fd exited");

		const file = await tool.execute({ pattern: "*.ts", path: "keep.ts" }, signal);
		expect(file.isError).toBe(true);
		expect(file.output).toContain("Error: not a directory:");
	});

	it.skipIf(!fdCaps?.noRequireGit)("respects .gitignore outside a Git repository", async () => {
		const plain = await mkTempDirAsync("ink-search-nongit-");
		await writeFile(path.join(plain, ".gitignore"), "ignored.txt\n");
		await writeFile(path.join(plain, "ignored.txt"), "ignored\n");
		await writeFile(path.join(plain, "kept.txt"), "kept\n");
		const result = await createFindTool({ cwd: plain }).execute({ pattern: "*.txt" }, signal);
		expect(result.output).toContain("kept.txt");
		expect(result.output).not.toContain("ignored.txt");
	});

	it("uses the default 1000-result limit and reports the cap", async () => {
		await Promise.all(
			Array.from({ length: 1001 }, (_, index) =>
				writeFile(path.join(dir, `f${String(index + 1).padStart(4, "0")}.txt`), "x\n"),
			),
		);
		const result = await createFindTool({ cwd: dir }).execute({ pattern: "f*.txt" }, signal);
		expect(result.output.match(/^\.\/f\d{4}\.txt$/gm)).toHaveLength(1000);
		expect(result.output).toContain("[Results limited to 1000; at least 1000 results were found.");
		expect(result.output).not.toContain("[Truncated:");
	});

	it("reports limit 2 and limit 1 notices without preview truncation", async () => {
		const tool = createFindTool({ cwd: dir });
		const two = await tool.execute({ pattern: "*.ts", limit: 2 }, signal);
		expect(two.output.match(/^\.\/.*\.ts$/gm)).toHaveLength(2);
		expect(two.output).toContain("[Results limited to 2; at least 2 results were found.");
		expect(two.output).not.toContain("[Truncated:");

		const one = await tool.execute({ pattern: "*.ts", limit: 1 }, signal);
		expect(one.output.match(/^\.\/.*\.ts$/gm)).toHaveLength(1);
		expect(one.output).toContain("[Result limited to 1; at least 1 result was found.");
	});

	it("does not emit a result-limit notice when fewer results exist", async () => {
		const result = await createFindTool({ cwd: dir }).execute({ pattern: "keep.ts" }, signal);
		expect(result.output).not.toContain("limited to");
	});

	it("emits the result-limit notice when results exactly equal the limit", async () => {
		const result = await createFindTool({ cwd: dir }).execute({ pattern: "keep.ts", limit: 1 }, signal);
		expect(result.output).toContain("[Result limited to 1; at least 1 result was found.");
	});

	it("matches a search root whose name appears in the path glob", async () => {
		const base = await mkTempDirAsync("ink-search-root-");
		const root = path.join(base, "sub");
		await mkdir(root);
		await writeFile(path.join(root, "file.ts"), "x\n");
		const result = await createFindTool({ cwd: root }).execute({ pattern: "sub/*.ts" }, signal);
		expect(result.output).toContain("file.ts");
	});
});
