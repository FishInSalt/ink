import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compactSession, summarizeBranchSegment } from "../src/core/compaction.js";
import { type AgentEvent, runAgentLoop } from "../src/core/loop.js";
import type { AgentMessage } from "../src/core/messages.js";
import { createSession } from "../src/core/session/manager.js";
import { getCodexAccessToken } from "../src/provider/codex-auth.js";
import { CodexResponseError, createCodexResponsesProvider } from "../src/provider/codex-responses.js";
import { StreamInterruptedError } from "../src/provider/shared.js";
import type { LLMEvent, LLMRequest } from "../src/provider/types.js";
import { mkTempDir } from "./helpers/mktemp.js";

// Even an accidental default-auth path must never inspect a credential file.
vi.mock("../src/provider/codex-auth.js", () => ({
	getCodexAccessToken: vi.fn(() => {
		throw new Error("Credential reads forbidden in Fast transport tests");
	}),
}));

const TOKEN = "fake-subscription-access";
const ENDPOINT = "https://api.openai.com/v1/responses";
const FAST_HINT = "To retry without Fast, explicitly select the normal model with /model.";
const request = (fields: Partial<LLMRequest> = {}): LLMRequest => ({
	system: "system",
	model: "gpt-5.5",
	messages: [{ role: "user", content: "hello" }],
	tools: [],
	maxTokens: 1024,
	speed: "fast",
	...fields,
});
const frame = (type: string, fields: Record<string, unknown> = {}) => ({ type, ...fields });
const terminal = (kind = "completed", tier: unknown = "priority", fields: Record<string, unknown> = {}) =>
	frame(`response.${kind}`, {
		response: {
			status: kind,
			service_tier: tier,
			...(kind === "incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
			...fields,
		},
	});
const streamResponse = (frames: unknown[]) =>
	new Response(frames.map((value) => `data: ${JSON.stringify(value)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream", "x-request-id": "req_fast" },
	});
const jsonError = (status: number, code?: string, param?: string, message = "Request refused") =>
	new Response(JSON.stringify({ error: { code, param, message } }), {
		status,
		headers: { "x-request-id": "req_admission" },
	});
function harness(replies: Array<() => Response | Promise<Response>> = [() => streamResponse([terminal()])]) {
	const auth = vi.fn(async () => ({ accessToken: TOKEN }));
	const fetch = vi.fn<typeof globalThis.fetch>(async () => {
		const reply = replies.shift();
		if (!reply) throw new Error("Unexpected fallback or extra inference request");
		return reply();
	});
	return {
		auth,
		fetch,
		provider: createCodexResponsesProvider({ baseUrl: "https://api.openai.com/v1", auth, fetch }),
	};
}
function body(init: RequestInit | undefined): Record<string, unknown> {
	return JSON.parse(String(init?.body)) as Record<string, unknown>;
}
async function collect(stream: AsyncIterable<LLMEvent>, events: LLMEvent[] = []) {
	for await (const event of stream) events.push(event);
	return events;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("OPENAI_API_KEY", "fake-api-key-must-not-be-used");
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("Non-injected network or fallback forbidden");
		}),
	);
});
afterEach(() => {
	expect(getCodexAccessToken).not.toHaveBeenCalled();
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("Codex Fast raw request boundary", () => {
	it.each([null, false, true, "", "normal", "priority", "FAST", "fast ", 1, {}, []])(
		"rejects raw speed %j before injected auth, default auth, or HTTP",
		async (speed) => {
			const { provider, auth, fetch } = harness();
			const invalid = { ...request(), speed } as LLMRequest;
			await expect(collect(provider.stream(invalid))).rejects.toMatchObject({
				name: "CodexResponseError",
				code: "invalid_speed",
				param: "speed",
			});
			expect(invalid.speed).toBe(speed);
			expect(auth).not.toHaveBeenCalled();
			expect(fetch).not.toHaveBeenCalled();
			const defaultAuth = createCodexResponsesProvider({ baseUrl: "https://api.openai.com/v1", fetch });
			await expect(collect(defaultAuth.stream(invalid))).rejects.toHaveProperty("code", "invalid_speed");
		},
	);

	it.each([
		"",
		" ",
		"gpt-5.5 ",
		" gpt-5.5",
		"gpt\t5.5",
		"gpt\n5.5",
		"gpt\u00a05.5",
		"gpt-5.5·fast",
		"gpt-5.5·fast·fast",
		"gpt·future",
		null,
		undefined,
		42,
		{},
		[],
	])("rejects raw Fast model %j before auth or HTTP", async (model) => {
		const { provider, auth, fetch } = harness();
		const invalid = { ...request(), model } as LLMRequest;
		await expect(collect(provider.stream(invalid))).rejects.toMatchObject({
			name: "CodexResponseError",
			code: "invalid_model",
			param: "model",
		});
		expect(auth).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
		const defaultAuth = createCodexResponsesProvider({ baseUrl: "https://api.openai.com/v1", fetch });
		await expect(collect(defaultAuth.stream(invalid))).rejects.toHaveProperty("code", "invalid_model");
	});

	it.each(["gpt-5.5", "gpt-6-astra", "gpt-6.1-sol", "future-model-v99", "custom/base-v1"])(
		"accepts a structurally valid base %s without consulting capabilities",
		async (model) => {
			const { provider, auth, fetch } = harness();
			await collect(provider.stream(request({ model })));
			expect(auth).toHaveBeenCalledTimes(1);
			expect(fetch).toHaveBeenCalledTimes(1);
			expect(fetch.mock.calls[0]?.[0]).toBe(ENDPOINT);
			expect(body(fetch.mock.calls[0]?.[1])).toMatchObject({ model, service_tier: "priority" });
		},
	);

	it("a pre-aborted request performs no validation, authentication, or HTTP", async () => {
		const { provider, auth, fetch } = harness();
		const signal = AbortSignal.abort();
		expect(await collect(provider.stream(request({ model: "bad·fast", signal })))).toEqual([]);
		expect(auth).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe("Fast recovery hints preserve original errors", () => {
	async function rejectFromAuth(original: unknown, speed: LLMRequest["speed"]) {
		const auth = vi.fn(async () => {
			throw original;
		});
		const fetch = vi.fn<typeof globalThis.fetch>();
		const provider = createCodexResponsesProvider({ auth, fetch });
		const actual = await collect(provider.stream(request({ speed }))).catch((error: unknown) => error);
		// Avoid coercing hostile accessors/proxies even in assertion output.
		expect(actual === original).toBe(true);
		expect(auth).toHaveBeenCalledTimes(1);
		expect(fetch).not.toHaveBeenCalled();
	}

	const unrelated: { name: string; make: () => unknown }[] = [
		{ name: "ordinary Error", make: () => new Error("adapter failed") },
		{
			name: "typed unrelated Codex error with misleading param and message",
			make: () =>
				new CodexResponseError("unsupported_service_tier: Fast unavailable", {
					status: 503,
					code: "adapter_error",
					param: "service_tier",
					retryable: true,
				}),
		},
		{ name: "native AbortError", make: () => new DOMException("adapter aborted", "AbortError") },
		{ name: "native TimeoutError", make: () => new DOMException("adapter timed out", "TimeoutError") },
		{
			name: "Error impersonating the typed class",
			make: () =>
				Object.assign(new Error("unsupported_service_tier"), {
					name: "CodexResponseError",
					code: "unsupported_service_tier",
					param: "service_tier",
				}),
		},
		{
			name: "non-Error object with tier fields",
			make: () => ({ code: "unsupported_service_tier", param: "service_tier", message: "refused" }),
		},
		{ name: "non-Error string", make: () => "unsupported_service_tier" },
		{ name: "null", make: () => null },
		{ name: "undefined", make: () => undefined },
	];
	for (const { name, make } of unrelated) {
		it.each([undefined, "fast"] as const)(
			`leaves ${name} unchanged from injected auth (speed=%s)`,
			async (speed) => {
				const original = make();
				const message = original instanceof Error ? original.message : undefined;
				await rejectFromAuth(original, speed);
				if (original instanceof Error) expect(original.message).toBe(message);
				if (original instanceof CodexResponseError) {
					expect(original).toMatchObject({
						status: 503,
						code: "adapter_error",
						param: "service_tier",
						retryable: true,
					});
				}
			},
		);
	}

	const tierFields = {
		status: 400,
		code: "unsupported_service_tier",
		param: "service_tier",
		reason: "failed",
		requestId: "req_tier",
		retryable: false,
	};
	const tierError = () => new CodexResponseError("Priority refused", tierFields);
	const classified: {
		name: string;
		make: () => CodexResponseError;
		hint: boolean;
		unreadable?: boolean;
	}[] = [
		{ name: "typed tier error", make: tierError, hint: true },
		{ name: "frozen tier error", make: () => Object.freeze(tierError()), hint: false },
		{ name: "sealed tier error", make: () => Object.seal(tierError()), hint: true },
		{
			name: "non-configurable message on a tier error",
			make: () => Object.defineProperty(tierError(), "message", { writable: false, configurable: false }),
			hint: false,
		},
		{
			name: "configurable read-only message on a tier error",
			make: () => Object.defineProperty(tierError(), "message", { writable: false, configurable: true }),
			hint: true,
		},
		{
			name: "throwing message getter on a tier error",
			make: () =>
				Object.defineProperty(tierError(), "message", {
					get() {
						throw new Error("getter failed");
					},
				}),
			hint: false,
			unreadable: true,
		},
		{
			name: "throwing message setter on a tier error",
			make: () =>
				Object.defineProperty(tierError(), "message", {
					get: () => "Priority refused",
					set() {
						throw new Error("setter failed");
					},
					configurable: true,
				}),
			hint: true,
		},
		{
			name: "getter-only message on a tier error",
			make: () =>
				Object.defineProperty(tierError(), "message", { get: () => "Priority refused", configurable: true }),
			hint: true,
		},
	];
	for (const { name, make, hint, unreadable } of classified) {
		it.each([undefined, "fast"] as const)(
			`keeps ${name} identity and typed fields (speed=%s)`,
			async (speed) => {
				const original = make();
				const descriptor = Object.getOwnPropertyDescriptor(original, "message");
				await rejectFromAuth(original, speed);
				expect(original).toMatchObject(tierFields);
				if (unreadable) expect(Object.getOwnPropertyDescriptor(original, "message")).toEqual(descriptor);
				else {
					expect(original.message).toBe(
						speed === "fast" && hint ? `Priority refused — ${FAST_HINT}` : "Priority refused",
					);
				}
			},
		);
	}

	for (const field of ["code", "param", "prototype"] as const) {
		it.each([undefined, "fast"] as const)(
			`guards a throwing classifier ${field} accessor (speed=%s)`,
			async (speed) => {
				const read = vi.fn(() => {
					throw new Error("classifier accessor failed");
				});
				const target = new CodexResponseError("Original failure", {
					code: field === "param" ? "unsupported_parameter" : "unsupported_service_tier",
					param: "service_tier",
				});
				const original =
					field === "prototype"
						? new Proxy(target, { getPrototypeOf: read })
						: Object.defineProperty(target, field, { get: read });
				await rejectFromAuth(original, speed);
				expect(read).toHaveBeenCalledTimes(speed === "fast" ? 1 : 0);
				expect(target.message).toBe("Original failure");
			},
		);
	}

	it("an explicit tier code does not require reading a hostile param", async () => {
		const param = vi.fn(() => {
			throw new Error("param getter failed");
		});
		const original = Object.defineProperty(tierError(), "param", { get: param });
		await rejectFromAuth(original, "fast");
		expect(original.message).toBe(`Priority refused — ${FAST_HINT}`);
		expect(param).not.toHaveBeenCalled();
	});

	for (const kind of ["AbortError", "TimeoutError"] as const) {
		it.each([undefined, "fast"] as const)(
			`keeps an injected body's native ${kind} unchanged (speed=%s)`,
			async (speed) => {
				const original = new DOMException("adapter body stopped", kind);
				const { provider, fetch } = harness([
					() =>
						new Response(
							new ReadableStream({
								start(controller) {
									controller.error(original);
								},
							}),
						),
				]);
				const actual = await collect(provider.stream(request({ speed }))).catch((error: unknown) => error);
				expect(actual === original).toBe(true);
				expect(original.message).toBe("adapter body stopped");
				expect(fetch).toHaveBeenCalledTimes(1);
			},
		);
	}

	it("retains stream interruption guidance without suggesting normal mode", async () => {
		const { provider, fetch } = harness([
			() =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.error(new Error("terminated"));
						},
					}),
				),
		]);
		await expect(collect(provider.stream(request()))).rejects.toMatchObject({
			name: "StreamInterruptedError",
			message: 'Codex stream interrupted — connection closed; send "continue" to resume',
		});
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});

