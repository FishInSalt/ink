import { createServer, type Server } from "node:http";
import { Type } from "typebox";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type AgentEvent, runAgentLoop } from "../src/core/loop.js";
import type { AgentMessage, AssistantMessage } from "../src/core/messages.js";
import type { Tool } from "../src/core/tools/types.js";
import { CodexResponseError, createCodexResponsesProvider } from "../src/provider/codex-responses.js";
import type { LLMEvent, LLMRequest } from "../src/provider/types.js";

/** Offline wire regressions for docs/design/codex-tool-arguments-design.md.
 * Auth is injected, every response comes from loopback, and tools only record
 * their arguments. Completed fixtures close calls with output_item.done unless
 * missing finalization is the specific condition under test. */
type Fields = Record<string, unknown>;
interface WireEvent {
	event: string;
	data: Fields;
}
interface FixtureCase {
	name: string;
	events: WireEvent[];
}
type Source = "initial" | "delta" | "arguments-done" | "final-item" | "done-only";

const INDEX = 7;
const ARGS = { path: "文档/naïve-🙂.ts" };
const RAW = JSON.stringify(ARGS);
const PREFIX = '{"path":"文档/';
const WRONG = '{"path":"incorrect';
const USAGE = { input_tokens: 33, output_tokens: 13, input_tokens_details: { cached_tokens: 8 } };
const NORMALIZED_USAGE = { inputTokens: 25, outputTokens: 13, cacheReadTokens: 8 };
const terminalOutputs = [
	{ aggregate: "omitted", output: undefined },
	{ aggregate: "empty", output: [] },
];

function wire(event: string, data: Fields): WireEvent {
	return { event, data };
}
function identity(index: unknown = INDEX, fields: Fields = {}): Fields {
	return { type: "function_call", id: `item_${index}`, call_id: `call_${index}`, name: "read", ...fields };
}
function itemEvent(kind: "added" | "done", index: unknown, item: Fields): WireEvent {
	return wire(`response.output_item.${kind}`, { output_index: index, item });
}
// An explicitly supplied undefined index means the wire omits output_index;
// omitting the helper parameter entirely uses the common fixture index.
function added(...params: [index?: unknown, fields?: Fields]): WireEvent {
	const [index, fields = {}] = params;
	const target = params.length === 0 ? INDEX : index;
	return itemEvent("added", target, identity(target, fields));
}
function done(...params: [index?: unknown, fields?: Fields]): WireEvent {
	const [index, fields = {}] = params;
	return itemEvent("done", params.length === 0 ? INDEX : index, { type: "function_call", ...fields });
}
function delta(value: unknown, ...params: [index?: unknown, fields?: Fields]): WireEvent {
	const [index, fields = {}] = params;
	return wire("response.function_call_arguments.delta", {
		output_index: params.length === 0 ? INDEX : index,
		delta: value,
		...fields,
	});
}
function argsDone(value: unknown, ...params: [index?: unknown, fields?: Fields]): WireEvent {
	const [index, fields = {}] = params;
	return wire("response.function_call_arguments.done", {
		output_index: params.length === 0 ? INDEX : index,
		arguments: value,
		...fields,
	});
}
function openTool(index = INDEX, fields: Fields = {}): WireEvent[] {
	return [added(index, fields), delta(RAW, index)];
}
function completed(fields: Fields = {}): WireEvent {
	return wire("response.completed", { response: { status: "completed", usage: USAGE, ...fields } });
}
function incomplete(event = "response.incomplete", status = "incomplete"): WireEvent {
	return wire(event, {
		response: { status, incomplete_details: { reason: "max_output_tokens" }, usage: USAGE },
	});
}
function textAdded(index: number): WireEvent {
	return itemEvent("added", index, { type: "message", id: `message_${index}` });
}
function textTurn(): WireEvent[] {
	return [
		textAdded(0),
		wire("response.output_text.delta", { output_index: 0, delta: "finished" }),
		itemEvent("done", 0, { type: "message", id: "message_0" }),
		completed(),
	];
}
function fromSource(source: Source, raw: string, index = INDEX, fields: Fields = {}): WireEvent[] {
	switch (source) {
		case "initial":
			return [added(index, { ...fields, arguments: raw }), done(index)];
		case "delta":
			return [added(index, fields), delta(raw, index), done(index)];
		case "arguments-done":
			return [added(index, fields), argsDone(raw, index), done(index)];
		case "final-item":
			return [added(index, fields), done(index, { arguments: raw })];
		case "done-only":
			return [done(index, identity(index, { ...fields, arguments: raw }))];
	}
}
function request(fields: Partial<LLMRequest> = {}): LLMRequest {
	return {
		system: "offline argument reconciliation test",
		model: "gpt-5.5",
		messages: [{ role: "user", content: "inspect the files" }],
		tools: [],
		maxTokens: 1024,
		...fields,
	};
}
async function collect(stream: AsyncIterable<LLMEvent>, observed: LLMEvent[] = []): Promise<LLMEvent[]> {
	for await (const event of stream) observed.push(event);
	return observed;
}
function message(events: LLMEvent[]): AssistantMessage {
	const endings = events.filter((event) => event.type === "message_end");
	expect(endings).toHaveLength(1);
	const end = endings[0];
	if (end?.type !== "message_end") throw new Error("Missing final message in local fixture");
	return { ...end.message, blocks: end.message.blocks.map(({ responses: _replay, ...block }) => block) };
}
function toolBlock(index: number, args: unknown, name = "read") {
	return { type: "toolCall", id: `call_${index}`, name, arguments: args };
}
function streamedJson(events: LLMEvent[], id = `call_${INDEX}`): string {
	return events
		.filter((event) => event.type === "tool_call_delta" && event.id === id)
		.map((event) => (event.type === "tool_call_delta" ? event.jsonDelta : ""))
		.join("");
}

