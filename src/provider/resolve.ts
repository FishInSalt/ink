import { createAnthropicProvider } from "./anthropic.js";
import { createCodexResponsesProvider } from "./codex-responses.js";
import { createDeepSeekProvider } from "./deepseek.js";
import { type ProviderName, parseModelSelection } from "./model-ref.js";
import type { ModelSpeed } from "./model-speed.js";
import { createMoonshotCnProvider, createMoonshotProvider } from "./moonshotai.js";
import { createOpenAICompletionsProvider } from "./openai-completions.js";
import type { LLMProvider } from "./types.js";
import { createZaiProvider } from "./zai.js";

// Compatibility: reference helpers remain available without coupling their consumers
// to provider construction. Metadata/core callers import model-ref directly.
export * from "./model-ref.js";

export function createProviderFor(provider: ProviderName): LLMProvider {
	switch (provider) {
		case "anthropic":
			return createAnthropicProvider();
		case "openai":
			return createOpenAICompletionsProvider();
		case "openai-codex":
			return createCodexResponsesProvider();
		case "zai":
			return createZaiProvider();
		case "deepseek":
			return createDeepSeekProvider();
		case "moonshotai":
			return createMoonshotProvider();
		case "moonshotai-cn":
			return createMoonshotCnProvider();
		default: {
			const exhaustive: never = provider;
			throw new Error(`unreachable provider: ${JSON.stringify(exhaustive)}`);
		}
	}
}

/** Resolve a model reference into (provider, wire model id). */
export function resolveModel(reference: string): {
	provider: LLMProvider;
	modelId: string;
	speed?: ModelSpeed;
} {
	const ref = parseModelSelection(reference);
	return {
		provider: createProviderFor(ref.provider),
		modelId: ref.modelId,
		...(ref.speed === undefined ? {} : { speed: ref.speed }),
	};
}
