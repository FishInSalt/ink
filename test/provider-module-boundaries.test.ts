import { afterEach, describe, expect, it, vi } from "vitest";

const runtimeModules = [
	"../src/provider/resolve.js",
	"../src/provider/anthropic.js",
	"../src/provider/openai-completions.js",
	"../src/provider/codex-responses.js",
	"../src/provider/thinking.js",
];

afterEach(() => {
	for (const module of runtimeModules) vi.doUnmock(module);
	vi.resetModules();
});

describe("provider dependency direction", () => {
	it("pure references, catalog and child model routing do not load provider constructors or thinking", async () => {
		vi.resetModules();
		for (const module of runtimeModules) {
			vi.doMock(module, () => {
				throw new Error(`unexpected runtime dependency: ${module}`);
			});
		}
		const ref = await import("../src/provider/model-ref.js");
		const catalog = await import("../src/provider/catalog.js");
		const child = await import("../src/core/child-model.js");
		expect(ref.parseModelRef(" OpenAI/gpt-5.2 ")).toEqual({ provider: "openai", modelId: "gpt-5.2" });
		expect(ref.parseModelRef("glm-5.3").provider).toBe("zai");
		expect(ref.knownProvider("zai ")).toBeUndefined();
		expect(ref.parseModelRef(" custom/id ").modelId).toBe(" custom/id ");
		expect(ref.parseModelSelection("openai-codex/custom·fast")).toEqual({
			provider: "openai-codex",
			modelId: "custom",
			speed: "fast",
		});
		expect(ref.formatModelSelection("openai-codex/custom", "fast")).toBe("openai-codex/custom·fast");
		expect(catalog.catalogEntryForReference("glm-5.3")).toBeNull();
		expect(child.resolveChildModel({ parentReference: "openai/gpt-5.2" }).ok).toBe(true);
	});

	it("metadata and core consumers do not import resolve's provider construction", async () => {
		vi.resetModules();
		vi.doMock("../src/provider/resolve.js", () => {
			throw new Error("provider resolver loaded");
		});
		const models = await import("../src/provider/models.js");
		const limits = await import("../src/provider/model-limits.js");
		const child = await import("../src/core/child-model.js");
		expect(models.costFor("anthropic/claude-sonnet-4-5")?.input).toBe(3);
		expect(limits.modelMaxTokensFor("anthropic/claude-opus-4-6")).toBe(128_000);
		expect(child.resolveChildModel({ parentReference: "anthropic/claude-opus-4-6" }).ok).toBe(true);
	});

	it("resolve preserves helper identity; catalog does not re-export model-limits", async () => {
		const pure = await import("../src/provider/model-ref.js");
		const compatible = await import("../src/provider/resolve.js");
		for (const name of [
			"knownProvider",
			"parseModelRef",
			"parseModelSelection",
			"formatModelSelection",
			"qualifiedReference",
			"canRequestFastMode",
		] as const) {
			expect(compatible[name]).toBe(pure[name]);
		}
		const catalog = await import("../src/provider/catalog.js");
		expect(catalog).not.toHaveProperty("modelMaxTokensFor");
	});
});
