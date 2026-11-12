import { spawn } from "node:child_process";
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import type { ToolResult } from "../src/core/messages.js";
import { createSession, listSessions } from "../src/core/session/manager.js";
import { SessionStore } from "../src/core/session/store.js";
import { collectCliOutput, createCliFixture } from "./helpers/cli-fixture.js";
import { assistant, user } from "./helpers/fakes.js";

interface WireBlock {
	type: string;
	id?: string;
	tool_use_id?: string;
	content?: string;
	is_error?: boolean;
}

interface WireMessage {
	role: "user" | "assistant";
	content: string | WireBlock[];
}

interface ProviderRequest {
	url: string;
	key: string | undefined;
	body: { model: string; messages: WireMessage[] };
}

function sse(event: string, data: object): string {
	return `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`;
}

function responseSse(tool?: { id: string; name: string }): string {
	return [
		sse("message_start", {
			message: {
				id: "fixture-response",
				role: "assistant",
				content: [],
				stop_reason: null,
				usage: { input_tokens: 10, output_tokens: 0 },
			},
		}),
		sse("content_block_start", {
			index: 0,
			content_block: tool ? { type: "tool_use", ...tool } : { type: "text", text: "" },
		}),
		sse("content_block_delta", {
			index: 0,
			delta: tool
				? { type: "input_json_delta", partial_json: "{}" }
				: { type: "text_delta", text: "Local continuation accepted." },
		}),
		sse("content_block_stop", { index: 0 }),
		sse("message_delta", {
			delta: { stop_reason: tool ? "tool_use" : "end_turn" },
			usage: { output_tokens: 5 },
		}),
		sse("message_stop", {}),
	].join("");
}

/** Built, copied installation; allowlisted HOME/env and outbound-network guard. */
async function cliWorld(replies: string[] = []) {
	const fixture = createCliFixture();
	const requests: ProviderRequest[] = [];
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			requests.push({
				url: request.url ?? "",
				key: request.headers["x-api-key"] as string | undefined,
				body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as ProviderRequest["body"],
			});
			response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
			response.end(replies[requests.length - 1] ?? responseSse());
		});
	});
	onTestFinished(async () => {
		try {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
				server.closeAllConnections();
			});
		} finally {
			fixture.cleanup();
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("Missing loopback provider");
	const env = fixture.env({
		ANTHROPIC_API_KEY: "resume-cli-fixture-key",
		ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
		INK_MCP: "0",
		INK_LOG: "0",
	});
	return {
		fixture,
		requests,
		sessionBaseDir: path.join(fixture.home, ".ink", "sessions"),
		async run(args: string[], input = "") {
			const child = spawn(process.execPath, [fixture.bin, "--no-context-files", ...args], {
				cwd: fixture.cwd,
				env,
				stdio: "pipe",
			});
			const output = await collectCliOutput(child, input);
			return { ...output, signal: child.signalCode };
		},
	};
}

type CliWorld = Awaited<ReturnType<typeof cliWorld>>;
const ENTRY_PATHS = ["-r", "-c", "piped /resume"] as const;
type EntryPath = (typeof ENTRY_PATHS)[number];

function continueCli(world: CliWorld, entry: EntryPath, id: string, prompt: string) {
	return entry === "piped /resume"
		? world.run([], `/resume ${id}\n${prompt}\n`)
		: world.run([...(entry === "-r" ? ["-r", id] : ["-c"]), "-p", prompt]);
}

