import type { AgentMessage, AssistantBlock, ContentBlock, StopReason, Usage } from "../core/messages.js";
import { getCodexAccessToken } from "./codex-auth.js";
import {
	abortSafe,
	downgradeUnsupportedImages,
	parseSse,
	postJsonWithRetry,
	safeParseJson,
} from "./shared.js";
import { clampThinkingLevel, effortFor, thinkingMetaFor } from "./thinking.js";
import type { LLMEvent, LLMProvider, LLMRequest } from "./types.js";
import { modelSupportsVision } from "./vision.js";

/**
 * OpenAI Responses wire protocol as spoken by the Codex backend
 * (chatgpt.com/backend-api/codex/responses) — the ChatGPT-subscription
 * credential path. Auth comes from the device-code OAuth store
 * (~/.ink/auth.json, `ink login`); the chatgpt-account-id header is derived
 * from the access token's JWT claim.
 *
 * Wire shape differs from both prior protocols in the ways that matter:
 *   - the system prompt rides as the top-level `instructions` field
 *   - messages are `input` ITEMS: user text as input_text parts, a tool call
 *     as a standalone {type:"function_call"} item, results as
 *     {type:"function_call_output"} items
 *   - tools are flat {type:"function", name, parameters} (no nested function
 *     wrapper, unlike Chat Completions)
 *   - streams use `event:` lines: response.output_item.added creates a slot
 *     per output_index, deltas flow per slot, response.completed terminates
 *   - usage.input_tokens INCLUDES cached tokens — subtract for the
 *     anthropic-compatible inputTokens semantics
 *
 * Reasoning output (response.reasoning_* events) stays ignored: the codex
 * Responses protocol surfaces no reasoning deltas here, so there is
 * nothing to stream or store (the request-side reasoning.effort knob
 * landed with #thinking-levels).
 */

const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api";

export interface CodexResponsesProviderOptions {
	baseUrl?: string;
	/** Injectable for tests; default: the OAuth credential store. */
	auth?: () => Promise<{ accessToken: string; accountId: string }>;
}

interface InputItem {
	type?: string;
	role?: string;
	content?: unknown;
	call_id?: string;
	name?: string;
	arguments?: string;
	output?: string | unknown[];
	[key: string]: unknown;
}

/** pi openai-responses-shared parity (M13 §7): text-only → the pre-M13
 *  input_text shape; with images → input_image parts with data URLs. */
function toUserInputContent(content: string | ContentBlock[]): unknown {
	if (typeof content === "string") return [{ type: "input_text", text: content }];
	const parts: unknown[] = [];
	for (const block of content) {
		if (block.type === "text") parts.push({ type: "input_text", text: block.text });
		else
			parts.push({
				type: "input_image",
				detail: "auto",
				image_url: `data:${block.mimeType};base64,${block.data}`,
			});
	}
	return parts;
}

/** function_call_output: string for text-only, the input-part array when
 *  images ride the result (pi convertToolResultOutput parity). */
function toToolOutput(content: string | ContentBlock[]): string | unknown[] {
	if (typeof content === "string") return content;
	const text = content
		.filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
		.map((b) => b.text)
		.join("\n");
	const images = content.filter((b): b is Extract<ContentBlock, { type: "image" }> => b.type === "image");
	if (images.length === 0) return text;
	const parts: unknown[] = [];
	if (text !== "") parts.push({ type: "input_text", text });
	for (const image of images) {
		parts.push({
			type: "input_image",
			detail: "auto",
			image_url: `data:${image.mimeType};base64,${image.data}`,
		});
	}
	return parts;
}

