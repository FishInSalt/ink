import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createBashTool } from "../src/core/tools/bash.js";
import { createReadTool } from "../src/core/tools/read.js";
import { mkTempDirAsync } from "./helpers/mktemp.js";

const noSignal = new AbortController().signal;

describe("bash tool", () => {
	it("returns stdout", async () => {
		const tool = createBashTool();
		const result = await tool.execute({ command: "echo hello-from-imp" }, noSignal);
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("hello-from-imp");
	});

	it("captures stderr and non-zero exit code", async () => {
		const tool = createBashTool();
		const result = await tool.execute({ command: "echo oops >&2; exit 3" }, noSignal);
		expect(result.output).toContain("oops");
		expect(result.output).toContain("Exit code: 3");
	});

	it("kills the command on timeout", async () => {
		const tool = createBashTool();
		const result = await tool.execute({ command: "sleep 30", timeout: 0.5 }, noSignal);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("timed out");
	}, 10_000);

	it("aborts via AbortSignal", async () => {
		const tool = createBashTool();
		const controller = new AbortController();
		const promise = tool.execute({ command: "sleep 30" }, controller.signal);
		setTimeout(() => controller.abort(), 100);
		const result = await promise;
		expect(result.isError).toBe(true);
		expect(result.output).toContain("aborted");
	}, 10_000);

	it("truncates large output and says so", async () => {
		const tool = createBashTool();
		const result = await tool.execute({ command: "seq 1 5000" }, noSignal);
		expect(result.output).toContain("truncated");
		expect(result.output).toContain("5000");
		// tail kept: early lines must be gone
		expect(result.output).not.toMatch(/^\s*1\n/);
		const lineCount = result.output.split("\n").length;
		expect(lineCount).toBeLessThan(560);
	});

	it("saves truncated full output to a temp file and names it", async () => {
		const tool = createBashTool();
		const result = await tool.execute({ command: "seq 1 5000" }, noSignal);
		expect(result.output).toMatch(/Full output saved to \/.*ink-output-.*\.log/);
		// the temp file actually contains the beginning that was cut from the tail
		const match = result.output.match(/Full output saved to (\S+)/);
		const full = await readFile(match![1]!, "utf8");
		expect(full).toContain("1\n2\n");
	});

	it("rejects an empty command", async () => {
		const tool = createBashTool();
		const result = await tool.execute({ command: "   " }, noSignal);
		expect(result.isError).toBe(true);
	});

	it("rejects an invalid timeout", async () => {
		const tool = createBashTool();
		const result = await tool.execute({ command: "true", timeout: -1 }, noSignal);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("invalid timeout");
	});
});

