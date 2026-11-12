import type { ProviderName } from "./model-ref.js";

/** Frozen first-party offline choices, not endpoint discovery results or proof
 * of account availability. The picker alone decides when to use these seeds. */
export const ZAI_SEED_MODELS = [
	"glm-4.7",
	"glm-5-turbo",
	"glm-5.2",
	"glm-5.2-highspeed",
	"glm-5.3",
	"glm-5.3-flash",
	"glm-5.3-highspeed",
] as const;

export const DEEPSEEK_SEED_MODELS = ["deepseek-flash", "deepseek-v4-pro"] as const;

export const MOONSHOT_SEED_MODELS = [
	"kimi-k2.6",
	"kimi-k2.7-code",
	"kimi-k2.7-code-highspeed",
	"kimi-k3",
] as const;

/** Wire IDs, shaped into model references by the picker just like live lists.
 * GLM is advertised only under zai; subscription models require account lists. */
export const STATIC_MODEL_SEEDS: Readonly<Record<ProviderName, readonly string[]>> = {
	anthropic: ["claude-sonnet-4-5"],
	openai: ["gpt-5.2"],
	"openai-codex": [],
	zai: ZAI_SEED_MODELS,
	deepseek: DEEPSEEK_SEED_MODELS,
	moonshotai: MOONSHOT_SEED_MODELS,
	"moonshotai-cn": MOONSHOT_SEED_MODELS,
};