function toInputItems(systemIgnored: string, messages: AgentMessage[]): InputItem[] {
	// system rides as `instructions` — the caller sets it; this parameter is
	// kept for signature symmetry with the other adapters' translators.
	void systemIgnored;
	const items: InputItem[] = [];
	for (const msg of messages) {
		switch (msg.role) {
			case "user":
				items.push({ role: "user", content: toUserInputContent(msg.content) });
				break;
			case "assistant": {
				const text = msg.blocks
					.filter((b): b is Extract<AssistantBlock, { type: "text" }> => b.type === "text")
					.map((b) => b.text)
					.join("\n");
				if (text !== "") items.push({ role: "assistant", content: [{ type: "output_text", text }] });
				for (const block of msg.blocks) {
					if (block.type !== "toolCall") continue;
					items.push({
						type: "function_call",
						call_id: block.id,
						name: block.name,
						arguments: JSON.stringify(block.arguments),
					});
				}
				break;
			}
			case "toolResult":
				for (const r of msg.results) {
					items.push({
						type: "function_call_output",
						call_id: r.toolCallId,
						output: toToolOutput(r.content),
					});
				}
				break;
			default: {
				const exhaustive: never = msg;
				throw new Error(`unreachable message role: ${JSON.stringify(exhaustive)}`);
			}
		}
	}
	return items;
}

interface ResponsesUsage {
	input_tokens?: number;
	output_tokens?: number;
	input_tokens_details?: { cached_tokens?: number };
}

function usageFromResponse(raw: ResponsesUsage | undefined): Usage {
	const input = raw?.input_tokens ?? 0;
	const cached = raw?.input_tokens_details?.cached_tokens ?? 0;
	return {
		// api semantics: input_tokens includes cache reads — subtract to match
		// the anthropic inputTokens convention the ctx% math assumes
		inputTokens: Math.max(0, input - cached),
		outputTokens: raw?.output_tokens ?? 0,
		cacheReadTokens: cached > 0 ? cached : undefined,
	};
}

type ToolCallBlock = Extract<AssistantBlock, { type: "toolCall" }>;
interface ToolSlot {
	type: "toolCall";
	block: ToolCallBlock;
	index: number;
	itemId?: string;
	raw: string;
	argumentsDone: boolean;
	done: boolean;
}
type OutputSlot = ToolSlot | { type: "text"; block: Extract<AssistantBlock, { type: "text" }> };

function protocolError(event: string, index: unknown, reason: string): Error {
	// Never include argument text, untrusted identities, or native JSON errors.
	const location = typeof index === "number" ? ` at output_index ${index}` : "";
	return new Error(`Codex protocol error (${event}${location}): ${reason}`);
}

function requireIndex(value: unknown, event: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw protocolError(event, undefined, "expected a nonnegative integer output_index");
	}
	return value;
}

function identityField(item: Record<string, unknown>, key: string, event: string, index: unknown) {
	const value = item[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.trim() === "") {
		throw protocolError(event, index, `expected a nonempty string ${key}`);
	}
	return value;
}

/** Reconcile incremental and final argument sources without mixing calls.
 * Final blocks follow output_index, not discovery order (a done item can
 * introduce a call whose added event was absent). Streaming stays in arrival order. */
class CodexOutput {
	private readonly slots = new Map<number, OutputSlot>();
	private readonly toolsByItemId = new Map<string, ToolSlot>();
	private readonly callIds = new Set<string>();

	private bindItemId(slot: ToolSlot, itemId: string | undefined, event: string): void {
		if (itemId === undefined) return;
		const owner = this.toolsByItemId.get(itemId);
		if ((slot.itemId !== undefined && slot.itemId !== itemId) || (owner !== undefined && owner !== slot)) {
			throw protocolError(event, slot.index, "conflicting or duplicate tool item ID");
		}
		slot.itemId = itemId;
		this.toolsByItemId.set(itemId, slot);
	}

	private createTool(index: number, item: Record<string, unknown>, event: string): ToolSlot {
		if (this.slots.has(index)) throw protocolError(event, index, "duplicate output slot");
		const callId = identityField(item, "call_id", event, index);
		const name = identityField(item, "name", event, index);
		if (callId === undefined || name === undefined) {
			throw protocolError(event, index, "a new function call requires call_id and name");
		}
		if (this.callIds.has(callId)) throw protocolError(event, index, "duplicate tool call ID");
		const slot: ToolSlot = {
			type: "toolCall",
			block: { type: "toolCall", id: callId, name, arguments: {} },
			index,
			raw: "",
			argumentsDone: false,
			done: false,
		};
		this.bindItemId(slot, identityField(item, "id", event, index), event);
		this.slots.set(index, slot);
		this.callIds.add(callId);
		return slot;
	}