function seedInterrupted(world: CliWorld, partial: boolean) {
	// -c must select the interrupted session, not this older complete one.
	const older = createSession(world.fixture.cwd, world.sessionBaseDir);
	older.appendMessage(user("older complete session"));
	older.appendMessage(assistant([{ type: "text", text: "older answer" }]));
	utimesSync(older.filePath, new Date("2000-01-01"), new Date("2000-01-01"));
	const store = createSession(world.fixture.cwd, world.sessionBaseDir);
	store.setModel({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
	store.appendSessionName("interrupted CLI fixture");
	store.appendMessage(user("original batch"));
	const ids = ["old-1", "old-2", "old-3", "old-4"];
	store.appendMessage(
		assistant(
			ids.map((id) => ({
				type: "toolCall",
				id,
				name: "bash",
				arguments: { command: `printf '${id}\\n' >> old-tools-ran` },
			})),
			"tool_use",
		),
	);
	const realResults: ToolResult[] = partial
		? ["old-2", "old-4"].map((id) => ({
				toolCallId: id,
				toolName: "bash",
				content: `real recorded output for ${id}`,
				isError: false,
			}))
		: [];
	if (partial) store.appendMessage({ role: "toolResult", results: realResults });
	return { store, realResults, missing: partial ? ["old-1", "old-3"] : ids };
}

function unknownOutcome(result: ToolResult): void {
	expect(result.isError).toBe(true);
	expect(result.content).toEqual(expect.stringContaining("outcome is unknown"));
	expect(result.content).toEqual(expect.stringContaining("may have executed fully or partially"));
	expect(result.content).toEqual(expect.stringContaining("did not replay"));
	expect(result.content).toEqual(expect.stringContaining("Inspect relevant state"));
}

/** Independent check of the actual HTTP transcript, not the runner's scanner. */
function pairedWire(messages: WireMessage[]): void {
	const pending = new Set<string>();
	const declared = new Set<string>();
	for (const message of messages) {
		const results = Array.isArray(message.content)
			? message.content.filter((block) => block.type === "tool_result")
			: [];
		if (results.length === 0) expect([...pending]).toEqual([]);
		for (const block of Array.isArray(message.content) ? message.content : []) {
			if (block.type === "tool_use") {
				expect(message.role).toBe("assistant");
				expect(block.id).toBeTypeOf("string");
				expect(declared.has(block.id!)).toBe(false);
				declared.add(block.id!);
				pending.add(block.id!);
			} else if (block.type === "tool_result") {
				expect(message.role).toBe("user");
				expect(pending.delete(block.tool_use_id!)).toBe(true);
			}
		}
	}
	expect([...pending]).toEqual([]);
}

function resultMessages(store: SessionStore) {
	return store.buildContext().messages.filter((message) => message.role === "toolResult");
}

describe("built CLI interrupted main-session continuation", () => {
	for (const entry of ENTRY_PATHS) {
		it.each([false, true])(
			`${entry} closes a four-call tail (partial results: %s) before the new user`,
			async (partial) => {
				const world = await cliWorld();
				const { store, missing, realResults } = seedInterrupted(world, partial);
				const originalBytes = readFileSync(store.filePath, "utf8");
				const preview =
					entry === "piped /resume"
						? await world.run([], `/resume ${store.header.id}\n/exit\n`)
						: await world.run(entry === "-r" ? ["-r", store.header.id] : ["-c"], "/exit\n");
				expect(preview.code, preview.stderr).toBe(0);
				expect(preview.stdout).not.toContain("▪ recovered");
				expect(world.requests).toHaveLength(0);
				expect(readFileSync(store.filePath, "utf8")).toBe(originalBytes);
				const prompt = `continue through ${entry}`;
				const output = await continueCli(world, entry, store.header.id, prompt);
				expect(output.code, output.stderr).toBe(0);
				expect(output.stdout).toContain(`recovered ${missing.length} tool call(s)`);
				expect(output.stdout).toContain("outcomes unknown, no tools replayed");
				expect(output.stdout).toContain("Local continuation accepted.");
				expect(world.requests).toHaveLength(1);
				const request = world.requests[0]!;
				expect(request.url).toBe("/v1/messages");
				expect(request.key).toBe("resume-cli-fixture-key");
				expect(request.body.model).toBe("claude-sonnet-4-5");
				pairedWire(request.body.messages);
				expect(request.body.messages.at(-1)).toEqual({ role: "user", content: prompt });
				const wireRepair = request.body.messages.at(-2);
				expect(wireRepair?.role).toBe("user");
				expect(wireRepair?.content).toEqual(
					missing.map((id) => ({
						type: "tool_result",
						tool_use_id: id,
						content: expect.stringContaining("outcome is unknown"),
						is_error: true,
					})),
				);

				if (partial) {
					expect(request.body.messages.at(-3)).toEqual({
						role: "user",
						content: realResults.map((result) => ({
							type: "tool_result",
							tool_use_id: result.toolCallId,
							content: result.content,
							is_error: false,
						})),
					});
				}

				const reopened = SessionStore.open(store.filePath);
				expect(readFileSync(store.filePath, "utf8").startsWith(originalBytes)).toBe(true);
				expect(reopened.header).toEqual(store.header);
				expect(reopened.getSessionName()).toBe("interrupted CLI fixture");
				const messages = reopened.buildContext().messages;
				const results = resultMessages(reopened);
				expect(results).toHaveLength(partial ? 2 : 1);
				if (partial) expect(results[0]?.results).toEqual(realResults);
				const repair = results.at(-1)!;
				expect(repair.results.map((result) => result.toolCallId)).toEqual(missing);
				for (const result of repair.results) unknownOutcome(result);
				expect(messages.at(-3)).toEqual(repair);
				expect(messages.at(-2)).toEqual(user(prompt));
				expect(existsSync(path.join(world.fixture.cwd, "old-tools-ran"))).toBe(false);

				// Opening/replaying alone stays read-only. A second continuation must
				// keep the exact same repair entries, rather than close the batch twice.
				const beforeOpen = readFileSync(store.filePath, "utf8");
				const readOnly = await world.run(["-r", store.header.id], "/exit\n");
				expect(readOnly.code, readOnly.stderr).toBe(0);
				expect(readFileSync(store.filePath, "utf8")).toBe(beforeOpen);
				expect(world.requests).toHaveLength(1);
				const second = await continueCli(world, entry, store.header.id, "check idempotent reopen");
				expect(second.code, second.stderr).toBe(0);
				expect(second.stdout).not.toContain("▪ recovered");
				expect(world.requests).toHaveLength(2);
				pairedWire(world.requests[1]!.body.messages);
				expect(resultMessages(SessionStore.open(store.filePath))).toEqual(results);
				expect(existsSync(path.join(world.fixture.cwd, "old-tools-ran"))).toBe(false);
			},
		);
	}

	it.each(ENTRY_PATHS)(
		"%s refuses a legacy failed continuation locally without appending another prompt",
		async (entry) => {
			const world = await cliWorld();
			const { store } = seedInterrupted(world, false);
			store.appendMessage(user("first failed continuation"));
			const before = readFileSync(store.filePath, "utf8");
			const output = await continueCli(world, entry, store.header.id, "must not be accepted");
			expect(output.code).toBe(entry === "piped /resume" ? 0 : 1);
			const text = output.stdout + output.stderr;
			expect(text).toContain("Cannot continue this history");
			expect(text).toContain("/tree to select the first failed continuation user message");
			expect(text).toContain("/new");
			expect(world.requests).toHaveLength(0);
			expect(readFileSync(store.filePath, "utf8")).toBe(before);
			expect(existsSync(path.join(world.fixture.cwd, "old-tools-ran"))).toBe(false);
		},
	);

	it("recovers an actual SIGKILL after tool execution starts, without executing that tool again", async () => {
		const world = await cliWorld([responseSse({ id: "crash-1", name: "crash_probe" })]);
		const marker = path.join(world.fixture.cwd, "tool-starts.log");
		const extension = path.join(world.fixture.cwd, "crash-probe.mjs");
		writeFileSync(
			extension,
			[
				'import { appendFileSync } from "node:fs";',
				"export default function(api) {",
				"  api.registerTool({",
				'    name: "crash_probe", description: "Record tool start, then die abruptly",',
				'    parameters: { type: "object", additionalProperties: false },',
				"    async execute() {",
				`      appendFileSync(${JSON.stringify(marker)}, "started\\n");`,
				'      process.kill(process.pid, "SIGKILL");',
				"      await new Promise(() => {});",
				"    }",
				"  });",
				"}",
			].join("\n"),
		);
		// The tool itself sends SIGKILL after its synchronous marker write.
		// No sleeps, cross-process polling, interrupt cleanup, or real auth.
		const killed = await world.run(["-e", extension, "-p", "run the crash probe"]);
		expect(killed.signal, killed.stderr).toBe("SIGKILL");
		expect(killed.code).toBeNull();
		expect(readFileSync(marker, "utf8")).toBe("started\n");
		expect(world.requests).toHaveLength(1);
		const sessions = listSessions(world.fixture.cwd, world.sessionBaseDir);
		expect(sessions).toHaveLength(1);
		const store = SessionStore.open(sessions[0]!.filePath);
		expect(store.buildContext().messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(JSON.stringify(store.buildContext().messages.at(-1))).toContain("crash-1");
		const before = readFileSync(store.filePath, "utf8");

		// Keep the lethal tool registered on restart: replay would kill the
		// process again and append a second marker, so both checks are observable.
		const resumed = await world.run(["-e", extension, "-c", "-p", "inspect after the crash"]);
		expect(resumed.code, resumed.stderr).toBe(0);
		expect(resumed.signal).toBeNull();
		expect(resumed.stdout).toContain("recovered 1 tool call(s)");
		expect(world.requests).toHaveLength(2);
		pairedWire(world.requests[1]!.body.messages);
		const reopened = SessionStore.open(store.filePath);
		const results = resultMessages(reopened);
		expect(results).toHaveLength(1);
		expect(results[0]?.results).toHaveLength(1);
		expect(results[0]?.results[0]?.toolCallId).toBe("crash-1");
		unknownOutcome(results[0]!.results[0]!);
		expect(reopened.buildContext().messages.at(-2)).toEqual(user("inspect after the crash"));
		expect(readFileSync(store.filePath, "utf8").startsWith(before)).toBe(true);
		expect(readFileSync(marker, "utf8")).toBe("started\n");
	});
});
