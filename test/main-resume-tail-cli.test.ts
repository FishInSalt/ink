// Built CLI only: npm run build && npm test -- test/main-resume-tail-cli.test.ts
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolResult } from "../src/core/messages.js";
import { createSession, listSessions } from "../src/core/session/manager.js";
import { type MessageEntry, SessionStore } from "../src/core/session/store.js";
import { type CliFixture, collectCliOutput, createCliFixture } from "./helpers/cli-fixture.js";

const MODEL = "claude-sonnet-4-5";
const PROMPT = "Inspect state before deciding whether to retry.";
const calls = [0, 1, 2, 3].map((index) => ({
	type: "toolCall" as const,
	id: `old-${index}`,
	name: "resume_probe",
	arguments: { index },
}));
const entrances = ["-r", "-c", "/resume"] as const;
type Entrance = (typeof entrances)[number];

function frame(type: string, data: Record<string, unknown> = {}): string {
	return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}
function responseSse(toolCalls: boolean): string {
	const chunks = [frame("message_start", { message: { usage: { input_tokens: 1 } } })];
	for (const [index, call] of (toolCalls ? calls : [null]).entries()) {
		const content_block = call
			? { type: "tool_use", id: call.id, name: call.name }
			: { type: "text", text: "" };
		const delta = call
			? { type: "input_json_delta", partial_json: JSON.stringify(call.arguments) }
			: { type: "text_delta", text: "Resumed safely." };
		chunks.push(
			frame("content_block_start", { index, content_block }),
			frame("content_block_delta", { index, delta }),
			frame("content_block_stop", { index }),
		);
	}
	return (
		chunks.join("") +
		frame("message_delta", {
			delta: { stop_reason: toolCalls ? "tool_use" : "end_turn" },
			usage: { output_tokens: 1 },
		}) +
		frame("message_stop")
	);
}
function realResults(answered: number[]): ToolResult[] {
	return answered.map((index) => ({
		toolCallId: calls[index]!.id,
		toolName: "resume_probe",
		content: `real output ${index}`,
		isError: index === 1,
	}));
}
function wireResults(results: ToolResult[]) {
	return {
		role: "user",
		content: results.map((result) => ({
			type: "tool_result",
			tool_use_id: result.toolCallId,
			content: result.content,
			is_error: result.isError,
		})),
	};
}

