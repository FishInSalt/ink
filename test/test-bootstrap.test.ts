import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { mkTempDir } from "./helpers/mktemp.js";
import { runVitestProbe } from "./helpers/run-vitest-probe.js";

it("real Vitest bootstrap contains worker and Node+tsx fixtures and inherits the offline preload", async () => {
	const repo = path.resolve(import.meta.dirname, "..");
	const report = path.join(mkTempDir("ink-bootstrap-"), "report.json");
	const { stdout, stderr } = await runVitestProbe(
		[
			path.join(repo, "node_modules/vitest/vitest.mjs"),
			"run",
			"--config",
			"test/fixtures/bootstrap-probe.config.ts",
			"test/fixtures/bootstrap-probe.case.ts",
		],
		{ ...process.env, INK_BOOTSTRAP_REPORT: report },
	);
	expect(stdout).toContain("1 passed");
	const probe = JSON.parse(readFileSync(report, "utf8"));
	expect(probe.fixture.startsWith(`${probe.root}/`)).toBe(true);
	expect(probe.child.tmpdir).toBe(probe.root);
	// The settings sandbox cleans itself, not its siblings. Retained
	// diagnostics (and tsx's cache) must survive both coordinators.
	expect(stderr).toContain(`[test-run-root] retained ${probe.root}:`);
	expect(existsSync(probe.root)).toBe(true);
	expect(existsSync(probe.home)).toBe(false);
	expect(readFileSync(path.join(probe.root, "bootstrap-diagnostic"), "utf8")).toBe("retained evidence");
}, 35_000);
