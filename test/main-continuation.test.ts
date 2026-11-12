import * as fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as continuation from "../src/core/continuation.js";
import type { AgentMessage, ToolResultMessage } from "../src/core/messages.js";
import { createSession } from "../src/core/session/manager.js";
import { SessionStore } from "../src/core/session/store.js";
import type { Tool } from "../src/core/tools/types.js";
import { toResponsesInput } from "../src/provider/responses-history.js";
import type { LLMProvider, LLMRequest } from "../src/provider/types.js";
import { createRunner, type RunnerOptions } from "../src/runner.js";
import { assistant, gate, makeRenderer, scriptedProvider, user } from "./helpers/fakes.js";
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
const realResult = (id: string): ToolResultMessage => ({
	role: "toolResult",
	results: [{ toolCallId: id, toolName: "probe", content: "actual saved output", isError: false }],
});
const results = (messages: AgentMessage[]) =>
	messages.flatMap((m) => (m.role === "toolResult" ? m.results : []));

beforeEach(() => {
	vi.mocked(fs.appendFileSync).mockReset().mockImplementation(actual.appendFileSync);
	vi.stubEnv("INK_LOG", "0");
	vi.stubEnv("INK_HEALTH", "0");
	vi.stubEnv("INK_AUTOCOMPACT", "0");
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

async function fixture(
	args: {
		messages?: AgentMessage[];
		provider?: LLMProvider;
		continueRecent?: boolean;
		deferInit?: boolean;
		noSession?: boolean;
		tools?: Tool[];
	} = {},
) {
	const base = mkTempDir("ink-main-continuation-");
	const cwd = path.join(base, "project");
	fs.mkdirSync(cwd);
	const store = createSession(cwd, base);
	for (const message of args.messages ?? []) store.appendMessage(message);
	const requests: LLMRequest[] = [];
	const view = makeRenderer();
	const options: RunnerOptions = {
		cwd,
		argv: [],
		model: "test-model",
		maxTokens: 1024,
		maxTurns: 20,
		noContextFiles: true,
		noSession: args.noSession ?? false,
		sessionBaseDir: base,
		settingsPath: path.join(base, "settings.json"),
		provider: args.provider ?? scriptedProvider([done()], requests),
		tools: args.tools ?? [],
		renderer: view.renderer,
		resume: args.messages && !args.continueRecent ? store.header.id : undefined,
		continueRecent: args.continueRecent,
		deferInit: args.deferInit,
	};
	const runner = await createRunner(options);
	return { runner, store, requests, output: view.output, base, cwd };
}

function expectWirePairs(messages: AgentMessage[]) {
	const input = toResponsesInput(messages, "test-model");
	const pending = new Set<string>();
	for (const item of input) {
		if ("type" in item && item.type === "function_call") pending.add(item.call_id);
		else if ("type" in item && item.type === "function_call_output") {
			expect(pending.delete(item.call_id)).toBe(true);
		} else if ("role" in item && item.role === "user") expect(pending.size).toBe(0);
	}
	expect(pending.size).toBe(0);
}

function failResultAppend(mode: "zero" | "partial" | "complete" | "unterminated", error: Error) {
	vi.mocked(fs.appendFileSync).mockImplementationOnce((file, data, options) => {
		const bytes = Buffer.from(String(data));
		const amount =
			mode === "zero"
				? 0
				: mode === "partial"
					? 45
					: mode === "unterminated"
						? bytes.length - 1
						: bytes.length;
		if (amount > 0) actual.appendFileSync(file, bytes.subarray(0, amount), options);
		throw error;
	});
}

describe("main continuation boundaries", () => {
	it.each(["resume", "continue", "slash", "deferred"])(
		"%s closes only missing results before the prompt and never executes old calls",
		async (kind) => {
			const execute = vi.fn(async () => ({ output: "must not execute" }));
			const env = await fixture({
				messages: [user("seed"), calls("a", "b", "c", "d"), realResult("b")],
				continueRecent: kind === "continue",
				deferInit: kind === "deferred",
				tools: [{ name: "probe", description: "probe", parameters: { type: "object" }, execute }],
			});
			if (kind === "deferred") env.runner.warmup();
			if (kind === "slash") {
				env.runner.newSession();
				env.runner.resumeSession(env.store.header.id);
			}
			const before = fs.readFileSync(env.store.filePath, "utf8");
			expect(results(env.runner.history)).toHaveLength(1);
			expect(env.output()).not.toContain("recovered");
			await env.runner.runTurn({ userMessage: "continue" });
			expect(execute).not.toHaveBeenCalled();
			expect(env.requests).toHaveLength(1);
			const request = env.requests[0]!;
			expect(request.messages.map((m) => m.role)).toEqual([
				"user",
				"assistant",
				"toolResult",
				"toolResult",
				"user",
			]);
			expect(results(request.messages).map((r) => r.toolCallId)).toEqual(["b", "a", "c", "d"]);
			expect(results(request.messages)[0]?.content).toBe("actual saved output");
			for (const result of results(request.messages).slice(1)) {
				expect(result.isError).toBe(true);
				expect(result.content).toContain("outcome is unknown");
				expect(result.content).toContain("fully or partially");
				expect(result.content).toContain("did not replay");
			}
			expectWirePairs(request.messages);
			expect(fs.readFileSync(env.store.filePath, "utf8").startsWith(before)).toBe(true);
			expect(SessionStore.open(env.store.filePath).buildContext().messages).toEqual(env.runner.history);
			env.runner.resumeSession(env.store.header.id);
			await env.runner.runTurn({ userMessage: "continue again" });
			expect(results(env.runner.history)).toHaveLength(4);
			expect(env.output().match(/recovered 3 tool/g)).toHaveLength(1);
		},
	);

	it("does not scan ordinary submissions or repeated model iterations", async () => {
		const scan = vi.spyOn(continuation, "scanToolPairs");
		const sink: LLMRequest[] = [];
		const env = await fixture({
			messages: [user("seed"), done()],
			provider: scriptedProvider([calls("new"), done(), done()], sink),
			tools: [
				{
					name: "probe",
					description: "probe",
					parameters: { type: "object" },
					execute: async () => ({ output: "ok" }),
				},
			],
		});
		expect(scan).not.toHaveBeenCalled();
		await env.runner.runTurn({ userMessage: "first" });
		expect(sink).toHaveLength(2);
		expect(scan).toHaveBeenCalledTimes(1);
		await env.runner.runTurn({ userMessage: "second" });
		await env.runner.compactNow();
		expect(scan).toHaveBeenCalledTimes(1);
	});

	it("fresh normal conversations need no recovery scan", async () => {
		const scan = vi.spyOn(continuation, "scanToolPairs");
		const env = await fixture();
		await env.runner.runTurn({ userMessage: "new" });
		await env.runner.runTurn({ userMessage: "next" });
		expect(scan).not.toHaveBeenCalled();
	});

	it.each([false, true])(
		"closes a runtime exception after tool execution, without reexecution (ephemeral=%s)",
		async (noSession) => {
			const execute = vi.fn(async () => ({ output: "side effect already happened" }));
			const sink: LLMRequest[] = [];
			const env = await fixture({
				noSession,
				provider: scriptedProvider([calls("executed"), done()], sink),
				tools: [{ name: "probe", description: "probe", parameters: { type: "object" }, execute }],
			});
			await expect(
				env.runner.runTurn({
					userMessage: "go",
					onEvent: (event) => {
						if (event.type === "tool_end") throw new Error("observer stopped before result persistence");
					},
				}),
			).rejects.toThrow("observer stopped");
			expect(execute).toHaveBeenCalledTimes(1);
			expect(results(env.runner.history)).toHaveLength(0);
			await env.runner.runTurn({ userMessage: "continue" });
			expect(execute).toHaveBeenCalledTimes(1);
			expect(results(sink[1]!.messages)[0]?.content).toContain("outcome is unknown");
			expectWirePairs(sink[1]!.messages);
		},
	);

	it.each(["later user", "duplicate call", "orphan result", "duplicate result", "early result"])(
		"refuses %s before prompt append, mutation or inference",
		async (kind) => {
			const bad: Record<string, AgentMessage[]> = {
				"later user": [user("seed"), calls("a"), user("failed continuation")],
				"duplicate call": [user("seed"), calls("a", "a")],
				"orphan result": [user("seed"), realResult("a")],
				"duplicate result": [user("seed"), calls("a"), realResult("a"), realResult("a")],
				"early result": [user("seed"), realResult("a"), calls("a")],
			};
			const env = await fixture({ messages: bad[kind] });
			const before = fs.readFileSync(env.store.filePath);
			const history = [...env.runner.history];
			await expect(env.runner.runTurn({ userMessage: "must not append" })).rejects.toThrow(/Use \/tree/);
			await expect(env.runner.compactNow()).rejects.toThrow(/Use \/tree/);
			expect(env.requests).toHaveLength(0);
			expect(env.runner.history).toEqual(history);
			expect(fs.readFileSync(env.store.filePath)).toEqual(before);
		},
	);

	it("pre-aborted continuation/compaction/navigation does not mutate or consume the recovery boundary", async () => {
		const env = await fixture({ messages: [user("seed"), calls("a")] });
		const before = fs.readFileSync(env.store.filePath);
		const signal = AbortSignal.abort();
		expect(await env.runner.runTurn({ userMessage: "cancelled", signal })).toMatchObject({
			stopReason: "aborted",
			turns: 0,
		});
		expect(await env.runner.compactNow(signal)).toBe("aborted");
		expect(await env.runner.navigateTree(env.runner.session!.getLeafId()!, { signal })).toEqual({
			aborted: true,
		});
		expect(fs.readFileSync(env.store.filePath)).toEqual(before);
		await env.runner.runTurn({ userMessage: "continue" });
		expect(results(env.runner.history)).toHaveLength(1);
	});

	it.each(["manual", "automatic", "overflow"])(
		"%s compaction keeps repaired native history without another pairing scan",
		async (mode) => {
			vi.stubEnv("INK_AUTOCOMPACT", mode === "automatic" ? "1" : "0");
			vi.stubEnv("INK_CONTEXT_WINDOW", "131072");
			const earlier = done();
			earlier.usage = { inputTokens: 250000, outputTokens: 5 };
			const batch = calls("kept");
			batch.provenance = { version: 1, provider: "openai-codex", model: "test-model" };
			batch.blocks[0]!.responses = { version: 1, provider: "openai-codex", itemId: "fc_kept" };
			batch.usage = { inputTokens: mode === "automatic" ? 250000 : 10, outputTokens: 5 };
			const requests: LLMRequest[] = [];
			let normalCalls = 0;
			const provider: LLMProvider = {
				name: "mock",
				async *stream(request) {
					requests.push({ ...request, messages: [...request.messages] });
					const summary = request.system.startsWith("You are a context summarization assistant.");
					if (!summary && ++normalCalls === 1 && mode === "overflow")
						throw new Error("context window exceeded");
					const text = summary ? "accepted summary" : "done";
					yield { type: "text_delta", text };
					yield { type: "message_end", message: assistant([{ type: "text", text }]) };
				},
			};
			const env = await fixture({
				messages: [
					user("older material ".repeat(9000)),
					earlier,
					user("recent material ".repeat(9000)),
					batch,
				],
				provider,
			});
			const scan = vi.spyOn(continuation, "scanToolPairs");
			if (mode === "manual") expect(await env.runner.compactNow()).toBe("compacted");
			await env.runner.runTurn({ userMessage: "continue" });
			expect(scan).toHaveBeenCalledTimes(1);
			expect(
				requests.filter((r) => r.system.startsWith("You are a context summarization assistant.")),
			).toHaveLength(1);
			const main = requests.at(-1)!;
			expect(results(main.messages).map((r) => r.toolCallId)).toEqual(["kept"]);
			expectWirePairs(main.messages);
			expect(toResponsesInput(main.messages, "test-model")).toContainEqual(
				expect.objectContaining({ type: "function_call", id: "fc_kept" }),
			);
			expect(env.runner.contextEstimateFloor).toBeGreaterThan(0);
			expect(SessionStore.open(env.store.filePath).buildContext().messages).toEqual(env.runner.history);
		},
	);

	it("only repairs effective retained history and preserves the compaction estimate boundary", async () => {
		const env = await fixture({ messages: [user("old"), calls("discarded")] });
		env.store.appendCompaction("accepted summary", [user("retained"), calls("retained")], 5000);
		env.runner.resumeSession(env.store.header.id);
		expect(env.runner.contextEstimateFloor).toBe(3);
		await env.runner.runTurn({ userMessage: "continue" });
		expect(results(env.requests[0]!.messages).map((r) => r.toolCallId)).toEqual(["retained"]);
		expect(JSON.stringify(env.requests[0]!.messages)).not.toContain("discarded");
		expect(env.runner.contextEstimateFloor).toBe(3);
	});

	it.each(["zero", "partial", "complete", "unterminated"] as const)(
		"requires reopen after a %s recovery append failure and does not duplicate accepted results",
		async (mode) => {
			const env = await fixture({ messages: [user("seed"), calls("a")] });
			const error = new Error("uncertain recovery append");
			failResultAppend(mode, error);
			await expect(env.runner.runTurn({ userMessage: "must not append" })).rejects.toBe(error);
			expect(env.output()).not.toContain("recovered");
			await expect(env.runner.runTurn({ userMessage: "must reopen" })).rejects.toThrow(
				/reopen with \/resume/,
			);
			expect(env.requests).toHaveLength(0);
			env.runner.resumeSession(env.store.header.id);
			await env.runner.runTurn({ userMessage: "continue after reopen" });
			expect(results(env.runner.history)).toHaveLength(1);
			expectWirePairs(env.requests[0]!.messages);
			expect(SessionStore.open(env.store.filePath).buildContext().messages).toEqual(env.runner.history);
		},
	);
});

describe("navigation destination recovery", () => {
	async function navFixture(provider?: LLMProvider) {
		const env = await fixture({ messages: [user("seed"), calls("a", "b"), realResult("b")], provider });
		const destination = env.store.getLeafId()!;
		env.store.appendMessage(realResult("a"));
		env.store.appendMessage(user("old branch"));
		env.store.appendMessage(done());
		env.runner.resumeSession(env.store.header.id);
		return { ...env, destination };
	}

	it.each([false, true])(
		"repairs a selected partial-result position without borrowing results from its old descendants (summary=%s)",
		async (summarize) => {
			const env = await navFixture();
			const before = fs.readFileSync(env.store.filePath, "utf8");
			const scan = vi.spyOn(continuation, "scanToolPairs");
			await env.runner.navigateTree(env.destination, { summarize });
			if (!summarize) expect(results(env.runner.history)).toHaveLength(1);
			await env.runner.runTurn({ userMessage: "new branch" });
			const saved = results(env.runner.history);
			expect(saved).toHaveLength(2);
			expect(saved[0]?.content).toBe("actual saved output");
			expect(saved[1]?.toolCallId).toBe("a");
			expect(saved[1]?.content).toContain("outcome is unknown");
			expect(scan).toHaveBeenCalledTimes(1);
			expectWirePairs(env.requests.at(-1)!.messages);
			expect(fs.readFileSync(env.store.filePath, "utf8").startsWith(before)).toBe(true);
			expect(SessionStore.open(env.store.filePath).buildContext().messages).toEqual(env.runner.history);
		},
	);

	it("rejects an inconsistent summary destination before inference or position change", async () => {
		const env = await fixture({ messages: [user("seed"), calls("a"), user("failed"), done()] });
		const invalidDestination = env.store.getLeafId()!;
		env.store.appendCompaction("new clean context", [user("clean")], 10);
		env.runner.resumeSession(env.store.header.id);
		const before = fs.readFileSync(env.store.filePath);
		await expect(env.runner.navigateTree(invalidDestination, { summarize: true })).rejects.toThrow(
			/Use \/tree/,
		);
		expect(env.requests).toHaveLength(0);
		expect(fs.readFileSync(env.store.filePath)).toEqual(before);
	});

	it("does not repair or move when cancellation arrives with a completed summary", async () => {
		const signal = new AbortController();
		const hold = gate();
		const env = await navFixture(
			scriptedProvider([
				async () => {
					await hold.promise;
					signal.abort();
					return done();
				},
			]),
		);
		const leaf = env.runner.session!.getLeafId();
		const pending = env.runner.navigateTree(env.destination, { summarize: true, signal: signal.signal });
		hold.resolve();
		expect(await pending).toEqual({ aborted: true });
		expect(env.runner.session!.getLeafId()).toBe(leaf);
		expect(results(env.runner.history).every((r) => !r.isError)).toBe(true);
	});

	it.each(["repair", "summary"])(
		"synchronizes destination history and refuses inference after a failed %s installation",
		async (stage) => {
			const env = await navFixture();
			const write = actual.appendFileSync;
			let failed = false;
			vi.mocked(fs.appendFileSync).mockImplementation((file, data, options) => {
				const line = String(data);
				if (!failed && line.includes(stage === "repair" ? '"role":"toolResult"' : '"type":"branchSummary"')) {
					failed = true;
					actual.appendFileSync(file, line.slice(0, 20), options);
					throw new Error(`failed ${stage} installation`);
				}
				return write(file, data, options);
			});
			await expect(env.runner.navigateTree(env.destination, { summarize: true })).rejects.toThrow(
				`failed ${stage} installation`,
			);
			expect(failed).toBe(true);
			expect(env.runner.history).toEqual(env.runner.session!.buildContext().messages);
			expect(env.runner.contextEstimateFloor).toBe(env.runner.session!.buildContext().compactionBoundary);
			expect(env.output()).toContain("summary usage receipt was not persisted");
			expect(env.output()).not.toContain("recovered");
			await expect(env.runner.runTurn({ userMessage: "blocked" })).rejects.toThrow(/reopen with \/resume/);
			env.runner.resumeSession(env.store.header.id);
			await env.runner.runTurn({ userMessage: "continue" });
			expectWirePairs(env.requests.at(-1)!.messages);
			expect(results(env.runner.history)).toHaveLength(2);
		},
	);

	it("failed old runs do not mark a replacement conversation for a scan", async () => {
		const entered = gate();
		const release = gate();
		const requests: LLMRequest[] = [];
		const env = await fixture({
			provider: scriptedProvider(
				[
					async () => {
						entered.resolve();
						await release.promise;
						throw new Error("old run failed");
					},
					done(),
				],
				requests,
			),
		});
		const pending = env.runner.runTurn({ userMessage: "old" });
		await entered.promise;
		env.runner.newSession();
		const scan = vi.spyOn(continuation, "scanToolPairs");
		release.resolve();
		await expect(pending).rejects.toThrow("old run failed");
		await env.runner.runTurn({ userMessage: "new" });
		expect(scan).not.toHaveBeenCalled();
		expect(env.runner.history.map((m) => m.role)).toEqual(["user", "assistant"]);
	});
});
