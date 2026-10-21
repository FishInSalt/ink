import { describe, expect, it } from "vitest";
import { StreamInterruptedError, wrapStreamInterruptions } from "../src/provider/shared.js";

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

describe("wrapStreamInterruptions", () => {
	it("passes non-transport errors through unchanged", async () => {
		const original = new Error("protocol exploded");
		expect(await capture(wrapStreamInterruptions(throws(original), "Codex"))).toBe(original);
	});

	it("caps a long detail and preserves the original error as cause", async () => {
		const original = new TypeError("terminated", { cause: new Error("x".repeat(500)) });
		const caught = await capture(wrapStreamInterruptions(throws(original), "Codex"));
		expect(caught).toBeInstanceOf(StreamInterruptedError);
		const error = caught as StreamInterruptedError;
		expect(error.cause).toBe(original);
		expect(error.message.length).toBeLessThanOrEqual(160);
		expect(error.message).toContain('send "继续" to resume');
		expect(error.message).not.toContain("\n");
	});

	it("uses a direct socket code without requiring a wrapped cause", async () => {
		const original = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
		const caught = await capture(wrapStreamInterruptions(throws(original), "Codex"));
		expect(caught).toBeInstanceOf(StreamInterruptedError);
		expect((caught as Error).message).toContain("UND_ERR_SOCKET: other side closed");
	});
});
