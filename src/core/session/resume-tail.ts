import { statSync } from "node:fs";
import type { AgentMessage, ToolResultMessage } from "../messages.js";
import { SessionError, type SessionStore } from "./store.js";

interface PendingCall {
	id: string;
	name: string;
}

/** Inspect only the final assistant and contiguous following tool results.
 * Do not cross a user message or examine earlier assistant batches. */
export function missingTailCalls(messages: readonly AgentMessage[]): PendingCall[] {
	let firstResult = messages.length;
	while (firstResult > 0 && messages[firstResult - 1]?.role === "toolResult") firstResult--;
	const assistant = messages[firstResult - 1];
	if (assistant?.role !== "assistant") return [];
	const calls = new Map<string, PendingCall>();
	for (const block of assistant.blocks) {
		if (block.type !== "toolCall") continue;
		if (calls.has(block.id))
			throw new SessionError(`Cannot repair final tool batch: duplicate call ${block.id}`);
		calls.set(block.id, { id: block.id, name: block.name });
	}
	if (calls.size === 0) return [];
	const answered = new Set<string>();
	for (let i = firstResult; i < messages.length; i++) {
		for (const result of (messages[i] as ToolResultMessage).results) {
			const call = calls.get(result.toolCallId);
			if (!call || call.name !== result.toolName || answered.has(result.toolCallId)) {
				throw new SessionError(`Cannot repair final tool batch: ambiguous result ${result.toolCallId}`);
			}
			answered.add(result.toolCallId);
		}
	}
	return [...calls.values()].filter((call) => !answered.has(call.id));
}

export const UNKNOWN_RESUME_OUTCOME =
	"[ink] No result was recorded for this tool call before the session was interrupted. Its outcome is unknown; it may have executed fully or partially. Ink did not replay it. Inspect relevant state before deciding whether to retry.";

/** Called only on freshly opened main sessions, before publishing the store or
 * appending model selections. Failed candidates must be discarded and reopened. */
export function recoverMainSession(store: SessionStore, active?: SessionStore | null) {
	const loaded = store.buildContext();
	const missing = missingTailCalls(loaded.messages);
	if ((missing.length > 0 || store.tornFinalLine) && active) {
		let sameFile = store.filePath === active.filePath;
		if (!sameFile && active.isPersisted) {
			const candidateFile = statSync(store.filePath);
			const activeFile = statSync(active.filePath);
			sameFile = candidateFile.dev === activeFile.dev && candidateFile.ino === activeFile.ino;
		}
		if (sameFile) {
			throw new SessionError(
				`This active session needs resume repair. Use /new then /resume ${store.header.id}, or restart with ink -r ${store.header.id}; no repair was written.`,
			);
		}
	}
	// Existing structural-tail utility, only at this explicit resume boundary.
	store.repairTornFinalLine();
	if (missing.length > 0) {
		const result: ToolResultMessage = {
			role: "toolResult",
			results: missing.map(({ id, name }) => ({
				toolCallId: id,
				toolName: name,
				content: UNKNOWN_RESUME_OUTCOME,
				isError: true,
			})),
		};
		store.appendMessage(result);
		loaded.messages.push(result);
	}
	return { ...loaded, repairedTools: missing.length };
}
