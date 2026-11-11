import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { AssistantMessage } from "../src/core/messages.js";
import * as catalog from "../src/provider/catalog.js";
import { bundledCodexFastModeSupport } from "../src/provider/codex-speed-catalog.js";
import * as discovery from "../src/provider/discover.js";
import {
	canRequestFastMode,
	formatModelSelection,
	parseModelRef,
	parseModelSelection,
	resolveModel,
} from "../src/provider/resolve.js";
import type { LLMRequest } from "../src/provider/types.js";
import { buildModelList, type CommandContext, dispatchCommand } from "../src/repl/commands.js";
import { createRunner } from "../src/runner.js";
import { assistant, makeRenderer, scriptedProvider } from "./helpers/fakes.js";
import { mkTempDir } from "./helpers/mktemp.js";

const MODELS = [
	"gpt-6-astra",
	"gpt-6.1-sol",
	"gpt-6.1-terra",
	"gpt-6-sol",
	"gpt-6-luna",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gpt-5.5",
	"codex-auto-review",
];
const BASE = "openai-codex/gpt-6.1-sol";
const FAST = `${BASE}·fast`;

beforeEach(() => {
	vi.stubEnv("INK_LOG", "0");
	vi.stubEnv("INK_AUTOCOMPACT", "0");
	vi.stubGlobal(
		"fetch",
		vi.fn(() => Promise.reject(new Error("Network forbidden in selection tests"))),
	);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("Fast selection is a mode, not a model", () => {
	it.each([...MODELS, "future-model", "retired-model", "vendor/custom-model"])(
		"keeps the base identity for %s",
		(modelId) => {
			const reference = `openai-codex/${modelId}`;
			const selection = parseModelSelection(` ${reference}·fast `);
			expect(selection).toEqual({ provider: "openai-codex", modelId, speed: "fast" });
			expect(formatModelSelection(reference, selection.speed)).toBe(`${reference}·fast`);
			expect(resolveModel(`${reference}·fast`).modelId).toBe(modelId);
			expect(parseModelSelection(reference)).toEqual({ provider: "openai-codex", modelId });
			expect(canRequestFastMode("openai-codex", modelId)).toBe(true);
		},
	);

	it.each([
		"openai/gpt-6.1-sol·fast",
		"anthropic/claude-sonnet-5·fast",
		"gpt-6.1-sol·fast",
		"openai-codex/·fast",
		`${FAST}·fast`,
		"openai-codex/model with spaces·fast",
	])("rejects structurally invalid Fast %s", (reference) => {
		expect(() => parseModelSelection(reference)).toThrow(/Fast/);
	});

	it.each(["glm-5.3", "vendor/model", "OpenAI/custom", "zai /custom", "custom"])(
		"preserves legacy ordinary routing for %s",
		(reference) => {
			expect(parseModelSelection(reference)).toEqual(parseModelRef(reference));
			expect(formatModelSelection(reference)).toBe(reference);
		},
	);

	it("distinguishes capability from structural request validity", () => {
		expect(bundledCodexFastModeSupport("future-model")).toBeUndefined();
		expect(bundledCodexFastModeSupport("gpt-daybreak-red-latest")).toBe(false);
		expect(parseModelSelection("openai-codex/future-model·fast").speed).toBe("fast");
		expect(parseModelSelection("openai-codex/gpt-daybreak-red-latest·fast").speed).toBe("fast");
	});
});

describe("Fast model picker", () => {
	it("derives every supported account-listed model, not just Sol", async () => {
		const { rows } = await buildModelList("current", {
			configured: (family) => family === "openai-codex",
			discover: async () => [...MODELS, "gpt-daybreak-red-latest", "unknown"],
		});
		expect(rows.map((row) => row.label)).toEqual([
			"current",
			...MODELS.flatMap((id) => [`openai-codex/${id}`, `openai-codex/${id}·fast`]),
			"openai-codex/gpt-daybreak-red-latest",
			"openai-codex/unknown",
		]);
		for (const row of rows.filter((entry) => entry.label.endsWith("·fast"))) {
			expect(row.description).toMatch(/Fast requested/);
			expect(row.description).toMatch(/higher usage/);
			expect(row.description).toMatch(/availability unverified/);
		}
	});

	it("honors explicit account negatives and enables future positives", async () => {
		const support = vi.fn((id: string) =>
			id === "future-model" ? true : id === "gpt-6.1-sol" ? false : undefined,
		);
		const { rows } = await buildModelList(BASE, {
			configured: (family) => family === "openai-codex",
			discover: async () => ["gpt-6.1-sol", "future-model", "unknown"],
			fastModeSupport: support,
		});
		expect(rows.map((row) => row.label)).toEqual([
			BASE,
			"openai-codex/future-model",
			"openai-codex/future-model·fast",
			"openai-codex/unknown",
		]);
		expect(support).toHaveBeenCalledTimes(3);
	});

	it("retains the current Fast selection first and deduplicates rows", async () => {
		const { rows } = await buildModelList(FAST, {
			configured: (family) => family === "openai-codex",
			discover: async () => ["gpt-6-luna", "gpt-6.1-sol", "gpt-6.1-sol"],
		});
		expect(rows[0]?.label).toBe(FAST);
		expect(rows[0]?.description).toMatch(/^current/);
		expect(rows.filter((row) => row.label === FAST)).toHaveLength(1);
		expect(rows.filter((row) => row.label === BASE)).toHaveLength(1);
	});

	it.each([[], null] as const)("does not invent availability for listing %j", async (listed) => {
		const result = await buildModelList("current", {
			configured: (family) => family === "openai-codex",
			discover: async () => (listed === null ? null : []),
			catalogIds: () => MODELS,
			fastModeSupport: () => true,
		});
		expect(result.rows.map((row) => row.label)).toEqual(["current"]);
	});

	it("inherits stale account-list warnings on derived Fast rows", async () => {
		const result = await buildModelList("current", {
			configured: (family) => family === "openai-codex",
			discover: async () => null,
			cachedCodexIds: () => ["gpt-6.1-sol", "gpt-6-luna"],
		});
		expect(result.fallbackNotes.join(" ")).toMatch(/unverified/);
		for (const row of result.rows.slice(1)) expect(row.description).toMatch(/offline\/stale/);
		expect(result.rows.filter((row) => row.label.endsWith("·fast"))).toHaveLength(2);
	});

	it("never adds variants for unconfigured or API-key families", async () => {
		const support = vi.fn(() => true);
		const result = await buildModelList("current", {
			configured: (family) => family === "openai",
			discover: async () => MODELS,
			fastModeSupport: support,
		});
		expect(result.rows.some((row) => row.label.endsWith("·fast"))).toBe(false);
		expect(support).not.toHaveBeenCalled();
	});

	it.each([false, undefined])("retains explicit Fast when its capability becomes %s", async (capability) => {
		const result = await buildModelList(FAST, {
			configured: (family) => family === "openai-codex",
			discover: async () => ["gpt-6.1-sol"],
			fastModeSupport: () => capability,
		});
		expect(result.rows[0]?.label).toBe(FAST);
		expect(result.rows[0]?.description).toMatch(/unverified/);
	});
});

async function commandFixture() {
	const root = mkTempDir("ink-fast-selection-");
	const requests: LLMRequest[] = [];
	const { renderer, output } = makeRenderer();
	const runner = await createRunner({
		cwd: root,
		argv: [],
		model: BASE,
		modelExplicit: true,
		maxTokens: 1024,
		maxTurns: 2,
		thinking: "high",
		noContextFiles: true,
		noSession: true,
		settingsPath: path.join(root, "settings.json"),
		agentsHomeDir: root,
		agentsProjectAllowed: false,
		systemPromptHomeDir: root,
		renderer,
		tools: [],
		provider: scriptedProvider([assistant([{ type: "text", text: "OK" }])], requests, "openai-codex"),
	});
	onTestFinished(() => runner.close());
	const ctx: CommandContext = {
		runner,
		renderer,
		isActive: () => false,
		requestExit: () => undefined,
		abortActive: () => false,
		replay: () => 0,
		submitPrompt: () => undefined,
		hintState: { defaultModelHintShown: false },
	};
	return { runner, ctx, output, requests };
}

describe("/status service tier observations", () => {
	const observed = (serviceTier: unknown, modelReference: string | undefined = BASE): AssistantMessage =>
		({ ...assistant([{ type: "text", text: "answer" }]), modelReference, serviceTier }) as AssistantMessage;

	it.each([undefined, "fast"] as const)(
		"labels the last matching response, not current speed=%s",
		async (speed) => {
			const { runner, ctx, output } = await commandFixture();
			if (speed) await dispatchCommand(`/model ${FAST}`, ctx);
			runner.history.push(
				observed({ requested: "priority", reported: "older" }),
				observed({ requested: "omitted", reported: "default" }),
				observed({ requested: "priority", reported: "other-model" }, "openai-codex/other"),
				observed({ requested: "priority", reported: "other-provider" }, "openai/gpt-6.1-sol"),
			);
			await dispatchCommand("/status", ctx);
			expect(output()).toContain(
				"LAST response service tier · requested omitted · reported default (not confirmation of current selection)",
			);
			expect(output()).not.toMatch(/reported (older|other-model|other-provider)/);
		},
	);

	it.each([undefined, null, {}, { requested: "fast", reported: "default" }, { reported: "default" }])(
		"never substitutes an older report for latest metadata %j",
		async (value) => {
			const { runner, ctx, output } = await commandFixture();
			runner.history.push(observed({ requested: "priority", reported: "older" }), observed(value));
			await dispatchCommand("/status", ctx);
			expect(output()).not.toContain("LAST response service tier");
		},
	);

	it.each([undefined, "default\n", "\u001b[31m", "x".repeat(161), {}])(
		"shows unreported for invalid/missing reported tier %j without stale reuse",
		async (reported) => {
			const { runner, ctx, output } = await commandFixture();
			runner.history.push(
				observed({ requested: "priority", reported: "older" }),
				observed({ requested: "priority", reported }),
			);
			await dispatchCommand("/status", ctx);
			expect(output()).toContain("LAST response service tier · requested priority · reported unreported");
			expect(output()).not.toContain("reported older");
		},
	);

	it("does not infer identity from model/provenance or use another provider's observation", async () => {
		const { runner, ctx, output } = await commandFixture();
		const legacy = observed({ requested: "priority", reported: "legacy" });
		delete legacy.modelReference;
		legacy.model = "gpt-6.1-sol";
		legacy.provenance = { version: 1, provider: "openai-codex", model: "gpt-6.1-sol" };
		runner.history.push(
			legacy,
			observed({ requested: "priority", reported: "foreign" }, "openai/gpt-6.1-sol"),
		);
		await dispatchCommand("/status", ctx);
		expect(output()).not.toContain("LAST response service tier");
		await runner.setModel("openai/gpt-6.1-sol");
		await dispatchCommand("/status", ctx);
		expect(output()).not.toContain("LAST response service tier");
	});
});

describe("Fast selection commands", () => {
	it("manual selection keeps thinking, shows Fast and a preserving default hint, then clears normally", async () => {
		const { runner, ctx, output, requests } = await commandFixture();
		const thinking = runner.thinkingLevel;
		await dispatchCommand(`/model ${FAST}`, ctx);
		expect(runner.modelReference()).toBe(BASE);
		expect(runner.modelSelectionReference()).toBe(FAST);
		expect(runner.thinkingLevel).toBe(thinking);
		expect(output()).toContain(`Model: ${FAST}`);
		expect(output()).toMatch(/higher usage; availability unverified/);
		expect(output()).toContain(`/settings defaultModel ${FAST}`);
		await dispatchCommand("/status", ctx);
		expect(output()).toContain("model gpt-6.1-sol·fast");
		await runner.runTurn({ userMessage: "Reply OK" });
		expect(requests[0]?.model).toBe("gpt-6.1-sol");
		expect(requests[0]?.speed).toBe("fast");
		await dispatchCommand(`/model ${BASE}`, ctx);
		expect(runner.speed).toBeUndefined();
		expect(runner.modelSelectionReference()).toBe(BASE);
	});

	it("the picker uses account-specific capabilities for every model and selects its Fast row", async () => {
		const { runner, ctx } = await commandFixture();
		vi.spyOn(discovery, "familyConfigured").mockImplementation((family) => family === "openai-codex");
		vi.spyOn(discovery, "discoverCodexModels").mockResolvedValue(["gpt-6.1-sol", "future-model"]);
		vi.spyOn(discovery, "codexFastModeSupport").mockImplementation((id) => id === "future-model");
		vi.spyOn(catalog, "refreshCatalog").mockResolvedValue({
			fetched: [],
			skippedFresh: [],
			noCatalog: [],
			failed: [],
		});
		ctx.select = async (options) => {
			const labels = options.items.map((item) => (typeof item === "string" ? item : item.label));
			expect(labels).not.toContain(FAST);
			return labels.indexOf("openai-codex/future-model·fast");
		};
		await dispatchCommand("/model", ctx);
		expect(runner.modelSelectionReference()).toBe("openai-codex/future-model·fast");
		expect(runner.modelReference()).toBe("openai-codex/future-model");
	});
});
