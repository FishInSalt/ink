import { createHash } from "node:crypto";
import type { StopReason, Usage } from "../core/messages.js";
import { parseServiceTierReport, type ServiceTierReport } from "../core/service-tier.js";
import { getCodexAccessToken } from "./codex-auth.js";
import { canRequestFastMode } from "./model-speed.js";
import {
	CodexResponseError,
	diagnosticField,
	protocolError,
	record,
	responseError,
} from "./responses-errors.js";
import { toResponsesInput } from "./responses-history.js";
import { CodexOutput } from "./responses-output.js";
import { parseResponsesSse } from "./responses-sse.js";
import { postResponses, responsesEndpoint } from "./responses-transport.js";
import { abortSafe, downgradeUnsupportedImages, wrapStreamInterruptions } from "./shared.js";
import { clampThinkingLevel, effortFor, thinkingMetaFor } from "./thinking.js";
import type { LLMEvent, LLMProvider, LLMRequest } from "./types.js";
import { modelSupportsVision } from "./vision.js";

export { CodexResponseError } from "./responses-errors.js";

/** The complete identity stays hashed; raw session IDs never leave Ink. */
function sessionKey(sessionId: unknown): string | undefined {
	if (typeof sessionId !== "string" || sessionId === "") return undefined;
	return createHash("sha256").update("ink-codex-session-v1\0").update(sessionId).digest("hex");
}

export interface CodexResponsesProviderOptions {
	/** API base, default https://api.openai.com/v1 (not the old backend-api). */
	baseUrl?: string;
	/** Test seam; HTTP is allowed only with explicit loopback base + injection. */
	auth?: (options?: { signal?: AbortSignal }) => Promise<{ accessToken: string }>;
	fetch?: typeof fetch;
}

function usageFromResponse(value: unknown): { usage: Usage; sawUsage: boolean } {
	const raw = record(value) ?? {};
	const inputDetails = record(raw.input_tokens_details) ?? {};
	const counter = (value: unknown): number | undefined =>
		typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
	const input = counter(raw.input_tokens);
	const cached = counter(inputDetails.cached_tokens);
	const written = counter(inputDetails.cache_write_tokens);
	const output = counter(raw.output_tokens);
	return {
		sawUsage: [input, cached, written, output].some((v) => v !== undefined),
		usage: {
			inputTokens: Math.max(0, (input ?? 0) - (cached ?? 0) - (written ?? 0)),
			// Responses output_tokens already includes reasoning_tokens.
			outputTokens: output ?? 0,
			cacheReadTokens: cached !== undefined && cached > 0 ? cached : undefined,
			...(written === undefined ? {} : { cacheWriteTokens: written }),
		},
	};
}

/** Stop before resuming a suspended assembler after a yielded start/delta.
 * A cancellation at tool_call_start must not inspect the deferred arguments. */
function* untilAborted(events: Iterable<LLMEvent>, signal?: AbortSignal): Generator<LLMEvent> {
	if (signal?.aborted) return;
	for (const event of events) {
		yield event;
		if (signal?.aborted) return;
	}
}

/** Conservative structured evidence, not a guarantee of Fast entitlement.
 * Unknown/hostile errors stay unchanged; status, message and param alone do
 * not establish a service-tier rejection. */
function isServiceTierRejection(error: unknown): error is CodexResponseError {
	try {
		if (!(error instanceof CodexResponseError)) return false;
		const code = error.code;
		return (
			code === "unsupported_service_tier" ||
			code === "invalid_service_tier" ||
			code === "tier_unavailable" ||
			(code === "unsupported_parameter" && error.param === "service_tier")
		);
	} catch {
		return false;
	}
}

/** Validate the raw boundary before the underlying generator can read auth.
 * Keep typed diagnostics intact, adding guidance only for explicit tier
 * rejections without retrying or changing model, speed, or credential route. */
