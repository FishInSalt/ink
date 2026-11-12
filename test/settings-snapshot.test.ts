import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSettingsSnapshot } from "../src/core/settings.js";
import { COMMANDS, type CommandContext } from "../src/repl/commands.js";
import type { Runner } from "../src/runner.js";
import { makeRenderer } from "./helpers/fakes.js";
import { mkTempDir } from "./helpers/mktemp.js";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

afterEach(() => {
	vi.clearAllMocks();
	vi.unstubAllEnvs();
});

function fixture() {
	const cwd = mkTempDir("ink-settings-snapshot-");
	mkdirSync(join(cwd, ".ink"));
	const globalPath = join(cwd, "global.json");
	const projectPath = join(cwd, ".ink", "settings.json");
	writeFileSync(globalPath, JSON.stringify({ autoCompact: true, images: { autoResize: false } }));
	writeFileSync(projectPath, JSON.stringify({ autoCompact: false, branchSummary: { skipPrompt: true } }));
	return { cwd, globalPath, projectPath };
}

function readsOf(file: string): number {
	return vi.mocked(readFileSync).mock.calls.filter(([path]) => path === file).length;
}

async function panel(paths: ReturnType<typeof fixture>, projectAllowed = true): Promise<string> {
	const { renderer, output } = makeRenderer();
	const ctx: CommandContext = {
		runner: {
			runnerCwd: paths.cwd,
			projectSettingsAllowed: projectAllowed,
			globalSettingsPath: () => paths.globalPath,
		} as Runner,
		renderer,
		isActive: () => false,
		requestExit: () => undefined,
		abortActive: () => false,
		replay: () => 0,
		submitPrompt: () => undefined,
	};
	const command = COMMANDS.find((entry) => entry.name === "settings");
	expect(command).toBeDefined();
	expect(await command!.run("", ctx)).toBe("handled");
	return output();
}

describe("settings snapshot", () => {
	it("returns both scopes and merged values with one read each, without caching", () => {
		const paths = fixture();
		const options = { ...paths, projectAllowed: true };
		const first = loadSettingsSnapshot(options);
		expect(first.global.autoCompact).toBe(true);
		expect(first.project.autoCompact).toBe(false);
		expect(first.effective).toEqual({
			autoCompact: false,
			images: { autoResize: false },
			branchSummary: { skipPrompt: true },
		});
		expect(readsOf(paths.globalPath)).toBe(1);
		expect(readsOf(paths.projectPath)).toBe(1);
		writeFileSync(paths.projectPath, JSON.stringify({ autoCompact: true }));
		expect(loadSettingsSnapshot(options).effective.autoCompact).toBe(true);
		expect(first.project.autoCompact).toBe(false);
		expect(readsOf(paths.globalPath)).toBe(2);
		expect(readsOf(paths.projectPath)).toBe(2);
	});

	it("projects all panel values and sources from two file reads", async () => {
		const paths = fixture();
		const text = await panel(paths);
		expect(text).toContain("autoCompact = false [project]");
		expect(text).toContain("images.autoResize = false [global]");
		expect(text).toContain("branchSummary.skipPrompt = true [project]");
		expect(text).toContain("treeFilterMode = default [default]");
		expect(readsOf(paths.globalPath)).toBe(1);
		expect(readsOf(paths.projectPath)).toBe(1);
	});

	it("never reads untrusted project settings, including for source labels", async () => {
		const paths = fixture();
		const text = await panel(paths, false);
		expect(text).toContain("autoCompact = true [global]");
		expect(text).toContain("branchSummary.skipPrompt = false [default]");
		expect(readsOf(paths.globalPath)).toBe(1);
		expect(readsOf(paths.projectPath)).toBe(0);
	});

	it("keeps environment shadows and rereads changed scopes on the next refresh", async () => {
		const paths = fixture();
		vi.stubEnv("INK_MODEL", "zai/glm-5.3");
		vi.stubEnv("INK_AUTOCOMPACT", "0");
		expect(await panel(paths)).toContain("autoCompact = false [env]");
		writeFileSync(paths.projectPath, "{}");
		const text = await panel(paths);
		expect(text).toContain("defaultModel = zai/glm-5.3 [env]");
		expect(text).toContain("branchSummary.skipPrompt = false [default]");
		expect(readsOf(paths.globalPath)).toBe(2);
		expect(readsOf(paths.projectPath)).toBe(2);
	});
});
