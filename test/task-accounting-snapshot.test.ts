import path from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { estimateTokens } from "../src/core/compaction.js";
import { ABORT_GRACE_MS } from "../src/core/constants.js";
import { type AgentEvent, runAgentLoop } from "../src/core/loop.js";
import type { AgentMessage, AssistantMessage, ToolResult, Usage } from "../src/core/messages.js";
import { pricingSlice } from "../src/core/service-tier-pricing.js";
import { type SessionEntry, SessionStore } from "../src/core/session/store.js";
import {
	buildTaskRecord,
	collectTaskRecords,
	parseTaskRecord,
	snapshotTaskRecord,
	type TaskRecord,
} from "../src/core/task-record.js";
import type { Tool, ToolExecuteResult } from "../src/core/tools/types.js";
import { priceUsageTotals, usageTotalsTracker } from "../src/core/usage-totals.js";
import type { LLMProvider } from "../src/provider/types.js";
import { createRunner } from "../src/runner.js";
import { assistant, gate, makeRenderer, scriptedProvider, waitUntil } from "./helpers/fakes.js";
import { mkTempDir } from "./helpers/mktemp.js";

const REF = "openai-codex/gpt-5.5";
const ALL: Usage = {
	inputTokens: 1_000_000,
	outputTokens: 2_000_000,
	cacheReadTokens: 3_000_000,
	cacheWriteTokens: 4_000_000,
};
const FAST = { requested: "priority", reported: "priority" } as const;
const RATES = { input: 1, output: 3, cacheRead: 5, cacheWrite: 7 };
const ZERO = { inputTokens: 0, outputTokens: 0 };
const PATHS = ["serial", "serial-display", "concurrent-end", "concurrent-settled"] as const;
type ResultPath = (typeof PATHS)[number];

function record(missing = false, id = "a"): TaskRecord {
	return {
		...buildTaskRecord({
			attemptId: id,
			sourceId: `source-${id}`,
			taskToolCallId: id,
			parentSessionId: "parent",
			childId: `child-${id}`,
			launched: true,
			cwd: "/work",
			status: "completed",
			turns: 2,
			textPresent: true,
			binding: { providerName: "openai-codex", wireModelId: "gpt-5.5", reference: REF },
			tools: ["read"],
			transcript: { present: true, path: "/child.jsonl" },
			worktree: { path: "/wt", branch: "child", disposition: "kept-work", detail: "original" },
			health: [{ code: "repeat-loop", count: 5, turn: 2, detail: "original" }],
			usage: { ...ALL, ...(missing ? { incomplete: true } : {}) },
			usagePricing: [pricingSlice(ALL, FAST)],
		}),
		timestamp: "2026-01-01T00:00:00.000Z",
	};
}

