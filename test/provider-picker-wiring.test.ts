import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiKeyFamily } from "../src/provider/auth-store.js";
import {
	catalogModelIds,
	loadCatalogCache,
	refreshCatalog,
	resetCatalogForTest,
} from "../src/provider/catalog.js";
import {
	cachedCodexModelIds,
	codexFastModeSupport,
	discoverModels,
	familyConfigured,
	resetDiscoveryCacheForTest,
	setDiscoveryClockForTest,
} from "../src/provider/discover.js";
import { buildModelList } from "../src/repl/commands.js";
import { mkTempDir } from "./helpers/mktemp.js";

const endpoints = [
	["anthropic", "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "https://api.anthropic.com/v1/models?limit=1000"],
	["openai", "OPENAI_BASE_URL", "OPENAI_API_KEY", "https://api.openai.com/v1/models"],
	["zai", "ZAI_BASE_URL", "ZAI_API_KEY", "https://api.z.ai/api/coding/paas/v4/models"],
	["deepseek", "DEEPSEEK_BASE_URL", "DEEPSEEK_API_KEY", "https://api.deepseek.com/models"],
	["moonshotai", "MOONSHOT_BASE_URL", "MOONSHOT_API_KEY", "https://api.moonshot.ai/v1/models"],
	["moonshotai-cn", "MOONSHOT_CN_BASE_URL", "MOONSHOT_API_KEY", "https://api.moonshot.cn/v1/models"],
] as const;

// Independent expectations: retain the union previously split between
// discover's provider seeds and the picker's FAMILY_FALLBACKS.
const kimi = ["kimi-k2.6", "kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k3"];
const legacyChoices: Record<ApiKeyFamily, string[]> = {
	anthropic: ["claude-sonnet-4-5"],
	openai: ["gpt-5.2"],
	zai: [
		"glm-4.7",
		"glm-5-turbo",
		"glm-5.2",
		"glm-5.2-highspeed",
		"glm-5.3",
		"glm-5.3-flash",
		"glm-5.3-highspeed",
	],
	deepseek: ["deepseek-flash", "deepseek-v4-pro"],
	moonshotai: kimi,
	"moonshotai-cn": kimi,
};
const deps = {
	configured: familyConfigured,
	discover: discoverModels,
	catalogIds: catalogModelIds,
	cachedCodexIds: cachedCodexModelIds,
	fastModeSupport: codexFastModeSupport,
};
let authPath: string;
let catalogPath: string;

function configure(family: ApiKeyFamily): void {
	writeFileSync(authPath, JSON.stringify({ version: 1, apiKeys: { [family]: `stored-${family}` } }));
}

function labels(result: Awaited<ReturnType<typeof buildModelList>>): string[] {
	return result.rows.map((row) => row.label);
}

function reference(family: ApiKeyFamily, id: string): string {
	return family === "anthropic" ? id : `${family}/${id}`;
}

beforeEach(() => {
	const dir = mkTempDir("ink-catalog-test-");
	authPath = join(dir, "auth.json");
	catalogPath = join(dir, "catalog.json");
	vi.stubEnv("INK_AUTH_PATH", authPath);
	vi.stubEnv("INK_CATALOG_PATH", catalogPath);
	vi.stubEnv("INK_CATALOG_BASE_URL", "https://pi.dev");
	for (const [, baseEnv, keyEnv] of endpoints) {
		vi.stubEnv(baseEnv, undefined);
		vi.stubEnv(keyEnv, undefined);
	}
	vi.stubEnv("ANTHROPIC_AUTH_TOKEN", undefined);
	vi.stubEnv("OPENAI_CODEX_BASE_URL", undefined);
	resetCatalogForTest();
	resetDiscoveryCacheForTest();
	setDiscoveryClockForTest(Date.now);
});

afterEach(() => {
	resetCatalogForTest();
	resetDiscoveryCacheForTest();
	setDiscoveryClockForTest(Date.now);
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe.each(endpoints)("real discovery → catalog → picker: %s", (family, baseEnv, keyEnv, endpoint) => {
	it("default endpoint failure reaches the real catalog before static seeds", async () => {
		configure(family);
		const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
			if (String(input) === `https://pi.dev/api/models/providers/${family}`) {
				expect(new Headers(init?.headers).has("authorization")).toBe(false);
				return Response.json([{ id: "catalog-only-new-model" }]);
			}
			expect(String(input)).toBe(endpoint);
			throw new Error("offline fixture");
		});
		vi.stubGlobal("fetch", fetchMock);
		expect((await refreshCatalog({ families: [family] })).fetched).toEqual([family]);
		// Round-trip through the one store, not a mocked catalogIds accessor.
		resetCatalogForTest();
		expect(loadCatalogCache()).toBe(true);
		expect(process.env[baseEnv]).toBeUndefined();
		expect(await discoverModels(family)).toBeNull();
		const result = await buildModelList("custom-current", deps);
		expect(labels(result)).toEqual(["custom-current", reference(family, "catalog-only-new-model")]);
		expect(result.fallbackNotes).toEqual([]);
		expect(fetchMock).toHaveBeenCalledTimes(3); // catalog + two failed discovery calls, no cached fiction
	});

	it("401 on the default endpoint yields null; only the picker supplies all legacy static choices", async () => {
		configure(family);
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 401 }));
		vi.stubGlobal("fetch", fetchMock);
		expect(await discoverModels(family)).toBeNull();
		const result = await buildModelList("custom-current", deps);
		expect(labels(result)).toEqual([
			"custom-current",
			...legacyChoices[family].map((id) => reference(family, id)),
		]);
		expect(result.fallbackNotes).toHaveLength(1);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls.every(([url]) => String(url) === endpoint)).toBe(true);
	});

	it("live results beat catalog/static choices and stored credentials beat env credentials", async () => {
		configure(family);
		vi.stubEnv(keyEnv, "env-key-must-not-win");
		vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "env-bearer-must-not-win");
		writeFileSync(
			catalogPath,
			JSON.stringify({
				version: 2,
				providers: {
					[family]: { checkedAt: 1, models: { ignored: { id: "catalog-not-available" } } },
				},
			}),
		);
		loadCatalogCache();
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [{ id: "live-only" }] }));
		vi.stubGlobal("fetch", fetchMock);
		expect(await discoverModels(family)).toEqual(["live-only"]);
		const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
		if (family === "anthropic") {
			expect(headers.get("x-api-key")).toBe("stored-anthropic");
			expect(headers.get("anthropic-version")).toBe("2023-06-01");
			expect(headers.has("authorization")).toBe(false);
		} else expect(headers.get("authorization")).toBe(`Bearer stored-${family}`);
		// Limit the picker to this family: Moonshot's shared env key and the
		// Anthropic bearer above intentionally configure additional families.
		const result = await buildModelList("custom-current", { ...deps, configured: (f) => f === family });
		expect(labels(result)).toEqual(["custom-current", reference(family, "live-only")]);
		expect(result.fallbackNotes).toEqual([]);
		expect(fetchMock).toHaveBeenCalledTimes(1); // live listing uses the ordinary TTL cache
	});

	it("a redirected endpoint cannot inherit a default endpoint's cache, catalog or seeds", async () => {
		configure(family);
		writeFileSync(
			catalogPath,
			JSON.stringify({
				version: 2,
				providers: {
					[family]: { checkedAt: 1, models: { ignored: { id: "catalog-not-available" } } },
				},
			}),
		);
		loadCatalogCache();
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(Response.json({ data: [{ id: "default-only" }] }))
			.mockRejectedValue(new Error("gateway offline fixture"));
		vi.stubGlobal("fetch", fetchMock);
		expect(await discoverModels(family)).toEqual(["default-only"]);
		vi.stubEnv(baseEnv, "https://gateway.example");
		const result = await buildModelList("custom-current", deps);
		expect(labels(result)).toEqual(["custom-current"]);
		expect(result.fallbackNotes[0]).toMatch(/^!redirect /);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(String(fetchMock.mock.calls[1]?.[0])).toMatch(/^https:\/\/gateway\.example\//);
	});
});

