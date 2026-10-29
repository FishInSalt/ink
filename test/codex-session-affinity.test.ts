import { mkdirSync } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import * as compaction from "../src/core/compaction.js";
import { type RunAgentLoopOptions, runAgentLoop } from "../src/core/loop.js";
import type { AgentMessage } from "../src/core/messages.js";
import { createChildSession, createSession } from "../src/core/session/manager.js";
import { SessionStore } from "../src/core/session/store.js";
import { runSubagent } from "../src/core/subagent.js";
import type { Tool } from "../src/core/tools/types.js";
import { ExtensionRegistry } from "../src/extensions/registry.js";
import * as providerResolution from "../src/provider/resolve.js";
import type { LLMProvider, LLMRequest } from "../src/provider/types.js";
import { createRunner, type RunnerOptions } from "../src/runner.js";
import { assistant, makeRenderer, scriptedProvider, user } from "./helpers/fakes.js";
import { mkTempDir } from "./helpers/mktemp.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TINY = { reserveTokens: 16, keepRecentTokens: 1, contextWindow: 131072 };
const text = (value = "done") => assistant([{ type: "text", text: value }]);
const echoCall = (id: string) =>
	assistant([{ type: "toolCall", id, name: "echo", arguments: { message: id } }], "tool_use");
const taskCall = (id: string) =>
	assistant([{ type: "toolCall", id, name: "task", arguments: { prompt: id } }], "tool_use");
const overflow = () => {
	throw new Error("context window exceeded");
};
const echo: Tool = {
	name: "echo",
	description: "fake echo",
	parameters: Type.Object({ message: Type.String() }),
	async execute(args) {
		return { output: String(args.message) };
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
	vi.stubEnv("INK_CHILD_SESSIONS", "1");
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("Network forbidden in session affinity tests");
		}),
	);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

async function runner(provider: LLMProvider, options: Partial<RunnerOptions> = {}) {
	const live = await createRunner({
		cwd,
		argv: [],
		model: "anthropic/affinity-model",
		maxTokens: 1024,
		maxTurns: 10,
		noContextFiles: true,
		noSession: false,
		sessionBaseDir: baseDir,
		settingsPath: path.join(root, "settings.json"),
		agentsHomeDir: root,
		agentsProjectAllowed: false,
		systemPromptHomeDir: root,
		renderer: makeRenderer().renderer,
		provider,
		tools: [echo],
		...options,
	});
	onTestFinished(() => live.close());
	return live;
}

function saved(large = false) {
	const store = createSession(cwd, baseDir);
	const content = large ? "context ".repeat(6000) : "old work";
	store.appendMessage(user(content));
	store.appendMessage(text(content));
	store.appendMessage(user(content));
	return store;
}

function expectNoKey(request: LLMRequest | undefined) {
	expect(request).toBeDefined();
	expect(request).not.toHaveProperty("sessionId");
}

describe("loop session identity", () => {
	it("captures the optional identity for tool, steering and follow-up turns", async () => {
		const requests: LLMRequest[] = [];
		const steering: AgentMessage[] = [];
		const followUps = [user("follow up")];
		const options: RunAgentLoopOptions = {
			provider: scriptedProvider([echoCall("one"), text("steered"), text("followed up")], requests),
			model: "affinity-model",
			sessionId: "conversation-会話\r\nfull-id",
			system: "test system",
			tools: [echo],
			history: [],
			userMessage: "start",
			getSteeringMessages: () => steering.splice(0),
			getFollowUpMessages: () => followUps.splice(0),
			onEvent: (event) => {
				if (event.type !== "tool_end") return;
				steering.push(user("steer"));
				options.sessionId = "changed after launch";
			},
		};
		const result = await runAgentLoop(options);
		expect(result).toMatchObject({ stopReason: "completed", turns: 3 });
		expect(requests.map((request) => request.sessionId)).toEqual(
			Array(3).fill("conversation-会話\r\nfull-id"),
		);
		expect(requests[1]?.messages).toContainEqual(user("steer"));
		expect(requests[2]?.messages).toContainEqual(user("follow up"));
	});

	it("keeps existing direct callers without an identity optional", async () => {
		const requests: LLMRequest[] = [];
		const result = await runAgentLoop({
			provider: scriptedProvider([text()], requests),
			model: "affinity-model",
			system: "",
			tools: [],
			history: [],
			userMessage: "go",
		});
		expect(result.stopReason).toBe("completed");
		expect(requests).toHaveLength(1);
		expect(requests[0]?.sessionId).toBeUndefined();
	});
});

