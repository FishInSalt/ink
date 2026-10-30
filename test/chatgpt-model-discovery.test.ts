import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as auth from "../src/provider/codex-auth.js";
import {
	cachedCodexModelIds,
	codexModelsCachePath,
	discoverCodexModels,
	discoverModels,
	familyConfigured,
	freshCachedCodexModelIds,
	resetDiscoveryCacheForTest,
	setDiscoveryClockForTest,
} from "../src/provider/discover.js";
import { decideStartupModel, resolveStartupModelFallback } from "../src/provider/startup-model.js";
import { buildModelList } from "../src/repl/commands.js";
import { mkTempDir } from "./helpers/mktemp.js";

const base = "https://subscription.example/v1";
const fixtureCredential = () => ({
	type: "chatgpt-oauth",
	provider: "openai-codex",
	accessToken: "fixture-access-token",
	refreshToken: "fixture-refresh-token",
	expiresAt: Date.now() + 3_600_000,
	clientId: "issued-fixture-client",
	issuer: "https://auth.openai.com",
	subject: "fixture-subject",
	idToken: "fixture-id-token",
	scopes: ["openid", "profile", "email", "offline_access", "chatgpt.tokens.use.direct"],
});
let clock = 1_000_000;
let authPath: string;
let catalogPath: string;
let body: unknown;
let requests: Array<{ url: string; init: RequestInit }>;

function credentialFile(changes: Record<string, unknown> = {}, revision = "generation-a"): void {
	writeFileSync(
		authPath,
		JSON.stringify({
			version: 1,
			hostId: "a73e4eec-dc3a-4000-9000-000000000001",
			codexRevision: revision,
			codex: { ...fixtureCredential(), ...changes },
			apiKeys: { openai: "fixture-api-key-not-for-subscriptions" },
		}),
	);
}

