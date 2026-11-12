// Real bin/ink.js probes for the approved startup-model-trust-order design.
// Run against a fresh dist: npm run build && npm test -- test/startup-model-trust-e2e.test.ts
// No private CLI declarations are extracted or mocked here. TTY/session-only
// decisions belong to the complementary CLI AST tests; these children use pipes.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSession } from "../src/core/session/manager.js";
import { SessionStore } from "../src/core/session/store.js";
import { type CliFixture, collectCliOutput, createCliFixture } from "./helpers/cli-fixture.js";

const PROJECT = "zai/project-startup-probe";
const GLOBAL = "zai/global-startup-probe";
const FAST = "openai-codex/project-startup-probe·fast";
const MCP_SERVER = path.join(import.meta.dirname, "helpers/mcp-fake-server.mjs");

function put(file: string, text: string): void {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, text);
}
function json(file: string, value: unknown): void {
	put(file, JSON.stringify(value));
}
function filesUnder(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		return entry.isDirectory() ? filesUnder(full) : [full];
	});
}
function state(fixture: CliFixture, name: string): string {
	return path.join(fixture.home, ".ink", name);
}
function projectSettings(fixture: CliFixture, model = PROJECT): void {
	json(path.join(fixture.cwd, ".ink/settings.json"), { defaultModel: model });
}
function globalSettings(fixture: CliFixture, model = GLOBAL): void {
	json(state(fixture, "settings.json"), { defaultModel: model });
}
function trust(fixture: CliFixture, trusted: boolean): void {
	json(state(fixture, "trust.json"), { [fixture.cwd]: trusted });
}
function recordedTrust(fixture: CliFixture): unknown {
	const file = state(fixture, "trust.json");
	return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
}

/** Same loopback 401 strategy as startRejectingProvider, additionally recording
 * the actual HTTP body: a path-only witness cannot distinguish model choices. */
async function startRecordingProvider() {
	const requests: { url: string; body: Record<string, unknown> }[] = [];
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk: string) => {
			body += chunk;
		});
		request.on("end", () => {
			requests.push({ url: request.url ?? "", body: JSON.parse(body) as Record<string, unknown> });
			response.writeHead(401, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					type: "error",
					error: { type: "authentication_error", message: "startup probe local rejection" },
				}),
			);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("Missing loopback address");
	return {
		url: `http://127.0.0.1:${address.port}`,
		requests,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
				server.closeAllConnections();
			}),
	};
}
type Provider = Awaited<ReturnType<typeof startRecordingProvider>>;

async function isolated(probe: (fixture: CliFixture, provider: Provider) => Promise<void>): Promise<void> {
	const fixture = createCliFixture({ model: null });
	let provider: Provider | undefined;
	try {
		provider = await startRecordingProvider();
		await probe(fixture, provider);
	} finally {
		try {
			await provider?.close();
		} finally {
			fixture.cleanup(); // also fails on swallowed nonlocal network attempts
		}
	}
}

/** collectCliOutput SIGKILLs at 10s and waits for close, including pipe errors.
 * Every caller awaits it before its finally removes the copied installation. */
async function cli(
	fixture: CliFixture,
	provider: Provider,
	args: string[],
	options: { input?: string; env?: NodeJS.ProcessEnv; preload?: string } = {},
) {
	const env = fixture.env({
		INK_LOG: "1", // no-side-effect assertions must not pass by disabling logging
		INK_AUTOCOMPACT: "0",
		INK_HEALTH: "0",
		ANTHROPIC_BASE_URL: provider.url,
		ZAI_BASE_URL: provider.url,
		OPENAI_BASE_URL: `${provider.url}/v1`,
		DEEPSEEK_BASE_URL: provider.url,
		...options.env,
	});
	// Append, never replace, CliFixture's mandatory offline network preload.
	if (options.preload) env.NODE_OPTIONS += ` --require ${JSON.stringify(options.preload)}`;
	return collectCliOutput(
		spawn(process.execPath, [fixture.bin, ...args], {
			cwd: fixture.cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		}),
		options.input ?? "",
	);
}

function expectModelRequest(provider: Provider, model: string): void {
	expect(provider.requests).toHaveLength(1);
	expect(provider.requests[0]?.body.model).toBe(model);
	expect(provider.requests[0]?.url).toBe("/chat/completions");
}

