import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compactSession, summarizeBranchSegment } from "../src/core/compaction.js";
import { type AgentEvent, runAgentLoop } from "../src/core/loop.js";
import type { AgentMessage } from "../src/core/messages.js";
import { createSession } from "../src/core/session/manager.js";
import { getCodexAccessToken } from "../src/provider/codex-auth.js";
import { CodexResponseError, createCodexResponsesProvider } from "../src/provider/codex-responses.js";
import { CodexOutput } from "../src/provider/responses-output.js";
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
const jsonError = (status: number, code: string) =>
	new Response(
		JSON.stringify({ error: { code, param: "service_tier", message: "Fast admission refused" } }),
		{ status, headers: { "x-request-id": "req_admission" } },
	);
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
				() => streamResponse([terminal("completed", "priority", { output: [reasoning, message] })]),
				() => streamResponse([terminal()]),
				() => streamResponse([terminal()]),
				() => streamResponse([terminal()]),
			]);
			const initial = await collect(provider.stream(request({ speed })));
			const end = initial.at(-1);
			if (end?.type !== "message_end") throw new Error("missing fixture message");
			expect(end.message.provenance).toEqual({ version: 1, provider: "openai-codex", model: "gpt-5.5" });
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
			message: expect.stringMatching(/Fast.*\/model.*normal/),
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

	it.each([
		[400, "unsupported_service_tier"],
		[401, "invalid_token"],
		[403, "permission_denied"],
		[404, "model_not_found"],
		[422, "invalid_service_tier"],
		[429, "subscription_sharing_usage_limit_exceeded"],
		[503, "unsupported_service_tier"],
	] as const)("HTTP %i (%s) preserves diagnostics and never retries normally", async (status, code) => {
		const { provider, auth, fetch } = harness([() => jsonError(status, code)]);
		const req = Object.freeze(request());
		await expect(collect(provider.stream(req))).rejects.toMatchObject({
			name: "CodexResponseError",
			status,
			code,
			param: "service_tier",
			requestId: "req_admission",
			retryable: false,
			message: expect.stringMatching(/Fast admission refused.*Fast.*\/model.*normal/),
		});
		expect(req.speed).toBe("fast");
		expect(auth).toHaveBeenCalledTimes(1);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

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
		expect(message).toMatch(/Fast.*\/model.*normal/);
		expect(message).not.toMatch(/fake-subscription-access|another-secret|\r|\n/);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it.each(["response.failed", "response.cancelled", "error", "response.incomplete"])(
		"retains redacted %s diagnostics and does not fall back",
		async (kind) => {
			const error = {
				code: "tier_unavailable",
				param: "service_tier",
				message: `Priority refused: ${TOKEN} Bearer hidden-secret`,
			};
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
			let caught: unknown;
			try {
				await collect(provider.stream(request()), events);
			} catch (failure) {
				caught = failure;
			}
			expect(caught).toBeInstanceOf(CodexResponseError);
			expect(caught).toMatchObject({
				status: 200,
				code: "tier_unavailable",
				param: "service_tier",
				requestId: "req_fast",
				retryable: false,
			});
			expect((caught as Error).message).toMatch(/Priority refused.*Fast.*\/model.*normal/);
			expect((caught as Error).message).not.toMatch(/fake-subscription-access|hidden-secret/);
			expect(events.some((event) => event.type === "message_end")).toBe(false);
			expect(auth).toHaveBeenCalledTimes(1);
			expect(fetch).toHaveBeenCalledTimes(1);
		},
	);

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
			message: expect.stringMatching(/redirect.*Fast.*\/model.*normal/),
		});
		expect(auth).toHaveBeenCalledTimes(1);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(fetch.mock.calls[0]?.[1]?.redirect).toBe("manual");
	});

	it.each(["data: {malformed-private-frame}\n\n", ": keepalive\n\n"])(
		"a malformed or missing terminal frame adds recovery guidance without retrying (%s)",
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
			expect((caught as Error).message).toMatch(/Fast.*\/model.*normal/);
			expect((caught as Error).message).not.toContain("malformed-private-frame");
			expect(events).toEqual([]);
			expect(fetch).toHaveBeenCalledTimes(1);
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
		expect(original.message).toMatch(/Subscription authorization required.*Fast.*\/model.*normal/);
		expect(auth).toHaveBeenCalledTimes(1);
		expect(fetch).not.toHaveBeenCalled();
		expect(req.speed).toBe("fast");
	});

	it("leaves normal error diagnostics unchanged", async () => {
		const { provider } = harness([() => jsonError(400, "unsupported_service_tier")]);
		await expect(collect(provider.stream(request({ speed: undefined })))).rejects.toMatchObject({
			message: "OpenAI Codex API error 400: Fast admission refused",
		});
	});
});

