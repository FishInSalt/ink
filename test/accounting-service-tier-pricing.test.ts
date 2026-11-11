import { appendFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AssistantMessage, Usage } from "../src/core/messages.js";
import type { ServiceTierReport } from "../src/core/service-tier.js";
import {
	CODEX_SERVICE_TIER_PRICING_VERSION,
	parseUsagePricing,
	pricingSlice,
	type UsagePricingSlice,
} from "../src/core/service-tier-pricing.js";
import { createSession } from "../src/core/session/manager.js";
import { type SessionEntry, SessionStore } from "../src/core/session/store.js";
import { runSubagent } from "../src/core/subagent.js";
import { buildTaskRecord, parseTaskRecord } from "../src/core/task-record.js";
import { createTaskTool } from "../src/core/tools/task.js";
import type { ToolExecuteResult } from "../src/core/tools/types.js";
import {
	attemptUsageSnapshot,
	createAttemptUsage,
	recordMissingUsageReport,
	recordSummarizerCall,
	recordUsageReport,
} from "../src/core/usage-ledger.js";
import { priceUsageTotals, usageTotalsTracker } from "../src/core/usage-totals.js";
import { usageMoneySegment } from "../src/format.js";
import type { ModelCost } from "../src/provider/models.js";
import { assistant, scriptedProvider } from "./helpers/fakes.js";
import { mkTempDir } from "./helpers/mktemp.js";

const REF = "openai-codex/gpt-5.5";
const NORMAL: ServiceTierReport = { requested: "omitted" };
const FAST: ServiceTierReport = { requested: "priority", reported: "priority" };
const ALL: Usage = {
	inputTokens: 1_000_000,
	outputTokens: 2_000_000,
	cacheReadTokens: 3_000_000,
	cacheWriteTokens: 4_000_000,
};
// All four components matter: each ALL report has a base cost of $50.
const RATES: ModelCost = { input: 1, output: 3, cacheRead: 5, cacheWrite: 7 };
const TS = "2026-11-10T00:00:00.000Z";

function message(serviceTier?: ServiceTierReport, usage: Usage = ALL): AssistantMessage {
	return {
		...assistant([{ type: "text", text: "done" }], "end_turn", { ...usage }),
		modelReference: REF,
		...(serviceTier === undefined ? {} : { serviceTier: { ...serviceTier } }),
	};
}

function entry(id: string, serviceTier?: ServiceTierReport, reference = REF): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: TS,
		message: { ...message(serviceTier), modelReference: reference },
	};
}

function record(usagePricing?: UsagePricingSlice[]) {
	return buildTaskRecord({
		attemptId: "attempt",
		sourceId: "source",
		launched: true,
		cwd: "/tmp",
		status: "completed",
		turns: 3,
		textPresent: true,
		usage: { ...ALL },
		binding: { providerName: "openai-codex", wireModelId: "gpt-5.5", reference: REF },
		...(usagePricing === undefined ? {} : { usagePricing }),
	});
}

function persistTask(store: SessionStore, result: ToolExecuteResult, toolCallId: string): void {
	store.appendMessage({
		role: "toolResult",
		results: [
			{
				toolCallId,
				toolName: "task",
				content: result.output,
				isError: result.isError ?? false,
				taskRecord: result.taskRecord,
			},
		],
	});
}

function assertConserved(slices: UsagePricingSlice[] | undefined, aggregate: Usage): void {
	expect(slices).toBeDefined();
	expect(parseUsagePricing(slices, aggregate)).toEqual(slices);
}

