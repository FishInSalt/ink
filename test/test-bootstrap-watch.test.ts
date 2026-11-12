import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { mkTempDir } from "./helpers/mktemp.js";
import { runVitestProbe } from "./helpers/run-vitest-probe.js";

const keys = ["TMPDIR", "TMP", "TEMP"] as const;

it.each([
	["cancel-first", "missing"],
	["cancel-first", "empty"],
	["cancel-rerun", "missing"],
	["cancel-rerun", "empty"],
])(
	"real Vitest watch API keeps all workers/Node+tsx inside one root: %s, env=%s",
	async (scenario, variant) => {
		const directory = mkTempDir("ink-bootstrap-watch-");
		const env = { ...process.env };
		for (const key of keys) {
			if (variant === "missing") delete env[key];
			else env[key] = "";
		}
		const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
		const { stderr } = await runVitestProbe(
			[
				"--import",
				loader,
				path.join(import.meta.dirname, "fixtures/watch-bootstrap-driver.ts"),
				directory,
				scenario,
				variant,
			],
			env,
		);
		const result = JSON.parse(readFileSync(path.join(directory, "result.json"), "utf8"));
		const expected = keys.map((key) => ({
			key,
			present: variant !== "missing",
			value: variant === "missing" ? null : "",
		}));
		expect(result.original).toEqual(expected);
		expect(result.restored).toEqual(expected);
		expect(result.configRestored).toBe(true);
		expect(result.rounds).toHaveLength(3);
		expect(result.rounds.map((round: { reason: string }) => round.reason)).toEqual(
			scenario === "cancel-first" ? ["interrupted", "passed", "passed"] : ["passed", "interrupted", "passed"],
		);
		const root = result.rounds[0].probe.root;
		for (const { probe, coordinator } of result.rounds) {
			expect(coordinator).toEqual(expected);
			expect(probe.root).toBe(root);
			expect(probe.fixture.startsWith(`${root}/`)).toBe(true);
			expect(probe.child.tmpdir).toBe(root);
			expect(probe.child.preloaded).toBe(true);
			expect(existsSync(probe.home)).toBe(false);
		}
		expect(stderr).toContain(`[test-run-root] retained ${root}:`);
		expect(readFileSync(path.join(root, "bootstrap-diagnostic"), "utf8")).toBe("retained evidence");
	},
	35_000,
);
