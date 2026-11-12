import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MAX_TOKENS } from "../src/core/constants.js";
import { processFileArguments } from "../src/core/file-processor.js";
import { AGENTS_SKILLS_PATH, INK_RESOURCE_PATHS } from "../src/core/resource-paths.js";
import { createSession, resolveSession } from "../src/core/session/manager.js";
import {
	effectiveSettings,
	loadProjectSettings,
	loadSettings,
	loadSettingsSnapshot,
} from "../src/core/settings.js";
import * as trust from "../src/core/trust.js";
import { ExtensionRegistry } from "../src/extensions/registry.js";
import { LOGIN_TARGETS } from "../src/provider/login-targets.js";
import { configuredFamilies, modelAvailability } from "../src/provider/model-availability.js";
import { parseModelRef } from "../src/provider/model-ref.js";
import { decideStartupModel } from "../src/provider/startup-model.js";
import { THINKING_LEVELS } from "../src/provider/thinking.js";
import { Renderer } from "../src/render.js";
import { TranscriptSink } from "../src/repl/transcript.js";
import type { TrustAskAnswer } from "../src/repl/trust-ask.js";
import { createRunner, type Runner, type RunnerOptions, resolveRunMode } from "../src/runner.js";
import { mkTempDir } from "./helpers/mktemp.js";

// Observe actual disk reads, forwarding every call to node:fs. In particular,
// no selection, trust, settings, D2 or preflight helper is replaced with a fake.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

// Execute real CLI declarations without importing cli.ts's top-level main().
// The obsolete helper is included only to make the regression runnable on base.
const source = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
const file = ts.createSourceFile("cli.ts", source, ts.ScriptTarget.Latest, true);
const names = new Set([
	"BUILTIN_MODEL",
	"requestedModel",
	"projectDefaultModelIfTrusted",
	"applyConfiguredModelDefaults",
	"envThinking",
	"parseArgs",
	"runnerOptions",
	"resumingExistingSession",
	"decideStartupResolution",
	"printNoModelText",
	"printModelUnusable",
	"resolveProjectTrust",
	"broadAncestorWarning",
	"reportStartupError",
	"runInteractive",
	"runPrint",
	"main",
]);
const declarations = file.statements.filter((node) => {
	if (ts.isFunctionDeclaration(node)) return names.has(node.name?.text ?? "");
	return (
		ts.isVariableStatement(node) &&
		node.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && names.has(d.name.text))
	);
});
const { outputText } = ts.transpileModule(declarations.map((node) => node.getText(file)).join("\n"), {
	compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
});

type Options = RunnerOptions & {
	fileArgs: string[];
	trustDecision?: "trust" | "no-trust";
	modelSource: string;
	modelExplicit: boolean;
};
interface Cli {
	parseArgs(argv: string[]): Options;
	runInteractive(opts: Options, argv: string[]): Promise<void>;
	runPrint(opts: Options, argv: string[]): Promise<void>;
	main(): Promise<void>;
}
function put(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}
function readsOf(path: string): number {
	return vi.mocked(readFileSync).mock.calls.filter(([file]) => file === path).length;
}
function sandbox(project: string | null = "openai/project", global: string | null = "openai/global") {
	const root = mkTempDir("ink-startup-trust-ast-");
	const cwd = join(root, "repo");
	const home = join(root, "home");
	mkdirSync(join(cwd, ".git"), { recursive: true });
	mkdirSync(home);
	const projectPath = join(cwd, ".ink", "settings.json");
	const globalPath = join(home, ".ink", "settings.json");
	if (project !== null) put(projectPath, JSON.stringify({ defaultModel: project }));
	if (global !== null) put(globalPath, JSON.stringify({ defaultModel: global }));
	vi.stubEnv("INK_SETTINGS_PATH", globalPath);
	vi.stubEnv("INK_AUTH_PATH", join(home, "auth.json"));
	return {
		root,
		cwd,
		home,
		projectPath,
		globalPath,
		store: trust.defaultTrustStorePath(home),
		sessions: join(root, "sessions"),
	};
}
type Paths = ReturnType<typeof sandbox>;

