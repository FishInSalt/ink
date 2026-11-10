import path from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentDefinition } from "../src/core/agents/registry.js";
import { buildChildLaunch, findChildByLaunch, parseChildLaunch } from "../src/core/child-launch.js";
import { resolveChildModel } from "../src/core/child-model.js";
import { createSession } from "../src/core/session/manager.js";
import { SessionStore } from "../src/core/session/store.js";
import { runSubagent, type SubagentOptions } from "../src/core/subagent.js";
import { createTaskTool, type TaskToolOptions } from "../src/core/tools/task.js";
import type { Tool, ToolExecuteResult } from "../src/core/tools/types.js";
import * as worktree from "../src/core/worktree.js";
import { CodexResponseError } from "../src/provider/responses-errors.js";
import type { LLMProvider, LLMRequest, ModelSpeed } from "../src/provider/types.js";
import { assistant, gate, scriptedProvider, user } from "./helpers/fakes.js";
import { mkTempDir } from "./helpers/mktemp.js";

const MODEL = "gpt-6.1-sol";
const MODELS = [
	MODEL,
	"gpt-5.5",
	"gpt-5.1-codex-mini",
	"custom-future-codex",
	"retired-codex-2025",
	"vendor/custom-codex",
	"glm-custom-codex",
];
const REFERENCE = `openai-codex/${MODEL}`;
const bindingFor = (modelId: string) => ({
	providerName: "openai-codex" as const,
	wireModelId: modelId,
	reference: `openai-codex/${modelId}`,
});
const BINDING = bindingFor(MODEL);
const SYSTEM = "Child Fast propagation fixture";
const environment = () => ({
	inkVersion: "9.9.9",
	systemText: SYSTEM,
	contextFiles: [],
	promptFiles: [],
	extensionContexts: [],
	extensions: [],
});
const signal = () => new AbortController().signal;
const answer = () => assistant([{ type: "text", text: "done" }]);

function launchRecord(speed?: ModelSpeed, modelId = MODEL) {
	return buildChildLaunch({
		parentSessionId: "parent-1",
		childId: "child-1",
		model: bindingFor(modelId),
		...(speed === undefined ? {} : { speed }),
		cwd: "/tmp/ink-fast-child",
		tools: [],
		...environment(),
	});
}

function taskHarness(overrides: Partial<TaskToolOptions> = {}) {
	const dir = mkTempDir("ink-fast-children-");
	const parent = createSession(dir, dir);
	const requests: LLMRequest[] = [];
	const provider = scriptedProvider([answer()], requests, "openai-codex");
	const task = createTaskTool({
		getProvider: () => provider,
		getModel: () => MODEL,
		getModelReference: () => REFERENCE,
		getSystem: () => SYSTEM,
		getTools: () => [],
		getSession: () => parent,
		getLaunchEnvironment: environment,
		getAutoCompact: () => false,
		childSessions: true,
		sessionBaseDir: dir,
		cwd: dir,
		...overrides,
	});
	return { task, requests, parent, dir };
}

function recordedLaunch(parent: SessionStore, result: ToolExecuteResult) {
	const id = result.taskRecord?.childId;
	expect(id).toBeDefined();
	const found = findChildByLaunch(parent, id!);
	if (!found.ok) throw new Error(found.message);
	return found.file.launch;
}

function persistResult(parent: SessionStore, result: ToolExecuteResult) {
	parent.appendMessage({
		role: "toolResult",
		results: [
			{
				toolCallId: "task-1",
				toolName: "task",
				content: result.output,
				isError: result.isError ?? false,
				taskRecord: result.taskRecord,
			},
		],
	});
}

afterEach(() => vi.restoreAllMocks());