/** All three extension origins write at module evaluation, not run_start.
 * The existing fake MCP server writes its PID on execution. A successful
 * startup control below proves these are executable witnesses, not dead paths. */
function loaderWitnesses(fixture: CliFixture) {
	const witnesses = ["global", "project", "explicit"].map((origin) =>
		path.join(fixture.root, `${origin}-extension.executed`),
	);
	const extensions = [
		state(fixture, "extensions/global-probe.mjs"),
		path.join(fixture.cwd, ".ink/extensions/project-probe.mjs"),
		path.join(fixture.root, "explicit-probe.mjs"),
	];
	for (const [index, file] of extensions.entries()) {
		put(
			file,
			`import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(witnesses[index])}, "executed");
export default function () {}
`,
		);
	}
	const server = path.join(fixture.root, "mcp-probe.mjs");
	cpSync(MCP_SERVER, server);
	const pid = path.join(fixture.root, "mcp-spawn.pid");
	json(path.join(fixture.cwd, ".mcp.json"), {
		mcpServers: {
			probe: { command: process.execPath, args: [server, "ok"], env: { FAKE_MCP_PIDFILE: pid } },
		},
	});
	return { args: ["-e", extensions[2]!], witnesses, pid };
}

function expectNoStartupEffects(
	fixture: CliFixture,
	provider: Provider,
	loaders?: ReturnType<typeof loaderWitnesses>,
): void {
	// Soft assertions ensure a stdout/diagnostic failure cannot hide a loader
	// execution, provider request, or physical session/log regression.
	expect.soft(provider.requests).toEqual([]);
	for (const dir of ["logs", "sessions"]) {
		expect.soft(filesUnder(state(fixture, dir)), dir).toEqual([]);
		expect.soft(existsSync(state(fixture, dir)), `${dir} directory`).toBe(false);
	}
	if (loaders) {
		for (const witness of [...loaders.witnesses, loaders.pid]) {
			expect.soft(existsSync(witness), witness).toBe(false);
		}
	}
}

/** Observe real sync/callback/promise content reads, including errors caught by
 * production code. Do not substitute malformed JSON as evidence of no reads.
 * syncBuiltinESMExports propagates hooks to node:fs named ESM imports. */
function readWitness(fixture: CliFixture, targets: string[]) {
	const preload = path.join(fixture.root, "read-witness.cjs");
	const witness = path.join(fixture.root, "content-reads.jsonl");
	put(
		preload,
		`const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { fileURLToPath } = require("node:url");
const { resolve } = require("node:path");
const append = fs.appendFileSync;
const targets = new Set(${JSON.stringify(targets)});
function observe(file) {
  if (file instanceof URL) file = fileURLToPath(file);
  if (Buffer.isBuffer(file)) file = file.toString();
  if (typeof file === "string" && targets.has(resolve(file)))
    append(${JSON.stringify(witness)}, JSON.stringify(resolve(file)) + "\\n");
}
for (const [object, names] of [[fs, ["readFileSync", "readFile"]], [fsp, ["readFile"]]]) {
  for (const name of names) {
    const original = object[name];
    object[name] = function(file, ...args) {
      observe(file);
      return original.call(this, file, ...args);
    };
  }
}
require("node:module").syncBuiltinESMExports();
`,
	);
	return {
		preload,
		reads: (): string[] =>
			existsSync(witness)
				? readFileSync(witness, "utf8")
						.trim()
						.split("\n")
						.map((line) => JSON.parse(line) as string)
				: [],
	};
}

const selectionCases = [
	{ name: "first --trust print overrides global", flags: ["--trust"], global: true },
	{ name: "first --trust print overrides usable builtin", flags: ["--trust"], global: false },
	{ name: "first --trust pipe overrides global", flags: ["--trust"], global: true, pipe: true },
	{ name: "first --trust pipe precedes builtin fallback", flags: ["--trust"], global: false, pipe: true },
	{ name: "stored deny to --trust print", flags: ["--trust"], global: true, prior: false },
	{ name: "stored deny to --trust pipe", flags: ["--trust"], global: true, prior: false, pipe: true },
	{
		name: "last trust flag wins when granting",
		flags: ["--no-trust", "--trust"],
		global: true,
		prior: true,
	},
	{
		name: "last trust flag wins when denying",
		flags: ["--trust", "--no-trust"],
		global: true,
		prior: true,
		denied: true,
	},
	{ name: "stored true to --no-trust", flags: ["--no-trust"], global: true, prior: true, denied: true },
] as const;

