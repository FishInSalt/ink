import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findChildByLaunch } from "../src/core/child-launch.js";
import { estimateContextTokens, findCutIndex, shouldCompact } from "../src/core/compaction.js";
import type { AssistantMessage } from "../src/core/messages.js";
import { createSession } from "../src/core/session/manager.js";
import { findOrphanChildren } from "../src/core/session/prune.js";
import { SessionStore } from "../src/core/session/store.js";
import { collectTaskRecords, type TaskRecord } from "../src/core/task-record.js";
import type { ToolExecuteResult } from "../src/core/tools/types.js";
import { ExtensionRegistry } from "../src/extensions/registry.js";
import { compactionSettingsFor } from "../src/provider/compaction-settings.js";
import * as providerResolution from "../src/provider/resolve.js";
import type { LLMProvider, LLMRequest } from "../src/provider/types.js";
import { createRunner, type Runner, type RunnerOptions } from "../src/runner.js";
import { assistant, type Gate, gate, makeRenderer, user, waitUntil } from "./helpers/fakes.js";
import { mkTempDir } from "./helpers/mktemp.js";

const text = (value = "done") => assistant([{ type: "text", text: value }]);
const records = (store: SessionStore) => collectTaskRecords(store.getEntries());
const kindOf = (request: LLMRequest) =>
	request.system.startsWith("You are a context summarization assistant.")
		? "summary"
		: request.system.includes("# Subagent mode")
			? "child"
			: "parent";
type Kind = ReturnType<typeof kindOf>;
const lastUser = (request: LLMRequest) => {
	const message = request.messages.findLast((message) => message.role === "user");
	return message?.role === "user" && typeof message.content === "string" ? message.content : "";
};

let root: string;
let cwd: string;
let baseDir: string;
let holds: Gate[];
let pending: Promise<unknown>[];
let runners: Runner[];
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
	root = mkTempDir("ink-runner-");
	cwd = path.join(root, "project");
	baseDir = path.join(root, "sessions");
	mkdirSync(cwd);
	writeFileSync(path.join(root, "settings.json"), JSON.stringify({ autoCompact: true }));
	holds = [];
	pending = [];
	runners = [];
	vi.stubEnv("INK_LOG", "0");
	vi.stubEnv("INK_HEALTH", "0");
	vi.stubEnv("INK_AUTOCOMPACT", "0");
	vi.stubEnv("INK_CONTEXT_WINDOW", "40000");
	vi.stubEnv("INK_CHILD_SESSIONS", "1");
	vi.stubEnv("INK_CATALOG_PATH", path.join(root, "absent-catalog.json"));
	fetchSpy = vi.fn(() => {
		throw new Error("Network forbidden in task ownership tests");
	});
	vi.stubGlobal("fetch", fetchSpy);
});

afterEach(async () => {
	for (const hold of holds) hold.resolve();
	await Promise.allSettled(pending);
	for (const runner of runners) runner.close();
	try {
		expect(fetchSpy).not.toHaveBeenCalled();
	} finally {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	}
});

function tracked<T>(promise: Promise<T>): Promise<T> {
	pending.push(promise);
	void promise.catch(() => {});
	return promise;
}

function latch() {
	const entered = gate();
	const release = gate();
	holds.push(release);
	let calls = 0;
	return {
		entered,
		release,
		async wait() {
			calls++;
			entered.resolve();
			await release.promise;
		},
		async reached() {
			await waitUntil(() => calls > 0);
		},
	};
}

