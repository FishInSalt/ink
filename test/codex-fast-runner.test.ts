import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { compactHistory, summarizeBranchSegment } from "../src/core/compaction.js";
import { type RunAgentLoopOptions, runAgentLoop } from "../src/core/loop.js";
import type { AgentMessage, AssistantMessage } from "../src/core/messages.js";
import { createSession } from "../src/core/session/manager.js";
import { SessionStore } from "../src/core/session/store.js";
import type { Tool } from "../src/core/tools/types.js";
import { ExtensionRegistry } from "../src/extensions/registry.js";
import { CODEX_METADATA_SOURCE, loadCatalogCache, resetCatalogForTest } from "../src/provider/catalog.js";
import { costFor } from "../src/provider/models.js";
import { toResponsesInput } from "../src/provider/responses-history.js";
import type { LLMRequest, ModelSpeed } from "../src/provider/types.js";
import { createRunner, type RunnerOptions } from "../src/runner.js";
import { assistant, makeRenderer, type ScriptStep, scriptedProvider, user } from "./helpers/fakes.js";
import { mkTempDir } from "./helpers/mktemp.js";

const MODEL = "gpt-6.1-sol";
const MODELS = [MODEL, "gpt-5.5", "custom-future-codex", "retired-codex-2025", "vendor/custom-codex"];
const BASE = `openai-codex/${MODEL}`;
const FAST = `${BASE}·fast`;
const TINY = { reserveTokens: 128, keepRecentTokens: 1, contextWindow: 131072 };
const text = (value = "done") => assistant([{ type: "text", text: value }]);
const echoCall = () =>
	assistant([{ type: "toolCall", id: "echo-one", name: "echo", arguments: {} }], "tool_use");
const echo: Tool = {
	name: "echo",
	description: "fake echo",
	parameters: Type.Object({}),
	async execute() {
		return { output: "echo result" };
	},
};
let root: string;
let cwd: string;
let baseDir: string;