function withFastMode(provider: LLMProvider): LLMProvider {
	return {
		name: provider.name,
		async *stream(request: LLMRequest): AsyncIterable<LLMEvent> {
			if (request.signal?.aborted) return;
			const speed: unknown = request.speed;
			if (speed !== undefined && speed !== "fast") {
				throw new CodexResponseError('Invalid Codex speed: expected "fast" or no speed', {
					code: "invalid_speed",
					param: "speed",
				});
			}
			if (
				speed === "fast" &&
				(typeof request.model !== "string" || !canRequestFastMode(provider.name, request.model))
			) {
				throw new CodexResponseError("Codex Fast requires an undecorated base model ID without whitespace", {
					code: "invalid_model",
					param: "model",
				});
			}
			try {
				yield* provider.stream(request);
			} catch (error) {
				if (speed === "fast" && isServiceTierRejection(error)) {
					try {
						const message = `${error.message} — To retry without Fast, explicitly select the normal model with /model.`;
						try {
							error.message = message;
						} catch {
							// A configurable getter-only message can still receive
							// the hint without replacing the original error.
							Object.defineProperty(error, "message", { value: message, writable: true, configurable: true });
						}
					} catch {
						// Immutable errors or throwing accessors must retain the
						// original failure, never an annotation-induced exception.
					}
				}
				throw error;
			}
		},
	};
}

