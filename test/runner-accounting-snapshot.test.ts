import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { estimateContextTokens } from "../src/core/compaction.js";
import type { AssistantMessage, Usage } from "../src/core/messages.js";
import type { ServiceTierReport } from "../src/core/service-tier.js";
import { SessionStore } from "../src/core/session/store.js";
import { priceUsageTotals, usageTotalsTracker } from "../src/core/usage-totals.js";
import { ExtensionRegistry } from "../src/extensions/registry.js";
import type { MessageEndEvent, RunEndEvent } from "../src/extensions/types.js";
import { createRunner, type Runner } from "../src/runner.js";
import { assistant, makeRenderer, scriptedProvider } from "./helpers/fakes.js";
import { mkTempDir } from "./helpers/mktemp.js";

const REF = "openai-codex/gpt-5.5";
const FAST: ServiceTierReport = { requested: "priority", reported: "priority" };
const ALL: Required<Usage> = {
	inputTokens: 1_000_000,
	outputTokens: 2_000_000,
	cacheReadTokens: 3_000_000,
	cacheWriteTokens: 4_000_000,
};
const ALTERED: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const RATES = { input: 1, output: 3, cacheRead: 5, cacheWrite: 7 };

beforeEach(() => {
	vi.stubEnv("INK_LOG", "0");
	vi.stubEnv("INK_AUTOCOMPACT", "0");
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("Network forbidden in runner accounting tests");
		}),
	);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

function sourceMessage(usage: Usage = ALL, missing = false): AssistantMessage {
	return {
		...assistant([{ type: "text", text: "original output" }], "end_turn", { ...usage }),
		serviceTier: { ...FAST },
		...(missing ? { usageMissing: true } : {}),
	};
}

async function makeRunner(
	source: AssistantMessage,
	hooks: { message?: (event: MessageEndEvent) => void; end?: (event: RunEndEvent) => void },
) {
	const base = mkTempDir("ink-runner-");
	const diagnostics: string[] = [];
	const registry = new ExtensionRegistry({ report: (line) => diagnostics.push(line) });
	registry.beginExtension("accounting-probe", "cli");
	if (hooks.message) registry.subscribe("message_end", hooks.message);
	if (hooks.end) registry.subscribe("run_end", hooks.end);
	registry.commitExtension();
	const runner = await createRunner({
		cwd: path.join(base, "project"),
		argv: [],
		model: REF,
		maxTokens: 1024,
		maxTurns: 2,
		noContextFiles: true,
		noSession: false,
		sessionBaseDir: base,
		settingsPath: path.join(base, "settings.json"),
		agentsHomeDir: base,
		agentsProjectAllowed: false,
		systemPromptHomeDir: base,
		renderer: makeRenderer().renderer,
		provider: scriptedProvider([source]),
		extensions: registry,
	});
	onTestFinished(() => runner.close());
	if (!runner.session) throw new Error("expected session");
	return { runner, store: runner.session, diagnostics };
}

function assertStored(store: SessionStore, usage: Usage, missing: boolean, usd: number) {
	const entry = store
		.getEntries()
		.find((item) => item.type === "message" && item.message.role === "assistant");
	if (entry?.type !== "message" || entry.message.role !== "assistant")
		throw new Error("missing stored assistant");
	expect(entry.message.usage).toEqual(usage);
	expect(entry.message.serviceTier).toEqual(FAST);
	expect(entry.message.usageMissing).toBe(missing ? true : undefined);
	expect(entry.message.modelReference).toBe(REF);
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
	const priced = priceUsageTotals(totals, (ref) => (ref === REF ? RATES : undefined));
	expect(priced.usd).toBe(usd);
	expect(priced.pricingIncomplete).toBeUndefined();
	return totals;
}

