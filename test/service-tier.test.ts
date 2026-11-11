import { describe, expect, it } from "vitest";
import { parseServiceTierReport } from "../src/core/service-tier.js";

describe("ServiceTierReport persisted-data parser", () => {
	it.each(["omitted", "priority"])("copies only validated fields for requested=%s", (requested) => {
		const source = Object.freeze({
			requested,
			reported: "future.v2-[A9]_tier",
			credential: "private",
			extra: {},
		});
		const parsed = parseServiceTierReport(source);
		expect(parsed).toEqual({ requested, reported: "future.v2-[A9]_tier" });
		expect(parsed).not.toBe(source);
		expect(parseServiceTierReport({ requested })).toEqual({ requested });
	});

	it.each([
		undefined,
		null,
		[],
		"priority",
		1,
		{},
		{ reported: "default" },
		...[undefined, null, false, 1, "normal", "fast", "Priority", "priority\n", ""].map((requested) => ({
			requested,
		})),
	])("does not infer or coerce malformed/legacy request %j", (value) => {
		expect(parseServiceTierReport(value)).toBeUndefined();
	});

	it.each([
		undefined,
		null,
		false,
		42,
		{},
		[],
		"",
		"x".repeat(161),
		"priority\n",
		"default\r",
		"\u001b[31m",
		"a\tb",
		"a b",
		"优先",
		"Bearer secret",
		"a/b",
		"a:b",
		"a\u007fb",
	])("ignores malformed report %j without losing the request", (reported) => {
		expect(parseServiceTierReport({ requested: "priority", reported })).toEqual({ requested: "priority" });
	});

	it.each(["a", "x".repeat(160), "default", "standard", "flex", "fast", "unknown-_.[]A09"])(
		"preserves valid report %s exactly, never rewriting it to priority",
		(reported) => {
			expect(parseServiceTierReport({ requested: "priority", reported })).toEqual({
				requested: "priority",
				reported,
			});
		},
	);
});