const terminalKinds = ["completed", "incomplete"] as const;
const downgradeCases = terminalKinds.flatMap((kind) =>
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

describe("Fast terminal tier validation", () => {
	it.each(downgradeCases)(
		"rejects $kind tier=$tier before reconciliation or message_end",
		async ({ kind, tier }) => {
			const reconcile = vi.spyOn(CodexOutput.prototype, "reconcile");
			const { provider, fetch } = harness([
				() =>
					streamResponse([
						terminal(kind, tier, {
							output: [{ type: "message", content: [{ type: "output_text", text: "must not reconcile" }] }],
						}),
					]),
			]);
			const events: LLMEvent[] = [];
			await expect(collect(provider.stream(request()), events)).rejects.toMatchObject({
				name: "CodexResponseError",
				code: "service_tier_downgrade",
				param: "service_tier",
				reason: tier,
				retryable: false,
				message: expect.stringMatching(new RegExp(`service_tier="${tier}".*Fast.*\\/model.*normal`)),
			});
			expect(reconcile).not.toHaveBeenCalled();
			expect(events).toEqual([]);
			expect(fetch).toHaveBeenCalledTimes(1);
		},
	);

	it.each(downgradeCases)(
		"$kind tier=$tier cannot execute tools or persist the streamed assistant",
		async ({ kind, tier }) => {
			const execute = vi.fn(async () => ({ output: "must not execute" }));
			const { provider, fetch } = harness([
				() => streamResponse([...toolFrames(), terminal(kind, tier, { output: [tool] })]),
			]);
			const history: AgentMessage[] = [];
			const persisted: AgentMessage[] = [];
			const events: AgentEvent[] = [];
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
					onEvent: (event) => {
						events.push(event);
					},
				}),
			).rejects.toHaveProperty("code", "service_tier_downgrade");
			expect(events.some((event) => event.type === "tool_call_start")).toBe(true);
			expect(events.some((event) => ["message_end", "tool_start", "tool_end"].includes(event.type))).toBe(
				false,
			);
			expect(execute).not.toHaveBeenCalled();
			expect(history).toEqual([{ role: "user", content: "probe" }]);
			expect(persisted).toEqual(history);
			expect(fetch).toHaveBeenCalledTimes(1);
		},
	);

	it("cancels a held response body on downgrade instead of waiting for EOF or retrying", async () => {
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
		await expect(collect(provider.stream(request()))).rejects.toHaveProperty(
			"code",
			"service_tier_downgrade",
		);
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("also rejects a completed event whose response status is output-token-limit incomplete", async () => {
		const { provider } = harness([
			() =>
				streamResponse([
					terminal("completed", "default", {
						status: "incomplete",
						incomplete_details: { reason: "max_output_tokens" },
					}),
				]),
		]);
		await expect(collect(provider.stream(request()))).rejects.toHaveProperty(
			"code",
			"service_tier_downgrade",
		);
	});

	it.each(
		terminalKinds.flatMap((kind) =>
			["priority", "fast", undefined, "future-tier", null, {}, 42].map((tier) => ({ kind, tier })),
		),
	)("accepts $kind tier=$tier; unknown/missing tier does not claim verification", async ({ kind, tier }) => {
		const { provider } = harness([() => streamResponse([terminal(kind, tier, { service_tier: tier })])]);
		const events = await collect(provider.stream(request()));
		expect(events).toEqual([expect.objectContaining({ type: "message_end" })]);
		expect(events.at(-1)).toMatchObject({
			type: "message_end",
			message: { stopReason: kind === "incomplete" ? "max_tokens" : "end_turn" },
		});
		const end = events.at(-1);
		if (end?.type !== "message_end") throw new Error("missing fixture message");
		expect(end.message).not.toHaveProperty("service_tier");
		expect(end.message).not.toHaveProperty("speed");
	});

	it.each(downgradeCases)("normal accepts $kind tier=$tier unchanged", async ({ kind, tier }) => {
		const { provider, fetch } = harness([() => streamResponse([terminal(kind, tier)])]);
		const events = await collect(provider.stream(request({ speed: undefined })));
		expect(events.at(-1)).toMatchObject({
			type: "message_end",
			message: { stopReason: kind === "incomplete" ? "max_tokens" : "end_turn" },
		});
		expect(body(fetch.mock.calls[0]?.[1])).not.toHaveProperty("service_tier");
	});

	it.each(downgradeCases)(
		"$kind tier=$tier cannot start a branch-summary thinking retry",
		async ({ kind, tier }) => {
			const { provider, fetch } = harness([
				() =>
					streamResponse([
						terminal(kind, tier, {
							output: [{ type: "message", content: [{ type: "output_text", text: "rejected summary" }] }],
						}),
					]),
			]);
			await expect(
				summarizeBranchSegment({
					provider,
					model: "gpt-5.5",
					speed: "fast",
					thinking: "high",
					messages: [{ role: "user", content: "old work" }],
				}),
			).rejects.toHaveProperty("code", "service_tier_downgrade");
			expect(fetch).toHaveBeenCalledTimes(1);
			expect(body(fetch.mock.calls[0]?.[1])).toMatchObject({
				service_tier: "priority",
				reasoning: { effort: "high", summary: "auto" },
			});
		},
	);

	it.each(downgradeCases)(
		"$kind tier=$tier cannot persist a compaction checkpoint or retry thinking",
		async ({ kind, tier }) => {
			const root = mkTempDir("ink-session-");
			const session = createSession(root, root);
			session.appendMessage({ role: "user", content: "older work ".repeat(20) });
			session.appendMessage({ role: "user", content: "latest work ".repeat(20) });
			const original = session.buildContext();
			const append = vi.spyOn(session, "appendCompaction");
			const { provider, fetch } = harness([
				() =>
					streamResponse([
						terminal(kind, tier, {
							output: [{ type: "message", content: [{ type: "output_text", text: "rejected checkpoint" }] }],
						}),
					]),
			]);
			await expect(
				compactSession({
					session,
					provider,
					model: "gpt-5.5",
					speed: "fast",
					thinking: "high",
					settings: { reserveTokens: 64, keepRecentTokens: 1, contextWindow: 4096 },
				}),
			).rejects.toHaveProperty("code", "service_tier_downgrade");
			expect(fetch).toHaveBeenCalledTimes(1);
			expect(append).not.toHaveBeenCalled();
			expect(session.buildContext()).toEqual(original);
		},
	);
});