it("unconfigured discovery is null without sending a credential or making any fetch", async () => {
	const fetchMock = vi.fn<typeof fetch>();
	vi.stubGlobal("fetch", fetchMock);
	for (const [family] of endpoints) expect(await discoverModels(family)).toBeNull();
	expect(fetchMock).not.toHaveBeenCalled();
});

it("subscription empty and Fast listings remain account-authoritative through the real wiring", async () => {
	writeFileSync(
		authPath,
		JSON.stringify({
			version: 1,
			hostId: "a73e4eec-dc3a-4000-9000-000000000001",
			codexRevision: "picker-generation",
			codex: {
				type: "chatgpt-oauth",
				provider: "openai-codex",
				accessToken: "subscription-token",
				refreshToken: "refresh-token",
				expiresAt: Date.now() + 3_600_000,
				clientId: "fixture-client",
				issuer: "https://auth.openai.com",
				subject: "fixture-subject",
				idToken: "fixture-id-token",
				scopes: ["openid", "profile", "email", "offline_access", "chatgpt.tokens.use.direct"],
			},
		}),
	);
	let models: object[] = [];
	const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
		expect(new Headers(init?.headers).get("authorization")).toBe("Bearer subscription-token");
		expect(init?.redirect).toBe("error");
		return Response.json({ models });
	});
	vi.stubGlobal("fetch", fetchMock);
	const current = "openai-codex/custom·fast";
	const empty = await buildModelList(current, { ...deps, catalogIds: () => ["not-account-listed"] });
	expect(labels(empty)).toEqual([current]);
	expect(empty.fallbackNotes).toEqual([]);
	models = [
		{ slug: "first", visibility: "list", additional_speed_tiers: ["fast"] },
		{ slug: "hidden", visibility: "hidden", additional_speed_tiers: ["fast"] },
		{ slug: "gpt-6.1-sol", visibility: "list", additional_speed_tiers: [] },
	];
	resetDiscoveryCacheForTest();
	setDiscoveryClockForTest(() => Date.now() + 6 * 60_000);
	const listed = await buildModelList(current, deps);
	expect(labels(listed)).toEqual([
		current,
		"openai-codex/first",
		"openai-codex/first·fast",
		"openai-codex/gpt-6.1-sol",
	]);
	fetchMock.mockRejectedValue(new Error("offline fixture"));
	resetDiscoveryCacheForTest();
	setDiscoveryClockForTest(() => Date.now() + 12 * 60_000);
	const offline = await buildModelList(current, deps);
	expect(labels(offline)).toEqual(labels(listed));
	expect(offline.rows.find((row) => row.label === "openai-codex/first·fast")?.description).toContain(
		"offline/stale",
	);
	expect(offline.fallbackNotes[0]).toContain("unverified");
	expect(fetchMock).toHaveBeenCalledTimes(3);
	expect(fetchMock.mock.calls.every(([url]) => String(url) === "https://api.openai.com/v1/models")).toBe(
		true,
	);
	expect(readFileSync(`${catalogPath}.chatgpt-models.json`, "utf8")).not.toContain("subscription-token");
});