describe("Codex normal/Fast stream interruption privacy", () => {
	const privateDetail = `${TOKEN} sk-fake-stream-token Bearer fake-stream-bearer https://private.invalid/path?token=fake-url-secret\r\n\t\0\x1b[31m`;
	const interruptions = [
		...["UND_ERR_SOCKET", "ECONNRESET", "EPIPE"].flatMap((code) =>
			[false, true].map((nested) => ({
				name: `${nested ? "nested" : "direct"} ${code}`,
				detail: `${code}: connection closed`,
				make: () => {
					const socket = Object.assign(new Error(privateDetail), { code });
					return nested
						? new TypeError(`outer ${privateDetail}`, {
								cause: new Error(`middle ${privateDetail}`, { cause: socket }),
							})
						: socket;
				},
			})),
		),
		...["terminated", "fetch failed"].flatMap((wrapper) => [
			{
				name: `bare ${wrapper}`,
				detail: "connection closed",
				make: () => new TypeError(wrapper),
			},
			...[undefined, `UNKNOWN_${privateDetail}`].map((code) => ({
				name: `${wrapper} with ${code === undefined ? "no" : "unknown"} code`,
				detail: "connection closed",
				make: () =>
					new TypeError(wrapper, {
						cause: Object.assign(new Error(privateDetail), { code }),
					}),
			})),
		]),
	];

	// Yield a real text delta before the body fails: this must never retry or
	// emit message_end, regardless of the normal/Fast request selection.
	function interruptedResponse(original: Error): Response {
		let started = false;
		return new Response(
			new ReadableStream<Uint8Array>({
				pull(controller) {
					if (started) {
						controller.error(original);
						return;
					}
					started = true;
					const frames = [
						frame("response.output_item.added", {
							output_index: 0,
							item: { type: "message", id: "msg_cut", role: "assistant", content: [] },
						}),
						frame("response.output_text.delta", {
							output_index: 0,
							item_id: "msg_cut",
							delta: "partial answer",
						}),
					];
					controller.enqueue(
						new TextEncoder().encode(frames.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("")),
					);
				},
			}),
		);
	}

	for (const speed of [undefined, "fast"] as const) {
		it.each(interruptions)(
			`publishes fixed $name diagnostics without a Fast hint or retry (speed=${speed})`,
			async ({ make, detail }) => {
				const original = make();
				const { provider, auth, fetch } = harness([() => interruptedResponse(original)]);
				const events: LLMEvent[] = [];
				const caught = await collect(provider.stream(request({ speed })), events).catch(
					(error: unknown) => error,
				);
				expect(caught).toBeInstanceOf(StreamInterruptedError);
				const error = caught as StreamInterruptedError;
				expect(error).toMatchObject({ name: "StreamInterruptedError", provider: "Codex" });
				expect(error.cause).toBe(original);
				expect(error.message).toBe(`Codex stream interrupted — ${detail}; send "continue" to resume`);
				expect(error.message.length).toBeLessThanOrEqual(160);
				expect(error.message).not.toContain(FAST_HINT);
				expect(error.message).not.toMatch(
					/fake-subscription-access|sk-fake|Bearer|fake-stream|https?:|fake-url|UNKNOWN/,
				);
				for (const control of ["\r", "\n", "\t", "\0", "\x1b"]) expect(error.message).not.toContain(control);
				expect(events).toEqual([{ type: "text_delta", text: "partial answer" }]);
				expect(auth).toHaveBeenCalledTimes(1);
				expect(fetch).toHaveBeenCalledTimes(1);
				expect(body(fetch.mock.calls[0]?.[1]).service_tier).toBe(speed === "fast" ? "priority" : undefined);
			},
		);

		it.each([
			() => new Error(privateDetail),
			() => Object.assign(new Error(privateDetail), { code: `UNKNOWN_${privateDetail}` }),
			() => new TypeError(`terminated ${privateDetail}`),
		])(`leaves unrelated body errors unchanged (speed=${speed}, case=%#)`, async (make) => {
			const original = make();
			const { provider, fetch } = harness([() => interruptedResponse(original)]);
			await expect(collect(provider.stream(request({ speed })))).rejects.toBe(original);
			expect(original.message).toBe(make().message);
			expect(fetch).toHaveBeenCalledTimes(1);
		});

		it(`ends an interrupted body silently after abort (speed=${speed})`, async () => {
			const controller = new AbortController();
			const original = Object.assign(new Error(privateDetail), { code: "ECONNRESET" });
			const { provider, fetch } = harness([() => interruptedResponse(original)]);
			const events: LLMEvent[] = [];
			for await (const event of provider.stream(request({ speed, signal: controller.signal }))) {
				events.push(event);
				controller.abort();
			}
			expect(events).toEqual([{ type: "text_delta", text: "partial answer" }]);
			expect(fetch).toHaveBeenCalledTimes(1);
		});
	}
});

