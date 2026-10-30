import type {
	AgentMessage,
	AssistantBlock,
	AssistantMessage,
	ContentBlock,
	ResponsesReasoningReplay,
	ResponsesTextReplay,
	ResponsesToolReplay,
} from "../core/messages.js";
import { CodexResponseError, record } from "./responses-errors.js";

type TextPart = { type: "output_text"; text: string; annotations: [] } | { type: "refusal"; refusal: string };
type TextInputPart = { type: "input_text"; text: string };
type AssistantInputItem =
	| {
			role: "assistant";
			content: TextInputPart[];
			phase?: "commentary" | "final_answer" | null;
			type?: undefined;
			id?: undefined;
	  }
	| {
			type: "message";
			role: "assistant";
			id: string;
			status: "completed";
			phase?: "commentary" | "final_answer" | null;
			content: TextPart[];
	  };
type InputPart =
	| { type: "input_text"; text: string }
	| {
			type: "input_image";
			detail: "auto";
			image_url: string;
	  };
export type ResponsesInputItem =
	| { role: "user"; content: InputPart[] }
	| AssistantInputItem
	| {
			type: "function_call";
			call_id: string;
			name: string;
			arguments: string;
			id?: string;
			namespace?: string;
	  }
	| { type: "function_call_output"; call_id: string; output: string | InputPart[] }
	| {
			type: "reasoning";
			id?: string;
			summary: ResponsesReasoningReplay["summary"];
			content?: ResponsesReasoningReplay["content"];
			encrypted_content?: string;
	  };

function malformed(): never {
	throw new CodexResponseError("Codex replay metadata is malformed", { code: "invalid_replay_metadata" });
}
function nonempty(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "";
}

type ResponsesReplay = ResponsesTextReplay | ResponsesToolReplay | ResponsesReasoningReplay;

/** Persisted metadata is untrusted. Unknown versions/providers fall back to
 * canonical content; a recognized schema must validate before any fetch. */
function replay(block: AssistantBlock): ResponsesReplay | undefined {
	const raw = record(block.responses);
	if (raw?.version !== 1 || raw.provider !== "openai-codex") return undefined;
	if (raw.itemId !== undefined && !nonempty(raw.itemId)) malformed();
	const identity = {
		version: 1 as const,
		provider: "openai-codex" as const,
		...(raw.itemId === undefined ? {} : { itemId: raw.itemId as string }),
	};
	if (block.type === "text") {
		if (
			typeof raw.contentIndex !== "number" ||
			!Number.isSafeInteger(raw.contentIndex) ||
			raw.contentIndex < 0
		)
			malformed();
		if (raw.kind !== "output_text" && raw.kind !== "refusal") malformed();
		if (
			raw.phase !== undefined &&
			raw.phase !== null &&
			raw.phase !== "commentary" &&
			raw.phase !== "final_answer"
		)
			malformed();
		return {
			...identity,
			contentIndex: raw.contentIndex,
			kind: raw.kind,
			...(raw.phase === undefined ? {} : { phase: raw.phase }),
		};
	}
	if (block.type === "toolCall") {
		if (raw.namespace !== undefined && !nonempty(raw.namespace)) malformed();
		return { ...identity, ...(raw.namespace === undefined ? {} : { namespace: raw.namespace as string }) };
	}
	const parts = (value: unknown, kind: string): Array<{ type: string; text: string }> => {
		if (!Array.isArray(value)) malformed();
		return value.map((part: unknown) => {
			const p = record(part);
			if (!p || p.type !== kind || typeof p.text !== "string") malformed();
			return { type: kind, text: p.text };
		});
	};
	const summary = parts(raw.summary, "summary_text") as ResponsesReasoningReplay["summary"];
	const content =
		raw.content === undefined
			? undefined
			: (parts(raw.content, "reasoning_text") as NonNullable<ResponsesReasoningReplay["content"]>);
	if (raw.encryptedContent !== undefined && typeof raw.encryptedContent !== "string") malformed();
	return {
		...identity,
		summary,
		...(content === undefined ? {} : { content }),
		...(raw.encryptedContent === undefined ? {} : { encryptedContent: raw.encryptedContent as string }),
	};
}

function userContent(content: string | ContentBlock[]): InputPart[] {
	if (typeof content === "string") return [{ type: "input_text", text: content }];
	return content.map((block) =>
		block.type === "text"
			? { type: "input_text", text: block.text }
			: { type: "input_image", detail: "auto", image_url: `data:${block.mimeType};base64,${block.data}` },
	);
}
function toolContent(content: string | ContentBlock[]): string | InputPart[] {
	if (typeof content === "string") return content;
	const text = content
		.filter((b) => b.type === "text")
		.map((b) => b.text)
		.join("\n");
	const images = content.filter((b) => b.type === "image");
	if (images.length === 0) return text;
	return [
		...(text === "" ? [] : [{ type: "input_text" as const, text }]),
		...images.map((b) => ({
			type: "input_image" as const,
			detail: "auto" as const,
			image_url: `data:${b.mimeType};base64,${b.data}`,
		})),
	];
}