function providerFixture(
	options: {
		name?: string;
		intercept?: (
			request: LLMRequest,
			kind: Kind,
		) => AssistantMessage | null | undefined | Promise<AssistantMessage | null | undefined>;
		taskArgs?: (prompt: string) => Record<string, unknown>;
	} = {},
) {
	const requests: LLMRequest[] = [];
	const turns = new Map<string, number>();
	const provider: LLMProvider = {
		name: options.name ?? "anthropic",
		async *stream(request) {
			requests.push({ ...request, messages: [...request.messages] });
			const kind = kindOf(request);
			const override = await options.intercept?.(request, kind);
			let message: AssistantMessage;
			if (override === null) return;
			if (override !== undefined) message = override;
			else if (kind === "summary") message = text("accepted summary");
			else if (kind === "child") message = text(`child answer: ${lastUser(request)}`);
			else {
				const prompt = lastUser(request);
				const key = `${request.sessionId}:${prompt}`;
				const turn = (turns.get(key) ?? 0) + 1;
				turns.set(key, turn);
				message =
					turn === 1
						? assistant(
								[
									{
										type: "toolCall",
										id: `task-${requests.length}`,
										name: "task",
										arguments: options.taskArgs?.(prompt) ?? { prompt: `child:${prompt}` },
									},
								],
								"tool_use",
							)
						: text("parent finished");
			}
			yield { type: "message_end", message };
		},
	};
	return { provider, requests };
}

async function makeRunner(provider: LLMProvider, options: Partial<RunnerOptions> = {}) {
	const runner = await createRunner({
		cwd,
		argv: [],
		model: "anthropic/test-model",
		maxTokens: 100,
		maxTurns: 8,
		noContextFiles: true,
		noSession: false,
		sessionBaseDir: baseDir,
		settingsPath: path.join(root, "settings.json"),
		agentsHomeDir: root,
		systemPromptHomeDir: root,
		agentsProjectAllowed: false,
		tools: [],
		renderer: makeRenderer().renderer,
		provider,
		...options,
	});
	runners.push(runner);
	return runner;
}

function seedLarge(runner: Runner) {
	const messages = [user("older work ".repeat(100)), text("older reply"), user("tail ".repeat(20000))];
	for (const message of messages) {
		runner.session!.appendMessage(message);
		runner.history.push(message);
	}
	const input = [...runner.history, user("main")];
	const settings = compactionSettingsFor("anthropic/test-model");
	expect(shouldCompact(estimateContextTokens(input).tokens, settings)).toBe(true);
	expect(findCutIndex(input, settings.keepRecentTokens, "anthropic/test-model")).toBeGreaterThan(0);
}

function switchSession(runner: Runner, mode: "new" | "resume") {
	if (mode === "new") runner.newSession();
	else {
		const target = createSession(cwd, baseDir);
		target.appendMessage(user("unrelated B"));
		runner.resumeSession(target.header.id);
	}
	return runner.session!;
}

function owned(parent: SessionStore, record: TaskRecord | undefined) {
	expect(record?.parentSessionId).toBe(parent.header.id);
	expect(record?.childId).toBeDefined();
	if (!record?.transcript?.present || !record.childId) throw new Error("Expected a persisted child");
	const child = SessionStore.open(record.transcript.path);
	expect(child.header.parent).toBe(parent.header.id);
	expect(child.header.launch?.parentSessionId).toBe(parent.header.id);
	expect(findChildByLaunch(parent, record.childId).ok).toBe(true);
	expect(findOrphanChildren(baseDir).map((entry) => entry.file)).not.toContain(child.filePath);
	return child;
}

function task(runner: Runner) {
	return runner.tools.find((tool) => tool.name === "task")!;
}

const matrix = (["automatic", "overflow"] as const).flatMap((seam) =>
	(["new", "resume"] as const).flatMap((mode) =>
		(["fresh", "resume"] as const).map((dispatch) => ({ seam, mode, dispatch })),
	),
);

