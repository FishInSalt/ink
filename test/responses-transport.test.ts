import { createServer } from "node:http";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAgentLoop } from "../src/core/loop.js";
import { CodexResponseError, createCodexResponsesProvider } from "../src/provider/codex-responses.js";
import { postResponses } from "../src/provider/responses-transport.js";
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
	it("bounds network retries to five attempts and never exposes the network error", async () => {
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
		expect((error as Error).message).toContain("5 attempts");
		expect(calls).toBe(5);
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

describe("pre-stream retry budget", () => {
	const post = (fetchImpl: typeof fetch, signal?: AbortSignal, redactions?: string[]) =>
		postResponses({
			url: "https://api.openai.com/v1/responses",
			headers: { "content-type": "application/json" },
			body: "{}",
			signal,
			fetch: fetchImpl,
			redactions,
		});

	const hangingFetch = () =>
		vi.fn<typeof globalThis.fetch>(
			(_url, init) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
						once: true,
					});
				}),
		);

	const jsonError = (status: number, code: string) =>
		new Response(JSON.stringify({ error: { code } }), { status });

	const stalled = (status: number) =>
		new Response(new ReadableStream<Uint8Array>({ start() {} }), { status });

	it("uses five attempts with 1/2/4/8 s pauses and a closed cause label", async () => {
		vi.useFakeTimers();
		const times: number[] = [];
		const fetchImpl = vi.fn<typeof globalThis.fetch>(async () => {
			times.push(Date.now());
			const error = new Error("PRIVATE_NETWORK_DATA");
			Object.defineProperty(error, "cause", { value: { code: "ECONNRESET" } });
			throw error;
		});
		const pending = post(fetchImpl).catch((error: unknown) => error);
		await vi.runAllTimersAsync();
		const error = (await pending) as Error;
		expect(error).toMatchObject({ code: "connection_failed", retryable: true });
		expect(error.message).toContain("5 attempts");
		expect(error.message).toContain("last: ECONNRESET");
		expect(error.message).not.toContain("PRIVATE_NETWORK_DATA");
		expect(fetchImpl).toHaveBeenCalledTimes(5);
		expect(times.slice(1).map((time, index) => time - times[index]!)).toEqual([1000, 2000, 4000, 8000]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("drops non-allowlisted, redacted, and unreadable cause codes", async () => {
		vi.useFakeTimers();
		const failWith = (error: Error) =>
			vi.fn<typeof globalThis.fetch>(async () => {
				throw error;
			});

		const shaped = new Error("PRIVATE_NETWORK_DATA");
		Object.defineProperty(shaped, "cause", { value: { code: "PRIVATE_NETWORK_DATA" } });
		let pending = post(failWith(shaped)).catch((error: unknown) => error);
		await vi.runAllTimersAsync();
		let error = (await pending) as Error;
		expect(error.message).toContain("5 attempts");
		expect(error.message).not.toContain("last:");
		expect(error.message).not.toContain("PRIVATE_NETWORK_DATA");

		const redacted = new Error("private");
		Object.defineProperty(redacted, "cause", { value: { code: "ECONNRESET" } });
		pending = post(failWith(redacted), undefined, ["ECONNRESET"]).catch((error: unknown) => error);
		await vi.runAllTimersAsync();
		error = (await pending) as Error;
		expect(error.message).toContain("5 attempts");
		expect(error.message).not.toContain("ECONNRESET");

		const hostile = new Error("private");
		Object.defineProperty(hostile, "cause", {
			get() {
				throw new Error("boom");
			},
		});
		pending = post(failWith(hostile)).catch((error: unknown) => error);
		await vi.runAllTimersAsync();
		error = (await pending) as Error;
		expect(error).toMatchObject({ code: "connection_failed", retryable: true });
		expect(error.message).toContain("5 attempts");
		expect(error.message).not.toContain("boom");
	});

	it("recovers on the fifth attempt", async () => {
		vi.useFakeTimers();
		let calls = 0;
		const fetchImpl = vi.fn<typeof globalThis.fetch>(async () => {
			calls++;
			if (calls < 5) throw new Error("transient");
			return ok();
		});
		const pending = post(fetchImpl);
		await vi.runAllTimersAsync();
		const response = await pending;
		expect(calls).toBe(5);
		expect(response).toBeInstanceOf(Response);
		await response?.body?.cancel().catch(() => {});
	});

	it("stops an all-timeout run at the 95 s opening budget after three attempts", async () => {
		vi.useFakeTimers();
		const fetchImpl = hangingFetch();
		const pending = post(fetchImpl).catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(30_000);
		await vi.advanceTimersByTimeAsync(1_000);
		await vi.advanceTimersByTimeAsync(30_000);
		await vi.advanceTimersByTimeAsync(2_000);
		await vi.advanceTimersByTimeAsync(30_000);
		await vi.advanceTimersByTimeAsync(2_000);
		const error = (await pending) as Error;
		expect(fetchImpl).toHaveBeenCalledTimes(3);
		expect(error.message).toContain("3 attempts");
		expect(error.message).toContain("last: deadline");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("labels a fifth-attempt timeout after four fast failures", async () => {
		vi.useFakeTimers();
		let calls = 0;
		const fetchImpl = vi.fn<typeof globalThis.fetch>((_url, init) => {
			calls++;
			if (calls < 5) return Promise.reject(new Error("fast"));
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
					once: true,
				});
			});
		});
		const pending = post(fetchImpl).catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(15_000);
		await vi.advanceTimersByTimeAsync(30_000);
		const error = (await pending) as Error;
		expect(fetchImpl).toHaveBeenCalledTimes(5);
		expect(error.message).toContain("5 attempts");
		expect(error.message).toContain("last: timeout");
	});

	it("lets the deadline abort a fifth hanging attempt", async () => {
		vi.useFakeTimers();
		let calls = 0;
		const fetchImpl = vi.fn<typeof globalThis.fetch>((_url, init) => {
			calls++;
			if (calls === 3 || calls === 4) return Promise.reject(new Error("fast"));
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
					once: true,
				});
			});
		});
		const pending = post(fetchImpl).catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(30_000);
		await vi.advanceTimersByTimeAsync(1_000);
		await vi.advanceTimersByTimeAsync(30_000);
		await vi.advanceTimersByTimeAsync(2_000);
		await vi.advanceTimersByTimeAsync(4_000);
		await vi.advanceTimersByTimeAsync(8_000);
		await vi.advanceTimersByTimeAsync(20_000);
		const error = (await pending) as Error;
		expect(fetchImpl).toHaveBeenCalledTimes(5);
		expect(error.message).toContain("5 attempts");
		expect(error.message).toContain("last: deadline");
	});

	it("returns null when the user aborts during the first network backoff", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		let calls = 0;
		const fetchImpl = vi.fn<typeof globalThis.fetch>(async () => {
			calls++;
			throw new Error("transient");
		});
		const pending = post(fetchImpl, controller.signal);
		await vi.advanceTimersByTimeAsync(0);
		controller.abort();
		await vi.runAllTimersAsync();
		expect(await pending).toBeNull();
		expect(calls).toBe(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("returns null when the user aborts a hanging attempt", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const fetchImpl = hangingFetch();
		const pending = post(fetchImpl, controller.signal);
		await vi.advanceTimersByTimeAsync(0);
		controller.abort();
		await vi.advanceTimersByTimeAsync(0);
		expect(await pending).toBeNull();
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("cancels the body and returns null when the user aborts as headers arrive", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const cancel = vi.fn<() => void>();
		const fetchImpl = vi.fn<typeof globalThis.fetch>(async () => {
			controller.abort();
			return new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 200 });
		});
		const pending = post(fetchImpl, controller.signal);
		await vi.advanceTimersByTimeAsync(0);
		expect(await pending).toBeNull();
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("keeps temporary admission retries at three attempts", async () => {
		vi.useFakeTimers();
		const fetchImpl = vi.fn<typeof globalThis.fetch>(async () => jsonError(503, "server_error"));
		const pending = post(fetchImpl).catch((error: unknown) => error);
		await vi.runAllTimersAsync();
		const error = await pending;
		expect(fetchImpl).toHaveBeenCalledTimes(3);
		expect(error).toMatchObject({ status: 503 });
	});

	it("applies each class schedule to mixed failures", async () => {
		vi.useFakeTimers();
		const times: number[] = [];
		const responses = [
			() => {
				throw new Error("network");
			},
			() => jsonError(503, "server_error"),
			() => {
				throw new Error("network");
			},
			() => {
				throw new Error("network");
			},
			() => ok(),
		];
		const fetchImpl = vi.fn<typeof globalThis.fetch>(async () => {
			times.push(Date.now());
			return responses.shift()!();
		});
		const pending = post(fetchImpl);
		await vi.runAllTimersAsync();
		const response = await pending;
		expect(response).toBeInstanceOf(Response);
		expect(fetchImpl).toHaveBeenCalledTimes(5);
		expect(times.slice(1).map((time, index) => time - times[index]!)).toEqual([1000, 600, 2000, 4000]);
		await response?.body?.cancel().catch(() => {});
	});

	it("stops when the admission class cap is exhausted in a mixed run", async () => {
		vi.useFakeTimers();
		const responses = [
			() => {
				throw new Error("network");
			},
			() => jsonError(503, "server_error"),
			() => jsonError(503, "server_error"),
			() => jsonError(503, "server_error"),
		];
		const fetchImpl = vi.fn<typeof globalThis.fetch>(async () => responses.shift()!());
		const pending = post(fetchImpl).catch((error: unknown) => error);
		await vi.runAllTimersAsync();
		const error = await pending;
		expect(fetchImpl).toHaveBeenCalledTimes(4);
		expect(error).toMatchObject({ status: 503 });
	});

	it("stops a mixed run at the shared five-attempt cap", async () => {
		vi.useFakeTimers();
		const responses = [
			() => jsonError(503, "server_error"),
			() => {
				throw new Error("network");
			},
			() => {
				throw new Error("network");
			},
			() => {
				throw new Error("network");
			},
			() => {
				throw new Error("network");
			},
		];
		const fetchImpl = vi.fn<typeof globalThis.fetch>(async () => responses.shift()!());
		const pending = post(fetchImpl).catch((error: unknown) => error);
		await vi.runAllTimersAsync();
		const error = (await pending) as Error;
		expect(fetchImpl).toHaveBeenCalledTimes(5);
		expect(error.message).toContain("5 attempts");
		expect(error).toMatchObject({ code: "connection_failed" });
	});

	it("lets a terminal 401 win when the deadline cuts its body read", async () => {
		vi.useFakeTimers();
		let calls = 0;
		const fetchImpl = vi.fn<typeof globalThis.fetch>((_url, init) => {
			calls++;
			if (calls <= 2) {
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
						once: true,
					});
				});
			}
			if (calls === 3) return Promise.reject(new Error("fast"));
			if (calls === 4) return Promise.resolve(stalled(503));
			return Promise.resolve(stalled(401));
		});
		const pending = post(fetchImpl).catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(30_000);
		await vi.advanceTimersByTimeAsync(1_000);
		await vi.advanceTimersByTimeAsync(30_000);
		await vi.advanceTimersByTimeAsync(2_000);
		await vi.advanceTimersByTimeAsync(4_000);
		await vi.advanceTimersByTimeAsync(15_000);
		await vi.advanceTimersByTimeAsync(600);
		await vi.advanceTimersByTimeAsync(12_400);
		const error = await pending;
		expect(fetchImpl).toHaveBeenCalledTimes(5);
		expect(error).toMatchObject({ status: 401 });
		expect((error as Error).message).toContain("ink login");
	});

	it("lets a retryable 503 reach the deadline when its body read is cut", async () => {
		vi.useFakeTimers();
		let calls = 0;
		const fetchImpl = vi.fn<typeof globalThis.fetch>((_url, init) => {
			calls++;
			if (calls <= 2) {
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
						once: true,
					});
				});
			}
			if (calls === 3) return Promise.reject(new Error("fast"));
			if (calls === 4) return Promise.resolve(stalled(503));
			return Promise.resolve(stalled(503));
		});
		const pending = post(fetchImpl).catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(30_000);
		await vi.advanceTimersByTimeAsync(1_000);
		await vi.advanceTimersByTimeAsync(30_000);
		await vi.advanceTimersByTimeAsync(2_000);
		await vi.advanceTimersByTimeAsync(4_000);
		await vi.advanceTimersByTimeAsync(15_000);
		await vi.advanceTimersByTimeAsync(600);
		await vi.advanceTimersByTimeAsync(12_400);
		const error = (await pending) as Error;
		expect(fetchImpl).toHaveBeenCalledTimes(5);
		expect(error).toMatchObject({ code: "connection_failed", retryable: true });
		expect(error.message).toContain("5 attempts");
		expect(error.message).toContain("last: deadline");
	});

	it("reports a stream interruption when an abort lands with the headers", async () => {
		vi.useFakeTimers();
		const fetchImpl = vi.fn<typeof globalThis.fetch>(
			(_url, _init) =>
				new Promise<Response>((resolve) => {
					setTimeout(() => {
						const body = new ReadableStream<Uint8Array>({
							start(controller) {
								const cause = Object.assign(new Error("other side closed"), {
									code: "UND_ERR_SOCKET",
								});
								controller.error(new TypeError("terminated", { cause }));
							},
						});
						resolve(
							new Response(body, {
								status: 200,
								headers: { "content-type": "text/event-stream" },
							}),
						);
					}, 30_000);
				}),
		);
		const provider = createCodexResponsesProvider({
			auth: async () => ({ accessToken: "fake" }),
			fetch: fetchImpl,
		});
		const pending = collect(provider.stream(req())).catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(30_000);
		const error = (await pending) as Error;
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(error.name).toBe("StreamInterruptedError");
		expect(error.message).toContain("stream interrupted");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("clears every timer after a successful response", async () => {
		vi.useFakeTimers();
		const fetchImpl = vi.fn<typeof globalThis.fetch>(async () => ok());
		const pending = post(fetchImpl);
		await vi.advanceTimersByTimeAsync(0);
		const response = await pending;
		expect(response).toBeInstanceOf(Response);
		expect(vi.getTimerCount()).toBe(0);
		await response?.body?.cancel().catch(() => {});
	});
});
