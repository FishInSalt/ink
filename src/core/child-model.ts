import {
	canRequestFastMode,
	knownProvider,
	type ProviderName,
	parseModelRef,
	parseModelSelection,
} from "../provider/resolve.js";
import type { ModelSpeed } from "../provider/types.js";

/**
 * SA-02: one resolution for the child model — API requests use the wire ID
 * (prefix stripped); every metadata/capability lookup uses the canonical
 * `provider/modelId` reference. The contract (design §2):
 *
 *   C1 absent override        → inherit the parent (family + wire model)
 *   C2 bare ID                → the parent's provider (no CLI default routing)
 *   C3 same-provider prefix   → strip the prefix
 *   C4 other-provider prefix  → reject BEFORE any launch side effect
 *   C5 unrecognized slash     → a legitimate wire id (OpenRouter/Bedrock style)
 *   C6 empty/blank override   → reject (malformed config)
 *   C7 known prefix, empty id → reject (malformed)
 *
 * The parent family is exact when the caller supplies getModelReference()
 * (the real runner always does); the getModel() fallback is an
 * approximation documented in the design (D1) — a wiring whose live family
 * cannot be derived from the model string must supply getModelReference().
 */

export interface ChildModelBinding {
	/** Family name of the provider that will run the child. */
	providerName: ProviderName;
	/** The exact model id for API requests (any recognized prefix stripped). */
	wireModelId: string;
	/** Canonical `${providerName}/${wireModelId}` — the ONLY metadata key. */
	reference: string;
}

export type ChildModelResolution =
	| { ok: true; binding: ChildModelBinding; speed?: ModelSpeed }
	| { ok: false; error: string };

function bind(providerName: ProviderName, wireModelId: string): ChildModelBinding {
	return { providerName, wireModelId, reference: `${providerName}/${wireModelId}` };
}

// Compatibility export; persisted-data readers use the pure module directly.
export { isModelBinding } from "./model-binding.js";

export function resolveChildModel(input: {
	/** getModelReference() (canonical) or the getModel() fallback. */
	parentReference: string;
	/** Live speed captured alongside the parent's base reference/provider. */
	parentSpeed?: ModelSpeed;
	/** agent?.model — undefined means inherit both model and speed. */
	override?: string;
	/** Diagnostics only. */
	agentName?: string;
}): ChildModelResolution {
	const parentReference = input.parentReference.trim();
	if (parentReference === "") {
		return {
			ok: false,
			error: "internal error: the session's model reference is empty — cannot resolve the child model",
		};
	}
	const parent = parseModelRef(parentReference);
	const inherit = bind(parent.provider, parent.modelId);
	if (input.override === undefined) {
		if (
			input.parentSpeed !== undefined &&
			(input.parentSpeed !== "fast" || !canRequestFastMode(parent.provider, parent.modelId))
		) {
			return { ok: false, error: "Invalid Fast request for the inherited child model." };
		}
		return {
			ok: true,
			binding: inherit,
			...(input.parentSpeed === undefined ? {} : { speed: input.parentSpeed }),
		};
	}

	const who = input.agentName === undefined ? "this task" : `agent "${input.agentName}"`;
	const trimmed = input.override.trim();
	if (trimmed === "") {
		return {
			ok: false,
			error: `${who} has an empty model override in its configuration — remove the field or name a model.`,
		};
	}

	// Normalize child-local routing FIRST, then parse selection syntax on the
	// parent's provider. A bare Fast override must never use CLI bare-ID routing.
	const select = (providerName: ProviderName, modelId: string): ChildModelResolution => {
		try {
			const selection = parseModelSelection(`${providerName}/${modelId}`);
			return {
				ok: true,
				binding: bind(selection.provider, selection.modelId),
				...(selection.speed === undefined ? {} : { speed: selection.speed }),
			};
		} catch (err) {
			return {
				ok: false,
				error: `${who} has an invalid model override "${trimmed}": ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	};

	const slash = trimmed.indexOf("/");
	if (slash === -1) {
		// C2: agent-local shorthand selects on the PARENT's provider; the
		// main-CLI bare-ID defaults (glm-* → zai) do not apply here.
		return select(parent.provider, trimmed);
	}

	const prefix = trimmed.slice(0, slash).trim();
	const rest = trimmed.slice(slash + 1).trim();
	const provider = knownProvider(prefix);
	if (provider === undefined) {
		// C5: an unrecognized slash prefix is not a provider delimiter —
		// legitimate wire ids may contain slashes. Keep the whole string.
		return select(parent.provider, trimmed);
	}
	if (rest === "") {
		return {
			ok: false,
			error: `${who} has a malformed model reference "${trimmed}" (no model id after "${prefix}/") — fix the agent configuration.`,
		};
	}
	if (provider !== parent.provider) {
		return {
			ok: false,
			error: `${who} requests model "${trimmed}" on provider "${provider}", but this session runs on "${parent.provider}". Cross-provider subagents are not supported — choose a model on the current provider, or switch the session model first (/model).`,
		};
	}
	return select(provider, rest);
}