/** Select native metadata for the WHOLE exact-model message, or canonical
 * fallback. Conversion and history estimates supply a history-wide ID set.
 * Only a fully validated message reserves IDs, so nonthrowing estimates can
 * recover after malformed metadata without retaining partial reservations. */
export function selectResponsesReplay(
	message: AssistantMessage,
	model: string,
	seen = new Set<string>(),
): Array<ResponsesReplay | undefined> | undefined {
	const provenance = record(message.provenance);
	if (provenance?.version === 1 && provenance.provider === "openai-codex" && !nonempty(provenance.model))
		malformed();
	if (provenance?.version !== 1 || provenance.provider !== "openai-codex" || provenance.model !== model)
		return undefined;
	// Validate every recognized peer BEFORE whole-message fallback. Unknown
	// versions must not hide malformed known schemas or replay half an item.
	const metadata = message.blocks.map(replay);
	if (!message.blocks.every((block, index) => block.responses === undefined || metadata[index] !== undefined))
		return undefined;
	const pending = new Set<string>();
	let previousText: ResponsesTextReplay | undefined;
	let nextIndex = 0;
	for (const [index, block] of message.blocks.entries()) {
		const meta = metadata[index];
		if (block.type === "text" && meta) {
			const text = meta as ResponsesTextReplay;
			if (
				previousText &&
				previousText.itemId === text.itemId &&
				(text.itemId !== undefined || text.contentIndex > 0)
			) {
				if (text.contentIndex !== nextIndex || text.phase !== previousText.phase) malformed();
				previousText = text;
				nextIndex++;
				continue;
			}
			if (text.contentIndex !== 0) malformed();
			previousText = text;
			nextIndex = 1;
		} else previousText = undefined;
		if (meta?.itemId !== undefined) {
			if (seen.has(meta.itemId) || pending.has(meta.itemId)) malformed();
			pending.add(meta.itemId);
		}
	}
	for (const itemId of pending) seen.add(itemId);
	return metadata;
}

function assistantItems(message: AssistantMessage, model: string, seen: Set<string>): ResponsesInputItem[] {
	const metadata = selectResponsesReplay(message, model, seen);
	const items: ResponsesInputItem[] = [];
	let group: AssistantInputItem | undefined;
	for (const [index, block] of message.blocks.entries()) {
		const meta = metadata?.[index];
		const itemId = meta?.itemId;
		if (block.type === "text") {
			const textMeta = meta as ResponsesTextReplay | undefined;
			if (!textMeta || textMeta.contentIndex === 0) {
				const phase = textMeta?.phase === undefined ? {} : { phase: textMeta.phase };
				group =
					itemId === undefined
						? { role: "assistant", content: [], ...phase }
						: { type: "message", role: "assistant", id: itemId, status: "completed", content: [], ...phase };
				items.push(group);
			}
			// Native output messages require status and output_text.annotations.
			// Canonical/ID-less history uses EasyInputMessage's input_text parts,
			// not an incomplete ResponseOutputMessage with fabricated native IDs.
			if (group!.type === "message") {
				group!.content.push(
					textMeta?.kind === "refusal"
						? { type: "refusal", refusal: block.text }
						: { type: "output_text", text: block.text, annotations: [] },
				);
			} else group!.content.push({ type: "input_text", text: block.text });
			continue;
		}
		group = undefined;
		if (block.type === "toolCall") {
			const toolMeta = meta as ResponsesToolReplay | undefined;
			items.push({
				type: "function_call",
				call_id: block.id,
				name: block.name,
				arguments: JSON.stringify(block.arguments),
				...(itemId === undefined ? {} : { id: itemId }),
				...(toolMeta?.namespace === undefined ? {} : { namespace: toolMeta.namespace }),
			});
		} else if (meta) {
			const thinking = meta as ResponsesReasoningReplay;
			items.push({
				type: "reasoning",
				summary: thinking.summary,
				...(itemId === undefined ? {} : { id: itemId }),
				...(thinking.content === undefined ? {} : { content: thinking.content }),
				...(thinking.encryptedContent === undefined ? {} : { encrypted_content: thinking.encryptedContent }),
			});
		}
	}
	return items;
}

/** Full canonical history, in block order. No raw response transcript, no
 * previous_response_id, no native IDs/ciphertext across exact-model boundaries. */
export function toResponsesInput(messages: AgentMessage[], model: string): ResponsesInputItem[] {
	const items: ResponsesInputItem[] = [];
	const seen = new Set<string>();
	for (const message of messages) {
		if (message.role === "user") items.push({ role: "user", content: userContent(message.content) });
		else if (message.role === "assistant") items.push(...assistantItems(message, model, seen));
		else
			for (const result of message.results) {
				items.push({
					type: "function_call_output",
					call_id: result.toolCallId,
					output: toolContent(result.content),
				});
			}
	}
	return items;
}
