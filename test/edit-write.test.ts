import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { contentText } from "../src/core/messages.js";
import { createEditTool, prepareEditArguments } from "../src/core/tools/edit.js";
import { applyEdits, countOccurrences, diffLines } from "../src/core/tools/edit-diff.js";
import { withFileLock } from "../src/core/tools/file-lock.js";
import { resolveToCwd } from "../src/core/tools/path-resolve.js";
import { createWriteTool } from "../src/core/tools/write.js";
import { mkTempDirAsync } from "./helpers/mktemp.js";

const signal = new AbortController().signal;

// per-test root: each tmp() call gets a fresh dir removed when that test ends
async function tmp(): Promise<string> {
	return mkTempDirAsync("ink-edit-");
}

describe("applyEdits (pure)", () => {
	it("applies a single unique replacement", () => {
		const result = applyEdits("a\nb\nc\n", [{ oldText: "b", newText: "B" }]);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.content).toBe("a\nB\nc\n");
			expect(result.applied[0]?.line).toBe(2);
		}
	});

	it("applies multiple non-overlapping edits against the ORIGINAL content", () => {
		const result = applyEdits("one\ntwo\nthree\n", [
			{ oldText: "one", newText: "1" },
			{ oldText: "three", newText: "3" },
		]);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.content).toBe("1\ntwo\n3\n");
	});

	it("tracks old and new starts across insertions, deletions, and mid-line edits", () => {
		const result = applyEdits("a\nb\nc\nd\n", [
			{ oldText: "a", newText: "a\nINS" },
			{ oldText: "c", newText: "C" },
			{ oldText: "d\n", newText: "" },
		]);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.applied.map((edit) => [edit.line, edit.newLine])).toEqual([
				[1, 1],
				[3, 4],
				[4, 5],
			]);
			expect(result.applied.every((edit) => edit.newLine >= 1)).toBe(true);
		}
	});

	it("keeps same-line edits on the same old and new line", () => {
		const result = applyEdits("abcdef\n", [
			{ oldText: "abc", newText: "x" },
			{ oldText: "def", newText: "y" },
		]);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.applied.map((edit) => [edit.line, edit.newLine])).toEqual([
				[1, 1],
				[1, 1],
			]);
		}
	});

	it("fails with zero matches and teaches how to fix it", () => {
		const result = applyEdits("a\nb\n", [{ oldText: "zzz", newText: "x" }]);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("edits[0]");
			expect(result.error).toContain("not found");
			expect(result.error).toContain("Read the file");
		}
	});

	it("fails on ambiguous matches", () => {
		const result = applyEdits("x\nx\n", [{ oldText: "x", newText: "y" }]);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("matches 2 times");
	});

	it("rejects overlapping edits", () => {
		const result = applyEdits("abcdef\n", [
			{ oldText: "abcd", newText: "1" },
			{ oldText: "cdef", newText: "2" },
		]);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("overlap");
	});

	it("rejects empty and no-op edits", () => {
		expect(applyEdits("a\n", [{ oldText: "", newText: "b" }]).ok).toBe(false);
		expect(applyEdits("a\n", [{ oldText: "a", newText: "a" }]).ok).toBe(false);
	});
});

describe("diffLines (pure)", () => {
	it("renders additions and removals", () => {
		const diff = diffLines("const a = 1;\n", "const a = 2;\nconst b = 3;\n");
		expect(diff).toContain("- const a = 1;");
		expect(diff).toContain("+ const a = 2;");
		expect(diff).toContain("+ const b = 3;");
	});

	it("numbers one header per changed block with zero-based offsets", () => {
		expect(diffLines("a\nb", "a\nc", { oldLine: 2, newLine: 2 })).toBe("@@ old 3 new 3 @@\n- b\n+ c");
		expect(diffLines("a\nb\nc\nd", "a\nX\nc\nY", { oldLine: 2, newLine: 2 })).toBe(
			"@@ old 3 new 3 @@\n- b\n+ X\n@@ old 5 new 5 @@\n- d\n+ Y",
		);
		expect(diffLines("a", "a\nb", { oldLine: 2, newLine: 2 })).toBe("@@ old 3 new 3 @@\n+ b");
	});

	it("keeps one header when no line is shared", () => {
		expect(diffLines("a\nb", "X\nY", { oldLine: 2, newLine: 2 })).toBe(
			"@@ old 2 new 2 @@\n- a\n- b\n+ X\n+ Y",
		);
	});

	it("elided fragments emit a non-numbered reset marker", () => {
		const before = Array.from({ length: 1001 }, () => "a").join("\n");
		const after = Array.from({ length: 1001 }, () => "b").join("\n");
		const diff = diffLines(before, after, { oldLine: 2, newLine: 2 });
		expect(diff.startsWith("@@ diff elided @@\n")).toBe(true);
		expect(diff).not.toContain("@@ old");
		expect(diff).toContain("- 1001 lines");
		expect(diff).toContain("+ 1001 lines (diff elided)");
	});
});