function harness(
	paths: Paths,
	options: {
		interactive?: boolean;
		answer?: TrustAskAnswer | null;
		beforeAnswer?: () => void;
		failLoader?: boolean;
		failRun?: boolean;
	} = {},
) {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const events: string[] = [];
	const renderers: Renderer[] = [];
	const notes: string[] = [];
	const originalNotes: Renderer["note"][] = [];
	const runners: Runner[] = [];
	const fakeProcess = {
		env: process.env,
		argv: ["node", "ink"],
		cwd: () => paths.cwd,
		stdin: { isTTY: options.interactive === true },
		stdout: { isTTY: options.interactive === true, write: (text: string) => stdout.push(text) },
		stderr: { write: (text: string) => stderr.push(text) },
		on: vi.fn(),
		off: vi.fn(),
		once: vi.fn(),
		exitCode: undefined as number | undefined,
		exit: (code: number) => {
			throw new Error(`CLI exit ${code}`);
		},
	};
	const ask = vi.fn(async () => {
		events.push("ask");
		expect(readsOf(paths.projectPath)).toBe(0);
		options.beforeAnswer?.();
		return options.answer ?? null;
	});
	const extensions = vi.fn(async (_opts: Options, renderer: Renderer) => {
		events.push("extensions");
		renderer.note("extension witness");
		if (options.failLoader) throw new Error("loader fixture failure");
		return { runtime: new ExtensionRegistry(), failures: [] };
	});
	const skills = vi.fn(() => {
		events.push("skills");
		return { skills: [], enableSkillCommands: true };
	});
	const commands = vi.fn(async () => {
		events.push("commands");
		return { commands: [] };
	});
	const mcp = vi.fn(() => {
		events.push("mcp");
		return undefined;
	});
	const create = vi.fn(async (input: RunnerOptions) => {
		events.push("runner");
		// Real provider construction and real restore/D3, but no inference or UI.
		const runner = await createRunner({
			...input,
			sessionBaseDir: paths.sessions,
			settingsPath: paths.globalPath,
			agentsHomeDir: paths.home,
			systemPromptHomeDir: paths.home,
		});
		runners.push(runner);
		vi.spyOn(runner, "runTurn").mockImplementation(async () => {
			events.push("run");
			if (options.failRun) throw new Error("stream fixture failure");
			return { stopReason: "completed", turns: 0, usage: { inputTokens: 0, outputTokens: 0 } };
		});
		return runner;
	});
	const repl = vi.fn(
		async ({ runner, releaseStartupNotes }: { runner: Runner; releaseStartupNotes?: () => void }) => {
			runner.warmup();
			releaseStartupNotes?.();
			events.push("repl");
			return 0;
		},
	);
	const quick = { sessions: vi.fn(), login: vi.fn(async () => 0), logout: vi.fn(async () => undefined) };
	const snapshot = vi.fn((input: Parameters<typeof loadSettingsSnapshot>[0]) => {
		events.push("defaults");
		return loadSettingsSnapshot(input);
	});
	const context = vm.createContext({
		...trust,
		DEFAULT_MAX_TOKENS,
		AGENTS_SKILLS_PATH,
		INK_RESOURCE_PATHS,
		THINKING_LEVELS,
		LOGIN_TARGETS,
		AbortController,
		process: fakeProcess,
		homedir: () => paths.home,
		dim: (text: string) => text,
		red: (text: string) => text,
		HELP: "help",
		VERSION: "test",
		COMMANDS: [],
		Renderer: class extends Renderer {
			constructor(input: ConstructorParameters<typeof Renderer>[0]) {
				super(input);
				renderers.push(this);
				originalNotes.push(this.note);
			}
			override note(text: string): void {
				notes.push(text);
				super.note(text);
			}
		},
		TranscriptSink,
		TtyConfirm: class {},
		resolveShell: () => "tui",
		historyFilePath: () => join(paths.home, "history"),
		loadSettings,
		loadProjectSettings,
		loadSettingsSnapshot: snapshot,
		effectiveSettings,
		decideStartupModel,
		configuredFamilies,
		modelAvailability,
		parseModelRef,
		resolveSession: (cwd: string, input: Parameters<typeof resolveSession>[1]) =>
			resolveSession(cwd, { ...input, baseDir: paths.sessions }),
		processFileArguments,
		askTrustViaTui: ask,
		askTrustOnTty: ask,
		loadExtensionSetup: extensions,
		loadSkillSetup: skills,
		loadMdCommands: commands,
		buildSkillCommands: () => [],
		createRunner: create,
		createMcpSetup: mcp,
		runRepl: repl,
		loadDotEnv: async () => undefined,
		loadCatalogCache: vi.fn(),
		refreshCatalog: vi.fn(async () => undefined),
		killTrackedDetachedChildren: vi.fn(),
		resolveRunMode,
		printSessionList: quick.sessions,
		runCliLogin: quick.login,
		runCliLogout: quick.logout,
	});
	const cli: Cli = vm.runInContext(
		`${outputText}\n({ parseArgs, runInteractive, runPrint, main });`,
		context,
	);
	return {
		cli,
		context,
		process: fakeProcess,
		stdout,
		stderr,
		events,
		notes,
		ask,
		extensions,
		skills,
		commands,
		mcp,
		create,
		repl,
		snapshot,
		runners,
		renderers,
		originalNotes,
	};
}
async function start(h: ReturnType<typeof harness>, mode: "print" | "interactive", argv: string[] = []) {
	const args = [...(mode === "print" ? ["-p", "hello"] : []), "-nc", ...argv];
	const opts = h.cli.parseArgs(args);
	await (mode === "print" ? h.cli.runPrint(opts, args) : h.cli.runInteractive(opts, args));
	return opts;
}
function expectBlocked(h: ReturnType<typeof harness>, text: string) {
	expect(h.process.exitCode).toBe(1);
	expect(h.stdout.join("")).toBe("");
	expect(h.stderr.join("")).toContain(text);
	for (const fn of [h.extensions, h.skills, h.commands, h.create, h.mcp, h.repl])
		expect(fn).not.toHaveBeenCalled();
	expect(h.renderers[0]!.note).toBe(h.originalNotes[0]);
}

