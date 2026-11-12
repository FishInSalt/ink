import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAgentDefinitions } from "../src/core/agents/registry.js";
import { loadMdCommands } from "../src/core/commands-md.js";
import { loadProjectSettings, loadSettingsSnapshot } from "../src/core/settings.js";
import { loadSkills } from "../src/core/skills.js";
import { loadSystemPromptFiles } from "../src/core/system-prompt-files.js";
import { trustRequiringResources } from "../src/core/trust.js";
import { loadExtensions } from "../src/extensions/loader.js";
import { discoverMcpConfig } from "../src/mcp/config.js";
import { mkTempDir } from "./helpers/mktemp.js";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

beforeEach(() => {
	vi.mocked(fs.readFileSync).mockClear();
});
afterEach(() => {
	vi.restoreAllMocks();
});

function fixture() {
	const root = mkTempDir("ink-resource-paths-");
	const cwd = join(root, "project");
	const home = join(root, "home");
	fs.mkdirSync(join(cwd, ".git"), { recursive: true }); // bound ancestor skill discovery
	fs.mkdirSync(home);
	return { root, cwd, home };
}

type Fixture = ReturnType<typeof fixture>;
type Resource = {
	rel: string;
	gate: "directory" | "file" | "exists";
	entry?: string;
	content: string;
	loaded: (env: Fixture, allowed: boolean) => boolean | Promise<boolean>;
};

const skill = "---\nname: fixture\ndescription: fixture skill\n---\nfixture body";
const agent = "---\nname: fixture\ndescription: fixture agent\n---\nfixture body";
const mcp = '{"mcpServers":{"fixture":{"command":"fixture"}}}';

// Literal paths intentionally do not import resource-paths.ts. These fixtures
// must catch a coordinated typo in trust detection AND the corresponding loader.
const resources: Resource[] = [
	{
		rel: ".ink/extensions",
		gate: "directory",
		entry: "fixture.mjs",
		content: 'export default (api) => api.registerContext("fixture", "fixture");',
		loaded: async ({ cwd, home }, projectDirAllowed) =>
			(await loadExtensions({ cwd, home, projectDirAllowed, cliPaths: [] })).summaries.length === 1,
	},
	{
		rel: ".ink/agents",
		gate: "directory",
		entry: "fixture.md",
		content: agent,
		loaded: ({ cwd, home }, allowed) => loadAgentDefinitions(cwd, home, allowed).agents.length === 1,
	},
	{
		rel: ".ink/commands",
		gate: "directory",
		entry: "fixture.md",
		content: "fixture command",
		loaded: async ({ cwd, home }, projectAllowed) =>
			(await loadMdCommands({ cwd, home, projectAllowed, reserved: new Set() })).commands.length === 1,
	},
	{
		rel: ".ink/skills",
		gate: "directory",
		entry: "fixture/SKILL.md",
		content: skill,
		loaded: ({ cwd, home }, projectTrusted) =>
			loadSkills({ cwd, home, projectTrusted, noSkills: false, explicitPaths: [] }).skills.length === 1,
	},
	{
		rel: ".ink/settings.json",
		gate: "exists",
		content: '{"defaultModel":"fixture"}',
		loaded: ({ cwd }, allowed) => loadProjectSettings(cwd, allowed).defaultModel === "fixture",
	},
	...(["SYSTEM.md", "APPEND_SYSTEM.md"] as const).map(
		(name): Resource => ({
			rel: `.ink/${name}`,
			gate: "file",
			content: "fixture prompt",
			loaded: ({ cwd, home }, allowed) =>
				loadSystemPromptFiles(cwd, allowed, home)[name === "SYSTEM.md" ? "override" : "append"]?.text ===
				"fixture prompt",
		}),
	),
	...([".mcp.json", "mcp.json"] as const).map(
		(name): Resource => ({
			rel: name,
			gate: "file",
			content: mcp,
			loaded: ({ cwd, home }, projectAllowed) =>
				discoverMcpConfig({ cwd, home, projectAllowed }).servers[0]?.name === "fixture",
		}),
	),
	{
		rel: ".agents/skills",
		gate: "exists",
		entry: "fixture/SKILL.md",
		content: skill,
		loaded: ({ cwd, home }, projectTrusted) =>
			loadSkills({ cwd, home, projectTrusted, noSkills: false, explicitPaths: [] }).skills.length === 1,
	},
];

