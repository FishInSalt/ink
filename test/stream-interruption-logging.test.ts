import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { AgentEvent } from "../src/core/loop.js";
import { ExtensionRegistry } from "../src/extensions/registry.js";
import type { RunErrorEvent } from "../src/extensions/types.js";
import { getCodexAccessToken } from "../src/provider/codex-auth.js";
import { createCodexResponsesProvider } from "../src/provider/codex-responses.js";
import { StreamInterruptedError } from "../src/provider/shared.js";
import { createRunner } from "../src/runner.js";
import { makeRenderer } from "./helpers/fakes.js";
import { mkTempDir } from "./helpers/mktemp.js";

vi.mock("../src/provider/codex-auth.js", () => ({
	getCodexAccessToken: vi.fn(() => {
		throw new Error("Credential reads forbidden in stream interruption logging tests");
	}),
}));

const TOKEN = "fake-stream-access-token";
const PRIVATE_DETAIL = `${TOKEN} sk-fake-stream-token Bearer fake-stream-bearer https://private.invalid/path?token=fake-url-secret\r\n\t\0\x1b[31m`;
const secretPattern = /fake-stream|sk-fake|Bearer|https?:|fake-url|UNKNOWN/;
const interruptions = [
	...["UND_ERR_SOCKET", "ECONNRESET", "EPIPE"].flatMap((code) =>
		[false, true].map((nested) => ({
			name: `${nested ? "nested" : "direct"} ${code}`,
			detail: `${code}: connection closed`,
			make: () => {
				const socket = Object.assign(new Error(PRIVATE_DETAIL), { code });
				return nested
					? new TypeError(`outer ${PRIVATE_DETAIL}`, {
							cause: new Error(`middle ${PRIVATE_DETAIL}`, { cause: socket }),
						})
					: socket;
			},
		})),
	),
	...["terminated", "fetch failed"].flatMap((wrapper) =>
		[undefined, `UNKNOWN_${PRIVATE_DETAIL}`].map((code) => ({
			name: `nested ${wrapper} with ${code === undefined ? "no" : "unknown"} code`,
			detail: "connection closed",
			make: () =>
				new Error(`outer ${PRIVATE_DETAIL}`, {
					cause: new TypeError(wrapper, {
						cause: Object.assign(new Error(PRIVATE_DETAIL), { code }),
					}),
				}),
		})),
	),
];

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("INK_LOG", "1");
	vi.stubEnv("INK_AUTOCOMPACT", "0");
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("Non-injected network forbidden in stream interruption logging tests");
		}),
	);
});
afterEach(() => {
	expect(getCodexAccessToken).not.toHaveBeenCalled();
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("real Runner stream interruption diagnostics", () => {
	for (const speed of [undefined, "fast"] as const) {
		it.each(interruptions)(
			`omits secrets from public errors, run_error events and JSONL logs: $name (speed=${speed})`,
			async ({ make, detail }) => {
				const root = mkTempDir("ink-stream-interruption-");
				vi.stubEnv("HOME", root);
				const original = make();
				const rawMessage = original.message;
				const rawCause = original.cause;
				const auth = vi.fn(async () => ({ accessToken: TOKEN }));
				const fetch = vi.fn<typeof globalThis.fetch>(async () => {
					let started = false;
					return new Response(
						new ReadableStream<Uint8Array>({
							pull(controller) {
								if (started) {
									controller.error(original);
									return;
								}
								started = true;
								const frames = [
									{
										type: "response.output_item.added",
										output_index: 0,
										item: { type: "message", id: "msg_cut", role: "assistant", content: [] },
									},
									{
										type: "response.output_text.delta",
										output_index: 0,
										item_id: "msg_cut",
										delta: "partial answer",
									},
								];
								controller.enqueue(
									new TextEncoder().encode(
										frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""),
									),
								);
							},
						}),
					);
				});
				const provider = createCodexResponsesProvider({ auth, fetch });
				const registry = new ExtensionRegistry();
				const errors: RunErrorEvent[] = [];
				registry.beginExtension("stream-interruption-probe", "cli");
				registry.subscribe("run_error", (event: RunErrorEvent) => errors.push(event));
				registry.commitExtension();
				const runner = await createRunner({
					cwd: path.join(root, "project"),
					argv: [],
					model: `openai-codex/gpt-5.5${speed === "fast" ? "·fast" : ""}`,
					maxTokens: 1024,
					maxTurns: 2,
					noContextFiles: true,
					noSession: true,
					sessionBaseDir: root,
					settingsPath: path.join(root, "settings.json"),
					agentsHomeDir: root,
					agentsProjectAllowed: false,
					systemPromptHomeDir: root,
					renderer: makeRenderer().renderer,
					provider,
					extensions: registry,
				});
				onTestFinished(() => runner.close());
				const events: AgentEvent[] = [];
				const caught: unknown = await runner
					.runTurn({ userMessage: "hello", onEvent: (event) => events.push(event) })
					.catch((error: unknown) => error);
				expect(caught).toBeInstanceOf(StreamInterruptedError);
				const error = caught as StreamInterruptedError;
				const message = `Codex stream interrupted — ${detail}; send "continue" to resume`;
				expect(error).toMatchObject({ name: "StreamInterruptedError", provider: "Codex", message });
				expect(error.message.length).toBeLessThanOrEqual(160);
				expect(error.message).not.toMatch(secretPattern);
				for (const control of ["\r", "\n", "\t", "\0", "\x1b"]) expect(error.message).not.toContain(control);
				expect(error.cause).toBe(original);
				expect(original.message).toBe(rawMessage);
				expect(original.cause).toBe(rawCause);
				expect(errors).toEqual([{ type: "run_error", message }]);
				expect(events).toContainEqual({ type: "text_delta", text: "partial answer" });
				expect(events.some((event) => event.type === "message_end")).toBe(false);
				expect(auth).toHaveBeenCalledTimes(1);
				expect(fetch).toHaveBeenCalledTimes(1);
				const sent = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
				expect(sent.model).toBe("gpt-5.5");
				expect(sent.service_tier).toBe(speed === "fast" ? "priority" : undefined);

				// Exercise createRunLogger's actual async appendFile path, not a
				// mocked logger or only the extension run_error event.
				const logDir = path.join(root, ".ink", "logs");
				let records: Record<string, unknown>[] = [];
				await expect
					.poll(async () => {
						const files = await readdir(logDir);
						const logs = await Promise.all(files.map((file) => readFile(path.join(logDir, file), "utf8")));
						records = logs
							.join("")
							.split("\n")
							.filter(Boolean)
							.map((line) => JSON.parse(line) as Record<string, unknown>);
						return records.filter((record) => record.type === "run_error");
					})
					.toEqual([{ t: expect.any(String), type: "run_error", message }]);
				expect(JSON.stringify(records)).not.toMatch(/fake-stream|sk-fake|Bearer|https?:|fake-url|UNKNOWN/);
			},
		);
	}
});
