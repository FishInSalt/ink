import { afterEach, describe, expect, it, vi } from "vitest";

// The store's persisted-data readers must not evaluate provider resolution or
// child-model's runtime imports merely to validate accounting metadata.
afterEach(() => {
	vi.doUnmock("../src/provider/resolve.js");
	vi.resetModules();
});

describe("pure model binding validation", () => {
	it("loads SessionStore and TaskRecord without provider runtime resolution", async () => {
		vi.resetModules();
		vi.doMock("../src/provider/resolve.js", () => {
			throw new Error("provider runtime loaded by persisted-data reader");
		});
		const { SessionStore } = await import("../src/core/session/store.js");
		const { snapshotTaskRecord } = await import("../src/core/task-record.js");
		expect(typeof SessionStore.open).toBe("function");
		expect(snapshotTaskRecord({ version: 2 })).toBeUndefined();
	});

	it("keeps the child-model compatibility export and exact derivation predicate", async () => {
		const pure = await import("../src/core/model-binding.js");
		const compatible = await import("../src/core/child-model.js");
		expect(compatible.isModelBinding).toBe(pure.isModelBinding);
		for (const value of [
			null,
			[],
			"model",
			{},
			{ providerName: "", wireModelId: "m", reference: "/m" },
			{ providerName: "openai", wireModelId: "", reference: "openai/" },
			{ providerName: "openai", wireModelId: "m", reference: "other/m" },
		])
			expect(pure.isModelBinding(value)).toBe(false);
		// Do not add known-provider, whitespace or extra-field restrictions.
		expect(
			pure.isModelBinding({
				providerName: "future",
				wireModelId: "a/b",
				reference: "future/a/b",
				extra: true,
			}),
		).toBe(true);
		expect(pure.isModelBinding({ providerName: " ", wireModelId: " ", reference: " / " })).toBe(true);
	});
});