function write(file: string, content: string): void {
	fs.mkdirSync(dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

function seed(base: string, resource: Resource, name = "fixture"): void {
	const target = join(base, resource.rel, resource.entry?.replaceAll("fixture", name) ?? "");
	write(target, resource.content.replaceAll("fixture", name));
}

const kinds = ["file", "directory", "symlink-file", "symlink-directory", "broken-symlink", "absent"] as const;
describe.each(resources)("actual trust/loader resource kinds: $rel", (resource) => {
	it.each(kinds)("%s preserves the resource-specific checks and the denial gate", async (kind) => {
		const env = fixture();
		const target = join(env.cwd, resource.rel);
		const isDirectory = kind === "directory" || kind === "symlink-directory";
		const isFile = kind === "file" || kind === "symlink-file";
		const exists = isDirectory || isFile;
		if (kind !== "absent") {
			const linked = kind.startsWith("symlink-") || kind === "broken-symlink";
			const real = linked ? join(env.root, "target") : target;
			if (isDirectory) {
				fs.mkdirSync(real, { recursive: true });
				if (resource.entry) write(join(real, resource.entry), resource.content);
			} else if (isFile) {
				write(real, resource.content);
			}
			if (linked) {
				fs.mkdirSync(dirname(target), { recursive: true });
				fs.symlinkSync(real, target);
			}
		}

		const requiresTrust =
			resource.gate === "exists" ? exists : resource.gate === "directory" ? isDirectory : isFile;
		expect(trustRequiringResources(env.cwd, env.home)).toEqual(requiresTrust ? [resource.rel] : []);
		const loadable = resource.entry ? isDirectory : isFile;
		expect(await resource.loaded(env, true)).toBe(loadable);

		vi.mocked(fs.readFileSync).mockClear();
		expect(await resource.loaded(env, false)).toBe(false);
		const reads = vi.mocked(fs.readFileSync).mock.calls.map(([file]) => String(file));
		expect(reads.filter((file) => file === target || file.startsWith(`${target}/`))).toEqual([]);
	});
});

it("keeps literal discovery order through a cwd alias and exempts canonical home aliases", async () => {
	const env = fixture();
	for (const resource of resources) seed(env.cwd, resource);
	const alias = join(env.root, "project-alias");
	fs.symlinkSync(env.cwd, alias);
	const expected = [
		".ink/extensions",
		".ink/agents",
		".ink/commands",
		".ink/skills",
		".ink/settings.json",
		".ink/SYSTEM.md",
		".ink/APPEND_SYSTEM.md",
		".mcp.json",
		"mcp.json",
		".agents/skills",
	];
	expect(trustRequiringResources(env.cwd, env.home)).toEqual(expected);
	expect(trustRequiringResources(alias, env.home)).toEqual(expected);
	// Skills dedup the identical names from the two real project tiers; MCP
	// replaces the duplicate server whole-entry. Each loader still finds one.
	for (const resource of resources) expect(await resource.loaded({ ...env, cwd: alias }, true)).toBe(true);

	for (const resource of resources) seed(env.home, resource);
	const homeAlias = join(env.root, "home-alias");
	fs.symlinkSync(env.home, homeAlias);
	expect(trustRequiringResources(homeAlias, env.home)).toEqual([]);
	expect(trustRequiringResources(env.home, homeAlias)).toEqual([]);
	const agents = loadAgentDefinitions(homeAlias, env.home, false);
	expect(agents.agents.map((entry) => entry.source)).toEqual([join(env.home, ".ink/agents/fixture.md")]);
	expect(agents.projectGated).toBe(true); // lexical distinctness is the existing loader contract
});

it("denial retains global resources and explicit extension/skill paths, with their original labels", async () => {
	const env = fixture();
	for (const resource of resources) {
		seed(env.cwd, resource, "project");
		seed(env.home, resource, "global");
	}
	const explicitExtension = join(env.cwd, ".ink/extensions/project.mjs");
	const extensions = await loadExtensions({
		...env,
		projectDirAllowed: false,
		cliPaths: [explicitExtension],
	});
	expect(extensions.failures).toEqual([]);
	expect(extensions.summaries.map((entry) => [entry.name, entry.origin])).toEqual([
		["project", "cli"],
		["global", "global"],
	]);
	expect(
		loadAgentDefinitions(env.cwd, env.home, false).agents.map((entry) => [entry.name, entry.source]),
	).toEqual([["global", join(env.home, ".ink/agents/global.md")]]);
	const commands = await loadMdCommands({ ...env, projectAllowed: false, reserved: new Set() });
	expect(commands.commands.map((entry) => [entry.command.name, entry.source])).toEqual([
		["global", "md:global"],
	]);
	const skills = loadSkills({
		...env,
		projectTrusted: false,
		noSkills: false,
		explicitPaths: [join(env.cwd, ".ink/skills/project/SKILL.md")],
	});
	expect(skills.skills.map((entry) => [entry.name, entry.source])).toEqual([
		["project", "path"],
		["global", "user"],
	]);
	const snapshot = loadSettingsSnapshot({
		...env,
		projectAllowed: false,
		globalPath: join(env.home, ".ink/settings.json"),
	});
	expect(snapshot.project).toEqual({});
	expect(snapshot.effective.defaultModel).toBe("global");
	const prompts = loadSystemPromptFiles(env.cwd, false, env.home);
	expect(prompts.override).toEqual({ text: "global prompt", path: join(env.home, ".ink/SYSTEM.md") });
	expect(prompts.append).toEqual({ text: "global prompt", path: join(env.home, ".ink/APPEND_SYSTEM.md") });
	expect(prompts.ignoredUntrusted).toEqual([
		join(env.cwd, ".ink/SYSTEM.md"),
		join(env.cwd, ".ink/APPEND_SYSTEM.md"),
	]);
});

it.each([".mcp.json", "mcp.json", "both"])(
	"MCP %s is unread on denial; all three global tiers remain, with one skip note",
	(projectName) => {
		const { cwd, home } = fixture();
		const globals = [
			join(home, ".config/mcp/mcp.json"),
			join(home, ".agents/mcp.json"),
			join(home, ".agents/mcp/mcp.json"),
		];
		for (const [index, file] of globals.entries()) {
			write(file, JSON.stringify({ mcpServers: { [`global${index}`]: { command: `global${index}` } } }));
		}
		const projectFiles = projectName === "both" ? [".mcp.json", "mcp.json"] : [projectName];
		for (const name of projectFiles) write(join(cwd, name), "{malformed and must not be read");
		vi.mocked(fs.readFileSync).mockClear();
		const result = discoverMcpConfig({ cwd, home, projectAllowed: false });
		expect(result.paths).toEqual([...globals, join(cwd, ".mcp.json"), join(cwd, "mcp.json")]);
		expect(result.servers.map((server) => server.name)).toEqual(["global0", "global1", "global2"]);
		expect(result.notes).toEqual(["mcp: project config skipped — directory not trusted (--trust to enable)"]);
		expect(vi.mocked(fs.readFileSync).mock.calls.map(([file]) => String(file))).toEqual(globals);
	},
);

it("MCP full overrides keep lexical matching, caller order and whole-entry replacement", () => {
	const { root, cwd, home } = fixture();
	write(join(cwd, ".mcp.json"), mcp);
	write(join(cwd, "mcp.json"), mcp);
	const alias = join(root, "project-alias");
	fs.symlinkSync(cwd, alias);
	const explicit = join(root, "chosen.json");
	write(explicit, '{"mcpServers":{"fixture":{"command":"explicit","args":["keep"]}}}');
	const lexicalAlias = `${cwd}/../project/mcp.json`;
	const paths = [
		join(cwd, ".mcp.json"),
		explicit,
		join(alias, ".mcp.json"),
		lexicalAlias,
		join(cwd, "mcp.json"),
	];
	vi.mocked(fs.readFileSync).mockClear();
	const result = discoverMcpConfig({ cwd, home, paths, projectAllowed: false });
	expect(result.paths).toEqual(paths);
	expect(result.servers).toEqual([
		{
			kind: "stdio",
			name: "fixture",
			command: "fixture",
			args: [],
			env: {},
			disabled: false,
			cwd: undefined,
		},
	]);
	expect(result.notes).toEqual(["mcp: project config skipped — directory not trusted (--trust to enable)"]);
	expect(vi.mocked(fs.readFileSync).mock.calls.map(([file]) => String(file))).toEqual([
		explicit,
		join(alias, ".mcp.json"),
		lexicalAlias,
	]);
});
