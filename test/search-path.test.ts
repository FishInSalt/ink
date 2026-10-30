import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectBinary } from "../src/core/tools/bin-detect.js";
import { fdCapabilities } from "../src/core/tools/fd-capabilities.js";
import { createFindTool } from "../src/core/tools/find.js";
import { createGrepTool } from "../src/core/tools/grep.js";
import { resolveSearchPath } from "../src/core/tools/search-path.js";
import { mkTempDirAsync } from "./helpers/mktemp.js";

const signal = new AbortController().signal;
const hasRg = await detectBinary("rg");
const hasFd = await detectBinary("fd");
const hasFind = hasFd && Boolean((await fdCapabilities("fd").catch(() => undefined))?.maxResults);
afterEach(() => vi.unstubAllEnvs());

describe("search path spelling", () => {
	it.each([
		["@space\u00a0dir/link/../target/", "space dir/link/../target/"],
		["@@foo", "@foo"],
		["@@~", "@~"],
		["@@/tmp/x", "@/tmp/x"],
	])("normalizes %s once without collapsing components", (raw, childPath) => {
		expect(resolveSearchPath(raw, "/project")).toEqual({
			childPath,
			resolvedPath: `/project/${childPath}`,
		});
	});
});

async function symlinkFixture() {
	const root = await mkTempDirAsync("ink-search-");
	await mkdir(path.join(root, "lexical"));
	await mkdir(path.join(root, "actual", "child"), { recursive: true });
	await mkdir(path.join(root, "actual", "target"));
	await writeFile(path.join(root, "actual", "target", "file.txt"), "target-probe\n");
	await symlink("../actual/child", path.join(root, "lexical", "link"));
	return { root, relative: "lexical/link/../target" };
}

for (const { name, available, create, pattern } of [
	{ name: "grep", available: hasRg, create: createGrepTool, pattern: "probe" },
	{ name: "find", available: hasFind, create: createFindTool, pattern: "*.txt" },
]) {
	describe.skipIf(process.platform === "win32" || !available)(`${name} filesystem paths`, () => {
		it.each(["relative", "absolute", "home", "at-prefix"] as const)(
			"follows symlink/.. in the search path (%s)",
			async (style) => {
				const { root, relative } = await symlinkFixture();
				vi.stubEnv("HOME", root);
				// Concatenation is intentional: path.join would remove link/.. in this fixture.
				const expanded = `${root}/${relative}`;
				const raw =
					style === "absolute"
						? expanded
						: style === "home"
							? `~/${relative}`
							: style === "at-prefix"
								? `@${relative}`
								: relative;
				const result = await create({ cwd: root }).execute({ pattern, path: raw }, signal);
				expect(result.isError).toBeFalsy();
				expect(result.output).toContain(
					`${style === "absolute" || style === "home" ? expanded : relative}/file.txt`,
				);
				if (name === "grep") expect(result.output).toContain("target-probe");
			},
		);

		it("searches the filesystem target even when the lexical target also exists", async () => {
			const { root, relative } = await symlinkFixture();
			await mkdir(path.join(root, "lexical", "target"));
			await writeFile(path.join(root, "lexical", "target", "wrong.txt"), "lexical-probe\n");
			const result = await create({ cwd: root }).execute({ pattern, path: relative }, signal);
			expect(result.isError).toBeFalsy();
			expect(result.output).toContain("file.txt");
			expect(result.output).not.toContain("wrong.txt");
			expect(result.output).not.toContain("lexical-probe");
		});

		it.each(["absolute", "relative"] as const)("preserves symlink/.. in tool cwd (%s)", async (style) => {
			const { root } = await symlinkFixture();
			const base = style === "absolute" ? root : path.relative(process.cwd(), root);
			const cwd = `${base}/lexical/link/..`;
			const result = await create({ cwd }).execute({ pattern, path: "target" }, signal);
			expect(result.isError).toBeFalsy();
			expect(result.output).toContain("target/file.txt");
		});

		it.each(["missing/../existing", "file.txt/../existing", "file.txt/"])(
			"rejects %s during preflight instead of collapsing it",
			async (requested) => {
				const root = await mkTempDirAsync("ink-search-");
				await mkdir(path.join(root, "existing"));
				await writeFile(path.join(root, "file.txt"), "probe\n");
				const result = await create({ cwd: root }).execute({ pattern, path: requested }, signal);
				expect(result.isError).toBe(true);
				expect(result.output).toContain("Error: path not found:");
				expect(result.output).not.toContain("stderr:");
			},
		);

		it("accepts a directory with a trailing separator", async () => {
			const { root } = await symlinkFixture();
			const result = await create({ cwd: root }).execute({ pattern, path: "actual/target/" }, signal);
			expect(result.isError).toBeFalsy();
			expect(result.output).toContain("file.txt");
		});
	});
}

it.skipIf(process.platform === "win32" || !hasRg)(
	"grep accepts a file reached through symlink/..",
	async () => {
		const { root, relative } = await symlinkFixture();
		const result = await createGrepTool({ cwd: root }).execute(
			{ pattern: "target-probe", path: `${relative}/file.txt` },
			signal,
		);
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain(`${relative}/file.txt:1:target-probe`);
	},
);
