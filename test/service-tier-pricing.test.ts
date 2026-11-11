import { describe, expect, it } from "vitest";
import type { Usage } from "../src/core/messages.js";
import {
	CODEX_SERVICE_TIER_PRICING_SOURCE,
	CODEX_SERVICE_TIER_PRICING_VERSION,
	parsePricingServiceTier,
	parseUsagePricing,
	pricingSlice,
	serviceTierPricing,
} from "../src/core/service-tier-pricing.js";

const usage: Usage = { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 };

describe("Codex reference service-tier pricing", () => {
	it.each([
		["gpt-5.5", "default", 2.5],
		["gpt-5.5", undefined, 2.5],
		["gpt-6.1-sol", "priority", 2],
		["future-model-v99", "default", 2],
		["gpt-5.5-snapshot", "fast", 2],
		["gpt-5.5", "fast", 2.5],
		["gpt-5.5", "flex", 0.5],
		["gpt-6.1-sol", "standard", 1],
		["gpt-6.1-sol", "auto", 1],
		["gpt-6.1-sol", "scale", 1],
	] as const)("prices %s reported %s as reference multiplier %s", (model, reported, multiplier) => {
		const report = { requested: "priority" as const, ...(reported === undefined ? {} : { reported }) };
		expect(serviceTierPricing(`openai-codex/${model}`, report)).toEqual({
			multiplier,
			incomplete: false,
			version: CODEX_SERVICE_TIER_PRICING_VERSION,
		});
		expect(report.reported).toBe(reported);
	});

	it("pins the source while keeping raw counters and observations unchanged", () => {
		expect(CODEX_SERVICE_TIER_PRICING_VERSION).toBe("pi-2cac4f1a9");
		expect(CODEX_SERVICE_TIER_PRICING_SOURCE).toContain("2cac4f1a934cdc4a80b05a7d8ff2543cf5ee623c");
		const report = { requested: "priority" as const, reported: "default" };
		const slice = pricingSlice(usage, report);
		serviceTierPricing("openai-codex/gpt-5.5", slice.serviceTier);
		expect(usage).toEqual({ inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 });
		expect(report.reported).toBe("default");
		expect(slice.usage).not.toBe(usage);
		expect(slice.serviceTier).not.toBe(report);
	});

	it("keeps omitted request separate from legacy absence", () => {
		expect(
			serviceTierPricing("openai-codex/gpt-5.5", { requested: "omitted", reported: "default" }).multiplier,
		).toBe(1);
		expect(serviceTierPricing("openai-codex/gpt-5.5", { requested: "omitted" }).incomplete).toBe(false);
		expect(serviceTierPricing("openai-codex/gpt-5.5")).toMatchObject({ multiplier: 1, incomplete: true });
	});

	it("leaves unknown tiers base-only and incomplete", () => {
		expect(
			serviceTierPricing("openai-codex/gpt-5.5", { requested: "priority", reported: "future_tier" }),
		).toMatchObject({ multiplier: 1, incomplete: true });
	});

	it.each([null, "openai/gpt-5.5", "anthropic/gpt-5.5", "custom/gpt-5.5"])(
		"never applies Codex multipliers to %s",
		(reference) => {
			expect(serviceTierPricing(reference, { requested: "priority", reported: "priority" })).toEqual({
				multiplier: 1,
				incomplete: false,
			});
		},
	);
});

describe("persisted pricing sidecar boundary", () => {
	it.each([
		null,
		[],
		{},
		{ requested: "normal" },
		{ requested: "priority", reported: "" },
		{ requested: "priority", reported: "bad\nvalue" },
		{ requested: "priority", reported: null },
		{ requested: "priority", reported: "x".repeat(161) },
	])("strictly rejects malformed observation %j", (value) => {
		expect(parsePricingServiceTier(value)).toBeUndefined();
	});

	it("validates conservation in all four categories and copies nested metadata", () => {
		const slices = [pricingSlice(usage, { requested: "priority", reported: "default" })];
		const parsed = parseUsagePricing(slices, usage);
		expect(parsed).toEqual(slices);
		expect(parsed).not.toBe(slices);
		expect(parsed?.[0]?.usage).not.toBe(slices[0]?.usage);
		expect(parsed?.[0]?.serviceTier).not.toBe(slices[0]?.serviceTier);
		for (const counter of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const) {
			expect(parseUsagePricing(slices, { ...usage, [counter]: (usage[counter] ?? 0) + 1 })).toBeUndefined();
		}
	});

	it.each([-1, NaN, Infinity, "10", null])(
		"rejects invalid slice counters %s without mutating aggregate",
		(value) => {
			const bad = [{ usage: { ...usage, inputTokens: value } }];
			expect(parseUsagePricing(bad, usage)).toBeUndefined();
			expect(usage.inputTokens).toBe(10);
		},
	);

	it("never accepts a partial array or sanitizes invalid supplied reports into priority", () => {
		expect(parseUsagePricing([], usage)).toBeUndefined();
		expect(
			parseUsagePricing([{ usage, serviceTier: { requested: "priority", reported: "bad\nvalue" } }], usage),
		).toBeUndefined();
		expect(parseUsagePricing([{ usage }, { usage }], usage)).toBeUndefined();
	});

	it("retains legacy slices and treats omitted caches as explicit zero for conservation", () => {
		const input = [{ usage: { inputTokens: 2, outputTokens: 3 } }];
		expect(
			parseUsagePricing(input, { inputTokens: 2, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 }),
		).toEqual(input);
	});
});
