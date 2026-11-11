import type { ChildModelBinding } from "./child-model.js";

/** SA-08 reopened F-3: the single derivation rule for a model binding —
 *  `bind()` writes it, and every persisted record that carries an identity
 *  (launch records, TaskRecords) validates against it. The three fields
 *  drive DIFFERENT subsystems (wire request, pricing metadata, endpoint
 *  gate), so a disagreeing triple can never be trusted for attribution. */
export function isModelBinding(value: unknown): value is ChildModelBinding {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const b = value as Record<string, unknown>;
	if (typeof b.providerName !== "string" || b.providerName === "") return false;
	if (typeof b.wireModelId !== "string" || b.wireModelId === "") return false;
	if (typeof b.reference !== "string" || b.reference === "") return false;
	return b.reference === `${b.providerName}/${b.wireModelId}`;
}
