import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MAX_TOKENS } from "../src/core/constants.js";
import { AGENTS_SKILLS_PATH, INK_RESOURCE_PATHS } from "../src/core/resource-paths.js";
import { effectiveSettings, loadSettings } from "../src/core/settings.js";
import * as trust from "../src/core/trust.js";
import { ExtensionRegistry } from "../src/extensions/registry.js";
import { discoverMcpConfig } from "../src/mcp/config.js";
import { McpManager, type McpManagerOptions } from "../src/mcp/manager.js";
import { Renderer } from "../src/render.js";
import { TranscriptSink } from "../src/repl/transcript.js";
import type { TrustAskAnswer } from "../src/repl/trust-ask.js";
import { createRunner, type Runner, type RunnerOptions } from "../src/runner.js";
import { assistant, makeRenderer, scriptedProvider } from "./helpers/fakes.js";
import { mkTempDir } from "./helpers/mktemp.js";

// Execute the real private CLI declarations, never import cli.ts/main().
const source = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
const file = ts.createSourceFile("cli.ts", source, ts.ScriptTarget.Latest, true);
const names = new Set([
	"parseArgs",
	"runnerOptions",
	"resolveProjectTrust",
	"broadAncestorWarning",
	"createMcpSetup",
	"runInteractive",
	"runPrint",
]);
const declarations = file.statements.filter(
	(statement): statement is ts.FunctionDeclaration =>
		ts.isFunctionDeclaration(statement) && names.has(statement.name?.text ?? ""),
);
if (declarations.length !== names.size) throw new Error("missing CLI declaration");
const { outputText } = ts.transpileModule(declarations.map((node) => node.getText(file)).join("\n"), {
	compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
});

interface TrustOptions {
	noExtensions: boolean;
	noSkills: boolean;
	trustDecision?: "trust" | "no-trust";
}
interface PrivateCli {
	parseArgs(argv: string[]): TrustOptions;
	resolveProjectTrust(
		opts: TrustOptions,
		renderer: Renderer,
		interactive: boolean,
		ask?: () => Promise<TrustAskAnswer | null>,
	): Promise<boolean>;
	createMcpSetup(renderer: Renderer, runner: Runner, projectTrusted: boolean): McpManager | undefined;
	runInteractive(opts: TrustOptions, argv: string[]): Promise<void>;
	runPrint(opts: TrustOptions, argv: string[]): Promise<void>;
}

function put(file: string, text: string): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, text);
}
function mcpFile(file: string, name: string): void {
	// Real discovery + manager, but disabled servers guarantee no spawn/network.
	put(file, JSON.stringify({ mcpServers: { [name]: { command: "never-spawn", disabled: true } } }));
}
function sandbox(resources = true) {
	const root = mkTempDir("ink-cli-project-trust-");
	const cwd = join(root, "repo");
	const home = join(root, "home");
	mkdirSync(join(cwd, ".git"), { recursive: true });
	mkdirSync(home);
	const globalPath = join(home, ".ink", "settings.json");
	const store = trust.defaultTrustStorePath(home);
	if (resources) {
		put(globalPath, '{"autoCompact":true}');
		put(join(cwd, ".ink", "settings.json"), '{"autoCompact":false}');
		for (const [dir, tier] of [
			[cwd, "project"],
			[home, "global"],
		] as const) {
			put(join(dir, ".ink", "SYSTEM.md"), `${tier} persona`);
			put(join(dir, ".ink", "APPEND_SYSTEM.md"), `${tier} appendix`);
			put(
				join(dir, ".ink", "agents", `${tier}-scout.md`),
				`---\nname: ${tier}-scout\ndescription: ${tier} scout\n---\nbody`,
			);
		}
		mcpFile(join(cwd, ".mcp.json"), "project-dot");
		mcpFile(join(cwd, "mcp.json"), "project-plain");
		mcpFile(join(home, ".agents", "mcp.json"), "global");
	}
	return { root, cwd, home, globalPath, store };
}
type Sandbox = ReturnType<typeof sandbox>;

