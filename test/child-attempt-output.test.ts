import path from "node:path";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../src/core/messages.js";
import { SessionStore } from "../src/core/session/store.js";
import { runSubagent } from "../src/core/subagent.js";
import { taskResult } from "../src/core/tools/task.js";
import type { Tool } from "../src/core/tools/types.js";
import type { LLMProvider, LLMRequest } from "../src/provider/types.js";
import { assistant, scriptedProvider, user } from "./helpers/fakes.js";
import { mkTempDir } from "./helpers/mktemp.js";

const OLD_ANSWER = "OLD ANSWER FROM A PREVIOUS ATTEMPT";
const SUMMARY = "SUMMARY MUST NEVER BECOME ATTEMPT OUTPUT";
const PARTIAL = "  CURRENT partial\n";

function historyFixture(persisted: boolean, messages: AgentMessage[]) {
	const root = mkTempDir("ink-resume-");
	const session = persisted ? SessionStore.create(path.join(root, "child.jsonl"), root) : undefined;
	for (const message of messages) session?.appendMessage(message);
	return {
		session,
		initialHistory: session?.buildContext().messages ?? messages,
		onMessage: session === undefined ? undefined : (message: AgentMessage) => session.appendMessage(message),
	};
}

const compactionModes = ["automatic", "overflow"] as const;
const storageModes = [false, true] as const;
const emptyResults = storageModes.flatMap((persisted) =>
	compactionModes.flatMap((compaction) =>
		(["silent", "crash", "abort"] as const).map((terminal) => ({ persisted, compaction, terminal })),
	),
);
const partialResults = storageModes.flatMap((persisted) =>
	compactionModes.flatMap((compaction) =>
		(["silent", "crash", "abort", "new answer"] as const).map((terminal) => ({
			persisted,
			compaction,
			terminal,
		})),
	),
);

function captureRequest(request: LLMRequest): LLMRequest {
	return { ...request, messages: [...request.messages] };
}

function isSummary(request: LLMRequest): boolean {
	return request.system.startsWith("You are a context summarization assistant.");
}

const echo: Tool = {
	name: "echo",
	description: "echoes a test payload",
	parameters: Type.Object({ message: Type.String() }),
	async execute(args) {
		return { output: String(args.message) };
	},
};

const call = (id: string, message: string) =>
	({ type: "toolCall", id, name: "echo", arguments: { message } }) as const;

