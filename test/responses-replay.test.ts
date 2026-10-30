import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
	compactHistory,
	compactSession,
	estimateContextTokens,
	estimateTokens,
	findCutIndex,
	isContextOverflowError,
	serializeForSummary,
	summarizeBranchSegment,
} from "../src/core/compaction.js";
import type { AgentEvent } from "../src/core/loop.js";
import type { AgentMessage, AssistantMessage } from "../src/core/messages.js";
import { createChildSession, createSession } from "../src/core/session/manager.js";
import { SessionStore, summaryToMessage } from "../src/core/session/store.js";
import { runSubagent } from "../src/core/subagent.js";
import { createAnthropicProvider } from "../src/provider/anthropic.js";
import { CodexResponseError, createCodexResponsesProvider } from "../src/provider/codex-responses.js";
import { createOpenAICompletionsProvider } from "../src/provider/openai-completions.js";
import { toResponsesInput } from "../src/provider/responses-history.js";
import type { LLMEvent, LLMRequest } from "../src/provider/types.js";
import { createRunner } from "../src/runner.js";
import { assistant, makeRenderer, scriptedProvider, user } from "./helpers/fakes.js";
import { mkTempDir } from "./helpers/mktemp.js";

type Fields = Record<string, unknown>;
const MODEL = "gpt-5.5";
const TARGET = `openai-codex/${MODEL}`;
const identity = { version: 1 as const, provider: "openai-codex" as const };
const terminalOutputs = [
	{ aggregate: "omitted", output: undefined },
	{ aggregate: "empty", output: [] },
];
const request = (fields: Partial<LLMRequest> = {}): LLMRequest => ({
	system: "system",
	model: MODEL,
	messages: [],
	tools: [],
	maxTokens: 32,
	...fields,
});
const event = (type: string, fields: Fields = {}): Fields => ({ type, ...fields });
const added = (output_index: number, item: Fields) =>
	event("response.output_item.added", { output_index, item });
const done = (output_index: number, item: Fields) =>
	event("response.output_item.done", { output_index, item });
const completed = (fields: Fields = {}) =>
	event("response.completed", { response: { status: "completed", ...fields } });
function response(events: Fields[], hold = false, cancel?: () => void): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					new TextEncoder().encode(events.map((data) => `data: ${JSON.stringify(data)}\n\n`).join("")),
				);
				if (!hold) controller.close();
			},
			cancel,
		}),
		{ headers: { "content-type": "text/event-stream" } },
	);
}
async function collect(stream: AsyncIterable<LLMEvent>): Promise<LLMEvent[]> {
	const events: LLMEvent[] = [];
	for await (const value of stream) events.push(value);
	return events;
}
async function turn(
	events: Fields[],
	req = request(),
): Promise<{ events: LLMEvent[]; message: AssistantMessage }> {
	const output = await collect(
		createCodexResponsesProvider({
			auth: async () => ({ accessToken: "fake-only" }),
			fetch: async () => response(events),
		}).stream(req),
	);
	const last = output.at(-1);
	if (last?.type !== "message_end") throw new Error("missing final fixture message");
	return { events: output, message: last.message };
}
function replayMessage(): AssistantMessage {
	return {
		role: "assistant",
		usage: { inputTokens: 10, outputTokens: 512 },
		stopReason: "tool_use",
		provenance: { ...identity, model: MODEL },
		blocks: [
			{
				type: "thinking",
				thinking: "exposed summary",
				responses: {
					...identity,
					itemId: "rs_1",
					summary: [{ type: "summary_text", text: "exposed summary" }],
					encryptedContent: "OPAQUE_CIPHERTEXT",
				},
			},
			{
				type: "text",
				text: "before",
				responses: {
					...identity,
					itemId: "msg_1",
					contentIndex: 0,
					kind: "output_text",
					phase: "commentary",
				},
			},
			{
				type: "text",
				text: "refused",
				responses: { ...identity, itemId: "msg_1", contentIndex: 1, kind: "refusal", phase: "commentary" },
			},
			{
				type: "toolCall",
				id: "call_1",
				name: "read",
				arguments: { path: "canonical" },
				responses: { ...identity, itemId: "fc_1", namespace: "functions" },
			},
			{
				type: "text",
				text: "after",
				responses: {
					...identity,
					itemId: "msg_2",
					contentIndex: 0,
					kind: "output_text",
					phase: "final_answer",
				},
			},
		],
	};
}