describe("Fast wire identity and replay", () => {
	it.each(["off", "minimal", "low", "high", "max"] as const)(
		"keeps thinking=%s and every normal field unchanged",
		async (thinking) => {
			const { provider, fetch } = harness([
				() => streamResponse([terminal()]),
				() => streamResponse([terminal()]),
			]);
			const req = request({ thinking, sessionId: "full-session/会話\r\n" });
			await collect(provider.stream({ ...req, speed: undefined }));
			await collect(provider.stream(req));
			const normal = body(fetch.mock.calls[0]?.[1]);
			const fast = body(fetch.mock.calls[1]?.[1]);
			expect(normal).not.toHaveProperty("service_tier");
			expect(fast).toEqual({ ...normal, service_tier: "priority" });
			expect(fetch.mock.calls[1]?.[1]?.headers).toEqual(fetch.mock.calls[0]?.[1]?.headers);
			expect(fast).not.toHaveProperty("speed");
			expect(fast).not.toHaveProperty("fast");
		},
	);

	it.each([undefined, "fast"] as const)(
		"replays native reasoning/text from speed=%s at the same base in both modes",
		async (speed) => {
			const reasoning = {
				type: "reasoning",
				id: "rs_base",
				summary: [{ type: "summary_text", text: "reasoning summary" }],
				encrypted_content: "fixture-ciphertext",
			};
			const message = {
				type: "message",
				id: "msg_base",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "answer" }],
			};
			const { provider, fetch } = harness([
				() => streamResponse([terminal("completed", "default", { output: [reasoning, message] })]),
				() => streamResponse([terminal()]),
				() => streamResponse([terminal()]),
				() => streamResponse([terminal()]),
			]);
			const initial = await collect(provider.stream(request({ speed })));
			const end = initial.at(-1);
			if (end?.type !== "message_end") throw new Error("missing fixture message");
			expect(end.message.provenance).toEqual({ version: 1, provider: "openai-codex", model: "gpt-5.5" });
			expect(end.message.serviceTier).toEqual({
				requested: speed === "fast" ? "priority" : "omitted",
				reported: "default",
			});
			expect(end.message).not.toHaveProperty("speed");
			for (const next of [undefined, "fast"] as const) {
				await collect(provider.stream(request({ speed: next, messages: [end.message] })));
			}
			const normalInput = body(fetch.mock.calls[1]?.[1]).input;
			expect(normalInput).toEqual([
				reasoning,
				{ ...message, content: [{ type: "output_text", text: "answer", annotations: [] }] },
			]);
			expect(body(fetch.mock.calls[2]?.[1]).input).toEqual(normalInput);
			const auth = vi.fn(async () => ({ accessToken: TOKEN }));
			const other = createCodexResponsesProvider({ auth, fetch });
			await expect(
				collect(other.stream(request({ model: "different-base", messages: [end.message] }))),
			).resolves.toBeDefined();
			// Cross-model replay is canonical, not native ciphertext replay.
			expect(body(fetch.mock.calls.at(-1)?.[1]).input).not.toContainEqual(reasoning);
		},
	);
});