describe("Fast child model resolution", () => {
	it.each(MODELS)("inherits %s Fast only without an override, keeping identity base-only", (modelId) => {
		const binding = bindingFor(modelId);
		const parentReference = binding.reference;
		expect(resolveChildModel({ parentReference, parentSpeed: "fast" })).toEqual({
			ok: true,
			binding,
			speed: "fast",
		});
		for (const override of [modelId, parentReference]) {
			expect(resolveChildModel({ parentReference, parentSpeed: "fast", override })).toEqual({
				ok: true,
				binding,
			});
		}
		// An explicit selection of another/custom model is also structural only.
		for (const override of [`${modelId}·fast`, `${parentReference}·fast`]) {
			expect(resolveChildModel({ parentReference: REFERENCE, override })).toEqual({
				ok: true,
				binding,
				speed: "fast",
			});
		}
		expect(resolveChildModel({ parentReference })).toEqual({ ok: true, binding });
	});

	it.each([`${MODEL}·fast`, `${REFERENCE}·fast`, ` OpenAI-Codex / ${MODEL}·fast `])(
		"parses %s on the parent's provider rather than CLI bare-ID routing",
		(override) => {
			expect(resolveChildModel({ parentReference: REFERENCE, override })).toEqual({
				ok: true,
				binding: BINDING,
				speed: "fast",
			});
		},
	);

	it.each([
		{ parentReference: "openai/gpt-6.1-sol", override: `${MODEL}·fast` },
		{ parentReference: "claude-sonnet-4-6", override: `${MODEL}·fast` },
		{ parentReference: REFERENCE, override: "gpt 5.5·fast" },
		{ parentReference: REFERENCE, override: "gpt\t5.5·fast" },
		{ parentReference: REFERENCE, override: "vendor/gpt·other·fast" },
		{ parentReference: REFERENCE, override: "openai-codex/·fast" },
		{ parentReference: REFERENCE, override: `${MODEL}·fast·fast` },
		{ parentReference: REFERENCE, override: `openai/${MODEL}·fast` },
		{ parentReference: "openai/gpt-6.1-sol", parentSpeed: "fast" as const },
		{ parentReference: "openai-codex/gpt other", parentSpeed: "fast" as const },
		{ parentReference: "openai-codex/gpt·other", parentSpeed: "fast" as const },
		{ parentReference: REFERENCE, parentSpeed: "normal" as ModelSpeed },
	])("refuses invalid/cross-provider selection $override on $parentReference", (input) => {
		const resolution = resolveChildModel(input);
		expect(resolution.ok).toBe(false);
		if (!resolution.ok) expect(resolution.error).toMatch(/Fast|Cross-provider/);
	});
});

describe("Fast child launch persistence", () => {
	it.each(MODELS)("round-trips %s speed separately from its binding; old records stay normal", (modelId) => {
		const fast = launchRecord("fast", modelId);
		expect(fast.speed).toBe("fast");
		expect(fast.model).toEqual(bindingFor(modelId));
		expect(fast.model).not.toHaveProperty("speed");
		expect(parseChildLaunch(JSON.parse(JSON.stringify(fast)))).toEqual({ ok: true, launch: fast });
		const old = launchRecord(undefined, modelId);
		expect(old).not.toHaveProperty("speed");
		expect(parseChildLaunch(old)).toEqual({ ok: true, launch: old });
	});

	it.each([null, "normal", "priority", "turbo", 1, false])("rejects invalid recorded speed %s", (speed) => {
		expect(parseChildLaunch({ ...launchRecord(), speed })).toEqual({ ok: false, reason: "invalid" });
	});

	it.each([
		{ providerName: "openai", wireModelId: MODEL, reference: `openai/${MODEL}` },
		{ providerName: "anthropic", wireModelId: MODEL, reference: `anthropic/${MODEL}` },
		{ providerName: "unknown", wireModelId: MODEL, reference: `unknown/${MODEL}` },
		...["", "  ", "gpt other", "gpt\tother", "gpt\u00a0other", "gpt·other", `${MODEL}·fast`].map(bindingFor),
	])("rejects a Fast launch on an invalid provider/base binding $reference", (model) => {
		expect(parseChildLaunch({ ...launchRecord("fast"), model })).toEqual({ ok: false, reason: "invalid" });
	});
});

