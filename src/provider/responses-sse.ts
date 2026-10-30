import { protocolError, record } from "./responses-errors.js";

export interface ResponsesSseEvent {
	event: string;
	data: Record<string, unknown>;
}

/** Ciphertext/final snapshots can be large; cap each frame, not the answer. */
const MAX_RESPONSES_FRAME_BYTES = 8 * 1024 * 1024;

function parseFrame(lines: string[]): ResponsesSseEvent | undefined {
	let fallback = "message";
	const data: string[] = [];
	for (const line of lines) {
		if (line.startsWith(":")) continue;
		const colon = line.indexOf(":");
		const field = colon === -1 ? line : line.slice(0, colon);
		let value = colon === -1 ? "" : line.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		if (field === "event") fallback = value;
		else if (field === "data") data.push(value);
	}
	if (data.length === 0) return undefined;
	const text = data.join("\n");
	if (text.trim() === "[DONE]") return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw protocolError("SSE", undefined, "malformed JSON frame");
	}
	const obj = record(parsed);
	if (!obj) throw protocolError("SSE", undefined, "expected an event object");
	if (obj.type !== undefined && (typeof obj.type !== "string" || obj.type === "")) {
		throw protocolError("SSE", undefined, "expected a string event type");
	}
	return { event: typeof obj.type === "string" ? obj.type : fallback, data: obj };
}

/** Responses has stricter framing than the shared legacy parser. Dispatch by
 * data.type (event: is a fixture-compatible fallback); CRLF may span chunks.
 * Always cancel on early return/terminal/abort so a server cannot hold the turn. */
export async function* parseResponsesSse(
	body: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
	maxFrameBytes = MAX_RESPONSES_FRAME_BYTES,
): AsyncGenerator<ResponsesSseEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let lineChunks: string[] = [];
	let lines: string[] = [];
	let frameBytes = 0;
	let afterCR = false;
	const cancel = () => {
		void reader.cancel().catch(() => {});
	};
	signal?.addEventListener("abort", cancel, { once: true });
	const decode = (bytes?: Uint8Array, stream = false): string => {
		try {
			return decoder.decode(bytes, { stream });
		} catch {
			throw protocolError("SSE", undefined, "invalid UTF-8 frame");
		}
	};
	const account = (bytes: number) => {
		frameBytes += bytes;
		if (frameBytes > maxFrameBytes) throw protocolError("SSE", undefined, "frame exceeds size limit");
	};
	function* consume(bytes: Uint8Array): Generator<ResponsesSseEvent> {
		// Scan delimiters before decoding: a terminal frame must be dispatched
		// before any invalid UTF-8 in the same chunk's unused suffix is touched.
		// CR/LF cannot occur inside a valid multibyte UTF-8 code point.
		let start = 0;
		for (let index = 0; index < bytes.length; index++) {
			const byte = bytes[index];
			if (afterCR && byte === 0x0a) {
				afterCR = false;
				start = index + 1;
				continue;
			}
			afterCR = false;
			if (byte !== 0x0d && byte !== 0x0a) continue;
			account(index - start + 1);
			// Including the delimiter validates pending UTF-8 before this line
			// ends, while a single streaming decoder preserves BOM semantics.
			lineChunks.push(decode(bytes.subarray(start, index + 1), true).slice(0, -1));
			const line = lineChunks.join("");
			lineChunks = [];
			start = index + 1;
			afterCR = byte === 0x0d;
			if (line === "") {
				const parsed = parseFrame(lines);
				lines = [];
				frameBytes = 0;
				if (parsed) yield parsed;
			} else lines.push(line);
		}
		const remainder = bytes.subarray(start);
		account(remainder.length);
		if (remainder.length !== 0) lineChunks.push(decode(remainder, true));
	}
	try {
		if (signal?.aborted) return;
		while (!signal?.aborted) {
			const { done, value } = await reader.read();
			if (signal?.aborted) return;
			if (done) {
				const tail = decode();
				if (tail !== "") lineChunks.push(tail);
				break;
			}
			yield* consume(value);
		}
		if (signal?.aborted) return;
		if (lineChunks.length !== 0) lines.push(lineChunks.join(""));
		const parsed = parseFrame(lines);
		if (parsed) yield parsed;
	} finally {
		signal?.removeEventListener("abort", cancel);
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