describe("runner conversation affinity", () => {
	it("uses the store header across runs, replaces it on /new, and restores it on /resume", async () => {
		const requests: LLMRequest[] = [];
		const live = await runner(scriptedProvider([text()], requests));
		const originalId = live.session!.header.id;
		await live.runTurn({ userMessage: "first" });
		await live.runTurn({ userMessage: "second" });
		live.newSession();
		const newId = live.session!.header.id;
		expect(newId).not.toBe(originalId);
		await live.runTurn({ userMessage: "new conversation" });
		live.resumeSession(originalId);
		await live.runTurn({ userMessage: "resumed" });
		expect(requests.map((request) => request.sessionId)).toEqual([originalId, originalId, newId, originalId]);
	});

	it.each(["resume", "continueRecent"] as const)(
		"restores the saved identity at startup via %s",
		async (mode) => {
			const store = saved();
			const requests: LLMRequest[] = [];
			const live = await runner(scriptedProvider([text()], requests), {
				...(mode === "resume" ? { resume: store.header.id } : { continueRecent: true }),
			});
			expect(live.session!.header.id).toBe(store.header.id);
			await live.runTurn({ userMessage: "continue" });
			expect(requests.map((request) => request.sessionId)).toEqual([store.header.id]);
		},
	);

	it("allocates one ephemeral UUID per no-session conversation, replaced only by /new", async () => {
		const requests: LLMRequest[] = [];
		const live = await runner(scriptedProvider([text()], requests), { noSession: true });
		await live.runTurn({ userMessage: "first" });
		await live.runTurn({ userMessage: "second" });
		const originalId = requests[0]?.sessionId;
		expect(originalId).toMatch(UUID);
		expect(requests[1]?.sessionId).toBe(originalId);
		live.newSession();
		await live.runTurn({ userMessage: "new" });
		await live.runTurn({ userMessage: "same new conversation" });
		const newId = requests[2]?.sessionId;
		expect(newId).toMatch(UUID);
		expect(newId).not.toBe(originalId);
		expect(requests[3]?.sessionId).toBe(newId);
		expect(live.session).toBeNull();
		const other = await runner(scriptedProvider([text()], requests), { noSession: true });
		await other.runTurn({ userMessage: "independent conversation" });
		expect(requests[4]?.sessionId).toMatch(UUID);
		expect(new Set(requests.map((request) => request.sessionId)).size).toBe(3);
	});

	it.each(["new", "resume", "no-session new"] as const)(
		"keeps the active run's snapshot when %s changes the live conversation",
		async (mode) => {
			const target = saved();
			const requests: LLMRequest[] = [];
			const live = await runner(scriptedProvider([echoCall("switch"), text()], requests), {
				noSession: mode === "no-session new",
			});
			const originalId = live.session?.header.id;
			await live.runTurn({
				userMessage: "switch while working",
				onEvent: (event) => {
					if (event.type !== "tool_end") return;
					if (mode === "resume") live.resumeSession(target.header.id);
					else live.newSession();
				},
			});
			const capturedId = originalId ?? requests[0]?.sessionId;
			expect(capturedId).toMatch(UUID);
			expect(requests.map((request) => request.sessionId)).toEqual([capturedId, capturedId]);
			await live.runTurn({ userMessage: "next run" });
			expect(requests[2]?.sessionId).toMatch(UUID);
			expect(requests[2]?.sessionId).not.toBe(capturedId);
			if (live.session) expect(requests[2]?.sessionId).toBe(live.session.header.id);
		},
	);

	it.each(["new", "resume"] as const)(
		"keeps the overflow retry identity when /%s happens during the unkeyed summary",
		async (mode) => {
			const store = saved(true);
			const target = saved();
			const requests: LLMRequest[] = [];
			const live = await runner(
				scriptedProvider(
					[
						overflow,
						() => {
							if (mode === "resume") live.resumeSession(target.header.id);
							else live.newSession();
							return text("summary of old work");
						},
						text("recovered"),
					],
					requests,
				),
				{ resume: store.header.id },
			);
			const result = await live.runTurn({ userMessage: "continue" });
			expect(result.stopReason).toBe("completed");
			expect(requests).toHaveLength(3);
			expect(requests[0]?.sessionId).toBe(store.header.id);
			expectNoKey(requests[1]);
			expect(requests[2]?.sessionId).toBe(store.header.id);
			await live.runTurn({ userMessage: "next run" });
			expect(requests[3]?.sessionId).toBe(live.session!.header.id);
			expect(requests[3]?.sessionId).not.toBe(store.header.id);
		},
	);

	it.each(["run_start", "tool_end"] as const)(
		"keeps the entry-time run context through overflow recovery after a model switch at %s",
		async (switchAt) => {
			vi.stubEnv("INK_AUTOCOMPACT", "1");
			vi.stubEnv("INK_CONTEXT_WINDOW", "1000000");
			const store = saved(true);
			const requests: LLMRequest[] = [];
			const replacementRequests: LLMRequest[] = [];
			const extensions = new ExtensionRegistry();
			const switchModel = () => {
				vi.stubEnv("INK_CONTEXT_WINDOW", "100");
				live.setModel("openai/gpt-5.2");
			};
			extensions.beginExtension("snapshot-probe", "cli");
			if (switchAt === "run_start") extensions.subscribe("run_start", switchModel);
			extensions.commitExtension();
			const live = await runner(
				scriptedProvider(
					[echoCall("before-switch"), overflow, text("summary"), text("recovered")],
					requests,
					"injected-provider-not-a-family",
				),
				{ resume: store.header.id, extensions },
			);
			const session = live.session!;
			const initialEntryCount = session.getEntries().length;
			const compact = vi.spyOn(compaction, "compactSession"); // delegate to real compaction
			const factory = vi
				.spyOn(providerResolution, "createProviderFor")
				.mockReturnValue(scriptedProvider([text("replacement")], replacementRequests));
			const result = await live.runTurn({
				userMessage: "continue with the original model",
				onEvent: (event) => {
					if (switchAt === "tool_end" && event.type === "tool_end") switchModel();
				},
			});

			expect(result.stopReason).toBe("completed");
			expect(factory).toHaveBeenCalledExactlyOnceWith("openai");
			expect(live.modelReference()).toBe("openai/gpt-5.2");
			expect(live.contextWindow).toBe(100);
			expect(replacementRequests).toHaveLength(0);
			expect(requests.map((request) => request.model)).toEqual(Array(4).fill("affinity-model"));
			expect(requests.map((request) => request.sessionId)).toEqual([
				store.header.id,
				store.header.id,
				undefined,
				store.header.id,
			]);
			expectNoKey(requests[2]);
			// The tiny live window must not cause an extra pre-turn compaction.
			expect(compact).toHaveBeenCalledTimes(1);
			const summary = compact.mock.calls[0]![0];
			expect(summary.session).toBe(session);
			expect(summary.provider.name).toBe("injected-provider-not-a-family");
			expect(summary).toMatchObject({
				model: "affinity-model",
				modelReference: "anthropic/affinity-model",
				settings: { contextWindow: 1000000, triggerTokens: 850000 },
			});
			const entries = session.getEntries().slice(initialEntryCount);
			expect(entries.filter((entry) => entry.type === "compaction")).toMatchObject([
				{ model: "affinity-model", modelReference: "anthropic/affinity-model" },
			]);
			expect(
				entries.flatMap((entry) =>
					entry.type === "message" && entry.message.role === "assistant"
						? [entry.message.modelReference]
						: [],
				),
			).toEqual(["anthropic/affinity-model", "anthropic/affinity-model"]);
		},
	);

	it("leaves manual compaction on the direct unkeyed summary path", async () => {
		const store = saved(true);
		const requests: LLMRequest[] = [];
		const live = await runner(scriptedProvider([text("summary")], requests), { resume: store.header.id });
		expect(await live.compactNow()).toBe("compacted");
		expect(requests).toHaveLength(1);
		expectNoKey(requests[0]);
	});

	it("leaves branch summaries on the direct unkeyed path", async () => {
		const store = saved();
		const targetId = store.appendMessage(text("branch point"));
		store.appendMessage(user("abandoned work"));
		store.appendMessage(text("abandoned answer"));
		const requests: LLMRequest[] = [];
		const live = await runner(scriptedProvider([text("branch summary")], requests), {
			resume: store.header.id,
		});
		expect(await live.navigateTree(targetId, { summarize: true })).toMatchObject({ summary: "written" });
		expect(requests).toHaveLength(1);
		expectNoKey(requests[0]);
	});
});