beforeEach(() => {
	for (const key of [
		"INK_MODEL",
		"ANTHROPIC_API_KEY",
		"ANTHROPIC_AUTH_TOKEN",
		"OPENAI_API_KEY",
		"ZAI_API_KEY",
		"DEEPSEEK_API_KEY",
		"MOONSHOT_API_KEY",
	])
		vi.stubEnv(key, undefined);
	vi.stubEnv("INK_LOG", "0");
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("post-trust startup defaults (actual CLI AST, trust/settings/D2/preflight)", () => {
	it("first --trust print selects the project default before credential preflight", async () => {
		const paths = sandbox();
		vi.stubEnv("OPENAI_API_KEY", "fixture");
		const h = harness(paths);
		const opts = await start(h, "print", ["--trust", "--no-session"]);
		expect(opts).toMatchObject({ model: "openai/project", modelSource: "project", modelExplicit: false });
		expect(h.create).toHaveBeenCalledOnce();
		expect(h.create.mock.calls[0]![0]).toMatchObject({ model: "openai/project", projectTrusted: true });
		expect(h.events).toEqual(["defaults", "extensions", "skills", "runner", "mcp", "run"]);
		expect(h.stdout.join("").indexOf("trust: recorded")).toBeLessThan(
			h.stdout.join("").indexOf("extension witness"),
		);
		expect(h.renderers[0]!.note).toBe(h.originalNotes[0]);
		expect(trust.readTrustFile(paths.store)[trust.canonicalizeDir(paths.cwd)]).toBe(true);
	});

	it.each(["session", "yes"] as const)(
		"first interactive %s applies project default, not a builtin fallback",
		async (answer) => {
			const paths = sandbox();
			vi.stubEnv("OPENAI_API_KEY", "fixture");
			const h = harness(paths, { interactive: true, answer });
			const opts = await start(h, "interactive", ["--no-session"]);
			expect(opts).toMatchObject({ model: "openai/project", modelSource: "project", modelExplicit: false });
			expect(h.create).toHaveBeenCalledOnce();
			expect(h.events).toEqual([
				"ask",
				"defaults",
				"extensions",
				"skills",
				"commands",
				"runner",
				"mcp",
				"repl",
			]);
			expect(h.notes.join("\n")).not.toContain("no startup model configured");
			expect(existsSync(paths.store)).toBe(answer === "yes");
		},
	);

	it.each([
		{ recorded: false, flags: ["--trust"], expected: "openai/project", allowed: true },
		{ recorded: true, flags: ["--no-trust"], expected: "openai/global", allowed: false },
		{ recorded: true, flags: ["--trust", "--no-trust"], expected: "openai/global", allowed: false },
		{ recorded: false, flags: ["--no-trust", "--trust"], expected: "openai/project", allowed: true },
		{ recorded: true, flags: ["-p", "--no-trust"], expected: "openai/project", allowed: true },
		{ recorded: false, flags: ["-p", "--trust"], expected: "openai/global", allowed: false },
	])("recorded=$recorded flags=$flags uses only the parsed final decision", async (row) => {
		const paths = sandbox();
		trust.setTrust(paths.store, paths.cwd, row.recorded);
		vi.stubEnv("OPENAI_API_KEY", "fixture");
		const h = harness(paths);
		const opts = await start(h, "print", [...row.flags, "--no-session"]);
		expect(opts.model).toBe(row.expected);
		expect(h.create.mock.calls[0]![0].projectTrusted).toBe(row.allowed);
		expect(readsOf(paths.projectPath) > 0).toBe(row.allowed);
		expect(trust.readTrustFile(paths.store)[trust.canonicalizeDir(paths.cwd)]).toBe(row.allowed);
	});

	it.each([
		{ label: "deny", interactive: true, answer: "no" as const, recorded: true },
		{ label: "cancel", interactive: true, answer: null, recorded: false },
		{ label: "pipe", interactive: false, answer: null, recorded: false },
	])("$label uses global without any project content read", async (row) => {
		const paths = sandbox();
		vi.stubEnv("OPENAI_API_KEY", "fixture");
		const h = harness(paths, row);
		const opts = await start(h, "interactive", ["--no-session"]);
		expect(opts).toMatchObject({ model: "openai/global", modelSource: "global", modelExplicit: false });
		expect(readsOf(paths.projectPath)).toBe(0);
		expect(h.create.mock.calls[0]![0].projectTrusted).toBe(false);
		expect(existsSync(paths.store)).toBe(row.recorded);
	});

	it("selection uses the session grant, never a second persistent lookup", async () => {
		const paths = sandbox();
		vi.stubEnv("OPENAI_API_KEY", "fixture");
		const h = harness(paths, {
			interactive: true,
			answer: "session",
			beforeAnswer: () => put(paths.store, "corrupt after ask"),
		});
		const opts = await start(h, "interactive", ["--no-session"]);
		expect(opts.modelSource).toBe("project");
		expect(h.create).toHaveBeenCalledOnce();
		expect(readFileSync(paths.store, "utf8")).toBe("corrupt after ask");
	});

	it.each(
		[
			{
				global: null,
				project: null,
				key: "OPENAI_API_KEY",
				model: "openai/gpt-5.2",
				source: "builtin",
				note: true,
			},
			{
				global: null,
				project: null,
				key: "ANTHROPIC_API_KEY",
				model: "claude-sonnet-4-5",
				source: "builtin",
				note: false,
			},
			{
				global: "openai/global",
				project: "openai/project",
				key: "OPENAI_API_KEY",
				model: "openai/project",
				source: "project",
				note: false,
			},
			{
				global: "openai/global",
				project: "",
				key: "OPENAI_API_KEY",
				model: "openai/global",
				source: "global",
				note: false,
			},
			{
				global: "",
				project: "",
				key: "OPENAI_API_KEY",
				model: "openai/gpt-5.2",
				source: "builtin",
				note: true,
			},
			{
				global: null,
				project: "  ",
				key: "OPENAI_API_KEY",
				model: "  ",
				source: "project",
				note: false,
			},
		].flatMap((row) => (["print", "interactive"] as const).map((mode) => ({ ...row, mode }))),
	)("$mode D2 follows defaults: project=$project global=$global key=$key", async (row) => {
		const paths = sandbox(row.project, row.global);
		vi.stubEnv(row.key, "fixture");
		const h = harness(paths, { interactive: true, answer: "session" });
		const opts = await start(h, row.mode, ["--no-session", ...(row.mode === "print" ? ["--trust"] : [])]);
		expect(opts).toMatchObject({ model: row.model, modelSource: row.source, modelExplicit: false });
		expect(h.notes.join("\n").includes("no startup model configured")).toBe(
			row.mode === "interactive" && row.note,
		);
	});

	it.each(["print", "interactive"] as const)(
		"%s retains unavailable project selection instead of D2 fallback",
		async (mode) => {
			const paths = sandbox("zai/project", null);
			vi.stubEnv("OPENAI_API_KEY", "fixture");
			const h = harness(paths, { interactive: true, answer: "session" });
			const opts = await start(h, mode, ["--trust", "--no-session"]);
			expect(opts).toMatchObject({ model: "zai/project", modelSource: "project" });
			if (mode === "print") expectBlocked(h, "zai/project (zai) has no credential");
			else {
				expect(h.create).toHaveBeenCalledOnce();
				expect(h.notes.join("\n")).not.toContain("no startup model configured");
			}
		},
	);

	it.each([
		{ env: "openai/env", flags: [], model: "openai/env", source: "env", explicit: false },
		{
			env: "openai/env",
			flags: ["-m", "openai/first", "--model", "openai/last"],
			model: "openai/last",
			source: "cli",
			explicit: true,
		},
		{ env: "", flags: [], model: "", source: "env", explicit: false },
		{ env: "  ", flags: [], model: "  ", source: "env", explicit: false },
		{ env: undefined, flags: ["-m", ""], model: "", source: "cli", explicit: true },
	])("preserves CLI/env selection and provenance: $source '$model'", async (row) => {
		const paths = sandbox();
		vi.stubEnv("INK_MODEL", row.env);
		vi.stubEnv("OPENAI_API_KEY", "fixture");
		const h = harness(paths);
		const opts = await start(h, "print", ["--trust", "--no-session", ...row.flags]);
		expect(opts).toMatchObject({ model: row.model, modelSource: row.source, modelExplicit: row.explicit });
		expect(h.snapshot).not.toHaveBeenCalled();
		expect(h.create).toHaveBeenCalledOnce(); // blank remains the existing Runner parse error, not a preflight error
		expect(trust.readTrustFile(paths.store)[trust.canonicalizeDir(paths.cwd)]).toBe(true);
	});

	it("denial without a global default permits builtin D2 without reading project settings", async () => {
		const paths = sandbox("zai/refused", null);
		vi.stubEnv("OPENAI_API_KEY", "fixture");
		const h = harness(paths);
		const opts = await start(h, "print", ["--no-trust", "--no-session"]);
		expect(opts).toMatchObject({ model: "openai/gpt-5.2", modelSource: "builtin", modelExplicit: false });
		expect(readsOf(paths.projectPath)).toBe(0);
		expect(h.create.mock.calls[0]![0].projectTrusted).toBe(false);
	});

	it("one snapshot derives value and source with one read per scope before loaders", async () => {
		const paths = sandbox();
		vi.stubEnv("OPENAI_API_KEY", "fixture");
		const h = harness(paths);
		h.extensions.mockImplementationOnce(async () => {
			expect(readsOf(paths.projectPath)).toBe(1);
			expect(readsOf(paths.globalPath)).toBe(1);
			return { runtime: new ExtensionRegistry(), failures: [] };
		});
		await start(h, "print", ["--trust", "--no-session"]);
		expect(h.snapshot).toHaveBeenCalledExactlyOnceWith({ cwd: paths.cwd, projectAllowed: true });
	});
});

describe("print trust/error channel and startup side-effect ordering", () => {
	it.each(["--trust", "--no-trust"])(
		"%s persists before explicit credential failure; pending note goes only to stderr",
		async (flag) => {
			const paths = sandbox();
			const h = harness(paths);
			await start(h, "print", [flag, "-m", "zai/absent"]);
			expectBlocked(h, "zai/absent (zai) has no credential");
			expect(h.stderr.join("")).toMatch(/trust: recorded[\s\S]*ink: zai\/absent/);
			expect(trust.readTrustFile(paths.store)[trust.canonicalizeDir(paths.cwd)]).toBe(flag === "--trust");
		},
	);

	it("recorded refusal note also drains to stderr on failed preflight", async () => {
		const paths = sandbox();
		trust.setTrust(paths.store, paths.cwd, false);
		const h = harness(paths);
		await start(h, "print");
		expectBlocked(h, "openai/global (openai) has no credential");
		expect(h.stderr.join("")).toMatch(/is not trusted[\s\S]*has no credential/);
	});

	it("unknown print directory warning stays on stderr before credential failure without writing trust", async () => {
		const paths = sandbox();
		const h = harness(paths);
		await start(h, "print");
		expectBlocked(h, "has no credential");
		expect(h.stderr.join("")).toMatch(/untrusted directory[\s\S]*has no credential/);
		expect(existsSync(paths.store)).toBe(false);
		expect(readsOf(paths.projectPath)).toBe(0);
	});

	it("corrupt store is diagnosed before credentials without reading settings", async () => {
		const paths = sandbox();
		put(paths.store, "corrupt");
		const h = harness(paths);
		await start(h, "print", ["-m", "zai/absent"]);
		expectBlocked(h, "failed to read the trust store");
		expect(h.stderr.join("")).not.toContain("has no credential");
		expect(readsOf(paths.projectPath)).toBe(0);
		expect(readsOf(paths.globalPath)).toBe(0);
	});

	it.each(["--trust", "--no-trust"])(
		"%s repairs corrupt store even when env model subsequently fails",
		async (flag) => {
			const paths = sandbox();
			put(paths.store, "corrupt");
			vi.stubEnv("INK_MODEL", "zai/env");
			const h = harness(paths);
			await start(h, "print", [flag]);
			expectBlocked(h, "zai/env (zai) has no credential");
			expect(trust.readTrustFile(paths.store)[trust.canonicalizeDir(paths.cwd)]).toBe(flag === "--trust");
		},
	);

	it.each([false, true])(
		"no/filtered resources skip store/flags before preflight (filtered=%s)",
		async (filtered) => {
			const paths = sandbox(null, null);
			put(paths.store, "corrupt");
			if (filtered) {
				mkdirSync(join(paths.cwd, ".ink", "extensions"), { recursive: true });
				mkdirSync(join(paths.cwd, ".ink", "skills"));
			}
			const h = harness(paths);
			await start(h, "print", ["--no-trust", "--no-extensions", "--no-skills"]);
			expectBlocked(h, "no model configured");
			expect(readFileSync(paths.store, "utf8")).toBe("corrupt");
			expect(h.stderr.join("")).not.toContain("trust:");
		},
	);

	it("attachment error precedes trust store corruption, defaults and loaders", async () => {
		const paths = sandbox();
		put(paths.store, "corrupt");
		const h = harness(paths);
		await expect(start(h, "print", ["--trust", `@${join(paths.cwd, "missing.txt")}`])).rejects.toThrow();
		expect(h.events).toEqual([]);
		expect(readFileSync(paths.store, "utf8")).toBe("corrupt");
		expect(h.stdout).toEqual([]);
		expect(h.renderers[0]!.note).toBe(h.originalNotes[0]);
	});

	it("selection exception drains trust notes to stderr and restores note", async () => {
		const paths = sandbox();
		const h = harness(paths);
		// A deleted working directory can make process.cwd() fail after trust.
		// Keep the actual selection helper and settings snapshot in this path.
		h.process.cwd = vi
			.fn()
			.mockReturnValueOnce(paths.cwd)
			.mockImplementation(() => {
				throw new Error("cwd fixture failure");
			});
		await start(h, "print", ["--trust"]);
		expectBlocked(h, "cwd fixture failure");
		expect(h.stderr.join("")).toMatch(/trust: recorded[\s\S]*cwd fixture failure/);
	});

	it.each(["loader", "stream"])(
		"successful preflight restores note before later %s failure",
		async (failure) => {
			const paths = sandbox();
			vi.stubEnv("OPENAI_API_KEY", "fixture");
			const h = harness(paths, { failLoader: failure === "loader", failRun: failure === "stream" });
			await start(h, "print", ["--trust", "--no-session"]);
			expect(h.renderers[0]!.note).toBe(h.originalNotes[0]);
			expect(h.stdout.join("")).toMatch(/trust: recorded[\s\S]*extension witness/);
			expect(h.stderr.join("")).toContain(`${failure} fixture failure`);
		},
	);
});

describe("pure parser and main quick branches", () => {
	it.each(
		[[], ["--help"], ["--version"], ["--no-trust", "--trust"], ["-p", "--no-trust"]].map((argv) => ({
			argv,
		})),
	)("parse $argv never reads config or trust even in a trusted directory", ({ argv }) => {
		const paths = sandbox();
		trust.setTrust(paths.store, paths.cwd, true);
		const h = harness(paths);
		const opts = h.cli.parseArgs(argv);
		expect(opts).toMatchObject({ model: "claude-sonnet-4-5", modelSource: "builtin", modelExplicit: false });
		for (const path of [paths.store, paths.globalPath, paths.projectPath]) expect(readsOf(path)).toBe(0);
	});

	it.each(["--help", "--version", "sessions", "login", "logout"])(
		"main %s does not enter selection/trust or run-mode setup",
		async (branch) => {
			const paths = sandbox();
			trust.setTrust(paths.store, paths.cwd, true);
			const h = harness(paths);
			h.process.argv.push(branch);
			if (branch === "--help") await expect(h.cli.main()).rejects.toThrow("CLI exit 0");
			else await h.cli.main();
			for (const path of [paths.store, paths.globalPath, paths.projectPath]) expect(readsOf(path)).toBe(0);
			expect(h.events).toEqual([]);
			expect(h.create).not.toHaveBeenCalled();
		},
	);
});

describe("new defaults passed into actual Runner restore (Fast and D3 unchanged)", () => {
	const fast = "openai-codex/gpt-6.1-sol·fast";
	it.each(["project", "global", "env", "cli"])(
		"fresh %s Fast selection preserves the full model and intent",
		async (scope) => {
			const paths = sandbox(scope === "project" ? fast : null, scope === "global" ? fast : null);
			if (scope === "env") vi.stubEnv("INK_MODEL", fast);
			const h = harness(paths, { interactive: true, answer: "session" });
			const opts = await start(h, "interactive", ["--no-session", ...(scope === "cli" ? ["-m", fast] : [])]);
			expect(opts).toMatchObject({ model: fast, modelSource: scope, modelExplicit: scope === "cli" });
			expect(h.runners[0]!.modelSelectionReference()).toBe(fast);
			expect(h.runners[0]!.speed).toBe("fast");
		},
	);

	it.each(["project", "global", "env", "cli"])(
		"saved Fast model outranks %s except explicit -m",
		async (scope) => {
			const paths = sandbox(
				scope === "project" ? "openai/new-project" : null,
				scope === "global" ? "openai/new-global" : null,
			);
			const saved = createSession(paths.cwd, paths.sessions);
			saved.setModel({ provider: "openai-codex", modelId: "gpt-6.1-sol", speed: "fast" });
			saved.appendMessage({ role: "user", content: "history" });
			if (scope === "env") vi.stubEnv("INK_MODEL", "openai/new-env");
			const h = harness(paths);
			await start(h, "print", [
				"--trust",
				"--resume",
				saved.header.id,
				...(scope === "cli" ? ["-m", "openai-codex/gpt-6-luna·fast"] : []),
			]);
			if (scope === "cli") expectBlocked(h, "openai-codex/gpt-6-luna·fast (openai-codex) has no credential");
			else {
				expect(h.runners[0]!.modelSelectionReference()).toBe(fast);
				expect(h.runners[0]!.speed).toBe("fast");
				expect(h.create.mock.calls[0]![0].modelExplicit).toBe(false);
			}
		},
	);

	it("startup -m replaces saved Fast model in actual interactive restore", async () => {
		const paths = sandbox(fast);
		const saved = createSession(paths.cwd, paths.sessions);
		saved.setModel({ provider: "openai-codex", modelId: "gpt-6.1-sol", speed: "fast" });
		const h = harness(paths, { interactive: true, answer: "session" });
		await start(h, "interactive", ["--resume", saved.header.id, "-m", "openai-codex/gpt-6-luna"]);
		expect(h.runners[0]!.modelSelectionReference()).toBe("openai-codex/gpt-6-luna");
		expect(h.runners[0]!.speed).toBeUndefined();
	});

	it.each(["print", "interactive"] as const)(
		"model-less %s restore starts with newly approved Fast default without API billing fallback",
		async (mode) => {
			const paths = sandbox(fast);
			const saved = createSession(paths.cwd, paths.sessions);
			saved.appendMessage({ role: "user", content: "legacy history" });
			vi.stubEnv("OPENAI_API_KEY", "fixture");
			const h = harness(paths, { interactive: true, answer: "session" });
			await start(h, mode, ["--trust", "--resume", saved.header.id]);
			expect(h.create.mock.calls[0]![0]).toMatchObject({
				model: fast,
				modelSource: "project",
				modelExplicit: false,
			});
			expect(h.runners[0]!.modelSelectionReference()).toBe(fast);
		},
	);

	it.each(["global", "env", "cli"])(
		"model-less interactive restore honors newly resolved %s Fast selection",
		async (scope) => {
			const paths = sandbox(
				scope === "global" ? null : "openai/project",
				scope === "global" ? fast : "openai/global",
			);
			const saved = createSession(paths.cwd, paths.sessions);
			saved.appendMessage({ role: "user", content: "legacy history" });
			vi.stubEnv("INK_MODEL", scope === "env" ? fast : undefined);
			const h = harness(paths, { interactive: true, answer: "session" });
			await start(h, "interactive", ["--resume", saved.header.id, ...(scope === "cli" ? ["-m", fast] : [])]);
			expect(h.create.mock.calls[0]![0]).toMatchObject({
				model: fast,
				modelSource: scope,
				modelExplicit: scope === "cli",
			});
			expect(h.runners[0]!.modelSelectionReference()).toBe(fast);
		},
	);

	it("model-less non-Codex restore retains existing D3 fallback, unlike fresh explicit-source D2", async () => {
		const paths = sandbox("zai/unavailable");
		const saved = createSession(paths.cwd, paths.sessions);
		saved.appendMessage({ role: "user", content: "legacy history" });
		vi.stubEnv("OPENAI_API_KEY", "fixture");
		const h = harness(paths);
		await start(h, "print", ["--trust", "--resume", saved.header.id]);
		expect(h.create.mock.calls[0]![0]).toMatchObject({ model: "zai/unavailable", modelSource: "project" });
		expect(h.runners[0]!.modelReference()).toBe("openai/gpt-5.2");
		expect(h.stdout.join("")).toContain("zai/unavailable has no credential — using openai/gpt-5.2");
	});

	it.each([["--continue"], ["--resume", "ignored", "--no-session"]].map((flags) => ({ flags })))(
		"$flags without an actual restore applies fresh preflight after defaults",
		async ({ flags }) => {
			const paths = sandbox("zai/unavailable");
			vi.stubEnv("OPENAI_API_KEY", "fixture");
			const h = harness(paths);
			await start(h, "print", ["--trust", ...flags]);
			expectBlocked(h, "zai/unavailable (zai) has no credential");
		},
	);

	it.each([["--continue"], ["--resume", "ignored", "--no-session"]].map((flags) => ({ flags })))(
		"$flags without an actual restore permits fresh builtin D2",
		async ({ flags }) => {
			const paths = sandbox("", null);
			vi.stubEnv("OPENAI_API_KEY", "fixture");
			const h = harness(paths);
			const opts = await start(h, "print", ["--trust", ...flags]);
			expect(opts).toMatchObject({ model: "openai/gpt-5.2", modelSource: "builtin" });
			expect(h.create).toHaveBeenCalledOnce();
		},
	);
});