function encryptedMessage(itemId: string, inputTokens = 90000, outputTokens = 2000): AssistantMessage {
	return {
		role: "assistant",
		usage: { inputTokens, outputTokens },
		stopReason: "end_turn",
		provenance: { ...identity, model: MODEL },
		blocks: [
			{
				type: "thinking",
				thinking: "abcd",
				responses: {
					...identity,
					itemId,
					summary: [{ type: "summary_text", text: "abcd" }],
					encryptedContent: "CIPHER",
				},
			},
		],
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("Responses final snapshots", () => {
	it("assembles interleaved parts in output/part order and retains only final ciphertext", async () => {
		const reasoning = {
			type: "reasoning",
			id: "rs_1",
			summary: [{ type: "summary_text", text: "corrected summary" }],
			content: [{ type: "reasoning_text", text: "exposed content" }],
			encrypted_content: "FINAL_CIPHER",
		};
		const text = {
			type: "message",
			role: "assistant",
			id: "msg_1",
			phase: "final_answer",
			content: [
				{ type: "output_text", text: "corrected first" },
				{ type: "refusal", refusal: "second" },
			],
		};
		const result = await turn([
			added(0, { type: "reasoning", id: "rs_1", encrypted_content: "PROVISIONAL_SECRET", summary: [] }),
			added(1, { type: "message", id: "msg_1", phase: "commentary", content: [] }),
			event("response.output_text.delta", { output_index: 1, content_index: 0, delta: "stale first" }),
			event("response.reasoning_summary_text.delta", {
				output_index: 0,
				summary_index: 0,
				delta: "stale summary",
			}),
			event("response.refusal.delta", { output_index: 1, content_index: 1, delta: "second" }),
			done(0, reasoning),
			done(1, text),
			completed({
				output: [reasoning, text],
				usage: {
					input_tokens: 100,
					input_tokens_details: { cached_tokens: 30 },
					output_tokens: 50,
				},
			}),
		]);
		expect(result.message.blocks).toEqual([
			{
				type: "thinking",
				thinking: "corrected summary\n\nexposed content",
				responses: {
					...identity,
					itemId: "rs_1",
					summary: reasoning.summary,
					content: reasoning.content,
					encryptedContent: "FINAL_CIPHER",
				},
			},
			{
				type: "text",
				text: "corrected first",
				responses: {
					...identity,
					itemId: "msg_1",
					phase: "final_answer",
					contentIndex: 0,
					kind: "output_text",
				},
			},
			{
				type: "text",
				text: "second",
				responses: { ...identity, itemId: "msg_1", phase: "final_answer", contentIndex: 1, kind: "refusal" },
			},
		]);
		expect(result.message.provenance).toEqual({ ...identity, model: MODEL });
		expect(result.message.usage).toEqual({
			inputTokens: 70,
			outputTokens: 50,
			cacheReadTokens: 30,
		});
		expect(result.events.filter((e) => e.type === "text_delta")).toEqual([
			{ type: "text_delta", text: "stale first" },
			{ type: "text_delta", text: "second" },
		]);
		expect(JSON.stringify(result.message)).not.toContain("PROVISIONAL_SECRET");
		expect(result.message.blocks.some((b) => b.type === "thinking" && b.signature !== undefined)).toBe(false);
	});
	it.each(
		terminalOutputs.flatMap((terminal) =>
			[undefined, "completed"].map((status) => ({ ...terminal, status })),
		),
	)(
		"preserves finalized items and ciphertext with $aggregate terminal output (status $status)",
		async ({ output, status }) => {
			const reasoning = {
				type: "reasoning",
				id: "rs",
				status,
				summary: [{ type: "summary_text", text: "final summary" }],
				encrypted_content: "FINAL_CIPHER",
			};
			const text = {
				type: "message",
				id: "msg",
				status,
				role: "assistant",
				phase: "commentary",
				content: [
					{ type: "output_text", text: "final text" },
					{ type: "refusal", refusal: "final refusal" },
				],
			};
			const call = {
				type: "function_call",
				id: "fc",
				status,
				call_id: "call",
				name: "read",
				arguments: '{"path":"a"}',
			};
			const { message } = await turn([
				added(0, { type: "reasoning", id: "rs", summary: [], encrypted_content: "PROVISIONAL_SECRET" }),
				added(1, { type: "message", id: "msg", content: [] }),
				added(2, { ...call, arguments: "", status: "in_progress" }),
				done(0, reasoning),
				done(1, text),
				done(2, call),
				completed({ output }),
			]);
			expect(message.stopReason).toBe("tool_use");
			expect(toResponsesInput([message], MODEL)).toEqual([
				{ type: "reasoning", id: "rs", summary: reasoning.summary, encrypted_content: "FINAL_CIPHER" },
				{
					type: "message",
					id: "msg",
					role: "assistant",
					status: "completed",
					phase: "commentary",
					content: [
						{ type: "output_text", text: "final text", annotations: [] },
						{ type: "refusal", refusal: "final refusal" },
					],
				},
				{ type: "function_call", id: "fc", call_id: "call", name: "read", arguments: call.arguments },
			]);
			expect(JSON.stringify(message)).not.toContain("PROVISIONAL_SECRET");
		},
	);
	it("still rejects a nonempty terminal aggregate that omits a finalized streamed item", async () => {
		const text = { type: "message", id: "msg", content: [{ type: "output_text", text: "answer" }] };
		const reasoning = { type: "reasoning", id: "rs", summary: [], encrypted_content: "cipher" };
		await expect(
			turn([
				added(0, text),
				added(1, reasoning),
				done(0, text),
				done(1, reasoning),
				completed({ output: [text] }),
			]),
		).rejects.toThrow("final output omitted a streamed item");
	});
	it("represents encrypted-only reasoning as an empty canonical block", async () => {
		const item = { type: "reasoning", id: "rs_hidden", summary: [], encrypted_content: "hidden" };
		const { message } = await turn([completed({ output: [item] })]);
		expect(message.blocks).toEqual([
			{
				type: "thinking",
				thinking: "",
				responses: { ...identity, itemId: "rs_hidden", summary: [], encryptedContent: "hidden" },
			},
		]);
	});
	it("preserves an explicit null text phase and final ciphertext correction", async () => {
		const reasoning = { type: "reasoning", id: "rs", summary: [], encrypted_content: "old-final" };
		const { message } = await turn([
			added(0, reasoning),
			done(0, reasoning),
			completed({
				output: [
					{ ...reasoning, encrypted_content: "new-final" },
					{ type: "message", id: "msg", phase: null, content: [{ type: "output_text", text: "answer" }] },
				],
			}),
		]);
		expect(toResponsesInput([message], MODEL)).toEqual([
			{ type: "reasoning", id: "rs", summary: [], encrypted_content: "new-final" },
			{
				type: "message",
				role: "assistant",
				id: "msg",
				status: "completed",
				phase: null,
				content: [{ type: "output_text", text: "answer", annotations: [] }],
			},
		]);
	});
	it("never retains provisional reasoning ciphertext when no final ciphertext arrives", async () => {
		const { message } = await turn([
			added(0, { type: "reasoning", id: "rs", encrypted_content: "never-save" }),
			done(0, { type: "reasoning", id: "rs", status: "completed", summary: [] }),
			completed(),
		]);
		expect(JSON.stringify(message)).not.toContain("never-save");
	});
	it.each([undefined, null])(
		"empty terminal output never promotes added-event ciphertext when the final value is %s",
		async (encrypted_content) => {
			const { message } = await turn([
				added(0, { type: "reasoning", id: "rs", encrypted_content: "PROVISIONAL_SECRET", summary: [] }),
				done(0, { type: "reasoning", id: "rs", status: "completed", encrypted_content, summary: [] }),
				completed({ output: [] }),
			]);
			expect(message.blocks).toEqual([
				{ type: "thinking", thinking: "", responses: { ...identity, itemId: "rs", summary: [] } },
			]);
			expect(JSON.stringify(toResponsesInput([message], MODEL))).not.toContain("PROVISIONAL_SECRET");
		},
	);
	it("reconciles terminal snapshots even when text/reasoning item.done is missing", async () => {
		const { message } = await turn([
			added(0, { type: "message", id: "m", content: [{ type: "output_text", text: "" }] }),
			event("response.content_part.added", {
				output_index: 0,
				content_index: 1,
				part: { type: "refusal", refusal: "" },
			}),
			event("response.refusal.delta", { output_index: 0, content_index: 1, delta: "old" }),
			completed({
				output: [
					{
						type: "message",
						id: "m",
						content: [
							{ type: "output_text", text: "final" },
							{ type: "refusal", refusal: "no" },
						],
					},
				],
			}),
		]);
		expect(message.blocks.map((b) => (b.type === "text" ? b.text : ""))).toEqual(["final", "no"]);
	});
	it("accepts the official summary-part/text/done lifecycle without duplicate text", async () => {
		const item = {
			type: "reasoning",
			id: "rs",
			summary: [{ type: "summary_text", text: "why" }],
			encrypted_content: "cipher",
		};
		const { events, message } = await turn([
			added(0, { type: "reasoning", id: "rs", summary: [] }),
			event("response.reasoning_summary_part.added", {
				output_index: 0,
				summary_index: 0,
				part: { type: "summary_text", text: "" },
			}),
			event("response.reasoning_summary_text.delta", { output_index: 0, summary_index: 0, delta: "why" }),
			event("response.reasoning_summary_text.done", { output_index: 0, summary_index: 0, text: "why" }),
			event("response.reasoning_summary_part.done", {
				output_index: 0,
				summary_index: 0,
				part: { type: "summary_text", text: "why" },
			}),
			done(0, item),
			completed({ output: [item] }),
		]);
		expect(events.filter((e) => e.type === "thinking_delta")).toEqual([
			{ type: "thinking_delta", text: "why" },
		]);
		expect(message.blocks[0]).toMatchObject({ thinking: "why" });
	});
	it.each(
		[
			[added(0, { type: "message", id: "same" }), added(1, { type: "reasoning", id: "same" }), completed()],
			[
				added(0, { type: "message" }),
				event("response.output_text.delta", { output_index: 0, content_index: null, delta: "bad" }),
				completed(),
			],
			[completed({ output: [{ type: "message", content: [{ type: "image", secret: "not-allowed" }] }] })],
			[
				added(0, { type: "message", id: "a" }),
				added(1, { type: "message", id: "b" }),
				completed({
					output: [
						{ type: "message", id: "b" },
						{ type: "message", id: "a" },
					],
				}),
			],
			[added(0, { type: "message", id: "a" }), completed({ output: [] })],
			...[null, {}, false, 1].map((output) => [completed({ output })]),
		].map((events) => ({ events })),
	)("rejects malformed output rather than emitting message_end (%#)", async ({ events }) => {
		await expect(turn(events)).rejects.toBeInstanceOf(CodexResponseError);
	});
	it("rejects noncontiguous content even after item finalization", async () => {
		await expect(
			turn([
				added(0, { type: "message" }),
				event("response.output_text.delta", { output_index: 0, content_index: 1, delta: "gap" }),
				done(0, { type: "message" }),
				completed(),
			]),
		).rejects.toThrow("noncontiguous content indices");
	});
	it("terminal function snapshots verify closed calls but cannot change arguments", async () => {
		const call = {
			type: "function_call",
			id: "fc",
			call_id: "call",
			name: "read",
			arguments: '{"path":"a"}',
		};
		const closed = [added(0, call), done(0, call)];
		expect((await turn([...closed, completed({ output: [call] })])).message.stopReason).toBe("tool_use");
		await expect(
			turn([...closed, completed({ output: [{ ...call, arguments: '{"path":"b"}' }] })]),
		).rejects.toThrow("conflicting final function arguments");
		await expect(turn([added(0, call), completed({ output: [call] })])).rejects.toThrow(
			"missing output_item.done",
		);
	});
	it.each(["in_progress", "incomplete"])(
		"never executes a normally completed response with %s tool status",
		async (status) => {
			const call = {
				type: "function_call",
				id: "fc",
				call_id: "call",
				name: "read",
				arguments: "{}",
				status,
			};
			await expect(
				turn([added(0, { ...call, status: "in_progress" }), done(0, call), completed({ output: [call] })]),
			).rejects.toThrow("did not finish normally");
		},
	);
	it.each([
		{ usage: undefined, missing: true },
		{ usage: null, missing: true },
		{ usage: {}, missing: true },
		{ usage: { input_tokens: null, output_tokens: null }, missing: true },
		{ usage: { input_tokens: 0, output_tokens: 0 }, missing: false },
		{ usage: { output_tokens_details: { reasoning_tokens: 40 } }, missing: true },
		{ usage: { output_tokens_details: { reasoning_tokens: 0 } }, missing: true },
	])("preserves structural usageMissing for $usage", async ({ usage, missing }) => {
		const { message } = await turn([completed({ usage })]);
		expect(message.usageMissing === true).toBe(missing);
	});
	it("stops/cancels at the terminal event even if the stream never closes", async () => {
		let cancelled = false;
		const provider = createCodexResponsesProvider({
			auth: async () => ({ accessToken: "fake" }),
			fetch: async () =>
				response([completed()], true, () => {
					cancelled = true;
				}),
		});
		expect((await collect(provider.stream(request()))).at(-1)?.type).toBe("message_end");
		expect(cancelled).toBe(true);
	});
});

describe("Responses replay boundary", () => {
	// Focused projections of OpenAI's Responses input schemas: native output
	// messages require id/status/annotations; EasyInputMessage permits only
	// input content parts. These checks remain offline and dependency-free.
	const outputMessageSchema = Type.Object(
		{
			type: Type.Literal("message"),
			role: Type.Literal("assistant"),
			id: Type.String(),
			status: Type.Literal("completed"),
			phase: Type.Optional(
				Type.Union([Type.Literal("commentary"), Type.Literal("final_answer"), Type.Null()]),
			),
			content: Type.Array(
				Type.Union([
					Type.Object(
						{ type: Type.Literal("output_text"), text: Type.String(), annotations: Type.Array(Type.Never()) },
						{ additionalProperties: false },
					),
					Type.Object(
						{ type: Type.Literal("refusal"), refusal: Type.String() },
						{ additionalProperties: false },
					),
				]),
			),
		},
		{ additionalProperties: false },
	);
	const canonicalMessageSchema = Type.Object(
		{
			role: Type.Literal("assistant"),
			phase: Type.Optional(
				Type.Union([Type.Literal("commentary"), Type.Literal("final_answer"), Type.Null()]),
			),
			content: Type.Array(
				Type.Object(
					{ type: Type.Literal("input_text"), text: Type.String() },
					{ additionalProperties: false },
				),
			),
		},
		{ additionalProperties: false },
	);
	it("native replay and canonical fallback satisfy their distinct Responses message schemas", async () => {
		for (const mode of ["native", "different-model", "no-provenance"] as const) {
			const message = replayMessage();
			if (mode === "no-provenance") delete message.provenance;
			const model = mode === "different-model" ? "other-model" : MODEL;
			let checked = 0;
			const provider = createCodexResponsesProvider({
				auth: async () => ({ accessToken: "fake-schema" }),
				fetch: async (_url, init) => {
					const input = (JSON.parse(String(init?.body)) as { input: Fields[] }).input;
					for (const item of input.filter((item) => item.role === "assistant")) {
						expect(Value.Check(mode === "native" ? outputMessageSchema : canonicalMessageSchema, item)).toBe(
							true,
						);
						checked++;
					}
					return response([completed()]);
				},
			});
			await collect(provider.stream(request({ model, messages: [message] })));
			expect(checked).toBe(mode === "native" ? 2 : 3);
		}
	});
	it("replays exact native parts/phase/ciphertext in block order, without duplicate tool arguments", () => {
		const message = replayMessage();
		const input = toResponsesInput([message], MODEL);
		expect(input).toEqual([
			{
				type: "reasoning",
				id: "rs_1",
				summary: [{ type: "summary_text", text: "exposed summary" }],
				encrypted_content: "OPAQUE_CIPHERTEXT",
			},
			{
				type: "message",
				role: "assistant",
				id: "msg_1",
				status: "completed",
				phase: "commentary",
				content: [
					{ type: "output_text", text: "before", annotations: [] },
					{ type: "refusal", refusal: "refused" },
				],
			},
			{
				type: "function_call",
				id: "fc_1",
				namespace: "functions",
				call_id: "call_1",
				name: "read",
				arguments: '{"path":"canonical"}',
			},
			{
				type: "message",
				role: "assistant",
				id: "msg_2",
				status: "completed",
				phase: "final_answer",
				content: [{ type: "output_text", text: "after", annotations: [] }],
			},
		]);
		expect(JSON.stringify(message)).not.toContain('"raw"');
		expect(JSON.stringify(message)).not.toContain('"output"');
	});
	it.each(["different-model", "no-provenance", "old-version", "other-provider"])(
		"uses canonical blocks without native IDs for %s",
		(mode) => {
			const message = replayMessage();
			if (mode === "no-provenance") delete message.provenance;
			if (mode === "old-version") (message.provenance as unknown as Fields).version = 2;
			if (mode === "other-provider") (message.provenance as unknown as Fields).provider = "openai";
			const input = toResponsesInput([message], mode === "different-model" ? "gpt-6" : MODEL);
			expect(input).toEqual([
				{ role: "assistant", content: [{ type: "input_text", text: "before" }] },
				{ role: "assistant", content: [{ type: "input_text", text: "refused" }] },
				{ type: "function_call", call_id: "call_1", name: "read", arguments: '{"path":"canonical"}' },
				{ role: "assistant", content: [{ type: "input_text", text: "after" }] },
			]);
		},
	);
	it("replays canonical-only old sessions in their original block order", () => {
		const message = replayMessage();
		delete message.provenance;
		for (const block of message.blocks) delete block.responses;
		expect(
			toResponsesInput([message], MODEL).map((item) => ("type" in item ? item.type : "message")),
		).toEqual(["message", "message", "function_call", "message"]);
	});
	it("reassembles contiguous parts without IDs when compatible fixtures omit item IDs", async () => {
		const { message } = await turn([
			completed({
				output: [
					{
						type: "message",
						content: [
							{ type: "output_text", text: "a" },
							{ type: "output_text", text: "b" },
						],
					},
				],
			}),
		]);
		expect(toResponsesInput([message], MODEL)).toEqual([
			{
				role: "assistant",
				content: [
					{ type: "input_text", text: "a" },
					{ type: "input_text", text: "b" },
				],
			},
		]);
	});
	it("ignores unknown metadata versions and never trusts extra native call fields", () => {
		const message = replayMessage();
		const block = message.blocks[3]!;
		Object.assign(block.responses!, { name: "evil", arguments: "evil", output: [{ type: "function_call" }] });
		expect(toResponsesInput([message], MODEL)[2]).toMatchObject({
			name: "read",
			arguments: '{"path":"canonical"}',
		});
		for (const b of message.blocks) if (b.responses) (b.responses as unknown as Fields).version = 99;
		expect(JSON.stringify(toResponsesInput([message], MODEL))).not.toContain("OPAQUE_CIPHERTEXT");
	});
	it.each([
		{ part: 1, version: 99 },
		{ part: 2, version: 99 },
		{ part: 1, version: 0 },
	])(
		"falls back for the whole message when multipart part $part has unknown version $version",
		async ({ part, version }) => {
			const message = replayMessage();
			Object.assign(message.blocks[part]!.responses!, { version });
			const canonical = { ...message, provenance: undefined };
			const expected = toResponsesInput([canonical], MODEL);
			expect(toResponsesInput([message], MODEL)).toEqual(expected);
			expect(estimateTokens(message, TARGET)).toBe(estimateTokens(canonical));
			expect(estimateContextTokens([message], 0, TARGET)).toEqual({
				tokens: estimateTokens(canonical),
				measured: false,
			});
			const provider = createCodexResponsesProvider({
				auth: async () => ({ accessToken: "fake-version" }),
				fetch: async (_url, init) => {
					expect((JSON.parse(String(init?.body)) as { input: unknown }).input).toEqual(expected);
					return response([completed()]);
				},
			});
			await expect(collect(provider.stream(request({ messages: [message] })))).resolves.toEqual(
				expect.arrayContaining([expect.objectContaining({ type: "message_end" })]),
			);
		},
	);
	it("shared selection preserves strict history-wide duplicate native ID rejection", () => {
		const first = replayMessage();
		const second = replayMessage();
		expect(() => toResponsesInput([first, second], MODEL)).toThrow("Codex replay metadata is malformed");
		// Unsupported whole-message metadata never reserves native item IDs.
		Object.assign(first.blocks[1]!.responses!, { version: 99 });
		expect(() => toResponsesInput([first, second], MODEL)).not.toThrow();
		expect(
			toResponsesInput([first, second], MODEL).filter((item) => "encrypted_content" in item),
		).toHaveLength(1);
	});

	it("unknown versions do not hide recognized malformed peer metadata", () => {
		const message = replayMessage();
		Object.assign(message.blocks[1]!.responses!, { version: 99 });
		Object.assign(message.blocks[2]!.responses!, { contentIndex: -1 });
		expect(() => toResponsesInput([message], MODEL)).toThrow("Codex replay metadata is malformed");
		expect(estimateTokens(message, TARGET)).toBe(estimateTokens(message));
		expect(estimateContextTokens([message], 0, TARGET)).toEqual({
			tokens: estimateTokens(message),
			measured: false,
		});
	});
	it.each([
		(message: AssistantMessage) => {
			Object.assign(message.blocks[1]!.responses!, { contentIndex: 2 });
		},
		(message: AssistantMessage) => {
			Object.assign(message.blocks[2]!.responses!, { phase: "final_answer" });
		},
		(message: AssistantMessage) => {
			Object.assign(message.blocks[4]!.responses!, { itemId: "msg_1" });
		},
		(message: AssistantMessage) => {
			Object.assign(message.blocks[3]!.responses!, { itemId: "rs_1" });
		},
		(message: AssistantMessage) => {
			Object.assign(message.blocks[0]!.responses!, { encryptedContent: 17 });
		},
		(message: AssistantMessage) => {
			Object.assign(message.blocks[0]!.responses!, { summary: [{ type: "function_call", name: "evil" }] });
		},
		(message: AssistantMessage) => {
			Object.assign(message.blocks[3]!.responses!, { namespace: "" });
		},
		(message: AssistantMessage) => {
			Object.assign(message.provenance!, { model: 17 });
		},
	])("rejects recognized malformed metadata with a fixed diagnostic before auth (%#)", async (change) => {
		const message = replayMessage();
		change(message);
		expect(estimateTokens(message, TARGET)).toBe(estimateTokens(message));
		expect(estimateContextTokens([message], 0, TARGET)).toEqual({
			tokens: estimateTokens(message),
			measured: false,
		});
		const auth = vi.fn(async () => ({ accessToken: "fake" }));
		const provider = createCodexResponsesProvider({ auth, fetch: async () => response([completed()]) });
		await expect(collect(provider.stream(request({ messages: [message] })))).rejects.toThrow(
			"Codex replay metadata is malformed",
		);
		expect(auth).not.toHaveBeenCalled();
	});
	it.each(["anthropic", "openai", "deepseek"])("does not leak native replay fields to %s", async (name) => {
		let captured = "";
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url, init) => {
				captured = String(init?.body);
				const text =
					name === "anthropic"
						? "event: message_stop\ndata: {}\n\n"
						: 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n';
				return new Response(text, { headers: { "content-type": "text/event-stream" } });
			}),
		);
		const provider =
			name === "anthropic"
				? createAnthropicProvider({ apiKey: "fake", baseUrl: "https://fake.invalid" })
				: createOpenAICompletionsProvider({ apiKey: "fake", name, baseUrl: "https://fake.invalid" });
		await collect(provider.stream(request({ messages: [replayMessage()] })));
		for (const hidden of [
			"OPAQUE_CIPHERTEXT",
			"responses",
			"provenance",
			"msg_1",
			"fc_1",
			"rs_1",
			"commentary",
		])
			expect(captured).not.toContain(hidden);
	});
});