describe("child attempt output isolation", () => {
	it.each(emptyResults)(
		"excludes retained historical text after $compaction ($terminal, persisted=$persisted)",
		async ({ persisted, compaction, terminal }) => {
			const fixture = historyFixture(persisted, [
				user("HEAD ".repeat(100)),
				assistant([{ type: "text", text: "head answer" }]),
				user("TAIL ".repeat(100)),
				assistant([{ type: "text", text: OLD_ANSWER }]),
			]);
			const controller = new AbortController();
			const taskRequests: LLMRequest[] = [];
			const summaryRequests: LLMRequest[] = [];
			const provider: LLMProvider = {
				name: "mock",
				async *stream(request) {
					if (isSummary(request)) {
						summaryRequests.push(captureRequest(request));
						yield { type: "message_end", message: assistant([{ type: "text", text: SUMMARY }]) };
						return;
					}
					taskRequests.push(captureRequest(request));
					if (compaction === "overflow" && taskRequests.length === 1)
						throw new Error("context window exceeded");
					if (terminal === "crash") throw new Error("current attempt failed");
					if (terminal === "abort") {
						yield { type: "text_delta", text: "UNACCEPTED STREAMED TEXT" };
						controller.abort();
						return;
					}
					yield { type: "message_end", message: assistant([]) };
				},
			};
			const outcome = await runSubagent({
				...fixture,
				provider,
				model: "m",
				system: "S",
				tools: [],
				prompt: "new instruction",
				autoCompact: compaction === "automatic",
				settings: { reserveTokens: 100, triggerTokens: 1, keepRecentTokens: 30, contextWindow: 1000 },
				signal: controller.signal,
			});
			expect(summaryRequests).toHaveLength(1);
			expect(taskRequests).toHaveLength(compaction === "automatic" ? 1 : 2);
			expect(JSON.stringify(taskRequests.at(-1)?.messages)).toContain(OLD_ANSWER);
			expect(JSON.stringify(taskRequests.at(-1)?.messages)).toContain(SUMMARY);
			if (fixture.session) {
				const checkpoints = fixture.session.getEntries().filter((entry) => entry.type === "compaction");
				expect(checkpoints).toHaveLength(1);
				expect(JSON.stringify(checkpoints[0]?.retainedTail)).toContain(OLD_ANSWER);
			}
			expect(outcome.status).toBe(
				terminal === "silent" ? "completed" : terminal === "abort" ? "aborted" : "crash",
			);
			expect(outcome.turns).toBe(terminal === "silent" ? 1 : 0);
			expect(outcome.usageDetail.summarizerCalls).toBe(1);
			expect(outcome.text).toBeUndefined();
			const result = taskResult(outcome, fixture.session ?? null);
			expect(result.output).not.toContain(OLD_ANSWER);
			expect(result.output).not.toContain(SUMMARY);
			expect(result.output).not.toContain("UNACCEPTED STREAMED TEXT");
			expect(result.isError).toBe(terminal !== "silent");
		},
	);

	it.each(partialResults)(
		"keeps current partial text removed by $compaction ($terminal, persisted=$persisted)",
		async ({ persisted, compaction, terminal }) => {
			// No seeded messages: fresh attempts must retain their own partial
			// output even when compaction removes it from provider replay history.
			const fixture = historyFixture(persisted, []);
			const controller = new AbortController();
			const taskRequests: LLMRequest[] = [];
			const summaryRequests: LLMRequest[] = [];
			const provider: LLMProvider = {
				name: "mock",
				async *stream(request) {
					if (isSummary(request)) {
						summaryRequests.push(captureRequest(request));
						yield { type: "message_end", message: assistant([{ type: "text", text: SUMMARY }]) };
						return;
					}
					taskRequests.push(captureRequest(request));
					if (taskRequests.length === 1) {
						yield {
							type: "message_end",
							message: assistant(
								[
									{ type: "text", text: "  CURRENT" },
									{ type: "thinking", thinking: "not output" },
									{ type: "text", text: " partial\n" },
									call("first", "small result"),
								],
								"tool_use",
							),
						};
					} else if (taskRequests.length === 2) {
						yield {
							type: "message_end",
							message: assistant([call("second", "r".repeat(3000))], "tool_use", {
								inputTokens: 5000,
								outputTokens: 5,
							}),
						};
					} else if (compaction === "overflow" && taskRequests.length === 3) {
						throw new Error("context window exceeded");
					} else if (terminal === "crash") {
						throw new Error("current attempt failed after compaction");
					} else if (terminal === "abort") {
						controller.abort();
						return;
					} else {
						yield {
							type: "message_end",
							message: assistant([{ type: "text", text: terminal === "new answer" ? "NEW ANSWER" : " \n" }]),
						};
					}
				},
			};
			const outcome = await runSubagent({
				...fixture,
				provider,
				model: "m",
				system: "S",
				tools: [echo],
				prompt: "work",
				autoCompact: compaction === "automatic",
				settings: { reserveTokens: 100, triggerTokens: 2000, keepRecentTokens: 40, contextWindow: 6000 },
				signal: controller.signal,
			});
			expect(summaryRequests).toHaveLength(1);
			expect(taskRequests).toHaveLength(compaction === "automatic" ? 3 : 4);
			expect(JSON.stringify(summaryRequests[0]?.messages)).toContain("CURRENT");
			expect(JSON.stringify(taskRequests.at(-1)?.messages)).not.toContain("CURRENT");
			expect(JSON.stringify(taskRequests.at(-1)?.messages)).toContain(SUMMARY);
			expect(outcome.status).toBe(
				terminal === "crash" ? "crash" : terminal === "abort" ? "aborted" : "completed",
			);
			expect(outcome.turns).toBe(terminal === "crash" || terminal === "abort" ? 2 : 3);
			expect(outcome.usageDetail.summarizerCalls).toBe(1);
			expect(outcome.text).toBe(terminal === "new answer" ? "NEW ANSWER" : PARTIAL);
			const result = taskResult(outcome, fixture.session ?? null);
			expect(result.isError).toBe(terminal === "abort");
			expect(result.output).not.toContain(SUMMARY);
			if (terminal === "abort" || terminal === "new answer") expect(result.output).not.toContain(PARTIAL);
			else expect(result.output.startsWith(`${PARTIAL}\n\n`)).toBe(true);
			if (terminal === "crash") expect(result.output).toContain("partial result above.");
		},
	);

	it("captures an accepted assistant before a persistence callback fails", async () => {
		const seen: string[] = [];
		const outcome = await runSubagent({
			provider: scriptedProvider([assistant([{ type: "text", text: PARTIAL }])]),
			model: "m",
			system: "S",
			tools: [],
			prompt: "work",
			autoCompact: false,
			onMessage: (message) => {
				seen.push(message.role);
				if (message.role === "assistant") throw new Error("transcript write failed");
			},
		});
		expect(seen).toEqual(["user", "assistant"]);
		expect(outcome).toMatchObject({
			status: "crash",
			reason: "transcript write failed",
			turns: 1,
			text: PARTIAL,
		});
	});

	it("does not accept text when the provider message_end observer throws", async () => {
		const seen: AgentMessage[] = [];
		const outcome = await runSubagent({
			provider: scriptedProvider([assistant([{ type: "text", text: "NOT ACCEPTED" }])]),
			model: "m",
			system: "S",
			tools: [],
			prompt: "work",
			autoCompact: false,
			onMessage: (message) => seen.push(message),
			onEvent: (event) => {
				if (event.type === "message_end") throw new Error("observer failed");
			},
		});
		expect(seen.map((message) => message.role)).toEqual(["user"]);
		expect(outcome).toMatchObject({ status: "crash", reason: "observer failed", turns: 1 });
		expect(outcome.text).toBeUndefined();
	});

	it("preserves provider observer content changes before loop acceptance", async () => {
		const outcome = await runSubagent({
			provider: scriptedProvider([assistant([{ type: "text", text: "original" }])]),
			model: "m",
			system: "S",
			tools: [],
			prompt: "work",
			autoCompact: false,
			onEvent: (event) => {
				if (event.type === "message_end") event.message.blocks = [{ type: "text", text: "observer content" }];
			},
		});
		expect(outcome).toMatchObject({ status: "completed", text: "observer content" });
	});

	it.each(["onMessage", "tool_end"] as const)(
		"does not retain mutable blocks exposed to %s after acceptance",
		async (boundary) => {
			let accepted: AgentMessage | undefined;
			const mutate = () => {
				if (accepted?.role === "assistant") accepted.blocks = [{ type: "text", text: "LATER MUTATION" }];
			};
			const outcome = await runSubagent({
				provider: scriptedProvider([
					assistant([{ type: "text", text: PARTIAL }, call("first", "small result")], "tool_use"),
					assistant([]),
				]),
				model: "m",
				system: "S",
				tools: [echo],
				prompt: "work",
				autoCompact: false,
				onMessage: (message) => {
					if (message.role === "assistant" && accepted === undefined) {
						accepted = message;
						if (boundary === "onMessage") mutate();
					}
				},
				onEvent: (event) => {
					if (boundary === "tool_end" && event.type === "tool_end") mutate();
				},
			});
			// onMessage content mutation may remove the tool call itself. In both
			// cases the accepted output string remains separate from its blocks.
			expect(accepted?.role === "assistant" ? accepted.blocks : []).toEqual([
				{ type: "text", text: "LATER MUTATION" },
			]);
			expect(outcome.text).toBe(PARTIAL);
		},
	);

	it.each(["abort", "crash"] as const)(
		"ignores delta-only %s without an accepted assistant",
		async (mode) => {
			const controller = new AbortController();
			const provider: LLMProvider = {
				name: "mock",
				async *stream() {
					yield { type: "text_delta", text: "NEVER ACCEPTED" };
					if (mode === "crash") throw new Error("stream broke");
					controller.abort();
				},
			};
			const outcome = await runSubagent({
				provider,
				model: "m",
				system: "S",
				tools: [],
				prompt: "work",
				autoCompact: false,
				signal: controller.signal,
			});
			expect(outcome.status).toBe(mode === "abort" ? "aborted" : "crash");
			expect(outcome.turns).toBe(0);
			expect(outcome.text).toBeUndefined();
		},
	);
});