describe("read tool", () => {
	async function setupFile(name: string, lines: number): Promise<string> {
		// per-test dir: mkTempDir's onTestFinished removes it when THIS test ends
		const dir = await mkTempDirAsync("ink-test-");
		const file = path.join(dir, name);
		const content = Array.from({ length: lines }, (_, i) => `line-${i + 1}`).join("\n");
		await writeFile(file, content, "utf8");
		return file;
	}

	it("reads a whole small file", async () => {
		const file = await setupFile("small.txt", 3);
		const tool = createReadTool();
		const result = await tool.execute({ path: file }, noSignal);
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("line-1");
		expect(result.output).toContain("line-3");
	});

	it("supports offset/limit and reports the remainder", async () => {
		const file = await setupFile("offset.txt", 100);
		const tool = createReadTool();
		const result = await tool.execute({ path: file, offset: 10, limit: 5 }, noSignal);
		expect(result.output).toContain("line-10");
		expect(result.output).toContain("line-14");
		expect(result.output).not.toContain("line-15\n");
		expect(result.output).toContain("[86 more lines in file. Use offset=15 to continue.]");
	});

	it("truncates at 2000 lines and suggests the next offset", async () => {
		const file = await setupFile("big.txt", 3000);
		const tool = createReadTool();
		const result = await tool.execute({ path: file }, noSignal);
		expect(result.output).toContain("line-1");
		expect(result.output).not.toContain("line-2001");
		expect(result.output).toContain("Use offset=2001 to continue.");
	});

	it("errors on missing files", async () => {
		const tool = createReadTool();
		const result = await tool.execute({ path: "definitely-not-here.txt" }, noSignal);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("Error reading");
	});

	it("refuses binary files", async () => {
		const dir = await mkTempDirAsync("ink-test-");
		const file = path.join(dir, "binary.bin");
		await writeFile(file, Buffer.from([0x00, 0x01, 0x02, 0x00]));
		const tool = createReadTool();
		const result = await tool.execute({ path: file }, noSignal);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("binary");
	});

	it("returns the tail when offset is beyond EOF", async () => {
		const file = await setupFile("eof.txt", 30);
		const tool = createReadTool();
		// limit describes a range at the invalid offset; recovery shows the tail.
		const result = await tool.execute({ path: file, offset: 99, limit: 5 }, noSignal);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("beyond the end");
		expect(result.output).toContain("line-11");
		expect(result.output).toContain("line-30");
		expect(result.output).not.toContain("line-10\n");
		expect(result.output).toContain("Showing the last 20 lines (file ends at line 30).");
	});

	it("reports an empty file when offset is beyond EOF", async () => {
		const dir = await mkTempDirAsync("ink-test-");
		const file = path.join(dir, "empty.txt");
		await writeFile(file, "", "utf8");
		const tool = createReadTool();
		const result = await tool.execute({ path: file, offset: 2 }, noSignal);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("file is empty");
	});

	it("handles a final blank line and singular tail wording", async () => {
		const dir = await mkTempDirAsync("ink-test-");
		const blank = path.join(dir, "blank.txt");
		const single = path.join(dir, "single.txt");
		await writeFile(blank, "\n", "utf8");
		await writeFile(single, "only-line\n", "utf8");
		const tool = createReadTool();
		const blankResult = await tool.execute({ path: blank, offset: 2 }, noSignal);
		expect(blankResult.isError).toBe(true);
		expect(blankResult.output).toContain("The last line is empty (file ends at line 1).");
		const singleResult = await tool.execute({ path: single, offset: 2 }, noSignal);
		expect(singleResult.output).toContain("Showing the last 1 line (file ends at line 1).");
	});

	it("reports the shown suffix when an earlier tail line hits the byte cap", async () => {
		const dir = await mkTempDirAsync("ink-test-");
		const file = path.join(dir, "huge-tail.txt");
		const lines = Array.from({ length: 25 }, (_, i) => (i === 20 ? "x".repeat(60 * 1024) : `line-${i + 1}`));
		await writeFile(file, lines.join("\n"), "utf8");
		const tool = createReadTool();
		const result = await tool.execute({ path: file, offset: 999 }, noSignal);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("Showing lines 22-25");
		expect(result.output).toContain("the last 4 lines");
		expect(result.output).toContain("lines 6-21 omitted");
		expect(result.output).toContain("line-22");
		expect(result.output).toContain("line-25");
		expect(result.output).not.toContain("line-21\n");
		expect(result.output).toContain("Use offset=6");
	});

	it("names omitted lines when the final line is blank and the tail is byte-capped", async () => {
		const dir = await mkTempDirAsync("ink-test-");
		const file = path.join(dir, "huge-before-blank.txt");
		await writeFile(file, `${"x".repeat(60 * 1024)}\n\n`, "utf8");
		const tool = createReadTool();
		const result = await tool.execute({ path: file, offset: 3 }, noSignal);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("The last line is empty (file ends at line 2).");
		expect(result.output).toContain("line 1 omitted");
		expect(result.output).toContain("Use offset=1 to read it.");
		expect(result.output).not.toContain("xxxx");
	});

	it("uses the bash hint when the final line alone exceeds the cap", async () => {
		const dir = await mkTempDirAsync("ink-test-");
		const file = path.join(dir, "huge-final.txt");
		await writeFile(file, `line-1\nline-2\n${"x".repeat(60 * 1024)}`, "utf8");
		const tool = createReadTool();
		const result = await tool.execute({ path: file, offset: 9 }, noSignal);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("[Line 3 is 60KB, exceeds the 50KB limit.");
		expect(result.output).toContain(`sed -n '3p' '${file}' | head -c`);
		expect(result.output).not.toContain("xxxx");
	});
});

describe("read single-line-over-limit fallback (prompt-audit P9)", () => {
	it("a line larger than the byte cap returns the bash sed hint", async () => {
		const root = await mkTempDirAsync("ink-read-huge-");
		const file = path.join(root, "huge.txt");
		const huge = `${"x".repeat(60 * 1024)}\nshort line\n`; // one 60KB line > 50KB cap
		await writeFile(file, huge, "utf8");
		const tool = createReadTool();
		const result = await tool.execute({ path: file }, noSignal);
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("[Line 1 is 60KB, exceeds the 50KB limit.");
		expect(result.output).toContain(`sed -n '1p' '${file}' | head -c`);
		expect(result.output).not.toContain("xxxx");
	});
});
