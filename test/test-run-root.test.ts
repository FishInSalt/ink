import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { TestProject } from "vitest/node";
import setup from "./helpers/global-setup.js";
import { mkTempDir } from "./helpers/mktemp.js";
import { createTestRunRoot } from "./helpers/test-run-root.js";

const keys = ["TMPDIR", "TMP", "TEMP"] as const;

describe("private test run root lifecycle", () => {
	it.each([{}, { TMPDIR: "", TMP: "/original/tmp", TEMP: "" }, { TMPDIR: "/original" }])(
		"creates a unique 0700 root, removes only empty roots, and restores exact env: %j",
		(original) => {
			const parent = mkTempDir("ink-test-root-");
			const env: NodeJS.ProcessEnv = { ...original, OTHER: "unchanged" };
			const before = { ...env };
			const run = createTestRunRoot({ env, parent });
			const other = createTestRunRoot({ env: {}, parent });
			try {
				expect(run.root).not.toBe(other.root);
				expect(statSync(run.root).mode & 0o777).toBe(0o700);
				for (const key of keys) expect(env[key]).toBe(run.root);
				run.teardown();
				expect(env).toEqual(before);
				expect(existsSync(run.root)).toBe(false);
				run.teardown(); // idempotent even if the root has already gone
			} finally {
				run.teardown();
				other.teardown();
			}
		},
	);

	it("retains nonempty roots, FIFO paths, visual and external diagnostics without following symlinks", () => {
		const parent = mkTempDir("ink-test-root-");
		const external = path.join(parent, "ink-renderer-logs-external");
		mkdirSync(external);
		writeFileSync(path.join(external, "evidence"), "external diagnostics");
		const report = vi.fn();
		const env: NodeJS.ProcessEnv = { TMP: "original" };
		const run = createTestRunRoot({ env, parent, report });
		mkdirSync(path.join(run.root, "fifo-inconclusive"));
		// No holder/process is attached to this synthetic FIFO. Only the owning
		// test's finishing cleanup may remove it after preservation is checked.
		if (process.platform !== "win32")
			execFileSync("mkfifo", [path.join(run.root, "fifo-inconclusive", "pipe")], { timeout: 1000 });
		writeFileSync(path.join(run.root, "visual-frame"), "retained frame");
		symlinkSync(external, path.join(run.root, "diagnostics"), "dir");
		run.teardown();
		expect(env).toEqual({ TMP: "original" });
		expect(readFileSync(path.join(run.root, "visual-frame"), "utf8")).toBe("retained frame");
		expect(existsSync(path.join(run.root, "fifo-inconclusive"))).toBe(true);
		expect(readFileSync(path.join(external, "evidence"), "utf8")).toBe("external diagnostics");
		expect(report).toHaveBeenCalledWith(expect.stringContaining(`retained ${run.root}`));
	});

	it.each([false, true])("setup redirection failure restores env; populated=%s", (populated) => {
		const parent = mkTempDir("ink-test-root-");
		const env: NodeJS.ProcessEnv = { TEMP: "", TMP: "original" };
		let root = "";
		let fail = true;
		const proxy = new Proxy(env, {
			set(target, key, value) {
				if (key === "TMPDIR") root = value;
				if (key === "TMP" && fail) {
					fail = false;
					if (populated) writeFileSync(path.join(root, "evidence"), "setup failed");
					throw new Error("injected redirection failure");
				}
				return Reflect.set(target, key, value);
			},
		});
		const report = vi.fn();
		expect(() => createTestRunRoot({ env: proxy, parent, report })).toThrow("injected redirection failure");
		expect(env).toEqual({ TEMP: "", TMP: "original" });
		expect(existsSync(root)).toBe(populated);
		if (populated) {
			expect(readFileSync(path.join(root, "evidence"), "utf8")).toBe("setup failed");
			expect(report).toHaveBeenCalledWith(expect.stringContaining(root));
		}
	});

	it("creation failure leaves env untouched", () => {
		const env = { TMPDIR: "", TEMP: "original" };
		expect(() =>
			createTestRunRoot({ env, parent: path.join(mkTempDir("ink-test-root-"), "missing") }),
		).toThrow();
		expect(env).toEqual({ TMPDIR: "", TEMP: "original" });
	});

	it.each([
		{},
		{ env: undefined },
		{ env: {} },
		{ env: { TMPDIR: "", TMP: undefined, TEMP: "original", OTHER: "unchanged" } },
	])("global setup scopes worker env and restores the exact config: %j", (config) => {
		const original = keys.map((key) => [key, process.env[key]] as const);
		const parent = mkTempDir("ink-test-root-");
		const beforeConfig = { ...config };
		const beforeEnv = config.env;
		if (beforeEnv) Object.freeze(beforeEnv);
		let root = "";
		const project = {
			config,
			provide(_key: string, value: string) {
				root = value;
			},
		} as unknown as TestProject;
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		process.env.TMPDIR = parent;
		delete process.env.TMP;
		process.env.TEMP = "";
		const coordinator = keys.map((key) => [key, process.env[key]]);
		try {
			const teardown = setup(project);
			expect(keys.map((key) => [key, process.env[key]])).toEqual(coordinator);
			for (const key of keys) expect(project.config.env[key]).toBe(root);
			expect(config.env).not.toBe(beforeEnv);
			writeFileSync(path.join(root, "diagnostic"), "retained through reruns");
			teardown();
			expect(config).toEqual(beforeConfig);
			expect(Object.hasOwn(config, "env")).toBe(Object.hasOwn(beforeConfig, "env"));
			expect(config.env).toBe(beforeEnv);
			expect(keys.map((key) => [key, process.env[key]])).toEqual(coordinator);
			expect(readFileSync(path.join(root, "diagnostic"), "utf8")).toBe("retained through reruns");
			expect(warn).toHaveBeenCalledWith(expect.stringContaining(root));

			project.provide = (_key, value) => {
				root = value as string;
				writeFileSync(path.join(root, "diagnostic"), "setup error");
				throw new Error("provide failed");
			};
			expect(() => setup(project)).toThrow("provide failed");
			expect(config).toEqual(beforeConfig);
			expect(Object.hasOwn(config, "env")).toBe(Object.hasOwn(beforeConfig, "env"));
			expect(config.env).toBe(beforeEnv);
			expect(keys.map((key) => [key, process.env[key]])).toEqual(coordinator);
			expect(readFileSync(path.join(root, "diagnostic"), "utf8")).toBe("setup error");
		} finally {
			warn.mockRestore();
			for (const [key, value] of original) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});
});