	private argumentSlot(data: Record<string, unknown>, event: string): ToolSlot {
		const itemId = identityField(data, "item_id", event, data.output_index);
		let slot: OutputSlot | undefined;
		if (data.output_index !== undefined) {
			slot = this.slots.get(requireIndex(data.output_index, event));
		} else if (itemId !== undefined) {
			slot = this.toolsByItemId.get(itemId);
		}
		if (slot?.type !== "toolCall") {
			throw protocolError(event, data.output_index, "unknown function call target");
		}
		// An indexed event may first-bind an ID omitted by the added item.
		// Index-less events can only resolve a binding that already exists.
		this.bindItemId(slot, itemId, event);
		return slot;
	}

	private *snapshot(slot: ToolSlot, value: unknown, event: string): Generator<LLMEvent> {
		if (value === undefined) return;
		if (typeof value !== "string") {
			throw protocolError(event, slot.index, "expected string arguments");
		}
		if (value.trim() === "") return; // omission/blank must not erase a known buffer
		const previous = slot.raw;
		slot.raw = value;
		// The event interface is append-only: corrections are authoritative in
		// message_end, while an extending snapshot can stream just its suffix.
		if (value.startsWith(previous) && value.length > previous.length) {
			yield { type: "tool_call_delta", id: slot.block.id, jsonDelta: value.slice(previous.length) };
		}
	}

	*addItem(data: Record<string, unknown>): Generator<LLMEvent> {
		const item = (data.item ?? {}) as Record<string, unknown>;
		if (item.type !== "message" && item.type !== "function_call") return;
		const event = "response.output_item.added";
		const index = requireIndex(data.output_index, event);
		if (this.slots.has(index)) throw protocolError(event, index, "duplicate output slot");
		if (item.type === "message") {
			this.slots.set(index, { type: "text", block: { type: "text", text: "" } });
		} else {
			const slot = this.createTool(index, item, event);
			yield { type: "tool_call_start", id: slot.block.id, name: slot.block.name };
			yield* this.snapshot(slot, item.arguments, event);
		}
	}

	textDelta(data: Record<string, unknown>): LLMEvent | undefined {
		const slot = this.slots.get(data.output_index as number);
		if (slot?.type !== "text") return undefined;
		const delta = String(data.delta ?? "");
		slot.block.text += delta;
		return { type: "text_delta", text: delta };
	}

	*appendArguments(data: Record<string, unknown>): Generator<LLMEvent> {
		const event = "response.function_call_arguments.delta";
		const slot = this.argumentSlot(data, event);
		if (slot.argumentsDone || slot.done) throw protocolError(event, slot.index, "arguments already closed");
		if (typeof data.delta !== "string") throw protocolError(event, slot.index, "expected string delta");
		slot.raw += data.delta;
		if (data.delta !== "") yield { type: "tool_call_delta", id: slot.block.id, jsonDelta: data.delta };
	}

	*finishArguments(data: Record<string, unknown>): Generator<LLMEvent> {
		const event = "response.function_call_arguments.done";
		const slot = this.argumentSlot(data, event);
		if (slot.argumentsDone || slot.done) throw protocolError(event, slot.index, "arguments already closed");
		if (typeof data.arguments !== "string") {
			throw protocolError(event, slot.index, "expected string arguments");
		}
		yield* this.snapshot(slot, data.arguments, event);
		slot.argumentsDone = true;
	}

	*finishItem(data: Record<string, unknown>): Generator<LLMEvent> {
		const item = (data.item ?? {}) as Record<string, unknown>;
		if (item.type !== "function_call") return; // text/reasoning snapshots are outside this repair
		const event = "response.output_item.done";
		const index = requireIndex(data.output_index, event);
		let slot = this.slots.get(index);
		if (slot === undefined) {
			slot = this.createTool(index, item, event);
			yield { type: "tool_call_start", id: slot.block.id, name: slot.block.name };
		}
		if (slot.type !== "toolCall") throw protocolError(event, index, "function call collides with text slot");
		if (slot.done) throw protocolError(event, index, "function call already closed");
		for (const [key, expected] of [
			["call_id", slot.block.id],
			["name", slot.block.name],
		] as const) {
			const supplied = identityField(item, key, event, index);
			if (supplied !== undefined && supplied !== expected) {
				throw protocolError(event, index, `conflicting function call ${key}`);
			}
		}
		this.bindItemId(slot, identityField(item, "id", event, index), event);
		yield* this.snapshot(slot, item.arguments, event);
		slot.done = true;
	}