function harness(
	paths: Sandbox,
	options: {
		interactive?: boolean;
		answer?: TrustAskAnswer | null;
		processCwd?: string;
		failRun?: boolean;
	} = {},
) {
	const output: string[] = [];
	const errors: string[] = [];
	const events: string[] = [];
	const runners: Runner[] = [];
	const managers: McpManager[] = [];
	const managerOptions: McpManagerOptions[] = [];
	const discover = vi.fn((input: Parameters<typeof discoverMcpConfig>[0]) =>
		discoverMcpConfig({ ...input, home: paths.home }),
	);
	const create = vi.fn(async (input: RunnerOptions) => {
		const runner = await createRunner({
			...input,
			settingsPath: paths.globalPath,
			agentsHomeDir: paths.home,
			systemPromptHomeDir: paths.home,
			provider: scriptedProvider([assistant([{ type: "text", text: "done" }])]),
		});
		runners.push(runner);
		const close = runner.close.bind(runner);
		vi.spyOn(runner, "close").mockImplementation(() => {
			events.push("runner-close");
			close();
		});
		if (options.failRun) {
			vi.spyOn(runner, "runTurn").mockRejectedValue(new Error("fixture run failed"));
		}
		return runner;
	});
	const ask = vi.fn(async () => options.answer ?? null);
	const extensionSetup = vi.fn(
		async (_opts: TrustOptions, _renderer: Renderer, _confirm: unknown, _trusted: boolean) => ({
			runtime: new ExtensionRegistry(),
			failures: [],
		}),
	);
	const skillSetup = vi.fn((_opts: TrustOptions, _renderer: Renderer, _trusted: boolean) => ({
		skills: [],
		enableSkillCommands: true,
	}));
	const mdCommands = vi.fn(async (_input: { projectAllowed: boolean }) => ({ commands: [] }));
	const fakeProcess = {
		env: { ...process.env },
		cwd: () => options.processCwd ?? paths.cwd,
		stdin: { isTTY: options.interactive === true },
		stdout: { isTTY: options.interactive === true, write: (text: string) => output.push(text) },
		stderr: { write: (text: string) => errors.push(text) },
		on: vi.fn(),
		off: vi.fn(),
		exitCode: undefined as number | undefined,
	};
	const repl = vi.fn(async ({ runner, mcp }: { runner: Runner; mcp?: McpManager }) => {
		// The actual CLI function selects/defer-initializes this real Runner;
		// only terminal input is replaced. Existing REPL tests own close logic.
		runner.warmup();
		await mcp?.close();
		return 0;
	});
	const cli: PrivateCli = vm.runInNewContext(`${outputText}\n({ ${[...names].join(", ")} });`, {
		...trust,
		AGENTS_SKILLS_PATH,
		INK_RESOURCE_PATHS,
		DEFAULT_MAX_TOKENS,
		AbortController,
		Renderer,
		TranscriptSink,
		TtyConfirm: class {},
		VERSION: "test",
		HELP: "help",
		COMMANDS: [],
		THINKING_LEVELS: [],
		process: fakeProcess,
		homedir: () => paths.home,
		dim: (text: string) => text,
		red: (text: string) => text,
		requestedModel: () => ({ model: "test-model", source: "cli" }),
		envThinking: () => undefined,
		loadSettings: () => loadSettings(paths.globalPath),
		effectiveSettings: (input: Parameters<typeof effectiveSettings>[0]) =>
			effectiveSettings({ ...input, globalPath: paths.globalPath }),
		resolveShell: () => "tui",
		decideStartupResolution: () => ({ kind: "keep" }),
		printModelUnusable: () => undefined,
		askTrustViaTui: ask,
		askTrustOnTty: ask,
		loadExtensionSetup: extensionSetup,
		loadSkillSetup: skillSetup,
		loadMdCommands: mdCommands,
		buildSkillCommands: () => [],
		historyFilePath: () => join(paths.home, "history"),
		createRunner: create,
		discoverMcpConfig: discover,
		McpManager: class extends McpManager {
			constructor(input: McpManagerOptions) {
				super(input);
				managerOptions.push(input);
				managers.push(this);
			}
			override connectAll(): void {
				events.push("connect");
				super.connectAll();
			}
			override onRunStart(): void {
				events.push("run-start");
				super.onRunStart();
			}
			override onRunEnd(): void {
				events.push("run-end");
				super.onRunEnd();
			}
			override async close(): Promise<void> {
				events.push("mcp-close");
				await super.close();
			}
		},
		runRepl: repl,
		reportStartupError: (error: Error) => {
			errors.push(error.message);
			fakeProcess.exitCode = 1;
		},
	});
	return {
		cli,
		create,
		discover,
		ask,
		extensionSetup,
		skillSetup,
		mdCommands,
		repl,
		runners,
		managers,
		managerOptions,
		events,
		output,
		errors,
		process: fakeProcess,
	};
}

