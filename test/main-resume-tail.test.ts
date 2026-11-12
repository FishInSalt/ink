import * as fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage, ToolResultMessage } from "../src/core/messages.js";
import { createSession } from "../src/core/session/manager.js";
import * as tail from "../src/core/session/resume-tail.js";
import { SessionStore } from "../src/core/session/store.js";
import type { LLMRequest } from "../src/provider/types.js";
import { createRunner, type RunnerOptions } from "../src/runner.js";
import { assistant, makeRenderer, scriptedProvider, user } from "./helpers/fakes.js";
import { mkTempDir } from "./helpers/mktemp.js";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, appendFileSync: vi.fn(actual.appendFileSync) };
});
const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
const done = () => assistant([{ type: "text", text: "done" }]);
const calls = (...ids: string[]) =>
	assistant(
		ids.map((id) => ({ type: "toolCall" as const, id, name: "probe", arguments: {} })),
		"tool_use",
	);
const result = (...ids: string[]): ToolResultMessage => ({
	role: "toolResult",
	results: ids.map((id) => ({ toolCallId: id, toolName: "probe", content: `saved ${id}`, isError: false })),
});

beforeEach(() => {
	vi.mocked(fs.appendFileSync).mockReset().mockImplementation(actual.appendFileSync);
	vi.stubEnv("INK_LOG", "0");
	vi.stubEnv("INK_AUTOCOMPACT", "0");
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

function world(messages: AgentMessage[] = [user("中断前 🔧"), calls("a", "b", "c")]) {
	const base = mkTempDir("ink-main-resume-tail-");
	const cwd = path.join(base, "project");
	fs.mkdirSync(cwd);
	const store = createSession(cwd, base);
	for (const message of messages) store.appendMessage(message);
	return { base, cwd, store };
}
async function runnerFor(env: ReturnType<typeof world>, options: Partial<RunnerOptions> = {}) {
	const view = makeRenderer();
	const requests: LLMRequest[] = [];
	const runner = await createRunner({
		cwd: env.cwd,
		argv: [],
		model: "test-model",
		maxTokens: 1024,
		maxTurns: 10,
		noContextFiles: true,
		noSession: false,
		sessionBaseDir: env.base,
		settingsPath: path.join(env.base, "settings.json"),
		renderer: view.renderer,
		provider: scriptedProvider([done()], requests),
		tools: [],
		...options,
	});
	return { runner, requests, output: view.output };
}
const savedResults = (messages: AgentMessage[]) =>
	messages.flatMap((m) => (m.role === "toolResult" ? m.results : []));

describe("final assistant batch only", () => {
	it.each([[], [user("last prompt")], [done()], [calls("a"), result("a")]].map((messages) => ({ messages })))(
		"leaves a completed or non-tool suffix unchanged: $messages",
		({ messages }) => {
			expect(tail.missingTailCalls(messages)).toEqual([]);
		},
	);
	it("preserves out-of-order partial outputs and returns missing IDs in declaration order", () => {
		expect(
			tail.missingTailCalls([user("seed"), calls("a", "b", "c", "d"), result("d"), result("b")]),
		).toEqual([
			{ id: "a", name: "probe" },
			{ id: "c", name: "probe" },
		]);
	});
	it("does not inspect earlier messages or cross a user boundary", () => {
		const earlier = Object.defineProperty({}, "role", {
			get() {
				throw new Error("older history inspected");
			},
		}) as AgentMessage;
		expect(tail.missingTailCalls([earlier, calls("last"), result("last")])).toEqual([]);
		expect(tail.missingTailCalls([earlier, calls("last")])).toEqual([{ id: "last", name: "probe" }]);
		expect(tail.missingTailCalls([earlier, user("failed continuation")])).toEqual([]);
		expect(tail.missingTailCalls([calls("old-gap"), user("later"), done()])).toEqual([]);
	});
	it.each(
		[[calls("a", "a")], [calls("a"), result("a"), result("a")], [calls("a"), result("foreign")]].map(
			(messages) => ({ messages }),
		),
	)("refuses ambiguous final-batch identities before writing: $messages", ({ messages }) => {
		const env = world(messages);
		const before = fs.readFileSync(env.store.filePath);
		expect(() => tail.recoverMainSession(SessionStore.open(env.store.filePath))).toThrow(
			/Cannot repair final tool batch/,
		);
		expect(fs.readFileSync(env.store.filePath)).toEqual(before);
	});
});

describe("immediate main-session resume", () => {
	it.each(["-r", "-c", "/resume", "deferred"])(
		"%s saves missing results while restoring, before any new input or inference",
		async (entry) => {
			const env = world([user("seed"), calls("a", "b", "c", "d"), result("d", "b")]);
			const before = fs.readFileSync(env.store.filePath, "utf8");
			const spy = vi.spyOn(tail, "recoverMainSession");
			const live = await runnerFor(
				env,
				entry === "/resume"
					? {}
					: {
							resume: entry === "-c" ? undefined : env.store.header.id,
							continueRecent: entry === "-c",
							deferInit: entry === "deferred",
						},
			);
			if (entry === "/resume") live.runner.resumeSession(env.store.header.id);
			if (entry === "deferred") live.runner.warmup();
			expect(spy).toHaveBeenCalledTimes(1);
			expect(live.requests).toHaveLength(0);
			expect(live.output()).toContain("recovered 2 interrupted tool call(s)");
			const outputs = savedResults(live.runner.history);
			expect(outputs.map((r) => r.toolCallId)).toEqual(["d", "b", "a", "c"]);
			expect(outputs.slice(0, 2).map((r) => r.content)).toEqual(["saved d", "saved b"]);
			for (const output of outputs.slice(2)) {
				expect(output.isError).toBe(true);
				expect(output.content).toContain("outcome is unknown");
				expect(output.content).toContain("fully or partially");
				expect(output.content).toContain("did not replay");
				expect(output.taskRecord).toBeUndefined();
			}
			expect(SessionStore.open(env.store.filePath).buildContext().messages).toEqual(live.runner.history);
			expect(fs.readFileSync(env.store.filePath, "utf8").startsWith(before)).toBe(true);
			const after = fs.readFileSync(env.store.filePath);
			live.runner.resumeSession(env.store.header.id); // Complete self-resume is allowed.
			expect(fs.readFileSync(env.store.filePath)).toEqual(after);
			spy.mockClear();
			await live.runner.runTurn({ userMessage: "next" });
			await live.runner.runTurn({ userMessage: "again" });
			await live.runner.compactNow();
			const point = live.runner
				.session!.getEntries()
				.find(
					(e) =>
						e.type === "message" && e.message.role === "assistant" && e.message.stopReason === "end_turn",
				)!;
			await live.runner.navigateTree(point.id, { summarize: false });
			expect(spy).not.toHaveBeenCalled();
		},
	);

	it("does not validate or repair an older gap followed by later user input", async () => {
		const env = world([user("seed"), calls("old"), user("old failed continue")]);
		const before = fs.readFileSync(env.store.filePath);
		const live = await runnerFor(env, { resume: env.store.header.id });
		expect(live.runner.history.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
		expect(fs.readFileSync(env.store.filePath)).toEqual(before);
		expect(live.output()).not.toContain("recovered");
	});

	it("repairs only retained effective context while preserving native metadata, selection and estimate floor", async () => {
		const env = world([user("discarded"), calls("old")]);
		const native = calls("kept");
		native.provenance = { version: 1, provider: "openai-codex", model: "gpt-5.5" };
		native.blocks[0]!.responses = { version: 1, provider: "openai-codex", itemId: "fc_kept" };
		native.serviceTier = { requested: "priority", reported: "default" };
		env.store.setModel({ provider: "openai-codex", modelId: "gpt-5.5", speed: "fast" });
		env.store.appendThinkingLevelChange("high");
		env.store.appendCompaction("accepted summary", [user("retained"), native], 9000);
		const live = await runnerFor(env, { resume: env.store.header.id, model: "openai-codex/gpt-5.5" });
		expect(live.runner.history[2]).toEqual(native);
		expect(live.runner.contextEstimateFloor).toBe(3);
		expect(live.runner.modelSelectionReference()).toBe("openai-codex/gpt-5.5·fast");
		expect(live.runner.thinkingLevel).toBe("high");
		expect(savedResults(live.runner.history).map((r) => r.toolCallId)).toEqual(["kept"]);
	});

	it.each(["calls", "text"])(
		"repairs an unterminated %s record before an explicit startup model append",
		async (kind) => {
			const env = world([]);
			env.store.setModel({ provider: "anthropic", modelId: "original-model" });
			env.store.appendMessage(user("完整前缀 🔧"));
			env.store.appendMessage(kind === "calls" ? calls("a") : done());
			// Make the final record unterminated without losing accepted bytes.
			const bytes = fs.readFileSync(env.store.filePath);
			fs.writeFileSync(env.store.filePath, bytes.subarray(0, -1));
			const live = await runnerFor(env, {
				resume: env.store.header.id,
				model: "anthropic/override-model",
				modelExplicit: true,
			});
			const reopened = SessionStore.open(env.store.filePath);
			expect(reopened.getModel()?.modelId).toBe("override-model");
			expect(reopened.buildContext().messages).toEqual(live.runner.history);
			expect(savedResults(live.runner.history)).toHaveLength(kind === "calls" ? 1 : 0);
			for (const line of fs.readFileSync(env.store.filePath, "utf8").trimEnd().split("\n"))
				expect(() => JSON.parse(line)).not.toThrow();
		},
	);

	it("removes only the torn final fragment and retains the complete CJK prefix", async () => {
		const env = world();
		const prefix = fs.readFileSync(env.store.filePath, "utf8");
		actual.appendFileSync(env.store.filePath, '{"type":"message","id":"残缺');
		const live = await runnerFor(env, { resume: env.store.header.id });
		expect(fs.readFileSync(env.store.filePath, "utf8").startsWith(prefix)).toBe(true);
		expect(SessionStore.open(env.store.filePath).buildContext().messages).toEqual(live.runner.history);
		expect(savedResults(live.runner.history)).toHaveLength(3);
	});
});

describe("failed candidate is never published", () => {
	it.each(["zero", "partial", "complete", "unterminated"])(
		"reopens actual saved state after a %s recovery write failure",
		async (mode) => {
			const env = world();
			const live = await runnerFor(env);
			await live.runner.runTurn({ userMessage: "previous conversation" });
			const previous = live.runner.session;
			const history = [...live.runner.history];
			const model = live.runner.modelSelectionReference();
			const failure = new Error("candidate append failed");
			vi.mocked(fs.appendFileSync).mockImplementationOnce((file, data, options) => {
				const bytes = Buffer.from(String(data));
				const n =
					mode === "zero"
						? 0
						: mode === "partial"
							? 30
							: mode === "unterminated"
								? bytes.length - 1
								: bytes.length;
				if (n > 0) actual.appendFileSync(file, bytes.subarray(0, n), options);
				throw failure;
			});
			expect(() => live.runner.resumeSession(env.store.header.id)).toThrow(failure);
			expect(live.runner.session).toBe(previous);
			expect(live.runner.history).toEqual(history);
			expect(live.runner.modelSelectionReference()).toBe(model);
			expect(live.output()).not.toContain("recovered");
			live.runner.resumeSession(env.store.header.id);
			expect(savedResults(live.runner.history)).toHaveLength(3);
			expect(SessionStore.open(env.store.filePath).buildContext().messages).toEqual(live.runner.history);
		},
	);

	it.each(["same path", "symlink", "hard link"])(
		"refuses a write-requiring active-file alias before writing: %s",
		(kind) => {
			const env = world();
			const active = SessionStore.open(env.store.filePath);
			const alias = kind === "same path" ? env.store.filePath : path.join(env.base, "alias.jsonl");
			if (kind === "symlink") fs.symlinkSync(env.store.filePath, alias);
			if (kind === "hard link") fs.linkSync(env.store.filePath, alias);
			const before = fs.readFileSync(env.store.filePath);
			vi.mocked(fs.appendFileSync).mockClear();
			expect(() => tail.recoverMainSession(SessionStore.open(alias), active)).toThrow(
				/Use \/new then \/resume/,
			);
			expect(fs.appendFileSync).not.toHaveBeenCalled();
			expect(fs.readFileSync(env.store.filePath)).toEqual(before);
		},
	);

	it("allows /new then /resume after refusing repair of the active file", async () => {
		const env = world([user("complete"), done()]);
		const live = await runnerFor(env, { resume: env.store.header.id });
		// Simulate an interrupted batch in the active persisted file; no normal-turn recovery is added.
		live.runner.session!.appendMessage(calls("later"));
		const before = fs.readFileSync(env.store.filePath);
		expect(() => live.runner.resumeSession(env.store.header.id)).toThrow(/Use \/new then \/resume/);
		expect(fs.readFileSync(env.store.filePath)).toEqual(before);
		live.runner.newSession();
		live.runner.resumeSession(env.store.header.id);
		expect(savedResults(live.runner.history).map((r) => r.toolCallId)).toEqual(["later"]);
	});
});
