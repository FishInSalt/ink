import { isDeepStrictEqual } from "node:util";
import type { AssistantBlock, ResponsesReasoningReplay } from "../core/messages.js";
import { protocolError, record } from "./responses-errors.js";
import type { LLMEvent } from "./types.js";

type Fields = Record<string, unknown>;
type ToolBlock = Extract<AssistantBlock, { type: "toolCall" }>;
interface BaseSlot {
	index: number;
	itemId?: string;
	done: boolean;
	finalStatus?: "in_progress" | "completed" | "incomplete";
}
interface ToolSlot extends BaseSlot {
	type: "toolCall";
	block: ToolBlock;
	namespace?: string;
	raw: string;
	argumentsDone: boolean;
}
interface TextPart {
	kind: "output_text" | "refusal";
	text: string;
	done: boolean;
}
interface TextSlot extends BaseSlot {
	type: "text";
	parts: Map<number, TextPart>;
	phase?: "commentary" | "final_answer" | null;
}
interface ReasoningSlot extends BaseSlot {
	type: "thinking";
	summary: Map<number, { text: string; done: boolean }>;
	content: Map<number, { text: string; done: boolean }>;
	encryptedContent?: string;
}
type Slot = ToolSlot | TextSlot | ReasoningSlot;

function requireIndex(value: unknown, event: string, field = "output_index"): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw protocolError(event, undefined, `expected a nonnegative integer ${field}`);
	}
	return value;
}
function identityField(item: Fields, key: string, event: string, index: unknown): string | undefined {
	const value = item[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.trim() === "") {
		throw protocolError(event, index, `expected a nonempty string ${key}`);
	}
	return value;
}
function stringField(value: unknown, event: string, index: unknown): string {
	if (typeof value !== "string") throw protocolError(event, index, "expected string content");
	return value;
}
function contiguous<T>(parts: Map<number, T>, index: number): T[] {
	const sorted = [...parts.entries()].sort(([a], [b]) => a - b);
	for (const [i, [key]] of sorted.entries()) {
		if (key !== i) throw protocolError("response.completed", index, "noncontiguous content indices");
	}
	return sorted.map(([, part]) => part);
}

/** Strict output assembly. Slots are independent so parallel/interleaved deltas
 * cannot cross identities. Final snapshots correct canonical blocks; UI deltas
 * remain append-only. Only output_item.done closes an executable function call. */
export class CodexOutput {
	private readonly slots = new Map<number, Slot>();
	private readonly byItemId = new Map<string, Slot>();
	private readonly callIds = new Set<string>();

