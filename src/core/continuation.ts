import type { AgentMessage, ToolResultMessage } from "./messages.js";

export interface PendingToolCall {
	id: string;
	name: string;
}

export interface ToolPairScan {
	missing: PendingToolCall[];
	repairable: boolean;
	problem?: string;
}

/** Ordered, read-only analysis at a continuation boundary, not per loop turn.
 * Only a final assistant batch followed by partial results can be repaired. */
export function scanToolPairs(messages: readonly AgentMessage[]): ToolPairScan {
	const seenCallIds = new Set<string>();
	const matchedIds = new Set<string>();
	const pending = new Map<string, PendingToolCall>();
	for (const message of messages) {
		if (message.role !== "toolResult" && pending.size > 0) {
			return {
				missing: [],
				repairable: false,
				problem: `a new ${message.role} message begins a turn while tool call(s) ${[...pending.keys()].join(", ")} are still awaiting results — the transcript cannot be paired unambiguously`,
			};
		}
		if (message.role === "assistant") {
			for (const block of message.blocks) {
				if (block.type !== "toolCall") continue;
				if (seenCallIds.has(block.id)) {
					return {
						missing: [],
						repairable: false,
						problem: `tool call ${block.id} is declared more than once — the transcript cannot be paired unambiguously`,
					};
				}
				seenCallIds.add(block.id);
				pending.set(block.id, { id: block.id, name: block.name });
			}
		} else if (message.role === "toolResult") {
			for (const result of message.results) {
				const id = result.toolCallId;
				if (!seenCallIds.has(id)) {
					return {
						missing: [],
						repairable: false,
						problem: `a tool result for ${id} has no preceding tool call — the transcript is not continuable`,
					};
				}
				if (matchedIds.has(id)) {
					return {
						missing: [],
						repairable: false,
						problem: `the tool result for ${id} is recorded more than once — the transcript is not continuable`,
					};
				}
				matchedIds.add(id);
				pending.delete(id);
			}
		}
	}
	// The ordered boundary check above ensures that any pending batch is the
	// final assistant's batch, followed exclusively by toolResult messages.
	return { missing: [...pending.values()], repairable: true };
}

export const UNKNOWN_TOOL_OUTCOME =
	"[ink] No result was recorded for this tool call in the selected continuation. Its outcome is unknown; it may have executed fully or partially. Ink did not replay it. Inspect relevant state before deciding whether to retry.";

export function interruptedToolResults(calls: readonly PendingToolCall[]): ToolResultMessage {
	return {
		role: "toolResult",
		results: calls.map(({ id, name }) => ({
			toolCallId: id,
			toolName: name,
			content: UNKNOWN_TOOL_OUTCOME,
			isError: true,
		})),
	};
}
