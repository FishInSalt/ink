import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRunner, type RunnerOptions } from "../src/runner.js";
import { makeRenderer, scriptedProvider } from "./helpers/fakes.js";
import { mkTempDir } from "./helpers/mktemp.js";

const legacyStates = [undefined, false, true];
const canonicalStates: unknown[] = [undefined, false, true, null, 0, 1, "true", "false", {}, []];
const cases = canonicalStates.flatMap((canonical) =>
	legacyStates.flatMap((settings) =>
		legacyStates.flatMap((agents) =>
			legacyStates.map((systemPrompt) => ({
				label: `canonical=${JSON.stringify(canonical)} settings=${settings} agents=${agents} system=${systemPrompt}`,
				canonical,
				settings,
				agents,
				systemPrompt,
				// Independent expectations, including the asymmetric legacy defaults.
				expected:
					canonical === undefined
						? [settings ?? false, agents ?? true, systemPrompt ?? false]
						: canonical === true
							? [settings !== false, agents !== false, systemPrompt !== false]
							: [false, false, false],
			})),
		),
	),
);

let previousLog: string | undefined;
beforeEach(() => {
	previousLog = process.env.INK_LOG;
	process.env.INK_LOG = "0";
});
afterEach(() => {
	if (previousLog === undefined) delete process.env.INK_LOG;
	else process.env.INK_LOG = previousLog;
});

describe("Runner project trust compatibility adapter", () => {
	it.each(cases)("$label", async ({ canonical, settings, agents, systemPrompt, expected }) => {
		const root = mkTempDir("ink-runner-project-trust-");
		const cwd = join(root, "repo");
		const home = join(root, "home");
		for (const dir of [cwd, home]) mkdirSync(join(dir, ".ink", "agents"), { recursive: true });
		const globalPath = join(home, ".ink", "settings.json");
		const projectPath = join(cwd, ".ink", "settings.json");
		const agentPath = join(cwd, ".ink", "agents", "project-scout.md");
		writeFileSync(globalPath, '{"autoCompact":true}');
		writeFileSync(projectPath, '{"autoCompact":false}');
		writeFileSync(agentPath, "---\nname: project-scout\ndescription: original project scout\n---\nbody");
		writeFileSync(
			join(home, ".ink", "agents", "global-scout.md"),
			"---\nname: global-scout\ndescription: global scout\n---\nbody",
		);
		for (const dir of [cwd, home]) {
			const tier = dir === cwd ? "project" : "global";
			writeFileSync(join(dir, ".ink", "SYSTEM.md"), `${tier} persona`);
			writeFileSync(join(dir, ".ink", "APPEND_SYSTEM.md"), `${tier} appendix`);
		}
		const options: RunnerOptions = {
			cwd,
			argv: [],
			model: "test-model",
			maxTokens: 100,
			maxTurns: 1,
			noContextFiles: true,
			noSession: true,
			settingsPath: globalPath,
			agentsHomeDir: home,
			systemPromptHomeDir: home,
			projectSettingsAllowed: settings,
			agentsProjectAllowed: agents,
			systemPromptProjectAllowed: systemPrompt,
			renderer: makeRenderer().renderer,
			provider: scriptedProvider([]),
		};
		// Truly omit the new key for legacy callers, not just set it undefined.
		if (canonical !== undefined) options.projectTrusted = canonical as boolean;
		const runner = await createRunner(options);
		try {
			const [settingsAllowed, agentsAllowed, systemAllowed] = expected;
			expect(runner.projectSettingsAllowed).toBe(settingsAllowed);
			expect(runner.effectiveSettings().autoCompact).toBe(!settingsAllowed);
			expect(runner.system.includes("project-scout")).toBe(agentsAllowed);
			expect(runner.system).toContain("global-scout");
			for (const suffix of ["persona", "appendix"]) {
				expect(runner.system.includes(`project ${suffix}`)).toBe(systemAllowed);
				expect(runner.system.includes(`global ${suffix}`)).toBe(!systemAllowed);
			}

			// Permissions are captured once, settings are a construction snapshot,
			// agents load once, but prompt refresh reads using the captured gate.
			options.projectTrusted = !systemAllowed;
			options.projectSettingsAllowed = !settingsAllowed;
			options.agentsProjectAllowed = !agentsAllowed;
			options.systemPromptProjectAllowed = !systemAllowed;
			writeFileSync(projectPath, '{"autoCompact":true}');
			writeFileSync(agentPath, "---\nname: revised-scout\ndescription: revised\n---\nbody");
			writeFileSync(join(cwd, ".ink", "SYSTEM.md"), "refreshed project persona");
			writeFileSync(join(cwd, ".ink", "APPEND_SYSTEM.md"), "refreshed project appendix");
			runner.refreshSystemPrompt();
			expect(runner.projectSettingsAllowed).toBe(settingsAllowed);
			expect(runner.effectiveSettings().autoCompact).toBe(!settingsAllowed);
			expect(runner.system.includes("project-scout")).toBe(agentsAllowed);
			expect(runner.system).not.toContain("revised-scout");
			expect(runner.system).toContain("global-scout");
			for (const suffix of ["persona", "appendix"]) {
				expect(runner.system.includes(`refreshed project ${suffix}`)).toBe(systemAllowed);
				expect(runner.system.includes(`global ${suffix}`)).toBe(!systemAllowed);
			}
		} finally {
			runner.close();
		}
	});
});