// Copied install, isolated HOME, synthetic key, loopback provider/catalog and mandatory fixture network guard.
describe("main final-batch recovery through the built CLI", () => {
	let fixture: CliFixture;
	let server: Server;
	let url: string;
	let extension: string;
	let activity: string;
	let serveCalls: boolean;
	let requests: { model: string; messages: unknown[] }[];

	beforeEach(async () => {
		fixture = createCliFixture();
		extension = path.join(fixture.root, "probe.mjs");
		activity = path.join(fixture.root, "extension-activity.log");
		writeFileSync(
			extension,
			`import { appendFileSync } from "node:fs";
const record = text => appendFileSync(${JSON.stringify(activity)}, text + "\\n");
export default function(api) {
  record("loaded");
  for (const type of ["tool_call", "tool_end"])
    api.on(type, event => { record(type + ":" + event.toolCallId); });
  api.registerTool({ name: "resume_probe", description: "Crash fixture only",
    parameters: { type: "object", properties: { index: { type: "integer" } }, required: ["index"] },
    async execute(args) {
      record("execute:" + args.index);
      process.kill(process.pid, "SIGKILL");
      return { output: "unreachable" };
    }
  });
}
`,
		);
		requests = [];
		serveCalls = false;
		server = createServer((request, response) => {
			let raw = "";
			request.setEncoding("utf8");
			request.on("data", (chunk: string) => {
				raw += chunk;
			});
			request.on("end", () => {
				requests.push(JSON.parse(raw));
				response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
				response.end(responseSse(serveCalls));
				serveCalls = false;
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Missing loopback address");
		url = `http://127.0.0.1:${address.port}`;
	});
	afterEach(async () => {
		try {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
				server.closeAllConnections();
			});
		} finally {
			fixture.cleanup(); // also fails on swallowed or SIGKILL-interrupted nonlocal attempts
		}
	});

	function start(args: string[]) {
		return spawn(process.execPath, [fixture.bin, "-e", extension, ...args], {
			cwd: fixture.cwd,
			env: fixture.env({
				ANTHROPIC_API_KEY: "fixture-resume-key",
				ANTHROPIC_BASE_URL: url,
				INK_AUTOCOMPACT: "0",
				INK_HEALTH: "0",
				INK_MCP: "0",
				INK_LOG: "0",
			}),
			stdio: ["pipe", "pipe", "pipe"],
		});
	}
	function resume(entrance: Entrance, id: string, prompt = false) {
		if (entrance === "/resume")
			return collectCliOutput(start([]), `/resume ${id}\n${prompt ? PROMPT : "/quit"}\n`);
		const args = entrance === "-r" ? ["-r", id] : ["-c"];
		return collectCliOutput(start(prompt ? [...args, "-p", PROMPT] : args), prompt ? "" : "/quit\n");
	}
	function seed(answered: number[]) {
		const store = createSession(fixture.cwd, path.join(fixture.home, ".ink/sessions"));
		store.setModel({ provider: "anthropic", modelId: MODEL });
		store.appendMessage({ role: "user", content: "saved request" });
		store.appendMessage({
			role: "assistant",
			blocks: calls,
			usage: { inputTokens: 1, outputTokens: 1 },
			stopReason: "tool_use",
		});
		if (answered.length) store.appendMessage({ role: "toolResult", results: realResults(answered) });
		return store;
	}
	function expectRecovery(entry: MessageEntry, answered: number[]) {
		expect(entry.type).toBe("message");
		expect(entry.message.role).toBe("toolResult");
		if (entry.message.role !== "toolResult") throw new Error("Missing persisted recovery");
		const missing = calls.filter((_, index) => !answered.includes(index));
		expect(entry.message.results.map((r) => r.toolCallId)).toEqual(missing.map((call) => call.id));
		for (const result of entry.message.results) {
			expect(result.toolName).toBe("resume_probe");
			expect(result.isError).toBe(true);
			for (const text of [
				"No result was recorded",
				"outcome is unknown",
				"fully or partially",
				"Ink did not replay it",
				"Inspect relevant state before deciding whether to retry",
			])
				expect(result.content).toContain(text);
			expect(result).not.toHaveProperty("taskRecord");
		}
		return entry.message.results;
	}

	const cases = entrances.flatMap((entrance) =>
		[0, 2].flatMap((real) => [false, true].map((prompt) => ({ entrance, real, prompt }))),
	);
	it.each(cases)(
		"$entrance with $real real results, new prompt=$prompt repairs immediately",
		async ({ entrance, real, prompt }) => {
			const answered = real ? [3, 1] : []; // deliberately out of declaration order
			const store = seed(answered);
			const before = readFileSync(store.filePath, "utf8");
			const result = await resume(entrance, store.header.id, prompt);
			expect(result.code, result.stderr + result.stdout).toBe(0);
			expect(result.stdout.match(/▪ recovered /g)).toHaveLength(1);
			expect(result.stdout).toContain(`▪ recovered ${4 - real} interrupted tool call(s)`);
			const after = readFileSync(store.filePath, "utf8");
			expect(after.startsWith(before)).toBe(true); // real outputs/metadata remain byte-for-byte
			const appended = after
				.slice(before.length)
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as MessageEntry);
			const recovered = expectRecovery(appended[0]!, answered);
			expect(appended[0]!.parentId).toBe(store.getLeafId());
			expect(appended).toHaveLength(prompt ? 3 : 1); // repair, then new user, then assistant
			if (prompt) {
				expect(appended[1]!.message).toEqual({ role: "user", content: PROMPT });
				expect(appended[1]!.parentId).toBe(appended[0]!.id);
				expect(requests).toHaveLength(1);
				expect(requests[0]?.model).toBe(MODEL);
				const wireCalls = calls.map(({ id, name, arguments: input }) => ({
					type: "tool_use",
					id,
					name,
					input,
				}));
				expect(requests[0]?.messages).toEqual([
					{ role: "user", content: "saved request" },
					{ role: "assistant", content: wireCalls },
					...(real ? [wireResults(realResults(answered))] : []),
					wireResults(recovered),
					{ role: "user", content: PROMPT },
				]);
			} else expect(requests).toEqual([]); // viewing alone must already repair
			const again = await resume(entrance, store.header.id);
			expect(again.code, again.stderr + again.stdout).toBe(0);
			expect(again.stdout).not.toContain("▪ recovered");
			expect(readFileSync(store.filePath, "utf8")).toBe(after);
			expect(requests).toHaveLength(prompt ? 1 : 0);
			expect(readFileSync(activity, "utf8")).toBe("loaded\nloaded\n"); // no tool hooks or execution
		},
	);

	it.each(entrances)("%s leaves a complete final batch unchanged", async (entrance) => {
		const store = seed([3, 1, 0, 2]);
		const before = readFileSync(store.filePath, "utf8");
		const result = await resume(entrance, store.header.id);
		expect(result.code, result.stderr + result.stdout).toBe(0);
		expect(result.stdout).not.toContain("▪ recovered");
		expect(readFileSync(store.filePath, "utf8")).toBe(before);
		expect(requests).toEqual([]);
		expect(readFileSync(activity, "utf8")).toBe("loaded\n");
	});

	it("repairs a four-call batch after actual SIGKILL without replaying the claimed tool", async () => {
		serveCalls = true;
		const child = start(["-p", "start crash fixture"]);
		let signal: NodeJS.Signals | null = null;
		child.once("exit", (_code, value) => {
			signal = value;
		});
		const killed = await collectCliOutput(child, "");
		expect(signal, killed.stderr + killed.stdout).toBe("SIGKILL");
		expect(killed.code).toBeNull();
		const [info] = listSessions(fixture.cwd, path.join(fixture.home, ".ink/sessions"));
		expect(info).toBeDefined();
		const file = info!.filePath;
		const messages = SessionStore.open(file).buildContext().messages;
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(messages[1]).toMatchObject({ blocks: calls });
		const before = readFileSync(file, "utf8");
		const claimed = readFileSync(activity, "utf8");
		expect(claimed).toBe("loaded\ntool_call:old-0\nexecute:0\n");
		const restarted = await resume("-r", info!.id);
		expect(restarted.code, restarted.stderr + restarted.stdout).toBe(0);
		expect(restarted.stdout).toContain("▪ recovered 4 interrupted tool call(s)");
		expectRecovery(JSON.parse(readFileSync(file, "utf8").slice(before.length)), []);
		expect(readFileSync(activity, "utf8")).toBe(`${claimed}loaded\n`);
		expect(requests).toHaveLength(1); // restart only views; no second model request
		const repaired = readFileSync(file, "utf8");
		const again = await resume("-c", info!.id);
		expect(again.code).toBe(0);
		expect(again.stdout).not.toContain("▪ recovered");
		expect(readFileSync(file, "utf8")).toBe(repaired);
		expect(readFileSync(activity, "utf8")).toBe(`${claimed}loaded\nloaded\n`);
	});
});