	blocks(incomplete: boolean): AssistantBlock[] {
		return [...this.slots.entries()]
			.sort(([a], [b]) => a - b)
			.map(([index, slot]) => {
				if (slot.type === "text") return slot.block;
				if (incomplete) {
					// The loop refuses the entire max_tokens batch. Preserve its existing
					// partial-message/usage/replay behavior rather than throwing here.
					slot.block.arguments = slot.raw.trim() === "" ? {} : safeParseJson(slot.raw);
				} else {
					const event = "response.completed";
					if (!slot.done) throw protocolError(event, index, "function call missing output_item.done");
					if (slot.raw.trim() === "") throw protocolError(event, index, "function call has no argument data");
					try {
						slot.block.arguments = JSON.parse(slot.raw);
					} catch {
						throw protocolError(event, index, "function call arguments are not valid JSON");
					}
				}
				return slot.block;
			});
	}
}

/** One SSE item may emit start + snapshot. Check before advancing the
 * suspended assembler again, not merely after its next yield: it may throw
 * while inspecting a snapshot the caller cancelled at tool_call_start. */
function* untilAborted(events: Iterable<LLMEvent>, signal?: AbortSignal): Generator<LLMEvent> {
	if (signal?.aborted) return;
	for (const event of events) {
		yield event;
		if (signal?.aborted) return;
	}
}