describe("attempt accounting attribution", () => {
	it("captures mixed task/summary reports, including earlier/later legacy work, without changing counters", () => {
		const ledger = createAttemptUsage();
		recordUsageReport(ledger, "task", ALL);
		expect(attemptUsageSnapshot(ledger).usagePricing).toBeUndefined();
		recordSummarizerCall(ledger);
		const observation = { ...FAST };
		const usage = { ...ALL };
		recordUsageReport(ledger, "summarizer", usage, observation);
		observation.reported = "flex";
		usage.cacheWriteTokens = 999;
		recordUsageReport(ledger, "task", ALL);
		recordMissingUsageReport(ledger);
		const snap = attemptUsageSnapshot(ledger);
		assertConserved(snap.usagePricing, snap.totals);
		expect(snap.usagePricing?.map((s) => s.serviceTier)).toEqual([undefined, FAST, undefined]);
		expect(snap.taskReports).toBe(2);
		expect(snap.summarizerCalls).toBe(1);
		expect(snap.incomplete).toBe(true);
		expect(snap.totals).toEqual({
			inputTokens: 3_000_000,
			outputTokens: 6_000_000,
			cacheReadTokens: 9_000_000,
			cacheWriteTokens: 12_000_000,
		});
		const pricedSlice = snap.usagePricing?.[1];
		if (!pricedSlice?.serviceTier) throw new Error("missing captured tier");
		pricedSlice.serviceTier.reported = "changed";
		pricedSlice.usage.inputTokens = 0;
		expect(attemptUsageSnapshot(ledger).usagePricing?.[1]).toEqual(pricingSlice(ALL, FAST));
	});

	it("preserves a report and observation before a throwing observer, even on a failed child", async () => {
		const outcome = await runSubagent({
			provider: scriptedProvider([message(FAST)]),
			model: "gpt-5.5",
			modelReference: REF,
			system: "",
			tools: [],
			prompt: "go",
			autoCompact: false,
			onEvent: (event) => {
				if (event.type !== "message_end") return;
				if (event.message.serviceTier) event.message.serviceTier.reported = "flex";
				event.message.usage.inputTokens = 0;
				throw new Error("observer failed");
			},
		});
		expect(outcome.status).toBe("crash");
		expect(outcome.turns).toBe(1);
		expect(outcome.usage).toEqual(ALL);
		expect(outcome.usageDetail.incomplete).toBe(false);
		expect(outcome.usagePricing?.filter((s) => s.serviceTier)).toEqual([pricingSlice(ALL, FAST)]);
		assertConserved(outcome.usagePricing, outcome.usage);
	});

	it("forwards task plus summary reports from an overflow retry without pricing restored history", async () => {
		const first = message(NORMAL, {
			inputTokens: 100,
			outputTokens: 7,
			cacheReadTokens: 3,
			cacheWriteTokens: 4,
		});
		first.blocks.push({ type: "toolCall", id: "c", name: "absent", arguments: {} });
		first.stopReason = "tool_use";
		const outcome = await runSubagent({
			provider: scriptedProvider([
				first,
				() => {
					throw new Error("prompt is too long");
				},
				message(FAST, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 2 }),
				message(undefined, { inputTokens: 50, outputTokens: 5 }),
			]),
			model: "m",
			modelReference: REF,
			system: "",
			tools: [],
			prompt: "go",
			autoCompact: false,
			settings: { reserveTokens: 16, keepRecentTokens: 1, contextWindow: 131072 },
		});
		expect(outcome.status).toBe("completed");
		expect(outcome.turns).toBe(2);
		expect(outcome.usageDetail.summarizerCalls).toBe(1);
		expect(outcome.usageDetail.incomplete).toBe(true);
		expect(outcome.usagePricing?.map((s) => s.serviceTier)).toEqual([NORMAL, FAST, undefined]);
		assertConserved(outcome.usagePricing, outcome.usage);
		expect(outcome.usage).toEqual({
			inputTokens: 160,
			outputTokens: 17,
			cacheReadTokens: 4,
			cacheWriteTokens: 6,
		});
	});
});