beforeEach(() => {
	root = mkTempDir("ink-runner-");
	cwd = path.join(root, "project");
	baseDir = path.join(root, "sessions");
	mkdirSync(cwd);
	vi.stubEnv("INK_LOG", "0");
	vi.stubEnv("INK_AUTOCOMPACT", "0");
	vi.stubEnv("INK_BRANCH_SUMMARY", "1");
	vi.stubEnv("INK_HEALTH", "0");
	vi.stubEnv("INK_CONTEXT_WINDOW", undefined);
	vi.stubEnv("INK_CATALOG_PATH", path.join(root, "catalog.json"));
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("Network forbidden in Fast runner tests");
		}),
	);
	resetCatalogForTest();
	writeFileSync(
		process.env.INK_CATALOG_PATH!,
		JSON.stringify({
			version: 2,
			providers: {
				"openai-codex": {
					source: CODEX_METADATA_SOURCE,
					checkedAt: 1,
					models: Object.fromEntries(
						MODELS.map((id) => [
							id,
							{
								id,
								contextWindow: 500_000,
								maxTokens: 12_345,
								reasoning: true,
								input: ["text", "image"],
								thinkingLevelMap: { off: null, minimal: "low", xhigh: "xhigh", max: "max" },
								cost: { input: 2, output: 8, cacheRead: 1, cacheWrite: 0 },
							},
						]),
					),
				},
			},
		}),
	);
	expect(loadCatalogCache()).toBe(true);
});
afterEach(() => {
	resetCatalogForTest();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

async function runner(scripts: ScriptStep[], options: Partial<RunnerOptions> = {}) {
	const requests: LLMRequest[] = [];
	const live = await createRunner({
		cwd,
		argv: [],
		model: FAST,
		modelExplicit: true,
		maxTokens: 1024,
		maxTurns: 10,
		thinking: "high",
		noContextFiles: true,
		noSession: false,
		sessionBaseDir: baseDir,
		settingsPath: path.join(root, "settings.json"),
		agentsHomeDir: root,
		agentsProjectAllowed: false,
		systemPromptHomeDir: root,
		renderer: makeRenderer().renderer,
		provider: scriptedProvider(scripts, requests, "openai-codex"),
		tools: [echo],
		...options,
	});
	onTestFinished(() => live.close());
	return { live, requests };
}

function saved(speed?: ModelSpeed, modelId = MODEL) {
	const store = createSession(cwd, baseDir);
	store.seedModel({ provider: "openai-codex", modelId, speed });
	const content = "history ".repeat(12_000);
	store.appendMessage(user(content));
	store.appendMessage(
		assistant([{ type: "text", text: content }], "end_turn", {
			inputTokens: 30_000,
			outputTokens: 24_000,
		}),
	);
	store.appendMessage(user(content));
	return store;
}

function expectSummary(request: LLMRequest, speed?: ModelSpeed, modelId = MODEL) {
	expect(request.model).toBe(modelId);
	expect(request.speed).toBe(speed);
	expect(request).not.toHaveProperty("sessionId");
	expect(request.tools).toEqual([]);
}

describe("Fast run snapshots and base identities", () => {
	it("captures loop speed across tool, steering and follow-up requests", async () => {
		const requests: LLMRequest[] = [];
		const steering: AgentMessage[] = [];
		const followUps = [user("follow up")];
		const options: RunAgentLoopOptions = {
			provider: scriptedProvider([echoCall(), text("steered"), text("followed up")], requests),
			model: MODEL,
			modelReference: BASE,
			speed: "fast",
			system: "system",
			tools: [echo],
			history: [],
			userMessage: "start",
			getSteeringMessages: () => steering.splice(0),
			getFollowUpMessages: () => followUps.splice(0),
			onEvent: (event) => {
				if (event.type !== "tool_end") return;
				options.speed = undefined;
				steering.push(user("steer"));
			},
		};
		expect((await runAgentLoop(options)).turns).toBe(3);
		expect(requests.map((request) => request.speed)).toEqual(["fast", "fast", "fast"]);
		expect(requests.map((request) => request.model)).toEqual([MODEL, MODEL, MODEL]);
	});

	it.each([false, true])("captures speed before run_start (initial Fast=%s)", async (isFast) => {
		const extensions = new ExtensionRegistry();
		let switchSelection = () => {};
		extensions.beginExtension("speed-snapshot", "cli");
		extensions.subscribe("run_start", () => switchSelection());
		extensions.commitExtension();
		const { live, requests } = await runner([text()], { model: isFast ? FAST : BASE, extensions });
		switchSelection = () => live.setModel(isFast ? BASE : FAST);
		await live.runTurn({ userMessage: "captured speed" });
		expect(requests[0]?.speed).toBe(isFast ? "fast" : undefined);
		expect(live.speed).toBe(isFast ? undefined : "fast");
		switchSelection = () => {};
		await live.runTurn({ userMessage: "next run uses the new selection" });
		expect(requests[1]?.speed).toBe(isFast ? undefined : "fast");
	});

	it("a mid-tool normal switch changes the next run, not the active follow-up", async () => {
		const { live, requests } = await runner([echoCall(), text()]);
		const thinking = live.thinkingLevel;
		await live.runTurn({
			userMessage: "tool turn",
			onEvent: (event) => {
				if (event.type === "tool_end") live.setModel(BASE);
			},
		});
		expect(requests.map((request) => request.speed)).toEqual(["fast", "fast"]);
		expect(live.speed).toBeUndefined();
		expect(live.thinkingLevel).toBe(thinking);
		await live.runTurn({ userMessage: "normal now" });
		expect(requests[2]).not.toHaveProperty("speed");
	});

	it.each(MODELS)(
		"keeps %s catalog, cost, output limits, provenance and replay base-only",
		async (modelId) => {
			const reference = `openai-codex/${modelId}`;
			const native: AssistantMessage = {
				...assistant([
					{
						type: "thinking",
						thinking: "",
						responses: {
							version: 1,
							provider: "openai-codex",
							itemId: "rs_speed",
							summary: [],
							encryptedContent: "fixture-ciphertext",
						},
					},
				]),
				provenance: { version: 1, provider: "openai-codex", model: modelId },
				model: modelId,
				modelReference: reference,
			};
			const { live, requests } = await runner([native], { noSession: true, model: `${reference}·fast` });
			expect(live.contextWindow).toBe(500_000);
			const cost = costFor(live.modelReference());
			await live.runTurn({ userMessage: "produce native history" });
			live.setModel(reference);
			expect(live.contextWindow).toBe(500_000);
			expect(costFor(live.modelReference())).toEqual(cost);
			await live.runTurn({ userMessage: "normal replay" });
			for (const request of requests) {
				expect(request.model).toBe(modelId);
				expect(request.maxTokens).toBe(12_345);
			}
			expect(requests.map((request) => request.speed)).toEqual(["fast", undefined]);
			const stored = live.history.filter((message) => message.role === "assistant");
			for (const message of stored) {
				expect(message.modelReference).toBe(reference);
				expect(message.model).toBe(modelId);
				expect(message.provenance?.model).toBe(modelId);
			}
			expect(toResponsesInput(requests[1]!.messages, requests[1]!.model)).toContainEqual({
				type: "reasoning",
				id: "rs_speed",
				summary: [],
				encrypted_content: "fixture-ciphertext",
			});
			expect(toResponsesInput(requests[1]!.messages, "different-codex-model")).not.toContainEqual(
				expect.objectContaining({ type: "reasoning", id: "rs_speed" }),
			);
		},
	);

	it.each(MODELS)("a %s Fast failure stays selected and is never retried as normal", async (modelId) => {
		const fastReference = `openai-codex/${modelId}·fast`;
		const rejection = new Error("Fast tier unavailable; choose the normal model explicitly");
		const { live, requests } = await runner(
			[
				() => {
					throw rejection;
				},
			],
			{ model: fastReference },
		);
		await expect(live.runTurn({ userMessage: "try Fast" })).rejects.toBe(rejection);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.speed).toBe("fast");
		expect(live.modelSelectionReference()).toBe(fastReference);
		expect(requests[0]?.model).toBe(modelId);
		expect(SessionStore.open(live.session!.filePath).getModel()).toEqual({
			provider: "openai-codex",
			modelId,
			speed: "fast",
		});
		expect(live.history.filter((message) => message.role === "assistant")).toEqual([]);
		expect(fetch).not.toHaveBeenCalled();
	});

	it.each([false, true])(
		"new children use the live selection while the main loop stays captured (initial Fast=%s)",
		async (isFast) => {
			const taskCall = assistant(
				[
					{
						type: "toolCall",
						id: "task-speed",
						name: "task",
						arguments: { prompt: "child work" },
					},
				],
				"tool_use",
			);
			const { live, requests } = await runner([taskCall, text("child"), text("parent")], {
				model: isFast ? FAST : BASE,
				noSession: true,
			});
			await live.runTurn({
				userMessage: "spawn a child",
				onEvent: (event) => {
					if (
						event.type === "message_end" &&
						event.message.blocks.some((block) => block.type === "toolCall")
					) {
						live.setModel(isFast ? BASE : FAST);
					}
				},
			});
			expect(requests).toHaveLength(3);
			expect(requests.map((request) => request.speed)).toEqual([
				isFast ? "fast" : undefined,
				isFast ? undefined : "fast",
				isFast ? "fast" : undefined,
			]);
		},
	);
});

describe("Fast summaries", () => {
	it.each(MODELS.flatMap((modelId) => ["manual", "automatic"].map((mode) => ({ modelId, mode }))))(
		"$modelId $mode compaction preserves speed and base stamps",
		async ({ modelId, mode }) => {
			const reference = `openai-codex/${modelId}`;
			const store = saved("fast", modelId);
			if (mode === "automatic") {
				vi.stubEnv("INK_AUTOCOMPACT", "1");
				vi.stubEnv("INK_CONTEXT_WINDOW", "60000");
			}
			const { live, requests } = await runner([text("summary"), text("answer")], {
				model: `${reference}·fast`,
				resume: store.header.id,
			});
			if (mode === "manual") expect(await live.compactNow()).toBe("compacted");
			else await live.runTurn({ userMessage: "continue after automatic compaction" });
			expectSummary(requests[0]!, "fast", modelId);
			expect(requests[0]?.thinking).toBe("high");
			expect(requests[0]?.maxTokens).toBe(12_345);
			if (mode === "automatic") expect(requests[1]?.speed).toBe("fast");
			const entries = SessionStore.open(store.filePath)
				.getEntries()
				.filter((entry) => entry.type === "compaction");
			expect(entries).toHaveLength(1);
			expect(entries[0]).toMatchObject({ model: modelId, modelReference: reference });
		},
	);

	it.each([false, true])(
		"overflow recovery keeps captured speed after run_start switches selection (initial Fast=%s)",
		async (isFast) => {
			const store = saved(isFast ? "fast" : undefined);
			const extensions = new ExtensionRegistry();
			let switchSelection = () => {};
			extensions.beginExtension("overflow-speed", "cli");
			extensions.subscribe("run_start", () => switchSelection());
			extensions.commitExtension();
			const { live, requests } = await runner(
				[
					() => {
						throw new Error("context window exceeded");
					},
					text("summary"),
					text("recovered"),
				],
				{ model: isFast ? FAST : BASE, resume: store.header.id, extensions },
			);
			switchSelection = () => live.setModel(isFast ? BASE : FAST);
			expect((await live.runTurn({ userMessage: "recover" })).stopReason).toBe("completed");
			expect(requests).toHaveLength(3);
			expect(requests.map((request) => request.speed)).toEqual(Array(3).fill(isFast ? "fast" : undefined));
			expectSummary(requests[1]!, isFast ? "fast" : undefined);
			expect(live.speed).toBe(isFast ? undefined : "fast");
		},
	);

	it("branch summaries inherit Fast without changing their base usage identity", async () => {
		const store = createSession(cwd, baseDir);
		store.seedModel({ provider: "openai-codex", modelId: MODEL, speed: "fast" });
		const target = store.appendMessage(user("shared trunk"));
		store.appendMessage(text("old answer"));
		store.appendMessage(user("abandoned work"));
		store.appendMessage(text("abandoned answer"));
		const { live, requests } = await runner([text("branch summary")], { resume: store.header.id });
		expect(await live.navigateTree(target, { summarize: true })).toMatchObject({ summary: "written" });
		expect(requests).toHaveLength(1);
		expectSummary(requests[0]!, "fast");
		const summary = live.session!.getEntries().find((entry) => entry.type === "branchSummary");
		expect(summary).toMatchObject({ model: MODEL, modelReference: BASE });
	});

	it.each(["history", "branch"] as const)("%s thinking retry retains Fast on both requests", async (kind) => {
		const requests: LLMRequest[] = [];
		const provider = scriptedProvider(
			[assistant([{ type: "text", text: "half" }], "max_tokens"), text("complete summary")],
			requests,
			"openai-codex",
		);
		const messages = [user("old work ".repeat(50)), text("old answer"), user("retained tail")];
		const common = { messages, provider, model: MODEL, speed: "fast" as const, thinking: "high" as const };
		if (kind === "history") await compactHistory({ ...common, settings: TINY });
		else await summarizeBranchSegment(common);
		expect(requests).toHaveLength(2);
		for (const request of requests) expectSummary(request, "fast");
		expect(requests[0]?.thinking).toBe("high");
		expect(requests[1]?.thinking).not.toBe("high");
	});

	it("a tier rejection cannot trigger a summarizer thinking retry or a normal fallback", async () => {
		const requests: LLMRequest[] = [];
		const rejection = new Error("Fast response reported default processing");
		const provider = scriptedProvider(
			[
				() => {
					throw rejection;
				},
			],
			requests,
			"openai-codex",
		);
		await expect(
			compactHistory({
				messages: [user("old work ".repeat(50)), text("answer"), user("tail")],
				provider,
				model: MODEL,
				speed: "fast",
				thinking: "high",
				settings: TINY,
			}),
		).rejects.toBe(rejection);
		expect(requests).toHaveLength(1);
		expectSummary(requests[0]!, "fast");
	});
});