export function createCodexResponsesProvider(options: CodexResponsesProviderOptions = {}): LLMProvider {
	const baseUrl = (options.baseUrl ?? process.env.OPENAI_CODEX_BASE_URL ?? DEFAULT_BASE_URL).replace(
		/\/+$/,
		"",
	);
	const auth = options.auth ?? (() => getCodexAccessToken());

	return {
		name: "openai-codex",
		async *stream(request: LLMRequest): AsyncIterable<LLMEvent> {
			if (request.signal?.aborted) return; // before auth: the refresh POST is not abortable (review F5)
			const credential = await auth();
			if (request.signal?.aborted) return;

			const body: Record<string, unknown> = {
				model: request.model,
				store: false,
				stream: true,
				instructions: request.system,
				input: toInputItems(
					request.system,
					downgradeUnsupportedImages(request.messages, modelSupportsVision("openai-codex", request.model)),
				),
				parallel_tool_calls: true,
				// NOTE: no max_output_tokens — the ChatGPT backend REJECTS it
				// ("Unsupported parameter", live 400 on the first real turn). The
				// reference implementation sends none either; output limits are
				// plan/policy-managed server-side. request.maxTokens is simply
				// not applicable to this family.
			};
			// Thinking (#thinking-levels, pi parity): the Responses protocol
			// takes a reasoning object. Effort values come from the model's
			// level map (pi.dev catalog: gpt-5.3+ minimal→"low", xhigh native;
			// gpt-6 max native). "off" sends effort:"none" — the backend
			// defaults reasoning-capable models to medium, so omission would
			// not disable anything (pi openai-responses.js:240).
			const meta = thinkingMetaFor("openai-codex", request.model);
			const level = request.thinking !== undefined ? clampThinkingLevel(meta, request.thinking) : undefined;
			if (level !== undefined && level !== "off") {
				body.reasoning = { effort: effortFor(meta, level), summary: "auto" };
			} else if ((level === undefined || level === "off") && meta !== null && meta.levelMap?.off !== null) {
				// "off" AND undefined (the runner maps off→undefined — pi
				// :238): explicit "none"; off:null models (gpt-6) never land here.
				body.reasoning = { effort: meta.levelMap?.off ?? "none" };
			}
			if (request.tools.length > 0) {
				body.tools = request.tools.map((t) => ({
					type: "function",
					name: t.name,
					description: t.description,
					parameters: t.parameters,
					strict: false,
				}));
				body.tool_choice = "auto";
			}

			const response = await postJsonWithRetry(
				`${baseUrl}/codex/responses`,
				{
					"content-type": "application/json",
					accept: "text/event-stream",
					authorization: `Bearer ${credential.accessToken}`,
					"chatgpt-account-id": credential.accountId,
					originator: "ink",
					"OpenAI-Beta": "responses=experimental",
				},
				JSON.stringify(body),
				request.signal,
				"Codex",
			);
			if (response === null) return; // aborted mid-connect
			if (!response.ok || !response.body) {
				const text = await response.text().catch(() => "");
				const hint =
					response.status === 401
						? " — run: ink login"
						: response.status === 404
							? " — check the model id (a Codex/ChatGPT model name, e.g. openai-codex/gpt-5.5)"
							: "";
				throw new Error(`OpenAI Codex API error ${response.status}${hint}: ${text.slice(0, 500)}`);
			}

			const output = new CodexOutput();
			let usage: Usage = { inputTokens: 0, outputTokens: 0 };
			// SA-04: did a mapped counter hold a number on the terminal event?
			let sawUsage = false;
			let stopReason: StopReason = null;
			let sawCompleted = false;

			for await (const sse of abortSafe(parseSse(response.body), request.signal)) {
				if (request.signal?.aborted) return;
				const data = sse.data as Record<string, unknown>;

				switch (sse.event) {
					case "response.output_item.added":
						yield* untilAborted(output.addItem(data), request.signal);
						break;
					case "response.output_text.delta": {
						const delta = output.textDelta(data);
						if (delta !== undefined) yield delta;
						break;
					}
					case "response.function_call_arguments.delta":
						yield* untilAborted(output.appendArguments(data), request.signal);
						break;
					case "response.function_call_arguments.done":
						yield* untilAborted(output.finishArguments(data), request.signal);
						break;
					case "response.output_item.done":
						yield* untilAborted(output.finishItem(data), request.signal);
						break;
					case "response.completed":
					case "response.incomplete": {
						sawCompleted = true;
						const responseObj = (data.response ?? {}) as Record<string, unknown>;
						const rawUsage = responseObj.usage as ResponsesUsage | undefined;
						if (
							typeof rawUsage?.input_tokens === "number" ||
							typeof rawUsage?.output_tokens === "number" ||
							typeof rawUsage?.input_tokens_details?.cached_tokens === "number"
						) {
							sawUsage = true;
						}
						usage = usageFromResponse(rawUsage);
						const status = String(responseObj.status ?? "completed");
						if (sse.event === "response.incomplete" || status === "incomplete") {
							stopReason = "max_tokens";
						} else {
							stopReason = "end_turn";
						}
						break;
					}
					case "response.failed": {
						const responseObj = (data.response ?? {}) as Record<string, unknown>;
						const error = (responseObj.error ?? data.error ?? {}) as Record<string, unknown>;
						throw new Error(
							`Codex response failed: ${String(error.message ?? JSON.stringify(data).slice(0, 300))}`,
						);
					}
					case "error": {
						throw new Error(
							`Codex stream error: ${String(data.message ?? JSON.stringify(data).slice(0, 300))}`,
						);
					}
					default:
						// Reasoning deltas / unknown events: intentionally ignored.
						break;
				}
				if (request.signal?.aborted) return;
			}

			if (request.signal?.aborted) return;
			// A stream without a terminal event was truncated — fail loudly
			// rather than persisting a partial turn as complete.
			if (!sawCompleted) {
				throw new Error("Codex stream ended without response.completed — response may be truncated");
			}
			const blocks = output.blocks(stopReason === "max_tokens");
			if (stopReason === null && blocks.some((b) => b.type === "toolCall")) stopReason = "tool_use";
			if (stopReason === "end_turn" && blocks.some((b) => b.type === "toolCall")) stopReason = "tool_use";
			if (blocks.length === 0) blocks.push({ type: "text", text: "(empty)" });
			yield {
				type: "message_end",
				message: {
					role: "assistant",
					blocks,
					usage,
					stopReason,
					...(sawUsage ? {} : { usageMissing: true as const }),
				},
			};
		},
	};
}