beforeEach(() => vi.stubEnv("INK_LOG", "0"));
afterEach(() => vi.unstubAllEnvs());

const trustOptions: TrustOptions = { noExtensions: false, noSkills: false };

describe("actual CLI session trust resolver", () => {
	for (const existing of [false, true]) {
		it.each([
			{ label: "session approval", answer: "session" as const, interactive: true, expected: true },
			{ label: "cancelled ask", answer: null, interactive: true, expected: false },
			{ label: "undecided print/pipe", answer: null, interactive: false, expected: false },
		])(`$label leaves ${existing ? "unrelated store bytes unchanged" : "store absent"}`, async (row) => {
			const paths = sandbox();
			if (existing) put(paths.store, `{\n  "${join(paths.root, "unrelated")}": true\n}\n`);
			const before = existing ? readFileSync(paths.store, "utf8") : undefined;
			const h = harness(paths);
			const ask = vi.fn(async () => row.answer);
			expect(
				await h.cli.resolveProjectTrust(trustOptions, makeRenderer().renderer, row.interactive, ask),
			).toBe(row.expected);
			expect(ask).toHaveBeenCalledTimes(row.interactive ? 1 : 0);
			expect(existsSync(paths.store)).toBe(existing);
			if (existing) expect(readFileSync(paths.store, "utf8")).toBe(before);
		});
	}

	it.each([true, false])(
		"nearest ancestor decision %s precedes the ask without rewriting",
		async (allowed) => {
			const paths = sandbox();
			trust.setTrust(paths.store, paths.root, !allowed);
			trust.setTrust(paths.store, paths.cwd, allowed);
			const before = readFileSync(paths.store, "utf8");
			const h = harness(paths);
			expect(await h.cli.resolveProjectTrust(trustOptions, makeRenderer().renderer, true, h.ask)).toBe(
				allowed,
			);
			expect(h.ask).not.toHaveBeenCalled();
			expect(readFileSync(paths.store, "utf8")).toBe(before);
		},
	);

	it.each(["trust", "no-trust"] as const)("explicit %s overrides a recorded ancestor", async (decision) => {
		const paths = sandbox();
		trust.setTrust(paths.store, paths.root, decision !== "trust");
		const h = harness(paths);
		expect(
			await h.cli.resolveProjectTrust(
				{ ...trustOptions, trustDecision: decision },
				makeRenderer().renderer,
				true,
				h.ask,
			),
		).toBe(decision === "trust");
		expect(h.ask).not.toHaveBeenCalled();
		expect(trust.readTrustFile(paths.store)[trust.canonicalizeDir(paths.cwd)]).toBe(decision === "trust");
		expect(trust.readTrustFile(paths.store)[trust.canonicalizeDir(paths.root)]).toBe(decision !== "trust");
	});

	it.each([false, true])(
		"empty or disabled resources short circuit before flags/store (disabled=%s)",
		async (disabled) => {
			const paths = sandbox(false);
			if (disabled) {
				mkdirSync(join(paths.cwd, ".ink", "extensions"), { recursive: true });
				mkdirSync(join(paths.cwd, ".ink", "skills"));
				mkdirSync(join(paths.cwd, ".agents", "skills"), { recursive: true });
			}
			const h = harness(paths);
			expect(
				await h.cli.resolveProjectTrust(
					{ noExtensions: true, noSkills: true, trustDecision: "no-trust" },
					makeRenderer().renderer,
					true,
					h.ask,
				),
			).toBe(true);
			expect(h.ask).not.toHaveBeenCalled();
			expect(existsSync(paths.store)).toBe(false);
		},
	);
});

