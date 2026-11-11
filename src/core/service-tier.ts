/** Request/terminal observations, not processing or billing attestation.
 * Absence on an old message is distinct from an observed ordinary request. */
export interface ServiceTierReport {
	requested: "omitted" | "priority";
	reported?: string;
}

/** Pure persisted-data boundary. Copy only bounded diagnostic tokens; never
 * stringify arbitrary values, normalize reports, or infer a requested tier. */
export function parseServiceTierReport(value: unknown): ServiceTierReport | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	if (raw.requested !== "omitted" && raw.requested !== "priority") return undefined;
	const reported =
		typeof raw.reported === "string" &&
		raw.reported.length >= 1 &&
		raw.reported.length <= 160 &&
		!/[^a-zA-Z0-9_.\-[\]]/.test(raw.reported)
			? raw.reported
			: undefined;
	return { requested: raw.requested, ...(reported === undefined ? {} : { reported }) };
}
