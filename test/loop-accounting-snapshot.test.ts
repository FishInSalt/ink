import path from "node:path";
import { describe, expect, it } from "vitest";
import { type AgentEvent, runAgentLoop } from "../src/core/loop.js";
import type { AgentMessage, AssistantMessage, Usage } from "../src/core/messages.js";
import type { ServiceTierReport } from "../src/core/service-tier.js";
import { SessionStore } from "../src/core/session/store.js";
import { priceUsageTotals, usageTotalsTracker } from "../src/core/usage-totals.js";
import { assistant, scriptedProvider } from "./helpers/fakes.js";
import { mkTempDir } from "./helpers/mktemp.js";

const REF = "openai-codex/gpt-5.5";
const FAST: ServiceTierReport = { requested: "priority", reported: "priority" };
const ALL: Usage = {
	inputTokens: 1_000_000,
	outputTokens: 2_000_000,
	cacheReadTokens: 3_000_000,
	cacheWriteTokens: 4_000_000,
};
const ALTERED: Usage = { inputTokens: 7, outputTokens: 8, cacheReadTokens: 9, cacheWriteTokens: 10 };
const RATES = { input: 1, output: 3, cacheRead: 5, cacheWrite: 7 };

function sourceMessage(usage: Usage = ALL, missing = false): AssistantMessage {
	return {
		...assistant([{ type: "text", text: "original output" }], "end_turn", { ...usage }),
		serviceTier: { ...FAST },
		model: "provider-wire",
		modelReference: "provider/unstamped",
		...(missing ? { usageMissing: true } : {}),
	};
}

async function runParent(source: AssistantMessage, onEvent: (event: AgentEvent) => void) {
	const base = mkTempDir("ink-pricing-e2e-");
	const store = SessionStore.create(path.join(base, "parent.jsonl"), base, "parent");
	const history: AgentMessage[] = [];
	const result = await runAgentLoop({
		provider: scriptedProvider([source]),
		model: "gpt-5.5",
		modelReference: REF,
		system: "",
		tools: [],
		history,
		userMessage: "go",
		onMessage: (message) => {
			store.appendMessage(message);
		},
		onEvent,
	});
	const accepted = history.find((message) => message.role === "assistant");
	if (accepted?.role !== "assistant") throw new Error("missing accepted parent assistant");
	return { store, history, result, accepted };
}

function assertParentStore(
	store: SessionStore,
	usage: Usage,
	serviceTier: ServiceTierReport | undefined,
	missing: boolean,
	usd: number,
): void {
	const persisted = store
		.getEntries()
		.find((entry) => entry.type === "message" && entry.message.role === "assistant");
	if (persisted?.type !== "message" || persisted.message.role !== "assistant")
		throw new Error("missing persisted parent assistant");
	expect(persisted.message.usage).toEqual(usage);
	expect(persisted.message.serviceTier).toEqual(serviceTier);
	expect(Object.hasOwn(persisted.message, "serviceTier")).toBe(serviceTier !== undefined);
	expect(persisted.message.usageMissing).toBe(missing ? true : undefined);
	expect(Object.hasOwn(persisted.message, "usageMissing")).toBe(missing);
	expect(persisted.message.model).toBe("gpt-5.5");
	expect(persisted.message.modelReference).toBe(REF);
	const counters = {
		...usage,
		cacheReadTokens: usage.cacheReadTokens ?? 0,
		cacheWriteTokens: usage.cacheWriteTokens ?? 0,
	};
	expect(store.stats()).toMatchObject(counters);
	const totals = usageTotalsTracker(store.getEntries()).view();
	expect(totals.parent).toEqual({ ...counters, calls: 1 });
	expect(totals.total).toEqual(totals.parent);
	expect(totals.incomplete).toEqual({ parent: missing, child: false, summarizer: false });
	const priced = priceUsageTotals(totals, () => RATES);
	expect(priced.usd).toBe(usd);
	expect(priced.pricingIncomplete ?? false).toBe(serviceTier === undefined);
}

