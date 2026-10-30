import { createServer } from "node:http";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAgentLoop } from "../src/core/loop.js";
import { CodexResponseError, createCodexResponsesProvider } from "../src/provider/codex-responses.js";
import type { LLMEvent, LLMRequest } from "../src/provider/types.js";

const req = (): LLMRequest => ({
	system: "sys",
	model: "gpt-5.5",
	messages: [{ role: "user", content: "hi" }],
	tools: [],
	maxTokens: 123,
});
const completed = { type: "response.completed", response: { status: "completed" } };
const sse = (events: unknown[]) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
// Bytes, not a string: Response(string) silently supplies text/plain and would
// not reproduce the production endpoint's genuinely absent Content-Type.
const bytes = (text: string) => new TextEncoder().encode(text);
const ok = () => new Response(sse([completed]), { headers: { "content-type": "text/event-stream" } });
async function collect(stream: AsyncIterable<LLMEvent>) {
	const out: LLMEvent[] = [];
	for await (const event of stream) out.push(event);
	return out;
}
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

describe("Responses endpoint and retry policy", () => {
	it("defaults to the official /v1/responses route and sends only the direct contract", async () => {
		vi.stubEnv("OPENAI_CODEX_BASE_URL", "https://api.openai.com/v1");
		let captured: RequestInit | undefined;
		let url: unknown;
		const provider = createCodexResponsesProvider({
			auth: async () => ({ accessToken: "fake-only" }),
			fetch: async (u, init) => {
				url = u;
				captured = init;
				return ok();
			},
		});
		await collect(provider.stream(req()));
		expect(url).toBe("https://api.openai.com/v1/responses");
		expect(captured?.redirect).toBe("manual");
		expect(captured?.headers).toEqual({
			"content-type": "application/json",
			accept: "text/event-stream",
			authorization: "Bearer fake-only",
		});
		const body = JSON.parse(String(captured?.body));
		expect(body).toMatchObject({
			store: false,
			stream: true,
			instructions: "sys",
			include: ["reasoning.encrypted_content"],
		});
		for (const key of [
			"previous_response_id",
			"temperature",
			"max_output_tokens",
			"configuration_update",
			"prompt_cache_retention",
			"tools",
		])
			expect(body).not.toHaveProperty(key);
	});
	it.each([
		undefined,
		"text/event-stream",
		"Text/Event-Stream; charset=UTF-8",
		"application/json",
		"text/plain",
		"application/octet-stream",
		"application/x-ndjson",
	])("validates SSE bytes rather than the media-type label %s", async (contentType) => {
		const item = {
			id: "msg_test",
			type: "message",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: "OK", annotations: [] }],
		};
		const response = new Response(
			bytes(
				sse([
					{
						type: "response.output_item.added",
						output_index: 0,
						item: { ...item, status: "in_progress", content: [] },
					},
					{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "OK" },
					{ type: "response.output_item.done", output_index: 0, item },
					{ type: "response.completed", response: { status: "completed", output: [item] } },
				]),
			),
			{ headers: contentType === undefined ? {} : { "content-type": contentType } },
		);
		expect(response.headers.get("content-type")).toBe(contentType ?? null);
		const fetch = vi.fn(async () => response);
		const provider = createCodexResponsesProvider({ auth: async () => ({ accessToken: "fake" }), fetch });
		const events = await collect(provider.stream(req()));
		expect(events.filter((event) => event.type === "text_delta")).toEqual([
			{ type: "text_delta", text: "OK" },
		]);
		expect(events.at(-1)).toMatchObject({
			type: "message_end",
			message: { blocks: [{ type: "text", text: "OK" }] },
		});
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	describe("body validation does not adapt JSON or relax tool safety", () => {
		const tool = {
			id: "fc_test",
			type: "function_call",
			call_id: "call_test",
			name: "probe",
			arguments: "{}",
		};
		const final = { type: "response.completed", response: { status: "completed", output: [tool] } };
		it.each([
			{ name: "JSON response", text: JSON.stringify(final.response) },
			{ name: "JSON terminal wrapper", text: JSON.stringify(final) },
			{
				name: "NDJSON events",
				text: [{ type: "response.output_item.done", output_index: 0, item: tool }, final]
					.map((event) => JSON.stringify(event))
					.join("\n"),
			},
			{ name: "HTML", text: "<html><body>Upstream page</body></html>" },
			{ name: "empty non-null stream", text: "" },
			{ name: "DONE alone", text: "data: [DONE]\n\n" },
			{ name: "malformed SSE", text: "data: {PRIVATE_PAYLOAD}\n\n" },
			{
				name: "unfinalized call",
				text: sse([{ type: "response.output_item.added", output_index: 0, item: tool }, completed]),
			},
			{ name: "terminal-only call", text: sse([final]) },
		])("$name cannot complete a message or execute tools without a media type", async ({ text }) => {
			const fetch = vi.fn(async () => new Response(bytes(text)));
			const execute = vi.fn(async () => ({ output: "must not execute" }));
			const events: LLMEvent[] = [];
			const provider = createCodexResponsesProvider({ auth: async () => ({ accessToken: "fake" }), fetch });
			await expect(
				runAgentLoop({
					provider,
					model: req().model,
					system: req().system,
					history: [],
					userMessage: "hi",
					tools: [{ name: "probe", description: "test only", parameters: Type.Object({}), execute }],
					onEvent: (event) => {
						if (event.type === "message_end") events.push(event);
					},
				}),
			).rejects.toBeInstanceOf(CodexResponseError);
			expect(events).toEqual([]);
			expect(execute).not.toHaveBeenCalled();
			expect(fetch).toHaveBeenCalledTimes(1);
		});
	});

	it("executes and replays a finalized call with no media type and empty terminal aggregates", async () => {
		const tool = {
			id: "fc_test",
			type: "function_call",
			call_id: "call_test",
			name: "probe",
			arguments: '{"text":"OK"}',
			status: "completed",
		};
		const text = {
			id: "msg_test",
			type: "message",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: "OK" }],
		};
		const captured: Record<string, unknown>[] = [];
		const replies = [
			[
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { ...tool, arguments: "", status: "in_progress" },
				},
				{
					type: "response.function_call_arguments.delta",
					output_index: 0,
					item_id: tool.id,
					delta: tool.arguments,
				},
				{
					type: "response.function_call_arguments.done",
					output_index: 0,
					item_id: tool.id,
					arguments: tool.arguments,
				},
				{ type: "response.output_item.done", output_index: 0, item: tool },
				{ type: "response.completed", response: { status: "completed", output: [] } },
			],
			[
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { ...text, content: [], status: "in_progress" },
				},
				{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "OK" },
				{ type: "response.output_item.done", output_index: 0, item: text },
				{ type: "response.completed", response: { status: "completed", output: [] } },
			],
		];
		const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
			captured.push(JSON.parse(String(init?.body)));
			const reply = replies.shift();
			if (!reply) throw new Error("unexpected fixture request");
			return new Response(bytes(sse(reply)));
		});
		const execute = vi.fn(async (_args: Record<string, unknown>) => ({ output: "OK" }));
		const events: LLMEvent[] = [];
		const provider = createCodexResponsesProvider({ auth: async () => ({ accessToken: "fake" }), fetch });
		await expect(
			runAgentLoop({
				provider,
				model: req().model,
				system: req().system,
				history: [],
				userMessage: "hi",
				tools: [
					{
						name: "probe",
						description: "test only",
						parameters: Type.Object({ text: Type.String() }),
						execute,
					},
				],
				onEvent: (event) => {
					if (event.type === "message_end") events.push(event);
				},
			}),
		).resolves.toMatchObject({ stopReason: "completed", turns: 2 });
		expect(execute).toHaveBeenCalledTimes(1);
		expect(execute.mock.calls[0]?.[0]).toEqual({ text: "OK" });
		expect(events).toHaveLength(2);
		expect(captured[1]?.input).toEqual(
			expect.arrayContaining([
				{
					type: "function_call",
					id: tool.id,
					call_id: tool.call_id,
					name: tool.name,
					arguments: tool.arguments,
				},
				{ type: "function_call_output", call_id: tool.call_id, output: "OK" },
			]),
		);
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it.each([
		{ value: "req_test", expected: "req_test" },
		{ value: "req unsafe", expected: undefined },
		{ value: "x".repeat(161), expected: undefined },
		{ value: "req_fake-sensitive-token", expected: undefined },
	])("reports a null body with bounded, redacted diagnostics ($expected)", async ({ value, expected }) => {
		const fetch = vi.fn(async () => new Response(null, { headers: { "x-request-id": value } }));
		const provider = createCodexResponsesProvider({
			auth: async () => ({ accessToken: "fake-sensitive-token" }),
			fetch,
		});
		await expect(collect(provider.stream(req()))).rejects.toMatchObject({
			status: 200,
			code: "invalid_response",
			requestId: expected,
			message: "Invalid Codex response 200: expected a response stream body",
			retryable: false,
		});
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("cancels a missing-media-type reader immediately at a terminal event", async () => {
		const cancel = vi.fn();
		const provider = createCodexResponsesProvider({
			auth: async () => ({ accessToken: "fake" }),
			fetch: async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(bytes(sse([completed])));
						},
						cancel,
					}),
				),
		});
		expect((await collect(provider.stream(req()))).at(-1)?.type).toBe("message_end");
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	it("cancels a pending missing-media-type stream without completing a message", async () => {
		const controller = new AbortController();
		const cancel = vi.fn();
		const provider = createCodexResponsesProvider({
			auth: async () => ({ accessToken: "fake" }),
			fetch: async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start() {
							setTimeout(() => controller.abort(), 0);
						},
						cancel,
					}),
				),
		});
		expect(await collect(provider.stream({ ...req(), signal: controller.signal }))).toEqual([]);
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	it.each([
		"http://example.com/v1",
		"https://user:password@example.com/v1",
		"https://example.com/v1#fragment",
		"https://example.com/v1?query=x",
		"file:///tmp/v1",
	])("rejects unsafe endpoint %s", (baseUrl) => {
		expect(() =>
			createCodexResponsesProvider({ baseUrl, auth: async () => ({ accessToken: "fake" }) }),
		).toThrow(CodexResponseError);
	});
	it("requires explicit endpoint plus test injection for loopback HTTP", () => {
		vi.stubEnv("OPENAI_CODEX_BASE_URL", "http://127.0.0.1:5555/v1");
		expect(() => createCodexResponsesProvider({ auth: async () => ({ accessToken: "fake" }) })).toThrow(
			CodexResponseError,
		);
		expect(() => createCodexResponsesProvider({ baseUrl: "http://127.0.0.1:5555/v1" })).toThrow(
			CodexResponseError,
		);
		expect(() =>
			createCodexResponsesProvider({
				baseUrl: "http://127.0.0.1:5555/v1",
				auth: async () => ({ accessToken: "fake" }),
			}),
		).not.toThrow();
	});
	it("does not follow a credential-bearing redirect even to the same loopback server", async () => {
		const paths: string[] = [];
		const server = createServer((request, res) => {
			paths.push(request.url ?? "");
			res.writeHead(307, { location: "/redirect-target" });
			res.end();
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("fixture address missing");
			const provider = createCodexResponsesProvider({
				baseUrl: `http://127.0.0.1:${address.port}/v1`,
				auth: async () => ({ accessToken: "fake" }),
			});
			await expect(collect(provider.stream(req()))).rejects.toMatchObject({
				status: 307,
				code: "redirect_rejected",
			});
			expect(paths).toEqual(["/v1/responses"]);
		} finally {
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			});
		}
	});
	it.each([
		{ status: 429, code: "subscription_sharing_usage_limit_exceeded" },
		{ status: 429, code: "insufficient_quota" },
		{ status: 403, code: "subscription_sharing_user_not_eligible" },
		{ status: 400, code: "subscription_sharing_unsupported_capability" },
		{ status: 503, code: "billing_hard_limit_reached" },
	])("never retries quota/policy failures ($code)", async ({ status, code }) => {
		let calls = 0;
		const provider = createCodexResponsesProvider({
			auth: async () => ({ accessToken: "fake" }),
			fetch: async () => {
				calls++;
				return new Response(
					JSON.stringify({ error: { code, param: "tools", message: "structured rejection" } }),
					{ status, headers: { "x-request-id": "req_test" } },
				);
			},
		});
		await expect(collect(provider.stream(req()))).rejects.toMatchObject({
			status,
			code,
			param: "tools",
			requestId: "req_test",
			retryable: false,
		});
		expect(calls).toBe(1);
	});
	it.each([
		{ status: 503, code: "subscription_sharing_usage_unavailable" },
		{ status: 503, code: "subscription_sharing_user_unavailable" },
		{ status: 429, code: "rate_limit_exceeded" },
		{ status: 503, code: undefined },
	])("bounded pre-stream retry for temporary failures ($status/$code)", async ({ status, code }) => {
		vi.useFakeTimers();
		let calls = 0;
		const provider = createCodexResponsesProvider({
			auth: async () => ({ accessToken: "fake" }),
			fetch: async () => {
				calls++;
				return calls < 3
					? new Response(
							JSON.stringify(code ? { error: { code } } : { detail: "temporary routing unavailable" }),
							{ status },
						)
					: ok();
			},
		});
		const pending = collect(provider.stream(req()));
		await vi.runAllTimersAsync();
		expect((await pending).at(-1)?.type).toBe("message_end");
		expect(calls).toBe(3);
	});
	it("does not retry an unclassified 429 or quota admission detail", async () => {
		for (const body of [
			{ detail: "app usage limit reached" },
			{ detail: "unclassified admission" },
			{ error: { type: "insufficient_quota" } },
		]) {
			let calls = 0;
			const provider = createCodexResponsesProvider({
				auth: async () => ({ accessToken: "fake" }),
				fetch: async () => {
					calls++;
					return new Response(JSON.stringify(body), { status: 429 });
				},
			});
			await expect(collect(provider.stream(req()))).rejects.toMatchObject({ status: 429, retryable: false });
			expect(calls).toBe(1);
		}
	});
	it("redacts the injected credential from HTTP and SSE server diagnostics", async () => {
		for (const streamed of [true, false]) {
			const secret = "fake-sensitive-token";
			const error = { code: "invalid_request", message: `rejected ${secret}\\nBearer ${secret}` };
			const provider = createCodexResponsesProvider({
				auth: async () => ({ accessToken: secret }),
				fetch: async () =>
					streamed
						? new Response(`data: ${JSON.stringify({ type: "response.failed", response: { error } })}\n\n`, {
								headers: { "content-type": "text/event-stream" },
							})
						: new Response(JSON.stringify({ error }), { status: 400 }),
			});
			const caught = await collect(provider.stream(req())).catch((error: unknown) => error);
			expect(caught).toBeInstanceOf(CodexResponseError);
			expect((caught as Error).message).not.toContain(secret);
		}
	});
	it("preserves detail-only admission status and teaches login without retry", async () => {
		const provider = createCodexResponsesProvider({
			auth: async () => ({ accessToken: "fake" }),
			fetch: async () => new Response('{"detail":"permission denied"}', { status: 401 }),
		});
		await expect(collect(provider.stream(req()))).rejects.toMatchObject({
			status: 401,
			code: undefined,
			message: expect.stringContaining("ink login"),
		});
	});
	it("never retries a failed stream after text was exposed", async () => {
		let calls = 0;
		const events = [
			{ type: "response.output_item.added", output_index: 0, item: { type: "message" } },
			{ type: "response.output_text.delta", output_index: 0, delta: "partial" },
			{ type: "response.failed", response: { error: { code: "subscription_sharing_usage_unavailable" } } },
		];
		const provider = createCodexResponsesProvider({
			auth: async () => ({ accessToken: "fake" }),
			fetch: async () => {
				calls++;
				return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), {
					headers: { "content-type": "text/event-stream" },
				});
			},
		});
		await expect(collect(provider.stream(req()))).rejects.toMatchObject({
			code: "subscription_sharing_usage_unavailable",
		});
		expect(calls).toBe(1);
	});
	it.each([undefined, "content_filter", "unknown"])(
		"does not treat incomplete reason %s as max_tokens",
		async (reason) => {
			const terminal = {
				type: "response.incomplete",
				response: { status: "incomplete", incomplete_details: reason === undefined ? undefined : { reason } },
			};
			const provider = createCodexResponsesProvider({
				auth: async () => ({ accessToken: "fake" }),
				fetch: async () =>
					new Response(`data: ${JSON.stringify(terminal)}\n\n`, {
						headers: { "content-type": "text/event-stream" },
					}),
			});
			await expect(collect(provider.stream(req()))).rejects.toMatchObject({
				reason: reason ?? "unknown_incomplete",
			});
		},
	);
	it.each([
		{ type: "response.cancelled", response: { status: "cancelled" }, reason: "cancelled" },
		{ type: "response.failed", response: { error: { code: "content_filter" } }, reason: "failed" },
		{ type: "response.completed", response: { status: "cancelled" }, reason: "cancelled" },
	])(
		"throws typed terminal failures for $type/$reason without message_end",
		async ({ type, response, reason }) => {
			const provider = createCodexResponsesProvider({
				auth: async () => ({ accessToken: "fake" }),
				fetch: async () =>
					new Response(`data: ${JSON.stringify({ type, response })}\n\n`, {
						headers: { "content-type": "text/event-stream", "x-request-id": "req_test" },
					}),
			});
			await expect(collect(provider.stream(req()))).rejects.toMatchObject({
				status: 200,
				reason,
				requestId: "req_test",
			});
		},
	);
	it("cancels pending error-body reads promptly on abort", async () => {
		const controller = new AbortController();
		let cancelled = false;
		const provider = createCodexResponsesProvider({
			auth: async () => ({ accessToken: "fake" }),
			fetch: async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start() {
							setTimeout(() => controller.abort(), 0);
						},
						cancel() {
							cancelled = true;
						},
					}),
					{ status: 503 },
				),
		});
		expect(await collect(provider.stream({ ...req(), signal: controller.signal }))).toEqual([]);
		expect(cancelled).toBe(true);
	});
	it("a malformed frame or [DONE]/EOF alone cannot complete a turn", async () => {
		for (const text of ["data: {private-secret}\n\n", "data: [DONE]\n\n", ": ping\n\n"]) {
			const provider = createCodexResponsesProvider({
				auth: async () => ({ accessToken: "fake" }),
				fetch: async () => new Response(text, { headers: { "content-type": "text/event-stream" } }),
			});
			await expect(collect(provider.stream(req()))).rejects.toBeInstanceOf(CodexResponseError);
		}
	});
	it.each(["\n", "\r\n"])(
		"ignores invalid UTF-8 only after a terminal frame regardless of chunking (%j)",
		async (newline) => {
			const terminal = new TextEncoder().encode(
				`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}${newline}${newline}`,
			);
			const joined = new Uint8Array([...terminal, 0xff]);
			for (let split = 0; split <= joined.length; split++) {
				const provider = createCodexResponsesProvider({
					auth: async () => ({ accessToken: "fake-utf8" }),
					fetch: async () =>
						new Response(
							new ReadableStream<Uint8Array>({
								start(controller) {
									controller.enqueue(joined.subarray(0, split));
									controller.enqueue(joined.subarray(split));
									controller.close();
								},
							}),
							{ headers: { "content-type": "text/event-stream" } },
						),
				});
				expect((await collect(provider.stream(req()))).map((event) => event.type)).toEqual(["message_end"]);
			}
		},
	);
	it("rejects invalid UTF-8 before the terminal frame rather than returning a successful message", async () => {
		const terminal = new TextEncoder().encode(
			'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
		);
		const provider = createCodexResponsesProvider({
			auth: async () => ({ accessToken: "fake-utf8" }),
			fetch: async () =>
				new Response(new Uint8Array([0xff, ...terminal]), {
					headers: { "content-type": "text/event-stream" },
				}),
		});
		await expect(collect(provider.stream(req()))).rejects.toThrow("invalid UTF-8 frame");
	});
	it("bounds network retries to three attempts and never exposes the network error", async () => {
		vi.useFakeTimers();
		let calls = 0;
		const provider = createCodexResponsesProvider({
			auth: async () => ({ accessToken: "fake" }),
			fetch: async () => {
				calls++;
				throw new Error("PRIVATE_NETWORK_DATA");
			},
		});
		const pending = collect(provider.stream(req())).catch((error: unknown) => error);
		await vi.runAllTimersAsync();
		const error = await pending;
		expect(error).toMatchObject({ code: "connection_failed", retryable: true });
		expect((error as Error).message).not.toContain("PRIVATE_NETWORK_DATA");
		expect(calls).toBe(3);
	});
	it("passes cancellation through auth and ends without connecting", async () => {
		const controller = new AbortController();
		let connected = false;
		const provider = createCodexResponsesProvider({
			auth: async (options) => {
				expect(options?.signal).toBe(controller.signal);
				controller.abort();
				return { accessToken: "fake" };
			},
			fetch: async () => {
				connected = true;
				return ok();
			},
		});
		expect(await collect(provider.stream({ ...req(), signal: controller.signal }))).toEqual([]);
		expect(connected).toBe(false);
	});
	it("an abort during backoff stops before a second request", async () => {
		const controller = new AbortController();
		let calls = 0;
		const provider = createCodexResponsesProvider({
			auth: async () => ({ accessToken: "fake" }),
			fetch: async () => {
				calls++;
				controller.abort();
				return new Response('{"error":{"code":"rate_limit_exceeded"}}', { status: 429 });
			},
		});
		expect(await collect(provider.stream({ ...req(), signal: controller.signal }))).toEqual([]);
		expect(calls).toBe(1);
	});
});