describe("run-owned task persistence", () => {
	it.each(matrix)(
		"$seam /$mode dispatch=$dispatch keeps ownership and next B",
		async ({ seam, mode, dispatch }) => {
			const summary = latch();
			let overflowed = false;
			let childId: string | undefined;
			const fixture = providerFixture({
				async intercept(request, kind) {
					if (kind === "summary") await summary.wait();
					if (kind === "parent" && lastUser(request) === "main" && seam === "overflow" && !overflowed) {
						overflowed = true;
						throw new Error("context window exceeded");
					}
					return undefined;
				},
				taskArgs: (prompt) =>
					(prompt === "main" && dispatch === "resume") || prompt === "foreign"
						? { prompt: `child:${prompt}`, resume: childId }
						: { prompt: `child:${prompt}` },
			});
			const runner = await makeRunner(fixture.provider);
			const origin = runner.session!;
			if (dispatch === "resume") {
				await runner.runTurn({ userMessage: "seed child" });
				childId = records(origin)[0]!.childId;
			}
			seedLarge(runner);
			if (seam === "automatic") vi.stubEnv("INK_AUTOCOMPACT", "1");
			// The auto-compaction policy is read at Runner construction.
			// Resume the seeded A in a fresh host to exercise its actual auto hook.
			const activeRunner =
				seam === "automatic" ? await makeRunner(fixture.provider, { resume: origin.header.id }) : runner;
			const owner = activeRunner.session!;
			const publicHistory = activeRunner.history;
			const turn = tracked(activeRunner.runTurn({ userMessage: "main" }));
			await summary.reached();
			const replacement = switchSession(activeRunner, mode);
			const entries = [...replacement.getEntries()];
			const context = replacement.buildContext();
			const leaf = replacement.getLeafId();
			summary.release.resolve();
			expect((await turn).stopReason).toBe("completed");
			const expectedCount = dispatch === "resume" ? 2 : 1;
			expect(records(owner)).toHaveLength(expectedCount);
			const record = records(owner).at(-1)!;
			const child = owned(owner, record);
			if (dispatch === "resume") expect(record.childId).toBe(childId);
			childId = record.childId;
			expect(child.buildContext().messages).toContainEqual(user("child:main"));
			expect(record.status).toBe("completed");
			expect(SessionStore.open(owner.filePath).getEntries()).toEqual(owner.getEntries());
			expect(owner.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
			expect(owner.getEntries().filter((entry) => entry.type === "summaryUsage")).toHaveLength(0);
			expect(replacement.getEntries()).toEqual(entries);
			expect(replacement.getLeafId()).toBe(leaf);
			expect(replacement.buildContext()).toEqual(context);
			expect(activeRunner.history).toBe(publicHistory);
			expect(activeRunner.history).toEqual(context.messages);
			expect(records(replacement)).toHaveLength(0);
			expect(findChildByLaunch(replacement, childId!)).toMatchObject({ ok: false, code: "not-owned" });
			if (mode === "new") expect(existsSync(replacement.filePath)).toBe(false);
			const summaries = fixture.requests.filter((request) => kindOf(request) === "summary");
			expect(summaries).toHaveLength(1);
			expect(summaries[0]).not.toHaveProperty("sessionId");
			const main = fixture.requests.filter(
				(request) => kindOf(request) === "parent" && lastUser(request) === "main",
			);
			expect(main).toHaveLength(seam === "overflow" ? 3 : 2);
			expect(main.every((request) => request.sessionId === owner.header.id)).toBe(true);
			const snapshot = records(owner);
			await activeRunner.runTurn({ userMessage: "next B" });
			owned(replacement, records(replacement)[0]);
			expect(records(owner)).toEqual(snapshot);
			const childCalls = fixture.requests.filter((request) => kindOf(request) === "child").length;
			await activeRunner.runTurn({ userMessage: "foreign" });
			expect(records(replacement).at(-1)).toMatchObject({ status: "rejected", launched: false });
			expect(fixture.requests.filter((request) => kindOf(request) === "child")).toHaveLength(childCalls);
			expect(findOrphanChildren(baseDir)).toEqual([]);
		},
	);
});

it.each([
	{ initial: "openai-codex/gpt-5.5", next: "openai-codex/gpt-5.5·fast", fast: true },
	{ initial: "openai-codex/gpt-5.5·fast", next: "openai-codex/gpt-5.5", fast: false },
	{ initial: "anthropic/test-model", next: "openai-codex/gpt-5.5·fast", fast: true },
])("keeps owner A but dispatches live selection $initial → $next", async ({ initial, next, fast }) => {
	vi.stubEnv("INK_AUTOCOMPACT", "1");
	const summary = latch();
	const fixture = providerFixture({
		name: initial.startsWith("openai-codex/") ? "openai-codex" : "anthropic",
		async intercept(_request, kind) {
			if (kind === "summary") await summary.wait();
			return undefined;
		},
	});
	const replacementProvider = providerFixture({ name: "openai-codex" });
	const factory = vi
		.spyOn(providerResolution, "createProviderFor")
		.mockReturnValue(replacementProvider.provider);
	const runner = await makeRunner(fixture.provider, { model: initial, thinking: "off" });
	seedLarge(runner);
	const origin = runner.session!;
	const turn = tracked(runner.runTurn({ userMessage: "main" }));
	await summary.reached();
	runner.newSession();
	runner.setModel(next);
	expect(runner.setThinkingLevel("high")).toBe("high");
	summary.release.resolve();
	await turn;
	const child = owned(origin, records(origin)[0]);
	const requests = [...fixture.requests, ...replacementProvider.requests];
	const childRequests = requests.filter((request) => kindOf(request) === "child");
	expect(childRequests).toHaveLength(1);
	expect(childRequests[0]).toMatchObject({ model: "gpt-5.5", thinking: "high" });
	expect(childRequests[0]?.speed).toBe(fast ? "fast" : undefined);
	expect(child.header.launch).toMatchObject({
		model: { providerName: "openai-codex", wireModelId: "gpt-5.5" },
	});
	expect(child.header.launch?.speed).toBe(fast ? "fast" : undefined);
	expect(records(origin)[0]?.binding).toEqual({
		providerName: "openai-codex",
		wireModelId: "gpt-5.5",
		reference: "openai-codex/gpt-5.5",
	});
	const originalRequests = fixture.requests.filter((request) => kindOf(request) !== "child");
	expect(
		originalRequests.every((request) => request.model === initial.split("/")[1]!.replace("·fast", "")),
	).toBe(true);
	expect(
		originalRequests.every((request) => request.speed === (initial.endsWith("·fast") ? "fast" : undefined)),
	).toBe(true);
	expect(records(runner.session!)).toHaveLength(0);
	if (initial.startsWith("anthropic/")) {
		expect(factory).toHaveBeenCalledExactlyOnceWith("openai-codex");
		expect(replacementProvider.requests.filter((request) => kindOf(request) === "child")).toHaveLength(1);
		expect(fixture.requests.filter((request) => kindOf(request) === "child")).toHaveLength(0);
	}
});

it.each(["fresh", "resume"] as const)(
	"captured null remains authoritative after live resume (%s)",
	async (dispatch) => {
		const main = latch();
		let childId: string | undefined;
		const fixture = providerFixture({
			async intercept(request, kind) {
				if (kind === "parent" && lastUser(request) === "null main") await main.wait();
				return undefined;
			},
			taskArgs: (prompt) =>
				prompt === "null main" && dispatch === "resume"
					? { prompt: "continue", resume: childId }
					: { prompt: `child:${prompt}` },
		});
		const seed = await makeRunner(fixture.provider);
		await seed.runTurn({ userMessage: "seed B" });
		const replacementId = seed.session!.header.id;
		childId = records(seed.session!)[0]!.childId;
		const runner = await makeRunner(fixture.provider, { noSession: true });
		const results: ToolExecuteResult[] = [];
		const turn = tracked(
			runner.runTurn({
				userMessage: "null main",
				onEvent: (event) => {
					if (event.type === "tool_end") results.push({ output: "", taskRecord: event.result.taskRecord });
				},
			}),
		);
		await main.reached();
		runner.resumeSession(replacementId);
		const replacement = runner.session!;
		const entries = [...replacement.getEntries()];
		main.release.resolve();
		await turn;
		expect(results).toHaveLength(1);
		expect(results[0]?.taskRecord).not.toHaveProperty("parentSessionId");
		expect(results[0]?.taskRecord).not.toHaveProperty("childId");
		if (dispatch === "fresh")
			expect(results[0]?.taskRecord?.transcript).toEqual({ present: false, why: "no-parent-session" });
		else expect(results[0]?.taskRecord).toMatchObject({ status: "rejected", launched: false });
		expect(replacement.getEntries()).toEqual(entries);
		await runner.runTurn({ userMessage: "next B" });
		owned(replacement, records(replacement).at(-1));
	},
);

it("direct calls retain live B/null while a separate run is gated, without inventing call IDs", async () => {
	const main = latch();
	const fixture = providerFixture({
		async intercept(request, kind) {
			if (kind === "parent" && lastUser(request) === "hold A") await main.wait();
			return undefined;
		},
	});
	const runner = await makeRunner(fixture.provider, { noSession: true });
	const ephemeral = await task(runner).execute({ prompt: "direct null" }, new AbortController().signal);
	expect(ephemeral.taskRecord).not.toHaveProperty("parentSessionId");
	expect(ephemeral.taskRecord).not.toHaveProperty("taskToolCallId");
	expect(ephemeral.taskRecord?.transcript).toEqual({ present: false, why: "no-parent-session" });
	const target = createSession(cwd, baseDir);
	target.appendMessage(user("persist B"));
	runner.resumeSession(target.header.id);
	const origin = runner.session!;
	const before = await task(runner).execute({ prompt: "direct before" }, new AbortController().signal);
	owned(origin, before.taskRecord);
	expect(before.taskRecord).not.toHaveProperty("taskToolCallId");
	const turn = tracked(runner.runTurn({ userMessage: "hold A" }));
	await main.reached();
	const replacement = switchSession(runner, "resume");
	const during = await task(runner).execute({ prompt: "direct B" }, new AbortController().signal);
	owned(replacement, during.taskRecord);
	expect(during.taskRecord).not.toHaveProperty("taskToolCallId");
	main.release.resolve();
	await turn;
	owned(origin, records(origin)[0]);
});

it.each(["A-first", "B-first"] as const)(
	"isolates overlapping run scopes with %s settlement",
	async (order) => {
		const gates = { A: latch(), B: latch() };
		const fixture = providerFixture({
			async intercept(request, kind) {
				const prompt = lastUser(request);
				if (kind === "parent" && (prompt === "A" || prompt === "B")) await gates[prompt].wait();
				return undefined;
			},
		});
		const runner = await makeRunner(fixture.provider);
		const origin = runner.session!;
		const a = tracked(runner.runTurn({ userMessage: "A" }));
		await gates.A.reached();
		const replacement = switchSession(runner, "resume");
		const b = tracked(runner.runTurn({ userMessage: "B" }));
		await gates.B.reached();
		const first = order === "A-first" ? "A" : "B";
		gates[first].release.resolve();
		await (first === "A" ? a : b);
		gates[first === "A" ? "B" : "A"].release.resolve();
		await Promise.all([a, b]);
		owned(origin, records(origin)[0]);
		owned(replacement, records(replacement)[0]);
		await runner.runTurn({ userMessage: "next B" });
		owned(replacement, records(replacement)[1]);
	},
);

it("captures before run_start and restores the outer scope after synchronous reentry", async () => {
	const extensions = new ExtensionRegistry();
	let runner: Runner;
	let nested: Promise<unknown> | undefined;
	extensions.beginExtension("owner-reentry", "cli");
	extensions.subscribe("run_start", () => {
		if (nested !== undefined) return;
		nested = Promise.resolve(); // Guard before the nested run synchronously emits run_start.
		switchSession(runner, "resume");
		nested = tracked(runner.runTurn({ userMessage: "nested B" }));
	});
	extensions.commitExtension();
	runner = await makeRunner(providerFixture().provider, { extensions });
	const origin = runner.session!;
	await runner.runTurn({ userMessage: "outer A" });
	await nested;
	owned(origin, records(origin)[0]);
	owned(runner.session!, records(runner.session!)[0]);
});

it("does not borrow another Runner's active ownership even for nested direct calls", async () => {
	const other = await makeRunner(providerFixture().provider);
	other.session!.appendMessage(user("persist other parent"));
	let nested: ToolExecuteResult | undefined;
	const fixture = providerFixture({
		async intercept(_request, kind) {
			if (kind === "parent" && nested === undefined) {
				nested = await task(other).execute({ prompt: "other direct" }, new AbortController().signal);
			}
			return undefined;
		},
	});
	const runner = await makeRunner(fixture.provider);
	const origin = runner.session!;
	await runner.runTurn({ userMessage: "A" });
	owned(origin, records(origin)[0]);
	owned(other.session!, nested?.taskRecord);
});

const terminals = [
	"success",
	"child-failure",
	"failure",
	"abort",
	"summary-failure",
	"second-overflow",
	"sync-failure",
] as const;
it.each(terminals)("invalidates detached scope and restores live calls after %s", async (terminal) => {
	const delayed = latch();
	const controller = new AbortController();
	const extensions = new ExtensionRegistry();
	let runner: Runner;
	let detached: Promise<ToolExecuteResult> | undefined;
	let scheduled = false;
	const schedule = () => {
		if (scheduled) return;
		scheduled = true;
		detached = tracked(
			(async () => {
				await delayed.wait();
				return task(runner).execute({ prompt: "detached" }, new AbortController().signal);
			})(),
		);
		switchSession(runner, "resume");
	};
	extensions.beginExtension("owner-detached", "cli");
	extensions.subscribe("run_start", schedule);
	extensions.commitExtension();
	const fixture = providerFixture({
		async intercept(request, kind) {
			if (kind === "parent" && lastUser(request) === "main") {
				if (terminal === "failure") throw new Error("parent failed");
				if (terminal === "abort") {
					controller.abort();
					return null;
				}
				if (terminal === "summary-failure" || terminal === "second-overflow")
					throw new Error("context window exceeded");
			}
			if (kind === "summary" && terminal === "summary-failure") throw new Error("summary failed");
			if (kind === "child" && terminal === "child-failure" && lastUser(request) === "child:main")
				throw new Error("child failed");
			return undefined;
		},
	});
	runner = await makeRunner(fixture.provider, { extensions });
	const origin = runner.session!;
	if (terminal === "summary-failure" || terminal === "second-overflow") seedLarge(runner);
	const failure = new Error("synchronous emitter failed");
	if (terminal === "sync-failure") {
		vi.spyOn(extensions, "emitRunStart").mockImplementationOnce(() => {
			schedule();
			throw failure;
		});
		expect(() => runner.runTurn({ userMessage: "main" })).toThrow(failure);
	} else {
		const turn = tracked(runner.runTurn({ userMessage: "main", signal: controller.signal }));
		if (["failure", "summary-failure", "second-overflow"].includes(terminal))
			await expect(turn).rejects.toThrow();
		else expect((await turn).stopReason).toBe(terminal === "abort" ? "aborted" : "completed");
		if (terminal === "success" || terminal === "child-failure") {
			owned(origin, records(origin)[0]);
			expect(records(origin)[0]?.status).toBe(terminal === "success" ? "completed" : "crash");
		}
	}
	expect(scheduled).toBe(true);
	const replacement = runner.session!;
	delayed.release.resolve();
	const result = await detached!;
	owned(replacement, result.taskRecord);
	expect(result.taskRecord).not.toHaveProperty("taskToolCallId");
	const direct = await task(runner).execute({ prompt: "independent direct" }, new AbortController().signal);
	owned(replacement, direct.taskRecord);
	await runner.runTurn({ userMessage: "next B" });
	owned(replacement, records(replacement)[0]);
});