function expectResources(runner: Runner, allowed: boolean): void {
	expect(runner.projectSettingsAllowed).toBe(allowed);
	expect(runner.effectiveSettings().autoCompact).toBe(!allowed);
	expect(runner.system.includes("project-scout")).toBe(allowed);
	expect(runner.system).toContain("global-scout");
	for (const suffix of ["persona", "appendix"]) {
		expect(runner.system.includes(`project ${suffix}`)).toBe(allowed);
		expect(runner.system.includes(`global ${suffix}`)).toBe(!allowed);
	}
}

describe("actual interactive/print startup wiring to real Runner and MCP discovery", () => {
	it.each([
		{
			mode: "interactive",
			interactive: true,
			answer: "session" as const,
			recorded: undefined,
			allowed: true,
		},
		{ mode: "interactive cancel", interactive: true, answer: null, recorded: undefined, allowed: false },
		{ mode: "scripted grant", interactive: false, answer: null, recorded: true, allowed: true },
		{ mode: "scripted undecided", interactive: false, answer: null, recorded: undefined, allowed: false },
		{ mode: "print grant", interactive: false, answer: null, recorded: true, allowed: true },
		{ mode: "print denial", interactive: false, answer: null, recorded: false, allowed: false },
		{ mode: "print undecided", interactive: false, answer: null, recorded: undefined, allowed: false },
	])("$mode forwards only the resolved canonical bit", async (row) => {
		const paths = sandbox();
		if (row.recorded !== undefined) trust.setTrust(paths.store, paths.root, row.recorded);
		const before = existsSync(paths.store) ? readFileSync(paths.store, "utf8") : undefined;
		const h = harness(paths, row);
		const print = row.mode.startsWith("print");
		const argv = print ? ["-p", "hello", "--no-session", "-nc"] : ["--no-session", "-nc"];
		const opts = h.cli.parseArgs(argv);
		await (print ? h.cli.runPrint(opts, argv) : h.cli.runInteractive(opts, argv));
		expect(h.errors.filter((line) => !line.includes("untrusted directory"))).toEqual([]);
		expect(h.create).toHaveBeenCalledTimes(1);
		const input = h.create.mock.calls[0]![0];
		expect(input.projectTrusted).toBe(row.allowed);
		for (const name of ["projectSettingsAllowed", "agentsProjectAllowed", "systemPromptProjectAllowed"]) {
			expect(Object.hasOwn(input, name)).toBe(false);
		}
		const runner = h.runners[0]!;
		expectResources(runner, row.allowed);
		expect(h.discover).toHaveBeenCalledExactlyOnceWith({ cwd: paths.cwd, projectAllowed: row.allowed });
		expect(h.managerOptions[0]!.servers.map((server) => server.name)).toEqual(
			row.allowed ? ["global", "project-dot", "project-plain"] : ["global"],
		);
		expect(h.managerOptions[0]!.cwd).toBe(paths.cwd);
		expect(h.extensionSetup.mock.calls[0]?.at(-1)).toBe(row.allowed);
		expect(h.skillSetup.mock.calls[0]?.at(-1)).toBe(row.allowed);
		if (!print) expect(h.mdCommands.mock.calls[0]?.[0]).toMatchObject({ projectAllowed: row.allowed });
		expect(h.events).toEqual(
			print
				? ["connect", "run-start", "run-end", "mcp-close", "runner-close"]
				: ["connect", "mcp-close", "runner-close"],
		);
		expect(h.ask).toHaveBeenCalledTimes(row.interactive ? 1 : 0);
		expect(existsSync(paths.store)).toBe(before !== undefined);
		if (before !== undefined) expect(readFileSync(paths.store, "utf8")).toBe(before);
		if (print) {
			expect(h.process.on).toHaveBeenCalledWith("SIGINT", expect.any(Function));
			expect(h.process.off.mock.calls[0]).toEqual(h.process.on.mock.calls[0]);
		}
	});

	it.each(["interactive", "print"])("%s resolver failure stops startup before any loaders", async (mode) => {
		const paths = sandbox();
		put(paths.store, "not valid JSON");
		const h = harness(paths, { interactive: mode === "interactive", answer: "session" });
		const argv = mode === "print" ? ["-p", "hello", "--no-session", "-nc"] : ["--no-session", "-nc"];
		const opts = h.cli.parseArgs(argv);
		await (mode === "print" ? h.cli.runPrint(opts, argv) : h.cli.runInteractive(opts, argv));
		expect(h.errors).toHaveLength(1);
		expect(h.errors[0]).toContain("failed to read the trust store");
		expect(h.ask).not.toHaveBeenCalled();
		expect(h.create).not.toHaveBeenCalled();
		expect(h.discover).not.toHaveBeenCalled();
		expect(h.extensionSetup).not.toHaveBeenCalled();
		expect(h.skillSetup).not.toHaveBeenCalled();
		expect(h.repl).not.toHaveBeenCalled();
		expect(h.events).toEqual([]);
		expect(readFileSync(paths.store, "utf8")).toBe("not valid JSON");
	});

	it("print failure still closes MCP, unregisters SIGINT and closes the Runner", async () => {
		const paths = sandbox();
		trust.setTrust(paths.store, paths.cwd, true);
		const h = harness(paths, { failRun: true });
		await h.cli.runPrint(h.cli.parseArgs(["-p", "hello", "--no-session", "-nc"]), []);
		expect(h.errors).toEqual(["fixture run failed"]);
		expect(h.events).toEqual(["connect", "run-start", "mcp-close", "runner-close"]);
		expect(h.process.off.mock.calls[0]).toEqual(h.process.on.mock.calls[0]);
	});
});