function assertRunner(runner: Runner, usage: Usage, missing: boolean, usd: number) {
	const accepted = runner.history.find((message) => message.role === "assistant");
	if (accepted?.role !== "assistant") throw new Error("missing live assistant");
	expect(accepted.usage).toEqual(usage);
	expect(accepted.serviceTier).toEqual(FAST);
	expect(accepted.usageMissing).toBe(missing ? true : undefined);
	expect(accepted.modelReference).toBe(REF);
	const store = runner.session!;
	const totals = assertStored(store, usage, missing, usd);
	expect(runner.usageTotals()).toEqual(totals); // Also exercise the cached incremental view.
	expect(assertStored(SessionStore.open(store.filePath), usage, missing, usd)).toEqual(totals);
	const context = estimateContextTokens(runner.history, runner.contextEstimateFloor, REF);
	expect(context.measured).toBe(!missing);
	if (!missing)
		expect(context.tokens).toBe(
			usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
		);
	expect(estimateContextTokens(store.buildContext().messages, 0, REF)).toEqual(context);
	return accepted;
}

function mutateAccounting(message: AssistantMessage, mode: "mutate" | "replace-fields") {
	if (mode === "mutate") {
		Object.assign(message.usage, ALTERED);
		Object.assign(message.serviceTier!, { requested: "omitted", reported: "flex" });
	} else {
		message.usage = { ...ALTERED };
		message.serviceTier = { requested: "omitted", reported: "flex" };
	}
	Reflect.set(message, "usageMissing", message.usageMissing !== true);
	message.model = "extension-wire";
	message.modelReference = "openai-codex/extension-model";
}

describe("SessionStore owns assistant accounting counters", () => {
	it.each(["message", "retained tail"])("detaches usage as well as tier at the %s boundary", (boundary) => {
		const base = mkTempDir("ink-runner-");
		const store = SessionStore.create(path.join(base, "session.jsonl"), base);
		const source = { ...sourceMessage(), modelReference: REF };
		const id =
			boundary === "message" ? store.appendMessage(source) : store.appendCompaction("summary", [source], 100);
		const entry = store.getEntry(id)!;
		const stored =
			entry.type === "message"
				? entry.message
				: entry.type === "compaction"
					? entry.retainedTail[0]
					: undefined;
		if (stored?.role !== "assistant") throw new Error("missing stored assistant");
		expect(stored.usage).not.toBe(source.usage);
		expect(stored.serviceTier).not.toBe(source.serviceTier);
		Object.assign(source.usage, ALTERED);
		source.serviceTier!.reported = "flex";
		expect(stored.usage).toEqual(ALL);
		expect(stored.serviceTier).toEqual(FAST);
		expect(SessionStore.open(store.filePath).getEntry(id)).toEqual(entry);
	});
});

