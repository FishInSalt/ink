import { catalogEntryForReference } from "./catalog.js";
import { parseModelRef } from "./model-ref.js";
import { thinkingMetaFor } from "./thinking.js";

/** The model's output-token cap for budget math (#derived-budget), or
 *  undefined when neither source knows. Sources, in order: the pi.dev
 *  catalog's maxTokens; the thinking table's maxOutputTokens (pi's
 *  model.maxTokens mirror). thinkingMetaFor preserves exact catalog hits:
 *  omitted maxTokens or reasoning:false must not regain a static prefix cap.
 *  Callers treat undefined as "no model-side bound" — never as zero. */
export function modelMaxTokensFor(reference: string): number | undefined {
	const entry = catalogEntryForReference(reference);
	if (entry?.maxTokens !== undefined && Number.isFinite(entry.maxTokens) && entry.maxTokens > 0) {
		return entry.maxTokens;
	}
	const ref = parseModelRef(reference);
	const meta = thinkingMetaFor(ref.provider, ref.modelId);
	if (meta?.maxOutputTokens !== undefined && meta.maxOutputTokens > 0) return meta.maxOutputTokens;
	return undefined;
}