describe("Responses target-aware estimation", () => {
	it.each([
		undefined,
		MODEL,
		`openai/${MODEL}`,
		`anthropic/${MODEL}`,
		"openai-codex/gpt-6",
		`OpenAI-Codex/${MODEL}`,
		`openai-codex/${MODEL.toUpperCase()}`,
		`${TARGET} `,
		"openai-codex/",
	])("uses canonical counts and no Responses anchor for target %s", (target) => {
		const message = replayMessage();
		const canonical = estimateTokens(message);
		expect(estimateTokens(message, target)).toBe(canonical);
		expect(estimateContextTokens([message], 0, target)).toEqual({ tokens: canonical, measured: false });
	});

	it.each<[(message: AssistantMessage) => void]>([
		[(message) => delete message.provenance],
		[(message) => Object.assign(message.provenance!, { version: 2 })],
		[(message) => Object.assign(message.provenance!, { provider: "openai" })],
		[(message) => Object.assign(message.provenance!, { model: "gpt-6" })],
		[(message) => Object.assign(message.provenance!, { model: `${MODEL} ` })],
		[(message) => Object.assign(message, { provenance: null })],
		[(message) => Object.assign(message, { provenance: [] })],
		[(message) => Object.assign(message.blocks[0]!.responses!, { version: 2 })],
		[(message) => Object.assign(message.blocks[0]!.responses!, { provider: "future" })],
		[(message) => Object.assign(message.blocks[1]!.responses!, { provider: "openai" })],
		[(message) => Object.assign(message.blocks[3]!, { responses: null })],
	])("whole-message canonical fallback has neither floor nor matching-target anchor (%#)", (change) => {
		const message = replayMessage();
		message.modelReference = TARGET; // a producer stamp cannot override fallback
		change(message);
		expect(JSON.stringify(toResponsesInput([message], MODEL))).not.toContain("OPAQUE_CIPHERTEXT");
		const canonical = estimateTokens(message);
		expect(estimateTokens(message, TARGET)).toBe(canonical);
		expect(estimateContextTokens([message], 0, TARGET)).toEqual({ tokens: canonical, measured: false });
		// Later valid native responses can restore measurement after fallback.
		const fresh = replayMessage();
		fresh.usage = { inputTokens: 80, outputTokens: 20 };
		expect(estimateContextTokens([message, fresh], 0, TARGET)).toEqual({ tokens: 100, measured: true });
	});

	it.each(["no-ids", "canonical-peer", "empty-ciphertext"])(
		"retains native eligibility for supported %s metadata",
		(mode) => {
			const message = replayMessage();
			if (mode === "no-ids") for (const block of message.blocks) delete block.responses?.itemId;
			if (mode === "canonical-peer") message.blocks.push({ type: "text", text: "plain" });
			if (mode === "empty-ciphertext") Object.assign(message.blocks[0]!.responses!, { encryptedContent: "" });
			expect(toResponsesInput([message], MODEL).some((item) => "encrypted_content" in item)).toBe(true);
			expect(estimateTokens(message, TARGET)).toBe(512);
			expect(estimateContextTokens([message], 0, TARGET)).toEqual({ tokens: 522, measured: true });
		},
	);

	it("encrypted-only reasoning gets a reported output floor despite empty canonical thinking", () => {
		const message = replayMessage();
		message.blocks = [
			{ type: "thinking", thinking: "", responses: { ...identity, summary: [], encryptedContent: "cipher" } },
		];
		expect(estimateTokens(message)).toBe(0);
		expect(estimateTokens(message, TARGET)).toBe(512);
		expect(estimateContextTokens([message], 1, TARGET)).toEqual({ tokens: 512, measured: false });
		message.usageMissing = true;
		expect(estimateTokens(message, TARGET)).toBe(0);
		const ordinary = assistant([{ type: "text", text: "away" }]);
		expect(estimateContextTokens([message, ordinary], 0, TARGET)).toEqual({ tokens: 1, measured: false });
	});

	it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
		"does not use invalid/nonpositive output %s as a floor",
		(outputTokens) => {
			const message = replayMessage();
			message.usage.outputTokens = outputTokens;
			expect(estimateTokens(message, TARGET)).toBe(estimateTokens(message));
		},
	);

	it("missing usage prevents floors/anchors but not native ciphertext replay", () => {
		const message = replayMessage();
		message.usageMissing = true;
		expect(toResponsesInput([message], MODEL).some((item) => "encrypted_content" in item)).toBe(true);
		expect(estimateTokens(message, TARGET)).toBe(estimateTokens(message));
		expect(estimateContextTokens([message], 0, TARGET)).toEqual({
			tokens: estimateTokens(message),
			measured: false,
		});
	});

	it("exposed-only reasoning has no floor, and a native output total is applied only once", () => {
		const message = replayMessage();
		const reasoning = message.blocks[0]!;
		const exposedOnly = structuredClone(message);
		if (exposedOnly.blocks[0]?.type === "thinking") delete exposedOnly.blocks[0].responses?.encryptedContent;
		expect(estimateTokens(exposedOnly, TARGET)).toBe(estimateTokens(exposedOnly));
		expect(estimateContextTokens([exposedOnly], 0, TARGET)).toEqual({ tokens: 522, measured: true });
		message.blocks.push({
			...reasoning,
			responses: { ...reasoning.responses!, itemId: "rs_2" },
		} as typeof reasoning);
		expect(estimateTokens(message, TARGET)).toBe(512);
		message.blocks.push({ type: "text", text: "x".repeat(4096) });
		expect(estimateTokens(message, TARGET)).toBe(estimateTokens(message));
		expect(estimateTokens(message, TARGET)).toBeGreaterThan(512);
	});

	it("metadata-free exact legacy producer usage can anchor, never supply native replay or a floor", () => {
		const message = replayMessage();
		delete message.provenance;
		for (const block of message.blocks) delete block.responses;
		message.modelReference = TARGET;
		expect(estimateTokens(message, TARGET)).toBe(estimateTokens(message));
		expect(
			toResponsesInput([message], MODEL).some((item) => "type" in item && item.type === "reasoning"),
		).toBe(false);
		expect(estimateContextTokens([message], 0, TARGET)).toEqual({ tokens: 522, measured: true });
		for (const target of [undefined, `openai/${MODEL}`, "openai-codex/other"])
			expect(estimateContextTokens([message], 0, target)).toEqual({
				tokens: estimateTokens(message),
				measured: false,
			});
		message.usageMissing = true;
		expect(estimateContextTokens([message], 0, TARGET).measured).toBe(false);
	});

	it("never treats a bare model stamp as Responses identity", () => {
		const message = assistant([{ type: "thinking", thinking: "abcd" }]);
		message.model = MODEL;
		// Ordinary legacy anchor behavior stays unchanged; no native floor is inferred.
		expect(estimateTokens(message, TARGET)).toBe(1);
		expect(estimateContextTokens([message], 0, TARGET)).toEqual({ tokens: 15, measured: true });
	});

	it("switching away skips foreign Responses usage and can use an earlier ordinary anchor", () => {
		const native = replayMessage();
		const earlier = assistant([{ type: "text", text: "old" }], "end_turn", {
			inputTokens: 100,
			outputTokens: 20,
			cacheReadTokens: 30,
			cacheWriteTokens: 40,
		});
		const tail = user("next");
		expect(estimateContextTokens([earlier, native, tail], 0, `openai/${MODEL}`)).toEqual({
			tokens: 190 + estimateTokens(native) + 1,
			measured: true,
		});
	});

	it("switching back rejects a newer ordinary anchor and restores the matching native anchor", () => {
		const native = replayMessage();
		const ordinary = assistant([{ type: "text", text: "away" }], "end_turn", {
			inputTokens: 9,
			outputTokens: 1,
		});
		ordinary.modelReference = `openai/${MODEL}`;
		const messages = [user("work"), native, ordinary];
		const original = JSON.stringify(messages);
		expect(estimateContextTokens(messages, 0, `openai/${MODEL}`)).toEqual({ tokens: 10, measured: true });
		expect(estimateContextTokens(messages, 0, TARGET)).toEqual({ tokens: 523, measured: true });
		expect(estimateContextTokens(messages, 0, `openai/${MODEL}`)).toEqual({ tokens: 10, measured: true });
		expect(JSON.stringify(messages)).toBe(original);
	});

	it.each([false, true])(
		"eligible ciphertext below the boundary rejects ordinary anchors even with usageMissing=%s",
		(missing) => {
			const native = replayMessage();
			if (missing) native.usageMissing = true;
			const ordinary = assistant([{ type: "text", text: "away" }], "end_turn", {
				inputTokens: 9,
				outputTokens: 1,
			});
			const messages = [summaryToMessage("checkpoint"), native, ordinary];
			expect(estimateContextTokens(messages, 2, TARGET)).toEqual({
				tokens: messages.reduce((sum, message) => sum + estimateTokens(message, TARGET), 0),
				measured: false,
			});
			// Removing the retained ciphertext restores ordinary anchors without state reset.
			expect(estimateContextTokens([messages[0]!, ordinary], 1, TARGET)).toEqual({
				tokens: 10,
				measured: true,
			});
		},
	);

	it("an earlier ordinary anchor still accounts for trailing encrypted reasoning without a report", () => {
		const earlier = assistant([{ type: "text", text: "base" }], "end_turn", {
			inputTokens: 40,
			outputTokens: 2,
		});
		const native = replayMessage();
		native.usageMissing = true;
		const ordinary = assistant([{ type: "text", text: "away" }], "end_turn", {
			inputTokens: 1,
			outputTokens: 1,
		});
		expect(estimateContextTokens([earlier, native, ordinary], 0, TARGET)).toEqual({
			tokens: 42 + estimateTokens(native, TARGET) + 1,
			measured: true,
		});
	});

	it("later matching native or exact legacy reports recover measurement, but stale ones never cross the boundary", () => {
		const native = replayMessage();
		const ordinary = assistant([{ type: "text", text: "away" }]);
		const later = assistant([{ type: "text", text: "back" }], "end_turn", {
			inputTokens: 100,
			outputTokens: 2,
		});
		later.provenance = { ...identity, model: MODEL };
		const messages = [native, ordinary, later];
		expect(estimateContextTokens(messages, 2, TARGET)).toEqual({ tokens: 102, measured: true });
		delete later.provenance;
		later.modelReference = TARGET;
		expect(estimateContextTokens(messages, 2, TARGET)).toEqual({ tokens: 102, measured: true });
		expect(estimateContextTokens(messages, messages.length, TARGET)).toEqual({
			tokens: 514,
			measured: false,
		});
	});

	it("history-wide duplicate IDs remove both the duplicate's measured anchor and output floor", () => {
		const first = encryptedMessage("rs_shared", 10000);
		const duplicate = encryptedMessage("rs_shared", 92000);
		const messages = [first, duplicate];
		expect(() => toResponsesInput(messages, MODEL)).toThrow("Codex replay metadata is malformed");
		expect(estimateTokens(duplicate, TARGET)).toBe(2000); // standalone has no prior IDs
		expect(estimateContextTokens(messages, 0, TARGET)).toEqual({ tokens: 12001, measured: true });
		for (const boundary of [1, messages.length]) {
			expect(estimateContextTokens(messages, boundary, TARGET)).toEqual({ tokens: 2001, measured: false });
		}
		const earlier = assistant([{ type: "text", text: "base" }], "end_turn", {
			inputTokens: 100,
			outputTokens: 2,
		});
		first.usageMissing = true; // native IDs remain reserved without a usage report
		expect(estimateContextTokens([earlier, first, duplicate], 0, TARGET)).toEqual({
			tokens: 104,
			measured: true,
		});
		expect(estimateContextTokens([first, duplicate], 0, TARGET)).toEqual({ tokens: 2, measured: false });
	});

	it("a duplicate native ID does not independently activate the away/back guard", () => {
		const first = replayMessage();
		first.blocks = [first.blocks[1]!]; // reserves msg_1, but has no encrypted reasoning
		const duplicate = encryptedMessage("msg_1");
		const ordinary = assistant([{ type: "text", text: "away" }]);
		expect(() => toResponsesInput([first, duplicate, ordinary], MODEL)).toThrow(
			"Codex replay metadata is malformed",
		);
		expect(estimateContextTokens([first, duplicate, ordinary], 0, TARGET)).toEqual({
			tokens: 15,
			measured: true,
		});
	});

	it("caught cross-message duplicates never reserve partial IDs that block a later valid anchor", () => {
		const first = encryptedMessage("rs_shared", 10000);
		const malformed = encryptedMessage("rs_recover");
		malformed.blocks.push(encryptedMessage("rs_shared").blocks[0]!);
		const fresh = encryptedMessage("rs_recover", 300, 5);
		const messages = [first, malformed, fresh];
		expect(() => toResponsesInput(messages, MODEL)).toThrow("Codex replay metadata is malformed");
		expect(estimateContextTokens(messages, 0, TARGET)).toEqual({ tokens: 305, measured: true });
		expect(estimateContextTokens(messages, messages.length, TARGET)).toEqual({
			tokens: 2007,
			measured: false,
		});
		const strictValid = [first, fresh];
		expect(() => toResponsesInput(strictValid, MODEL)).not.toThrow();
	});

	it("caught within-message validation failures do not retain partial native ID reservations", () => {
		const malformed = encryptedMessage("rs_recover");
		const part = replayMessage().blocks[1]!;
		Object.assign(part.responses!, { contentIndex: 1 });
		malformed.blocks.push(part);
		const fresh = encryptedMessage("rs_recover", 300, 5);
		expect(() => toResponsesInput([malformed, fresh], MODEL)).toThrow("Codex replay metadata is malformed");
		expect(estimateContextTokens([malformed, fresh], 0, TARGET)).toEqual({ tokens: 305, measured: true });
		expect(estimateContextTokens([malformed, fresh], 2, TARGET)).toEqual({
			tokens: estimateTokens(malformed) + 5,
			measured: false,
		});
	});

	it.each(["unknown-peer", "foreign-model", "foreign-provider"])(
		"%s earlier messages do not reserve native IDs for later matching history",
		(mode) => {
			const first = encryptedMessage("rs_shared");
			if (mode === "unknown-peer") Object.assign(first.blocks[0]!.responses!, { version: 99 });
			if (mode === "foreign-model") Object.assign(first.provenance!, { model: "other" });
			if (mode === "foreign-provider") Object.assign(first.provenance!, { provider: "openai" });
			const fresh = encryptedMessage("rs_shared", 300, 5);
			expect(() => toResponsesInput([first, fresh], MODEL)).not.toThrow();
			expect(estimateContextTokens([first, fresh], 0, TARGET)).toEqual({ tokens: 305, measured: true });
			expect(estimateContextTokens([first, fresh], 2, TARGET)).toEqual({ tokens: 6, measured: false });
		},
	);

	it("fallback ciphertext does not disable ordinary anchors", () => {
		const native = replayMessage();
		Object.assign(native.blocks[1]!.responses!, { version: 99 });
		const ordinary = assistant([{ type: "text", text: "away" }]);
		expect(estimateContextTokens([native, ordinary], 0, TARGET)).toEqual({ tokens: 15, measured: true });
	});
});