describe("private MCP setup permission and cwd", () => {
	it.each([true, false])(
		"session=%s is independent of settings-only permission and process cwd",
		async (allowed) => {
			const paths = sandbox();
			const elsewhere = join(paths.root, "elsewhere");
			mkdirSync(elsewhere);
			mcpFile(join(elsewhere, ".mcp.json"), "wrong-cwd");
			const h = harness(paths, { processCwd: elsewhere });
			const runner = await h.create({
				cwd: paths.cwd,
				argv: [],
				model: "test-model",
				maxTokens: 100,
				maxTurns: 1,
				noSession: true,
				noContextFiles: true,
				renderer: makeRenderer().renderer,
				projectTrusted: true,
				projectSettingsAllowed: !allowed,
			});
			try {
				expect(runner.projectSettingsAllowed).toBe(!allowed);
				const manager = h.cli.createMcpSetup(makeRenderer().renderer, runner, allowed);
				expect(h.discover).toHaveBeenCalledExactlyOnceWith({ cwd: paths.cwd, projectAllowed: allowed });
				expect(h.managerOptions[0]!.cwd).toBe(paths.cwd);
				expect(h.managerOptions[0]!.servers.map((server) => server.name)).toEqual(
					allowed ? ["global", "project-dot", "project-plain"] : ["global"],
				);
				const refresh = vi.spyOn(runner, "refreshSystemPrompt");
				h.managerOptions[0]!.onToolsChanged?.();
				expect(refresh).toHaveBeenCalledOnce();
				await manager?.close();
			} finally {
				runner.close();
			}
		},
	);

	it.each(["environment", "settings"])("%s disabled gate prevents even discovery", async (gate) => {
		const paths = sandbox();
		if (gate === "settings") put(paths.globalPath, '{"mcp":{"enabled":false}}');
		const h = harness(paths);
		if (gate === "environment") h.process.env.INK_MCP = "0";
		const runner = await h.create({
			cwd: paths.cwd,
			argv: [],
			model: "test-model",
			maxTokens: 100,
			maxTurns: 1,
			noSession: true,
			noContextFiles: true,
			renderer: makeRenderer().renderer,
			projectTrusted: true,
		});
		try {
			expect(h.cli.createMcpSetup(makeRenderer().renderer, runner, true)).toBeUndefined();
			expect(h.discover).not.toHaveBeenCalled();
			expect(h.managers).toEqual([]);
		} finally {
			runner.close();
		}
	});
});
