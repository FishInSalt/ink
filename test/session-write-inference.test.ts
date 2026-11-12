import * as fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as continuation from "../src/core/continuation.js";
import { createSession } from "../src/core/session/manager.js";
import { SessionStore } from "../src/core/session/store.js";
import { runSubagent } from "../src/core/subagent.js";
import type { Tool } from "../src/core/tools/types.js";
import type { LLMRequest } from "../src/provider/types.js";
import { runRepl } from "../src/repl/repl.js";
import { createRunner } from "../src/runner.js";
import {
	assistant,
	gate,
	makeConsole,
	makeRenderer,
	type ScriptStep,
	scriptedProvider,
	ticks,
	user,
} from "./helpers/fakes.js";
import { mkTempDir } from "./helpers/mktemp.js";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, appendFileSync: vi.fn(actual.appendFileSync) };
});
const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
const modes = ["zero", "partial", "complete", "unterminated"] as const;
type Mode = (typeof modes)[number];
const done = () => assistant([{ type: "text", text: "done" }]);
const toolCall = () =>
	assistant([{ type: "toolCall", id: "call-probe", name: "probe", arguments: {} }], "tool_use");

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

function failAppend(mode: Mode, error: Error, when: (line: string) => boolean = () => true) {
	let failed = false;
	vi.mocked(fs.appendFileSync).mockImplementation((file, data, options) => {
		const line = String(data);
		if (!failed && when(line)) {
			failed = true;
			const bytes = Buffer.from(line);
			const n =
				mode === "zero"
					? 0
					: mode === "partial"
						? 17
						: mode === "unterminated"
							? bytes.length - 1
							: bytes.length;
			if (n > 0) actual.appendFileSync(file, bytes.subarray(0, n), options);
			throw error;
		}
		return actual.appendFileSync(file, data, options);
	});
	return () => failed;
}

async function mainFixture(tools: Tool[] = [], scripts: ScriptStep[] = [done()]) {
	const base = mkTempDir("ink-write-inference-");
	const cwd = path.join(base, "project");
	fs.mkdirSync(cwd);
	const view = makeRenderer();
	const requests: LLMRequest[] = [];
	const runner = await createRunner({
		cwd,
		argv: [],
		model: "test-model",
		maxTokens: 1024,
		maxTurns: 5,
		noContextFiles: true,
		noSession: false,
		sessionBaseDir: base,
		settingsPath: path.join(base, "settings.json"),
		renderer: view.renderer,
		provider: scriptedProvider(scripts, requests),
		tools,
	});
	return { runner, requests, output: view.output, base, cwd };
}