describe("Fast admission, diagnostics, and retry policy", () => {
	it.each([429, 503, "network"] as const)(
		"retries %s with the identical priority body and credentials",
		async (failure) => {
			vi.useFakeTimers();
			const fail = () => {
				if (failure === "network") throw new Error("private network detail");
				return jsonError(failure, failure === 429 ? "rate_limit_exceeded" : "server_error");
			};
			const { provider, auth, fetch } = harness([fail, fail, () => streamResponse([terminal()])]);
			const result = collect(provider.stream(request({ thinking: "high", sessionId: "retry-session" })));
			await vi.runAllTimersAsync();
			expect((await result).at(-1)?.type).toBe("message_end");
			expect(auth).toHaveBeenCalledTimes(1);
			expect(fetch).toHaveBeenCalledTimes(3);
			const first = fetch.mock.calls[0]?.[1];
			for (const [url, init] of fetch.mock.calls) {
				expect(url).toBe(ENDPOINT);
				expect(init?.body).toBe(first?.body);
				expect(init?.headers).toEqual(first?.headers);
				expect(init?.redirect).toBe("manual");
				expect(body(init)).toMatchObject({
					model: "gpt-5.5",
					service_tier: "priority",
					reasoning: { effort: "high", summary: "auto" },
				});
				expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
			}
		},
	);

	it("exhausts network retries without a normal, API-key, or legacy-backend request", async () => {
		vi.useFakeTimers();
		const fail = () => {
			throw new Error(`Bearer ${TOKEN}`);
		};
		const { provider, auth, fetch } = harness([fail, fail, fail, fail, fail]);
		const req = request();
		const failure = expect(collect(provider.stream(req))).rejects.toMatchObject({
			name: "CodexResponseError",
			code: "connection_failed",
			retryable: true,
			message: "Codex request failed before the response stream opened (5 attempts)",
		});
		await vi.runAllTimersAsync();
		await failure;
		expect(auth).toHaveBeenCalledTimes(1);
		expect(fetch).toHaveBeenCalledTimes(5);
		expect(req).toEqual(request());
		for (const [url, init] of fetch.mock.calls) {
			expect(url).toBe(ENDPOINT);
			expect(body(init).service_tier).toBe("priority");
		}
	});

	it.each([429, 503])("exhausts HTTP %i retries without a Fast hint or fallback", async (status) => {
		vi.useFakeTimers();
		const code = status === 429 ? "rate_limit_exceeded" : "server_error";
		const fail = () => jsonError(status, code);
		const { provider, auth, fetch } = harness([fail, fail, fail]);
		const failure = expect(collect(provider.stream(request()))).rejects.toMatchObject({
			name: "CodexResponseError",
			status,
			code,
			param: undefined,
			retryable: true,
			message: `OpenAI Codex API error ${status}: Request refused`,
		});
		await vi.runAllTimersAsync();
		await failure;
		expect(auth).toHaveBeenCalledTimes(1);
		expect(fetch).toHaveBeenCalledTimes(3);
		for (const [url, init] of fetch.mock.calls) {
			expect(url).toBe(ENDPOINT);
			expect(body(init).service_tier).toBe("priority");
		}
	});

	const admissionCases: {
		status: number;
		code?: string;
		param?: string;
		hint: boolean;
		message?: string;
	}[] = [
		{ status: 400, code: "unsupported_service_tier", param: "service_tier", hint: true },
		{ status: 400, code: "unsupported_service_tier", hint: true },
		{ status: 422, code: "invalid_service_tier", param: "service_tier", hint: true },
		{ status: 400, code: "tier_unavailable", hint: true },
		{ status: 400, code: "unsupported_parameter", param: "service_tier", hint: true },
		{ status: 503, code: "unsupported_service_tier", param: "service_tier", hint: true },
		{ status: 401, code: "invalid_token", param: "authorization", hint: false },
		{ status: 403, code: "permission_denied", hint: false },
		{ status: 404, code: "model_not_found", param: "model", hint: false },
		{ status: 429, code: "subscription_sharing_usage_limit_exceeded", hint: false },
		{ status: 429, code: "insufficient_quota", hint: false },
		{ status: 400, code: "context_length_exceeded", param: "input", hint: false },
		{
			status: 400,
			code: "invalid_request_error",
			param: "input",
			message: "No tool output found for function call call_missing",
			hint: false,
		},
		{ status: 400, hint: false }, // Neither status nor typed class alone is evidence.
		{ status: 400, param: "service_tier", hint: false }, // Bare parameter is insufficient.
		// Conflicting evidence: an unrelated code must outweigh a tier parameter.
		{ status: 401, code: "invalid_token", param: "service_tier", hint: false },
		{ status: 400, code: "invalid_request_error", param: "service_tier", hint: false },
		{ status: 400, code: "context_length_exceeded", param: "service_tier", hint: false },
		{ status: 400, code: "unknown_code", param: "service_tier", hint: false },
		{ status: 400, code: "unsupported_parameter", param: "model", hint: false },
		{ status: 400, code: "unsupported_parameter", param: "service_tiers", hint: false },
		{ status: 400, code: "unsupported_parameter", hint: false },
		{ status: 400, code: "Unsupported_service_tier", hint: false },
		{
			status: 400,
			code: "invalid_request_error",
			message: "unsupported_service_tier: service_tier priority Fast unavailable",
			hint: false,
		},
	];
	for (const speed of [undefined, "fast"] as const) {
		it.each(admissionCases)(
			`HTTP $status code=$code param=$param preserves diagnostics (speed=${speed})`,
			async ({ status, code, param, hint, message }) => {
				const { provider, auth, fetch } = harness([() => jsonError(status, code, param, message)]);
				const req = Object.freeze(request({ speed }));
				const caught = await collect(provider.stream(req)).catch((error: unknown) => error);
				expect(caught).toBeInstanceOf(CodexResponseError);
				expect(caught).toMatchObject({
					status,
					code,
					param,
					reason: undefined,
					requestId: "req_admission",
					retryable: false,
				});
				expect((caught as Error).message).toContain(message ?? "Request refused");
				expect((caught as Error).message.includes(FAST_HINT)).toBe(speed === "fast" && hint);
				expect(req.speed).toBe(speed);
				expect(auth).toHaveBeenCalledTimes(1);
				expect(fetch).toHaveBeenCalledTimes(1);
				expect(body(fetch.mock.calls[0]?.[1]).service_tier).toBe(speed === "fast" ? "priority" : undefined);
			},
		);
	}

	it("redacts HTTP credentials while retaining safe upstream fields and recovery guidance", async () => {
		const { provider, fetch } = harness([
			() =>
				new Response(
					JSON.stringify({
						error: {
							code: "unsupported_service_tier",
							param: "service_tier",
							message: `Priority unavailable\r\n${TOKEN}; Bearer another-secret`,
						},
					}),
					{ status: 400, headers: { "x-request-id": `req_${TOKEN}` } },
				),
		]);
		let caught: unknown;
		try {
			await collect(provider.stream(request()));
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(CodexResponseError);
		expect(caught).toMatchObject({
			status: 400,
			code: "unsupported_service_tier",
			param: "service_tier",
			requestId: undefined,
		});
		const message = (caught as Error).message;
		expect(message).toContain("Priority unavailable");
		expect(message).toContain("[redacted]");
		expect(message).toContain(FAST_HINT);
		expect(message).not.toMatch(/fake-subscription-access|another-secret|\r|\n/);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	for (const kind of [
		"response.failed",
		"response.cancelled",
		"error",
		"response.incomplete",
		"response.completed",
	] as const) {
		it.each([
			{ code: "unsupported_service_tier", param: undefined, hint: true },
			{ code: "invalid_service_tier", param: "service_tier", hint: true },
			{ code: "tier_unavailable", param: "service_tier", hint: true },
			{ code: "unsupported_parameter", param: "service_tier", hint: true },
			{ code: "unsupported_parameter", param: "input", hint: false },
			{ code: "context_length_exceeded", param: "input", hint: false },
			{ code: "invalid_request_error", param: "input", hint: false },
			{ code: "invalid_response", param: undefined, hint: false },
			{ code: "insufficient_quota", param: undefined, hint: false },
			{ code: "invalid_token", param: "authorization", hint: false },
			{ code: "server_error", param: undefined, hint: false },
			// Conflicting structured fields do not turn a context error into a tier rejection.
			{ code: "context_length_exceeded", param: "service_tier", hint: false },
		])(
			`retains redacted ${kind} $code/$param diagnostics without fallback`,
			async ({ code, param, hint }) => {
				const diagnostic =
					code === "invalid_request_error" ? "No tool output found for function call call_missing" : code;
				const error = { code, param, message: `${diagnostic}: ${TOKEN} Bearer hidden-secret` };
				const fields =
					kind === "error"
						? { error }
						: {
								response: {
									status: kind.split(".")[1],
									error,
									incomplete_details: { reason: "content_filter" },
								},
							};
				const { provider, auth, fetch } = harness([() => streamResponse([frame(kind, fields)])]);
				const events: LLMEvent[] = [];
				const caught = await collect(provider.stream(request()), events).catch((failure: unknown) => failure);
				expect(caught).toBeInstanceOf(CodexResponseError);
				expect(caught).toMatchObject({
					status: 200,
					code,
					param,
					reason: {
						"response.failed": "failed",
						"response.cancelled": "cancelled",
						error: "error",
						"response.incomplete": "content_filter",
						"response.completed": undefined,
					}[kind],
					requestId: "req_fast",
					retryable: false,
				});
				const message = (caught as Error).message;
				expect(message).toContain(diagnostic);
				expect(message).toContain("[redacted]");
				expect(message.includes(FAST_HINT)).toBe(hint);
				expect(message).not.toMatch(
					/fake-subscription-access|hidden-secret|API error 200|(?:failed|incomplete|error) 200:/,
				);
				expect(events.some((event) => event.type === "message_end")).toBe(false);
				expect(auth).toHaveBeenCalledTimes(1);
				expect(fetch).toHaveBeenCalledTimes(1);
			},
		);
	}

	it("rejects redirects without credential forwarding or fallback", async () => {
		const { provider, auth, fetch } = harness([
			() =>
				new Response(null, {
					status: 307,
					headers: { location: "https://chatgpt.com/backend-api/responses" },
				}),
		]);
		await expect(collect(provider.stream(request()))).rejects.toMatchObject({
			code: "redirect_rejected",
			status: 307,
			message: "Codex credential-bearing request rejected a redirect",
		});
		expect(auth).toHaveBeenCalledTimes(1);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(fetch.mock.calls[0]?.[1]?.redirect).toBe("manual");
	});

	it.each(["data: {malformed-private-frame}\n\n", ": keepalive\n\n"])(
		"a malformed or missing terminal frame fails without a Fast hint or retry (%s)",
		async (data) => {
			const { provider, fetch } = harness([() => new Response(data)]);
			const events: LLMEvent[] = [];
			let caught: unknown;
			try {
				await collect(provider.stream(request()), events);
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(CodexResponseError);
			expect((caught as Error).message).not.toContain(FAST_HINT);
			expect((caught as Error).message).not.toContain("malformed-private-frame");
			expect(events).toEqual([]);
			expect(fetch).toHaveBeenCalledTimes(1);
		},
	);

	it.each([undefined, "fast"] as const)(
		"refuses malformed native replay without a Fast hint before auth or HTTP (speed=%s)",
		async (speed) => {
			const { provider, auth, fetch } = harness();
			const messages: AgentMessage[] = [
				{
					role: "assistant",
					blocks: [
						{
							type: "text",
							text: "old answer",
							responses: {
								version: 1,
								provider: "openai-codex",
								itemId: " ",
								contentIndex: 0,
								kind: "output_text",
							},
						},
					],
					usage: { inputTokens: 1, outputTokens: 1 },
					stopReason: "end_turn",
					provenance: { version: 1, provider: "openai-codex", model: "gpt-5.5" },
				},
			];
			await expect(collect(provider.stream(request({ speed, messages })))).rejects.toMatchObject({
				name: "CodexResponseError",
				code: "invalid_replay_metadata",
				message: "Codex replay metadata is malformed",
			});
			expect(auth).not.toHaveBeenCalled();
			expect(fetch).not.toHaveBeenCalled();
		},
	);

	it("keeps auth failure identity and Fast selection without trying any transport", async () => {
		const original = new Error("Subscription authorization required");
		const auth = vi.fn(async () => {
			throw original;
		});
		const fetch = vi.fn<typeof globalThis.fetch>();
		const provider = createCodexResponsesProvider({ auth, fetch });
		const req = Object.freeze(request());
		await expect(collect(provider.stream(req))).rejects.toBe(original);
		expect(original.message).toBe("Subscription authorization required");
		expect(auth).toHaveBeenCalledTimes(1);
		expect(fetch).not.toHaveBeenCalled();
		expect(req.speed).toBe("fast");
	});

	it("leaves normal error diagnostics unchanged", async () => {
		const { provider } = harness([() => jsonError(400, "unsupported_service_tier")]);
		await expect(collect(provider.stream(request({ speed: undefined })))).rejects.toMatchObject({
			message: "OpenAI Codex API error 400: Request refused",
		});
	});
});

const terminalKinds = ["completed", "incomplete"] as const;
const differingTierCases = terminalKinds.flatMap((kind) =>
	["default", "standard", "flex"].map((tier) => ({ kind, tier })),
);
const tool = {
	type: "function_call",
	id: "fc_fast",
	call_id: "call_fast",
	name: "probe",
	arguments: "{}",
	status: "completed",
};
const toolFrames = () => [
	frame("response.output_item.added", {
		output_index: 0,
		item: { ...tool, arguments: "", status: "in_progress" },
	}),
	frame("response.output_item.done", { output_index: 0, item: tool }),
];

describe("Fast terminal tier observations", () => {
	it.each([undefined, "fast"] as const)(
		"observes the actual sent body even if the caller mutates speed=%s",
		async (speed) => {
			const req = request({ speed });
			let sent: Record<string, unknown> | undefined;
			const provider = createCodexResponsesProvider({
				auth: async () => ({ accessToken: TOKEN }),
				fetch: async (_url, init) => {
					sent = body(init);
					req.speed = speed === "fast" ? undefined : "fast";
					return streamResponse([terminal("completed", "default")]);
				},
			});
			const events = await collect(provider.stream(req));
			expect(sent?.service_tier).toBe(speed === "fast" ? "priority" : undefined);
			expect(events.at(-1)).toMatchObject({
				message: {
					serviceTier: {
						requested: speed === "fast" ? "priority" : "omitted",
						reported: "default",
					},
				},
			});
		},
	);

	it.each(
		terminalKinds.flatMap((kind) =>
			[
				"priority",
				"default",
				"standard",
				"flex",
				"fast",
				"future-tier",
				undefined,
				null,
				{},
				42,
				"",
				"priority\n",
				"bad tier",
				"x".repeat(161),
			].flatMap((tier) => [undefined, "fast" as const].map((speed) => ({ kind, tier, speed }))),
		),
	)("accepts $kind tier=$tier speed=$speed without fallback or rewriting", async ({ kind, tier, speed }) => {
		const { provider, fetch } = harness([
			() =>
				streamResponse([
					frame("response.created", { response: { service_tier: "created-only" } }),
					terminal(kind, tier, { service_tier: tier }),
				]),
		]);
		const events = await collect(provider.stream(request({ speed })));
		expect(events).toEqual([expect.objectContaining({ type: "message_end" })]);
		const end = events.at(-1);
		if (end?.type !== "message_end") throw new Error("missing fixture message");
		const valid =
			typeof tier === "string" &&
			["priority", "default", "standard", "flex", "fast", "future-tier"].includes(tier);
		expect(end.message.serviceTier).toEqual({
			requested: speed === "fast" ? "priority" : "omitted",
			...(valid ? { reported: tier } : {}),
		});
		expect(end.message.stopReason).toBe(kind === "incomplete" ? "max_tokens" : "end_turn");
		expect(end.message).not.toHaveProperty("speed");
		expect(end.message).not.toHaveProperty("service_tier");
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(body(fetch.mock.calls[0]?.[1])).toMatchObject({ model: "gpt-5.5" });
		if (speed === "fast") expect(body(fetch.mock.calls[0]?.[1]).service_tier).toBe("priority");
		else expect(body(fetch.mock.calls[0]?.[1])).not.toHaveProperty("service_tier");
	});

	it.each([TOKEN, `tier_${TOKEN}`])("does not persist a credential echoed as a tier (%s)", async (tier) => {
		const { provider } = harness([() => streamResponse([terminal("completed", tier)])]);
		const events = await collect(provider.stream(request()));
		expect(events.at(-1)).toMatchObject({ message: { serviceTier: { requested: "priority" } } });
		expect(JSON.stringify(events)).not.toContain(TOKEN);
	});

	it.each(["default", "standard", "flex"])(
		"persists and executes valid completed tools with tier=%s",
		async (tier) => {
			const execute = vi.fn(async () => ({ output: "executed" }));
			const { provider, fetch } = harness([
				() => streamResponse([...toolFrames(), terminal("completed", tier, { output: [tool] })]),
				() => streamResponse([terminal("completed", tier)]),
			]);
			const root = mkTempDir("ink-session-");
			const session = createSession(root, root);
			const history: AgentMessage[] = [];
			const events: AgentEvent[] = [];
			await runAgentLoop({
				provider,
				model: "gpt-5.5",
				modelReference: "openai-codex/gpt-5.5",
				speed: "fast",
				system: "test",
				userMessage: "probe",
				history,
				tools: [{ name: "probe", description: "test", parameters: Type.Object({}), execute }],
				onMessage: (message) => {
					session.appendMessage(message);
				},
				onEvent: (event) => {
					events.push(event);
				},
			});
			expect(execute).toHaveBeenCalledTimes(1);
			expect(fetch).toHaveBeenCalledTimes(2); // tool continuation, never a tier fallback
			expect(events.filter((event) => event.type === "message_end")).toHaveLength(2);
			expect(session.buildContext().messages).toEqual(history);
			const assistants = history.filter((message) => message.role === "assistant");
			expect(assistants).toHaveLength(2);
			for (const message of assistants) {
				expect(message.modelReference).toBe("openai-codex/gpt-5.5");
				expect(message.serviceTier).toEqual({ requested: "priority", reported: tier });
			}
			for (const [, init] of fetch.mock.calls) expect(body(init).service_tier).toBe("priority");
		},
	);

	it.each([
		"truncated",
		"invalid-json",
		"unfinished",
		"conflicting",
		"failed",
		"cancelled",
		"error",
		"filtered",
		"bad-status",
		"terminal-error",
	])("tier=default never conceals %s or executes/persists its tool batch", async (failure) => {
		const execute = vi.fn(async () => ({ output: "must not execute" }));
		const closed = failure === "invalid-json" ? { ...tool, arguments: "{" } : tool;
		const frames = [toolFrames()[0]!];
		if (failure !== "unfinished")
			frames.push(frame("response.output_item.done", { output_index: 0, item: closed }));
		if (failure === "failed" || failure === "cancelled") frames.push(terminal(failure, "default"));
		else if (failure === "error")
			frames.push(frame("error", { error: { code: "stream_failed", message: "refused" } }));
		else if (failure !== "truncated")
			frames.push(
				terminal(failure === "filtered" ? "incomplete" : "completed", "default", {
					output: [failure === "conflicting" ? { ...tool, arguments: '{"different":true}' } : closed],
					...(failure === "filtered" ? { incomplete_details: { reason: "content_filter" } } : {}),
					...(failure === "bad-status" ? { status: "failed" } : {}),
					...(failure === "terminal-error" ? { error: { code: "terminal_failed" } } : {}),
				}),
			);
		const { provider, fetch } = harness([() => streamResponse(frames)]);
		const history: AgentMessage[] = [];
		const persisted: AgentMessage[] = [];
		await expect(
			runAgentLoop({
				provider,
				model: "gpt-5.5",
				speed: "fast",
				system: "test",
				userMessage: "probe",
				history,
				tools: [{ name: "probe", description: "test", parameters: Type.Object({}), execute }],
				onMessage: (message) => {
					persisted.push(message);
				},
			}),
		).rejects.toMatchObject({
			name: "CodexResponseError",
			message: expect.not.stringContaining(FAST_HINT),
		});
		expect(execute).not.toHaveBeenCalled();
		expect(history).toEqual([{ role: "user", content: "probe" }]);
		expect(persisted).toEqual(history);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("accepts max_output_tokens text but never executes an incomplete tool batch", async () => {
		const { provider, fetch } = harness([
			() => streamResponse([toolFrames()[0]!, terminal("incomplete", "default", { output: [tool] })]),
			() => streamResponse([terminal("completed", "default")]),
		]);
		const execute = vi.fn(async () => ({ output: "must not execute" }));
		const history: AgentMessage[] = [];
		await runAgentLoop({
			provider,
			model: "gpt-5.5",
			speed: "fast",
			system: "test",
			userMessage: "probe",
			history,
			tools: [{ name: "probe", description: "test", parameters: Type.Object({}), execute }],
		});
		expect(execute).not.toHaveBeenCalled();
		expect(history[1]).toMatchObject({
			role: "assistant",
			stopReason: "max_tokens",
			serviceTier: { requested: "priority", reported: "default" },
		});
		// Partial tool data remains inspectable, but max_tokens is never executable.
		expect(history[1]).toHaveProperty(
			"blocks",
			expect.arrayContaining([expect.objectContaining({ type: "toolCall" })]),
		);
		expect(history[2]).toMatchObject({
			role: "toolResult",
			results: [{ isError: true, content: expect.stringContaining("not executed") }],
		});
		expect(fetch).toHaveBeenCalledTimes(2); // existing tool re-issue continuation, not a tier fallback
	});

	it("cancels a held accepted body immediately instead of waiting for EOF", async () => {
		const cancel = vi.fn();
		const { provider, fetch } = harness([
			() =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(
								new TextEncoder().encode(`data: ${JSON.stringify(terminal("incomplete", "default"))}\n\n`),
							);
						},
						cancel,
					}),
				),
		]);
		expect((await collect(provider.stream(request()))).at(-1)).toMatchObject({
			type: "message_end",
			message: { stopReason: "max_tokens" },
		});
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("also accepts a completed event with output-token-limit incomplete status", async () => {
		const { provider, fetch } = harness([
			() =>
				streamResponse([
					terminal("completed", "default", {
						status: "incomplete",
						incomplete_details: { reason: "max_output_tokens" },
					}),
				]),
		]);
		expect((await collect(provider.stream(request()))).at(-1)).toMatchObject({
			type: "message_end",
			message: { stopReason: "max_tokens", serviceTier: { requested: "priority", reported: "default" } },
		});
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it.each(differingTierCases)(
		"$kind tier=$tier summarizes with only the existing thinking retry",
		async ({ kind, tier }) => {
			const summary = (terminalKind: string) =>
				streamResponse([
					terminal(terminalKind, tier, {
						output: [{ type: "message", content: [{ type: "output_text", text: "accepted summary" }] }],
					}),
				]);
			const { provider, fetch } = harness([() => summary(kind), () => summary("completed")]);
			const result = await summarizeBranchSegment({
				provider,
				model: "gpt-5.5",
				speed: "fast",
				thinking: "high",
				messages: [{ role: "user", content: "old work" }],
			});
			expect(result?.summary).toBe("accepted summary");
			expect(fetch).toHaveBeenCalledTimes(kind === "incomplete" ? 2 : 1);
			for (const [, init] of fetch.mock.calls)
				expect(body(init)).toMatchObject({ model: "gpt-5.5", service_tier: "priority" });
			if (kind === "incomplete") expect(body(fetch.mock.calls[1]?.[1]).reasoning).toEqual({ effort: "none" });
		},
	);

	it.each(differingTierCases)("$kind tier=$tier permits a compaction checkpoint", async ({ kind, tier }) => {
		const root = mkTempDir("ink-session-");
		const session = createSession(root, root);
		session.appendMessage({ role: "user", content: "older work ".repeat(20) });
		session.appendMessage({ role: "user", content: "latest work ".repeat(20) });
		const summary = (terminalKind: string) =>
			streamResponse([
				terminal(terminalKind, tier, {
					output: [{ type: "message", content: [{ type: "output_text", text: "accepted checkpoint" }] }],
				}),
			]);
		const { provider, fetch } = harness([() => summary(kind), () => summary("completed")]);
		await compactSession({
			session,
			provider,
			model: "gpt-5.5",
			speed: "fast",
			thinking: "high",
			settings: { reserveTokens: 64, keepRecentTokens: 1, contextWindow: 4096 },
		});
		expect(fetch).toHaveBeenCalledTimes(kind === "incomplete" ? 2 : 1);
		expect(session.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		for (const [, init] of fetch.mock.calls) expect(body(init).service_tier).toBe("priority");
	});
});