const sourceCases: Array<FixtureCase & { streamed: string; index?: number }> = [
	{
		name: "initial arguments survive a final item with no argument field",
		events: fromSource("initial", RAW),
		streamed: RAW,
	},
	{
		name: "arguments-done supplies the sole argument snapshot",
		events: fromSource("arguments-done", RAW),
		streamed: RAW,
	},
	{
		name: "final item supplies the sole argument snapshot",
		events: fromSource("final-item", RAW),
		streamed: RAW,
	},
	{
		name: "done-only creates exactly one executable call",
		events: fromSource("done-only", RAW),
		streamed: RAW,
	},
	{
		name: "existing fragmented delta-only streams are unchanged",
		events: [added(), delta(PREFIX), delta(RAW.slice(PREFIX.length)), done()],
		streamed: RAW,
	},
	{
		name: "initial prefix and subsequent deltas concatenate",
		events: [added(INDEX, { arguments: PREFIX }), delta(RAW.slice(PREFIX.length)), done()],
		streamed: RAW,
	},
	{
		name: "arguments-done extends a partial delta without duplication",
		events: [added(), delta(PREFIX), argsDone(RAW), done()],
		streamed: RAW,
	},
	{
		name: "final item extends a partial delta without duplication",
		events: [added(), delta(PREFIX), done(INDEX, { arguments: RAW })],
		streamed: RAW,
	},
	{
		name: "arguments-done repairs incorrect deltas without an invented reset delta",
		events: [added(), delta(WRONG), argsDone(RAW), done()],
		streamed: WRONG,
	},
	{
		name: "final item repairs incorrect deltas without an invented reset delta",
		events: [added(), delta(WRONG), done(INDEX, { arguments: RAW })],
		streamed: WRONG,
	},
	{
		name: "final item overrides an earlier arguments-done snapshot",
		events: [added(), argsDone('{"path":"old"}'), done(INDEX, { arguments: RAW })],
		streamed: '{"path":"old"}',
	},
	{
		name: "final item extends an incomplete arguments-done snapshot",
		events: [added(), argsDone(PREFIX), done(INDEX, { arguments: RAW })],
		streamed: RAW,
	},
	{
		name: "all complete snapshots are replacements, not appended copies",
		events: [added(INDEX, { arguments: RAW }), argsDone(RAW), done(INDEX, { arguments: RAW })],
		streamed: RAW,
	},
	{
		name: "complete deltas followed by both snapshots are not duplicated",
		events: [added(), delta(RAW), argsDone(RAW), done(INDEX, { arguments: RAW })],
		streamed: RAW,
	},
	{
		name: "arguments-done repairs an incorrect initial snapshot",
		events: [added(INDEX, { arguments: WRONG }), argsDone(RAW), done()],
		streamed: WRONG,
	},
	{
		name: "index zero remains a valid delta target",
		index: 0,
		events: fromSource("delta", RAW, 0),
		streamed: RAW,
	},
	{
		name: "index zero also supports done-only snapshot creation",
		index: 0,
		events: fromSource("done-only", RAW, 0),
		streamed: RAW,
	},
	...(["", " \t\n"] as const).flatMap((blank) => [
		{
			name: `blank snapshots ${JSON.stringify(blank)} preserve initial arguments`,
			events: [added(INDEX, { arguments: RAW }), argsDone(blank), done(INDEX, { arguments: blank })],
			streamed: RAW,
		},
		{
			name: `blank snapshots ${JSON.stringify(blank)} preserve deltas`,
			events: [added(), delta(RAW), argsDone(blank), done(INDEX, { arguments: blank })],
			streamed: RAW,
		},
		{
			name: `blank final snapshot ${JSON.stringify(blank)} preserves arguments-done`,
			events: [added(), argsDone(RAW), done(INDEX, { arguments: blank })],
			streamed: RAW,
		},
	]),
];

const routingCases: FixtureCase[] = [
	...([undefined, -1, 0.5, "7", null, true, {}, []] as const).flatMap((index) => [
		{
			name: `invalid addition index ${JSON.stringify(index)}`,
			events: [added(index), delta(RAW, index), done(index)],
		},
		{
			name: `invalid done-only index ${JSON.stringify(index)}`,
			events: [done(index, identity(INDEX, { arguments: RAW }))],
		},
		{
			name: `existing final item cannot replace invalid index ${JSON.stringify(index)} with a known item ID`,
			events: [...openTool(), done(index, { id: `item_${INDEX}` }), done()],
		},
	]),
	...(["delta", "arguments-done"] as const).flatMap((kind) => {
		// A misplaced delta is whitespace: ignoring its bad routing or applying
		// it to either existing call would still leave valid JSON. All existing
		// calls are otherwise complete, so argument/completion errors cannot
		// accidentally satisfy these routing-specific rejection assertions.
		const event = (index: unknown, fields: Fields = {}) =>
			kind === "delta" ? delta(" ", index, fields) : argsDone(RAW, index, fields);
		return [
			...([undefined, -1, 0.5, "7", null, false, {}, []] as const).map((index) => ({
				name: `${kind} rejects invalid/missing index ${JSON.stringify(index)} without item ID`,
				events: [...openTool(), event(index), done()],
			})),
			...([-1, 0.5, "7", null] as const).map((index) => ({
				name: `${kind} cannot replace invalid index ${JSON.stringify(index)} with a known item ID`,
				events: [...openTool(), event(index, { item_id: `item_${INDEX}` }), done()],
			})),
			{ name: `${kind} has no preexisting target`, events: [event(INDEX)] },
			{ name: `${kind} has an unknown index`, events: [...openTool(), event(99), done()] },
			{
				name: `${kind} cannot override unknown index with known item ID`,
				events: [...openTool(), event(99, { item_id: `item_${INDEX}` }), done()],
			},
			{
				name: `${kind} cannot route index-less unknown item ID`,
				events: [...openTool(), event(undefined, { item_id: "unknown_item" }), done()],
			},
			{
				name: `${kind} cannot confuse an executable call ID with a wire item ID`,
				events: [...openTool(), event(undefined, { item_id: `call_${INDEX}` }), done()],
			},
			{
				name: `${kind} index and item ID identify different calls`,
				events: [...openTool(), ...openTool(11), event(INDEX, { item_id: "item_11" }), done(), done(11)],
			},
			{
				name: `${kind} cannot rebind an existing wire item ID`,
				events: [...openTool(), event(INDEX, { item_id: "changed_item" }), done()],
			},
			{
				name: `${kind} cannot bind an ID claimed by another slot`,
				events: [
					...openTool(INDEX, { id: undefined }),
					...openTool(11),
					event(INDEX, { item_id: "item_11" }),
					done(),
					done(11),
				],
			},
			...(["", null, 17, false, {}, []] as const).map((itemId) => ({
				name: `${kind} rejects invalid item ID ${JSON.stringify(itemId)}`,
				events: [...openTool(INDEX, { id: undefined }), event(INDEX, { item_id: itemId }), done()],
			})),
			{ name: `${kind} collides with a text slot`, events: [textAdded(INDEX), event(INDEX)] },
		];
	}),
	{
		name: "a tool addition collides with a text slot",
		events: [textAdded(INDEX), added(), delta(RAW), done()],
	},
	{
		name: "a text addition cannot replace an existing tool slot",
		events: [...openTool(), textAdded(INDEX), done()],
	},
	{
		name: "a final tool item collides with a text slot",
		events: [textAdded(INDEX), done(INDEX, identity(INDEX, { arguments: RAW }))],
	},
	{
		name: "final item cannot move a known ID to an unknown index",
		events: [...openTool(), done(99, identity(INDEX, { arguments: RAW })), done()],
	},
];