export function createCodexResponsesProvider(options: CodexResponsesProviderOptions = {}): LLMProvider {
	const explicitBase = options.baseUrl;
	const endpoint = responsesEndpoint(
		explicitBase ?? process.env.OPENAI_CODEX_BASE_URL,
		explicitBase !== undefined && (options.auth !== undefined || options.fetch !== undefined),
	);
	const auth = options.auth ?? getCodexAccessToken;
	return withFastMode({
		name: "openai-codex",
		async *stream(request: LLMRequest): AsyncIterable<LLMEvent> {
			if (request.signal?.aborted) return;
			// Validate persisted native data before consulting credentials/network.
			const input: unknown[] = toResponsesInput(
				downgradeUnsupportedImages(request.messages, modelSupportsVision("openai-codex", request.model)),
				request.model,
			);
			if (request.tools.length > 0) {
				input.unshift({
					type: "additional_tools",
					role: "developer",
					tools: request.tools.map((tool) => ({
						type: "function",
						name: tool.name,
						description: tool.description,
						parameters: tool.parameters,
						strict: false,
					})),
				});
			}
			let credential: { accessToken: string };
			try {
				credential = await auth({ signal: request.signal });
			} catch (error) {
				if (request.signal?.aborted) return;
				throw error;
			}
			if (request.signal?.aborted) return;
			const key = sessionKey(request.sessionId);
			const body: Record<string, unknown> = {
				model: request.model,
				...(request.speed === "fast" ? { service_tier: "priority" } : {}),
				store: false,
				stream: true,
				instructions: request.system,
				input,
				include: ["reasoning.encrypted_content"],
				parallel_tool_calls: true,
				...(key === undefined ? {} : { prompt_cache_key: key }),
				// No previous_response_id, temperature, max_output_tokens or cache
				// retention: full stateless replay; output is plan/policy-managed.
			};
			const meta = thinkingMetaFor("openai-codex", request.model);
			const level = request.thinking !== undefined ? clampThinkingLevel(meta, request.thinking) : undefined;
			if (level !== undefined && level !== "off") {
				body.reasoning = { effort: effortFor(meta, level), summary: "auto" };
			} else if (meta !== null && meta.levelMap?.off !== null) {
				body.reasoning = { effort: meta.levelMap?.off ?? "none" };
			}
			const response = await postResponses({
				url: endpoint,
				headers: {
					"content-type": "application/json",
					accept: "text/event-stream",
					authorization: `Bearer ${credential.accessToken}`,
					...(key === undefined ? {} : { session_id: key, "x-client-request-id": key }),
				},
				body: JSON.stringify(body),
				signal: request.signal,
				fetch: options.fetch ?? fetch,
				redactions: [credential.accessToken],
			});
			if (response === null || request.signal?.aborted) return;
			const errorFields = {
				status: response.status,
				requestId: response.headers.get("x-request-id") ?? undefined,
				redactions: [credential.accessToken],
			};
			const output = new CodexOutput();
			let usage: Usage = { inputTokens: 0, outputTokens: 0 };
			let sawUsage = false;
			let stopReason: StopReason = null;
			let terminal = false;
			let serviceTier: ServiceTierReport | undefined;
			for await (const sse of abortSafe(
				wrapStreamInterruptions(parseResponsesSse(response.body!, request.signal), "Codex"),
				request.signal,
			)) {
				if (request.signal?.aborted) return;
				const data = sse.data;
				let events: Iterable<LLMEvent> = [];
				switch (sse.event) {
					case "response.output_item.added":
						events = output.addItem(data);
						break;
					case "response.output_item.done":
						events = output.finishItem(data);
						break;
					case "response.function_call_arguments.delta":
						events = output.appendArguments(data);
						break;
					case "response.function_call_arguments.done":
						events = output.finishArguments(data);
						break;
					case "response.output_text.delta":
					case "response.output_text.done":
					case "response.refusal.delta":
					case "response.refusal.done":
						events = output.textEvent(data, sse.event);
						break;
					case "response.content_part.added":
					case "response.content_part.done":
					case "response.reasoning_summary_part.added":
					case "response.reasoning_summary_part.done":
						events = output.partEvent(data, sse.event);
						break;
					case "response.reasoning_summary_text.delta":
					case "response.reasoning_summary_text.done":
					case "response.reasoning_text.delta":
					case "response.reasoning_text.done":
						events = output.reasoningEvent(data, sse.event);
						break;
					case "response.completed":
					case "response.incomplete": {
						const final = record(data.response);
						if (!final) throw protocolError("terminal", undefined, "expected response object");
						const status = final.status;
						const incomplete = sse.event === "response.incomplete" || status === "incomplete";
						if (status !== undefined && status !== "completed" && status !== "incomplete") {
							throw responseError(final, {
								...errorFields,
								reason: diagnosticField(status),
								label: "Codex response did not complete",
							});
						}
						if (incomplete) {
							const reason = diagnosticField(record(final.incomplete_details)?.reason);
							if (reason !== "max_output_tokens") {
								throw responseError(final, {
									...errorFields,
									reason: reason ?? "unknown_incomplete",
									label: "Codex response incomplete",
								});
							}
						}
						if (record(final.error))
							throw responseError(final, { ...errorFields, label: "Codex response failed" });
						// Fast requests priority, not priority-or-error. Keep the terminal
						// report unchanged; created-event metadata is not authoritative.
						const tier = final.service_tier;
						serviceTier = parseServiceTierReport({
							requested: body.service_tier === "priority" ? "priority" : "omitted",
							reported:
								typeof tier === "string" &&
								credential.accessToken !== "" &&
								tier.includes(credential.accessToken)
									? undefined
									: tier,
						});
						({ usage, sawUsage } = usageFromResponse(final.usage));
						stopReason = incomplete ? "max_tokens" : "end_turn";
						events = output.reconcile(final.output, incomplete);
						terminal = true;
						break;
					}
					case "response.failed":
					case "response.cancelled":
						throw responseError(record(data.response) ?? data, {
							...errorFields,
							label: "Codex response failed",
							reason: sse.event === "response.cancelled" ? "cancelled" : "failed",
						});
					case "error":
						throw responseError(data, { ...errorFields, reason: "error", label: "Codex stream error" });
					default:
						break; // lifecycle/annotations/unknown non-executable events
				}
				yield* untilAborted(events, request.signal);
				if (request.signal?.aborted) return;
				if (terminal) break; // cancel reader immediately; never wait for EOF/[DONE]
			}
			if (request.signal?.aborted) return;
			if (!terminal)
				throw new CodexResponseError(
					"Codex stream ended without response.completed — response may be truncated",
					{ code: "missing_terminal" },
				);
			const blocks = output.blocks(stopReason === "max_tokens");
			if (stopReason === "end_turn" && blocks.some((b) => b.type === "toolCall")) stopReason = "tool_use";
			if (blocks.length === 0) blocks.push({ type: "text", text: "(empty)" });
			yield {
				type: "message_end",
				message: {
					role: "assistant",
					blocks,
					usage,
					stopReason,
					serviceTier,
					provenance: { version: 1, provider: "openai-codex", model: request.model },
					...(sawUsage ? {} : { usageMissing: true as const }),
				},
			};
		},
	});
}
