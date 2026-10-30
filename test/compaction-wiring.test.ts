import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompactionSettings } from "../src/core/compaction.js";
import type { LLMRequest } from "../src/provider/types.js";
import { assistant, makeRenderer, scriptedProvider, user } from "./helpers/fakes.js";
import { mkTempDir } from "./helpers/mktemp.js";

let base: string;
beforeEach(async () => {
	base = mkTempDir("ink-compaction-wiring-");
	vi.stubEnv("INK_LOG", "0");
	vi.stubEnv("INK_CONTEXT_WINDOW", undefined);
	vi.stubEnv("INK_KEEP_RECENT", "1");
	vi.stubEnv("INK_AUTOCOMPACT", "1");
	vi.stubEnv("INK_CATALOG_PATH", join(base, "catalog.json"));
	vi.resetModules();
	writeFileSync(
		join(base, "catalog.json"),
		JSON.stringify({
			version: 1,
			providers: {
				anthropic: {
					checkedAt: Date.now(),
					models: {
						shared: { id: "shared", contextWindow: 1000000 },
						small: { id: "small", contextWindow: 100000 },
					},
				},
				openai: {
					checkedAt: Date.now(),
					models: {
						"vendor/small": { id: "vendor/small", contextWindow: 100000 },
					},
				},
				zai: {
					checkedAt: Date.now(),
					models: {
						shared: { id: "shared", contextWindow: 100000 },
					},
				},
			},
		}),
	);
	const { loadCatalogCache } = await import("../src/provider/catalog.js");
	loadCatalogCache();
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

const echo = {
	name: "echo",
	description: "echo",
	parameters: Type.Object({}),
	async execute() {
		return { output: "done" };
	},
};
function childScript(compacts: boolean) {
	const first = assistant([{ type: "toolCall" as const, id: "t", name: "echo", arguments: {} }]);
	// #compaction-thinking-retry: the fixture context must sit BETWEEN the
	// catalog-100k threshold (min(85k, 100k − 32,768) = 67,232) and the legacy
	// DEFAULT threshold (131,072 − 32,768 = 98,304), so the cross-provider /
	// no-reference cases (legacy settings → no compact) still discriminate
	// against the catalog cases (compact).
	first.usage = { inputTokens: 90000, outputTokens: 1 };
	return [
		first,
		...(compacts ? [assistant([{ type: "text" as const, text: "SUMMARY" }])] : []),
		assistant([{ type: "text" as const, text: "FINAL" }]),
	];
}

describe("child model-aware compaction wiring", () => {
	it.each([
		["anthropic/shared", false],
		["zai/shared", true],
	])("standalone reference %s disambiguates the same wire model", async (modelReference, compacts) => {
		const { runSubagent } = await import("../src/core/subagent.js");
		const requests: LLMRequest[] = [];
		const result = await runSubagent({
			provider: scriptedProvider(childScript(compacts), requests),
			model: "shared",
			modelReference,
			system: "test",
			tools: [echo],
			prompt: "go",
			autoCompact: true,
		});
		expect(result.text).toBe("FINAL");
		expect(requests).toHaveLength(compacts ? 3 : 2);
		expect(requests.every((r) => r.model === "shared")).toBe(true);
	});

	it("bare slash model uses the parent provider's catalog threshold", async () => {
		const { compactionSettingsFor } = await import("../src/provider/compaction-settings.js");
		expect(compactionSettingsFor("openai/vendor/small")).toMatchObject({
			contextWindow: 100000,
			triggerTokens: 67232,
		});
	});

	it("explicit settings remain authoritative over model metadata", async () => {
		const { runSubagent } = await import("../src/core/subagent.js");
		const requests: LLMRequest[] = [];
		const settings: CompactionSettings = {
			contextWindow: 1000000,
			reserveTokens: 16384,
			keepRecentTokens: 1,
		};
		const result = await runSubagent({
			provider: scriptedProvider(childScript(false), requests),
			model: "shared",
			modelReference: "zai/shared",
			system: "test",
			tools: [echo],
			prompt: "go",
			autoCompact: true,
			settings,
		});
		expect(result.text).toBe("FINAL");
		expect(requests).toHaveLength(2);
	});

	it.each([
		// [parent reference, agent override, compacts, expected wire model]
		["anthropic/shared", undefined, false, "shared"],
		["zai/shared", undefined, true, "shared"],
		["anthropic/shared", "small", true, "small"],
		["openai/shared", "vendor/small", true, "vendor/small"],
		// SA-02 C3: the same-provider prefix is stripped for the request.
		["anthropic/shared", "anthropic/small", true, "small"],
		// SA-02 D1 fallback: parent derived from "shared" = anthropic/shared,
		// so the override is same-provider (C3) — wire "small" and the settings
		// come from the canonical anthropic/small window (100k → compacts).
		[undefined, "anthropic/small", true, "small"],
		[undefined, "small", true, "small"],
	] as const)(
		"task reference %s override %s compacts=%s wire=%s",
		async (reference, override, compacts, wire) => {
			const { createTaskTool } = await import("../src/core/tools/task.js");
			const requests: LLMRequest[] = [];
			const tool = createTaskTool({
				getProvider: () => scriptedProvider(childScript(compacts), requests),
				getModel: () => "shared",
				getModelReference: reference ? () => reference : undefined,
				getSystem: () => "test",
				getTools: () => [echo],
				getSession: () => null,
				getAutoCompact: () => true,
				childSessions: false,
				agents: [{ name: "worker", description: "test", system: "", source: "test", model: override }],
			});
			const result = await tool.execute({ prompt: "go", agent: "worker" }, new AbortController().signal);
			expect(result.isError).toBe(false);
			expect(result.output).toContain("FINAL");
			expect(requests).toHaveLength(compacts ? 3 : 2);
			expect(requests.every((r) => r.model === wire)).toBe(true);
		},
	);

	it("SA-02 C4: a cross-provider override is rejected before launch — zero provider calls", async () => {
		const { createTaskTool } = await import("../src/core/tools/task.js");
		const requests: LLMRequest[] = [];
		const tool = createTaskTool({
			getProvider: () => scriptedProvider(childScript(false), requests),
			getModel: () => "shared",
			getModelReference: () => "anthropic/shared",
			getSystem: () => "test",
			getTools: () => [echo],
			getSession: () => null,
			getAutoCompact: () => true,
			childSessions: false,
			agents: [{ name: "worker", description: "test", system: "", source: "test", model: "zai/shared" }],
		});
		const result = await tool.execute({ prompt: "go", agent: "worker" }, new AbortController().signal);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("Cross-provider subagents are not supported");
		expect(requests).toHaveLength(0);
	});
});

describe("Runner model-aware compaction wiring", () => {
	it("construction and model switching refresh actual ratio thresholds", async () => {
		const { createRunner } = await import("../src/runner.js");
		const { createSession } = await import("../src/core/session/manager.js");
		const cwd = join(base, "project");
		const store = createSession(cwd, base);
		store.appendMessage({ role: "user", content: "seed" });
		const seed = assistant([{ type: "text", text: "seed answer" }]);
		seed.usage = { inputTokens: 900000, outputTokens: 1 };
		store.appendMessage(seed);
		const requests: LLMRequest[] = [];
		const provider = scriptedProvider(
			[
				assistant([{ type: "text", text: "SUMMARY" }]),
				assistant([{ type: "text", text: "reply" }]),
				...childScript(true).slice(1),
			],
			requests,
		);
		const { renderer } = makeRenderer();
		const runner = await createRunner({
			cwd,
			argv: [],
			model: "anthropic/shared",
			maxTokens: 1024,
			maxTurns: 5,
			noContextFiles: true,
			noSession: false,
			resume: store.header.id,
			sessionBaseDir: base,
			renderer,
			provider,
			agentsHomeDir: base,
		});
		await runner.runTurn({ userMessage: "continue" });
		expect(requests).toHaveLength(2); // 900k > 850k, but below the former 983616 trigger
		expect(runner.history[0]).toMatchObject({ role: "user", content: expect.stringContaining("SUMMARY") });
		runner.setModel("anthropic/small");
		// Add a fresh usage anchor after the previous summary boundary.
		const high = assistant([{ type: "text", text: "more" }]);
		high.usage = { inputTokens: 90000, outputTokens: 1 };
		runner.history.push({ role: "user", content: "next" }, high);
		runner.session?.appendMessage({ role: "user", content: "next" });
		runner.session?.appendMessage(high);
		await runner.runTurn({ userMessage: "continue again" });
		expect(requests).toHaveLength(4);
		expect(requests.slice(2).every((r) => r.model === "small")).toBe(true);
	});
});

describe("Runner Responses target-aware compaction wiring", () => {
	function encryptedAssistant(outputTokens: number) {
		const identity = { version: 1 as const, provider: "openai-codex" as const };
		return {
			...assistant(
				[
					{
						type: "thinking",
						thinking: "",
						responses: { ...identity, itemId: "rs_hidden", summary: [], encryptedContent: "FAKE_CIPHER" },
					},
					{ type: "text", text: "visible" },
				],
				"end_turn",
				{ inputTokens: 90000, outputTokens },
			),
			provenance: { ...identity, model: "shared" },
			modelReference: "openai-codex/shared",
		};
	}

	it.each(["openai-codex/other", "anthropic/shared"])(
		"switching to %s avoids false compaction and switching back restores hidden accounting",
		async (otherReference) => {
			vi.stubEnv("INK_CONTEXT_WINDOW", "100000");
			const { createSession } = await import("../src/core/session/manager.js");
			const cwd = join(base, "project");
			const store = createSession(cwd, base);
			const native = encryptedAssistant(90000);
			// Ciphertext retained below the boundary still invalidates newer
			// usage anchors from calls that omitted it while switched away.
			store.appendCompaction("previous checkpoint", [user("old work"), native], 180000);
			store.appendMessage(user("new work"));
			const requests: LLMRequest[] = [];
			const provider = scriptedProvider(
				["away", "SUMMARY", "back"].map((text) => assistant([{ type: "text", text }])),
				requests,
				"not-a-provider-family",
			);
			const routing = await import("../src/provider/resolve.js");
			vi.spyOn(routing, "createProviderFor").mockReturnValue(provider);
			const { createRunner } = await import("../src/runner.js");
			const { renderer, output } = makeRenderer();
			const runner = await createRunner({
				cwd,
				argv: [],
				model: "openai-codex/shared",
				maxTokens: 1024,
				maxTurns: 3,
				noContextFiles: true,
				noSession: false,
				resume: store.header.id,
				sessionBaseDir: base,
				renderer,
				provider,
				agentsHomeDir: base,
			});
			try {
				expect(runner.contextEstimateFloor).toBe(3);
				expect(output()).toContain("~90k tokens (compacted)");
				runner.setModel(otherReference);
				await runner.runTurn({ userMessage: "away" });
				expect(requests).toHaveLength(1);
				expect(requests[0]?.model).toBe(otherReference.split("/")[1]);
				expect(runner.history).toContainEqual(native);
				expect(runner.session?.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);

				runner.setModel("openai-codex/shared");
				await runner.runTurn({
					userMessage: "back",
					getSteeringMessages: () => {
						// A switch after run-entry must not change its captured target.
						runner.setModel(otherReference);
						return [];
					},
				});
				expect(requests).toHaveLength(3);
				expect(requests[1]).toMatchObject({ model: "shared", tools: [] });
				expect(requests[2]?.model).toBe("shared");
				expect(runner.history[0]).toMatchObject({
					role: "user",
					content: expect.stringContaining("SUMMARY"),
				});
				const compactions = runner.session?.getEntries().filter((entry) => entry.type === "compaction");
				expect(compactions).toHaveLength(2);
				expect(compactions?.at(-1)).toMatchObject({ modelReference: "openai-codex/shared" });
			} finally {
				runner.close();
			}
		},
	);

	it.each([
		["openai-codex", "not-a-provider-family", 2000],
		["anthropic", "openai-codex", 2],
	] as const)(
		"manual compaction uses declared %s target, not provider.name=%s, for the boundary, cut and tokensAfter",
		async (family, providerName, nativeTokens) => {
			vi.stubEnv("INK_CONTEXT_WINDOW", "100000");
			vi.stubEnv("INK_KEEP_RECENT", "1000");
			const compaction = await import("../src/core/compaction.js");
			const compactSession = vi.spyOn(compaction, "compactSession");
			const { createSession } = await import("../src/core/session/manager.js");
			const cwd = join(base, "project");
			const store = createSession(cwd, base);
			const stale = assistant([{ type: "text", text: "x".repeat(4800) }], "end_turn", {
				inputTokens: 90000,
				outputTokens: 1,
			});
			const native = encryptedAssistant(2000);
			// A 1k keep budget stops at native reasoning only for the exact target;
			// canonical fallback must also keep the preceding 1.2k text message.
			store.appendCompaction("previous checkpoint", [user("old work"), stale, native], 99999);
			store.appendMessage(user("tail"));
			const tokensBefore =
				compaction.estimateTokens(store.buildContext().messages[0]!) + 2 + 1200 + nativeTokens + 1;
			const retainedTail = family === "openai-codex" ? [native, user("tail")] : [stale, native, user("tail")];
			const tokensAfter = 2 + (family === "openai-codex" ? 0 : 1200) + nativeTokens + 1;
			const requests: LLMRequest[] = [];
			const provider = scriptedProvider(
				[assistant([{ type: "text", text: "SUMMARY" }])],
				requests,
				providerName,
			);
			const { createRunner } = await import("../src/runner.js");
			const { renderer } = makeRenderer();
			const target = `${family}/shared`;
			const runner = await createRunner({
				cwd,
				argv: [],
				model: target,
				maxTokens: 1024,
				maxTurns: 3,
				noContextFiles: true,
				noSession: false,
				resume: store.header.id,
				sessionBaseDir: base,
				renderer,
				provider,
				agentsHomeDir: base,
			});
			try {
				expect(runner.contextEstimateFloor).toBe(4);
				expect(await runner.compactNow()).toBe("compacted");
				expect(compactSession).toHaveBeenCalledExactlyOnceWith(
					expect.objectContaining({ model: "shared", modelReference: target }),
				);
				expect(await compactSession.mock.results[0]?.value).toMatchObject({
					tokensBefore,
					tokensAfter,
					retainedCount: retainedTail.length,
				});
				expect(runner.history.slice(1)).toEqual(retainedTail);
				expect(runner.session?.getEntries().at(-1)).toMatchObject({
					type: "compaction",
					modelReference: target,
					tokensBefore,
					retainedTail,
				});
				expect(requests).toHaveLength(1);
				expect(requests[0]).toMatchObject({ model: "shared", tools: [] });
				expect(JSON.stringify(requests[0])).not.toMatch(/FAKE_CIPHER|rs_hidden|provenance|encryptedContent/);
			} finally {
				runner.close();
			}
		},
	);
});