beforeEach(() => {
	const root = mkTempDir("ink-disc-");
	authPath = join(root, "auth.json");
	catalogPath = join(root, "catalog.json");
	vi.stubEnv("INK_AUTH_PATH", authPath);
	vi.stubEnv("INK_CATALOG_PATH", catalogPath);
	vi.stubEnv("INK_CATALOG_BASE_URL", "https://metadata.example");
	vi.stubEnv("OPENAI_CODEX_BASE_URL", base);
	for (const key of [
		"OPENAI_API_KEY",
		"ANTHROPIC_API_KEY",
		"ANTHROPIC_AUTH_TOKEN",
		"ZAI_API_KEY",
		"DEEPSEEK_API_KEY",
		"MOONSHOT_API_KEY",
	])
		vi.stubEnv(key, undefined);
	credentialFile();
	// Startup tests need exactly one configured family; store an API key
	// only in the discovery tests which explicitly verify billing isolation.
	const store = JSON.parse(readFileSync(authPath, "utf8"));
	delete store.apiKeys;
	writeFileSync(authPath, JSON.stringify(store));
	clock = 1_000_000;
	resetDiscoveryCacheForTest();
	setDiscoveryClockForTest(() => clock);
	requests = [];
	body = {
		models: [
			{ slug: "server-first", visibility: "list" },
			{ slug: "server-second", visibility: "list" },
		],
	};
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
			requests.push({ url: String(input), init });
			return new Response(JSON.stringify(body), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}),
	);
});
afterEach(() => {
	resetDiscoveryCacheForTest();
	setDiscoveryClockForTest(Date.now);
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("direct subscription account models", () => {
	it("GETs subscription /models with refreshed OAuth only, no legacy account or API-key headers", async () => {
		credentialFile(); // another provider's key must never authorize this request
		const original = readFileSync(authPath, "utf8");
		expect(await discoverModels("openai-codex")).toEqual(["server-first", "server-second"]);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe(`${base}/models`);
		expect(requests[0]?.init).toMatchObject({
			method: "GET",
			redirect: "error",
			headers: { accept: "application/json", authorization: "Bearer fixture-access-token" },
		});
		expect(Object.keys(requests[0]!.init.headers!)).toEqual(["accept", "authorization"]);
		expect(requests[0]?.init.signal).toBeInstanceOf(AbortSignal);
		expect(readFileSync(authPath, "utf8")).toBe(original);
	});

	it("accepts only visibility:list slugs in server order, never id aliases or public catalogs", async () => {
		body = {
			models: [
				{ id: "wrong-id", slug: "z-first", visibility: "list" },
				{ slug: "hidden", visibility: "hidden" },
				{ slug: "unmarked" },
				{ id: "no-slug", visibility: "list" },
				{ slug: "", visibility: "list" },
				{ slug: "  ", visibility: "list" },
				null,
				"bad",
				{ slug: "a-second", visibility: "list" },
			],
		};
		expect(await discoverCodexModels()).toEqual(["z-first", "a-second"]);
		expect(requests.map((request) => request.url)).toEqual([`${base}/models`]);
	});

	it.each([{ models: [] }, { models: [{ slug: "hidden", visibility: "hidden" }] }])(
		"successful empty account lists are authoritative and persist (%j)",
		async (empty) => {
			body = empty;
			expect(await discoverCodexModels()).toEqual([]);
			expect(await discoverCodexModels()).toEqual([]);
			expect(requests).toHaveLength(1);
			resetDiscoveryCacheForTest();
			expect(cachedCodexModelIds()).toEqual([]);
			expect(freshCachedCodexModelIds()).toEqual([]);
			expect(resolveStartupModelFallback()).toBeUndefined();
		},
	);

	it.each([
		{ data: [{ id: "api-key-list" }] },
		{ bare: [{ slug: "bare-array", visibility: "list" }] },
		{},
		null,
	])("rejects non-subscription listing shapes (%j)", async (invalid) => {
		body = invalid !== null && "bare" in invalid ? invalid.bare : invalid;
		expect(await discoverCodexModels()).toBeNull();
		expect(cachedCodexModelIds()).toBeNull();
	});

	it("persists secret-free account data separately from auth and public metadata", async () => {
		writeFileSync(catalogPath, JSON.stringify({ version: 1, providers: {} }));
		await discoverCodexModels();
		const path = codexModelsCachePath();
		expect(path).toBe(`${catalogPath}.chatgpt-models.json`);
		expect(path).not.toBe(authPath);
		const text = readFileSync(path, "utf8");
		for (const secret of [
			"fixture-access-token",
			"fixture-refresh-token",
			"fixture-id-token",
			"fixture-subject",
			"issued-fixture-client",
		])
			expect(text).not.toContain(secret);
		expect(JSON.parse(text)).toMatchObject({ version: 1, source: "chatgpt-direct-models" });
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(catalogPath, "utf8"))).toEqual({ version: 1, providers: {} });
		resetDiscoveryCacheForTest();
		expect(cachedCodexModelIds()).toEqual(["server-first", "server-second"]);
		expect(await discoverCodexModels()).toEqual(["server-first", "server-second"]);
		expect(requests).toHaveLength(1);
	});

	it("default endpoint is public /v1/models and does not follow the ordinary OpenAI base override", async () => {
		vi.stubEnv("OPENAI_CODEX_BASE_URL", undefined);
		vi.stubEnv("OPENAI_BASE_URL", "https://api-key-gateway.example/v1");
		await discoverCodexModels();
		expect(requests[0]?.url).toBe("https://api.openai.com/v1/models");
	});

	it("uses the first account slug for unselected startup only, and returns a defensive copy", async () => {
		await discoverCodexModels();
		const ids = freshCachedCodexModelIds();
		ids?.reverse();
		expect(freshCachedCodexModelIds()).toEqual(["server-first", "server-second"]);
		expect(cachedCodexModelIds()).toEqual(["server-first", "server-second"]);
		expect(resolveStartupModelFallback()).toEqual({
			family: "openai-codex",
			reference: "openai-codex/server-first",
		});
		const input = {
			model: "claude-sonnet-4-5",
			source: "builtin" as const,
			explicit: false,
			resuming: false,
			isUsable: () => false,
		};
		expect(decideStartupModel(input)).toMatchObject({
			kind: "resolve",
			fallback: { reference: "openai-codex/server-first" },
		});
		for (const source of ["cli", "env", "project", "global"] as const)
			expect(decideStartupModel({ ...input, source, model: "openai-codex/not-listed" })).toEqual({
				kind: "keep",
			});
		expect(decideStartupModel({ ...input, resuming: true })).toEqual({ kind: "keep" });
	});

	it("unknown offline availability leaves startup unresolved, not legacy Codex or API-key billing", async () => {
		expect(cachedCodexModelIds()).toBeNull();
		expect(resolveStartupModelFallback()).toBeUndefined();
		vi.mocked(fetch).mockRejectedValue(new Error("offline"));
		expect(await discoverCodexModels()).toBeNull();
		expect(resolveStartupModelFallback()).toBeUndefined();
	});

	it.each([false, true])(
		"automatic startup ignores a stale account snapshot (reload=%s), while picker labels it unverified",
		async (reload) => {
			await discoverCodexModels();
			if (reload) resetDiscoveryCacheForTest();
			clock += 5 * 60_000; // exact TTL boundary is stale, not only after it
			expect(freshCachedCodexModelIds()).toBeNull();
			expect(cachedCodexModelIds()).toEqual(["server-first", "server-second"]);
			expect(resolveStartupModelFallback()).toBeUndefined();
			expect(
				decideStartupModel({
					model: "claude-sonnet-4-5",
					source: "builtin",
					explicit: false,
					resuming: false,
					isUsable: () => false,
				}),
			).toEqual({ kind: "unresolved" });
			vi.mocked(fetch).mockRejectedValue(new Error("offline"));
			expect(await discoverCodexModels()).toBeNull();
			expect(resolveStartupModelFallback()).toBeUndefined();
			const result = await buildModelList("current-custom", {
				configured: (family) => family === "openai-codex",
				discover: discoverModels,
				cachedCodexIds: cachedCodexModelIds,
				catalogIds: () => null,
			});
			expect(result.rows.map((row) => row.label)).toEqual([
				"current-custom",
				"openai-codex/server-first",
				"openai-codex/server-second",
			]);
			expect(result.fallbackNotes.join(" ")).toMatch(/unverified/i);
		},
	);

	it("fresh-cache startup cutoff is five minutes and rejects future timestamps", async () => {
		await discoverCodexModels();
		const listedAt = clock;
		clock = listedAt + 5 * 60_000 - 1;
		expect(freshCachedCodexModelIds()).toEqual(["server-first", "server-second"]);
		expect(resolveStartupModelFallback()?.reference).toBe("openai-codex/server-first");
		clock++;
		expect(freshCachedCodexModelIds()).toBeNull();
		expect(resolveStartupModelFallback()).toBeUndefined();
		clock = listedAt - 1;
		expect(freshCachedCodexModelIds()).toBeNull();
		expect(resolveStartupModelFallback()).toBeUndefined();
	});

	it("a stale empty list also remains unresolved and can never select a legacy model", async () => {
		body = { models: [] };
		await discoverCodexModels();
		clock += 6 * 60_000;
		resetDiscoveryCacheForTest();
		expect(freshCachedCodexModelIds()).toBeNull();
		expect(cachedCodexModelIds()).toEqual([]);
		expect(resolveStartupModelFallback()).toBeUndefined();
	});

	it("TTL rechecks the endpoint and failed refreshes retain only the labeled offline snapshot", async () => {
		await discoverCodexModels();
		clock += 6 * 60_000;
		vi.mocked(fetch).mockRejectedValue(new Error("offline"));
		expect(await discoverCodexModels()).toBeNull();
		expect(requests).toHaveLength(1); // failed mock does not reach the recording handler
		expect(cachedCodexModelIds()).toEqual(["server-first", "server-second"]);
		expect(freshCachedCodexModelIds()).toBeNull();
		expect(resolveStartupModelFallback()).toBeUndefined();
		vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ models: [] })));
		expect(await discoverCodexModels({ force: true })).toEqual([]);
		expect(cachedCodexModelIds()).toEqual([]);
	});

	it("token rotation preserves cache identity; login generation, registration, host and endpoint changes invalidate it", async () => {
		await discoverCodexModels();
		const file = JSON.parse(readFileSync(authPath, "utf8"));
		file.codex.accessToken = "rotated-access";
		file.codex.refreshToken = "rotated-refresh";
		writeFileSync(authPath, JSON.stringify(file));
		expect(cachedCodexModelIds()).toEqual(["server-first", "server-second"]);
		for (const change of [
			{ codexRevision: "generation-b" },
			{ hostId: "a73e4eec-dc3a-4000-9000-000000000002" },
			{ codex: { ...file.codex, clientId: "another-client" } },
			{ codex: { ...file.codex, subject: "another-subject" } },
		]) {
			writeFileSync(authPath, JSON.stringify({ ...file, ...change }));
			expect(cachedCodexModelIds()).toBeNull();
		}
		writeFileSync(authPath, JSON.stringify(file));
		vi.stubEnv("OPENAI_CODEX_BASE_URL", "https://other-subscription.example/v1");
		expect(cachedCodexModelIds()).toBeNull();
		await discoverCodexModels();
		expect(requests.at(-1)?.url).toBe("https://other-subscription.example/v1/models");
	});

	it("endpoint rechecks retain only that endpoint's list, including authoritative empty data", async () => {
		await discoverCodexModels();
		vi.stubEnv("OPENAI_CODEX_BASE_URL", "https://other-subscription.example/v1");
		body = { models: [] };
		expect(await discoverCodexModels()).toEqual([]);
		expect(cachedCodexModelIds()).toEqual([]);
		vi.stubEnv("OPENAI_CODEX_BASE_URL", base);
		expect(cachedCodexModelIds()).toEqual(["server-first", "server-second"]);
	});

	it("unwritable cache storage does not discard a successful live list", async () => {
		// The metadata path is a regular file: a nested directory cannot be created.
		writeFileSync(catalogPath, "not a directory");
		vi.stubEnv("INK_CATALOG_PATH", join(catalogPath, "nested.json"));
		expect(await discoverCodexModels()).toEqual(["server-first", "server-second"]);
		expect(cachedCodexModelIds()).toEqual(["server-first", "server-second"]);
	});

	it("never publishes a stale in-flight account result into a changed login generation", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		vi.mocked(fetch).mockImplementation(async () => {
			await gate;
			return new Response(JSON.stringify(body));
		});
		const pending = discoverCodexModels();
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
		credentialFile({}, "generation-b");
		release();
		expect(await pending).toBeNull();
		expect(cachedCodexModelIds()).toBeNull();
	});

	it("uses the shared refreshed-token accessor with a bounded, cancellable signal", async () => {
		const accessor = vi.spyOn(auth, "getCodexAccessToken").mockImplementation(async () => {
			const file = JSON.parse(readFileSync(authPath, "utf8"));
			file.codex.accessToken = "fresh-from-shared-accessor";
			file.codex.refreshToken = "rotated-by-shared-accessor";
			writeFileSync(authPath, JSON.stringify(file));
			return file.codex;
		});
		await discoverCodexModels();
		expect(accessor).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) });
		expect(requests[0]?.init.headers).toMatchObject({ authorization: "Bearer fresh-from-shared-accessor" });
	});

	it("refresh generation updates cache scope rather than caching under the obsolete generation", async () => {
		vi.spyOn(auth, "getCodexAccessToken").mockImplementation(async () => {
			credentialFile({ accessToken: "refreshed-access" }, "refresh-generation");
			return JSON.parse(readFileSync(authPath, "utf8")).codex;
		});
		expect(await discoverCodexModels()).toEqual(["server-first", "server-second"]);
		expect(cachedCodexModelIds()).toEqual(["server-first", "server-second"]);
	});

	it("never sends an accessor's obsolete token after login replaces its stored snapshot", async () => {
		vi.spyOn(auth, "getCodexAccessToken").mockImplementation(async () => {
			const stale = JSON.parse(readFileSync(authPath, "utf8")).codex;
			credentialFile({ accessToken: "new-login-access" }, "new-login-generation");
			return stale;
		});
		expect(await discoverCodexModels()).toBeNull();
		expect(fetch).not.toHaveBeenCalled();
	});

	it("absent, disabled and legacy credentials do not discover or use cached account models", async () => {
		await discoverCodexModels();
		vi.mocked(fetch).mockClear();
		for (const value of [
			{},
			{ version: 1, codex: { ...fixtureCredential(), scopes: ["openid"] } },
			{
				version: 1,
				codex: {
					provider: "openai-codex",
					accessToken: "old",
					refreshToken: "old",
					expiresAt: Date.now() + 3_600_000,
					accountId: "legacy-account",
				},
			},
		]) {
			writeFileSync(authPath, JSON.stringify(value));
			expect(familyConfigured("openai-codex")).toBe(false);
			expect(await discoverCodexModels()).toBeNull();
			expect(cachedCodexModelIds()).toBeNull();
		}
		expect(fetch).not.toHaveBeenCalled();
	});

	it.each([
		"http://subscription.example/v1",
		"http://127.0.0.1:1/v1",
		"https://user:pass@subscription.example/v1",
		"https://subscription.example/v1#fragment",
		"https://subscription.example/v1?q=1",
	])("rejects unsafe production endpoint %s before acquiring/sending credentials", async (url) => {
		vi.stubEnv("OPENAI_CODEX_BASE_URL", url);
		expect(await discoverCodexModels()).toBeNull();
		expect(fetch).not.toHaveBeenCalled();
	});

	it("permits loopback HTTP only through explicit test injection, never following a redirect", async () => {
		vi.mocked(fetch).mockResolvedValue(
			new Response(null, { status: 302, headers: { location: "https://foreign.example/models" } }),
		);
		expect(await discoverCodexModels({ baseUrl: "http://127.0.0.1:1/v1" })).toBeNull();
		expect(fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:1/v1/models",
			expect.objectContaining({ redirect: "error" }),
		);
	});

	it("bounds response bodies and does not cache malformed JSON", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(new Response(" ".repeat(2 * 1024 * 1024 + 1)));
		expect(await discoverCodexModels()).toBeNull();
		vi.mocked(fetch).mockResolvedValueOnce(new Response("{ invalid"));
		expect(await discoverCodexModels()).toBeNull();
		expect(cachedCodexModelIds()).toBeNull();
	});

	it("caller cancellation bounds a stalled body read and cancels the reader", async () => {
		let cancelled = false;
		vi.mocked(fetch).mockResolvedValue(
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode('{"models":['));
					},
					cancel() {
						cancelled = true;
					},
				}),
			),
		);
		const controller = new AbortController();
		const pending = discoverCodexModels({ signal: controller.signal });
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
		controller.abort();
		expect(await pending).toBeNull();
		expect(cancelled).toBe(true);
		expect(cachedCodexModelIds()).toBeNull();
	});

	it("auth-path isolation does not reuse another store's identical registration and endpoint", async () => {
		await discoverCodexModels();
		const alternatePath = join(mkTempDir("ink-disc-"), "auth.json");
		writeFileSync(alternatePath, readFileSync(authPath));
		vi.stubEnv("INK_AUTH_PATH", alternatePath);
		expect(cachedCodexModelIds()).toBeNull();
	});

	it("auth-only path overrides relocate the availability cache without sharing a directory-global filename", () => {
		vi.stubEnv("INK_CATALOG_PATH", undefined);
		expect(codexModelsCachePath()).toBe(`${authPath}.chatgpt-models.json`);
	});

	it("corrupt or wrong-source account caches do not become availability", async () => {
		await discoverCodexModels();
		for (const text of ["{ invalid", JSON.stringify({ version: 1, source: "legacy-codex", entries: {} })]) {
			resetDiscoveryCacheForTest();
			writeFileSync(codexModelsCachePath(), text);
			expect(cachedCodexModelIds()).toBeNull();
		}
	});

	it("pre-aborted callers make no network request", async () => {
		const controller = new AbortController();
		controller.abort();
		expect(await discoverCodexModels({ signal: controller.signal })).toBeNull();
		expect(fetch).not.toHaveBeenCalled();
	});
});