describe("countOccurrences (pure)", () => {
	it("counts non-overlapping matches", () => {
		expect(countOccurrences("ababab", "ab")).toBe(3);
		expect(countOccurrences("aaa", "aa")).toBe(1);
		expect(countOccurrences("x", "")).toBe(0);
	});
});

describe("prepareEditArguments", () => {
	const edit = { oldText: "a", newText: "b" };

	it("wraps a single edit object and parses a stringified array", () => {
		expect(prepareEditArguments({ path: "f", edits: edit }).edits).toEqual([edit]);
		expect(prepareEditArguments({ path: "f", edits: JSON.stringify([edit]) }).edits).toEqual([edit]);
		expect(prepareEditArguments({ path: "f", edits: JSON.stringify(edit) }).edits).toEqual([edit]);
	});

	it("appends legacy top-level fields and removes them", () => {
		const prepared = prepareEditArguments({
			path: "f",
			edits: [{ oldText: "x", newText: "y" }],
			oldText: "a",
			newText: "b",
		});
		expect(prepared).toEqual({ path: "f", edits: [{ oldText: "x", newText: "y" }, edit] });
	});

	it("uses legacy fields when edits is not an array", () => {
		expect(prepareEditArguments({ path: "f", edits: "not-json", oldText: "a", newText: "b" }).edits).toEqual([
			edit,
		]);
	});

	it("does not mutate the raw arguments", () => {
		const raw = { path: "f", edits: JSON.stringify(edit) };
		const original = raw.edits;
		prepareEditArguments(raw);
		expect(raw.edits).toBe(original);
	});

	it("copies the edits array before appending legacy fields", () => {
		const edits = [{ oldText: "x", newText: "y" }];
		const raw = { path: "f", edits, oldText: "a", newText: "b" };
		const prepared = prepareEditArguments(raw);
		expect(prepared.edits).not.toBe(edits);
		expect(prepared.edits).toEqual([...edits, edit]);
		expect(edits).toEqual([{ oldText: "x", newText: "y" }]);
	});

	it("leaves invalid JSON for the normal schema error when no legacy pair exists", () => {
		expect(prepareEditArguments({ path: "f", edits: "not-json" }).edits).toBe("not-json");
	});
});

