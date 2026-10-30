import * as fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSession, listSessions } from "../src/core/session/manager.js";
import { type SessionModel, SessionStore } from "../src/core/session/store.js";
import { CODEX_METADATA_SOURCE, loadCatalogCache, resetCatalogForTest } from "../src/provider/catalog.js";
import { compactionSettingsFor } from "../src/provider/compaction-settings.js";
import { resetDiscoveredWindowsForTest } from "../src/provider/discover.js";
import { contextWindowInfoFor } from "../src/provider/models.js";
import type { LLMRequest } from "../src/provider/types.js";
import { createRunner, type RunnerOptions } from "../src/runner.js";
import { assistant, makeRenderer, scriptedProvider } from "./helpers/fakes.js";
import { mkTempDir } from "./helpers/mktemp.js";

// Replace every provider factory, including cross-family restoration. Parsing,
// runner state transitions, context replay and JSONL persistence remain real.
const calls = vi.hoisted(() => [] as { family: string; request: LLMRequest }[]);
vi.mock("../src/provider/resolve.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/provider/resolve.js")>();
	const { assistant, scriptedProvider } = await import("./helpers/fakes.js");
	const createProviderFor = vi.fn((family: string) => {
		const fake = scriptedProvider([assistant([{ type: "text", text: "reply" }])]);
		return {
			...fake,
			stream: (...args: Parameters<typeof fake.stream>) => {
				calls.push({ family, request: args[0] });
				return fake.stream(...args);
			},
		};
	});
	return {
		...actual,
		createProviderFor,
		resolveModel: (reference: string) => {
			const ref = actual.parseModelRef(reference);
			return { provider: createProviderFor(ref.provider), modelId: ref.modelId };
		},
	};
});
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, appendFileSync: vi.fn(actual.appendFileSync) };
});

let root: string;
let cwd: string;
let baseDir: string;
const initial = { provider: "anthropic", modelId: "claude-sonnet-4-6" };
const other = { provider: "openai", modelId: "gpt-5.2" };
const zai = { provider: "zai", modelId: "glm-5.3" };
const qualified = (model: SessionModel) => `${model.provider}/${model.modelId}`;
const snapshot = (store: SessionStore) => ({
	bytes: fs.readFileSync(store.filePath, "utf8"),
	mtime: fs.statSync(store.filePath).mtimeMs,
});
const reopen = (store: SessionStore) => SessionStore.open(store.filePath);

beforeEach(() => {
	root = mkTempDir("ink-session-model-runner-");
	cwd = path.join(root, "project");
	baseDir = path.join(root, "sessions");
	fs.mkdirSync(cwd);
	// settings-setup already isolates globals; each case also gets independent
	// settings/auth/catalog files and an empty home for deterministic defaults.
	for (const [key, value] of Object.entries({
		HOME: root,
		INK_SETTINGS_PATH: path.join(root, "settings.json"),
		INK_AUTH_PATH: path.join(root, "auth.json"),
		INK_CATALOG_PATH: path.join(root, "catalog.json"),
		INK_LOG: "0",
		INK_BRANCH_SUMMARY: "0",
	}))
		vi.stubEnv(key, value);
	for (const key of [
		"ANTHROPIC_API_KEY",
		"ANTHROPIC_AUTH_TOKEN",
		"OPENAI_API_KEY",
		"ZAI_API_KEY",
		"DEEPSEEK_API_KEY",
		"MOONSHOT_API_KEY",
		"INK_MODEL",
		"INK_THINKING",
	])
		vi.stubEnv(key, undefined);
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("Network forbidden in session model tests");
		}),
	);
	calls.length = 0;
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.clearAllMocks();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	fs.rmSync(root, { recursive: true, force: true });
});

async function runner(options: Partial<RunnerOptions> = {}) {
	const { renderer, output } = makeRenderer();
	const live = await createRunner({
		cwd,
		argv: [],
		model: qualified(initial),
		maxTokens: 1024,
		maxTurns: 3,
		noContextFiles: true,
		noSession: false,
		sessionBaseDir: baseDir,
		renderer,
		settingsPath: path.join(root, "settings.json"),
		agentsHomeDir: root,
		...options,
	});
	return Object.assign(live, { output });
}
function saved(model?: SessionModel, text = "saved history") {
	const store = createSession(cwd, baseDir);
	if (model) store.seedModel(model);
	store.appendMessage({ role: "user", content: text });
	store.appendMessage(assistant([{ type: "text", text: "saved reply" }]));
	return store;
}