describe("task dispatch and continuation speed", () => {
	it.each(
		MODELS.flatMap((modelId) => [
			{ modelId, override: undefined, parentSpeed: "fast" as const, expected: "fast" as const },
			{ modelId, override: modelId, parentSpeed: "fast" as const, expected: undefined },
			{ modelId, override: `openai-codex/${modelId}`, parentSpeed: "fast" as const, expected: undefined },
			{ modelId, override: `${modelId}·fast`, parentSpeed: undefined, expected: "fast" as const },
			{
				modelId,
				override: `openai-codex/${modelId}·fast`,
				parentSpeed: undefined,
				expected: "fast" as const,
			},
		]),
	)("dispatch $modelId override=$override, parent=$parentSpeed, child=$expected", async (row) => {
		const agent: AgentDefinition = {
			name: "fixture",
			description: "fixture",
			system: "Fixture agent",
			source: "/tmp/ink-fast-agent.md",
			...(row.override === undefined ? {} : { model: row.override }),
		};
		const binding = bindingFor(row.modelId);
		const { task, requests, parent } = taskHarness({
			getModel: () => row.modelId,
			getModelReference: () => binding.reference,
			getSpeed: () => row.parentSpeed,
			agents: [agent],
		});
		const result = await task.execute({ prompt: "go", agent: agent.name }, signal());
		expect(result.isError).toBe(false);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.model).toBe(row.modelId);
		expect(requests[0]?.speed).toBe(row.expected);
		const launch = recordedLaunch(parent, result);
		expect(launch.speed).toBe(row.expected);
		expect(launch.model).toEqual(binding);
		expect(result.taskRecord?.binding).toEqual(binding);
		if (row.expected === undefined) {
			expect(launch).not.toHaveProperty("speed");
			expect(requests[0]).not.toHaveProperty("speed");
		}
	});

	it.each(MODELS.filter((modelId) => modelId !== MODEL))(
		"an explicit %s Fast override dispatches and records that base, not the parent's base",
		async (modelId) => {
			const binding = bindingFor(modelId);
			const { task, requests, parent } = taskHarness({
				getSpeed: () => "fast",
				agents: [
					{
						name: "other-model",
						description: "Explicit child model",
						source: "/tmp/ink-fast-other-model.md",
						system: "Child model fixture",
						model: `${modelId}·fast`,
					},
				],
			});
			const result = await task.execute({ prompt: "go", agent: "other-model" }, signal());
			expect(result.isError).toBe(false);
			expect(requests).toHaveLength(1);
			expect(requests[0]).toMatchObject({ model: modelId, speed: "fast" });
			expect(recordedLaunch(parent, result)).toMatchObject({ model: binding, speed: "fast" });
			expect(result.taskRecord?.binding).toEqual(binding);
		},
	);

	it("legacy callers without getSpeed dispatch normally", async () => {
		const { task, requests, parent } = taskHarness();
		const result = await task.execute({ prompt: "go" }, signal());
		expect(result.isError).toBe(false);
		expect(requests[0]).not.toHaveProperty("speed");
		expect(recordedLaunch(parent, result)).not.toHaveProperty("speed");
	});

	it("rejects invalid Fast before launch-environment, tool-pool or worktree setup", async () => {
		const getLaunchEnvironment = vi.fn(environment);
		const getTools = vi.fn(() => []);
		const resolveRepo = vi.spyOn(worktree, "resolveRepoState");
		const { task, requests } = taskHarness({
			getLaunchEnvironment,
			getTools,
			agents: [
				{ name: "bad", description: "bad", source: "/tmp/ink-bad.md", system: "bad", model: "gpt 5.5·fast" },
			],
		});
		const result = await task.execute({ prompt: "go", agent: "bad", worktree: true }, signal());
		expect(result.isError).toBe(true);
		expect(result.taskRecord?.launched).toBe(false);
		expect(requests).toHaveLength(0);
		expect(getTools).not.toHaveBeenCalled();
		expect(getLaunchEnvironment).not.toHaveBeenCalled();
		expect(resolveRepo).not.toHaveBeenCalled();
	});

	it("snapshots LIVE provider/model/speed together before asynchronous setup", async () => {
		const entered = gate();
		const release = gate();
		const oldRequests: LLMRequest[] = [];
		const newRequests: LLMRequest[] = [];
		const oldProvider = scriptedProvider([answer()], oldRequests, "openai-codex");
		const newProvider = scriptedProvider([answer()], newRequests, "openai");
		let live = { provider: oldProvider, reference: REFERENCE, speed: undefined as ModelSpeed | undefined };
		const { task, parent, dir } = taskHarness({
			getProvider: () => live.provider,
			getModelReference: () => live.reference,
			getSpeed: () => live.speed,
			getToolsForChild: () => [],
		});
		vi.spyOn(worktree, "resolveRepoState").mockImplementation(async () => {
			entered.resolve();
			await release.promise;
			return { root: dir, cwdRelative: "", head: "a".repeat(40) };
		});
		vi.spyOn(worktree, "createChildWorktree").mockResolvedValue({
			path: dir,
			branch: "ink/task-fast-fixture",
			nodeModulesLinked: false,
		});
		vi.spyOn(worktree, "assessWorktreeRemoval").mockResolvedValue({ verdict: "clean" });
		vi.spyOn(worktree, "removeChildWorktree").mockResolvedValue([]);
		// Changed since tool construction: dispatch must see the LIVE Fast choice.
		live.speed = "fast";
		const pending = task.execute({ prompt: "go", worktree: true }, signal());
		await entered.promise;
		live = { provider: newProvider, reference: "openai/gpt-5.5", speed: undefined };
		release.resolve();
		const result = await pending;
		expect(result.isError).toBe(false);
		expect(oldRequests).toHaveLength(1);
		expect(oldRequests[0]).toMatchObject({ model: MODEL, speed: "fast" });
		expect(newRequests).toHaveLength(0);
		expect(recordedLaunch(parent, result)).toMatchObject({ model: BINDING, speed: "fast" });
		const next = await task.execute({ prompt: "next child" }, signal());
		expect(next.isError).toBe(false);
		expect(newRequests).toHaveLength(1);
		expect(newRequests[0]?.model).toBe("gpt-5.5");
		expect(newRequests[0]).not.toHaveProperty("speed");
	});

	it.each(
		MODELS.flatMap((modelId) => ["fast" as const, undefined].map((recorded) => ({ modelId, recorded }))),
	)(
		"resume keeps $modelId recorded $recorded despite opposite live speed/model",
		async ({ modelId, recorded }) => {
			let speed: ModelSpeed | undefined = recorded;
			let reference = bindingFor(modelId).reference;
			const getSpeed = vi.fn(() => speed);
			const { task, requests, parent } = taskHarness({
				getSpeed,
				getModelReference: () => reference,
			});
			const first = await task.execute({ prompt: "first" }, signal());
			const launch = recordedLaunch(parent, first);
			expect(launch.model).toEqual(bindingFor(modelId));
			persistResult(parent, first);
			speed = recorded === "fast" ? undefined : "fast";
			reference = "openai-codex/a-different-future-codex";
			getSpeed.mockClear();
			const resumed = await task.execute({ resume: launch.childId, prompt: "continue" }, signal());
			expect(resumed.isError).toBe(false);
			expect(requests).toHaveLength(2);
			expect(requests[1]?.speed).toBe(recorded);
			expect(requests[1]?.model).toBe(modelId);
			expect(recordedLaunch(parent, resumed)).toEqual(launch);
			expect(getSpeed).not.toHaveBeenCalled();
		},
	);

	it("keeps Fast on tool follow-ups and base-only identity on persisted assistant messages", async () => {
		const requests: LLMRequest[] = [];
		const provider = scriptedProvider(
			[assistant([{ type: "toolCall", id: "c1", name: "unused", arguments: {} }], "tool_use"), answer()],
			requests,
			"openai-codex",
		);
		const { task, parent } = taskHarness({
			getProvider: () => provider,
			getSpeed: () => "fast",
			getTools: () => [sentinelTool],
		});
		const result = await task.execute({ prompt: "go" }, signal());
		expect(result.isError).toBe(false);
		expect(requests).toHaveLength(2);
		expect(requests.every((request) => request.model === MODEL && request.speed === "fast")).toBe(true);
		const found = findChildByLaunch(parent, recordedLaunch(parent, result).childId);
		if (!found.ok) throw new Error(found.message);
		const messages = found.file.store
			.buildContext()
			.messages.filter((message) => message.role === "assistant");
		expect(messages).toHaveLength(2);
		expect(messages.every((message) => message.modelReference === REFERENCE)).toBe(true);
	});

	it("concurrent Fast and explicit normal children do not share mutable provider speed", async () => {
		const { task, requests, parent } = taskHarness({
			getSpeed: () => "fast",
			agents: [
				{
					name: "normal",
					description: "normal",
					source: "/tmp/ink-normal.md",
					system: "normal",
					model: MODEL,
				},
			],
		});
		const [fast, normal] = await Promise.all([
			task.execute({ prompt: "Fast child" }, signal()),
			task.execute({ prompt: "Normal child", agent: "normal" }, signal()),
		]);
		expect(fast.isError).toBe(false);
		expect(normal.isError).toBe(false);
		expect(requests).toHaveLength(2);
		expect(requests.map((request) => request.speed)).toEqual(["fast", undefined]);
		expect(recordedLaunch(parent, fast).speed).toBe("fast");
		expect(recordedLaunch(parent, normal)).not.toHaveProperty("speed");
	});

	it.each(MODELS)("a %s Fast failure never starts a normal child or summary fallback", async (modelId) => {
		const requests: LLMRequest[] = [];
		const provider = scriptedProvider(
			[
				() => {
					throw new Error("Fast tier unavailable; choose normal explicitly");
				},
			],
			requests,
			"openai-codex",
		);
		const { task, parent } = taskHarness({
			getProvider: () => provider,
			getModel: () => modelId,
			getModelReference: () => bindingFor(modelId).reference,
			getSpeed: () => "fast",
		});
		const result = await task.execute({ prompt: "go" }, signal());
		expect(result.isError).toBe(true);
		expect(result.output).toContain("Fast tier unavailable");
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({ model: modelId, speed: "fast" });
		expect(recordedLaunch(parent, result)).toMatchObject({ model: bindingFor(modelId), speed: "fast" });
	});
});