describe("Responses persistence and compaction", () => {
	it.each(
		terminalOutputs.flatMap((terminal) =>
			["text", "refusal", "reasoning"].map((kind) => ({ ...terminal, kind })),
		),
	)(
		"runner rejects partial $kind with $aggregate output before JSONL admission and native resume",
		async ({ kind, output }) => {
			vi.stubEnv("INK_LOG", "0");
			vi.stubEnv("INK_AUTOCOMPACT", "0");
			const root = mkTempDir("ink-runner-");
			const reasoning = {
				type: "reasoning",
				id: "accepted_reasoning",
				summary: [{ type: "summary_text", text: "ACCEPTED_SUMMARY" }],
				encrypted_content: "ACCEPTED_CIPHER",
			};
			const text = {
				type: "message",
				id: "accepted_message",
				role: "assistant",
				status: "completed",
				phase: "final_answer",
				content: [
					{ type: "output_text", text: "ACCEPTED_TEXT" },
					{ type: "refusal", refusal: "ACCEPTED_REFUSAL" },
				],
			};
			const call = {
				type: "function_call",
				id: "rejected_tool",
				call_id: "rejected_call",
				name: "probe",
				arguments: "{}",
				status: "completed",
			};
			const partial =
				kind === "reasoning" ? "REJECTED_SUMMARY" : kind === "refusal" ? "REJECTED_REFUSAL" : "REJECTED_TEXT";
			const scripts: Fields[][] = [
				[
					added(0, { type: "reasoning", id: reasoning.id }),
					done(0, reasoning),
					added(1, { type: "message", id: text.id }),
					done(1, text),
					completed({ output }),
				],
				[
					added(0, { type: kind === "reasoning" ? "reasoning" : "message", id: "rejected_peer" }),
					event(
						`response.${kind === "reasoning" ? "reasoning_summary_text" : kind === "refusal" ? "refusal" : "output_text"}.delta`,
						{ output_index: 0, delta: partial },
					),
					// A done reasoning item with noncompleted status must not save its final ciphertext either.
					...(kind === "reasoning"
						? [
								done(0, {
									type: "reasoning",
									id: "rejected_peer",
									status: "incomplete",
									summary: [{ type: "summary_text", text: partial }],
									encrypted_content: "REJECTED_CIPHER",
								}),
							]
						: []),
					added(1, call),
					done(1, call),
					completed({ output }),
				],
			];
			const captured: string[] = [];
			const provider = () =>
				createCodexResponsesProvider({
					baseUrl: "http://127.0.0.1:1",
					auth: async () => ({ accessToken: "fake-runner" }),
					fetch: async (_url, init) => {
						captured.push(String(init?.body));
						return response(scripts.shift() ?? [completed()]);
					},
				});
			const execute = vi.fn(async () => ({ output: "inert result" }));
			const options = {
				cwd: root,
				argv: [],
				model: TARGET,
				modelExplicit: true,
				maxTokens: 32,
				maxTurns: 3,
				noContextFiles: true,
				noSession: false,
				sessionBaseDir: join(root, "sessions"),
				settingsPath: join(root, "settings.json"),
				agentsHomeDir: root,
				agentsProjectAllowed: false,
				systemPromptHomeDir: root,
				renderer: makeRenderer().renderer,
				tools: [
					{
						name: "probe",
						description: "Inert admission regression probe",
						parameters: Type.Object({}),
						execute,
					},
				],
			};
			const live = await createRunner({ ...options, provider: provider() });
			onTestFinished(() => live.close());
			await expect(live.runTurn({ userMessage: "accept" })).resolves.toMatchObject({
				turns: 1,
				stopReason: "completed",
			});
			const accepted = live.history[1]!;
			expect(accepted).toMatchObject({ role: "assistant", provenance: { ...identity, model: MODEL } });
			const observed: AgentEvent[] = [];
			// Soft assertions deliberately continue through reopening/resume on the unfixed adapter.
			await expect
				.soft(live.runTurn({ userMessage: "reject", onEvent: (value) => observed.push(value) }))
				.rejects.toBeInstanceOf(CodexResponseError);
			expect(observed).toContainEqual({
				type: kind === "reasoning" ? "thinking_delta" : "text_delta",
				text: partial,
			});
			expect
				.soft(observed.filter((value) => ["message_end", "tool_start", "tool_running"].includes(value.type)))
				.toEqual([]);
			expect.soft(execute).not.toHaveBeenCalled();
			expect.soft(live.history).toEqual([user("accept"), accepted, user("reject")]);
			expect.soft(captured).toHaveLength(2);
			const filePath = live.session!.filePath;
			live.close();
			const reopened = SessionStore.open(filePath);
			expect(reopened.header.version).toBe(1);
			expect.soft(reopened.buildContext().messages).toEqual([user("accept"), accepted, user("reject")]);
			expect.soft(readFileSync(filePath, "utf8")).not.toMatch(/REJECTED_|rejected_/);

			const beforeResume = captured.length;
			const resumed = await createRunner({ ...options, resume: reopened.header.id, provider: provider() });
			onTestFinished(() => resumed.close());
			expect(resumed.session!.filePath).toBe(filePath);
			expect(resumed.providerName).toBe("openai-codex");
			expect(resumed.modelReference()).toBe(TARGET);
			await resumed.runTurn({ userMessage: "resume" });
			expect(captured).toHaveLength(beforeResume + 1);
			const serialized = captured.at(-1)!;
			const body = JSON.parse(serialized) as { model: string; input: Fields[] };
			expect(body.model).toBe(MODEL);
			const nativeText = {
				...text,
				content: [{ type: "output_text", text: "ACCEPTED_TEXT", annotations: [] }, text.content[1]],
			};
			expect(body.input).toEqual(expect.arrayContaining([reasoning, nativeText]));
			expect
				.soft(body.input.filter((item) => item.type !== "additional_tools"))
				.toEqual([
					{ role: "user", content: [{ type: "input_text", text: "accept" }] },
					reasoning,
					nativeText,
					{ role: "user", content: [{ type: "input_text", text: "reject" }] },
					{ role: "user", content: [{ type: "input_text", text: "resume" }] },
				]);
			expect.soft(serialized).not.toMatch(/REJECTED_|rejected_/);
		},
	);
	it("round-trips version-1 session/resume/child/compaction native fields without a format bump", async () => {
		const root = mkTempDir("ink-session-");
		const message = replayMessage();
		const parent = createSession(root, root);
		parent.appendMessage(user("work"));
		parent.appendMessage(message);
		const reopened = SessionStore.open(parent.filePath);
		expect(reopened.header.version).toBe(1);
		expect(reopened.buildContext().messages[1]).toEqual(message);
		const child = createChildSession(reopened, root);
		await runSubagent({
			provider: scriptedProvider(
				[message, assistant([{ type: "text", text: "child done" }])],
				undefined,
				"openai-codex",
			),
			model: MODEL,
			system: "",
			tools: [],
			prompt: "child",
			autoCompact: false,
			session: child,
			onMessage: (value) => {
				child.appendMessage(value);
			},
		});
		const childMessage = SessionStore.open(child.filePath)
			.buildContext()
			.messages.find((m) => m.role === "assistant");
		expect(childMessage).toMatchObject({ provenance: message.provenance, blocks: message.blocks });
		reopened.appendMessage(user("recent"));
		reopened.appendMessage({ ...message, blocks: message.blocks.map((b) => ({ ...b })) });
		await compactSession({
			session: reopened,
			provider: scriptedProvider([assistant([{ type: "text", text: "checkpoint" }])]),
			model: MODEL,
			settings: { reserveTokens: 32, keepRecentTokens: 1, contextWindow: 10000 },
		});
		const resumed = SessionStore.open(parent.filePath).buildContext();
		expect(resumed.messages.at(-1)).toEqual(message);
		expect(
			toResponsesInput(resumed.messages, MODEL).some((item) => "type" in item && item.type === "reasoning"),
		).toBe(true);
		expect(readFileSync(parent.filePath, "utf8")).not.toContain('"rawResponse"');
	});
	it("uses reported output as an exact-target floor, never ciphertext length", () => {
		const message = replayMessage();
		expect(estimateTokens(message, TARGET)).toBe(512);
		const reasoning = message.blocks[0]!;
		Object.assign(reasoning.responses!, { encryptedContent: "x".repeat(100000) });
		expect(estimateTokens(message, TARGET)).toBe(512);
		expect(estimateContextTokens([message], 1, TARGET)).toEqual({ tokens: 512, measured: false });
		expect(estimateTokens(message)).toBeLessThan(512);
		expect(serializeForSummary([message])).not.toMatch(/OPAQUE|encryptedContent|rs_1|exposed summary/);
	});
	it.each(["explicit", "derived"])(
		"%s compaction target controls cut points, tokensBefore and retained tokensAfter",
		async (mode) => {
			const message = replayMessage();
			message.usage.inputTokens = 99999; // never a post-compaction anchor
			const messages = [user("old"), user("q".repeat(400)), message, user("next")];
			const canonical = estimateTokens(message);
			expect(findCutIndex(messages, 100, TARGET)).toBe(2);
			expect(findCutIndex(messages, 100, `openai/${MODEL}`)).toBe(1);
			expect(findCutIndex(messages, 100)).toBe(1);
			for (const target of [TARGET, `openai/${MODEL}`]) {
				const sink: LLMRequest[] = [];
				const providerName = target.slice(0, target.indexOf("/"));
				const result = await compactHistory({
					messages,
					provider: scriptedProvider(
						[assistant([{ type: "text", text: "summary" }])],
						sink,
						mode === "derived" ? providerName : "not-the-selected-family",
					),
					model: MODEL,
					...(mode === "explicit" && { modelReference: target }),
					settings: { reserveTokens: 32, keepRecentTokens: 100, contextWindow: 131072 },
				});
				const matching = target === TARGET;
				expect(result?.retainedTail).toEqual(messages.slice(matching ? 2 : 1));
				expect(result?.retainedTail.find((value) => value.role === "assistant")).toBe(message);
				expect(result?.tokensBefore).toBe(matching ? 100512 : 102 + canonical);
				expect(result?.tokensAfter).toBe(matching ? 515 : 103 + canonical);
				// Summary tokens are canonical, not the summarizer's reported usage.
				expect(JSON.stringify(sink[0]?.messages)).not.toMatch(/OPAQUE_CIPHERTEXT|encryptedContent|rs_1/);
			}
		},
	);

	it("cut selection and tokensAfter use history-wide duplicate eligibility rather than isolated floors", async () => {
		const first = encryptedMessage("rs_shared", 10000);
		const duplicate = encryptedMessage("rs_shared", 92000);
		const messages = [user("old"), user("q".repeat(400)), first, duplicate];
		expect(findCutIndex(messages, 1000, TARGET)).toBe(2); // duplicate alone cannot fill the keep window
		expect(findCutIndex(messages, 1000)).toBe(0);
		const requests: LLMRequest[] = [];
		const result = await compactHistory({
			messages,
			provider: scriptedProvider([assistant([{ type: "text", text: "summary" }])], requests),
			model: MODEL,
			modelReference: TARGET,
			settings: { reserveTokens: 32, keepRecentTokens: 1000, contextWindow: 131072 },
		});
		expect(result?.retainedTail).toEqual([first, duplicate]);
		expect(result?.tokensBefore).toBe(12001);
		expect(result?.tokensAfter).toBe(2003); // 2 summary + 2000 first + 1 canonical duplicate
		expect(estimateContextTokens([user("summary"), ...result!.retainedTail], 3, TARGET)).toEqual({
			tokens: 2003,
			measured: false,
		});
		expect(() => toResponsesInput(result!.retainedTail, MODEL)).toThrow("Codex replay metadata is malformed");
		expect(JSON.stringify(requests[0]?.messages)).not.toContain("CIPHER");
	});

	it("tokensAfter revalidates native IDs against only the new summary and retained tail", async () => {
		const first = encryptedMessage("rs_shared", 10000);
		const retained = encryptedMessage("rs_shared", 92000);
		const messages = [user("old"), first, user("new"), retained, user("next")];
		expect(findCutIndex(messages, 1, TARGET)).toBe(4);
		const result = await compactHistory({
			messages,
			provider: scriptedProvider([assistant([{ type: "text", text: "summary" }])]),
			model: MODEL,
			modelReference: TARGET,
			// The last user costs 1 token, the duplicate's canonical thinking costs
			// another 1: retaining 2 removes the earlier native ID reservation.
			settings: { reserveTokens: 32, keepRecentTokens: 2, contextWindow: 131072 },
		});
		expect(result?.retainedTail).toEqual([retained, messages[4]]);
		expect(result?.tokensBefore).toBe(12003);
		expect(result?.tokensAfter).toBe(2003);
		expect(() => toResponsesInput(result!.retainedTail, MODEL)).not.toThrow();
		expect(estimateContextTokens([user("summary"), ...result!.retainedTail], 3, TARGET)).toEqual({
			tokens: 2003,
			measured: false,
		});
	});

	it.each([TARGET, `openai/${MODEL}`])(
		"compactSession forwards explicit target %s and boundary without changing retained metadata",
		async (modelReference) => {
			const root = mkTempDir("ink-session-");
			const session = createSession(root, root);
			const native = replayMessage();
			native.usage.inputTokens = 99999;
			session.appendMessage(user("old"));
			session.appendMessage(user("q".repeat(400)));
			session.appendMessage(native);
			session.appendMessage(user("next"));
			const result = await compactSession({
				session,
				provider: scriptedProvider([assistant([{ type: "text", text: "summary" }])], undefined, "mock"),
				model: MODEL,
				modelReference,
				settings: { reserveTokens: 32, keepRecentTokens: 100, contextWindow: 131072 },
			});
			expect(result?.retainedCount).toBe(modelReference === TARGET ? 2 : 3);
			const reopened = SessionStore.open(session.filePath);
			const context = reopened.buildContext();
			expect(context.messages.find((message) => message.role === "assistant")).toEqual(native);
			const estimated = estimateContextTokens(context.messages, context.compactionBoundary, TARGET);
			expect(estimated.measured).toBe(false);
			expect(estimated.tokens).toBe(
				context.messages.reduce((sum, message) => sum + estimateTokens(message, TARGET), 0),
			);
			expect(toResponsesInput(context.messages, MODEL).some((item) => "encrypted_content" in item)).toBe(
				true,
			);
		},
	);

	it("session boundary excludes stale native usage but still counts retained ciphertext on compaction", async () => {
		const root = mkTempDir("ink-session-");
		const session = createSession(root, root);
		const native = replayMessage();
		native.usage.inputTokens = 99999;
		session.appendMessage(user("old"));
		session.appendCompaction("first checkpoint", [native], 100511);
		session.appendMessage(user("new work"));
		const context = session.buildContext();
		const requests: LLMRequest[] = [];
		const result = await compactSession({
			session,
			provider: scriptedProvider([assistant([{ type: "text", text: "updated" }])], requests),
			model: MODEL,
			modelReference: TARGET,
			settings: { reserveTokens: 32, keepRecentTokens: 1, contextWindow: 131072 },
		});
		expect(result?.tokensBefore).toBe(
			context.messages.reduce((sum, message) => sum + estimateTokens(message, TARGET), 0),
		);
		expect(result?.tokensBefore).toBeLessThan(100511);
		expect(JSON.stringify(requests[0]?.messages)).not.toMatch(/OPAQUE_CIPHERTEXT|encryptedContent|rs_1/);
	});

	it("derives a direct session estimate target without inventing a persisted pricing stamp", async () => {
		const root = mkTempDir("ink-session-");
		const session = createSession(root, root);
		const native = replayMessage();
		session.appendMessage(user("old"));
		session.appendMessage(user("q".repeat(400)));
		session.appendMessage(native);
		const result = await compactSession({
			session,
			provider: scriptedProvider([assistant([{ type: "text", text: "summary" }])], undefined, "openai-codex"),
			model: MODEL,
			settings: { reserveTokens: 32, keepRecentTokens: 100, contextWindow: 131072 },
		});
		expect(result?.retainedCount).toBe(1);
		expect(result?.tokensAfter).toBe(514);
		const entry = session.getEntries().at(-1);
		expect(entry?.type).toBe("compaction");
		expect(entry).not.toHaveProperty("modelReference");
	});

	it("does not compact when only the current native message reaches the keep window", async () => {
		const message = replayMessage();
		const requests: LLMRequest[] = [];
		expect(
			await compactHistory({
				messages: [message],
				provider: scriptedProvider([assistant([{ type: "text", text: "unused" }])], requests),
				model: MODEL,
				modelReference: TARGET,
				settings: { reserveTokens: 32, keepRecentTokens: 100, contextWindow: 131072 },
			}),
		).toBeNull();
		expect(requests).toHaveLength(0);
	});

	it("new summary messages never inherit native replay fields or summarizer usage floors", async () => {
		const requests: LLMRequest[] = [];
		const summarizer = replayMessage();
		summarizer.blocks = [summarizer.blocks[0]!, { type: "text", text: "summary" }];
		summarizer.usage = { inputTokens: 99999, outputTokens: 10000 };
		const result = await compactHistory({
			messages: [user("old"), replayMessage(), user("next")],
			provider: scriptedProvider([summarizer], requests),
			model: MODEL,
			modelReference: TARGET,
			settings: { reserveTokens: 32, keepRecentTokens: 1, contextWindow: 131072 },
		});
		expect(result?.summary).toBe("summary");
		expect(result?.tokensAfter).toBe(3); // 2 summary tokens + 1 retained user token
		expect(result?.usage.outputTokens).toBe(10000); // accounting only
		expect(JSON.stringify(requests[0]?.messages)).not.toMatch(
			/OPAQUE_CIPHERTEXT|responses|provenance|rs_1|exposed summary/,
		);
		const summary = summaryToMessage(result!.summary);
		expect(summary).not.toHaveProperty("usage");
		expect(summary).not.toHaveProperty("provenance");
		expect(estimateContextTokens([summary], 0, TARGET)).toEqual({
			tokens: estimateTokens(summary),
			measured: false,
		});
	});

	it("persists final corrected text, never stale deltas, for both summary paths", async () => {
		const summarizer = () =>
			createCodexResponsesProvider({
				auth: async () => ({ accessToken: "fake" }),
				fetch: async (_url, init) => {
					expect(String(init?.body)).not.toContain("OPAQUE_CIPHERTEXT");
					return response([
						added(0, { type: "message", id: "sum" }),
						event("response.output_text.delta", { output_index: 0, delta: "stale summary" }),
						completed({
							output: [
								{
									type: "message",
									id: "sum",
									content: [{ type: "output_text", text: "correct final summary" }],
								},
							],
						}),
					]);
				},
			});
		const messages: AgentMessage[] = [user("old"), replayMessage(), user("recent")];
		expect(
			(
				await compactHistory({
					messages,
					provider: summarizer(),
					model: MODEL,
					settings: { reserveTokens: 32, keepRecentTokens: 1, contextWindow: 10000 },
				})
			)?.summary,
		).toBe("correct final summary");
		expect((await summarizeBranchSegment({ messages, provider: summarizer(), model: MODEL })).summary).toBe(
			"correct final summary",
		);
	});
	it("rejects an empty final summary even when stale deltas were nonempty", async () => {
		const provider = {
			name: "mock",
			async *stream(): AsyncIterable<LLMEvent> {
				yield { type: "text_delta", text: "stale" };
				yield { type: "message_end", message: assistant([{ type: "text", text: "" }]) };
			},
		};
		await expect(summarizeBranchSegment({ messages: [user("old")], provider, model: MODEL })).rejects.toThrow(
			"returned nothing",
		);
	});
	it("recognizes structured context overflow without relying on diagnostic text", () => {
		expect(
			isContextOverflowError(new CodexResponseError("request rejected", { code: "context_length_exceeded" })),
		).toBe(true);
	});
});