describe("Runner extension accounting payloads", () => {
	it("preserves the reviewer's 1M report and $2.50 estimate when message_end zeroes usage", async () => {
		const usage: Usage = { inputTokens: 1_000_000, outputTokens: 0 };
		const source = sourceMessage(usage);
		const events: string[] = [];
		const { runner, diagnostics } = await makeRunner(source, {
			message: (event) => {
				events.push(event.type);
				event.message.usage.inputTokens = 0;
			},
			end: (event) => events.push(event.type),
		});
		const result = await runner.runTurn({ userMessage: "go" });
		expect(result.usage).toEqual({ ...usage, cacheReadTokens: 0, cacheWriteTokens: 0 });
		assertRunner(runner, usage, false, 2.5);
		expect(source.usage).toEqual(usage);
		expect(source.serviceTier).toEqual(FAST);
		expect(events).toEqual(["message_end", "run_end"]);
		expect(diagnostics).toEqual([]);
	});

	for (const mode of ["mutate", "replace-fields"] as const) {
		it.each([false, true])(
			`${mode} in immediate message_end cannot change captured accounting (missing=%s)`,
			async (missing) => {
				const source = sourceMessage(ALL, missing);
				const { runner, diagnostics } = await makeRunner(source, {
					message: (event) => mutateAccounting(event.message, mode),
				});
				let captured: AssistantMessage | undefined;
				const result = await runner.runTurn({
					userMessage: "go",
					onEvent: (event) => {
						if (event.type === "message_end") captured = event.message;
					},
				});
				expect(captured).toBe(source);
				expect(captured?.usage).toEqual(ALL);
				expect(captured?.serviceTier).toEqual(FAST);
				expect(result.usage).toEqual(ALL);
				assertRunner(runner, ALL, missing, 125);
				expect(diagnostics).toEqual([]);
			},
		);
	}

	it.each([false, true])(
		"isolates retained message/counter/tier objects after completion (missing=%s)",
		async (missing) => {
			const source = sourceMessage(ALL, missing);
			let retained: AssistantMessage | undefined;
			let counters: Usage | undefined;
			let tier: ServiceTierReport | undefined;
			const { runner, diagnostics } = await makeRunner(source, {
				message: (event) => {
					retained = event.message;
					counters = event.message.usage;
					tier = event.message.serviceTier;
				},
			});
			const result = await runner.runTurn({ userMessage: "go" });
			const accepted = assertRunner(runner, ALL, missing, 125);
			expect(retained).not.toBe(accepted);
			expect(counters).not.toBe(accepted.usage);
			expect(tier).not.toBe(accepted.serviceTier);
			await new Promise<void>((resolve) =>
				setImmediate(() => {
					Object.assign(counters!, ALTERED);
					tier!.requested = "omitted";
					tier!.reported = "flex";
					mutateAccounting(retained!, "replace-fields");
					resolve();
				}),
			);
			expect(counters).toEqual(ALTERED);
			expect(tier?.reported).toBe("flex");
			expect(source.usage).toEqual(ALL);
			expect(source.serviceTier).toEqual(FAST);
			expect(result.usage).toEqual(ALL);
			assertRunner(runner, ALL, missing, 125);
			expect(diagnostics).toEqual([]);
		},
	);

	it("keeps shared content blocks and post-persistence event ordering without accounting aliases", async () => {
		const source = sourceMessage();
		let blocks: AssistantMessage["blocks"] | undefined;
		let assertPersisted: (() => void) | undefined;
		const { runner, diagnostics } = await makeRunner(source, {
			message: (event) => {
				assertPersisted!();
				blocks = event.message.blocks;
				const first = event.message.blocks[0];
				if (first?.type === "text") first.text = "extension content";
			},
		});
		assertPersisted = () => {
			expect(runner.session!.getEntries().filter((entry) => entry.type === "message")).toHaveLength(2);
			expect(runner.history.at(-1)?.role).toBe("assistant");
		};
		await runner.runTurn({ userMessage: "go" });
		const accepted = assertRunner(runner, ALL, false, 125);
		expect(accepted.blocks).toBe(blocks);
		expect(accepted.blocks).toBe(source.blocks);
		expect(accepted.blocks).toEqual([{ type: "text", text: "extension content" }]);
		expect(diagnostics).toEqual([]);
	});

	it.each(["immediate", "retained"])(
		"run_end %s counter mutation cannot change the returned report",
		async (timing) => {
			const source = sourceMessage();
			let retained: Usage | undefined;
			const { runner, diagnostics } = await makeRunner(source, {
				end: (event) => {
					retained = event.usage;
					if (timing === "immediate") Object.assign(event.usage, ALTERED);
				},
			});
			const result = await runner.runTurn({ userMessage: "go" });
			if (timing === "retained")
				await new Promise<void>((resolve) =>
					setImmediate(() => {
						Object.assign(retained!, ALTERED);
						resolve();
					}),
				);
			expect(retained).not.toBe(result.usage);
			expect(retained).toEqual(ALTERED);
			expect(result.usage).toEqual(ALL);
			assertRunner(runner, ALL, false, 125);
			expect(diagnostics).toEqual([]);
		},
	);
});
