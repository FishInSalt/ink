/**
 * Generated from ALL 12 official Codex model entries (10 Fast-capable).
 * Source: https://raw.githubusercontent.com/openai/codex/0d37c062de16c81caa1376e072ccd15cf3d68506/codex-rs/models-manager/models.json
 * Revision: 0d37c062de16c81caa1376e072ccd15cf3d68506
 * Retrieved: 2026-11-10
 * Predicate: service_tiers id priority/fast OR additional_speed_tiers fast.
 * Generic capability only, never account availability or entitlement.
 * No runtime network refresh; regenerate from the pinned source when updating.
 */
const fastModes: ReadonlyMap<string, boolean> = new Map([
	["gpt-6-astra", true],
	["gpt-6.1-sol", true],
	["gpt-6.1-terra", true],
	["gpt-6-sol", true],
	["gpt-6-luna", true],
	["gpt-5.6-sol", true],
	["gpt-5.6-terra", true],
	["gpt-5.6-luna", true],
	["gpt-daybreak-blue-latest", false],
	["gpt-daybreak-red-latest", false],
	["gpt-5.5", true],
	["codex-auto-review", true],
]);

/** Unknown ids remain unknown; do not infer capability from model names. */
export function bundledCodexFastModeSupport(modelId: string): boolean | undefined {
	return fastModes.get(modelId);
}
