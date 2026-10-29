import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	clearFdCapabilitiesCache,
	fdCapabilities,
	parseFdCapabilities,
} from "../src/core/tools/fd-capabilities.js";
import { buildFindArgv, createFindTool, resolveFindPattern } from "../src/core/tools/find.js";
import { createGrepTool } from "../src/core/tools/grep.js";
import { mkTempDirAsync } from "./helpers/mktemp.js";

describe("find argv and capability parsing", () => {
	it("builds the exact argv for path globs and Git/non-Git roots", () => {
		const capabilities = { maxResults: true, noRequireGit: true };
		expect(
			buildFindArgv({
				pattern: "sub/*.ts",
				childPath: "src",
				type: "file",
				limit: 1000,
				capabilities,
				insideGitRepo: false,
			}),
		).toEqual([
			"--color",
			"never",
			"--hidden",
			"--glob",
			"--type",
			"file",
			"--no-require-git",
			"--max-results",
			"1000",
			"--full-path",
			"--",
			"**/sub/*.ts",
			"src",
		]);
		expect(
			buildFindArgv({
				pattern: "*.ts",
				childPath: ".",
				type: "",
				limit: 1,
				capabilities,
				insideGitRepo: true,
			}),
		).toEqual(["--color", "never", "--hidden", "--glob", "--max-results", "1", "--", "*.ts", "."]);
		expect(
			buildFindArgv({
				pattern: "*.ts",
				childPath: ".",
				type: "",
				limit: 1,
				capabilities: { maxResults: true, noRequireGit: false },
				insideGitRepo: false,
			}),
		).not.toContain("--no-require-git");
		expect(resolveFindPattern("./sub/*.ts")).toEqual({ effectivePattern: "**/sub/*.ts", fullPath: true });
		expect(resolveFindPattern("/sub/*.ts")).toEqual({ effectivePattern: "**/sub/*.ts", fullPath: true });
		expect(resolveFindPattern("**/sub/*.ts")).toEqual({ effectivePattern: "**/sub/*.ts", fullPath: true });
		expect(resolveFindPattern("*.ts")).toEqual({ effectivePattern: "*.ts", fullPath: false });
	});

	it("parses both capability flags independently", () => {
		expect(parseFdCapabilities("--max-results <count>\n--no-require-git\n")).toEqual({
			maxResults: true,
			noRequireGit: true,
		});
		expect(parseFdCapabilities("--max-results <count>\n")).toEqual({
			maxResults: true,
			noRequireGit: false,
		});
		expect(parseFdCapabilities("--no-require-git\n")).toEqual({
			maxResults: false,
			noRequireGit: true,
		});
		expect(parseFdCapabilities("")).toEqual({ maxResults: false, noRequireGit: false });
	});

	it("returns a clean upgrade error when fd lacks --max-results", async () => {
		const binDir = await mkTempDirAsync("ink-fd-old-");
		const cwd = await mkTempDirAsync("ink-fd-old-cwd-");
		await writeFile(
			path.join(binDir, "fd"),
			`#!${process.execPath}\nif(process.argv.includes('--version'))process.exit(0);if(process.argv.includes('--help')){process.stdout.write('--no-require-git\\n');process.exit(0);}process.exit(0);`,
			{ mode: 0o755 },
		);
		const previous = process.env.PATH;
		process.env.PATH = binDir;
		clearFdCapabilitiesCache();
		try {
			const result = await createFindTool({ cwd }).execute({ pattern: "*" }, new AbortController().signal);
			expect(result.isError).toBe(true);
			expect(result.output).toContain("--max-results is unavailable");
		} finally {
			if (previous === undefined) delete process.env.PATH;
			else process.env.PATH = previous;
			clearFdCapabilitiesCache();
		}
	});

	it("aborts an in-flight fd help probe", async () => {
		const binDir = await mkTempDirAsync("ink-fd-abort-");
		await writeFile(
			path.join(binDir, "fd"),
			`#!${process.execPath}\nif(process.argv.includes('--help')){setTimeout(()=>process.stdout.write('--max-results\\n'),10000);}else{process.exit(0);}`,
			{ mode: 0o755 },
		);
		const previous = process.env.PATH;
		process.env.PATH = binDir;
		clearFdCapabilitiesCache();
		const controller = new AbortController();
		try {
			const pending = fdCapabilities("fd", controller.signal);
			controller.abort();
			await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		} finally {
			if (previous === undefined) delete process.env.PATH;
			else process.env.PATH = previous;
			clearFdCapabilitiesCache();
		}
	});

	it("does not probe fd when the path is missing", async () => {
		const binDir = await mkTempDirAsync("ink-fd-noprobe-");
		const cwd = await mkTempDirAsync("ink-fd-noprobe-cwd-");
		const marker = path.join(binDir, "probe-marker");
		await writeFile(
			path.join(binDir, "fd"),
			`#!${process.execPath}\nif(process.argv.includes('--version'))process.exit(0);if(process.argv.includes('--help'))require('fs').writeFileSync(${JSON.stringify(marker)}, 'probed');process.exit(0);`,
			{ mode: 0o755 },
		);
		const previous = process.env.PATH;
		process.env.PATH = binDir;
		clearFdCapabilitiesCache();
		try {
			const result = await createFindTool({ cwd }).execute(
				{ pattern: "*", path: "missing" },
				new AbortController().signal,
			);
			expect(result.output).toContain("path not found");
			expect(existsSync(marker)).toBe(false);
		} finally {
			if (previous === undefined) delete process.env.PATH;
			else process.env.PATH = previous;
			clearFdCapabilitiesCache();
		}
	});

	it("pins the model-facing descriptions and the find schema default", () => {
		const find = createFindTool({ cwd: "" });
		const grep = createGrepTool({ cwd: "" });
		expect(find.description).toContain("inside Git repositories");
		expect(find.promptSnippet).toContain("Git repos");
		expect(
			(find.parameters as { properties: { limit: { description: string } } }).properties.limit.description,
		).toContain("1000");
		expect(grep.description).toContain("VCS metadata directories");
		expect(grep.promptSnippet).toContain("skips VCS dirs");
	});

	it.skipIf(process.platform === "win32")(
		"uses realpath for Git detection with symlinked roots",
		async () => {
			const binDir = await mkTempDirAsync("ink-fd-symlink-");
			const argsLog = path.join(binDir, "args.log");
			const help = "--max-results <count>\n--no-require-git\n";
			await writeFile(
				path.join(binDir, "fd"),
				`#!${process.execPath}\nif(process.argv.includes('--version'))process.exit(0);if(process.argv.includes('--help')){process.stdout.write(${JSON.stringify(help)});process.exit(0);}require('fs').appendFileSync(${JSON.stringify(argsLog)}, JSON.stringify(process.argv.slice(2))+'\\n');process.exit(0);`,
				{ mode: 0o755 },
			);
			const repo = await mkTempDirAsync("ink-fd-repo-");
			execSync("git init -q", { cwd: repo });
			const outside = await mkTempDirAsync("ink-fd-outside-");
			const nonGit = await mkTempDirAsync("ink-fd-nongit-");
			await symlink(repo, path.join(outside, "link"));
			await symlink(nonGit, path.join(repo, "outside-link"));
			const previous = process.env.PATH;
			process.env.PATH = binDir;
			clearFdCapabilitiesCache();
			try {
				const signal = new AbortController().signal;
				await createFindTool({ cwd: outside }).execute({ pattern: "*.ts", path: "link" }, signal);
				await createFindTool({ cwd: repo }).execute({ pattern: "*.ts", path: "outside-link" }, signal);
				const lines = (await readFile(argsLog, "utf8")).trim().split("\n");
				const gitArgs = JSON.parse(lines[0]!) as string[];
				const nonGitArgs = JSON.parse(lines[1]!) as string[];
				expect(gitArgs).not.toContain("--no-require-git");
				expect(nonGitArgs).toContain("--no-require-git");
			} finally {
				if (previous === undefined) delete process.env.PATH;
				else process.env.PATH = previous;
				clearFdCapabilitiesCache();
			}
		},
	);

	it("probes fd help and caches the parsed capabilities", async () => {
		const binDir = await mkTempDirAsync("ink-fd-caps-");
		const countPath = path.join(binDir, "count");
		const help = "--max-results <count>\n--no-require-git\n";
		await writeFile(
			path.join(binDir, "fd"),
			`#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(countPath)}, 'x');process.stdout.write(${JSON.stringify(help)});`,
			{ mode: 0o755 },
		);
		const previous = process.env.PATH;
		process.env.PATH = binDir;
		clearFdCapabilitiesCache();
		try {
			await expect(fdCapabilities("fd")).resolves.toEqual({ maxResults: true, noRequireGit: true });
			await expect(fdCapabilities("fd")).resolves.toEqual({ maxResults: true, noRequireGit: true });
			expect(await readFile(countPath, "utf8")).toBe("x");
		} finally {
			if (previous === undefined) delete process.env.PATH;
			else process.env.PATH = previous;
			clearFdCapabilitiesCache();
		}
	});

	it("does not cache probe failures and can retry", async () => {
		const binDir = await mkTempDirAsync("ink-fd-fail-");
		const fd = path.join(binDir, "fd");
		await writeFile(fd, "#!/bin/sh\nexit 2\n", { mode: 0o755 });
		const previous = process.env.PATH;
		process.env.PATH = binDir;
		clearFdCapabilitiesCache();
		try {
			await expect(fdCapabilities("fd")).rejects.toMatchObject({ name: "FdCapabilityError" });
			const help = "--max-results <count>\n";
			await writeFile(fd, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(help)});`, {
				mode: 0o755,
			});
			await expect(fdCapabilities("fd")).resolves.toEqual({ maxResults: true, noRequireGit: false });
		} finally {
			if (previous === undefined) delete process.env.PATH;
			else process.env.PATH = previous;
			clearFdCapabilitiesCache();
		}
	});

	it("reports a missing fd binary as a capability error", async () => {
		const binDir = await mkTempDirAsync("ink-fd-missing-");
		const previous = process.env.PATH;
		process.env.PATH = binDir;
		clearFdCapabilitiesCache();
		try {
			await expect(fdCapabilities("fd")).rejects.toMatchObject({ name: "FdCapabilityError" });
		} finally {
			if (previous === undefined) delete process.env.PATH;
			else process.env.PATH = previous;
			clearFdCapabilitiesCache();
		}
	});

	it("rejects empty help output and times out a hung probe", async () => {
		const binDir = await mkTempDirAsync("ink-fd-empty-");
		const hangDir = await mkTempDirAsync("ink-fd-hang-");
		await writeFile(path.join(binDir, "fd"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		await writeFile(path.join(hangDir, "fd"), `#!${process.execPath}\nsetTimeout(()=>{},10000);`, {
			mode: 0o755,
		});
		const previous = process.env.PATH;
		try {
			process.env.PATH = binDir;
			clearFdCapabilitiesCache();
			await expect(fdCapabilities("fd")).rejects.toMatchObject({ name: "FdCapabilityError" });
			process.env.PATH = hangDir;
			clearFdCapabilitiesCache();
			await expect(fdCapabilities("fd")).rejects.toMatchObject({ name: "FdCapabilityError" });
		} finally {
			if (previous === undefined) delete process.env.PATH;
			else process.env.PATH = previous;
			clearFdCapabilitiesCache();
		}
	}, 10_000);

	it("degrades when fd lacks --no-require-git", async () => {
		const binDir = await mkTempDirAsync("ink-fd-degrade-");
		const help = "--max-results <count>\n";
		await writeFile(
			path.join(binDir, "fd"),
			`#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(help)});`,
			{
				mode: 0o755,
			},
		);
		const previous = process.env.PATH;
		process.env.PATH = binDir;
		clearFdCapabilitiesCache();
		try {
			await expect(fdCapabilities("fd")).resolves.toEqual({ maxResults: true, noRequireGit: false });
		} finally {
			if (previous === undefined) delete process.env.PATH;
			else process.env.PATH = previous;
			clearFdCapabilitiesCache();
		}
	});
});