const identityCases: FixtureCase[] = [
	...(["call_id", "name"] as const).flatMap((key) =>
		([undefined, "", null, 17, false, {}, []] as const).flatMap((value) => [
			{
				name: `addition requires nonempty string ${key}: ${JSON.stringify(value)}`,
				events: [added(INDEX, { [key]: value }), delta(RAW), done()],
			},
			{
				name: `done-only requires nonempty string ${key}: ${JSON.stringify(value)}`,
				events: [done(INDEX, identity(INDEX, { [key]: value, arguments: RAW }))],
			},
		]),
	),
	...(["id", "call_id", "name"] as const).flatMap((key) =>
		(["changed", "", null, 17, false, {}, []] as const).map((value) => ({
			name: `final metadata cannot change ${key} to ${JSON.stringify(value)}`,
			events: [added(), delta(RAW), done(INDEX, { [key]: value })],
		})),
	),
	...(["", null, 17, false, {}, []] as const).map((id) => ({
		name: `supplied creation item ID must be nonempty string: ${JSON.stringify(id)}`,
		events: [added(INDEX, { id }), delta(RAW), done()],
	})),
	{ name: "duplicate output slot addition", events: [added(), added(), delta(RAW), done()] },
	{
		name: "duplicate output slot addition with different identity",
		events: [added(), added(INDEX, identity(11)), delta(RAW), done()],
	},
	{
		name: "duplicate call ID across different indices",
		events: [...openTool(), ...openTool(11, { call_id: `call_${INDEX}` }), done(), done(11)],
	},
	{
		name: "duplicate item ID across different indices",
		events: [...openTool(), ...openTool(11, { id: `item_${INDEX}` }), done(), done(11)],
	},
	{
		name: "done-only cannot duplicate an existing call ID",
		events: [
			added(),
			delta(RAW),
			done(),
			done(11, identity(11, { call_id: `call_${INDEX}`, arguments: RAW })),
		],
	},
	{
		name: "done-only cannot duplicate an existing item ID",
		events: [added(), delta(RAW), done(), done(11, identity(11, { id: `item_${INDEX}`, arguments: RAW }))],
	},
	{
		name: "final binding cannot claim another slot's item ID",
		events: [
			...openTool(INDEX, { id: undefined }),
			...openTool(11),
			done(INDEX, { id: "item_11" }),
			done(11),
		],
	},
	{
		name: "indexed delta first-binding cannot later change",
		events: [
			added(INDEX, { id: undefined }),
			delta(PREFIX, INDEX, { item_id: "bound" }),
			delta(RAW.slice(PREFIX.length), INDEX, { item_id: "other" }),
			done(),
		],
	},
	{
		name: "arguments-done first-binding cannot change in final metadata",
		events: [
			...openTool(INDEX, { id: undefined }),
			argsDone(RAW, INDEX, { item_id: "bound" }),
			done(INDEX, { id: "other" }),
		],
	},
	{
		name: "final-item first-binding remains claimed after completion",
		events: [
			added(INDEX, { id: undefined }),
			delta(RAW),
			done(INDEX, { id: "bound" }),
			added(11, { id: "bound" }),
			delta(RAW, 11),
			done(11),
		],
	},
];

const lifecycleCases: FixtureCase[] = [
	{ name: "delta after arguments-done", events: [...openTool(), argsDone(RAW), delta(" "), done()] },
	{ name: "empty delta after arguments-done", events: [...openTool(), argsDone(RAW), delta(""), done()] },
	{ name: "delta after final item", events: [added(), delta(RAW), done(), delta(" ")] },
	{ name: "empty delta after final item", events: [added(), delta(RAW), done(), delta("")] },
	{ name: "arguments-done after final item", events: [added(), delta(RAW), done(), argsDone(RAW)] },
	{
		name: "repeated identical arguments-done",
		events: [...openTool(), argsDone(RAW), argsDone(RAW), done()],
	},
	{
		name: "repeated conflicting arguments-done",
		events: [...openTool(), argsDone(RAW), argsDone('{"path":"other"}'), done()],
	},
	{
		name: "repeated blank arguments-done",
		events: [added(), delta(RAW), argsDone(""), argsDone(""), done()],
	},
	{ name: "repeated identical final item", events: [added(), delta(RAW), done(), done()] },
	{
		name: "repeated conflicting final item",
		events: [...openTool(), done(INDEX, { arguments: RAW }), done(INDEX, { arguments: '{"path":"other"}' })],
	},
	{
		name: "new addition after finalization cannot reuse slot",
		events: [added(), delta(RAW), done(), added(), delta(RAW), done()],
	},
	...([null, {}, [], 17, true, false] as const).flatMap((value) => [
		{
			name: `nonstring initial arguments ${JSON.stringify(value)}`,
			events: [added(INDEX, { arguments: value }), delta(RAW), done(INDEX, { arguments: RAW })],
		},
		{
			name: `nonstring delta ${JSON.stringify(value)}`,
			events: [...openTool(), delta(value), done(INDEX, { arguments: RAW })],
		},
		{
			name: `nonstring arguments-done ${JSON.stringify(value)}`,
			events: [added(), delta(RAW), argsDone(value), done()],
		},
		{
			name: `nonstring final arguments ${JSON.stringify(value)}`,
			events: [added(), delta(RAW), done(INDEX, { arguments: value })],
		},
	]),
	{ name: "missing delta field", events: [...openTool(), delta(undefined), done(INDEX, { arguments: RAW })] },
	{ name: "missing arguments-done field", events: [added(), delta(RAW), argsDone(undefined), done()] },
];

const completionCases: FixtureCase[] = [
	{ name: "no argument data is not an explicit empty object", events: [added(), done()] },
	{ name: "empty initial argument data", events: [added(INDEX, { arguments: "" }), done()] },
	{ name: "whitespace initial argument data", events: [added(INDEX, { arguments: " \t\n" }), done()] },
	{ name: "empty delta is not argument data", events: [added(), delta(""), done()] },
	{ name: "whitespace delta is not argument data", events: [added(), delta(" \n"), done()] },
	{ name: "empty arguments-done is not argument data", events: [added(), argsDone(""), done()] },
	{ name: "whitespace arguments-done is not argument data", events: [added(), argsDone(" \t"), done()] },
	{ name: "empty final arguments are not argument data", events: [added(), done(INDEX, { arguments: "" })] },
	{
		name: "whitespace final arguments are not argument data",
		events: [added(), done(INDEX, { arguments: " \n" })],
	},
	{ name: "done-only with no argument field", events: [done(INDEX, identity())] },
	{ name: "done-only with blank arguments", events: [done(INDEX, identity(INDEX, { arguments: " \t" }))] },
	{ name: "complete deltas still require item finalization", events: [added(), delta(RAW)] },
	{ name: "initial arguments still require item finalization", events: [added(INDEX, { arguments: RAW })] },
	{ name: "arguments-done is not item finalization", events: [added(), argsDone(RAW)] },
	...(["{", "[1,", '{"path":}', "undefined"] as const).map((raw) => ({
		name: `malformed completed JSON ${JSON.stringify(raw)}`,
		events: [added(), delta(raw), done()],
	})),
];