describe("write-invalid inference boundaries", () => {
	for (const auto of [false, true]) {
		it.each(modes)(
			`does not start inference after a %s in-flight model-write failure (auto=${auto})`,
			async (mode) => {
				vi.stubEnv("INK_AUTOCOMPACT", auto ? "1" : "0");
				const env = await mainFixture();
				const entered = gate();
				const release = gate();
				const scan = vi.spyOn(continuation, "scanToolPairs");
				const pending = env.runner.runTurn({
					userMessage: "go",
					getSteeringMessages: async () => {
						entered.resolve();
						await release.promise;
						return [];
					},
				});
				await entered.promise;
				const error = new Error("in-flight model append failed");
				failAppend(mode, error);
				expect(() => env.runner.setModel("anthropic/other-model")).toThrow(error);
				expect(() => env.runner.session!.assertWritable()).toThrow(/reopen with \/resume/);
				release.resolve();
				await expect(pending).rejects.toThrow(/reopen with \/resume/);
				expect(env.requests).toHaveLength(0);
				expect(scan).not.toHaveBeenCalled();
			},
		);
	}

	it("also guards the next tool-follow-up stream without scanning history", async () => {
		const env = await mainFixture(
			[
				{
					name: "probe",
					description: "probe",
					parameters: { type: "object" },
					execute: async () => ({ output: "ok" }),
				},
			],
			[toolCall(), done()],
		);
		let boundary = 0;
		const entered = gate();
		const release = gate();
		const scan = vi.spyOn(continuation, "scanToolPairs");
		const pending = env.runner.runTurn({
			userMessage: "go",
			getSteeringMessages: async () => {
				if (++boundary === 2) {
					entered.resolve();
					await release.promise;
				}
				return [];
			},
		});
		await entered.promise;
		failAppend("partial", new Error("follow-up model append failed"));
		expect(() => env.runner.setModel("anthropic/other-model")).toThrow("follow-up model append failed");
		release.resolve();
		await expect(pending).rejects.toThrow(/reopen with \/resume/);
		expect(env.requests).toHaveLength(1);
		expect(scan).not.toHaveBeenCalled();
	});

	for (const speed of [undefined, "fast"] as const) {
		it.each(modes)(
			`keeps the original %s child checkpoint failure and starts no task inference (speed=${speed})`,
			async (mode) => {
				const base = mkTempDir("ink-child-write-inference-");
				const store = createSession(base, base);
				const anchor = done();
				anchor.usage = { inputTokens: 5000, outputTokens: 5 };
				for (const message of [
					user("old material".repeat(1000)),
					anchor,
					user("recent material".repeat(100)),
				])
					store.appendMessage(message);
				const requests: LLMRequest[] = [];
				const failure = new Error("ENOSPC: original checkpoint append failure");
				const failed = failAppend(mode, failure, (line) => line.includes('"type":"compaction"'));
				const outcome = await runSubagent({
					provider: scriptedProvider([done()], requests),
					model: "test-model",
					speed,
					system: "test",
					tools: [],
					prompt: "continue",
					session: store,
					initialHistory: store.buildContext().messages,
					onMessage: (message) => store.appendMessage(message),
					autoCompact: true,
					settings: { contextWindow: 2500, reserveTokens: 500, keepRecentTokens: 40 },
				});
				expect(failed()).toBe(true);
				expect(outcome.status).toBe("crash");
				expect(outcome.reason).toBe(failure.message);
				expect(requests).toHaveLength(1);
				expect(requests[0]!.system).toContain("context summarization assistant");
				expect(() => store.assertWritable()).toThrow(/reopen with \/resume/);
				const reopened = SessionStore.open(store.filePath);
				expect(() => reopened.assertWritable()).not.toThrow();
			},
		);
	}

	it("guards summarizer retries when the store is invalidated during the first summary stream", async () => {
		const base = mkTempDir("ink-summary-write-inference-");
		const store = createSession(base, base);
		const anchor = done();
		anchor.usage = { inputTokens: 5000, outputTokens: 5 };
		for (const message of [user("old".repeat(1000)), anchor, user("recent".repeat(100))])
			store.appendMessage(message);
		let requests = 0;
		const outcome = await runSubagent({
			provider: {
				name: "mock",
				async *stream() {
					requests++;
					failAppend("partial", new Error("other writer failed"));
					expect(() => store.appendSessionName("in-flight")).toThrow("other writer failed");
					yield {
						type: "message_end",
						message: assistant([{ type: "text", text: "incomplete summary" }], "max_tokens"),
					};
				},
			},
			model: "test-model",
			thinking: "high",
			system: "test",
			tools: [],
			prompt: "continue",
			session: store,
			initialHistory: store.buildContext().messages,
			onMessage: (message) => store.appendMessage(message),
			autoCompact: true,
			settings: { contextWindow: 2500, reserveTokens: 500, keepRecentTokens: 40 },
		});
		expect(outcome.status).toBe("crash");
		expect(requests).toBe(1);
	});
});