function calls(names = ["task"], stop: "tool_use" | "max_tokens" = "tool_use") {
	return assistant(
		names.map((name, index) => ({
			type: "toolCall" as const,
			id: String.fromCharCode(97 + index),
			name,
			arguments: {},
		})),
		stop,
		ZERO,
	);
}
const done = () => assistant([{ type: "text", text: "done" }], "end_turn", ZERO);
function results(history: readonly AgentMessage[]): ToolResult[] {
	return history.flatMap((m) => (m.role === "toolResult" ? m.results : []));
}
function entries(history: readonly AgentMessage[]): SessionEntry[] {
	return history.map((message, i) => ({
		type: "message",
		id: `e${i}`,
		parentId: null,
		timestamp: "old",
		message,
	}));
}
function historyTokens(history: readonly AgentMessage[]): number {
	return history.reduce((total, message) => total + estimateTokens(message), 0);
}
function storeFixture() {
	const dir = mkTempDir("ink-pricing-e2e-");
	return SessionStore.create(path.join(dir, "parent.jsonl"), dir, "parent");
}
function eventType(p: ResultPath) {
	return p === "concurrent-settled" ? "tool_settled" : "tool_end";
}
function tool(p: ResultPath, source: ToolExecuteResult, name = "task"): Tool {
	return {
		name,
		description: "accounting fixture",
		parameters: Type.Object({}),
		concurrencySafe: p.startsWith("concurrent"),
		async execute() {
			return source;
		},
	};
}
async function run(
	p: ResultPath,
	source: ToolExecuteResult,
	onEvent: (event: AgentEvent) => void,
	name = "task",
) {
	const store = storeFixture();
	const history: AgentMessage[] = [];
	await runAgentLoop({
		provider: scriptedProvider([calls([name]), done()]),
		model: "gpt-5.5",
		modelReference: REF,
		system: "",
		history,
		tools: [tool(p, source, name)],
		onEvent,
		onMessage: (m) => {
			store.appendMessage(m);
		},
	});
	return { store, history };
}
function damage(r: TaskRecord) {
	r.usage!.inputTokens = 7;
	r.usage!.outputTokens = 8;
	r.usage!.cacheReadTokens = 9;
	r.usage!.cacheWriteTokens = 10;
	if (r.usage!.incomplete) delete r.usage!.incomplete;
	else r.usage!.incomplete = true;
	r.usagePricing![0]!.usage = { ...r.usage! };
	r.usagePricing![0]!.serviceTier!.reported = "flex";
	r.attemptId = "forged";
	r.sourceId = "forged";
	r.childId = "forged";
	r.parentSessionId = "forged";
	r.taskToolCallId = "forged";
	Object.assign(r.binding!, { providerName: "openai", wireModelId: "other", reference: "openai/other" });
	r.tools!.push("bash");
	r.transcript = { present: false, why: "disabled" };
	r.worktree!.detail = "forged";
	r.health![0]!.detail = "forged";
	r.timestamp = "new";
}
function assertFacts(
	history: AgentMessage[],
	store: SessionStore,
	expected: TaskRecord[],
	cached = usageTotalsTracker(store.getEntries()),
) {
	expect(collectTaskRecords(entries(history))).toEqual(expected);
	const rebuilt = usageTotalsTracker(store.getEntries()).view();
	expect(cached.view()).toEqual(rebuilt);
	expect(usageTotalsTracker(SessionStore.open(store.filePath).getEntries()).view()).toEqual(rebuilt);
	for (const source of [store, SessionStore.open(store.filePath)]) {
		expect(collectTaskRecords(source.getEntries())).toEqual(expected);
		expect(historyTokens(source.buildContext().messages)).toBe(historyTokens(history));
	}
	const contributing = expected.filter((r) => r.launched && r.usage);
	expect(rebuilt.child.calls).toBe(contributing.length);
	expect(rebuilt.child.inputTokens).toBe(contributing.reduce((sum, r) => sum + r.usage!.inputTokens, 0));
	expect(rebuilt.child.outputTokens).toBe(contributing.reduce((sum, r) => sum + r.usage!.outputTokens, 0));
	expect(rebuilt.child.cacheReadTokens).toBe(
		contributing.reduce((sum, r) => sum + (r.usage!.cacheReadTokens ?? 0), 0),
	);
	expect(rebuilt.child.cacheWriteTokens).toBe(
		contributing.reduce((sum, r) => sum + (r.usage!.cacheWriteTokens ?? 0), 0),
	);
	return rebuilt;
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("TaskRecord snapshots before result observers", () => {
	for (const p of PATHS)
		for (const timing of ["immediate", "delayed"] as const)
			for (const mode of ["mutate", "replace", "delete", "replace-fields", "delete-fields"] as const) {
				it.each([false, true])(
					`${p} ${timing} ${mode} isolates usage/pricing/identity (missing=%s)`,
					async (missing) => {
						const original = record(missing);
						const expected = structuredClone(original);
						const source = {
							output: "original",
							taskRecord: original,
							...(p === "serial-display" ? { display: "display" } : {}),
						};
						let change: (() => void) | undefined;
						const { history, store } = await run(p, source, (e) => {
							if (e.type !== eventType(p) || !("result" in e)) return;
							const retained = e.result;
							const raw = retained.taskRecord!;
							change = () => {
								if (mode === "mutate") damage(raw);
								else if (mode === "delete") delete retained.taskRecord;
								else if (mode === "replace-fields") {
									Object.assign(raw, record(!missing, "replaced-fields"));
									damage(raw);
								} else if (mode === "delete-fields") {
									for (const key of [
										"usage",
										"usagePricing",
										"binding",
										"tools",
										"transcript",
										"worktree",
										"health",
										"attemptId",
										"sourceId",
										"parentSessionId",
										"childId",
										"taskToolCallId",
									])
										Reflect.deleteProperty(raw, key);
								} else {
									const replacement = record(!missing);
									damage(replacement);
									retained.taskRecord = replacement;
								}
							};
							if (timing === "immediate") change();
						});
						const cached = usageTotalsTracker(store.getEntries());
						cached.view();
						const tokens = historyTokens(history);
						expect(tokens).toBeGreaterThan(0);
						if (timing === "delayed") {
							await Promise.resolve();
							change!();
						}
						const totals = assertFacts(history, store, [expected], cached);
						expect(totals.incomplete).toEqual({ parent: false, child: missing, summarizer: false });
						expect(priceUsageTotals(totals, (ref) => (ref === REF ? RATES : undefined)).usd).toBe(125);
						expect(historyTokens(history)).toBe(tokens);
						expect(results(history)[0]!.taskRecord).not.toBe(original);
						expect(Object.hasOwn(source, "durationMs")).toBe(false);
					},
				);
			}

	it.each(["tool_end", "tool_settled"] as const)(
		"%s preserves the exact $2.50 priority report when changed to flex",
		async (event) => {
			const original = record();
			original.usage = { inputTokens: 1_000_000, outputTokens: 0 };
			original.usagePricing = [pricingSlice(original.usage, FAST)];
			const expected = structuredClone(original);
			const { history, store } = await run(
				event === "tool_end" ? "serial" : "concurrent-settled",
				{ output: "ok", taskRecord: original },
				(e) => {
					if (e.type === event) e.result.taskRecord!.usagePricing![0]!.serviceTier!.reported = "flex";
				},
			);
			expect(priceUsageTotals(assertFacts(history, store, [expected]), () => RATES).usd).toBe(2.5);
		},
	);

	it("captures before out-of-order settlement and delayed mutation while waiting for prefix flush", async () => {
		const slow = gate();
		const fast = gate();
		const history: AgentMessage[] = [];
		const events: AgentEvent[] = [];
		const originals = [record(false, "a"), record(true, "b")];
		const expected = structuredClone(originals);
		const store = storeFixture();
		const tools = [slow, fast].map(
			(g, i): Tool => ({
				...tool("concurrent-settled", { output: "unused" }, i === 0 ? "slow" : "task"),
				async execute() {
					await g.promise;
					return { output: "original", taskRecord: originals[i] };
				},
			}),
		);
		const pending = runAgentLoop({
			provider: scriptedProvider([calls(["slow", "task"]), done()]),
			model: "m",
			system: "",
			tools,
			history,
			onMessage: (m) => {
				store.appendMessage(m);
			},
			onEvent: (e) => {
				events.push(e);
				if (e.type === "tool_settled" && e.result.toolCallId === "b") {
					e.result.taskRecord!.usagePricing![0]!.serviceTier!.reported = "flex";
					e.result.content = "immediate";
					e.result.isError = true;
				}
				if (e.type === "tool_end") e.result.content = "too late";
			},
		});
		fast.resolve();
		await waitUntil(() => events.some((e) => e.type === "tool_settled" && e.result.toolCallId === "b"));
		expect(events.filter((e) => e.type === "tool_end")).toHaveLength(0);
		const e = events.find((e) => e.type === "tool_settled")!;
		if (e.type !== "tool_settled") throw new Error("missing settled");
		damage(originals[1]!);
		delete e.result.taskRecord;
		e.result.taskRecord = record();
		e.result.content = "delayed before flush";
		e.result.isError = false;
		slow.resolve();
		await pending;
		expect(events.flatMap((e) => (e.type === "tool_end" ? [e.result.toolCallId] : []))).toEqual(["a", "b"]);
		const totals = assertFacts(history, store, expected);
		expect(totals.incomplete.child).toBe(true);
		expect(priceUsageTotals(totals, () => RATES).usd).toBe(250);
		expect(results(history)[1]).toMatchObject({ content: "delayed before flush", isError: false });
	});
});

describe("non-accounting content/status behavior is unchanged", () => {
	it.each(PATHS)("%s preserves its immediate and delayed top-level behavior", async (p) => {
		let retained: ToolResult | undefined;
		const { history, store } = await run(
			p,
			{ output: "original", taskRecord: record(), ...(p === "serial-display" ? { display: "ui" } : {}) },
			(e) => {
				if (e.type !== eventType(p) || !("result" in e)) return;
				retained = e.result;
				retained.content = "immediate";
				retained.isError = true;
			},
		);
		const visible = p === "serial" || p === "concurrent-settled";
		expect(results(history)[0]).toMatchObject({
			content: visible ? "immediate" : "original",
			isError: visible,
		});
		retained!.content = "delayed";
		retained!.isError = false;
		const lateVisible = p === "serial";
		expect(results(history)[0]).toMatchObject({
			content: lateVisible ? "delayed" : visible ? "immediate" : "original",
			isError: visible && !lateVisible,
		});
		const stored = store.getEntries().flatMap((e) => (e.type === "message" ? results([e.message]) : []))[0]!;
		expect(stored.content).toBe(results(history)[0]!.content);
		expect(stored.isError).toBe(results(history)[0]!.isError);
		expect(Object.getPrototypeOf(stored)).toBe(Object.prototype);
		expect(Object.keys(stored)).toContain("content");
		expect(Object.keys(stored)).toContain("isError");
		expect(JSON.parse(JSON.stringify(stored))).toMatchObject({
			content: stored.content,
			isError: stored.isError,
		});
		expect(results(history)[0]!.display).toBeUndefined();
		expect(results(history)[0]!.durationMs).toBeUndefined();
	});
	it.each(PATHS)("%s still shares content blocks", async (p) => {
		const blocks = [{ type: "text" as const, text: "original" }];
		const { history, store } = await run(
			p,
			{
				output: "",
				content: blocks,
				taskRecord: record(),
				...(p === "serial-display" ? { display: "ui" } : {}),
			},
			() => {},
		);
		blocks[0]!.text = "shared";
		expect(results(history)[0]!.content).toBe(blocks);
		expect(results(store.buildContext().messages)[0]!.content).toBe(blocks);
	});
});

describe("unknown and legacy accounting", () => {
	const cases = [
		"absent",
		"invalid",
		"future",
		"legacy",
		"malformed-pricing",
		"rejected",
		"launched-missing",
		"non-task",
		"non-task-absent",
	] as const;
	for (const p of ["serial", "concurrent-settled"] as const)
		it.each(cases)(`${p} %s cannot be forged or restamped`, async (kind) => {
			const raw = record();
			if (kind === "future") Reflect.set(raw, "version", 2);
			if (kind === "invalid") Reflect.set(raw, "usage", { inputTokens: "bad", outputTokens: 0 });
			if (kind === "legacy") delete raw.usagePricing;
			if (kind === "malformed-pricing")
				Reflect.set(raw, "usagePricing", [
					{ usage: ALL, serviceTier: { requested: "priority", reported: 42 } },
				]);
			if (kind === "rejected") {
				raw.launched = false;
				raw.status = "rejected";
				raw.turns = 0;
				delete raw.usage;
				delete raw.usagePricing;
			}
			if (kind === "launched-missing") {
				delete raw.usage;
				delete raw.usagePricing;
			}
			const absent = kind === "absent" || kind === "non-task-absent";
			const valid = !absent && kind !== "future" && kind !== "invalid";
			const expected = valid ? [parseTaskRecord(raw)!] : [];
			const { history, store } = await run(
				p,
				{ output: "valid output", ...(absent ? {} : { taskRecord: raw }) },
				(e) => {
					if (e.type === eventType(p) && "result" in e) e.result.taskRecord = record();
				},
				kind.startsWith("non-task") ? "custom" : "task",
			);
			const totals = assertFacts(history, store, expected);
			expect(totals.incomplete.child).toBe(
				(!valid && !kind.startsWith("non-task")) || kind === "launched-missing",
			);
			if (kind === "legacy" || kind === "malformed-pricing") {
				const priced = priceUsageTotals(totals, () => RATES);
				expect(priced.usd).toBe(50);
				expect(priced.pricingIncomplete).toBe(true);
			}
		});

	it.each(["validation", "gate", "truncation", "throw", "unknown"] as const)(
		"%s captures absent metadata before tool_end",
		async (kind) => {
			const history: AgentMessage[] = [];
			const store = storeFixture();
			const t = tool("serial", { output: "ok" });
			if (kind === "validation") t.parameters = Type.Object({ required: Type.String() });
			if (kind === "throw")
				t.execute = async () => {
					throw new Error("fixture failure");
				};
			await runAgentLoop({
				provider: scriptedProvider([
					calls(["task"], kind === "truncation" ? "max_tokens" : "tool_use"),
					done(),
				]),
				model: "m",
				system: "",
				tools: kind === "unknown" ? [] : [t],
				history,
				onToolCall: () => (kind === "gate" ? { block: true } : undefined),
				onMessage: (m) => {
					store.appendMessage(m);
				},
				onEvent: (e) => {
					if (e.type === "tool_end") e.result.taskRecord = record();
				},
			});
			expect(assertFacts(history, store, []).incomplete.child).toBe(true);
		},
	);

	it.each(["serial", "concurrent-settled"] as const)(
		"%s grace abandonment rejects forged and late records",
		async (p) => {
			vi.useFakeTimers();
			const late = gate();
			const controller = new AbortController();
			const history: AgentMessage[] = [];
			const store = storeFixture();
			const events: AgentEvent[] = [];
			vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			const t = tool(p, { output: "unused" });
			t.execute = async () => {
				await late.promise;
				return { output: "late", taskRecord: record() };
			};
			const pending = runAgentLoop({
				provider: scriptedProvider([calls(), done()]),
				model: "m",
				system: "",
				tools: [t],
				history,
				signal: controller.signal,
				onMessage: (m) => {
					store.appendMessage(m);
				},
				onEvent: (e) => {
					events.push(e);
					if (e.type === "tool_settled" || e.type === "tool_end") e.result.taskRecord = record();
				},
			});
			await vi.advanceTimersByTimeAsync(0);
			controller.abort();
			await vi.advanceTimersByTimeAsync(ABORT_GRACE_MS + 1);
			expect((await pending).stopReason).toBe("aborted");
			const totals = assertFacts(history, store, []);
			expect(totals.incomplete.child).toBe(true);
			late.resolve();
			await vi.advanceTimersByTimeAsync(0);
			expect(assertFacts(history, store, [])).toEqual(totals);
			expect(events.filter((e) => e.type === "tool_end")).toHaveLength(1);
			expect(results(history)[0]!.content).toContain("did not respond to the interrupt");
		},
	);
});

describe("TaskRecord snapshot validation", () => {
	it("reuses parser copies without restamping, rebounding, freezing or dropping extra v1 fields", () => {
		const raw = { ...record(true), reason: "x".repeat(500), extraV1: "preserved" };
		raw.worktree!.detail = "y".repeat(500);
		const expected = structuredClone(raw);
		const copy = snapshotTaskRecord(raw)!;
		expect(copy).toEqual(expected);
		for (const key of [
			"binding",
			"tools",
			"transcript",
			"worktree",
			"health",
			"usage",
			"usagePricing",
		] as const)
			expect(copy[key]).not.toBe(raw[key]);
		expect(copy.health![0]).not.toBe(raw.health![0]);
		expect(copy.usagePricing![0]!.usage).not.toBe(raw.usagePricing![0]!.usage);
		expect(copy.usagePricing![0]!.serviceTier).not.toBe(raw.usagePricing![0]!.serviceTier);
		if (raw.transcript?.present) raw.transcript.path = "mutated";
		damage(raw);
		expect(copy).toEqual(expected);
	});
});

describe("SessionStore owns TaskRecord metadata only", () => {
	it.each(["message", "retained-tail"] as const)(
		"%s detaches records while forwarding enumerable content/status",
		(boundary) => {
			const store = storeFixture();
			const original = record(true);
			const expected = structuredClone(original);
			const source: AgentMessage = {
				role: "toolResult",
				results: [
					{ toolCallId: "a", toolName: "task", content: "original", isError: false, taskRecord: original },
				],
			};
			const id =
				boundary === "message"
					? store.appendMessage(source)
					: store.appendCompaction("summary", [source], 100);
			const entry = store.getEntry(id)!;
			const stored =
				entry.type === "message"
					? entry.message
					: entry.type === "compaction"
						? entry.retainedTail[0]!
						: undefined;
			if (stored?.role !== "toolResult") throw new Error("missing result");
			expect(stored).not.toBe(source);
			expect(stored.results).not.toBe(source.results);
			expect(stored.results[0]!.taskRecord).not.toBe(original);
			damage(original);
			source.results[0]!.taskRecord = record();
			source.results[0]!.content = "delayed";
			source.results[0]!.isError = true;
			expect(stored.results[0]).toMatchObject({ content: "delayed", isError: true, taskRecord: expected });
			stored.results[0]!.content = "write through";
			stored.results[0]!.isError = false;
			expect(source.results[0]).toMatchObject({ content: "write through", isError: false });
			const reopened = SessionStore.open(store.filePath).getEntry(id)!;
			const read =
				reopened.type === "message"
					? reopened.message
					: reopened.type === "compaction"
						? reopened.retainedTail[0]!
						: undefined;
			if (read?.role !== "toolResult") throw new Error("missing read result");
			expect(read.results[0]!.taskRecord).toEqual(expected);
			expect(read.results[0]!.content).toBe("original");
			expect(JSON.parse(JSON.stringify(stored.results[0]))).toMatchObject({
				content: "write through",
				isError: false,
				taskRecord: expected,
			});
		},
	);

	it.each(["absent", "invalid", "future", "malformed-pricing"] as const)(
		"append/read/retained tail preserve %s accounting",
		(kind) => {
			const store = storeFixture();
			const raw = record();
			if (kind === "future") Reflect.set(raw, "version", 2);
			if (kind === "invalid")
				Reflect.set(raw, "binding", { providerName: "openai", wireModelId: "m", reference: REF });
			if (kind === "malformed-pricing")
				Reflect.set(raw, "usagePricing", [
					{ usage: ALL, serviceTier: { requested: "priority", reported: 42 } },
				]);
			const expected = kind === "malformed-pricing" ? [parseTaskRecord(raw)!] : [];
			const source: AgentMessage = {
				role: "toolResult",
				results: [
					{
						toolCallId: "a",
						toolName: "task",
						content: "ok",
						isError: false,
						...(kind === "absent" ? {} : { taskRecord: raw }),
					},
				],
			};
			store.appendMessage(source);
			store.appendCompaction("summary", [source], 100);
			const cached = usageTotalsTracker(store.getEntries());
			const initial = cached.view();
			source.results[0]!.taskRecord = record();
			for (const s of [store, SessionStore.open(store.filePath)]) {
				expect(collectTaskRecords(s.getEntries())).toEqual(expected);
				expect(results(s.buildContext().messages)[0]!.taskRecord).toEqual(expected[0]);
				expect(usageTotalsTracker(s.getEntries()).view()).toEqual(initial);
			}
			expect(cached.view()).toEqual(initial);
		},
	);

	it("compaction independently copies history records and preserves token estimates", async () => {
		const { store, history } = await run(
			"serial",
			{ output: "stable model content", taskRecord: record() },
			() => {},
		);
		const expected = structuredClone(results(history)[0]!.taskRecord!);
		const before = historyTokens(history);
		const id = store.appendCompaction("summary", history, 100);
		const entry = store.getEntry(id)!;
		if (entry.type !== "compaction") throw new Error("missing checkpoint");
		damage(results(history)[0]!.taskRecord!);
		expect(results(entry.retainedTail)[0]!.taskRecord).toEqual(expected);
		expect(collectTaskRecords(store.getEntries())).toEqual([expected]);
		expect(historyTokens(history)).toBe(before);
	});
});

describe("real Runner and task children", () => {
	it.each([false, true])(
		"isolates multiple real child attempts (transcripts disabled=%s)",
		async (disabled) => {
			vi.stubEnv("INK_LOG", "0");
			vi.stubEnv("INK_AUTOCOMPACT", "0");
			vi.stubEnv("INK_CHILD_SESSIONS", disabled ? "0" : "1");
			const base = mkTempDir("ink-runner-");
			let parentCalls = 0;
			const childRequests: string[] = [];
			const provider: LLMProvider = {
				name: "openai-codex",
				async *stream(request) {
					const isParent = request.tools.some((t) => t.name === "task");
					let message: AssistantMessage;
					if (isParent) {
						parentCalls++;
						message =
							parentCalls === 1
								? assistant(
										["one", "two"].map((prompt, i) => ({
											type: "toolCall",
											id: `task-${i}`,
											name: "task",
											arguments: { prompt },
										})),
										"tool_use",
										ZERO,
									)
								: done();
					} else {
						childRequests.push(request.model);
						message = {
							...assistant([{ type: "text", text: "child output" }], "end_turn", { ...ALL }),
							serviceTier: { ...FAST },
						};
					}
					yield { type: "message_end", message };
				},
			};
			const runner = await createRunner({
				cwd: path.join(base, "project"),
				argv: [],
				model: REF,
				provider,
				maxTokens: 1024,
				maxTurns: 4,
				noContextFiles: true,
				noSession: false,
				sessionBaseDir: base,
				settingsPath: path.join(base, "settings.json"),
				agentsHomeDir: base,
				agentsProjectAllowed: false,
				systemPromptHomeDir: base,
				renderer: makeRenderer().renderer,
			});
			onTestFinished(() => runner.close());
			const expected: TaskRecord[] = [];
			const retained: ToolResult[] = [];
			await runner.runTurn({
				userMessage: "delegate",
				onEvent: (e, info) => {
					if (info || (e.type !== "tool_settled" && e.type !== "tool_end")) return;
					if (e.type === "tool_settled") {
						expected.push(structuredClone(e.result.taskRecord!));
						retained.push(e.result);
						e.result.taskRecord!.usagePricing![0]!.serviceTier!.reported = "flex";
					} else delete e.result.taskRecord;
				},
			});
			expect(childRequests).toEqual(["gpt-5.5", "gpt-5.5"]);
			expect(expected).toHaveLength(2);
			expect(new Set(expected.map((r) => r.attemptId)).size).toBe(2);
			const store = runner.session!;
			const cached = runner.usageTotals()!;
			for (const result of retained) result.taskRecord = record();
			const totals = assertFacts(runner.history, store, expected);
			expect(runner.usageTotals()).toEqual(cached);
			expect(totals).toEqual(cached);
			expect(priceUsageTotals(totals, () => RATES).usd).toBe(250);
			for (const r of expected) {
				expect(r.parentSessionId).toBe(store.header.id);
				expect(r.binding?.reference).toBe(REF);
				if (disabled) expect(r.transcript).toEqual({ present: false, why: "disabled" });
				else {
					expect(r.transcript?.present).toBe(true);
					expect(r.childId).toBeDefined();
				}
			}
		},
	);
});