	private bindItemId(slot: Slot, id: string | undefined, event: string): void {
		if (id === undefined) return;
		const owner = this.byItemId.get(id);
		if ((slot.itemId !== undefined && slot.itemId !== id) || (owner !== undefined && owner !== slot)) {
			throw protocolError(event, slot.index, "conflicting or duplicate item ID");
		}
		slot.itemId = id;
		this.byItemId.set(id, slot);
	}
	private target(data: Fields, event: string): Slot {
		const id = identityField(data, "item_id", event, data.output_index);
		const slot =
			data.output_index !== undefined
				? this.slots.get(requireIndex(data.output_index, event))
				: id === undefined
					? undefined
					: this.byItemId.get(id);
		if (!slot) throw protocolError(event, data.output_index, "unknown output target");
		this.bindItemId(slot, id, event);
		return slot;
	}
	private toolTarget(data: Fields, event: string): ToolSlot {
		const slot = this.target(data, event);
		if (slot.type !== "toolCall") throw protocolError(event, slot.index, "unknown function call target");
		return slot;
	}
	private create(index: number, item: Fields, event: string): Slot {
		if (this.slots.has(index)) throw protocolError(event, index, "duplicate output slot");
		let slot: Slot;
		if (item.type === "message") {
			slot = { type: "text", index, done: false, parts: new Map() };
		} else if (item.type === "reasoning") {
			slot = { type: "thinking", index, done: false, summary: new Map(), content: new Map() };
		} else if (item.type === "function_call") {
			const callId = identityField(item, "call_id", event, index);
			const name = identityField(item, "name", event, index);
			if (callId === undefined || name === undefined) {
				throw protocolError(event, index, "a new function call requires call_id and name");
			}
			if (this.callIds.has(callId)) throw protocolError(event, index, "duplicate tool call ID");
			slot = {
				type: "toolCall",
				index,
				done: false,
				block: { type: "toolCall", id: callId, name, arguments: {} },
				raw: "",
				argumentsDone: false,
			};
			this.callIds.add(callId);
		} else throw protocolError(event, index, "unsupported output item type");
		this.bindItemId(slot, identityField(item, "id", event, index), event);
		this.slots.set(index, slot);
		return slot;
	}
	private check(slot: Slot, item: Fields, event: string): void {
		if (
			item.status !== undefined &&
			item.status !== "in_progress" &&
			item.status !== "completed" &&
			item.status !== "incomplete"
		)
			throw protocolError(event, slot.index, "invalid output item status");
		const expected =
			slot.type === "toolCall" ? "function_call" : slot.type === "text" ? "message" : "reasoning";
		if (item.type !== expected) throw protocolError(event, slot.index, "conflicting output item type");
		this.bindItemId(slot, identityField(item, "id", event, slot.index), event);
		if (slot.type === "toolCall") {
			for (const [key, expected] of [
				["call_id", slot.block.id],
				["name", slot.block.name],
			] as const) {
				const value = identityField(item, key, event, slot.index);
				if (value !== undefined && value !== expected)
					throw protocolError(event, slot.index, `conflicting function call ${key}`);
			}
			const namespace = identityField(item, "namespace", event, slot.index);
			if (namespace !== undefined) {
				if (slot.namespace !== undefined && namespace !== slot.namespace)
					throw protocolError(event, slot.index, "conflicting function namespace");
				slot.namespace = namespace;
			}
		} else if (slot.type === "text") {
			if (item.role !== undefined && item.role !== "assistant")
				throw protocolError(event, slot.index, "expected assistant role");
			if (item.phase === null) slot.phase = null;
			else if (item.phase !== undefined) {
				if (item.phase !== "commentary" && item.phase !== "final_answer")
					throw protocolError(event, slot.index, "invalid message phase");
				slot.phase = item.phase;
			}
		}
	}
	private *argumentsSnapshot(slot: ToolSlot, value: unknown, event: string): Generator<LLMEvent> {
		if (value === undefined) return;
		if (typeof value !== "string") throw protocolError(event, slot.index, "expected string arguments");
		if (value.trim() === "") return;
		const previous = slot.raw;
		slot.raw = value;
		if (value.startsWith(previous) && value.length > previous.length) {
			yield { type: "tool_call_delta", id: slot.block.id, jsonDelta: value.slice(previous.length) };
		}
	}
	private *textSnapshot(slot: TextSlot, value: unknown, event: string): Generator<LLMEvent> {
		if (value === undefined) return;
		if (!Array.isArray(value)) throw protocolError(event, slot.index, "expected content parts");
		const parts = new Map<number, TextPart>();
		for (const [index, raw] of value.entries()) {
			const part = record(raw);
			if (!part || (part.type !== "output_text" && part.type !== "refusal"))
				throw protocolError(event, slot.index, "invalid message content part");
			const text = stringField(part.type === "refusal" ? part.refusal : part.text, event, slot.index);
			const previous = slot.parts.get(index)?.text ?? "";
			parts.set(index, { kind: part.type, text, done: event !== "response.output_item.added" });
			if (text.startsWith(previous) && text.length > previous.length)
				yield { type: "text_delta", text: text.slice(previous.length) };
		}
		slot.parts = parts;
	}
	private *reasoningSnapshot(
		slot: ReasoningSlot,
		item: Fields,
		final: boolean,
		event: string,
	): Generator<LLMEvent> {
		for (const [field, kind] of [
			["summary", "summary_text"],
			["content", "reasoning_text"],
		] as const) {
			const value = item[field];
			if (value === undefined) continue;
			if (!Array.isArray(value)) throw protocolError(event, slot.index, "expected reasoning parts");
			const parts = new Map<number, { text: string; done: boolean }>();
			for (const [index, raw] of value.entries()) {
				const part = record(raw);
				if (!part || part.type !== kind) throw protocolError(event, slot.index, "invalid reasoning part");
				const text = stringField(part.text, event, slot.index);
				const previous = slot[field].get(index)?.text ?? "";
				parts.set(index, { text, done: final });
				if (text.startsWith(previous) && text.length > previous.length)
					yield { type: "thinking_delta", text: text.slice(previous.length) };
			}
			slot[field] = parts;
		}
		// Added-event ciphertext is explicitly provisional. Never persist it.
		if (final && item.encrypted_content !== undefined) {
			if (item.encrypted_content !== null && typeof item.encrypted_content !== "string")
				throw protocolError(event, slot.index, "invalid encrypted reasoning");
			slot.encryptedContent = item.encrypted_content === null ? undefined : item.encrypted_content;
		}
	}
	*addItem(data: Fields): Generator<LLMEvent> {
		const event = "response.output_item.added";
		const item = record(data.item);
		if (!item) throw protocolError(event, data.output_index, "expected output item");
		const slot = this.create(requireIndex(data.output_index, event), item, event);
		if (slot.type === "toolCall") yield { type: "tool_call_start", id: slot.block.id, name: slot.block.name };
		this.check(slot, item, event);
		if (slot.type === "toolCall") yield* this.argumentsSnapshot(slot, item.arguments, event);
		else if (slot.type === "text") yield* this.textSnapshot(slot, item.content, event);
		else yield* this.reasoningSnapshot(slot, item, false, event);
	}
	*appendArguments(data: Fields): Generator<LLMEvent> {
		const event = "response.function_call_arguments.delta";
		const slot = this.toolTarget(data, event);
		if (slot.argumentsDone || slot.done) throw protocolError(event, slot.index, "arguments already closed");
		if (typeof data.delta !== "string") throw protocolError(event, slot.index, "expected string delta");
		slot.raw += data.delta;
		if (data.delta !== "") yield { type: "tool_call_delta", id: slot.block.id, jsonDelta: data.delta };
	}
	*finishArguments(data: Fields): Generator<LLMEvent> {
		const event = "response.function_call_arguments.done";
		const slot = this.toolTarget(data, event);
		if (slot.argumentsDone || slot.done) throw protocolError(event, slot.index, "arguments already closed");
		if (typeof data.arguments !== "string")
			throw protocolError(event, slot.index, "expected string arguments");
		yield* this.argumentsSnapshot(slot, data.arguments, event);
		slot.argumentsDone = true;
	}
	*textEvent(data: Fields, event: string): Generator<LLMEvent> {
		const slot = this.target(data, event);
		if (slot.type !== "text" || slot.done)
			throw protocolError(event, slot.index, "message already closed or wrong target");
		const index = requireIndex(
			data.content_index === undefined ? 0 : data.content_index,
			event,
			"content_index",
		);
		const kind = event.includes("refusal") ? "refusal" : "output_text";
		let part = slot.parts.get(index);
		if (part && part.kind !== kind) throw protocolError(event, slot.index, "conflicting content kind");
		if (!part) {
			part = { kind, text: "", done: false };
			slot.parts.set(index, part);
		}
		if (part.done) throw protocolError(event, slot.index, "content part already closed");
		if (event.endsWith(".delta")) {
			const delta = stringField(data.delta, event, slot.index);
			part.text += delta;
			if (delta !== "") yield { type: "text_delta", text: delta };
		} else {
			const text = stringField(kind === "refusal" ? data.refusal : data.text, event, slot.index);
			if (text.startsWith(part.text) && text.length > part.text.length)
				yield { type: "text_delta", text: text.slice(part.text.length) };
			part.text = text;
			part.done = true;
		}
	}
	*partEvent(data: Fields, event: string): Generator<LLMEvent> {
		const slot = this.target(data, event);
		if (slot.done) throw protocolError(event, slot.index, "output item already closed");
		const part = record(data.part);
		if (!part) throw protocolError(event, slot.index, "expected content part");
		if (slot.type === "text") {
			if (part.type !== "output_text" && part.type !== "refusal")
				throw protocolError(event, slot.index, "invalid message content part");
			const index = requireIndex(
				data.content_index === undefined ? 0 : data.content_index,
				event,
				"content_index",
			);
			const text = stringField(part.type === "refusal" ? part.refusal : part.text, event, slot.index);
			const previous = slot.parts.get(index);
			if (previous && previous.kind !== part.type)
				throw protocolError(event, slot.index, "conflicting content kind");
			if (event.endsWith(".added") && previous)
				throw protocolError(event, slot.index, "duplicate content part");
			if (text.startsWith(previous?.text ?? "") && text.length > (previous?.text.length ?? 0))
				yield { type: "text_delta", text: text.slice(previous?.text.length ?? 0) };
			slot.parts.set(index, { kind: part.type, text, done: event.endsWith(".done") });
		} else if (slot.type === "thinking") {
			const expected = event.includes("summary") ? "summary_text" : "reasoning_text";
			if (part.type !== expected) throw protocolError(event, slot.index, "invalid reasoning part");
			yield* this.reasoningEvent({ ...data, text: part.text }, event);
		} else throw protocolError(event, slot.index, "wrong content target");
	}
	*reasoningEvent(data: Fields, event: string): Generator<LLMEvent> {
		const slot = this.target(data, event);
		if (slot.type !== "thinking" || slot.done)
			throw protocolError(event, slot.index, "reasoning already closed or wrong target");
		const summary = event.includes("summary");
		const suppliedIndex = summary ? data.summary_index : data.content_index;
		const index = requireIndex(
			suppliedIndex === undefined ? 0 : suppliedIndex,
			event,
			summary ? "summary_index" : "content_index",
		);
		const parts = summary ? slot.summary : slot.content;
		const previous = parts.get(index);
		if (event.endsWith(".added") && previous)
			throw protocolError(event, slot.index, "duplicate reasoning part");
		// Part.done normally follows text.done; accept the same snapshot once more.
		if (previous?.done && event.endsWith(".delta"))
			throw protocolError(event, slot.index, "reasoning part already closed");
		const text = stringField(event.endsWith(".delta") ? data.delta : data.text, event, slot.index);
		const value = event.endsWith(".delta") ? (previous?.text ?? "") + text : text;
		if (value.startsWith(previous?.text ?? "") && value.length > (previous?.text.length ?? 0))
			yield { type: "thinking_delta", text: value.slice(previous?.text.length ?? 0) };
		parts.set(index, { text: value, done: event.endsWith(".done") });
	}
	*finishItem(data: Fields): Generator<LLMEvent> {
		const event = "response.output_item.done";
		const item = record(data.item);
		if (!item) throw protocolError(event, data.output_index, "expected output item");
		const index = requireIndex(data.output_index, event);
		let slot = this.slots.get(index);
		if (!slot) {
			slot = this.create(index, item, event);
			if (slot.type === "toolCall")
				yield { type: "tool_call_start", id: slot.block.id, name: slot.block.name };
		}
		if (slot.done) throw protocolError(event, index, "output item already closed");
		this.check(slot, item, event);
		if (slot.type === "toolCall") yield* this.argumentsSnapshot(slot, item.arguments, event);
		else if (slot.type === "text") yield* this.textSnapshot(slot, item.content, event);
		else yield* this.reasoningSnapshot(slot, item, true, event);
		slot.done = true;
		if (item.status === "in_progress" || item.status === "completed" || item.status === "incomplete")
			slot.finalStatus = item.status;
	}
	private parseArguments(slot: ToolSlot): unknown {
		if (!slot.done)
			throw protocolError("response.completed", slot.index, "function call missing output_item.done");
		if (slot.finalStatus !== undefined && slot.finalStatus !== "completed")
			throw protocolError("response.completed", slot.index, "function call did not finish normally");
		if (slot.raw.trim() === "")
			throw protocolError("response.completed", slot.index, "function call has no argument data");
		try {
			return JSON.parse(slot.raw);
		} catch {
			throw protocolError("response.completed", slot.index, "function call arguments are not valid JSON");
		}
	}
	/** Terminal text/reasoning snapshots are authoritative. Function snapshots
	 * only verify already closed calls: they never create, close or repair one. */
	*reconcile(value: unknown, incomplete: boolean): Generator<LLMEvent> {
		if (value === undefined) value = [];
		if (!Array.isArray(value)) throw protocolError("terminal", undefined, "expected output array");
		// Missing and empty aggregates both require complete per-item events.
		// Only finalized items can replace an absent aggregate on a normal turn;
		// explicit truncation remains non-executable and preserves partial data.
		if (value.length === 0) {
			if (
				!incomplete &&
				[...this.slots.values()].some(
					(slot) => !slot.done || (slot.finalStatus !== undefined && slot.finalStatus !== "completed"),
				)
			) {
				throw protocolError(
					"terminal",
					undefined,
					"missing or empty final output requires finalized streamed items",
				);
			}
			return;
		}
		const seen = new Set<Slot>();
		for (const [index, raw] of value.entries()) {
			const item = record(raw);
			if (!item) throw protocolError("terminal", index, "expected output item");
			const id = identityField(item, "id", "terminal", index);
			let slot = (id === undefined ? undefined : this.byItemId.get(id)) ?? this.slots.get(index);
			if (slot && slot.index !== index)
				throw protocolError("terminal", index, "conflicting final output order");
			if (!incomplete && item.status !== undefined && item.status !== "completed")
				throw protocolError("terminal", index, "final output item did not finish normally");
			if (item.type === "function_call") {
				if (slot?.type !== "toolCall")
					throw protocolError("terminal", index, "terminal cannot introduce a function call");
				if (!slot.done && !incomplete) this.parseArguments(slot);
				this.check(slot, item, "terminal");
				if (item.arguments !== undefined && typeof item.arguments !== "string")
					throw protocolError("terminal", index, "expected string arguments");
				if (item.arguments !== undefined && slot.done && !incomplete) {
					const expected = this.parseArguments(slot);
					let supplied: unknown;
					try {
						supplied = JSON.parse(stringField(item.arguments, "terminal", index));
					} catch {
						throw protocolError("terminal", index, "invalid final function arguments");
					}
					if (!isDeepStrictEqual(expected, supplied))
						throw protocolError("terminal", index, "conflicting final function arguments");
				}
			} else {
				if (!slot) slot = this.create(index, item, "terminal");
				this.check(slot, item, "terminal");
				if (slot.type === "text") yield* this.textSnapshot(slot, item.content, "terminal");
				else if (slot.type === "thinking") yield* this.reasoningSnapshot(slot, item, true, "terminal");
			}
			if (seen.has(slot!)) throw protocolError("terminal", index, "duplicate output item");
			seen.add(slot!);
		}
		if ([...this.slots.values()].some((slot) => !seen.has(slot)))
			throw protocolError("terminal", undefined, "final output omitted a streamed item");
	}
	blocks(incomplete: boolean): AssistantBlock[] {
		const blocks: AssistantBlock[] = [];
		for (const [, slot] of [...this.slots.entries()].sort(([a], [b]) => a - b)) {
			const identity = {
				version: 1 as const,
				provider: "openai-codex" as const,
				...(slot.itemId === undefined ? {} : { itemId: slot.itemId }),
			};
			if (slot.type === "toolCall") {
				if (incomplete) {
					try {
						slot.block.arguments = slot.raw.trim() === "" ? {} : JSON.parse(slot.raw);
					} catch {
						slot.block.arguments = { _parseError: "tool arguments were not valid JSON" };
					}
				} else slot.block.arguments = this.parseArguments(slot);
				blocks.push({
					...slot.block,
					responses: { ...identity, ...(slot.namespace === undefined ? {} : { namespace: slot.namespace }) },
				});
			} else if (slot.type === "text") {
				const parts = contiguous(slot.parts, slot.index);
				for (const [contentIndex, part] of parts.entries())
					blocks.push({
						type: "text",
						text: part.text,
						responses: {
							...identity,
							contentIndex,
							kind: part.kind,
							...(slot.phase === undefined ? {} : { phase: slot.phase }),
						},
					});
			} else {
				const summary = contiguous(slot.summary, slot.index).map((p) => ({
					type: "summary_text" as const,
					text: p.text,
				}));
				const content = contiguous(slot.content, slot.index).map((p) => ({
					type: "reasoning_text" as const,
					text: p.text,
				}));
				const responses: ResponsesReasoningReplay = {
					...identity,
					summary,
					...(content.length === 0 ? {} : { content }),
					...(slot.encryptedContent === undefined ? {} : { encryptedContent: slot.encryptedContent }),
				};
				blocks.push({
					type: "thinking",
					thinking: [...summary, ...content].map((p) => p.text).join("\n\n"),
					responses,
				});
			}
		}
		return blocks;
	}
}