describe("path resolution", () => {
	it("edit strips one leading @ and normalizes Unicode spaces", async () => {
		const dir = await tmp();
		await writeFile(path.join(dir, "note.txt"), "plain\n");
		const tool = createEditTool({ cwd: dir });
		const at = await tool.execute(
			{ path: "@note.txt", edits: [{ oldText: "plain", newText: "changed" }] },
			signal,
		);
		expect(at.isError).toBeFalsy();
		expect(await readFile(path.join(dir, "note.txt"), "utf8")).toBe("changed\n");

		await writeFile(path.join(dir, "a b.txt"), "space\n");
		const spaced = await tool.execute(
			{ path: "a\u00A0b.txt", edits: [{ oldText: "space", newText: "normalized" }] },
			signal,
		);
		expect(spaced.isError).toBeFalsy();
		expect(await readFile(path.join(dir, "a b.txt"), "utf8")).toBe("normalized\n");
	});

	it("edit expands ~ with the active home directory", async () => {
		const home = await tmp();
		const file = path.join(home, "notes.txt");
		await writeFile(file, "home\n");
		vi.stubEnv("HOME", home);
		try {
			const tool = createEditTool({ cwd: home });
			const result = await tool.execute(
				{ path: "~/notes.txt", edits: [{ oldText: "home", newText: "expanded" }] },
				signal,
			);
			expect(result.isError).toBeFalsy();
			expect(await readFile(file, "utf8")).toBe("expanded\n");
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("write uses the same @, Unicode-space, and ~ rules", async () => {
		const dir = await tmp();
		const tool = createWriteTool({ cwd: dir });
		await tool.execute({ path: "@at.txt", content: "at\n" }, signal);
		await tool.execute({ path: "sp\u00A0ace.txt", content: "space\n" }, signal);
		expect(await readFile(path.join(dir, "at.txt"), "utf8")).toBe("at\n");
		expect(await readFile(path.join(dir, "sp ace.txt"), "utf8")).toBe("space\n");

		const home = await tmp();
		vi.stubEnv("HOME", home);
		try {
			const homeTool = createWriteTool({ cwd: dir });
			await homeTool.execute({ path: "~/home.txt", content: "home\n" }, signal);
			expect(await readFile(path.join(home, "home.txt"), "utf8")).toBe("home\n");
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("@file and file share the same resolved target", () => {
		const dir = "/tmp/project";
		expect(resolveToCwd("@file", dir)).toBe(resolveToCwd("file", dir));
		expect(resolveToCwd("./@file", dir)).toBe(path.join(dir, "@file"));
	});
});

describe("edit tool", () => {
	it("edits a file and returns a diff with line numbers", async () => {
		const dir = await tmp();
		const file = path.join(dir, "one.ts");
		await writeFile(file, "function add(a, b) {\n  return a - b;\n}\n");
		const tool = createEditTool({ cwd: dir });
		const result = await tool.execute(
			{ path: file, edits: [{ oldText: "return a - b;", newText: "return a + b;" }] },
			signal,
		);
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("1 edit applied");
		expect(result.output).toContain("@@ old 2 new 2 @@");
		expect(result.output).toContain("- return a - b;");
		expect(result.output).toContain("+ return a + b;");
		expect(await readFile(file, "utf8")).toBe("function add(a, b) {\n  return a + b;\n}\n");
	});

	it("applies several edits in one call", async () => {
		const dir = await tmp();
		const file = path.join(dir, "multi.ts");
		await writeFile(file, "const x = 1;\nconst y = 2;\nconst z = 3;\n");
		const tool = createEditTool({ cwd: dir });
		const result = await tool.execute(
			{
				path: file,
				edits: [
					{ oldText: "const x = 1;", newText: "const x = 10;" },
					{ oldText: "const z = 3;", newText: "const z = 30;" },
				],
			},
			signal,
		);
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("2 edits applied");
		expect(result.display).toContain("@@ old 1 new 1 @@");
		expect(result.display).toContain("@@ old 3 new 3 @@");
		expect(await readFile(file, "utf8")).toBe("const x = 10;\nconst y = 2;\nconst z = 30;\n");
	});

	it("numbers a later hunk by its new-file start after an insertion", async () => {
		const dir = await tmp();
		const file = path.join(dir, "shift.ts");
		await writeFile(file, "one\ntwo\nthree\nfour\nfive\n");
		const tool = createEditTool({ cwd: dir });
		const result = await tool.execute(
			{
				path: file,
				edits: [
					{ oldText: "one\ntwo", newText: "one\nINSERTED1\nINSERTED2\ntwo" },
					{ oldText: "five", newText: "FIVE" },
				],
			},
			signal,
		);
		expect(result.isError).toBeFalsy();
		expect(result.display).toContain("@@ old 5 new 7 @@");
	});

	it("shows the old-file line number for a deletion-only edit", async () => {
		const dir = await tmp();
		const file = path.join(dir, "delete.ts");
		await writeFile(file, "one\ntwo\nthree\n");
		const tool = createEditTool({ cwd: dir });
		const result = await tool.execute({ path: file, edits: [{ oldText: "two\n", newText: "" }] }, signal);
		expect(result.isError).toBeFalsy();
		expect(result.display).toContain("@@ old 2 new 2 @@");
		expect(result.display).toContain("- two");
	});

	it("is atomic: a failing edit leaves the file untouched", async () => {
		const dir = await tmp();
		const file = path.join(dir, "atomic.ts");
		const original = "keep\nme\n";
		await writeFile(file, original);
		const tool = createEditTool({ cwd: dir });
		const result = await tool.execute(
			{
				path: file,
				edits: [
					{ oldText: "keep", newText: "CHANGE" },
					{ oldText: "nope-not-here", newText: "x" },
				],
			},
			signal,
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("edits[1]");
		expect(await readFile(file, "utf8")).toBe(original);
	});

	it("preserves CRLF line endings and BOM", async () => {
		const dir = await tmp();
		const file = path.join(dir, "crlf.txt");
		await writeFile(file, "\uFEFFalpha\r\nbeta\r\n");
		const tool = createEditTool({ cwd: dir });
		const result = await tool.execute({ path: file, edits: [{ oldText: "beta", newText: "gamma" }] }, signal);
		expect(result.isError).toBeFalsy();
		const content = await readFile(file, "utf8");
		expect(content).toBe("\uFEFFalpha\r\ngamma\r\n");
	});

	it("reports a helpful error on zero matches", async () => {
		const dir = await tmp();
		const file = path.join(dir, "missing.ts");
		await writeFile(file, "actual content\n");
		const tool = createEditTool({ cwd: dir });
		const result = await tool.execute(
			{ path: file, edits: [{ oldText: "wrong\n\tindentation", newText: "x" }] },
			signal,
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("not found");
		expect(result.output).toContain("whitespace");
	});

	it("errors on missing files", async () => {
		const dir = await tmp();
		const tool = createEditTool({ cwd: dir });
		const result = await tool.execute(
			{ path: path.join(dir, "ghost.ts"), edits: [{ oldText: "a", newText: "b" }] },
			signal,
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("Error reading");
	});
});

describe("write tool", () => {
	it("creates a new file with parent directories", async () => {
		const dir = await tmp();
		const tool = createWriteTool({ cwd: dir });
		const result = await tool.execute(
			{ path: path.join(dir, "nested/deep/file.txt"), content: "line1\nline2\n" },
			signal,
		);
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("Created");
		expect(result.output).toContain("2 lines");
		expect(await readFile(path.join(dir, "nested/deep/file.txt"), "utf8")).toBe("line1\nline2\n");
	});

	it("overwrites an existing file and says so", async () => {
		const dir = await tmp();
		const file = path.join(dir, "exists.txt");
		await writeFile(file, "old");
		const tool = createWriteTool({ cwd: dir });
		const result = await tool.execute({ path: file, content: "new" }, signal);
		expect(result.output).toContain("Overwrote");
		expect(await readFile(file, "utf8")).toBe("new");
	});
});

describe("withFileLock", () => {
	it("serializes concurrent mutations of the same file", async () => {
		const order: number[] = [];
		const task = (id: number, ms: number) =>
			withFileLock("/tmp/imp-lock-test-file", async () => {
				order.push(id);
				await new Promise((r) => setTimeout(r, ms));
			});

		await Promise.all([task(1, 30), task(2, 5), task(3, 1)]);
		expect(order).toEqual([1, 2, 3]);
	});

	it("runs mutations of different files concurrently", async () => {
		let running = 0;
		let maxRunning = 0;
		const task = (file: string) =>
			withFileLock(file, async () => {
				running++;
				maxRunning = Math.max(maxRunning, running);
				await new Promise((r) => setTimeout(r, 20));
				running--;
			});
		await Promise.all([task("/tmp/a"), task("/tmp/b")]);
		expect(maxRunning).toBe(2);
	});
});

describe("edit output contract (prompt-audit P1)", () => {
	it("model content is a one-liner; the diff is display-only", async () => {
		const dir = await tmp();
		const file = path.join(dir, `p1-${Date.now()}.ts`);
		await writeFile(file, "const a = 1;\nconst b = 2;\n");
		const edit = createEditTool({ cwd: dir });
		const result = await edit.execute(
			{ path: file, edits: [{ oldText: "const a = 1;", newText: "const a = 42;" }] },
			signal,
		);
		const modelText = contentText(result.content ?? "");
		expect(modelText.trim()).toMatch(/^Edited .*: 1 edit applied\.$/);
		expect(modelText).not.toContain("@@");
		expect(result.display).toBeDefined();
		expect(result.display).toContain("@@ old 1 new 1 @@");
		expect(result.display).toContain("- const a = 1;");
		expect(result.display).toContain("+ const a = 42;");
		// output doubles as the pre-P1 display fallback (read-image pattern)
		expect(result.output).toBe(result.display);
	});
});