describe("runner per-session model restoration", () => {
	it.each(["resume", "continue"])("startup %s restores model before making any request", async (mode) => {
		// #fresh-install-hint: the resumed-model rendering assertion below
		// pins the USABLE path — give the saved family a credential (env var,
		// scrubbed around the test) so the banner is not the new
		// "no model — /login" segment (that path has its own suite).
		const prevKey = process.env.OPENAI_API_KEY;
		process.env.OPENAI_API_KEY = "test-key-openai";
		try {
			const store = saved(other);
			const before = snapshot(store);
			const live = await runner(mode === "resume" ? { resume: store.header.id } : { continueRecent: true });
			expect(live.session?.header.id).toBe(store.header.id);
			expect(live.modelReference()).toBe(qualified(other));
			expect(live.providerName).toBe(other.provider);
			expect(live.history).toEqual(store.buildContext().messages);
			expect(live.output()).toContain(qualified(other));
			expect(snapshot(store)).toEqual(before);
			expect(calls).toEqual([]);
			await live.runTurn({ userMessage: "next" });
			expect(calls.map(({ family, request }) => [family, request.model])).toEqual([
				[other.provider, other.modelId],
			]);
		} finally {
			if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
			else process.env.OPENAI_API_KEY = prevKey;
		}
	});

	it("slash resume restores independent selections and history without writing either file", async () => {
		const a = saved(initial, "session A");
		const b = saved(other, "session B");
		const beforeA = snapshot(a);
		const beforeB = snapshot(b);
		const live = await runner({ resume: a.header.id });
		const history = live.history;
		for (const [store, model] of [
			[b, other],
			[a, initial],
			[b, other],
		] as const) {
			live.resumeSession(store.header.id);
			expect(live.history).toBe(history);
			expect(live.history).toEqual(store.buildContext().messages);
			expect(live.session?.header.id).toBe(store.header.id);
			expect(live.session?.getModel()).toEqual(model);
			expect(live.providerName).toBe(model.provider);
			expect(live.model).toBe(model.modelId);
		}
		expect(snapshot(a)).toEqual(beforeA);
		expect(snapshot(b)).toEqual(beforeB);
		expect(calls).toEqual([]);
	});

	it("captures the initial model on the first message without /model and reuses injected providers", async () => {
		const requests: LLMRequest[] = [];
		const live = await runner({
			provider: scriptedProvider([assistant([{ type: "text", text: "injected" }])], requests),
		});
		const store = live.session!;
		expect(fs.existsSync(store.filePath)).toBe(false);
		expect(live.listSessions()).toEqual([]);
		await live.runTurn({ userMessage: "first" });
		expect(requests).toHaveLength(1);
		expect(requests[0]?.model).toBe(initial.modelId);
		expect(reopen(store).getModel()).toEqual(initial);
		expect(reopen(store).hasModelSelection).toBe(false);
		expect(JSON.parse(snapshot(store).bytes.split("\n")[0]!).model).toEqual(initial);
	});

	it("switching before any message immediately creates a discoverable model-only session", async () => {
		const live = await runner();
		live.setModel(qualified(other));
		const store = live.session!;
		expect(reopen(store).getModel()).toEqual(other);
		expect(reopen(store).hasModelSelection).toBe(true);
		expect(reopen(store).buildContext().messages).toEqual([]);
		expect(listSessions(cwd, baseDir)).toMatchObject([
			{ id: store.header.id, title: `(model: ${qualified(other)})` },
		]);
		const continued = await runner({ continueRecent: true });
		expect(continued.session?.header.id).toBe(store.header.id);
		expect(continued.modelReference()).toBe(qualified(other));
		expect(calls).toEqual([]);
	});

	it("explicit startup override persists once, but does not override later slash resume", async () => {
		const a = saved(initial);
		const b = saved(zai);
		const beforeB = snapshot(b);
		const live = await runner({ resume: a.header.id, model: qualified(other), modelExplicit: true });
		expect(reopen(a).getModel()).toEqual(other);
		expect(
			snapshot(a)
				.bytes.split("\n")
				.filter((line) => line.includes('"type":"session_model"')),
		).toHaveLength(1);
		const afterA = snapshot(a);
		live.resumeSession(b.header.id);
		expect(live.providerName).toBe("zai");
		expect(live.model).toBe(zai.modelId);
		live.resumeSession(a.header.id);
		expect(live.modelReference()).toBe(qualified(other));
		expect(snapshot(a)).toEqual(afterA);
		expect(snapshot(b)).toEqual(beforeB);
		expect((await runner({ resume: a.header.id })).modelReference()).toBe(qualified(other));
	});

	it("same explicit startup override and /model leave bytes and mtime unchanged", async () => {
		const store = saved(other);
		fs.utimesSync(store.filePath, new Date(1000), new Date(1000));
		const before = snapshot(store);
		const live = await runner({ resume: store.header.id, model: qualified(other), modelExplicit: true });
		live.setModel(qualified(other));
		expect(snapshot(store)).toEqual(before);
		expect(reopen(store).hasModelSelection).toBe(false);
	});

	it("legacy files use the original startup model, not the previous live session model", async () => {
		// #fresh-install-hint: pins the persistence contract (seed on first
		// message), not credential UX — both touched families get env keys so
		// the D4 gates stay open (the unusable variants live in
		// fresh-install-hint.test.ts).
		const prevOpen = process.env.OPENAI_API_KEY;
		const prevZai = process.env.ZAI_API_KEY;
		process.env.OPENAI_API_KEY = "test-key-openai";
		process.env.ZAI_API_KEY = "test-key-zai";
		try {
			const legacy = saved();
			const modern = saved(other);
			const before = snapshot(legacy);
			const live = await runner({ resume: modern.header.id });
			live.setModel(qualified(zai));
			live.resumeSession(legacy.header.id);
			expect(live.providerName).toBe(initial.provider);
			expect(live.model).toBe(initial.modelId);
			expect(snapshot(legacy)).toEqual(before);
			expect(reopen(legacy).getModel()).toBeUndefined();
			await live.runTurn({ userMessage: "capture legacy seed" });
			// #fresh-install-hint round-2 review F2: the seed gate probes the
			// model BEING persisted (anthropic, no credential — only zai/openai
			// hold keys in this test), so a model-less legacy session resumed
			// mid-session stays model-less even after a turn. The OLD assertion
			// (seed lands as the startup default) pinned the pre-F2 behavior —
			// the stale-family verdict — which P4 forbids.
			expect(reopen(legacy).getModel()).toBeUndefined();
		} finally {
			if (prevOpen === undefined) delete process.env.OPENAI_API_KEY;
			else process.env.OPENAI_API_KEY = prevOpen;
			if (prevZai === undefined) delete process.env.ZAI_API_KEY;
			else process.env.ZAI_API_KEY = prevZai;
		}
	});

	it("/new preserves the live model while remaining lazy until a message", async () => {
		// #fresh-install-hint: pins laziness, not credential UX — env key so
		// the D4 gate stays open.
		const prevOpen = process.env.OPENAI_API_KEY;
		process.env.OPENAI_API_KEY = "test-key-openai";
		try {
			const live = await runner();
			live.setModel(qualified(other));
			const previous = live.session!;
			const before = snapshot(previous);
			live.newSession();
			const fresh = live.session!;
			expect(fresh.header.id).not.toBe(previous.header.id);
			expect(live.modelReference()).toBe(qualified(other));
			expect(live.history).toEqual([]);
			expect(fs.existsSync(fresh.filePath)).toBe(false);
			live.setModel(qualified(other));
			expect(fs.existsSync(fresh.filePath)).toBe(false);
			expect(live.listSessions().map((item) => item.id)).toEqual([previous.header.id]);
			await live.runTurn({ userMessage: "new conversation" });
			expect(reopen(fresh).getModel()).toEqual(other);
			expect(snapshot(previous)).toEqual(before);
		} finally {
			if (prevOpen === undefined) delete process.env.OPENAI_API_KEY;
			else process.env.OPENAI_API_KEY = prevOpen;
		}
	});

	it("preserves anthropic/glm-5.3 versus zai/glm-5.3 across cross-provider restores", async () => {
		const compat = { provider: "anthropic", modelId: "glm-5.3" };
		const a = saved(compat);
		const b = saved(zai);
		const live = await runner({ resume: a.header.id, model: qualified(other) });
		expect(live.providerName).toBe("anthropic");
		await live.runTurn({ userMessage: "compat" });
		live.resumeSession(b.header.id);
		await live.runTurn({ userMessage: "native" });
		live.resumeSession(a.header.id);
		await live.runTurn({ userMessage: "compat again" });
		expect(calls.map(({ family, request }) => [family, request.model])).toEqual([
			["anthropic", "glm-5.3"],
			["zai", "glm-5.3"],
			["anthropic", "glm-5.3"],
		]);
		expect(reopen(a).getModel()).toEqual(compat);
		expect(reopen(b).getModel()).toEqual(zai);
	});

	it("/fork and /tree change history but retain the session-wide current model", async () => {
		const live = await runner();
		await live.runTurn({ userMessage: "old model turn" });
		const oldLeaf = live.session!.getLeafId()!;
		live.setModel(qualified(other));
		await live.runTurn({ userMessage: "new model turn" });
		const point = live.forkPoints()[0]!;
		await live.forkSessionAt(point.id);
		expect(live.history).toEqual([]);
		expect(live.modelReference()).toBe(qualified(other));
		await live.navigateTree(oldLeaf, { summarize: false });
		expect(live.history).toHaveLength(2);
		expect(live.modelReference()).toBe(qualified(other));
		expect(reopen(live.session!).getModel()).toEqual(other);
		expect(calls).toHaveLength(2);
	});

	it.each([false, true])(
		"restores explicit thinking after a knobless startup model (deferred=%s)",
		async (deferInit) => {
			const store = saved(initial);
			store.appendThinkingLevelChange("low");
			const live = await runner({
				resume: store.header.id,
				model: "openai/gpt-4o",
				thinking: "high",
				deferInit,
			});
			await live.warmup();
			expect(live.supportsThinking()).toBe(true);
			expect(live.thinkingLevel).toBe("high");
			expect(live.model).toBe(initial.modelId);
			expect(calls).toEqual([]);
		},
	);

	it("missing credentials never substitute a different model or make validation requests", async () => {
		const store = saved(zai);
		const before = snapshot(store);
		const live = await runner({ resume: store.header.id });
		expect(live.modelReference()).toBe(qualified(zai));
		expect(live.output()).toContain("/login zai");
		expect(calls).toEqual([]);
		expect(fetch).not.toHaveBeenCalled();
		expect(snapshot(store)).toEqual(before);
	});

	it.each(["startup", "slash"])(
		"%s resume preserves a subscription selection without credentials even when API-key billing is configured",
		async (mode) => {
			vi.stubEnv("OPENAI_API_KEY", "api-key-must-not-replace-subscription");
			const subscription = { provider: "openai-codex", modelId: "account-unlisted-choice" };
			const store = saved(subscription);
			const before = snapshot(store);
			const live = await runner(mode === "startup" ? { resume: store.header.id } : {});
			if (mode === "slash") live.resumeSession(store.header.id);
			expect(live.modelReference()).toBe(qualified(subscription));
			expect(live.providerName).toBe("openai-codex");
			expect(live.modelSelectionPending()).toBe(false);
			expect(live.modelUsable()).toBe(false);
			expect(live.output()).not.toContain("using openai/");
			expect(snapshot(store)).toEqual(before);
			expect(calls).toEqual([]);
			expect(fetch).not.toHaveBeenCalled();
			await live.runTurn({ userMessage: "still the subscription model" });
			expect(calls.at(-1)?.family).toBe("openai-codex");
			expect(calls.at(-1)?.request.model).toBe(subscription.modelId);
		},
	);

	it("explicit subscription remains selected when resuming a model-less session", async () => {
		vi.stubEnv("OPENAI_API_KEY", "must-not-fall-back-to-api-key");
		const legacy = saved();
		const live = await runner({
			model: "openai-codex/explicit-unlisted",
			modelSource: "global",
			resume: legacy.header.id,
		});
		expect(live.modelReference()).toBe("openai-codex/explicit-unlisted");
		expect(live.modelSelectionPending()).toBe(false);
		expect(live.modelUsable()).toBe(false);
		expect(reopen(legacy).getModel()).toBeUndefined();
		expect(fetch).not.toHaveBeenCalled();
	});

	it.each(["cli", "env", "project", "global"] as const)(
		"fresh deliberate subscription (%s) persists through messages and real-session resume with only an API key",
		async (modelSource) => {
			const subscription = { provider: "openai-codex", modelId: "chosen-without-token" };
			const live = await runner({
				model: qualified(subscription),
				modelSource,
				modelExplicit: modelSource === "cli",
			});
			const store = live.session!;
			expect(live.modelUsable()).toBe(false);
			expect(live.modelSelectionPending()).toBe(false);
			expect(store.getModel()).toEqual(subscription);
			expect(fs.existsSync(store.filePath)).toBe(false); // seeding remains lazy
			await live.runTurn({ userMessage: "persist my deliberate subscription choice" });
			expect(reopen(store).getModel()).toEqual(subscription);
			expect(JSON.parse(snapshot(store).bytes.split("\n")[0]!).model).toEqual(subscription);
			vi.stubEnv("OPENAI_API_KEY", "api-key-must-not-replace-subscription");
			const resumed = await runner({
				resume: store.header.id,
				model: "claude-sonnet-4-5",
				modelSource: "builtin",
			});
			expect(resumed.providerName).toBe("openai-codex");
			expect(resumed.modelReference()).toBe(qualified(subscription));
			expect(resumed.modelUsable()).toBe(false);
			expect(resumed.modelSelectionPending()).toBe(false);
			await resumed.runTurn({ userMessage: "continue without changing billing provider" });
			expect(calls.map(({ family, request }) => [family, request.model])).toEqual([
				["openai-codex", subscription.modelId],
				["openai-codex", subscription.modelId],
			]);
			expect(fetch).not.toHaveBeenCalled();
		},
	);

	it("model-less restored history records a deliberate retained subscription on the next message", async () => {
		vi.stubEnv("OPENAI_API_KEY", "api-key-must-not-replace-subscription");
		const legacy = saved();
		const subscription = { provider: "openai-codex", modelId: "configured-without-token" };
		const live = await runner({
			model: qualified(subscription),
			modelSource: "global",
			resume: legacy.header.id,
		});
		// No rewrite on merely opening old history; selection is appended
		// with its next message, even without an intervening setModel call.
		expect(reopen(legacy).getModel()).toBeUndefined();
		expect(live.modelSelectionPending()).toBe(false);
		await live.runTurn({ userMessage: "record the retained selection" });
		expect(reopen(legacy).getModel()).toEqual(subscription);
		expect(snapshot(legacy).bytes).toContain('"type":"session_model","provider":"openai-codex"');
		const resumed = await runner({
			resume: legacy.header.id,
			model: "claude-sonnet-4-5",
			modelSource: "builtin",
		});
		expect(resumed.modelReference()).toBe(qualified(subscription));
		expect(resumed.modelUsable()).toBe(false);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("/new retains deliberate subscription identity without credentials and persists it lazily", async () => {
		vi.stubEnv("OPENAI_API_KEY", "api-key-must-not-replace-subscription");
		const live = await runner({
			model: "openai-codex/new-without-token",
			modelSource: "cli",
			modelExplicit: true,
		});
		live.newSession();
		const store = live.session!;
		expect(fs.existsSync(store.filePath)).toBe(false);
		await live.runTurn({ userMessage: "keep subscription for this new session" });
		expect(reopen(store).getModel()).toEqual({ provider: "openai-codex", modelId: "new-without-token" });
		const resumed = await runner({
			continueRecent: true,
			model: "claude-sonnet-4-5",
			modelSource: "builtin",
		});
		expect(resumed.modelReference()).toBe("openai-codex/new-without-token");
	});

	it.each(["claude-sonnet-4-5", "openai-codex/unselected-placeholder"])(
		"unselected builtin placeholder %s is still absent from persisted session identity",
		async (model) => {
			const live = await runner({ model, modelSource: "builtin" });
			expect(live.modelSelectionPending()).toBe(true);
			expect(live.session?.getModel()).toBeUndefined();
			await live.runTurn({ userMessage: "unselected builtin must not become a choice" });
			expect(reopen(live.session!).getModel()).toBeUndefined();
			expect(snapshot(live.session!).bytes).not.toContain('"type":"session_model"');
		},
	);

	it("slash resume recomputes unselected intent from that session instead of the prior session's selection", async () => {
		const subscription = saved({ provider: "openai-codex", modelId: "saved-subscription" });
		const legacy = saved();
		const live = await runner({
			model: "claude-sonnet-4-5",
			modelSource: "builtin",
			resume: subscription.header.id,
		});
		expect(live.modelSelectionPending()).toBe(false);
		live.resumeSession(legacy.header.id);
		expect(live.modelSelectionPending()).toBe(true);
		live.resumeSession(subscription.header.id);
		expect(live.modelReference()).toBe("openai-codex/saved-subscription");
		expect(live.modelSelectionPending()).toBe(false);
	});

	it.each(["cli", "env", "project", "global"] as const)(
		"configured subscription startup intent (%s) is separate from credential availability",
		async (modelSource) => {
			const live = await runner({
				model: "openai-codex/account-unlisted-choice",
				modelSource,
				noSession: true,
			});
			expect(live.modelSelectionPending()).toBe(false);
			expect(live.modelUsable()).toBe(false);
			live.newSession();
			expect(live.modelReference()).toBe("openai-codex/account-unlisted-choice");
			expect(live.modelSelectionPending()).toBe(false);
		},
	);

	it("only a builtin unselected model permits login-time selection; /model records intent even without credentials", async () => {
		const live = await runner({ model: "claude-sonnet-4-5", modelSource: "builtin", noSession: true });
		expect(live.modelSelectionPending()).toBe(true);
		live.setModel("openai-codex/not-in-account-list");
		expect(live.modelSelectionPending()).toBe(false);
		expect(live.modelSelectedExplicitly()).toBe(true);
		expect(live.modelUsable()).toBe(false);
	});

	it("setModel persistence failure leaves provider, model, thinking, history and session unchanged", async () => {
		const store = saved(initial);
		const live = await runner({ resume: store.header.id, thinking: "high" });
		const session = live.session!;
		const history = live.history;
		const messages = [...history];
		const before = snapshot(session);
		const window = live.contextWindow;
		const leaf = session.getLeafId();
		vi.mocked(fs.appendFileSync).mockImplementationOnce(() => {
			throw new Error("disk full");
		});
		expect(() => live.setModel("openai/gpt-4o")).toThrow("disk full");
		expect(live.session).toBe(session);
		expect(session.getModel()).toEqual(initial);
		expect(session.getLeafId()).toBe(leaf);
		expect(live.history).toBe(history);
		expect(live.history).toEqual(messages);
		expect(live.providerName).toBe(initial.provider);
		expect(live.model).toBe(initial.modelId);
		expect(live.contextWindow).toBe(window);
		expect(live.thinkingLevel).toBe("high");
		expect(snapshot(session)).toEqual(before);
		await live.runTurn({ userMessage: "still original provider" });
		expect(calls.at(-1)?.family).toBe(initial.provider);
		expect(calls.at(-1)?.request.model).toBe(initial.modelId);
	});
});

describe("runner context window provider identity", () => {
	const modelId = "gpt-catalog-window-test";
	const providerWindows = { anthropic: 200_000, openai: 272_000, "openai-codex": 500_000 };

	function installWindowCatalog(windows: Record<string, number> = providerWindows): void {
		const providers = Object.fromEntries(
			Object.entries(windows).map(([provider, contextWindow]) => [
				provider,
				{
					models: { [modelId]: { id: modelId, contextWindow } },
					checkedAt: 1,
					...(provider === "openai-codex" ? { source: CODEX_METADATA_SOURCE } : {}),
				},
			]),
		);
		fs.writeFileSync(process.env.INK_CATALOG_PATH!, JSON.stringify({ version: 2, providers }));
		resetCatalogForTest();
		expect(loadCatalogCache()).toBe(true);
	}

	beforeEach(() => {
		vi.stubEnv("INK_CONTEXT_WINDOW", undefined);
		resetCatalogForTest();
		resetDiscoveredWindowsForTest();
		installWindowCatalog();
	});
	afterEach(() => {
		resetCatalogForTest();
		resetDiscoveredWindowsForTest();
	});

	it.each(Object.entries(providerWindows))(
		"uses the selected %s catalog window at construction",
		async (provider, window) => {
			const reference = qualified({ provider, modelId });
			const live = await runner({ model: reference, provider: scriptedProvider([]), noSession: true });
			expect(live.providerName).toBe(provider);
			expect(live.model).toBe(modelId);
			expect(live.contextWindow).toBe(window);
			expect(live.contextWindow).toBe(compactionSettingsFor(reference).contextWindow);
		},
	);

	it("uses a cached Codex-only model without model discovery or a static entry", async () => {
		installWindowCatalog({ "openai-codex": 500_000 });
		// The bare id has no static/discovery fallback to conceal a lost provider.
		expect(contextWindowInfoFor(modelId)).toEqual({ contextWindow: 131_072, source: "fallback" });
		const live = await runner({
			model: `openai-codex/${modelId}`,
			provider: scriptedProvider([]),
			noSession: true,
		});
		expect(live.contextWindow).toBe(500_000);
		expect(fetch).not.toHaveBeenCalled();
		expect(calls).toEqual([]);
	});

	it("changes the window when switching providers without changing the model id", async () => {
		const live = await runner({
			model: `anthropic/${modelId}`,
			provider: scriptedProvider([]),
			noSession: true,
		});
		for (const provider of ["openai", "openai-codex", "anthropic"] as const) {
			live.setModel(`${provider}/${modelId}`);
			expect(live.providerName).toBe(provider);
			expect(live.model).toBe(modelId);
			expect(live.contextWindow).toBe(providerWindows[provider]);
		}
		expect(fetch).not.toHaveBeenCalled();
		expect(calls).toEqual([]);
	});

	it.each(["resume", "continue"])("restores the Codex catalog window on startup %s", async (mode) => {
		const store = saved({ provider: "openai-codex", modelId });
		const live = await runner({
			provider: scriptedProvider([]),
			...(mode === "resume" ? { resume: store.header.id } : { continueRecent: true }),
		});
		expect(live.session?.header.id).toBe(store.header.id);
		expect(live.providerName).toBe("openai-codex");
		expect(live.model).toBe(modelId);
		expect(live.contextWindow).toBe(500_000);
		expect(fetch).not.toHaveBeenCalled();
		expect(calls).toEqual([]);
	});

	it("uses each restored session's provider when resuming the same model id", async () => {
		const stores = Object.entries(providerWindows).map(([provider, window]) => ({
			provider,
			window,
			store: saved({ provider, modelId }),
		}));
		const live = await runner({ provider: scriptedProvider([]) });
		for (const { provider, window, store } of stores) {
			live.resumeSession(store.header.id);
			expect(live.session?.header.id).toBe(store.header.id);
			expect(live.providerName).toBe(provider);
			expect(live.model).toBe(modelId);
			expect(live.contextWindow).toBe(window);
		}
		expect(fetch).not.toHaveBeenCalled();
		expect(calls).toEqual([]);
	});

	it("preserves the environment override and the unknown-model fallback", async () => {
		const live = await runner({
			model: `openai-codex/${modelId}`,
			provider: scriptedProvider([]),
			noSession: true,
		});
		vi.stubEnv("INK_CONTEXT_WINDOW", "65536");
		expect(live.contextWindow).toBe(65_536);
		live.setModel("openai-codex/gpt-unknown-window-test");
		expect(live.contextWindow).toBe(65_536);
		vi.stubEnv("INK_CONTEXT_WINDOW", undefined);
		expect(live.contextWindow).toBe(131_072);
		live.setModel(`openai-codex/${modelId}`);
		expect(live.contextWindow).toBe(500_000);
	});
});
