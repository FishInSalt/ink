/** Requested processing mode, independent of the underlying model identity. */
export type ModelSpeed = "fast";

/** Structural request validation, NOT evidence of capability or entitlement.
 * Persisted/custom selections must not become invalid when catalogs change.
 * Keep this module free of provider imports and credential reads. */
export function canRequestFastMode(provider: string, modelId: string): boolean {
	return provider === "openai-codex" && modelId !== "" && !/[\s·]/u.test(modelId);
}
