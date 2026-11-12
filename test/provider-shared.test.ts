import { describe, expect, it } from "vitest";
import { abortSafe, StreamInterruptedError, wrapStreamInterruptions } from "../src/provider/shared.js";

// biome-ignore lint/correctness/useYield: the contract is an async generator that throws before yielding
async function* throws(err: unknown): AsyncGenerator<never> {
	throw err;
}

async function capture(source: AsyncIterable<unknown>): Promise<unknown> {
	try {
		for await (const _ of source) {
			// drain
		}
	} catch (err) {
		return err;
	}
	throw new Error("expected a rejection");
}

const PRIVATE_DETAIL =
	"sk-fake-stream-token Bearer fake-stream-bearer https://private.invalid/path?token=fake-url-secret\r\n\t\0\x1b[31m";
const socketCodes = ["UND_ERR_SOCKET", "ECONNRESET", "EPIPE"] as const;

function expectPublicError(caught: unknown, original: Error, detail: string): void {
	expect(caught).toBeInstanceOf(StreamInterruptedError);
	const error = caught as StreamInterruptedError;
	expect(error.name).toBe("StreamInterruptedError");
	expect(error.provider).toBe("Codex");
	expect(error.cause).toBe(original);
	expect(error.message).toBe(`Codex stream interrupted — ${detail}; send "continue" to resume`);
	expect(error.message.length).toBeLessThanOrEqual(160);
	expect(error.message).not.toMatch(/sk-fake|Bearer|fake-stream|https?:|fake-url/);
	for (const control of ["\r", "\n", "\t", "\0", "\x1b"]) expect(error.message).not.toContain(control);
}

describe("wrapStreamInterruptions", () => {
	it.each([
		new Error(`protocol exploded: ${PRIVATE_DETAIL}`),
		Object.assign(new Error(PRIVATE_DETAIL), { code: `UNKNOWN_${PRIVATE_DETAIL}` }),
		Object.assign(new Error(PRIVATE_DETAIL), { code: "UND_ERR_SOCKET_EXTRA" }),
		Object.assign(new Error(PRIVATE_DETAIL), { code: "econnreset" }),
		new Error(`terminated ${PRIVATE_DETAIL}`),
		new Error(`fetch failed ${PRIVATE_DETAIL}`),
		new DOMException("adapter aborted", "AbortError"),
		new DOMException("adapter timed out", "TimeoutError"),
		{ message: "terminated", code: "UND_ERR_SOCKET" },
		"terminated",
		null,
		undefined,
	])("passes non-transport errors through unchanged (%#)", async (original) => {
		expect(await capture(wrapStreamInterruptions(throws(original), "Codex"))).toBe(original);
	});

	for (const code of socketCodes) {
		it.each([false, true])(`publishes only ${code} and fixed wording (nested=%s)`, async (nested) => {
			const socket = Object.assign(new Error(PRIVATE_DETAIL), { code });
			const original = nested
				? new TypeError(`outer ${PRIVATE_DETAIL}`, {
						cause: new Error(`middle ${PRIVATE_DETAIL}`, { cause: socket }),
					})
				: socket;
			expectPublicError(
				await capture(wrapStreamInterruptions(throws(original), "Codex")),
				original,
				`${code}: connection closed`,
			);
			expect(socket.message).toBe(PRIVATE_DETAIL);
			if (nested) expect((original.cause as Error).cause).toBe(socket);
		});
	}

	for (const wrapper of ["terminated", "fetch failed"]) {
		it.each([undefined, `UNKNOWN_${PRIVATE_DETAIL}`, "UND_ERR_SOCKET_EXTRA", 42])(
			`never publishes cause text or unknown codes under ${wrapper} (code=%#)`,
			async (code) => {
				const inner = Object.assign(new Error(PRIVATE_DETAIL), { code });
				const original = Object.assign(new TypeError(wrapper, { cause: inner }), {
					code: `OUTER_${PRIVATE_DETAIL}`,
				});
				expectPublicError(
					await capture(wrapStreamInterruptions(throws(original), "Codex")),
					original,
					"connection closed",
				);
				expect(original.cause).toBe(inner);
				expect(inner.message).toBe(PRIVATE_DETAIL);
				expect(inner.code).toBe(code);
			},
		);

		it(`recognizes a nested ${wrapper} without publishing its outer message`, async () => {
			const original = new Error(PRIVATE_DETAIL, { cause: new TypeError(wrapper) });
			expectPublicError(
				await capture(wrapStreamInterruptions(throws(original), "Codex")),
				original,
				"connection closed",
			);
		});
	}

	it("does not publish even a very long code-less cause", async () => {
		const original = new TypeError("terminated", {
			cause: new Error(`${PRIVATE_DETAIL}${"x".repeat(500)}`),
		});
		expectPublicError(
			await capture(wrapStreamInterruptions(throws(original), "Codex")),
			original,
			"connection closed",
		);
	});

	it("still bounds explicitly supplied constructor details and preserves the hint and cause", () => {
		const original = new Error("local diagnostic");
		const error = new StreamInterruptedError("Codex", "x".repeat(500), { cause: original });
		expect(error.cause).toBe(original);
		expect(error.message).toHaveLength(160);
		expect(error.message.endsWith('; send "continue" to resume')).toBe(true);
	});

	it("keeps upstream Unicode details unchanged and the recovery hint in English", () => {
		const detail = "连接已关闭 — café 🔌";
		const error = new StreamInterruptedError("Codex", detail);
		expect(error.message).toBe(`Codex stream interrupted — ${detail}; send "continue" to resume`);
	});

	it("keeps abortSafe silent when an aborted source throws a transport error", async () => {
		const controller = new AbortController();
		const original = Object.assign(new Error(PRIVATE_DETAIL), { code: "ECONNRESET" });
		// biome-ignore lint/correctness/useYield: simulate a reader rejecting after cancellation
		async function* interrupted(): AsyncGenerator<never> {
			controller.abort();
			throw original;
		}
		const events: unknown[] = [];
		for await (const event of abortSafe(wrapStreamInterruptions(interrupted(), "Codex"), controller.signal)) {
			events.push(event);
		}
		expect(events).toEqual([]);
		expect(controller.signal.aborted).toBe(true);
	});
});
