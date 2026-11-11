import { appendFileSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compactSession, summarizeBranchSegment } from "../src/core/compaction.js";
import type { AssistantMessage, Usage } from "../src/core/messages.js";
import { pricingSlice } from "../src/core/service-tier-pricing.js";
import { createSession } from "../src/core/session/manager.js";
import { SessionStore, summaryUsageOwner } from "../src/core/session/store.js";
import { createAttemptUsage } from "../src/core/usage-ledger.js";
import { usageTotalsTracker } from "../src/core/usage-totals.js";
import type { LLMProvider, LLMRequest } from "../src/provider/types.js";
import { buildTreeRows } from "../src/repl/components/tree-selector.js";
import { replaySession } from "../src/repl/replay.js";
import { createRunner } from "../src/runner.js";
import { assistant, gate, makeRenderer, scriptedProvider, user } from "./helpers/fakes.js";
import { mkTempDir } from "./helpers/mktemp.js";

beforeEach(() => vi.stubEnv("INK_LOG", "0"));
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

const usage: Usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 };
const settings = { reserveTokens: 100, keepRecentTokens: 1, contextWindow: 1000 };
const stamps = { model: "gpt-5.5", modelReference: "openai-codex/gpt-5.5" };
function report(text = "SUMMARY", stop: AssistantMessage["stopReason"] = "end_turn", tier = "priority") {
	return {
		...assistant([{ type: "text" as const, text }], stop, { ...usage }),
		serviceTier: { requested: "priority" as const, reported: tier },
	};
}
function seed(store: SessionStore) {
	store.appendMessage(user("first ".repeat(50)));
	const target = store.appendMessage(assistant([{ type: "text", text: "first answer" }]));
	store.appendMessage(user("second ".repeat(50)));
	store.appendMessage(assistant([{ type: "text", text: "second answer" }]));
	return target;
}
function localStore() {
	const base = mkTempDir("ink-compact-");
	const store = SessionStore.create(path.join(base, "session.jsonl"), base);
	seed(store);
	return store;
}
const receipts = (store: SessionStore) => store.getEntries().filter((entry) => entry.type === "summaryUsage");
const durableReceiptCount = (store: SessionStore) =>
	readFileSync(store.filePath, "utf8")
		.split("\n")
		.filter((line) => line.includes('"type":"summaryUsage"')).length;

function compact(
	store: SessionStore,
	provider: LLMProvider,
	extra: Partial<Parameters<typeof compactSession>[0]> = {},
) {
	return compactSession({ session: store, provider, ...stamps, settings, ...extra });
}

describe("summary report slices", () => {
	it.each(["priority", "legacy"])(
		"compaction retries preserve %s first-hop attribution and all counters",
		async (firstTier) => {
			const store = localStore();
			const first: AssistantMessage = report("cut", "max_tokens");
			if (firstTier === "legacy") delete first.serviceTier;
			const second = report("accepted", "end_turn", "flex");
			const result = await compact(store, scriptedProvider([first, second]), { thinking: "high" });
			expect(result?.usage).toEqual({
				inputTokens: 20,
				outputTokens: 4,
				cacheReadTokens: 6,
				cacheWriteTokens: 8,
			});
			expect(result?.usagePricing).toEqual([
				pricingSlice(usage, first.serviceTier),
				pricingSlice(usage, second.serviceTier),
			]);
			const entry = store.getEntries().at(-1);
			if (entry?.type !== "compaction") throw new Error("missing checkpoint");
			expect(entry.usagePricing).toEqual(result?.usagePricing);
			expect(SessionStore.open(store.filePath).getEntries().at(-1)).toEqual(entry);
			expect(receipts(store)).toHaveLength(0);
		},
	);

	it("one stream captures every report before later report objects can mutate", async () => {
		const first = report("first", "end_turn", "priority");
		const second = report("final", "end_turn", "flex");
		const provider: LLMProvider = {
			name: "mock",
			async *stream() {
				yield { type: "message_end", message: first };
				first.serviceTier.reported = "changed-after-capture";
				first.usage.inputTokens = 999;
				yield { type: "message_end", message: second };
			},
		};
		const result = await summarizeBranchSegment({ messages: [user("hello")], provider, model: stamps.model });
		expect(result.summary).toBe("final");
		expect(result.usage.inputTokens).toBe(20);
		expect(result.usagePricing).toEqual([
			pricingSlice(usage, report().serviceTier),
			pricingSlice(usage, second.serviceTier),
		]);
	});

	it("branch retry collects local slices without any surrounding ledger", async () => {
		const first = report("cut", "max_tokens", "fast");
		const second = report("accepted", "end_turn", "flex");
		const result = await summarizeBranchSegment({
			messages: [user("hello")],
			provider: scriptedProvider([first, second]),
			model: stamps.model,
			thinking: "high",
		});
		expect(result.usagePricing).toEqual([
			pricingSlice(usage, first.serviceTier),
			pricingSlice(usage, second.serviceTier),
		]);
	});
});