describe("parent message accounting snapshots before observers", () => {
	it("preserves the reviewer's gpt-5.5 priority estimate when an observer changes the report to flex", async () => {
		const usage = { inputTokens: 1_000_000, outputTokens: 0 };
		const source = sourceMessage(usage);
		const { store, result, accepted } = await runParent(source, (event) => {
			if (event.type !== "message_end") return;
			expect(event.message).toBe(source);
			event.message.serviceTier!.reported = "flex";
			// Output observer behavior remains unchanged; only accounting is captured.
			event.message.blocks = [{ type: "text", text: "observer output" }];
		});
		expect(priceUsageTotals(usageTotalsTracker(store.getEntries()).view(), () => RATES).usd).toBe(2.5);
		expect(accepted.blocks).toEqual([{ type: "text", text: "observer output" }]);
		expect(result.usage).toEqual({ ...usage, cacheReadTokens: 0, cacheWriteTokens: 0 });
		expect(accepted.usage).not.toBe(source.usage);
		expect(accepted.serviceTier).not.toBe(source.serviceTier);
		assertParentStore(store, usage, FAST, false, 2.5);
		assertParentStore(SessionStore.open(store.filePath), usage, FAST, false, 2.5);
	});

	for (const mode of ["mutate", "replace-fields", "replace-message"] as const) {
		for (const flagChange of ["flip", "delete"] as const) {
			it.each([false, true])(
				`${mode}, ${flagChange} missing flag (original missing=%s) cannot change accepted facts`,
				async (missing) => {
					const source = sourceMessage(ALL, missing);
					const { store, result, accepted } = await runParent(source, (event) => {
						if (event.type !== "message_end") return;
						if (mode === "mutate") {
							Object.assign(event.message.usage, ALTERED);
							Object.assign(event.message.serviceTier!, { requested: "omitted", reported: "flex" });
						} else if (mode === "replace-fields") {
							event.message.usage = { ...ALTERED };
							event.message.serviceTier = { requested: "omitted", reported: "flex" };
						} else {
							event.message = {
								...event.message,
								usage: { ...ALTERED },
								serviceTier: { requested: "omitted", reported: "flex" },
							};
						}
						if (flagChange === "delete") delete event.message.usageMissing;
						else Reflect.set(event.message, "usageMissing", !missing);
						event.message.model = "observer-wire";
						event.message.modelReference = "observer/reference";
					});
					expect(result.usage).toEqual(ALL);
					expect(accepted.usage).toEqual(ALL);
					expect(accepted.serviceTier).toEqual(FAST);
					expect(accepted.usageMissing).toBe(missing ? true : undefined);
					assertParentStore(store, ALL, FAST, missing, 125);
					assertParentStore(SessionStore.open(store.filePath), ALL, FAST, missing, 125);
				},
			);
		}
	}

	it.each([
		["absent", undefined],
		["invalid reported type", { requested: "priority", reported: 42 }],
		["invalid reported spelling", { requested: "priority", reported: "!" }],
	] as const)(
		"captures %s attribution strictly before an observer supplies valid priority",
		async (_name, tier) => {
			const source = sourceMessage();
			if (tier === undefined) delete source.serviceTier;
			else source.serviceTier = tier as unknown as ServiceTierReport;
			const { store, accepted } = await runParent(source, (event) => {
				if (event.type === "message_end") event.message.serviceTier = { ...FAST };
			});
			expect(accepted.serviceTier).toBeUndefined();
			assertParentStore(store, ALL, undefined, false, 50);
			assertParentStore(SessionStore.open(store.filePath), ALL, undefined, false, 50);
		},
	);

	it.each([false, true])(
		"isolates accepted/history/live/reopened facts from delayed retained-object mutations (missing=%s)",
		async (missing) => {
			const source = sourceMessage(ALL, missing);
			let mutateLater: (() => void) | undefined;
			const { store, result, accepted } = await runParent(source, (event) => {
				if (event.type !== "message_end") return;
				const retainedMessage = event.message;
				const retainedUsage = event.message.usage;
				const retainedTier = event.message.serviceTier!;
				mutateLater = () => {
					Object.assign(retainedUsage, ALTERED);
					retainedTier.requested = "omitted";
					retainedTier.reported = "flex";
					Reflect.set(retainedMessage, "usageMissing", !missing);
				};
			});
			assertParentStore(store, ALL, FAST, missing, 125);
			assertParentStore(SessionStore.open(store.filePath), ALL, FAST, missing, 125);
			await new Promise<void>((resolve) =>
				setImmediate(() => {
					mutateLater!();
					resolve();
				}),
			);
			expect(source.usage).toEqual(ALTERED);
			expect(source.serviceTier?.reported).toBe("flex");
			expect(accepted.usage).toEqual(ALL);
			expect(accepted.serviceTier).toEqual(FAST);
			expect(accepted.usageMissing).toBe(missing ? true : undefined);
			expect(result.usage).toEqual(ALL);
			assertParentStore(store, ALL, FAST, missing, 125);
			assertParentStore(SessionStore.open(store.filePath), ALL, FAST, missing, 125);
		},
	);
});
