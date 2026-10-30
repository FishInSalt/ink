import { describe, expect, it } from "vitest";
import { CodexResponseError } from "../src/provider/responses-errors.js";
import { parseResponsesSse } from "../src/provider/responses-sse.js";

async function collect(body: ReadableStream<Uint8Array>, max?: number) {
	const events = [];
	for await (const event of parseResponsesSse(body, undefined, max)) events.push(event);
	return events;
}
function stream(chunks: Uint8Array[]) {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});
}
const bytes = (text: string) => new TextEncoder().encode(text);

describe("Responses SSE framing", () => {
	it("is chunk-safe at every byte boundary, including Unicode and CRLF", async () => {
		const text =
			': comment\r\nevent: ignored\r\ndata: {"type":"response.output_text.delta","delta":"雪🙂"}\r\n\r\ndata: [DONE]\r\n\r\n';
		const wire = bytes(text);
		for (let i = 0; i <= wire.length; i++) {
			expect(await collect(stream([wire.slice(0, i), wire.slice(i)]))).toEqual([
				{ event: "response.output_text.delta", data: { type: "response.output_text.delta", delta: "雪🙂" } },
			]);
		}
	});
	it("handles one-byte chunks, multiline JSON, comments and final EOF frames", async () => {
		const wire = bytes(
			': ping\n\nevent: fallback\ndata: {\ndata: "delta": "λ",\ndata: "ok": true}\n\ndata: {"type":"response.completed","response":{}}',
		);
		expect(await collect(stream([...wire].map((byte) => Uint8Array.of(byte))))).toEqual([
			{ event: "fallback", data: { delta: "λ", ok: true } },
			{ event: "response.completed", data: { type: "response.completed", response: {} } },
		]);
	});
	it("preserves a UTF-8 BOM inside a later line across every chunk boundary", async () => {
		const wire = bytes(
			'\uFEFF: initial comment\n\ndata: {\n\uFEFFdata: invalid-field-not-data\ndata: "type":"response.completed"}\n\n',
		);
		for (let index = 0; index <= wire.length; index++) {
			expect(await collect(stream([wire.subarray(0, index), wire.subarray(index)]))).toEqual([
				{ event: "response.completed", data: { type: "response.completed" } },
			]);
		}
	});
	it("ignores empty/comment frames and the sentinel without treating it as completion", async () => {
		expect(await collect(stream([bytes(": ping\n\ndata: [DONE]\n\n\n")]))).toEqual([]);
	});
	it.each(["data: {PRIVATE_SECRET}\n\n", "data: []\n\n", "data: null\n\n", 'data: {"type":17}\n\n'])(
		"rejects malformed frames without raw data (%s)",
		async (text) => {
			let failure: unknown;
			try {
				await collect(stream([bytes(text)]));
			} catch (error) {
				failure = error;
			}
			expect(failure).toBeInstanceOf(CodexResponseError);
			expect((failure as Error).message).not.toContain("PRIVATE_SECRET");
		},
	);
	it("rejects invalid/truncated UTF-8 at flush rather than silently replacing it", async () => {
		await expect(collect(stream([Uint8Array.of(0xf0, 0x9f)]))).rejects.toThrow("UTF-8");
	});
	it.each(["\n\n", "\r\n\r\n", "\r\r"])(
		"dispatches a complete frame before decoding an invalid same-chunk suffix (%j)",
		async (ending) => {
			const terminal = bytes(`data: {"type":"response.completed","response":{}}${ending}`);
			for (const chunks of [[new Uint8Array([...terminal, 0xff])], [terminal, Uint8Array.of(0xff)]]) {
				const body = stream(chunks);
				const events = parseResponsesSse(body);
				expect((await events.next()).value?.event).toBe("response.completed");
				await events.return(undefined);
				expect(body.locked).toBe(false);
			}
		},
	);
	it("still rejects invalid UTF-8 before a terminal frame or when the invalid suffix is consumed", async () => {
		const terminal = bytes('data: {"type":"response.completed","response":{}}\n\n');
		await expect(collect(stream([new Uint8Array([0xff, ...terminal])]))).rejects.toThrow("UTF-8");
		await expect(collect(stream([new Uint8Array([...terminal, 0xff])]))).rejects.toThrow("UTF-8");
	});
	it("bounds frame accumulation even before a newline", async () => {
		await expect(collect(stream([bytes("data: "), bytes("x".repeat(50))]), 32)).rejects.toThrow("size limit");
	});
	it("cancels and releases the reader on early return", async () => {
		let cancelled = 0;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes('data: {"type":"response.completed"}\n\n'));
			},
			cancel() {
				cancelled++;
			},
		});
		for await (const _event of parseResponsesSse(body)) break;
		expect(cancelled).toBe(1);
		expect(body.locked).toBe(false);
	});
	it("cancels a pending read on abort", async () => {
		let cancelled = 0;
		const body = new ReadableStream<Uint8Array>({
			cancel() {
				cancelled++;
			},
		});
		const controller = new AbortController();
		const events = parseResponsesSse(body, controller.signal);
		const pending = events.next();
		controller.abort();
		expect((await pending).done).toBe(true);
		expect(cancelled).toBe(1);
		expect(body.locked).toBe(false);
	});
});