describe("compaction failure receipts", () => {
	it.each(["empty", "cap", "both capped", "retry throws", "throws before report"])(
		"%s accounts once without installing a checkpoint",
		async (failure) => {
			const store = localStore();
			const before = { leaf: store.getLeafId(), context: store.buildContext(), stats: store.stats() };
			const throws = () => {
				throw new Error("provider failed");
			};
			const scripts =
				failure === "empty"
					? [report(" ")]
					: failure === "cap"
						? [report("cut", "max_tokens")]
						: failure === "both capped"
							? [report("cut", "max_tokens"), report("cut", "max_tokens", "flex")]
							: failure === "retry throws"
								? [report("cut", "max_tokens"), throws]
								: [throws];
			await expect(
				compact(store, scriptedProvider(scripts), { thinking: failure === "cap" ? "off" : "high" }),
			).rejects.toThrow();
			expect(receipts(store)).toHaveLength(1);
			const receipt = receipts(store)[0]!;
			expect(receipt.modelReference).toBe(stamps.modelReference);
			expect(receipt.usage.inputTokens).toBe(
				failure === "throws before report" ? 0 : failure === "both capped" ? 20 : 10,
			);
			expect(receipt.usageMissing).toBe(failure.includes("throws") ? true : undefined);
			if (failure !== "throws before report")
				expect(receipt.usagePricing?.some((slice) => slice.serviceTier?.requested === "priority")).toBe(true);
			expect({ leaf: store.getLeafId(), context: store.buildContext(), stats: store.stats() }).toEqual(
				before,
			);
			expect(store.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
			expect(durableReceiptCount(store)).toBe(1);
		},
	);

	it.each([false, true])(
		"mid-stream abort (reported=%s) retains work but never context",
		async (reported) => {
			const store = localStore();
			const entered = gate();
			const hold = gate();
			const controller = new AbortController();
			const provider: LLMProvider = {
				name: "mock",
				async *stream() {
					if (reported) yield { type: "message_end", message: report() };
					else yield { type: "text_delta", text: "partial" };
					entered.resolve();
					await hold.promise;
				},
			};
			const before = store.buildContext();
			const promise = compact(store, provider, { signal: controller.signal });
			await entered.promise;
			controller.abort();
			hold.resolve();
			await expect(promise).rejects.toThrow(/abort/);
			expect(receipts(store)).toHaveLength(1);
			expect(receipts(store)[0]?.usage.inputTokens).toBe(reported ? 10 : 0);
			expect(receipts(store)[0]?.usageMissing).toBe(reported ? undefined : true);
			expect(store.buildContext()).toEqual(before);
		},
	);

	it("no receipt or provider call for null work or a pre-aborted call", async () => {
		const store = localStore();
		const requests: LLMRequest[] = [];
		const provider = scriptedProvider([report()], requests);
		expect(await compact(store, provider, { settings: { ...settings, keepRecentTokens: 1e6 } })).toBeNull();
		const controller = new AbortController();
		controller.abort();
		await expect(compact(store, provider, { signal: controller.signal })).rejects.toThrow(/abort/);
		expect(requests).toHaveLength(0);
		expect(receipts(store)).toHaveLength(0);
	});

	it("an external child ledger is the sole owner, with no parent-facing receipt", async () => {
		const store = localStore();
		const ledger = createAttemptUsage();
		await expect(
			compact(store, scriptedProvider([report("cut", "max_tokens")]), { usageLedger: ledger }),
		).rejects.toThrow(/cap/);
		expect(ledger.summarizer.inputTokens).toBe(10);
		expect(ledger.usagePricing).toBeDefined();
		expect(receipts(store)).toHaveLength(0);
	});

	it("does not create a receipt around an ambiguous accepted checkpoint write", async () => {
		const store = localStore();
		vi.spyOn(store, "appendCompaction").mockImplementation(() => {
			throw new Error("checkpoint write failed");
		});
		await expect(compact(store, scriptedProvider([report()]))).rejects.toThrow("checkpoint write failed");
		expect(receipts(store)).toHaveLength(0);
	});

	it("receipt failure and failing diagnostics do not replace the primary error", async () => {
		const store = localStore();
		const primary = new Error("primary failure");
		const append = vi.spyOn(store, "appendSummaryUsage").mockImplementation(() => {
			throw new Error("disk failed");
		});
		const diagnostic = vi.fn(() => {
			throw new Error("diagnostic failed");
		});
		await expect(
			compact(
				store,
				scriptedProvider([
					() => {
						throw primary;
					},
				]),
				{ onReceiptError: diagnostic },
			),
		).rejects.toBe(primary);
		expect(append).toHaveBeenCalledTimes(1);
		expect(diagnostic).toHaveBeenCalledTimes(1);
	});
});

describe("accounting-only session receipts", () => {
	it.each(["null", "interior"])("a receipt after a %s position never supersedes it on reopen", (position) => {
		const store = localStore();
		const first = store.getEntries()[0]!.id;
		store.appendSessionName("kept name");
		store.appendThinkingLevelChange("high");
		store.branchTo(position === "null" ? null : first);
		const before = {
			leaf: store.getLeafId(),
			context: store.buildContext(),
			tree: store.getTree(),
			tips: store.otherBranchTips(),
			stats: store.stats(),
			name: store.getSessionName(),
		};
		const id = store.appendSummaryUsage(usage, {
			...stamps,
			usagePricing: [pricingSlice(usage, report().serviceTier)],
		});
		const receipt = store.getEntry(id)!;
		for (const filter of ["all", "default", "labeled-only"] as const) {
			expect(buildTreeRows([{ entry: receipt, children: [], label: "receipt" }], id, { filter })).toEqual([]);
		}
		for (const view of [store, SessionStore.open(store.filePath)]) {
			expect({
				leaf: view.getLeafId(),
				context: view.buildContext(),
				tree: view.getTree(),
				tips: view.otherBranchTips(),
				stats: view.stats(),
				name: view.getSessionName(),
			}).toEqual(before);
			expect(() => view.branchTo(id)).toThrow(/not branch targets/);
			expect(() => view.getBranch(id)).toThrow(/not branch targets/);
			let text = "";
			expect(
				replaySession(
					{
						write: (s) => {
							text += s;
						},
						ansi: false,
						markdown: false,
					},
					view,
				),
			).toBe(before.context.messages.length);
			expect(text).not.toContain("summaryUsage");
		}
		appendFileSync(store.filePath, `${JSON.stringify({ type: "position", leafId: id })}\n`);
		expect(SessionStore.open(store.filePath).getLeafId()).not.toBe(id);
	});

	it.each(["summaryUsage", "compaction", "branchSummary"] as const)(
		"%s append/parser copy slices and strictly discard invalid metadata without losing usage",
		(kind) => {
			const store = localStore();
			const slice = pricingSlice(usage, report().serviceTier);
			const options = { ...stamps, usagePricing: [slice] };
			const id =
				kind === "summaryUsage"
					? store.appendSummaryUsage(usage, options)
					: kind === "compaction"
						? store.appendCompaction("summary", [], 123, usage, options)
						: store.appendBranchSummary("summary", usage, options);
			slice.usage.inputTokens = 999;
			slice.serviceTier!.reported = "flex";
			const entry = store.getEntry(id);
			expect(entry && "usage" in entry ? entry.usagePricing?.[0] : undefined).toEqual(
				pricingSlice(usage, report().serviceTier),
			);
			const raw = readFileSync(store.filePath, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			for (const bad of ["bad reported", "nonconserving", "negative", "missing field"]) {
				const last = raw.at(-1);
				last.usagePricing = [pricingSlice(usage, report().serviceTier)];
				if (bad === "bad reported") last.usagePricing[0].serviceTier.reported = " priority ";
				if (bad === "nonconserving") last.usagePricing[0].usage.outputTokens++;
				if (bad === "negative") last.usagePricing[0].usage.cacheReadTokens = -1;
				if (bad === "missing field") delete last.usagePricing[0].usage.inputTokens;
				writeFileSync(store.filePath, `${raw.map((value) => JSON.stringify(value)).join("\n")}\n`);
				const restored = SessionStore.open(store.filePath).getEntry(id);
				expect(restored && "usage" in restored ? restored.usage : undefined).toEqual(usage);
				expect(restored && "usage" in restored ? restored.usagePricing : undefined).toBeUndefined();
			}
		},
	);

	it("malformed persisted individual observations cannot silently retain requested priority", () => {
		const store = localStore();
		const message = { ...report(), serviceTier: { requested: "priority", reported: " priority " } };
		appendFileSync(
			store.filePath,
			`${JSON.stringify({ type: "message", id: "malformed", parentId: store.getLeafId(), timestamp: new Date().toISOString(), message })}\n`,
		);
		const reopened = SessionStore.open(store.filePath);
		const entry = reopened.getEntry("malformed");
		expect(
			entry?.type === "message" && entry.message.role === "assistant" && entry.message.serviceTier,
		).toBeUndefined();
		expect(entry?.type === "message" && entry.message.role === "assistant" && entry.message.usage).toEqual(
			usage,
		);
	});

	it("file routing requires BOTH canonical path and header identity", () => {
		const origin = localStore();
		const link = path.join(path.dirname(origin.filePath), "alias.jsonl");
		symlinkSync(origin.filePath, link);
		const replacement = SessionStore.open(link);
		expect(summaryUsageOwner(origin, replacement)).toBe(replacement);
		const otherPath = SessionStore.create(
			path.join(path.dirname(origin.filePath), "other.jsonl"),
			origin.header.cwd,
			origin.header.id,
		);
		expect(summaryUsageOwner(origin, otherPath)).toBe(origin);
		const otherId = SessionStore.create(origin.filePath, origin.header.cwd, "other-id");
		expect(summaryUsageOwner(origin, otherId)).toBe(origin);
	});
});

async function runnerEnv(provider: LLMProvider) {
	const base = mkTempDir("ink-tree-");
	const cwd = path.join(base, "project");
	const initial = createSession(cwd, base);
	const target = seed(initial);
	const { renderer, output } = makeRenderer();
	const runner = await createRunner({
		cwd,
		argv: [],
		model: stamps.modelReference,
		settingsPath: path.join(base, "settings.json"),
		sessionBaseDir: base,
		resume: initial.header.id,
		maxTokens: 100,
		maxTurns: 2,
		noContextFiles: true,
		noSession: false,
		renderer,
		provider,
	});
	if (!runner.session) throw new Error("no session");
	return { runner, origin: runner.session, target, base, cwd, output };
}

describe("gated runner summary ownership", () => {
	it("discloses receipt persistence failure even when run logging is disabled", async () => {
		const provider: LLMProvider = {
			name: "mock",
			async *stream() {
				yield { type: "message_end", message: report() };
				throw new Error("primary summary failure");
			},
		};
		const { runner, origin, target, output } = await runnerEnv(provider);
		const append = vi.spyOn(origin, "appendSummaryUsage").mockImplementation(() => {
			throw new Error("disk failed");
		});
		expect(await runner.navigateTree(target, { summarize: true })).toMatchObject({ summary: "failed" });
		expect(append).toHaveBeenCalledTimes(1);
		expect(output()).toContain("summary usage receipt was not persisted: disk failed");
		expect(receipts(origin)).toHaveLength(0);
		runner.close();
	});

	it.each(
		["failure", "success", "abort"].flatMap((outcome) =>
			["same", "different"].map((file) => ({ outcome, file })),
		),
	)(
		"$outcome while reopening $file file appends exactly one receipt to its owner",
		async ({ outcome, file }) => {
			const entered = gate();
			const hold = gate();
			const controller = new AbortController();
			const provider: LLMProvider = {
				name: "mock",
				async *stream() {
					yield { type: "message_end", message: report() };
					entered.resolve();
					await hold.promise;
					if (outcome === "failure") throw new Error("late summary failure");
				},
			};
			const { runner, origin, target, cwd, base } = await runnerEnv(provider);
			const sourceContext = origin.buildContext();
			const promise = runner.navigateTree(target, { summarize: true, signal: controller.signal });
			await entered.promise;
			if (file === "same") runner.resumeSession(origin.header.id);
			else {
				const other = createSession(cwd, base);
				other.appendMessage(user("unrelated"));
				runner.resumeSession(other.header.id);
			}
			const active = runner.session!;
			const activeContext = active.buildContext();
			const activeLeaf = active.getLeafId();
			const activeTotals = runner.usageTotals();
			if (outcome === "abort") controller.abort();
			hold.resolve();
			const result = await promise;
			if (outcome === "abort") expect(result).toEqual({ aborted: true });
			else expect(result).toMatchObject({ summary: "failed" });
			const owner = file === "same" ? active : origin;
			expect(receipts(owner)).toHaveLength(1);
			expect(receipts(file === "same" ? origin : active)).toHaveLength(0);
			expect(durableReceiptCount(origin)).toBe(1);
			expect(origin.buildContext()).toEqual(sourceContext);
			expect(active.getLeafId()).toBe(activeLeaf);
			expect(active.buildContext()).toEqual(activeContext);
			expect(runner.history).toEqual(activeContext.messages);
			const rebuilt = usageTotalsTracker(SessionStore.open(active.filePath).getEntries()).view();
			expect(runner.usageTotals()).toEqual(rebuilt);
			if (file === "same") expect(rebuilt.summarizer.inputTokens).toBe(10);
			else expect(runner.usageTotals()).toEqual(activeTotals);
			runner.close();
		},
	);

	it("pre-aborted branch navigation never starts a call or writes a receipt", async () => {
		const requests: LLMRequest[] = [];
		const { runner, origin, target } = await runnerEnv(scriptedProvider([report()], requests));
		const controller = new AbortController();
		controller.abort();
		const leaf = origin.getLeafId();
		expect(await runner.navigateTree(target, { summarize: true, signal: controller.signal })).toEqual({
			aborted: true,
		});
		expect(requests).toHaveLength(0);
		expect(receipts(origin)).toHaveLength(0);
		expect(origin.getLeafId()).toBe(leaf);
		runner.close();
	});

	it("successful branch summary uses its one accepted entry, and receipts cannot be runner navigation targets", async () => {
		const { runner, origin, target } = await runnerEnv(scriptedProvider([report()]));
		expect(await runner.navigateTree(target, { summarize: true })).toMatchObject({ summary: "written" });
		const entry = origin.getEntries().at(-1);
		expect(entry?.type === "branchSummary" && entry.usagePricing).toEqual([
			pricingSlice(usage, report().serviceTier),
		]);
		expect(receipts(origin)).toHaveLength(0);
		const id = origin.appendSummaryUsage(usage, stamps);
		await expect(runner.navigateTree(id)).rejects.toThrow(/not found/);
		runner.close();
	});

	it.each(["overflow", "automatic"].flatMap((seam) => ["new", "resume"].map((mode) => ({ seam, mode }))))(
		"$seam compaction after /$mode continues the captured run without mutating the replacement",
		async ({ seam, mode }) => {
			if (seam === "automatic") vi.stubEnv("INK_CONTEXT_WINDOW", "40000");
			const entered = gate();
			const hold = gate();
			const requests: LLMRequest[] = [];
			const provider = scriptedProvider(
				[
					...(seam === "overflow"
						? [
								() => {
									throw new Error("context window exceeded");
								},
							]
						: []),
					async () => {
						entered.resolve();
						await hold.promise;
						return report();
					},
					report("recovered"),
					report("next run"),
				],
				requests,
			);
			const { runner, origin, cwd, base } = await runnerEnv(provider);
			const tail = user("tail".repeat(25000));
			origin.appendMessage(tail);
			runner.history.push(tail);
			const publicHistory = runner.history;
			const promise = runner.runTurn({ userMessage: "continue original" });
			await entered.promise;
			if (mode === "new") runner.newSession();
			else {
				const other = createSession(cwd, base);
				other.appendMessage(user("unrelated"));
				runner.resumeSession(other.header.id);
			}
			const active = runner.session!;
			const before = active.buildContext();
			const entries = [...active.getEntries()];
			const leaf = active.getLeafId();
			hold.resolve();
			expect(await promise).toMatchObject({ stopReason: "completed" });
			expect(requests.map((request) => request.sessionId)).toEqual(
				seam === "overflow" ? [origin.header.id, undefined, origin.header.id] : [undefined, origin.header.id],
			);
			const summaryIndex = seam === "overflow" ? 1 : 0;
			const continuation = requests[summaryIndex + 1];
			expect(requests[summaryIndex]).not.toHaveProperty("sessionId");
			expect(continuation?.messages).toContainEqual(user("continue original"));
			expect(
				continuation?.messages.some(
					(message) =>
						message.role === "user" &&
						typeof message.content === "string" &&
						message.content.includes("SUMMARY"),
				),
			).toBe(true);
			expect(continuation?.messages).not.toContainEqual(user("unrelated"));
			expect(origin.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
			expect(origin.buildContext().messages.at(-1)).toMatchObject({
				role: "assistant",
				blocks: [{ type: "text", text: "recovered" }],
			});
			expect(receipts(origin)).toHaveLength(0);
			expect(receipts(active)).toHaveLength(0);
			expect(active.getEntries()).toEqual(entries);
			expect(active.getLeafId()).toBe(leaf);
			expect(active.buildContext()).toEqual(before);
			expect(runner.history).toEqual(before.messages);
			expect(runner.history).toBe(publicHistory);
			expect(await runner.runTurn({ userMessage: "next run" })).toMatchObject({ stopReason: "completed" });
			expect(requests[summaryIndex + 2]?.sessionId).toBe(active.header.id);
			expect(requests[summaryIndex + 2]?.sessionId).not.toBe(origin.header.id);
			runner.close();
		},
	);

	it("a session swap after checkpoint append keeps the accepted entry as the sole accounting owner", async () => {
		const { runner, origin, cwd, base } = await runnerEnv(scriptedProvider([report()]));
		origin.appendMessage(user("tail".repeat(25000)));
		const other = createSession(cwd, base);
		other.appendMessage(user("unrelated"));
		const append = origin.appendCompaction.bind(origin);
		vi.spyOn(origin, "appendCompaction").mockImplementation((...args) => {
			const id = append(...args);
			runner.resumeSession(other.header.id);
			return id;
		});
		await runner.compactNow();
		expect(runner.session?.header.id).toBe(other.header.id);
		expect(runner.history).toEqual(other.buildContext().messages);
		expect(origin.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(receipts(origin)).toHaveLength(0);
		expect(receipts(runner.session!)).toHaveLength(0);
		runner.close();
	});

	// The resolver routes FAILED compaction receipts; it is not an acceptance
	// gate. Successful compaction remains a checkpoint in the captured store,
	// unlike a branch summary whose navigation can no longer be installed.
	it.each(
		["failure", "success"].flatMap((outcome) => ["same", "different"].map((file) => ({ outcome, file }))),
	)(
		"runner compaction $outcome during $file reopen retains its accounting owner without replacing live context",
		async ({ outcome, file }) => {
			// The retained-tail setting is captured at module initialization. A long
			// tail makes a real cut even with the default 20k retained window.
			const entered = gate();
			const hold = gate();
			const provider: LLMProvider = {
				name: "mock",
				async *stream() {
					yield { type: "message_end", message: report() };
					entered.resolve();
					await hold.promise;
					if (outcome === "failure") throw new Error("late compaction failure");
				},
			};
			const { runner, origin, cwd, base } = await runnerEnv(provider);
			origin.appendMessage(user("tail".repeat(25000)));
			const promise = runner.compactNow();
			await entered.promise;
			if (file === "same") runner.resumeSession(origin.header.id);
			else {
				const other = createSession(cwd, base);
				other.appendMessage(user("unrelated"));
				runner.resumeSession(other.header.id);
			}
			const active = runner.session!;
			const before = active.buildContext();
			const leaf = active.getLeafId();
			const activeTotals = runner.usageTotals();
			hold.resolve();
			if (outcome === "failure") {
				await expect(promise).rejects.toThrow("late compaction failure");
				expect(receipts(file === "same" ? active : origin)).toHaveLength(1);
				expect(receipts(file === "same" ? origin : active)).toHaveLength(0);
				expect(durableReceiptCount(origin)).toBe(1);
				expect(runner.usageTotals()).toEqual(
					usageTotalsTracker(SessionStore.open(active.filePath).getEntries()).view(),
				);
			} else {
				await expect(promise).resolves.toBe("compacted");
				expect(origin.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
				expect(receipts(origin)).toHaveLength(0);
				expect(receipts(active)).toHaveLength(0);
				expect(durableReceiptCount(origin)).toBe(0);
				// A replacement store is a separate live snapshot, not a general
				// concurrent-writer watcher for accepted checkpoints in the old run.
				expect(runner.usageTotals()).toEqual(activeTotals);
				expect(usageTotalsTracker(SessionStore.open(origin.filePath).getEntries()).view()).toEqual(
					usageTotalsTracker(origin.getEntries()).view(),
				);
			}
			expect(active.getLeafId()).toBe(leaf);
			expect(active.buildContext()).toEqual(before);
			expect(runner.history).toEqual(before.messages);
			runner.close();
		},
	);
});
