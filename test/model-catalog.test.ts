/**
 * M14 #model-catalog — pi.dev as the single source of truth for model
 * metadata. Covers the catalog module (parse shapes, staleness, HTTP
 * revalidation, disk round-trip) and every consult point it feeds
 * (windows, costs, thinking, vision, /model list).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CATALOG_FRESH_WINDOW_MS,
	type CatalogFetcher,
	CODEX_METADATA_SOURCE,
	catalogEntryFor,
	catalogModelIds,
	loadCatalogCache,
	modelMaxTokensFor,
	refreshCatalog,
	resetCatalogForTest,
	setCatalogClockForTest,
	setCatalogFetcherForTest,
} from "../src/provider/catalog.js";
import { registerDiscoveredContextWindows, resetDiscoveredWindowsForTest } from "../src/provider/discover.js";
import { contextWindowFor, costFor } from "../src/provider/models.js";
import { effortFor, supportedThinkingLevels, thinkingMetaFor } from "../src/provider/thinking.js";
import { modelSupportsVision } from "../src/provider/vision.js";
import { mkTempDir } from "./helpers/mktemp.js";

let clockMs = 1_000_000;
const clock = () => clockMs;

interface FetchLog {
	url: string;
	headers: Record<string, string>;
}

function jsonResponse(
	status: number,
	body: unknown,
	headers: Record<string, string> = {},
): Awaited<ReturnType<CatalogFetcher>> {
	return {
		status,
		ok: status >= 200 && status < 300,
		headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
		json: async () => body,
	};
}

const zaiCatalog = {
	"glm-5.3": {
		id: "glm-5.3",
		name: "GLM-5.3",
		reasoning: true,
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 131_072,
		cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
		thinkingLevelMap: { off: null, low: "low", high: "high", max: "max" },
		compat: { supportsReasoningEffort: true },
	},
	"glm-5.3-flash": {
		id: "glm-5.3-flash",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 1_000_000,
		cost: { input: 0.1, output: 0.4, cacheRead: 0.02, cacheWrite: 0 },
	},
};

function fixtureFetcher(
	responses: Record<
		string,
		Awaited<ReturnType<CatalogFetcher>> | ((log: FetchLog) => Awaited<ReturnType<CatalogFetcher>>)
	>,
): { fetcher: CatalogFetcher; logs: FetchLog[] } {
	const logs: FetchLog[] = [];
	return {
		logs,
		fetcher: async (url, headers) => {
			logs.push({ url, headers });
			const handler = responses[url] ?? responses["*"];
			if (handler === undefined) return jsonResponse(404, {});
			return typeof handler === "function" ? handler(logs[logs.length - 1] as FetchLog) : handler;
		},
	};
}

// Only the injected fetcher handles these URLs; no network requests are made.
const catalogBaseUrl = "https://catalog.example";
const piZaiUrl = `${catalogBaseUrl}/api/models/providers/zai`;
const piOpenAiUrl = `${catalogBaseUrl}/api/models/providers/openai`;
const piCodexUrl = `${catalogBaseUrl}/api/models/providers/openai-codex`;
const solId = "gpt-6.1-sol";
const codexSolCatalog = {
	[solId]: {
		id: solId,
		name: "GPT-6.1 Sol",
		api: "openai-codex-responses",
		baseUrl: "https://chatgpt.com/backend-api",
		contextWindow: 500_000,
		maxTokens: 128_000,
		input: ["text", "image"],
		reasoning: true,
		thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: null, high: "high" },
		cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
		compat: { supportsReasoningEffort: true },
	},
};

describe("M14 catalog refresh", () => {
	let tmpDir: string;
	let savedPath: string | undefined;

	beforeEach(() => {
		resetCatalogForTest();
		resetDiscoveredWindowsForTest();
		clockMs = 1_000_000;
		setCatalogClockForTest(clock);
		vi.stubEnv("INK_CATALOG_BASE_URL", catalogBaseUrl);
		tmpDir = mkTempDir("ink-catalog-test-");
		savedPath = process.env.INK_CATALOG_PATH;
		process.env.INK_CATALOG_PATH = join(tmpDir, "models-catalog.json");
	});

	afterEach(() => {
		resetCatalogForTest();
		resetDiscoveredWindowsForTest();
		setCatalogClockForTest(Date.now);
		setCatalogFetcherForTest(async (url, headers, signal) => fetch(url, { headers, signal }));
		vi.unstubAllEnvs();
		if (savedPath === undefined) delete process.env.INK_CATALOG_PATH;
		else process.env.INK_CATALOG_PATH = savedPath;
	});

	it("parses the record-keyed shape pi.dev serves and persists to disk", async () => {
		const { fetcher, logs } = fixtureFetcher({ [piZaiUrl]: jsonResponse(200, zaiCatalog, { etag: '"a1"' }) });
		setCatalogFetcherForTest(fetcher);
		const summary = await refreshCatalog({ families: ["zai"], force: true });
		expect(logs.map((log) => log.url)).toEqual([piZaiUrl]);
		expect(summary.fetched).toEqual(["zai"]);
		expect(catalogModelIds("zai")).toEqual(["glm-5.3", "glm-5.3-flash"]);

		// Disk round-trip: a fresh module state loads the overlay back.
		resetCatalogForTest();
		expect(loadCatalogCache()).toBe(true);
		expect(catalogEntryFor("zai", "glm-5.3")?.contextWindow).toBe(1_000_000);
	});

	it("parses array and {models:[...]} shapes too (pi parseCatalog parity)", async () => {
		const arrayForm = [zaiCatalog["glm-5.3"]];
		const { fetcher } = fixtureFetcher({
			[piZaiUrl]: jsonResponse(200, arrayForm),
			[piCodexUrl]: jsonResponse(200, { models: [{ id: "gpt-5.5" }] }),
		});
		setCatalogFetcherForTest(fetcher);
		await refreshCatalog({ families: ["zai", "openai-codex"], force: true });
		expect(catalogModelIds("zai")).toEqual(["glm-5.3"]);
		expect(catalogModelIds("openai-codex")).toEqual(["gpt-5.5"]);
	});

	it("uses each provider's complete metadata catalog without importing its transport", async () => {
		const openAiSol = {
			id: solId,
			contextWindow: 272_000,
			maxTokens: 64_000,
			input: ["text"],
			reasoning: true,
			thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: "high" },
			cost: { input: 3, output: 12, cacheRead: 0.3, cacheWrite: 3 },
		};
		const { fetcher, logs } = fixtureFetcher({
			[piOpenAiUrl]: jsonResponse(200, { [solId]: openAiSol }),
			[piCodexUrl]: jsonResponse(200, codexSolCatalog),
		});
		setCatalogFetcherForTest(fetcher);
		await refreshCatalog({ families: ["openai", "openai-codex"], force: true });
		expect(logs.map((log) => log.url)).toEqual([piOpenAiUrl, piCodexUrl]);
		const subscription = `openai-codex/${solId}`;
		const apiKey = `openai/${solId}`;
		expect(contextWindowFor(subscription)).toBe(500_000);
		expect(contextWindowFor(apiKey)).toBe(272_000);
		expect(modelMaxTokensFor(subscription)).toBe(128_000);
		expect(modelMaxTokensFor(apiKey)).toBe(64_000);
		expect(modelSupportsVision("openai-codex", solId)).toBe(true);
		expect(modelSupportsVision("openai", solId)).toBe(false);
		const subscriptionThinking = thinkingMetaFor("openai-codex", solId);
		expect(supportedThinkingLevels(subscriptionThinking)).toEqual(["minimal", "low", "high"]);
		expect(effortFor(subscriptionThinking, "minimal")).toBe("low");
		expect(supportedThinkingLevels(thinkingMetaFor("openai", solId))).toEqual(["high"]);
		expect(costFor(subscription)).toEqual({ ...codexSolCatalog[solId].cost, subscription: true });
		expect(costFor(apiKey)).toEqual(openAiSol.cost);
		const entry = catalogEntryFor("openai-codex", solId);
		expect(entry?.compat).toEqual({ supportsReasoningEffort: true });
		expect(entry).not.toHaveProperty("api");
		expect(entry).not.toHaveProperty("baseUrl");
		const file = JSON.parse(readFileSync(process.env.INK_CATALOG_PATH!, "utf8"));
		expect(file.version).toBe(2);
		expect(file.providers["openai-codex"].source).toBe(CODEX_METADATA_SOURCE);
		resetCatalogForTest();
		expect(loadCatalogCache()).toBe(true);
		expect(contextWindowFor(subscription)).toBe(500_000);
		expect(contextWindowFor(apiKey)).toBe(272_000);
		expect(modelMaxTokensFor(subscription)).toBe(128_000);
		expect(costFor(subscription)?.input).toBe(2);
		expect(effortFor(thinkingMetaFor("openai-codex", solId), "minimal")).toBe("low");
		expect(modelSupportsVision("openai-codex", solId)).toBe(true);
	});

	it("replaces a fresh OpenAI-derived subscription cache without reusing its body or ETag", async () => {
		writeFileSync(
			process.env.INK_CATALOG_PATH!,
			JSON.stringify({
				version: 2,
				providers: {
					"openai-codex": {
						source: "openai:chatgpt-direct-v1",
						models: { [solId]: { id: solId, contextWindow: 272_000 } },
						checkedAt: clockMs,
						etag: '"old-openai"',
					},
					openai: {
						models: { [solId]: { id: solId, contextWindow: 272_000 } },
						checkedAt: clockMs,
						etag: '"api-key"',
					},
				},
			}),
		);
		expect(loadCatalogCache()).toBe(true);
		expect(catalogEntryFor("openai-codex", solId)).toBeNull();
		expect(contextWindowFor(`openai-codex/${solId}`)).toBe(131_072);
		expect(contextWindowFor(`openai/${solId}`)).toBe(272_000);
		const { fetcher, logs } = fixtureFetcher({
			[piCodexUrl]: jsonResponse(200, codexSolCatalog, { etag: '"codex"' }),
		});
		setCatalogFetcherForTest(fetcher);
		const summary = await refreshCatalog({ families: ["openai", "openai-codex"] });
		expect(summary.fetched).toEqual(["openai-codex"]);
		expect(summary.skippedFresh).toEqual(["openai"]);
		expect(logs.map((log) => log.url)).toEqual([piCodexUrl]);
		expect(logs[0]?.headers["if-none-match"]).toBeUndefined();
		const file = JSON.parse(readFileSync(process.env.INK_CATALOG_PATH!, "utf8"));
		expect(file.providers["openai-codex"].source).toBe("openai-codex:chatgpt-direct-v2");
		expect(file.providers["openai-codex"].etag).toBe('"codex"');
		expect(file.providers.openai.etag).toBe('"api-key"');
		resetCatalogForTest();
		expect(loadCatalogCache()).toBe(true);
		expect(contextWindowFor(`openai-codex/${solId}`)).toBe(500_000);
		expect(contextWindowFor(`openai/${solId}`)).toBe(272_000);
	});

	it("does not revive an OpenAI-derived subscription window when the new source is offline", async () => {
		writeFileSync(
			process.env.INK_CATALOG_PATH!,
			JSON.stringify({
				version: 2,
				providers: {
					"openai-codex": {
						source: "openai:chatgpt-direct-v1",
						models: { [solId]: { id: solId, contextWindow: 272_000 } },
						checkedAt: clockMs,
						etag: '"old-openai"',
					},
				},
			}),
		);
		expect(loadCatalogCache()).toBe(true);
		setCatalogFetcherForTest(async () => {
			throw new Error("offline");
		});
		expect((await refreshCatalog({ families: ["openai-codex"] })).failed).toEqual(["openai-codex"]);
		expect(catalogEntryFor("openai-codex", solId)).toBeNull();
		expect(contextWindowFor(`openai-codex/${solId}`)).toBe(131_072);
		resetCatalogForTest();
		expect(loadCatalogCache()).toBe(true);
		expect(catalogEntryFor("openai-codex", solId)).toBeNull();
	});

	it.each([304, "network"] as const)(
		"preserves valid Codex-source metadata after revalidation returns %s",
		async (status) => {
			const initial = fixtureFetcher({
				[piCodexUrl]: jsonResponse(200, codexSolCatalog, { etag: '"codex"' }),
			});
			setCatalogFetcherForTest(initial.fetcher);
			await refreshCatalog({ families: ["openai-codex"] });
			resetCatalogForTest();
			expect(loadCatalogCache()).toBe(true);
			clockMs += CATALOG_FRESH_WINDOW_MS + 1;
			const logs: FetchLog[] = [];
			setCatalogFetcherForTest(async (url, headers) => {
				logs.push({ url, headers });
				if (status === "network") throw new Error("offline");
				return jsonResponse(status, {});
			});
			const summary = await refreshCatalog({ families: ["openai-codex"] });
			expect(status === 304 ? summary.skippedFresh : summary.failed).toEqual(["openai-codex"]);
			expect(logs).toHaveLength(1);
			for (const log of logs) {
				expect(log.url).toBe(piCodexUrl);
				expect(log.headers["if-none-match"]).toBe('"codex"');
			}
			expect(contextWindowFor(`openai-codex/${solId}`)).toBe(500_000);
			const file = JSON.parse(readFileSync(process.env.INK_CATALOG_PATH!, "utf8"));
			expect(file.providers["openai-codex"].source).toBe(CODEX_METADATA_SOURCE);
			if (status === 304) expect(file.providers["openai-codex"].checkedAt).toBe(clockMs);
			resetCatalogForTest();
			expect(loadCatalogCache()).toBe(true);
			expect(contextWindowFor(`openai-codex/${solId}`)).toBe(500_000);
		},
	);

	it.each([
		{ version: 1, source: undefined },
		{ version: 2, source: "openai-codex" },
		{ version: 2, source: undefined },
	])(
		"rejects legacy/unknown subscription metadata ($version/$source), preserving other providers",
		async ({ version, source }) => {
			writeFileSync(
				process.env.INK_CATALOG_PATH!,
				JSON.stringify({
					version,
					providers: {
						"openai-codex": {
							source,
							models: { "gpt-5.5": { id: "gpt-5.5", contextWindow: 99 } },
							checkedAt: clockMs,
							etag: '"legacy"',
						},
						zai: { models: { "glm-5.3": { id: "glm-5.3", contextWindow: 600_000 } }, checkedAt: clockMs },
					},
				}),
			);
			expect(loadCatalogCache()).toBe(true);
			expect(catalogModelIds("openai-codex")).toBeNull();
			expect(contextWindowFor("openai-codex/gpt-5.5")).toBe(131_072);
			expect(costFor("openai-codex/gpt-5.5")).toBeUndefined();
			expect(contextWindowFor("zai/glm-5.3")).toBe(600_000);
			const { fetcher, logs } = fixtureFetcher({ [piCodexUrl]: jsonResponse(200, [{ id: "gpt-direct" }]) });
			setCatalogFetcherForTest(fetcher);
			await refreshCatalog({ families: ["openai-codex"] });
			expect(logs).toHaveLength(1);
			expect(logs[0]?.headers["if-none-match"]).toBeUndefined();
		},
	);

	it("drops invalid entries instead of failing the family", async () => {
		const body = { bad: "not-an-object", "glm-x": { id: "glm-x" }, nullish: null };
		const { fetcher } = fixtureFetcher({ [piZaiUrl]: jsonResponse(200, body) });
		setCatalogFetcherForTest(fetcher);
		const summary = await refreshCatalog({ families: ["zai"], force: true });
		expect(summary.fetched).toEqual(["zai"]);
		expect(catalogModelIds("zai")).toEqual(["glm-x"]);
	});

	it("fresh window skips the network; staleness triggers a conditional request", async () => {
		const { fetcher, logs } = fixtureFetcher({
			[piZaiUrl]: (log) =>
				jsonResponse(
					200,
					zaiCatalog,
					log.headers["if-none-match"] === undefined ? { etag: '"a1"' } : { etag: '"a1"' },
				),
		});
		setCatalogFetcherForTest(fetcher);
		await refreshCatalog({ families: ["zai"], force: true });
		expect(logs.length).toBe(1);
		expect(logs[0]?.headers["if-none-match"]).toBeUndefined();

		clockMs += 1000; // still fresh
		const fresh = await refreshCatalog({ families: ["zai"] });
		expect(fresh.skippedFresh).toEqual(["zai"]);
		expect(logs.length).toBe(1);

		clockMs += CATALOG_FRESH_WINDOW_MS + 1; // stale → revalidate WITH the etag
		await refreshCatalog({ families: ["zai"], force: true });
		expect(logs.length).toBe(2);
		expect(logs[1]?.headers["if-none-match"]).toBe('"a1"');
	});

	it("304 bumps only the window; the body survives", async () => {
		const { fetcher, logs } = fixtureFetcher({
			[piZaiUrl]: (log) =>
				jsonResponse(log.headers["if-none-match"] === undefined ? 200 : 304, zaiCatalog, { etag: '"a1"' }),
		});
		setCatalogFetcherForTest(fetcher);
		await refreshCatalog({ families: ["zai"], force: true });
		clockMs += CATALOG_FRESH_WINDOW_MS + 1;
		await refreshCatalog({ families: ["zai"], force: true });
		expect(logs.length).toBe(2);
		expect(catalogModelIds("zai")).toEqual(["glm-5.3", "glm-5.3-flash"]);
		// the 304 refreshed the window: no third fetch
		await refreshCatalog({ families: ["zai"] });
		expect(logs.length).toBe(2);
	});

	it("404 records no-catalog; 5xx keeps the cached body and bumps the window", async () => {
		let status = 200;
		const { fetcher } = fixtureFetcher({
			[piZaiUrl]: () => jsonResponse(status, status === 200 ? zaiCatalog : {}),
		});
		setCatalogFetcherForTest(fetcher);
		await refreshCatalog({ families: ["zai"], force: true });
		expect(catalogModelIds("zai")).not.toBeNull();

		status = 500;
		clockMs += CATALOG_FRESH_WINDOW_MS + 1;
		const transient = await refreshCatalog({ families: ["zai"], force: true });
		expect(transient.failed).toEqual(["zai"]);
		expect(catalogModelIds("zai")).toEqual(["glm-5.3", "glm-5.3-flash"]); // body kept

		status = 404;
		clockMs += CATALOG_FRESH_WINDOW_MS + 1;
		const gone = await refreshCatalog({ families: ["zai"], force: true });
		expect(gone.noCatalog).toEqual(["zai"]);
		expect(catalogModelIds("zai")).toBeNull(); // recorded empty
	});

	it("network failure keeps the cache and never throws", async () => {
		setCatalogFetcherForTest(async () => {
			throw new Error("offline");
		});
		const summary = await refreshCatalog({ families: ["zai"], force: true });
		expect(summary.failed).toEqual(["zai"]);
	});

	it("concurrent callers join one in-flight pass (single-flight)", async () => {
		let calls = 0;
		let release: (() => void) | undefined;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		setCatalogFetcherForTest(async (url) => {
			calls++;
			if (url === piZaiUrl) await gate;
			return jsonResponse(200, zaiCatalog);
		});
		const a = refreshCatalog({ families: ["zai"], force: true });
		const b = refreshCatalog({ families: ["zai"], force: true });
		release?.();
		const [sa, sb] = await Promise.all([a, b]);
		expect(sa).toEqual(sb);
		expect(calls).toBe(1);
	});

	it("a forced caller JOINS a non-forced pass mid-flight (documented semantics)", async () => {
		let calls = 0;
		let release: (() => void) | undefined;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		setCatalogFetcherForTest(async (url) => {
			calls++;
			if (url === piZaiUrl) await gate;
			return jsonResponse(200, zaiCatalog);
		});
		const normal = refreshCatalog({ families: ["zai"] }); // stale? none cached → fetches
		const forced = refreshCatalog({ families: ["zai"], force: true });
		release?.();
		const [sn, sf] = await Promise.all([normal, forced]);
		expect(calls).toBe(1); // one network pass shared
		expect(sn.fetched).toEqual(["zai"]);
		expect(sf).toEqual(sn); // joiner sees the same summary
	});

	it("outer abort mid-fetch skips the window bump (no 4h freeze from our own shutdown)", async () => {
		const { fetcher, logs } = fixtureFetcher({
			[piZaiUrl]: () => jsonResponse(200, zaiCatalog, { etag: '"a1"' }),
		});
		setCatalogFetcherForTest(fetcher);
		// seed the cache so the no-persist-on-abort path has a body to protect
		await refreshCatalog({ families: ["zai"], force: true });
		const before = JSON.parse(readFileSync(process.env.INK_CATALOG_PATH as string, "utf-8"));
		expect(before.providers.zai.checkedAt).toBe(1_000_000);

		const controller = new AbortController();
		let release: (() => void) | undefined;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		// the fake fetcher honors the abort signal like the real fetch
		setCatalogFetcherForTest(async (_url, _headers, signal) => {
			await gate;
			if (signal.aborted) {
				const err = new Error("This operation was aborted");
				err.name = "AbortError";
				throw err;
			}
			return jsonResponse(200, zaiCatalog);
		});
		clockMs += CATALOG_FRESH_WINDOW_MS + 1; // stale → refetch
		const pending = refreshCatalog({ families: ["zai"], force: true, signal: controller.signal });
		controller.abort();
		release?.();
		const summary = await pending;
		expect(summary.failed).toEqual(["zai"]);
		const after = JSON.parse(readFileSync(process.env.INK_CATALOG_PATH as string, "utf-8"));
		expect(after.providers.zai.checkedAt).toBe(1_000_000); // NOT bumped
		expect(logs.length).toBeGreaterThanOrEqual(1);
	});

	it("load path sanitizes like the fetch path (review P2-1)", () => {
		writeFileSync(
			process.env.INK_CATALOG_PATH as string,
			JSON.stringify({
				version: 1,
				providers: {
					zai: {
						models: {
							"glm-bad": {
								id: "glm-bad",
								contextWindow: "one million" as unknown as number,
								input: "text" as unknown as string[],
								cost: { input: "1" } as unknown as never,
							},
							"glm-good": { id: "glm-good", contextWindow: 128_000 },
						},
						checkedAt: 1,
					},
				},
			}),
			"utf-8",
		);
		expect(loadCatalogCache()).toBe(true);
		const bad = catalogEntryFor("zai", "glm-bad");
		expect(bad?.contextWindow).toBeUndefined(); // string rejected
		expect(bad?.input).toBeUndefined(); // wrong shape rejected
		expect(bad?.cost).toBeUndefined();
		const good = catalogEntryFor("zai", "glm-good");
		expect(good?.contextWindow).toBe(128_000);
	});

	it("one quiet retry on 429/5xx before the window freezes (review P2-2)", async () => {
		let calls = 0;
		setCatalogFetcherForTest(async () => {
			calls++;
			return jsonResponse(calls === 1 ? 503 : 200, calls === 1 ? {} : zaiCatalog, { etag: '"r1"' });
		});
		const summary = await refreshCatalog({ families: ["zai"], force: true });
		expect(calls).toBe(2);
		expect(summary.fetched).toEqual(["zai"]);
		expect(catalogModelIds("zai")).toEqual(["glm-5.3", "glm-5.3-flash"]);
	});

	it("corrupt cache file → static floor, load returns false", () => {
		writeFileSync(process.env.INK_CATALOG_PATH as string, "{ not json", "utf-8");
		expect(loadCatalogCache()).toBe(false);
		expect(catalogModelIds("zai")).toBeNull();
	});

	it("INK_CATALOG_BASE_URL redirects the fetch", async () => {
		const saved = process.env.INK_CATALOG_BASE_URL;
		process.env.INK_CATALOG_BASE_URL = "https://mirror.example/";
		try {
			const { fetcher, logs } = fixtureFetcher({
				"https://mirror.example/api/models/providers/zai": jsonResponse(200, zaiCatalog),
			});
			setCatalogFetcherForTest(fetcher);
			await refreshCatalog({ families: ["zai"], force: true });
			expect(logs[0]?.url).toBe("https://mirror.example/api/models/providers/zai");
		} finally {
			if (saved === undefined) delete process.env.INK_CATALOG_BASE_URL;
			else process.env.INK_CATALOG_BASE_URL = saved;
		}
	});
});

describe("M14 consult wiring", () => {
	let savedPath: string | undefined;
	beforeEach(() => {
		resetCatalogForTest();
		resetDiscoveredWindowsForTest();
		setCatalogClockForTest(() => 1_000_000);
		const tmp = mkTempDir("ink-catalog-consult-");
		savedPath = process.env.INK_CATALOG_PATH;
		process.env.INK_CATALOG_PATH = join(tmp, "models-catalog.json");
	});
	afterEach(() => {
		resetCatalogForTest();
		resetDiscoveredWindowsForTest();
		if (savedPath === undefined) delete process.env.INK_CATALOG_PATH;
		else process.env.INK_CATALOG_PATH = savedPath;
	});

	it("catalog window beats discovery and the static table", () => {
		// static: glm-5.3 → 1_000_000; discovery enrichment would say 200_000
		registerDiscoveredContextWindows({ "glm-5.3": 200_000 });
		expect(contextWindowFor("glm-5.3")).toBe(200_000); // pre-overlay truth
		// overlay via disk: catalog says 512_000
		writeFileSync(
			process.env.INK_CATALOG_PATH as string,
			JSON.stringify({
				version: 1,
				providers: {
					zai: {
						models: { "glm-5.3": { id: "glm-5.3", contextWindow: 512_000 } },
						checkedAt: 1,
					},
				},
			}),
			"utf-8",
		);
		loadCatalogCache();
		expect(contextWindowFor("glm-5.3")).toBe(512_000);
		expect(contextWindowFor("zai/glm-5.3")).toBe(512_000); // prefixed form too
		// unknown id keeps the static floor
		expect(contextWindowFor("glm-5.2")).toBe(1_000_000);
		// INK_CONTEXT_WINDOW still wins over everything (review P2-4: this
		// was a dead set-and-delete; now actually asserted)
		process.env.INK_CONTEXT_WINDOW = "65536";
		try {
			expect(contextWindowFor("glm-5.3")).toBe(65536);
		} finally {
			delete process.env.INK_CONTEXT_WINDOW;
		}
	});

	it("catalog cost + family subscription annotation; anthropic stays unflagged", () => {
		writeFileSync(
			process.env.INK_CATALOG_PATH as string,
			JSON.stringify({
				version: 1,
				providers: {
					zai: {
						models: {
							"glm-5.3": { id: "glm-5.3", cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 } },
						},
						checkedAt: 1,
					},
					anthropic: {
						models: {
							"claude-sonnet-5": {
								id: "claude-sonnet-5",
								cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
							},
						},
						checkedAt: 1,
					},
				},
			}),
			"utf-8",
		);
		loadCatalogCache();
		expect(costFor("zai/glm-5.3")).toEqual({
			input: 1.4,
			output: 4.4,
			cacheRead: 0.26,
			cacheWrite: 0,
			subscription: true,
		});
		expect(costFor("anthropic/claude-sonnet-5")).toEqual({
			input: 2,
			output: 10,
			cacheRead: 0.2,
			cacheWrite: 2.5,
		});
		// static floor intact for unknown ids
		expect(costFor("zai/glm-5.2")?.subscription).toBe(true);
	});

	it("catalog thinking map beats MODEL_RULES; reasoning:false means no knob", () => {
		writeFileSync(
			process.env.INK_CATALOG_PATH as string,
			JSON.stringify({
				version: 1,
				providers: {
					zai: {
						models: {
							"glm-5.3": {
								id: "glm-5.3",
								reasoning: true,
								// the REAL pi.dev shape: all seven keys, null = unavailable
								thinkingLevelMap: {
									off: null,
									minimal: null,
									low: "low",
									medium: null,
									high: "high",
									xhigh: null,
									max: "max",
								},
								maxTokens: 131_072,
								compat: { supportsReasoningEffort: true },
							},
							"glm-5.3-flash": { id: "glm-5.3-flash", reasoning: false },
						},
						checkedAt: 1,
					},
				},
			}),
			"utf-8",
		);
		loadCatalogCache();
		const meta = thinkingMetaFor("zai", "glm-5.3");
		expect(meta?.style).toBe("glm-openai");
		expect(meta?.supportsEffort).toBe(true);
		expect(meta?.maxOutputTokens).toBe(131_072);
		expect(supportedThinkingLevels(meta)).toEqual(["low", "high", "max"]);
		// flash: catalog says no knob → only off (prefix rules would disagree)
		expect(supportedThinkingLevels(thinkingMetaFor("zai", "glm-5.3-flash"))).toEqual(["off"]);
		// unknown id → frozen static rules still answer
		expect(thinkingMetaFor("zai", "glm-5.2")?.style).toBe("glm-openai");
	});

	it("direct subscription metadata never inherits unscoped gateway discovery windows", () => {
		registerDiscoveredContextWindows({ "gpt-5.5": 99 });
		expect(contextWindowFor("openai/gpt-5.5")).toBe(99);
		expect(contextWindowFor("openai-codex/gpt-5.5")).toBe(131_072);
	});

	it("adaptive style derives from compat.forceAdaptiveThinking", () => {
		writeFileSync(
			process.env.INK_CATALOG_PATH as string,
			JSON.stringify({
				version: 1,
				providers: {
					anthropic: {
						models: {
							"claude-sonnet-5": {
								id: "claude-sonnet-5",
								reasoning: true,
								thinkingLevelMap: { xhigh: "xhigh", max: "max" },
								maxTokens: 128_000,
								compat: { forceAdaptiveThinking: true },
							},
						},
						checkedAt: 1,
					},
				},
			}),
			"utf-8",
		);
		loadCatalogCache();
		const meta = thinkingMetaFor("anthropic", "claude-sonnet-5");
		expect(meta?.style).toBe("anthropic-adaptive");
		expect(meta?.adaptive).toBe(true);
		expect(meta?.levelMap?.max).toBe("max");
	});

	it("subscription metadata lookup never borrows another provider's live capability overlay", () => {
		writeFileSync(
			process.env.INK_CATALOG_PATH!,
			JSON.stringify({
				version: 2,
				providers: {
					openai: {
						models: {
							"gpt-5.5": { id: "gpt-5.5", reasoning: false, input: ["text"], contextWindow: 900_000 },
						},
						checkedAt: 1,
					},
				},
			}),
		);
		loadCatalogCache();
		expect(thinkingMetaFor("openai", "gpt-5.5")).toBeNull();
		expect(thinkingMetaFor("openai-codex", "gpt-5.5")?.style).toBe("codex-effort");
		expect(modelSupportsVision("openai", "gpt-5.5")).toBe(false);
		expect(modelSupportsVision("openai-codex", "gpt-5.5")).toBe(true);
		expect(contextWindowFor("openai-codex/gpt-5.5")).toBe(131_072);
	});

	it("catalog input array decides vision; the prefix table is the floor", () => {
		writeFileSync(
			process.env.INK_CATALOG_PATH as string,
			JSON.stringify({
				version: 1,
				providers: {
					anthropic: {
						models: {
							// prefix rules say claude-* → vision; catalog truth says
							// this one is text-only
							"claude-text-only-hypothetical": { id: "claude-text-only-hypothetical", input: ["text"] },
						},
						checkedAt: 1,
					},
				},
			}),
			"utf-8",
		);
		loadCatalogCache();
		expect(modelSupportsVision("anthropic", "claude-text-only-hypothetical")).toBe(false);
		expect(modelSupportsVision("anthropic", "claude-sonnet-5")).toBe(true); // floor
	});
});

describe("M14 /model list fallback", () => {
	it("offline discovery falls back to catalog ids before static seeds", async () => {
		const { buildModelList } = await import("../src/repl/commands.js");
		const rows: Array<{ label: string; description?: string }> = [];
		const notes: string[] = [];
		const result = await buildModelList("zai/glm-5.3", {
			configured: (family) => family === "zai",
			discover: async () => null,
			catalogIds: (family) => (family === "zai" ? ["glm-5.3", "glm-5.3-flash"] : null),
		});
		rows.push(...result.rows);
		notes.push(...result.fallbackNotes);
		expect(rows.map((r) => r.label)).toEqual(["zai/glm-5.3", "zai/glm-5.3-flash"]);
		expect(notes).toEqual([]); // catalog rows are truth, not a degraded note
	});

	it("no catalog either → static seeds with the unreachable note", async () => {
		const { buildModelList } = await import("../src/repl/commands.js");
		const result = await buildModelList("zai/glm-5.3", {
			configured: (family) => family === "zai",
			discover: async () => null,
			catalogIds: () => null,
		});
		expect(result.fallbackNotes.length).toBe(1);
		expect(result.rows.some((r) => r.label.startsWith("zai/"))).toBe(true);
	});

	it("anthropic catalog rows drop glm ids (#glm-retire shaping)", async () => {
		const { buildModelList } = await import("../src/repl/commands.js");
		const result = await buildModelList("claude-sonnet-5", {
			configured: (family) => family === "anthropic",
			discover: async () => null,
			catalogIds: () => ["claude-sonnet-5", "glm-5.3"],
		});
		expect(result.rows.map((r) => r.label)).toEqual(["claude-sonnet-5"]);
	});

	// #gateway-truth: the catalog/static-seed fallback describes FIRST-PARTY
	// endpoints. When ANTHROPIC_BASE_URL points at a compat gateway (z.ai), a
	// failed probe must NOT surface claude ids the gateway never listed.
	it("redirected anthropic endpoint: probe failure shows no claude fallback rows", async () => {
		const { buildModelList } = await import("../src/repl/commands.js");
		const saved = process.env.ANTHROPIC_BASE_URL;
		process.env.ANTHROPIC_BASE_URL = "https://api.z.ai/api/anthropic";
		try {
			const result = await buildModelList("glm-5.3", {
				configured: (family) => family === "anthropic",
				discover: async () => null, // gateway probe failed
				catalogIds: () => ["claude-opus-5", "claude-sonnet-5", "glm-5.3"], // pi.dev cache would answer
			});
			expect(result.rows.some((r) => r.label.startsWith("claude-"))).toBe(false);
			// !redirect marker — the renderer swaps to the honest sentence (review P2)
			expect(result.fallbackNotes[0]).toMatch(/^!redirect /);
			expect(result.rows[0]?.label).toBe("glm-5.3"); // current still leads
		} finally {
			if (saved === undefined) delete process.env.ANTHROPIC_BASE_URL;
			else process.env.ANTHROPIC_BASE_URL = saved;
		}
	});

	// #gateway-truth sibling: zai/openai redirected by their own env vars behave
	// the same — no catalog/seed rows when the probe fails on a redirected family.
	it("redirected zai endpoint: probe failure shows no seed rows", async () => {
		const { buildModelList } = await import("../src/repl/commands.js");
		const saved = process.env.ZAI_BASE_URL;
		process.env.ZAI_BASE_URL = "https://gateway.example/api";
		try {
			const result = await buildModelList("zai/glm-5.3", {
				configured: (family) => family === "zai",
				discover: async () => null,
				catalogIds: () => ["glm-5.3", "glm-5.3-flash"],
			});
			expect(result.rows.map((r) => r.label)).toEqual(["zai/glm-5.3"]);
			// the !redirect marker drives the honest renderer sentence (review P2)
			expect(result.fallbackNotes[0]).toMatch(/^!redirect /);
		} finally {
			if (saved === undefined) delete process.env.ZAI_BASE_URL;
			else process.env.ZAI_BASE_URL = saved;
		}
	});

	it("redirected openai endpoint: probe failure shows no fallback rows either", async () => {
		const { buildModelList } = await import("../src/repl/commands.js");
		const saved = process.env.OPENAI_BASE_URL;
		process.env.OPENAI_BASE_URL = "https://gateway.example/v1";
		try {
			const result = await buildModelList("openai/gpt-5.2", {
				configured: (family) => family === "openai",
				discover: async () => null,
				catalogIds: () => ["gpt-5.2", "gpt-5.2-mini"],
			});
			expect(result.rows.map((r) => r.label)).toEqual(["openai/gpt-5.2"]);
			expect(result.fallbackNotes[0]).toMatch(/^!redirect /);
		} finally {
			if (saved === undefined) delete process.env.OPENAI_BASE_URL;
			else process.env.OPENAI_BASE_URL = saved;
		}
	});

	// regression guard: the #gateway-truth change must not break the legitimate
	// offline path — first-party + probe failure + catalog present still lists
	// catalog rows with NO unreachable note.
	it("first-party offline: catalog rows still shown, no note", async () => {
		const { buildModelList } = await import("../src/repl/commands.js");
		for (const [family, envVar, current, catalog] of [
			["anthropic", "ANTHROPIC_BASE_URL", "claude-sonnet-5", ["claude-sonnet-5", "claude-opus-5"]],
			["openai", "OPENAI_BASE_URL", "openai/gpt-5.2", ["gpt-5.2", "gpt-5.2-mini"]],
		] as const) {
			const saved = process.env[envVar as "ANTHROPIC_BASE_URL"];
			delete process.env[envVar as "ANTHROPIC_BASE_URL"]; // ALWAYS unset — the runner's env may carry a gateway URL
			const result = await buildModelList(current, {
				configured: (f) => f === family,
				discover: async () => null,
				catalogIds: (f) => (f === family ? [...catalog] : null),
			});
			const labels = result.rows.map((r) => r.label);
			expect(labels).toEqual(family === "anthropic" ? [...catalog] : catalog.map((id) => `${family}/${id}`));
			expect(result.fallbackNotes).toEqual([]);
			if (saved !== undefined) process.env[envVar as "ANTHROPIC_BASE_URL"] = saved;
		}
	});
});