describe("persisted pricing validation", () => {
	it("builders/parsers copy every nested sidecar and leave raw records intact", () => {
		const supplied = [pricingSlice(ALL, FAST)];
		const built = record(supplied);
		supplied[0]!.usage.inputTokens = 0;
		supplied[0]!.serviceTier!.reported = "flex";
		expect(built.usagePricing).toEqual([pricingSlice(ALL, FAST)]);
		const parsed = parseTaskRecord(built);
		if (!parsed?.usagePricing) throw new Error("missing parsed pricing");
		parsed.usagePricing[0]!.usage.cacheReadTokens = 0;
		parsed.usagePricing[0]!.serviceTier!.reported = "flex";
		parsed.usage!.inputTokens = 0;
		expect(built.usage).toEqual(ALL);
		expect(built.usagePricing).toEqual([pricingSlice(ALL, FAST)]);
	});

	it.each([
		["not an array", {}],
		["missing slice usage", [{}]],
		["negative counter", [{ usage: { ...ALL, inputTokens: -1 } }]],
		["nonfinite counter", [{ usage: { ...ALL, outputTokens: Number.POSITIVE_INFINITY } }]],
		["NaN cache", [{ usage: { ...ALL, cacheReadTokens: Number.NaN } }]],
		["wrong cache type", [{ usage: { ...ALL, cacheWriteTokens: "4" } }]],
		["missing required counter", [{ usage: { outputTokens: 2 } }]],
		["nonconserved cache", [{ usage: { ...ALL, cacheReadTokens: 0 } }]],
		["nonconserved input", [{ usage: { ...ALL, inputTokens: 1 } }]],
		["empty subset", []],
		["invalid request", [{ usage: ALL, serviceTier: { requested: "fast" } }]],
		["malformed reported tier", [{ usage: ALL, serviceTier: { requested: "priority", reported: 42 } }]],
		["invalid reported spelling", [{ usage: ALL, serviceTier: { requested: "priority", reported: "!" } }]],
		["partial valid subset", [pricingSlice(ALL, FAST), { usage: { inputTokens: -1, outputTokens: 0 } }]],
	])("drops %s, not the valid raw TaskRecord", (_name, sidecar) => {
		const raw = { ...record(), usagePricing: sidecar };
		const parsed = parseTaskRecord(raw);
		expect(parsed?.usage).toEqual(ALL);
		expect(parsed?.usagePricing).toBeUndefined();
		expect(raw.usagePricing).toBe(sidecar);
		const built = record(sidecar as UsagePricingSlice[]);
		expect(built.usage).toEqual(ALL);
		expect(built.usagePricing).toBeUndefined();
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "t",
				parentId: null,
				timestamp: TS,
				message: {
					role: "toolResult",
					results: [
						{ toolCallId: "t", toolName: "task", content: "", isError: false, taskRecord: raw as never },
					],
				},
			},
		];
		const view = usageTotalsTracker(entries).view();
		expect(view.child.calls).toBe(1);
		expect(view.incomplete.child).toBe(false);
		const priced = priceUsageTotals(view, () => RATES);
		expect(priced.usd).toBe(50);
		expect(priced.pricingIncomplete).toBe(true);
	});

	it("strictly rejects malformed individual persisted observations before priority sanitization", () => {
		const base = mkTempDir("ink-pricing-e2e-");
		const file = path.join(base, "parent.jsonl");
		const store = SessionStore.create(file, base, "parent");
		store.appendMessage({ role: "user", content: "go" });
		const malformed = entry("malformed", FAST);
		if (malformed.type !== "message" || malformed.message.role !== "assistant") throw new Error("entry");
		malformed.message.serviceTier = { requested: "priority", reported: 42 } as never;
		appendFileSync(file, `${JSON.stringify(malformed)}\n`);
		const priced = priceUsageTotals(
			usageTotalsTracker(SessionStore.open(file).getEntries()).view(),
			() => RATES,
		);
		expect(priced.usd).toBe(50);
		expect(priced.pricingIncomplete).toBe(true);
	});
});