const jsonValues = [
	{ label: "explicit empty object", raw: "{}", value: {} },
	{ label: "empty array", raw: "[]", value: [] },
	{ label: "array", raw: '[1,"雪",null]', value: [1, "雪", null] },
	{ label: "string", raw: '"résumé 🙂"', value: "résumé 🙂" },
	{ label: "number", raw: "42", value: 42 },
	{ label: "true", raw: "true", value: true },
	{ label: "false", raw: "false", value: false },
	{ label: "null", raw: "null", value: null },
];

interface Executed {
	id: string | undefined;
	name: string;
	args: Record<string, unknown>;
}
function recordingTool(
	name: string,
	parameters: Tool["parameters"],
	seen: Executed[],
	order: string[] = [],
): Tool {
	return {
		name,
		description: `Record ${name} arguments without accessing files`,
		parameters,
		async execute(args, _signal, context) {
			const id = context?.toolCallId;
			order.push(`start:${id}`);
			seen.push({ id, name, args });
			await Promise.resolve();
			order.push(`end:${id}`);
			return { output: `${name}:${JSON.stringify(args)}` };
		},
	};
}

// A shared localhost SSE harness keeps the parameterized cases small. The
// script queue permits a real second loop turn so replay is checked on the wire.
describe("Codex tool arguments", () => {
	let server: Server;
	let baseUrl = "";
	const scripts: Array<{ events: WireEvent[]; hold: boolean }> = [];
	const captured: Fields[] = [];

	beforeAll(async () => {
		server = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (chunk) => chunks.push(chunk as Buffer));
			req.on("end", () => {
				captured.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Fields);
				const script = scripts.shift();
				res.writeHead(200, { "content-type": "text/event-stream" });
				if (script === undefined) {
					res.end('event: error\ndata: {"message":"Unexpected localhost fixture request"}\n\n');
					return;
				}
				for (const event of script.events) {
					res.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
				}
				if (!script.hold) res.end();
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("Missing localhost address");
		baseUrl = `http://127.0.0.1:${address.port}`;
	});
	beforeEach(() => {
		scripts.length = 0;
		captured.length = 0;
	});
	afterAll(async () => {
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
			server.closeAllConnections();
		});
	});

	function enqueue(events: WireEvent[], hold = false) {
		scripts.push({ events, hold });
	}
	function provider() {
		return createCodexResponsesProvider({
			baseUrl,
			auth: async () => ({ accessToken: "fake-offline-access" }),
		});
	}
	async function run(events: WireEvent[], terminal = completed()): Promise<LLMEvent[]> {
		enqueue([...events, terminal]);
		return collect(provider().stream(request()));
	}
	async function protocolFailure(events: WireEvent[], terminal: WireEvent | null = completed()) {
		enqueue(terminal === null ? events : [...events, terminal]);
		const observed: LLMEvent[] = [];
		const pending = collect(provider().stream(request()), observed);
		const error: unknown = await pending.then(
			() => undefined,
			(failure: unknown) => failure,
		);
		await expect.soft(pending).rejects.toThrow();
		expect.soft(observed.filter((event) => event.type === "message_end")).toHaveLength(0);
		return error;
	}
	function loopOptions(tools: Tool[], history: AgentMessage[], events: AgentEvent[], extra = {}) {
		return {
			provider: provider(),
			model: "gpt-5.5",
			system: "offline loop integration",
			tools,
			history,
			userMessage: "inspect the files",
			maxIterations: 3,
			onEvent: (event: AgentEvent) => events.push(event),
			...extra,
		};
	}

	describe("source reconciliation", () => {
		it.each(sourceCases)("$name", async ({ events: fixture, streamed, index = INDEX }) => {
			const events = await run(fixture);
			expect(message(events).blocks).toEqual([toolBlock(index, ARGS)]);
			expect(message(events)).toMatchObject({ stopReason: "tool_use", usage: NORMALIZED_USAGE });
			expect(events.filter((event) => event.type === "tool_call_start")).toEqual([
				{ type: "tool_call_start", id: `call_${index}`, name: "read" },
			]);
			expect(streamedJson(events, `call_${index}`)).toBe(streamed);
			expect(events.at(-1)?.type).toBe("message_end");
		});

		it.each(
			(["initial", "delta", "arguments-done", "final-item", "done-only"] as const).flatMap((source) =>
				jsonValues.map((value) => ({ ...value, source })),
			),
		)("$source preserves JSON $label for loop-owned schema validation", async ({ source, raw, value }) => {
			const events = await run(fromSource(source, raw));
			expect(message(events).blocks).toEqual([toolBlock(INDEX, value)]);
			expect(streamedJson(events)).toBe(raw);
		});

		it("isolates four interleaved mixed-source calls, repeated names, text, reasoning and Unicode", async () => {
			const a = { path: "文档/甲.txt" };
			const b = { path: "βeta/🙂.ts" };
			const c = { pattern: "TODO:雪|λ", path: "src/世界" };
			const d = { pattern: "café|🦊", path: "测试" };
			const rawB = JSON.stringify(b);
			const rawC = JSON.stringify(c);
			const events = await run([
				itemEvent("added", 0, { type: "reasoning", id: "reasoning_0" }),
				added(9, { arguments: rawB.slice(0, 12) }),
				textAdded(2),
				added(27, { name: "grep" }),
				wire("response.output_text.delta", { output_index: 2, delta: "checking 日本語…" }),
				added(4, { arguments: JSON.stringify(a) }),
				delta(rawB.slice(12), 9),
				added(15, { name: "grep" }),
				delta(rawC.slice(0, 14), 15),
				wire("response.reasoning_summary_text.delta", { output_index: 0, delta: "ignored reasoning" }),
				argsDone(rawB, 9),
				delta(rawC.slice(14, 18), undefined, { item_id: "item_15" }),
				done(27, { arguments: JSON.stringify(d) }),
				done(4),
				argsDone(rawC, undefined, { item_id: "item_15" }),
				done(9),
				itemEvent("done", 2, { type: "message" }),
				done(15),
				itemEvent("done", 0, { type: "reasoning", id: "reasoning_0" }),
			]);
			expect(message(events).blocks).toEqual([
				{ type: "thinking", thinking: "ignored reasoning" },
				{ type: "text", text: "checking 日本語…" },
				toolBlock(4, a),
				toolBlock(9, b),
				toolBlock(15, c, "grep"),
				toolBlock(27, d, "grep"),
			]);
			expect(events.filter((event) => event.type === "tool_call_start")).toEqual([
				{ type: "tool_call_start", id: "call_9", name: "read" },
				{ type: "tool_call_start", id: "call_27", name: "grep" },
				{ type: "tool_call_start", id: "call_4", name: "read" },
				{ type: "tool_call_start", id: "call_15", name: "grep" },
			]);
			for (const [index, args] of [
				[4, a],
				[9, b],
				[15, c],
				[27, d],
			] as const) {
				expect(streamedJson(events, `call_${index}`)).toBe(JSON.stringify(args));
			}
			expect(events.filter((event) => event.type === "text_delta")).toEqual([
				{ type: "text_delta", text: "checking 日本語…" },
			]);
			expect(events.filter((event) => event.type === "thinking_delta")).toEqual([
				{ type: "thinking_delta", text: "ignored reasoning" },
			]);
		});

		it("sorts done-only discoveries and text by output index, not discovery or completion order", async () => {
			const events = await run([
				added(11),
				delta(RAW, 11),
				done(11),
				textAdded(4),
				wire("response.output_text.delta", { output_index: 4, delta: "middle" }),
				done(2, identity(2, { arguments: RAW })),
				itemEvent("done", 4, { type: "message" }),
			]);
			expect(message(events).blocks).toEqual([
				toolBlock(2, ARGS),
				{ type: "text", text: "middle" },
				toolBlock(11, ARGS),
			]);
			expect(events.filter((event) => event.type === "tool_call_start").map((event) => event.id)).toEqual([
				"call_11",
				"call_2",
			]);
		});
	});

	describe("item ID fallback and first binding", () => {
		const successes: FixtureCase[] = [
			{
				name: "index-less deltas and arguments-done route to a known item ID",
				events: [
					added(),
					delta(PREFIX, undefined, { item_id: `item_${INDEX}` }),
					delta(RAW.slice(PREFIX.length), undefined, { item_id: `item_${INDEX}` }),
					argsDone(RAW, undefined, { item_id: `item_${INDEX}` }),
					done(),
				],
			},
			{
				name: "indexed delta binds a previously absent ID for later index-less events",
				events: [
					added(INDEX, { id: undefined }),
					delta(PREFIX, INDEX, { item_id: "bound" }),
					delta(RAW.slice(PREFIX.length), undefined, { item_id: "bound" }),
					argsDone(RAW, undefined, { item_id: "bound" }),
					done(INDEX, { id: "bound" }),
				],
			},
			{
				name: "indexed arguments-done may first-bind an absent ID",
				events: [
					added(INDEX, { id: undefined }),
					argsDone(RAW, INDEX, { item_id: "bound" }),
					done(INDEX, { id: "bound" }),
				],
			},
			{
				name: "index-less arguments-done alone resolves a known item ID",
				events: [added(), argsDone(RAW, undefined, { item_id: `item_${INDEX}` }), done()],
			},
			{
				name: "an indexed event may first-bind the ID of a later discovered slot",
				events: [
					added(INDEX, { id: undefined }),
					delta(PREFIX),
					delta(RAW.slice(PREFIX.length), INDEX, { item_id: "bound" }),
					argsDone(RAW, undefined, { item_id: "bound" }),
					done(),
				],
			},
			{
				name: "matching index and wire item ID target the same call",
				events: [
					added(),
					delta(RAW, INDEX, { item_id: `item_${INDEX}` }),
					argsDone(RAW, INDEX, { item_id: `item_${INDEX}` }),
					done(),
				],
			},
			{
				name: "executable call IDs and wire item IDs are separate namespaces",
				events: [
					added(INDEX, { id: `call_${INDEX}` }),
					delta(RAW, undefined, { item_id: `call_${INDEX}` }),
					done(),
				],
			},
			{
				name: "final item may first-bind an absent ID",
				events: [added(INDEX, { id: undefined }), delta(RAW), done(INDEX, { id: "bound" })],
			},
			{
				name: "omitted final identity preserves the creation identity",
				events: [added(), delta(RAW), done()],
			},
			{
				name: "matching supplied final identity is accepted",
				events: [added(), delta(RAW), done(INDEX, identity())],
			},
			{
				name: "creation wire item ID is optional",
				events: [added(INDEX, { id: undefined }), delta(RAW), done()],
			},
			{
				name: "done-only wire item ID is optional",
				events: [done(INDEX, identity(INDEX, { id: undefined, arguments: RAW }))],
			},
		];
		it.each(successes)("$name", async ({ events: fixture }) => {
			const events = await run(fixture);
			expect(message(events).blocks).toEqual([toolBlock(INDEX, ARGS)]);
			expect(events.filter((event) => event.type === "tool_call_start")).toHaveLength(1);
			expect(streamedJson(events)).toBe(RAW);
		});
	});

	describe("strict routing rejection", () => {
		it.each(routingCases)("$name", async ({ events }) => {
			await protocolFailure(events);
		});
	});
	describe("strict identity and metadata rejection", () => {
		it.each(identityCases)("$name", async ({ events }) => {
			await protocolFailure(events);
		});
	});
	describe("duplicate, late and nonstring event rejection", () => {
		it.each(lifecycleCases)("$name", async ({ events }) => {
			await protocolFailure(events);
		});
	});
	describe("completed-call safety", () => {
		it.each(completionCases)("$name", async ({ events }) => {
			await protocolFailure(events);
		});

		it.each(["initial", "delta", "arguments-done", "final-item", "done-only"] as const)(
			"malformed %s JSON rejects without exposing sensitive raw arguments",
			async (source) => {
				const sensitive = "PRIVATE_ARG_SECRET";
				const raw = `{"path":"${sensitive}:/private/雪/🔒",}`;
				const failure = await protocolFailure(fromSource(source, raw));
				// protocolFailure also asserts rejection and absence of message_end.
				const diagnostic = failure instanceof Error ? failure.message : String(failure);
				expect(diagnostic).not.toContain(sensitive);
				expect(diagnostic).not.toContain("PRIVATE_ARG");
				expect(diagnostic).not.toContain("/private/雪/🔒");
				expect(diagnostic).not.toContain(raw);
			},
		);

		it("a terminal output array cannot finalize or repair an unfinished call", async () => {
			await protocolFailure(
				[added(), delta(PREFIX)],
				completed({ output: [identity(INDEX, { arguments: RAW })] }),
			);
		});
		it("a terminal output array alone cannot create executable tool calls", async () => {
			await protocolFailure([], completed({ output: [identity(INDEX, { arguments: RAW })] }));
		});
		it.each(["", " \t\n"])(
			"an explicit blank terminal argument snapshot %j rejects a closed call",
			async (argumentsValue) => {
				await protocolFailure(
					fromSource("delta", RAW, 0),
					completed({ output: [identity(0, { arguments: argumentsValue })] }),
				);
			},
		);
		it("closed calls still require a terminal response event", async () => {
			await protocolFailure(fromSource("delta", RAW), null);
		});
	});

	describe("incomplete and abort protections", () => {
		it.each([
			{ event: "response.incomplete", status: "incomplete" },
			{ event: "response.completed", status: "incomplete" },
			{ event: "response.incomplete", status: "completed" },
		])(
			"$event with status $status preserves partial calls, max_tokens and usage",
			async ({ event, status }) => {
				const events = await run([added(), delta(PREFIX)], incomplete(event, status));
				expect(message(events)).toMatchObject({
					stopReason: "max_tokens",
					usage: NORMALIZED_USAGE,
					blocks: [toolBlock(INDEX, { _parseError: expect.any(String) })],
				});
			},
		);
		it("an incomplete call with no argument data remains a non-executable partial block", async () => {
			const events = await run([added()], incomplete());
			expect(message(events)).toMatchObject({
				stopReason: "max_tokens",
				usage: NORMALIZED_USAGE,
				blocks: [toolBlock(INDEX, {})],
			});
		});
		it.each([
			{ name: "unknown argument target", events: [added(), delta(RAW, 99), done(INDEX, { arguments: RAW })] },
			{ name: "identity mismatch", events: [added(), delta(RAW), done(INDEX, { call_id: "wrong" })] },
			{
				name: "inconsistent index and item ID",
				events: [
					added(),
					added(11),
					delta(RAW, INDEX, { item_id: "item_11" }),
					done(INDEX, { arguments: RAW }),
					done(11, { arguments: RAW }),
				],
			},
		])("incomplete does not excuse $name", async ({ events }) => {
			await protocolFailure(events, incomplete());
		});

		it("aborting a partial tool stream is silent and emits no message_end", async () => {
			enqueue([added(), delta(PREFIX)], true);
			const controller = new AbortController();
			const observed: LLMEvent[] = [];
			try {
				for await (const event of provider().stream(request({ signal: controller.signal }))) {
					observed.push(event);
					if (event.type === "tool_call_delta") controller.abort();
				}
			} finally {
				controller.abort();
			}
			expect(observed.map((event) => event.type)).toEqual(["tool_call_start", "tool_call_delta"]);
			expect(observed.some((event) => event.type === "message_end")).toBe(false);
		});
		it.each(
			(["added", "done"] as const).flatMap((kind) =>
				[RAW, { path: "must-not-parse-after-abort" }].map((argumentsValue) => ({
					kind,
					argumentsValue,
				})),
			),
		)(
			"abort at $kind tool_call_start ignores the deferred $argumentsValue snapshot",
			async ({ kind, argumentsValue }) => {
				enqueue([itemEvent(kind, INDEX, identity(INDEX, { arguments: argumentsValue }))], true);
				const controller = new AbortController();
				const observed: LLMEvent[] = [];
				try {
					for await (const event of provider().stream(request({ signal: controller.signal }))) {
						observed.push(event);
						if (event.type === "tool_call_start") controller.abort();
					}
				} finally {
					controller.abort();
				}
				expect(observed).toEqual([{ type: "tool_call_start", id: `call_${INDEX}`, name: "read" }]);
			},
		);

		it("a pre-aborted tool request does not consult auth or connect", async () => {
			let authCalls = 0;
			const local = createCodexResponsesProvider({
				baseUrl,
				auth: async () => {
					authCalls++;
					return { accessToken: "fake" };
				},
			});
			const controller = new AbortController();
			controller.abort();
			expect(await collect(local.stream(request({ signal: controller.signal })))).toEqual([]);
			expect(authCalls).toBe(0);
			expect(captured).toHaveLength(0);
		});
	});

	describe("real agent-loop integration", () => {
		it.each(
			terminalOutputs.flatMap((terminal) =>
				[
					{ name: "unfinalized tool", invalid: [added(1), delta(RAW, 1)] },
					{ name: "arguments.done only", invalid: [added(1), argsDone(RAW, 1)] },
					{ name: "missing arguments", invalid: [added(1), done(1)] },
					{
						name: "malformed arguments",
						invalid: [added(1), delta("PRIVATE_ARG_SECRET:not-json", 1), done(1)],
					},
					{
						name: "in_progress tool",
						invalid: [added(1), delta(RAW, 1), done(1, { status: "in_progress" })],
					},
					{ name: "incomplete tool", invalid: [added(1), delta(RAW, 1), done(1, { status: "incomplete" })] },
					...(["text", "refusal", "reasoning"] as const).flatMap((kind) => {
						const item =
							kind === "reasoning"
								? {
										type: "reasoning",
										id: "peer",
										summary: [{ type: "summary_text", text: "partial reasoning" }],
									}
								: {
										type: "message",
										id: "peer",
										content: [
											kind === "text"
												? { type: "output_text", text: "partial text" }
												: { type: "refusal", refusal: "partial refusal" },
										],
									};
						return [
							{ name: `unfinalized ${kind}`, invalid: [itemEvent("added", 1, item)] },
							...(["in_progress", "incomplete"] as const).map((status) => ({
								name: `${status} ${kind}`,
								invalid: [
									itemEvent("added", 1, item),
									itemEvent("done", 1, {
										...item,
										status,
										...(kind === "reasoning" && { encrypted_content: "UNFINISHED_CIPHER" }),
									}),
								],
							})),
						];
					}),
				].map((fixture) => ({ ...terminal, ...fixture })),
			),
		)(
			"$aggregate terminal output with $name refuses even an earlier valid call",
			async ({ invalid, output }) => {
				const seen: Executed[] = [];
				const events: AgentEvent[] = [];
				const history: AgentMessage[] = [];
				enqueue([...fromSource("delta", RAW, 0), ...invalid, completed({ output })]);
				enqueue(textTurn()); // A broken adapter must not pass by exhausting the fixture queue.
				await expect
					.soft(
						runAgentLoop(
							loopOptions(
								[recordingTool("read", Type.Object({ path: Type.Optional(Type.String()) }), seen)],
								history,
								events,
							),
						),
					)
					.rejects.toBeInstanceOf(CodexResponseError);
				expect.soft(seen).toEqual([]);
				expect
					.soft(events.filter((event) => event.type === "message_end" || event.type === "tool_start"))
					.toEqual([]);
				expect.soft(history.map((entry) => entry.role)).toEqual(["user"]);
				expect.soft(captured).toHaveLength(1);
			},
		);

		it("empty output in a nonempty aggregate still cannot omit a finalized peer", async () => {
			const seen: Executed[] = [];
			const events: AgentEvent[] = [];
			enqueue([
				...fromSource("delta", RAW, 0),
				...fromSource("delta", RAW, 1),
				completed({ output: [identity(0, { arguments: RAW })] }),
			]);
			await expect(
				runAgentLoop(
					loopOptions([recordingTool("read", Type.Object({ path: Type.String() }), seen)], [], events),
				),
			).rejects.toThrow("final output omitted a streamed item");
			expect(seen).toEqual([]);
			expect(events.some((event) => event.type === "message_end")).toBe(false);
			expect(captured).toHaveLength(1);
		});

		it.each(
			terminalOutputs.flatMap((terminal) =>
				["response.incomplete", "response.completed"].map((type) => ({ ...terminal, type })),
			),
		)(
			"$aggregate output on $type with max_output_tokens refuses the entire tool batch",
			async ({ type, output }) => {
				const seen: Executed[] = [];
				const events: AgentEvent[] = [];
				const history: AgentMessage[] = [];
				enqueue([
					...fromSource("delta", RAW, 0),
					added(1),
					delta(PREFIX, 1),
					wire(type, {
						response: {
							status: "incomplete",
							incomplete_details: { reason: "max_output_tokens" },
							output,
						},
					}),
				]);
				enqueue(textTurn());
				await expect(
					runAgentLoop(
						loopOptions([recordingTool("read", Type.Object({ path: Type.String() }), seen)], history, events),
					),
				).resolves.toMatchObject({ stopReason: "completed", turns: 2 });
				expect(seen).toEqual([]);
				expect(history[1]).toMatchObject({ role: "assistant", stopReason: "max_tokens" });
				expect(history[2]).toMatchObject({
					role: "toolResult",
					results: [
						{ toolCallId: "call_0", isError: true },
						{ toolCallId: "call_1", isError: true },
					],
				});
				expect(events.some((event) => event.type === "tool_running")).toBe(false);
				expect(captured).toHaveLength(2);
			},
		);

		it.each(["initial", "delta", "arguments-done", "final-item", "done-only"] as const)(
			"%s arguments satisfy required path/pattern schemas, execute and replay intact",
			async (source) => {
				const seen: Executed[] = [];
				const history: AgentMessage[] = [];
				const events: AgentEvent[] = [];
				const search = { pattern: "TODO|λ|🦊", path: "src/世界" };
				const tools = [
					recordingTool("read", Type.Object({ path: Type.String() }), seen),
					recordingTool("grep", Type.Object({ pattern: Type.String(), path: Type.String() }), seen),
				];
				enqueue([
					...fromSource(source, RAW, 3),
					...fromSource(source, JSON.stringify(search), 9, { name: "grep" }),
					completed(),
				]);
				enqueue(textTurn());
				const result = await runAgentLoop(loopOptions(tools, history, events));
				expect(result).toMatchObject({ stopReason: "completed", turns: 2 });
				expect(seen).toEqual([
					{ id: "call_3", name: "read", args: ARGS },
					{ id: "call_9", name: "grep", args: search },
				]);
				expect(history[1]).toMatchObject({
					role: "assistant",
					blocks: [toolBlock(3, ARGS), toolBlock(9, search, "grep")],
				});
				expect(history[2]).toMatchObject({
					role: "toolResult",
					results: [
						{ toolCallId: "call_3", toolName: "read", content: `read:${RAW}`, isError: false },
						{
							toolCallId: "call_9",
							toolName: "grep",
							content: `grep:${JSON.stringify(search)}`,
							isError: false,
						},
					],
				});
				expect(captured).toHaveLength(2);
				const declaration = (captured[0]!.input as Fields[])[0]!;
				expect(declaration).toMatchObject({ type: "additional_tools", role: "developer" });
				expect((declaration.tools as Fields[]).map((tool) => (tool.parameters as Fields).required)).toEqual([
					["path"],
					["pattern", "path"],
				]);
				const replay = (captured[1]!.input as Fields[])
					.filter((item) => item.type !== "additional_tools")
					.map(({ id: _id, ...item }) => item);
				expect(replay).toEqual([
					{ role: "user", content: [{ type: "input_text", text: "inspect the files" }] },
					{ type: "function_call", call_id: "call_3", name: "read", arguments: RAW },
					{ type: "function_call", call_id: "call_9", name: "grep", arguments: JSON.stringify(search) },
					{ type: "function_call_output", call_id: "call_3", output: `read:${RAW}` },
					{ type: "function_call_output", call_id: "call_9", output: `grep:${JSON.stringify(search)}` },
				]);
			},
		);

		it("a lower-index done-only call discovered last executes serially first and replays first", async () => {
			const seen: Executed[] = [];
			const order: string[] = [];
			const low = { path: "first/雪" };
			const history: AgentMessage[] = [];
			enqueue([
				added(11),
				delta(RAW, 11),
				done(11),
				done(2, identity(2, { arguments: JSON.stringify(low) })),
				completed(),
			]);
			enqueue(textTurn());
			await runAgentLoop(
				loopOptions([recordingTool("read", Type.Object({ path: Type.String() }), seen, order)], history, []),
			);
			expect(order).toEqual(["start:call_2", "end:call_2", "start:call_11", "end:call_11"]);
			expect(seen.map((call) => call.args)).toEqual([low, ARGS]);
			expect(
				((captured[1]?.input ?? []) as Fields[])
					.filter((item) => item.type === "function_call")
					.map((item) => item.call_id),
			).toEqual(["call_2", "call_11"]);
		});

		it.each([
			{
				name: "malformed JSON",
				events: [added(5, { name: "probe" }), delta("PRIVATE_ARG_SECRET:not-json", 5), done(5)],
			},
			{ name: "unfinished valid JSON", events: [added(5, { name: "probe" }), delta(RAW, 5)] },
			{
				name: "arguments-done without item finalization",
				events: [added(5, { name: "probe" }), argsDone(RAW, 5)],
			},
			{ name: "missing argument data", events: [added(5, { name: "probe" }), done(5)] },
		])(
			"a completed batch containing $name rejects before dispatching even an earlier valid peer",
			async ({ events: invalid }) => {
				const seen: Executed[] = [];
				const history: AgentMessage[] = [];
				const events: AgentEvent[] = [];
				const gates: unknown[] = [];
				// This schema deliberately allows the old _parseError object. Only the
				// provider's completed-response validation can prevent that execution.
				const tool = recordingTool("probe", Type.Object({ path: Type.Optional(Type.String()) }), seen);
				enqueue([...fromSource("delta", RAW, 1, { name: "probe" }), ...invalid, completed()]);
				enqueue(textTurn());
				await expect
					.soft(
						runAgentLoop(
							loopOptions([tool], history, events, {
								onToolCall: (call: unknown) => {
									gates.push(call);
								},
							}),
						),
					)
					.rejects.toThrow();
				expect.soft(seen).toEqual([]);
				expect.soft(gates).toEqual([]);
				expect.soft(events.filter((event) => event.type === "message_end")).toHaveLength(0);
				expect.soft(history.map((entry) => entry.role)).toEqual(["user"]);
				expect(captured).toHaveLength(1);
			},
		);

		it.each(["", " \t\n"])(
			"an explicit blank terminal argument snapshot %j prevents execution of the entire batch",
			async (argumentsValue) => {
				const seen: Executed[] = [];
				const history: AgentMessage[] = [];
				const events: AgentEvent[] = [];
				const gates: unknown[] = [];
				enqueue([
					...fromSource("delta", RAW, 0),
					...fromSource("delta", RAW, 1),
					completed({
						output: [identity(0, { arguments: RAW }), identity(1, { arguments: argumentsValue })],
					}),
				]);
				enqueue(textTurn());
				await expect(
					runAgentLoop(
						loopOptions(
							[recordingTool("read", Type.Object({ path: Type.String() }), seen)],
							history,
							events,
							{
								onToolCall: (call: unknown) => {
									gates.push(call);
								},
							},
						),
					),
				).rejects.toThrow("invalid final function arguments");
				expect(seen).toEqual([]);
				expect(gates).toEqual([]);
				expect(events.filter((event) => event.type === "message_end")).toEqual([]);
				expect(history.map((entry) => entry.role)).toEqual(["user"]);
				expect(captured).toHaveLength(1);
			},
		);
		it.each(["response.incomplete", "response.completed"])(
			"%s/incomplete refuses the entire mixed closed/unclosed batch and replays errors",
			async (terminalEvent) => {
				const seen: Executed[] = [];
				const gates: unknown[] = [];
				const history: AgentMessage[] = [];
				const events: AgentEvent[] = [];
				const tool = recordingTool("probe", Type.Object({ path: Type.Optional(Type.String()) }), seen);
				enqueue([
					...fromSource("delta", RAW, 1, { name: "probe" }),
					added(5, { name: "probe" }),
					delta(PREFIX, 5),
					incomplete(terminalEvent),
				]);
				enqueue(textTurn());
				const result = await runAgentLoop(
					loopOptions([tool], history, events, {
						onToolCall: (call: unknown) => {
							gates.push(call);
						},
					}),
				);
				expect(result).toMatchObject({ stopReason: "completed", turns: 2 });
				expect(seen).toEqual([]);
				expect(gates).toEqual([]);
				expect(events.filter((event) => event.type === "tool_running")).toEqual([]);
				expect(history[1]).toMatchObject({
					role: "assistant",
					stopReason: "max_tokens",
					usage: NORMALIZED_USAGE,
				});
				const resultMessage = history[2];
				if (resultMessage?.role !== "toolResult") throw new Error("Missing refusal results");
				expect(
					resultMessage.results.map((entry) => ({ id: entry.toolCallId, isError: entry.isError })),
				).toEqual([
					{ id: "call_1", isError: true },
					{ id: "call_5", isError: true },
				]);
				expect(
					((captured[1]?.input ?? []) as Fields[]).filter((item) => item.type === "function_call_output"),
				).toEqual(
					resultMessage.results.map((entry) => ({
						type: "function_call_output",
						call_id: entry.toolCallId,
						output: entry.content,
					})),
				);
			},
		);

		it("abort during the second tool stream never dispatches the already closed first call", async () => {
			const seen: Executed[] = [];
			const gates: unknown[] = [];
			const history: AgentMessage[] = [];
			const events: AgentEvent[] = [];
			const controller = new AbortController();
			enqueue([...fromSource("delta", RAW, 1), added(5), delta(PREFIX, 5)], true);
			try {
				const result = await runAgentLoop(
					loopOptions([recordingTool("read", Type.Object({ path: Type.String() }), seen)], history, events, {
						signal: controller.signal,
						onToolCall: (call: unknown) => {
							gates.push(call);
						},
						onEvent: (event: AgentEvent) => {
							events.push(event);
							if (event.type === "tool_call_delta" && event.id === "call_5") controller.abort();
						},
					}),
				);
				expect(result).toMatchObject({ stopReason: "aborted", turns: 0 });
			} finally {
				controller.abort();
			}
			expect(seen).toEqual([]);
			expect(gates).toEqual([]);
			expect(history.map((entry) => entry.role)).toEqual(["user"]);
			expect(events.some((event) => event.type === "message_end")).toBe(false);
			expect(captured).toHaveLength(1);
		});

		it.each(
			(["added", "done"] as const).flatMap((kind) =>
				[RAW, { path: "must-not-parse-after-abort" }].map((argumentsValue) => ({
					kind,
					argumentsValue,
				})),
			),
		)(
			"abort at $kind tool_call_start returns aborted before inspecting $argumentsValue",
			async ({ kind, argumentsValue }) => {
				const seen: Executed[] = [];
				const history: AgentMessage[] = [];
				const events: AgentEvent[] = [];
				const controller = new AbortController();
				enqueue([itemEvent(kind, INDEX, identity(INDEX, { arguments: argumentsValue }))], true);
				try {
					const result = await runAgentLoop(
						loopOptions(
							[recordingTool("read", Type.Object({ path: Type.String() }), seen)],
							history,
							events,
							{
								signal: controller.signal,
								onEvent: (event: AgentEvent) => {
									events.push(event);
									if (event.type === "tool_call_start") controller.abort();
								},
							},
						),
					);
					expect(result).toMatchObject({ stopReason: "aborted", turns: 0 });
				} finally {
					controller.abort();
				}
				expect(events.filter((event) => event.type === "tool_call_start")).toHaveLength(1);
				expect(events.some((event) => event.type === "tool_call_delta" || event.type === "message_end")).toBe(
					false,
				);
				expect(seen).toEqual([]);
				expect(history.map((entry) => entry.role)).toEqual(["user"]);
			},
		);

		it.each(jsonValues.filter((value) => value.label !== "explicit empty object"))(
			"valid JSON $label reaches loop validation but is never executed as object arguments",
			async ({ raw, value }) => {
				const seen: Executed[] = [];
				const history: AgentMessage[] = [];
				enqueue([...fromSource("delta", raw), completed()]);
				enqueue(textTurn());
				await runAgentLoop(
					loopOptions([recordingTool("read", Type.Object({ path: Type.String() }), seen)], history, []),
				);
				expect(seen).toEqual([]);
				expect(history[1]).toMatchObject({ role: "assistant", blocks: [toolBlock(INDEX, value)] });
				expect(history[2]).toMatchObject({
					role: "toolResult",
					results: [{ toolCallId: `call_${INDEX}`, isError: true }],
				});
			},
		);
		it.each([true, false])(
			"explicit {} is not fabricated into required fields (required path: %s)",
			async (required) => {
				const seen: Executed[] = [];
				const history: AgentMessage[] = [];
				const parameters = required
					? Type.Object({ path: Type.String() })
					: Type.Object({ path: Type.Optional(Type.String()) });
				enqueue([...fromSource("delta", "{}"), completed()]);
				enqueue(textTurn());
				await runAgentLoop(loopOptions([recordingTool("read", parameters, seen)], history, []));
				expect(seen).toEqual(required ? [] : [{ id: `call_${INDEX}`, name: "read", args: {} }]);
				expect(history[1]).toMatchObject({ role: "assistant", blocks: [toolBlock(INDEX, {})] });
				expect(history[2]).toMatchObject({
					role: "toolResult",
					results: [{ toolCallId: `call_${INDEX}`, isError: required }],
				});
				expect(
					((captured[1]?.input ?? []) as Fields[]).find((item) => item.type === "function_call")?.arguments,
				).toBe("{}");
			},
		);
	});
});