describe("child conversation affinity", () => {
	it.each(["persisted", "disabled", "no-session"] as const)(
		"separates parent and sibling identities with %s child transcripts",
		async (mode) => {
			vi.stubEnv("INK_CHILD_SESSIONS", mode === "disabled" ? "0" : "1");
			const requests: LLMRequest[] = [];
			const live = await runner(
				scriptedProvider(
					[
						taskCall("child-one"),
						echoCall("child-tool"),
						text("first child"),
						taskCall("child-two"),
						text("second child"),
						text("parent done"),
					],
					requests,
				),
				{ noSession: mode === "no-session" },
			);
			expect((await live.runTurn({ userMessage: "delegate twice" })).stopReason).toBe("completed");
			expect(requests).toHaveLength(6);
			const parentId = live.session?.header.id ?? requests[0]?.sessionId;
			const firstChildId = requests[1]?.sessionId;
			const secondChildId = requests[4]?.sessionId;
			expect(parentId).toMatch(UUID);
			expect(firstChildId).toMatch(UUID);
			expect(secondChildId).toMatch(UUID);
			expect(requests.map((request) => request.sessionId)).toEqual([
				parentId,
				firstChildId,
				firstChildId,
				parentId,
				secondChildId,
				parentId,
			]);
			expect(new Set([parentId, firstChildId, secondChildId]).size).toBe(3);
			const records = live.history.flatMap((message) =>
				message.role === "toolResult"
					? message.results.flatMap((result) => (result.taskRecord ? [result.taskRecord] : []))
					: [],
			);
			expect(records).toHaveLength(2);
			expect(records.map((record) => record.childId)).toEqual(
				mode === "persisted" ? [firstChildId, secondChildId] : [undefined, undefined],
			);
		},
	);

	it("restores a child's own store identity from disk rather than its parent's", async () => {
		const parent = saved();
		const child = createChildSession(parent, baseDir);
		const requests: LLMRequest[] = [];
		const provider = scriptedProvider([text("child answer")], requests);
		const options = {
			provider,
			model: "affinity-model",
			system: "parent system",
			tools: [],
			autoCompact: false,
		};
		expect(
			(
				await runSubagent({
					...options,
					prompt: "initial child instruction",
					session: child,
					onMessage: (message) => {
						child.appendMessage(message);
					},
				})
			).status,
		).toBe("completed");
		const restored = SessionStore.open(child.filePath);
		expect(
			(
				await runSubagent({
					...options,
					prompt: "resumed child instruction",
					session: restored,
					initialHistory: restored.buildContext().messages,
					onMessage: (message) => {
						restored.appendMessage(message);
					},
				})
			).status,
		).toBe("completed");
		expect(requests.map((request) => request.sessionId)).toEqual([child.header.id, child.header.id]);
		expect(child.header.id).not.toBe(parent.header.id);
		expect(requests[1]?.messages).toContainEqual(user("initial child instruction"));
	});

	it.each([true, false])("keeps child identity across overflow retries; persisted=%s", async (persisted) => {
		const parent = saved();
		const child = persisted ? createChildSession(parent, baseDir) : undefined;
		const requests: LLMRequest[] = [];
		const provider = scriptedProvider(
			[echoCall("before-overflow"), overflow, text("summary"), echoCall("after-overflow"), text("recovered")],
			requests,
		);
		const outcome = await runSubagent({
			provider,
			model: "affinity-model",
			system: "parent system",
			tools: [echo],
			prompt: "child instruction",
			autoCompact: false,
			settings: TINY,
			session: child,
			onMessage: child
				? (message) => {
						child.appendMessage(message);
					}
				: undefined,
		});
		expect(outcome.status).toBe("completed");
		expect(requests).toHaveLength(5);
		const childId = child?.header.id ?? requests[0]?.sessionId;
		expect(childId).toMatch(UUID);
		expect(childId).not.toBe(parent.header.id);
		expect(requests.map((request) => request.sessionId)).toEqual([
			childId,
			childId,
			undefined,
			childId,
			childId,
		]);
		expectNoKey(requests[2]);
		if (!persisted) {
			expect(
				(
					await runSubagent({
						provider,
						model: "affinity-model",
						system: "",
						tools: [],
						prompt: "next invocation",
					})
				).status,
			).toBe("completed");
			expect(requests[5]?.sessionId).toMatch(UUID);
			expect(requests[5]?.sessionId).not.toBe(childId);
		}
	});
});