describe("conserved aggregation and reference pricing", () => {
	it("ordinary/Fast/ordinary, legacy work and changed producers agree incrementally and after reload/branching", () => {
		const base = mkTempDir("ink-pricing-e2e-");
		const store = SessionStore.create(path.join(base, "parent.jsonl"), base, "parent");
		const tracker = usageTotalsTracker(store.getEntries());
		for (const tier of [NORMAL, FAST, NORMAL, undefined]) {
			store.appendMessage(message(tier));
			const snapshot = tracker.view();
			for (const model of snapshot.byModel) assertConserved(model.usagePricing, model.bucket);
			expect(snapshot).toEqual(usageTotalsTracker(store.getEntries()).view());
		}
		store.appendMessage({ ...message(FAST), modelReference: "openai/gpt-5.5" });
		store.appendMessage({ ...message(FAST), modelReference: "openai-codex/gpt-future" });
		store.appendMessage({ ...message(FAST), modelReference: "unknown/model" });
		store.branchTo(null);
		store.appendMessage({ role: "user", content: "new branch" });
		const before = tracker.view();
		expect(before.parent).toEqual({
			inputTokens: 7_000_000,
			outputTokens: 14_000_000,
			cacheReadTokens: 21_000_000,
			cacheWriteTokens: 28_000_000,
			calls: 7,
		});
		const rateFor = (reference: string) => (reference === "unknown/model" ? undefined : RATES);
		const priced = priceUsageTotals(before, rateFor);
		expect(priced.usd).toBe(425); // Codex: 275 + 100; OpenAI: 50, never multiplied.
		expect(priced.pricingIncomplete).toBe(true); // only legacy Codex attribution
		expect(priced.serviceTierPricingVersion).toBe(CODEX_SERVICE_TIER_PRICING_VERSION);
		expect(priced.unpriced.calls).toBe(1);
		const reloaded = usageTotalsTracker(SessionStore.open(store.filePath).getEntries()).view();
		expect(reloaded).toEqual(before);
		expect(priceUsageTotals(reloaded, rateFor)).toEqual(priced);
		// Snapshots and priced projections cannot change the tracker's internal slices.
		before.byModel[0]!.usagePricing![0]!.usage.inputTokens = 0;
		priced.byModel[0]!.usagePricing![0]!.serviceTier!.reported = "flex";
		store.appendMessage(message(NORMAL));
		expect(tracker.view()).toEqual(usageTotalsTracker(store.getEntries()).view());
	});

	it.each([
		["gpt-5.5", FAST, 2.5, false],
		["gpt-5.5-mini", FAST, 2, false],
		["future", FAST, 2, false],
		["gpt-5.5", { requested: "omitted", reported: "fast" }, 2.5, false],
		["gpt-5.5", { requested: "priority", reported: "flex" }, 0.5, false],
		["gpt-5.5", { requested: "priority", reported: "default" }, 2.5, false],
		["gpt-5.5", { requested: "priority" }, 2.5, false],
		["gpt-5.5", NORMAL, 1, false],
		["gpt-5.5", { requested: "priority", reported: "standard" }, 1, false],
		["gpt-5.5", { requested: "priority", reported: "auto" }, 1, false],
		["gpt-5.5", { requested: "priority", reported: "scale" }, 1, false],
		["gpt-5.5", { requested: "priority", reported: "future-tier" }, 1, true],
		["gpt-5.5", undefined, 1, true],
	] as const)("prices %s with %j across all four counters", (model, tier, multiplier, incomplete) => {
		const view = usageTotalsTracker([entry("a", tier, `openai-codex/${model}`)]).view();
		const priced = priceUsageTotals(view, () => RATES);
		expect(priced.usd).toBe(50 * multiplier);
		expect(priced.pricingIncomplete ?? false).toBe(incomplete);
		expect(view.parent.inputTokens).toBe(ALL.inputTokens);
		expect(priced.serviceTierPricingVersion).toBe(CODEX_SERVICE_TIER_PRICING_VERSION);
	});

	it("accounts summaryUsage receipts like summaries, not retained-tail copies, and preserves missing flags", () => {
		const base = mkTempDir("ink-pricing-e2e-");
		const store = SessionStore.create(path.join(base, "parent.jsonl"), base, "parent");
		store.appendMessage(message(NORMAL));
		const stamps = { modelReference: REF, usagePricing: [pricingSlice(ALL, FAST)] };
		store.appendCompaction("summary", [message(FAST)], 10, ALL, stamps);
		store.appendBranchSummary("branch", ALL, { modelReference: REF });
		store.appendSummaryUsage(ALL, { ...stamps, usageMissing: true });
		const view = usageTotalsTracker(store.getEntries()).view();
		expect(view.parent.calls).toBe(1);
		expect(view.summarizer.calls).toBe(3);
		expect(view.total.inputTokens).toBe(4_000_000);
		expect(view.incomplete).toEqual({ parent: false, child: false, summarizer: true });
		assertConserved(view.byModel[0]?.usagePricing, view.byModel[0]!.bucket);
		expect(priceUsageTotals(view, () => RATES).usd).toBe(350);
		expect(usageTotalsTracker(SessionStore.open(store.filePath).getEntries()).view()).toEqual(view);
	});

	it("unknown rates stay unpriced; zero-rate subscriptions and empty reports never invent charges", () => {
		const unknown = priceUsageTotals(usageTotalsTracker([entry("a", FAST)]).view(), () => undefined);
		expect(unknown.usd).toBe(0);
		expect(unknown.unpriced.calls).toBe(1);
		expect(unknown.serviceTierPricingVersion).toBeUndefined();
		const zero = priceUsageTotals(usageTotalsTracker([entry("a")]).view(), () => ({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			subscription: true,
		}));
		expect(zero.usd).toBe(0);
		expect(zero.subscription).toBe(true);
		expect(zero.pricingIncomplete).toBe(true);
		const empty = entry("a");
		if (empty.type !== "message" || empty.message.role !== "assistant") throw new Error("entry");
		empty.message.usage = { inputTokens: 0, outputTokens: 0 };
		const priced = priceUsageTotals(usageTotalsTracker([empty]).view(), () => RATES);
		expect(priced.pricingIncomplete).toBeUndefined();
		expect(priced.usd).toBe(0);
	});

	it.each(["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const)(
		"marks positive legacy %s as incomplete even when all other counters are zero",
		(counter) => {
			const legacy = entry("legacy");
			if (legacy.type !== "message" || legacy.message.role !== "assistant") throw new Error("entry");
			legacy.message.usage = { inputTokens: 0, outputTokens: 0, [counter]: 1 };
			const priced = priceUsageTotals(usageTotalsTracker([legacy]).view(), () => RATES);
			expect(priced.pricingIncomplete).toBe(true);
			expect(priced.serviceTierPricingVersion).toBe(CODEX_SERVICE_TIER_PRICING_VERSION);
			expect(priced.usd).toBeGreaterThan(0);
		},
	);

	it("rejects malformed ModelUsage sidecars as a whole, pricing the raw bucket once", () => {
		const view = usageTotalsTracker([entry("a", FAST)]).view();
		view.byModel[0]!.usagePricing!.push(pricingSlice(ALL, FAST));
		const priced = priceUsageTotals(view, () => RATES);
		expect(priced.usd).toBe(50);
		expect(priced.pricingIncomplete).toBe(true);
		expect(priced.byModel[0]?.usagePricing).toBeUndefined();
	});

	it("formatting uses ~ for tier uncertainty and ! only for missing usage", () => {
		const args = { usd: 1, subscription: false, unpricedTokens: 0, incomplete: false };
		expect(usageMoneySegment({ ...args, pricingIncomplete: true })).toBe("~$1.000");
		expect(usageMoneySegment({ ...args, pricingIncomplete: true, incomplete: true })).toBe("~$1.000!");
		expect(usageMoneySegment({ ...args, pricingIncomplete: true, unpricedTokens: 2 })).toBe("~$1.000");
		expect(usageMoneySegment({ ...args, usd: 0, subscription: true, pricingIncomplete: true })).toBe(
			"~$0.000 (sub)",
		);
		expect(usageMoneySegment({ ...args, usd: 0, pricingIncomplete: true })).toBe("~$0.000");
		expect(usageMoneySegment({ ...args, usd: 0, unpricedTokens: 2, pricingIncomplete: true })).toBe("$?");
	});
});

describe("child terminal sidecar forwarding", () => {
	it("prices mixed task/summary slices once per deduped child bucket, not once per report", () => {
		const base = mkTempDir("ink-pricing-e2e-");
		const parent = createSession(base, base);
		const usage = {
			inputTokens: 3_000_000,
			outputTokens: 6_000_000,
			cacheReadTokens: 9_000_000,
			cacheWriteTokens: 12_000_000,
			incomplete: true as const,
		};
		const taskRecord = buildTaskRecord({
			...record(),
			usage,
			usagePricing: [pricingSlice(ALL, NORMAL), pricingSlice(ALL, FAST), pricingSlice(ALL)],
		});
		persistTask(parent, { output: "done", taskRecord }, "call");
		persistTask(parent, { output: "duplicate", taskRecord }, "copy");
		const view = usageTotalsTracker(SessionStore.open(parent.filePath).getEntries()).view();
		expect(view.child).toEqual({
			inputTokens: 3_000_000,
			outputTokens: 6_000_000,
			cacheReadTokens: 9_000_000,
			cacheWriteTokens: 12_000_000,
			calls: 1,
		});
		expect(view.summarizer.calls).toBe(0);
		expect(view.incomplete.child).toBe(true);
		assertConserved(view.byModel[0]?.usagePricing, view.byModel[0]!.bucket);
		const priced = priceUsageTotals(view, () => RATES);
		expect(priced.usd).toBe(225);
		expect(priced.pricingIncomplete).toBe(true);
	});

	it.each([false, true])("keeps pricing on a crashed child with childSessions=%s", async (childSessions) => {
		const base = mkTempDir("ink-pricing-e2e-");
		const parent = createSession(base, base);
		const provider = scriptedProvider([message(FAST)], undefined, "openai-codex");
		const task = createTaskTool({
			getProvider: () => provider,
			getModel: () => "gpt-5.5",
			getModelReference: () => REF,
			getSystem: () => "",
			getTools: () => [],
			getSession: () => parent,
			getAutoCompact: () => false,
			childSessions,
			sessionBaseDir: base,
			cwd: base,
			onEvent: (event) => {
				if (event.type === "message_end") throw new Error("observer failed");
			},
		});
		const result = await task.execute({ prompt: "go" }, new AbortController().signal);
		expect(result.taskRecord?.status).toBe("crash");
		assertConserved(result.taskRecord?.usagePricing, result.taskRecord!.usage!);
		persistTask(parent, result, "call");
		persistTask(parent, result, "duplicate-call");
		const view = usageTotalsTracker(SessionStore.open(parent.filePath).getEntries()).view();
		expect(view.child.calls).toBe(1);
		expect(view.child.inputTokens).toBe(ALL.inputTokens);
		expect(priceUsageTotals(view, () => RATES).usd).toBe(125);
	});

	it("fresh and resumed TaskRecords carry only their own conserved attribution after reopen", async () => {
		const base = mkTempDir("ink-pricing-e2e-");
		const parent = createSession(base, base);
		const provider = scriptedProvider([message(FAST), message(NORMAL)], undefined, "openai-codex");
		const task = createTaskTool({
			getProvider: () => provider,
			getModel: () => "gpt-5.5",
			getModelReference: () => REF,
			getSystem: () => "SYSTEM",
			getTools: () => [],
			getSession: () => parent,
			getAutoCompact: () => false,
			childSessions: true,
			sessionBaseDir: base,
			cwd: base,
			getLaunchEnvironment: () => ({
				inkVersion: "9.9.9",
				systemText: "SYSTEM",
				contextFiles: [],
				promptFiles: [],
				extensionContexts: [],
				extensions: [],
			}),
		});
		const first = await task.execute({ prompt: "first" }, new AbortController().signal);
		expect(first.taskRecord?.status).toBe("completed");
		persistTask(parent, first, "first");
		const resumed = await task.execute(
			{ prompt: "second", resume: first.taskRecord?.childId },
			new AbortController().signal,
		);
		expect(resumed.taskRecord?.status).toBe("completed");
		expect(resumed.taskRecord?.childId).toBe(first.taskRecord?.childId);
		expect(resumed.taskRecord?.usage).toEqual(first.taskRecord?.usage);
		expect(first.taskRecord?.usagePricing?.filter((s) => s.serviceTier)).toEqual([pricingSlice(ALL, FAST)]);
		expect(resumed.taskRecord?.usagePricing?.filter((s) => s.serviceTier)).toEqual([
			pricingSlice(ALL, NORMAL),
		]);
		persistTask(parent, resumed, "second");
		const view = usageTotalsTracker(SessionStore.open(parent.filePath).getEntries()).view();
		expect(view.child.calls).toBe(2);
		expect(view.summarizer.calls).toBe(0);
		expect(view.incomplete.child).toBe(false);
		expect(priceUsageTotals(view, () => RATES).usd).toBe(175);
	});
});