describe("overflow retry preserves persistence failures", () => {
	function nativeFailure(base: string): Error {
		try {
			actual.appendFileSync(path.join(base, "context_length", "missing.jsonl"), "fixture");
		} catch (error) {
			return error as Error;
		}
		throw new Error("expected native ENOENT");
	}

	it("preserves the original main assistant append error after overflow recovery", async () => {
		const env = await mainFixture(
			[],
			[
				() => {
					throw new Error("context window exceeded");
				},
				done(),
				done(),
			],
		);
		const store = env.runner.session!;
		for (const message of [
			user("older material".repeat(9000)),
			done(),
			user("recent material".repeat(9000)),
			done(),
		])
			store.appendMessage(message);
		env.runner.resumeSession(store.header.id);
		const failure = nativeFailure(env.base);
		failAppend(
			"zero",
			failure,
			(line) => line.startsWith('{"type":"message"') && line.includes('"role":"assistant"'),
		);
		await expect(env.runner.runTurn({ userMessage: "continue" })).rejects.toBe(failure);
		expect(env.requests).toHaveLength(3);
		expect(() => env.runner.session!.assertWritable()).toThrow(/reopen with \/resume/);
	});

	it.each([false, true])("preserves a child assistant append failure (overflow retry=%s)", async (retry) => {
		const base = mkTempDir("ink-child-assistant-write-");
		const store = createSession(base, base);
		for (const message of [user("old".repeat(1000)), done(), user("recent material".repeat(100)), done()])
			store.appendMessage(message);
		const failure = nativeFailure(base);
		const requests: LLMRequest[] = [];
		failAppend(
			"zero",
			failure,
			(line) => line.startsWith('{"type":"message"') && line.includes('"role":"assistant"'),
		);
		const scripts: ScriptStep[] = retry
			? [
					() => {
						throw new Error("context window exceeded");
					},
					done(),
					done(),
				]
			: [done()];
		const outcome = await runSubagent({
			provider: scriptedProvider(scripts, requests),
			model: "test-model",
			system: "test",
			prompt: "continue",
			tools: [],
			session: store,
			initialHistory: store.buildContext().messages,
			onMessage: (message) => store.appendMessage(message),
			autoCompact: false,
			settings: { contextWindow: 2500, reserveTokens: 500, keepRecentTokens: 40 },
		});
		expect(outcome.status).toBe("crash");
		expect(outcome.reason).toBe(failure.message);
		expect(requests).toHaveLength(retry ? 3 : 1);
	});

	it("preserves a second child checkpoint failure inside the overflow retry", async () => {
		const base = mkTempDir("ink-child-retry-write-");
		const store = createSession(base, base);
		for (const message of [user("old".repeat(1000)), done(), user("recent material".repeat(100)), done()])
			store.appendMessage(message);
		const failure = nativeFailure(base);
		let taskCalls = 0;
		let summaries = 0;
		let checkpoints = 0;
		const failed = failAppend(
			"zero",
			failure,
			(line) => line.includes('"type":"compaction"') && ++checkpoints === 2,
		);
		const outcome = await runSubagent({
			provider: {
				name: "mock",
				async *stream(request) {
					let message: ReturnType<typeof done>;
					if (request.system.startsWith("You are a context summarization assistant.")) {
						summaries++;
						message = done();
						yield { type: "text_delta", text: "done" };
					} else {
						if (++taskCalls === 1) throw new Error("context window exceeded");
						message = toolCall();
						message.blocks.push({ type: "text", text: "progress ".repeat(1500) });
						message.usage = { inputTokens: 5000, outputTokens: 5 };
					}
					yield { type: "message_end", message };
				},
			},
			model: "test-model",
			modelReference: "anthropic/test-model",
			system: "test",
			prompt: "continue",
			tools: [
				{
					name: "probe",
					description: "probe",
					parameters: { type: "object" },
					execute: async () => ({ output: "done" }),
				},
			],
			session: store,
			initialHistory: store.buildContext().messages,
			onMessage: (message) => store.appendMessage(message),
			autoCompact: true,
			settings: { contextWindow: 2500, reserveTokens: 500, keepRecentTokens: 40 },
		});
		expect(failed()).toBe(true);
		expect(outcome.status).toBe("crash");
		expect(outcome.reason).toBe(failure.message);
		expect([taskCalls, summaries, checkpoints]).toEqual([2, 2, 2]);
	});
});

describe("emergency exit with an invalid writable store", () => {
	it.each(["zero", "partial"] as const)(
		"still finishes double Ctrl+C after a %s write failure with a tool pending",
		async (mode) => {
			const started = gate();
			const release = gate();
			const env = await mainFixture(
				[
					{
						name: "probe",
						description: "probe",
						parameters: { type: "object" },
						async execute() {
							started.resolve();
							await release.promise;
							return { output: "done" };
						},
					},
				],
				[toolCall(), done()],
			);
			const fake = makeConsole({ tty: true });
			const exit = vi.fn((code: number): never => {
				throw new Error(`fixture exit ${code}`);
			});
			const repl = runRepl({
				runner: env.runner,
				input: fake.stdin,
				output: fake.stdout,
				interactive: true,
				shell: "legacy",
				exit,
			});
			try {
				await ticks(2);
				fake.send("go\n");
				await started.promise;
				failAppend(mode, new Error("write failed while tool pending"));
				expect(() => env.runner.setModel("anthropic/other-model")).toThrow("write failed while tool pending");
				fake.send("\x03\x03");
				expect(await repl).toBe(130);
				expect(exit).toHaveBeenCalledExactlyOnceWith(130);
				expect(env.output()).toContain("emergency tool results were not persisted");
				expect(env.output()).toContain("reopen with /resume");
				expect(env.requests).toHaveLength(1);
				expect(() => env.runner.session!.assertWritable()).toThrow(/reopen with \/resume/);
			} finally {
				release.resolve();
				fake.eof();
				await ticks();
			}
		},
	);
});