const sentinelTool: Tool = {
	name: "unused",
	description: "Distinguishes child task requests from summarizer requests",
	parameters: Type.Object({}),
	async execute() {
		return { output: "unused" };
	},
};

describe("Fast child compaction and retries", () => {
	it.each(
		[false, true].flatMap((persisted) =>
			[false, true].flatMap((overflow) =>
				["service_tier_downgrade", "unsupported_parameter", "context_length_exceeded"].map((code) => ({
					persisted,
					overflow,
					code,
				})),
			),
		),
	)(
		"surfaces $code in persisted=$persisted overflow=$overflow without continuing",
		async ({ persisted, overflow, code }) => {
			const dir = mkTempDir("ink-fast-child-summary-");
			const session = persisted ? SessionStore.create(path.join(dir, "child.jsonl"), dir) : undefined;
			const history = [
				user(`old task ${"x".repeat(6000)}`),
				assistant([{ type: "text", text: "old answer" }], "end_turn", { inputTokens: 6000, outputTokens: 5 }),
			];
			for (const message of history) session?.appendMessage(message);
			const taskRequests: LLMRequest[] = [];
			const summaries: LLMRequest[] = [];
			const diagnostic = "Fast request rejected; use /model to explicitly select the normal model";
			const provider: LLMProvider = {
				name: "openai-codex",
				async *stream(request) {
					if (request.tools.length === 0) {
						summaries.push(request);
						if (summaries.length > 1) {
							// A mistaken recovery would succeed and conceal the first failure.
							yield { type: "message_end", message: answer() };
							return;
						}
						throw new CodexResponseError(diagnostic, { code, status: 400, param: "service_tier" });
					}
					taskRequests.push(request);
					if (overflow && taskRequests.length === 1) throw new Error("context length exceeded");
					yield { type: "message_end", message: answer() };
				},
			};
			const outcome = await runSubagent({
				provider,
				model: MODEL,
				modelReference: REFERENCE,
				speed: "fast",
				thinking: "high",
				system: SYSTEM,
				tools: [sentinelTool],
				prompt: "continue",
				initialHistory: history,
				autoCompact: !overflow,
				settings: { reserveTokens: 200, keepRecentTokens: 1, contextWindow: 1200 },
				...(session === undefined ? {} : { session, onMessage: (message) => session.appendMessage(message) }),
			});
			expect(outcome.status).toBe("crash");
			expect(outcome.reason).toBe(diagnostic);
			expect(summaries).toHaveLength(1);
			expect(summaries[0]?.speed).toBe("fast");
			expect(taskRequests).toHaveLength(overflow ? 1 : 0);
			expect(taskRequests.every((request) => request.speed === "fast")).toBe(true);
			if (session !== undefined) {
				expect(session.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
				expect(
					session.buildContext().messages.filter((message) => message.role === "assistant"),
				).toHaveLength(1);
			}
		},
	);

	it.each([
		{ persisted: false, overflow: false },
		{ persisted: true, overflow: false },
		{ persisted: false, overflow: true },
		{ persisted: true, overflow: true },
	])(
		"same speed in persisted=$persisted overflow=$overflow and thinking retry",
		async ({ persisted, overflow }) => {
			const dir = mkTempDir("ink-fast-child-summary-");
			const session = persisted ? SessionStore.create(path.join(dir, "child.jsonl"), dir) : undefined;
			const history = [
				user(`old task ${"x".repeat(6000)}`),
				assistant([{ type: "text", text: "old answer" }], "end_turn", { inputTokens: 6000, outputTokens: 5 }),
			];
			for (const message of history) session?.appendMessage(message);
			const taskRequests: LLMRequest[] = [];
			const summaryRequests: LLMRequest[] = [];
			const provider: LLMProvider = {
				name: "openai-codex",
				async *stream(request) {
					if (request.tools.length === 0) {
						summaryRequests.push(request);
						// A capped first summary retries at lower thinking, never normal speed.
						yield {
							type: "message_end",
							message: assistant(
								[{ type: "text", text: "SUMMARY" }],
								summaryRequests.length === 1 ? "max_tokens" : "end_turn",
							),
						};
						return;
					}
					taskRequests.push(request);
					if (overflow && taskRequests.length === 1) {
						// Even mutation of a caller-owned options object cannot change the retry.
						options.speed = undefined;
						throw new Error("context length exceeded");
					}
					yield { type: "message_end", message: answer() };
				},
			};
			const options: SubagentOptions = {
				provider,
				model: MODEL,
				modelReference: REFERENCE,
				speed: "fast",
				thinking: "high",
				system: SYSTEM,
				tools: [sentinelTool],
				prompt: "continue",
				initialHistory: history,
				autoCompact: !overflow,
				settings: { reserveTokens: 200, keepRecentTokens: 1, contextWindow: 1200 },
				...(session === undefined
					? {}
					: {
							session,
							onMessage: (message) => {
								session.appendMessage(message);
							},
						}),
			};
			const outcome = await runSubagent(options);
			expect(outcome, outcome.reason).toMatchObject({ status: "completed" });
			expect(taskRequests).toHaveLength(overflow ? 2 : 1);
			expect(summaryRequests).toHaveLength(2);
			for (const request of [...taskRequests, ...summaryRequests]) {
				expect(request.model).toBe(MODEL);
				expect(request.speed).toBe("fast");
			}
			expect(taskRequests.every((request) => request.thinking === "high")).toBe(true);
			expect(summaryRequests.map((request) => request.thinking)).toEqual(["high", "minimal"]);
			expect(summaryRequests.every((request) => request.sessionId === undefined)).toBe(true);
			expect(taskRequests.at(-1)?.messages[0]).toMatchObject({
				role: "user",
				content: expect.stringContaining("SUMMARY"),
			});
			if (session !== undefined) {
				expect(session.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
			}
		},
	);
});