describe("startup model after trust: real offline CLI", () => {
	it.each(selectionCases)("$name uses the actual requested model ID", async (testCase) => {
		await isolated(async (fixture, provider) => {
			projectSettings(fixture);
			if (testCase.global) globalSettings(fixture);
			if ("prior" in testCase) trust(fixture, testCase.prior);
			const piped = "pipe" in testCase;
			const result = await cli(
				fixture,
				provider,
				piped ? [...testCase.flags] : ["-p", "hello", ...testCase.flags],
				{
					input: piped ? "hello\n" : "",
					env: {
						ZAI_API_KEY: "fixture-zai",
						// First print/builtin case proves even a usable builtin loses;
						// first pipe/builtin case exercises the misleading D2 note.
						ANTHROPIC_API_KEY: piped ? undefined : "fixture-anthropic",
					},
				},
			);
			const denied = "denied" in testCase;
			expect.soft(recordedTrust(fixture)).toEqual({ [fixture.cwd]: !denied });
			expect.soft(result.stdout).not.toContain("no startup model configured");
			// REPL renders provider failures on its transcript (stdout); print
			// reports them on stderr. Neither is a startup/preflight failure.
			expect.soft(piped ? result.stdout : result.stderr).toContain("401");
			if (!piped) expect.soft(result.code).toBe(1);
			expectModelRequest(provider, (denied ? GLOBAL : PROJECT).slice("zai/".length));
		});
	});

	it("a flag-looking -p value is not a denial flag", async () => {
		await isolated(async (fixture, provider) => {
			projectSettings(fixture);
			globalSettings(fixture);
			trust(fixture, true);
			const result = await cli(fixture, provider, ["-p", "--no-trust", "--trust"], {
				env: { ZAI_API_KEY: "fixture-key" },
			});
			expect(result.stderr).toContain("401");
			expect(recordedTrust(fixture)).toEqual({ [fixture.cwd]: true });
			expectModelRequest(provider, "project-startup-probe");
			expect(JSON.stringify(provider.requests[0]?.body.messages)).toContain("--no-trust");
		});
	});

	it.each(["unknown", "denied"] as const)(
		"%s without flags uses global without writing trust",
		async (prior) => {
			await isolated(async (fixture, provider) => {
				projectSettings(fixture);
				globalSettings(fixture);
				if (prior === "denied") trust(fixture, false);
				const before = recordedTrust(fixture);
				const result = await cli(fixture, provider, ["-p", "hello"], {
					env: { ZAI_API_KEY: "fixture-key" },
				});
				expect(result.stderr).toContain("401");
				expect(recordedTrust(fixture)).toEqual(before);
				expectModelRequest(provider, "global-startup-probe");
			});
		},
	);

	it.each([
		{ name: "env", args: [], env: { INK_MODEL: "zai/env-probe" }, model: "env-probe" },
		{
			name: "CLI over env",
			args: ["-m", "zai/cli-probe"],
			env: { INK_MODEL: "zai/env-probe" },
			model: "cli-probe",
		},
		{
			name: "last model flag",
			args: ["-m", "zai/old-probe", "--model", "zai/last-probe"],
			env: {},
			model: "last-probe",
		},
	])("$name remains above a newly trusted project default", async ({ args, env, model }) => {
		await isolated(async (fixture, provider) => {
			projectSettings(fixture);
			globalSettings(fixture);
			const result = await cli(fixture, provider, ["-p", "hello", "--trust", ...args], {
				env: { ZAI_API_KEY: "fixture-key", ...env },
			});
			expect(result.stderr).toContain("401");
			expectModelRequest(provider, model);
		});
	});

	it("an unavailable newly trusted project default cannot fall back to the only keyed family", async () => {
		await isolated(async (fixture, provider) => {
			projectSettings(fixture, "deepseek/project-needs-key");
			globalSettings(fixture);
			const loaders = loaderWitnesses(fixture);
			const result = await cli(fixture, provider, ["-p", "hello", "--trust", ...loaders.args], {
				env: { ZAI_API_KEY: "fixture-key" },
			});
			expect.soft(result.code).toBe(1);
			expect.soft(result.stdout).toBe("");
			expect.soft(result.stderr).toContain("deepseek/project-needs-key (deepseek) has no credential");
			expect.soft(result.stderr).toContain("DEEPSEEK_API_KEY");
			expect.soft(result.stderr).toContain("▪ trust: recorded");
			expect.soft(recordedTrust(fixture)).toEqual({ [fixture.cwd]: true });
			expectNoStartupEffects(fixture, provider, loaders);
		});
	});

	it.each(["--trust", "--no-trust"] as const)(
		"%s persists before explicit-model preflight failure, with notes only on stderr",
		async (flag) => {
			await isolated(async (fixture, provider) => {
				projectSettings(fixture);
				const loaders = loaderWitnesses(fixture);
				const result = await cli(fixture, provider, [
					"-p",
					"hello",
					flag,
					"-m",
					"zai/no-key",
					...loaders.args,
				]);
				expect.soft(result.code).toBe(1);
				expect.soft(result.stdout).toBe("");
				expect.soft(result.stderr).toContain("has no credential");
				expect.soft(result.stderr).toContain("▪ trust: recorded");
				expect
					.soft(result.stderr.indexOf("▪ trust:"))
					.toBeLessThan(result.stderr.indexOf("has no credential"));
				expect.soft(recordedTrust(fixture)).toEqual({ [fixture.cwd]: flag === "--trust" });
				expectNoStartupEffects(fixture, provider, loaders);
			});
		},
	);

	it.each(["env", "project", "global", "builtin", "ambiguous-builtin"] as const)(
		"%s preflight failure has empty stdout, exit 1, zero loaders/logs/sessions/MCP",
		async (source) => {
			await isolated(async (fixture, provider) => {
				projectSettings(fixture);
				trust(fixture, source === "project");
				if (source === "global") globalSettings(fixture);
				const loaders = loaderWitnesses(fixture);
				const result = await cli(fixture, provider, ["-p", "hello", ...loaders.args], {
					env:
						source === "env"
							? { INK_MODEL: "zai/env-no-key" }
							: source === "ambiguous-builtin"
								? { ZAI_API_KEY: "fixture-zai", DEEPSEEK_API_KEY: "fixture-deepseek" }
								: {},
				});
				expect.soft(result.code).toBe(1);
				expect.soft(result.stdout).toBe("");
				expect
					.soft(result.stderr)
					.toContain(
						source === "builtin"
							? "no model configured"
							: source === "ambiguous-builtin"
								? "no startup model"
								: "has no credential",
					);
				if (source !== "project") expect.soft(result.stderr).toContain("is not trusted");
				expectNoStartupEffects(fixture, provider, loaders);
			});
		},
	);

	it("witness control: passing preflight executes all extension tiers, reads settings and spawns MCP", async () => {
		await isolated(async (fixture, provider) => {
			projectSettings(fixture);
			trust(fixture, true);
			const loaders = loaderWitnesses(fixture);
			const settings = path.join(fixture.cwd, ".ink/settings.json");
			const reads = readWitness(fixture, [settings]);
			const result = await cli(fixture, provider, ["-p", "hello", ...loaders.args], {
				env: { ZAI_API_KEY: "fixture-key" },
				preload: reads.preload,
			});
			expect(result.code).toBe(1);
			expect(result.stderr).toContain("401");
			expectModelRequest(provider, "project-startup-probe");
			for (const witness of [...loaders.witnesses, loaders.pid])
				expect(existsSync(witness), witness).toBe(true);
			expect(reads.reads()).toContain(settings);
			expect(filesUnder(state(fixture, "logs")).length).toBeGreaterThan(0);
			expect(filesUnder(state(fixture, "sessions")).length).toBeGreaterThan(0);
		});
	});

	it("corrupt trust store is diagnosed before an explicit model's missing credential", async () => {
		await isolated(async (fixture, provider) => {
			projectSettings(fixture);
			put(state(fixture, "trust.json"), "{broken");
			const loaders = loaderWitnesses(fixture);
			const result = await cli(fixture, provider, ["-p", "hello", "-m", "zai/no-key", ...loaders.args]);
			expect.soft(result.code).toBe(1);
			expect.soft(result.stdout).toBe("");
			expect.soft(result.stderr).toContain("failed to read the trust store");
			expect.soft(result.stderr).not.toContain("has no credential");
			expect.soft(readFileSync(state(fixture, "trust.json"), "utf8")).toBe("{broken");
			expectNoStartupEffects(fixture, provider, loaders);
		});
	});

	it.each(["--trust", "--no-trust"] as const)(
		"%s repairs a corrupt store even when env preflight fails",
		async (flag) => {
			await isolated(async (fixture, provider) => {
				projectSettings(fixture);
				put(state(fixture, "trust.json"), "{broken");
				const loaders = loaderWitnesses(fixture);
				const result = await cli(fixture, provider, ["-p", "hello", flag, ...loaders.args], {
					env: { INK_MODEL: "zai/no-key" },
				});
				expect.soft(result.code).toBe(1);
				expect.soft(result.stdout).toBe("");
				expect.soft(result.stderr).toContain("has no credential");
				expect.soft(result.stderr).toContain("▪ trust: recorded");
				// Compare bytes through JSON.stringify: the base's corrupt file must
				// produce a meaningful failed assertion, not a JSON.parse exception.
				expect
					.soft(readFileSync(state(fixture, "trust.json"), "utf8").trim())
					.toBe(JSON.stringify({ [fixture.cwd]: flag === "--trust" }, null, "\t"));
				expectNoStartupEffects(fixture, provider, loaders);
			});
		},
	);

	it("without project resources --trust does not read or repair a corrupt store", async () => {
		await isolated(async (fixture, provider) => {
			const store = state(fixture, "trust.json");
			put(store, "{broken");
			const reads = readWitness(fixture, [store]);
			const result = await cli(fixture, provider, ["-p", "hello", "--trust"], {
				env: { INK_MODEL: "zai/no-key" },
				preload: reads.preload,
			});
			expect(result.code).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("has no credential");
			expect(reads.reads()).toEqual([]);
			expect(readFileSync(store, "utf8")).toBe("{broken");
			expectNoStartupEffects(fixture, provider);
		});
	});

	it.each(["trusted", "corrupt"] as const)("missing @file precedes trust in a %s project", async (prior) => {
		await isolated(async (fixture, provider) => {
			projectSettings(fixture);
			const store = state(fixture, "trust.json");
			if (prior === "trusted") trust(fixture, true);
			else put(store, "{broken");
			const before = readFileSync(store, "utf8");
			const loaders = loaderWitnesses(fixture);
			const reads = readWitness(fixture, [store, path.join(fixture.cwd, ".ink/settings.json")]);
			const result = await cli(
				fixture,
				provider,
				["-p", "hello", "@missing-probe.txt", "--trust", ...loaders.args],
				{
					preload: reads.preload,
				},
			);
			expect.soft(result.code).toBe(1);
			expect.soft(result.stdout).toBe("");
			expect.soft(result.stderr).toContain("missing-probe.txt");
			expect.soft(result.stderr).not.toContain("has no credential");
			expect.soft(result.stderr).not.toContain("trust store");
			expect.soft(result.stderr).not.toContain("▪ trust:");
			expect.soft(readFileSync(store, "utf8")).toBe(before);
			expect.soft(reads.reads()).toEqual([]);
			expectNoStartupEffects(fixture, provider, loaders);
		});
	});

	it.each(["--help", "--version"] as const)(
		"%s never reads project content in an already trusted directory",
		async (flag) => {
			await isolated(async (fixture, provider) => {
				projectSettings(fixture);
				trust(fixture, true);
				const loaders = loaderWitnesses(fixture);
				put(path.join(fixture.cwd, ".ink/SYSTEM.md"), "Project startup prompt");
				const reads = readWitness(fixture, [
					path.join(fixture.cwd, ".ink/settings.json"),
					path.join(fixture.cwd, ".ink/SYSTEM.md"),
					path.join(fixture.cwd, ".ink/extensions/project-probe.mjs"),
					path.join(fixture.cwd, ".mcp.json"),
				]);
				const result = await cli(fixture, provider, [flag, ...loaders.args], { preload: reads.preload });
				expect.soft(result.code).toBe(0);
				expect.soft(result.stdout).toContain(flag === "--help" ? "--trust" : "Ink ");
				expect.soft(result.stderr).toBe("");
				expect.soft(reads.reads()).toEqual([]);
				expectNoStartupEffects(fixture, provider, loaders);
			});
		},
	);

	it.each(["settings", "env", "CLI"] as const)(
		"actual resume with %s selection: only explicit -m overrides the saved model",
		async (source) => {
			await isolated(async (fixture, provider) => {
				projectSettings(fixture, "deepseek/unavailable-project-default");
				globalSettings(fixture, "deepseek/unavailable-global-default");
				const session = createSession(fixture.cwd, state(fixture, "sessions"));
				session.setModel({ provider: "zai", modelId: "saved-probe" });
				session.appendMessage({ role: "user", content: "saved history" });
				const result = await cli(
					fixture,
					provider,
					[
						"-r",
						session.header.id,
						"-p",
						"hello",
						"--trust",
						...(source === "CLI" ? ["-m", "zai/cli-resume-probe"] : []),
					],
					{
						env: {
							INK_MODEL: source === "env" ? "deepseek/unavailable-env-default" : undefined,
							ZAI_API_KEY: "fixture-key",
						},
					},
				);
				expect(result.code).toBe(1);
				expect(result.stderr).toContain("401");
				expect(result.stdout).toContain("▪ resumed");
				const selected = source === "CLI" ? "cli-resume-probe" : "saved-probe";
				expectModelRequest(provider, selected);
				expect(SessionStore.open(session.filePath).getModel()).toEqual({
					provider: "zai",
					modelId: selected,
				});
			});
		},
	);

	it.each(["fresh", "model-less-resume"] as const)(
		"%s retains newly trusted subscription Fast identity without login",
		async (mode) => {
			await isolated(async (fixture, provider) => {
				projectSettings(fixture, FAST);
				globalSettings(fixture);
				const session =
					mode === "model-less-resume" ? createSession(fixture.cwd, state(fixture, "sessions")) : undefined;
				session?.appendMessage({ role: "user", content: "model-less history" });
				// /name durably flushes the selection through the actual REPL without
				// requiring OAuth, a fake provider injection, or a subscription call.
				const result = await cli(
					fixture,
					provider,
					["--trust", ...(session ? ["-r", session.header.id] : [])],
					{
						input: "/name Fast selection probe\n",
						env: { ZAI_API_KEY: "fixture-api-key-must-not-replace-subscription" },
					},
				);
				expect.soft(result.code).toBe(0);
				expect.soft(result.stdout).not.toContain("using zai/");
				expect.soft(provider.requests).toEqual([]);
				const files = filesUnder(state(fixture, "sessions")).filter((file) => file.endsWith(".jsonl"));
				expect(files).toHaveLength(1);
				expect(SessionStore.open(files[0]!).getModel()).toEqual({
					provider: "openai-codex",
					modelId: "project-startup-probe",
					speed: "fast",
				});
			});
		},
	);

	it("saved Fast subscription selection survives keyed API defaults and a newly trusted project", async () => {
		await isolated(async (fixture, provider) => {
			projectSettings(fixture);
			globalSettings(fixture);
			const session = createSession(fixture.cwd, state(fixture, "sessions"));
			session.setModel({ provider: "openai-codex", modelId: "saved-fast-probe", speed: "fast" });
			session.appendMessage({ role: "user", content: "retain subscription billing and speed" });
			const result = await cli(fixture, provider, ["--trust", "-r", session.header.id], {
				input: "/name Retained Fast probe\n",
				env: { ZAI_API_KEY: "fixture-key", OPENAI_API_KEY: "fixture-api-key" },
			});
			expect(result.code).toBe(0);
			expect(result.stdout).toContain("▪ resumed");
			expect(result.stdout).not.toContain("using zai/");
			expect(provider.requests).toEqual([]);
			expect(SessionStore.open(session.filePath).getModel()).toEqual({
				provider: "openai-codex",
				modelId: "saved-fast-probe",
				speed: "fast",
			});
		});
	});
});
