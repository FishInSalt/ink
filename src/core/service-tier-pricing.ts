import type { Usage } from "./messages.js";
import { parseServiceTierReport, type ServiceTierReport } from "./service-tier.js";

/** Reference-price assumptions, not processing or subscription-charge evidence. */
export const CODEX_SERVICE_TIER_PRICING_VERSION = "pi-2cac4f1a9";
export const CODEX_SERVICE_TIER_PRICING_SOURCE =
	"https://github.com/earendil-works/pi/blob/2cac4f1a934cdc4a80b05a7d8ff2543cf5ee623c/packages/ai/src/api/openai-codex-responses.ts#L623-L660";

export interface UsagePricingSlice {
	usage: Usage;
	serviceTier?: ServiceTierReport;
}

const COUNTERS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const;

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Unlike the display parser, pricing cannot silently turn an invalid supplied
 * reported value into an absent report and then apply the requested multiplier. */
export function parsePricingServiceTier(value: unknown): ServiceTierReport | undefined {
	const raw = record(value);
	const report = parseServiceTierReport(value);
	if (!raw || !report) return undefined;
	if (raw.reported !== undefined && report.reported === undefined) return undefined;
	return report;
}

function parseUsage(value: unknown): Usage | undefined {
	const raw = record(value);
	if (!raw) return undefined;
	for (const key of COUNTERS) {
		const counter = raw[key];
		if (counter === undefined && (key === "cacheReadTokens" || key === "cacheWriteTokens")) continue;
		if (typeof counter !== "number" || !Number.isFinite(counter) || counter < 0) return undefined;
	}
	return {
		inputTokens: raw.inputTokens as number,
		outputTokens: raw.outputTokens as number,
		...(raw.cacheReadTokens === undefined ? {} : { cacheReadTokens: raw.cacheReadTokens as number }),
		...(raw.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: raw.cacheWriteTokens as number }),
	};
}

/** A copied per-report attribution. Missing or malformed observations mean a
 * base-only legacy estimate, never an inferred ordinary/Fast request. */
export function pricingSlice(usage: Usage, observation?: ServiceTierReport): UsagePricingSlice {
	const serviceTier = parsePricingServiceTier(observation);
	return {
		usage: {
			inputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens,
			...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
			...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
		},
		...(serviceTier === undefined ? {} : { serviceTier }),
	};
}

/** Persisted sidecars are optional. Accept all slices or none: a partial subset
 * would silently lose or double-price usage. Authoritative counters stay intact. */
export function parseUsagePricing(value: unknown, aggregate: Usage): UsagePricingSlice[] | undefined {
	if (!Array.isArray(value) || !parseUsage(aggregate)) return undefined;
	const out: UsagePricingSlice[] = [];
	const sum: Required<Usage> = {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
	};
	for (const item of value) {
		const raw = record(item);
		const usage = parseUsage(raw?.usage);
		if (!raw || !usage) return undefined;
		const serviceTier = parsePricingServiceTier(raw.serviceTier);
		if (raw.serviceTier !== undefined && serviceTier === undefined) return undefined;
		out.push({ usage, ...(serviceTier === undefined ? {} : { serviceTier }) });
		for (const key of COUNTERS) sum[key] += usage[key] ?? 0;
	}
	for (const key of COUNTERS) {
		if (!Number.isFinite(sum[key]) || sum[key] !== (aggregate[key] ?? 0)) return undefined;
	}
	return out;
}

export interface ServiceTierPricing {
	multiplier: number;
	/** Missing/unknown attribution leaves a base-only reference estimate. */
	incomplete: boolean;
	version?: string;
}

/** Source-scoped monetary adjustment. The caller decides whether positive
 * usage makes an incomplete estimate visible; zero reports remain zero. */
export function serviceTierPricing(
	reference: string | null,
	observation?: ServiceTierReport,
): ServiceTierPricing {
	if (reference === null || !reference.startsWith("openai-codex/")) {
		return { multiplier: 1, incomplete: false };
	}
	const model = reference.slice("openai-codex/".length);
	const report = parsePricingServiceTier(observation);
	const version = CODEX_SERVICE_TIER_PRICING_VERSION;
	if (!report) return { multiplier: 1, incomplete: true, version };
	let tier = report.reported;
	if (tier === undefined || tier === "default") {
		tier = report.requested === "priority" ? "priority" : "standard";
	}
	switch (tier) {
		case "priority":
		case "fast":
			return { multiplier: model === "gpt-5.5" ? 2.5 : 2, incomplete: false, version };
		case "flex":
			return { multiplier: 0.5, incomplete: false, version };
		case "standard":
		case "auto":
		case "scale":
			return { multiplier: 1, incomplete: false, version };
		default:
			return { multiplier: 1, incomplete: true, version };
	}
}
