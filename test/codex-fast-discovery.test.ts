import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as auth from "../src/provider/codex-auth.js";
import { bundledCodexFastModeSupport } from "../src/provider/codex-speed-catalog.js";
import {
	cachedCodexModelIds,
	codexFastModeSupport,
	codexModelsCachePath,
	discoverCodexModels,
	freshCachedCodexModelIds,
	resetDiscoveryCacheForTest,
	setDiscoveryClockForTest,
} from "../src/provider/discover.js";
import { mkTempDir } from "./helpers/mktemp.js";

const base = "https://subscription.example/v1";
const future = "future-account-model";
const tier = (id: string) => ({ id, name: "Fixture tier", description: "Fixture description" });
const listed = (slug: string, fields: Record<string, unknown> = {}) => ({
	slug,
	visibility: "list",
	...fields,
});

let authPath: string;
let catalogPath: string;
let clock: number;
let body: unknown;

interface StoredEntry {
	ids: string[];
	at: number;
	fastModes?: unknown;
}

function readCache(): { version: number; source: string; entries: Record<string, StoredEntry> } {
	return JSON.parse(readFileSync(codexModelsCachePath(), "utf8"));
}

function storedEntry(): StoredEntry {
	const entries = Object.values(readCache().entries);
	expect(entries).toHaveLength(1);
	return entries[0]!;
}

function rewriteEntry(update: (entry: StoredEntry) => void): void {
	const file = readCache();
	for (const entry of Object.values(file.entries)) update(entry);
	writeFileSync(codexModelsCachePath(), JSON.stringify(file));
	resetDiscoveryCacheForTest();
}

beforeEach(() => {
	const root = mkTempDir("ink-disc-");
	authPath = join(root, "auth.json");
	catalogPath = join(root, "catalog.json");
	vi.stubEnv("INK_AUTH_PATH", authPath);
	vi.stubEnv("INK_CATALOG_PATH", catalogPath);
	vi.stubEnv("OPENAI_CODEX_BASE_URL", base);
	writeFileSync(
		authPath,
		JSON.stringify({
			version: 1,
			hostId: "a73e4eec-dc3a-4000-9000-000000000001",
			codexRevision: "generation-a",
			codex: {
				type: "chatgpt-oauth",
				provider: "openai-codex",
				accessToken: "fixture-access-token",
				refreshToken: "fixture-refresh-token",
				expiresAt: Date.now() + 3_600_000,
				clientId: "issued-fixture-client",
				issuer: "https://auth.openai.com",
				subject: "fixture-subject",
				idToken: "fixture-id-token",
				scopes: ["openid", "chatgpt.tokens.use.direct"],
			},
		}),
	);
	// Only fixture credentials are read; never refresh or contact an auth service.
	vi.spyOn(auth, "getCodexAccessToken").mockImplementation(async () => {
		const credential = auth.loadCodexCredential();
		if (credential === null) throw new Error("Missing fixture credential");
		return credential;
	});
	clock = 1_000_000;
	setDiscoveryClockForTest(() => clock);
	resetDiscoveryCacheForTest();
	body = { models: [] };
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }),
		),
	);
});

afterEach(() => {
	resetDiscoveryCacheForTest();
	setDiscoveryClockForTest(Date.now);
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("pinned official Codex Fast snapshot", () => {
	it("includes all 12 pinned entries, including both negatives and all 10 positives, without fetching", () => {
		const expected = {
			"gpt-6-astra": true,
			"gpt-6.1-sol": true,
			"gpt-6.1-terra": true,
			"gpt-6-sol": true,
			"gpt-6-luna": true,
			"gpt-5.6-sol": true,
			"gpt-5.6-terra": true,
			"gpt-5.6-luna": true,
			"gpt-daybreak-blue-latest": false,
			"gpt-daybreak-red-latest": false,
			"gpt-5.5": true,
			"codex-auto-review": true,
		};
		expect(Object.keys(expected)).toHaveLength(12);
		expect(Object.values(expected).filter(Boolean)).toHaveLength(10);
		for (const [id, support] of Object.entries(expected)) {
			expect(bundledCodexFastModeSupport(id), id).toBe(support);
			expect(codexFastModeSupport(id), id).toBe(support);
		}
		expect(cachedCodexModelIds()).toBeNull(); // Capability never invents account membership.
		expect(fetch).not.toHaveBeenCalled();
		expect(auth.getCodexAccessToken).not.toHaveBeenCalled();
	});

	it.each([
		future,
		"gpt-6.2-sol",
		"gpt-6.1-sol·fast",
		"openai-codex/gpt-6.1-sol",
		"fast",
		"constructor",
		"__proto__",
		"toString",
		"",
	])("keeps absent id %j unknown rather than inferring from names or object properties", (id) => {
		expect(bundledCodexFastModeSupport(id)).toBeUndefined();
		expect(codexFastModeSupport(id)).toBeUndefined();
		expect(fetch).not.toHaveBeenCalled();
	});
});

const hints: Array<{ name: string; fields: Record<string, unknown>; expected: boolean | undefined }> = [
	{ name: "modern priority", fields: { service_tiers: [tier("priority")] }, expected: true },
	{ name: "modern fast alias", fields: { service_tiers: [tier("fast")] }, expected: true },
	{ name: "legacy fast", fields: { additional_speed_tiers: ["fast"] }, expected: true },
	{ name: "modern empty", fields: { service_tiers: [] }, expected: false },
	{ name: "legacy empty", fields: { additional_speed_tiers: [] }, expected: false },
	{ name: "both empty", fields: { service_tiers: [], additional_speed_tiers: [] }, expected: false },
	{ name: "modern non-Fast tier", fields: { service_tiers: [tier("flex")] }, expected: false },
	{ name: "legacy non-Fast tier", fields: { additional_speed_tiers: ["priority"] }, expected: false },
	{
		name: "modern exact ids only",
		fields: { service_tiers: [tier("Priority"), tier(" fast")] },
		expected: false,
	},
	{ name: "legacy exact ids only", fields: { additional_speed_tiers: ["FAST", " fast"] }, expected: false },
	{
		name: "modern positive OR legacy empty",
		fields: { service_tiers: [tier("priority")], additional_speed_tiers: [] },
		expected: true,
	},
	{
		name: "legacy positive OR modern empty",
		fields: { service_tiers: [], additional_speed_tiers: ["fast"] },
		expected: true,
	},
	{
		name: "valid legacy despite malformed modern",
		fields: { service_tiers: "bad", additional_speed_tiers: ["fast"] },
		expected: true,
	},
	{
		name: "valid modern despite malformed legacy",
		fields: { service_tiers: [tier("priority")], additional_speed_tiers: null },
		expected: true,
	},
	{
		name: "valid negative despite malformed alternative",
		fields: { service_tiers: [], additional_speed_tiers: [3] },
		expected: false,
	},
	{ name: "missing fields", fields: {}, expected: undefined },
	{ name: "null fields", fields: { service_tiers: null, additional_speed_tiers: null }, expected: undefined },
	{
		name: "scalar fields",
		fields: { service_tiers: "priority", additional_speed_tiers: "fast" },
		expected: undefined,
	},
	{
		name: "record instead of array",
		fields: { service_tiers: tier("priority"), additional_speed_tiers: { fast: true } },
		expected: undefined,
	},
	{ name: "modern string entry", fields: { service_tiers: ["priority"] }, expected: undefined },
	{
		name: "modern missing description and name",
		fields: { service_tiers: [{ id: "priority" }] },
		expected: undefined,
	},
	{
		name: "modern non-string description",
		fields: { service_tiers: [{ ...tier("priority"), description: 1 }] },
		expected: undefined,
	},
	{
		name: "modern non-string id",
		fields: { service_tiers: [{ ...tier("priority"), id: 1 }] },
		expected: undefined,
	},
	{
		name: "modern non-string name",
		fields: { service_tiers: [{ ...tier("priority"), name: false }] },
		expected: undefined,
	},
	{
		name: "mixed malformed modern array",
		fields: { service_tiers: [tier("priority"), null] },
		expected: undefined,
	},
	{
		name: "mixed malformed legacy array",
		fields: { additional_speed_tiers: ["fast", 1] },
		expected: undefined,
	},
	{ name: "legacy object entry", fields: { additional_speed_tiers: [tier("fast")] }, expected: undefined },
	{ name: "unrelated cost tiers", fields: { cost: { tiers: [{ id: "priority" }] } }, expected: undefined },
];

describe("account Fast capability hints", () => {
	it.each(hints)("validates and round-trips $name", async ({ fields, expected }) => {
		body = { models: [listed(future, fields)] };
		expect(await discoverCodexModels()).toEqual([future]);
		expect(codexFastModeSupport(future)).toBe(expected);
		expect(storedEntry()).toEqual({
			ids: [future],
			at: clock,
			...(expected === undefined ? {} : { fastModes: { [future]: expected } }),
		});
		resetDiscoveryCacheForTest();
		expect(codexFastModeSupport(future)).toBe(expected);
		expect(await discoverCodexModels()).toEqual([future]);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("lets explicit account positives and negatives override the bundle, but not missing hints", async () => {
		body = {
			models: [
				listed("gpt-5.5", { service_tiers: [] }),
				listed("gpt-daybreak-blue-latest", { additional_speed_tiers: ["fast"] }),
				listed(future, { service_tiers: [tier("priority")] }),
				listed("gpt-6.1-sol"),
				listed("gpt-daybreak-red-latest"),
				listed("unknown-without-hints"),
			],
		};
		await discoverCodexModels();
		for (const reload of [false, true]) {
			if (reload) resetDiscoveryCacheForTest();
			expect(codexFastModeSupport("gpt-5.5")).toBe(false);
			expect(codexFastModeSupport("gpt-daybreak-blue-latest")).toBe(true);
			expect(codexFastModeSupport(future)).toBe(true);
			expect(codexFastModeSupport("gpt-6.1-sol")).toBe(true);
			expect(codexFastModeSupport("gpt-daybreak-red-latest")).toBe(false);
			expect(codexFastModeSupport("unknown-without-hints")).toBeUndefined();
		}
		expect(storedEntry().fastModes).toEqual({
			"gpt-5.5": false,
			"gpt-daybreak-blue-latest": true,
			[future]: true,
		});
	});

	it("retains hints only for visibility:list slugs, never hidden rows, aliases or missing slugs", async () => {
		body = {
			models: [
				listed(future, { id: "alias-not-a-slug", additional_speed_tiers: ["fast"] }),
				{ slug: "gpt-5.5", visibility: "hidden", service_tiers: [] },
				{ slug: "unmarked", additional_speed_tiers: ["fast"] },
				{ id: "no-slug", visibility: "list", additional_speed_tiers: ["fast"] },
				listed(" ", { additional_speed_tiers: ["fast"] }),
				null,
			],
		};
		expect(await discoverCodexModels()).toEqual([future]);
		expect(storedEntry().fastModes).toEqual({ [future]: true });
		expect(codexFastModeSupport("gpt-5.5")).toBe(true); // Hidden account evidence was not retained.
		for (const id of ["alias-not-a-slug", "unmarked", "no-slug"])
			expect(codexFastModeSupport(id)).toBeUndefined();
	});

	it("preserves old ids-only cache files and falls back to the bundle without a refresh", async () => {
		body = {
			models: [
				listed("gpt-5.5", { service_tiers: [] }),
				listed(future, { additional_speed_tiers: ["fast"] }),
			],
		};
		await discoverCodexModels();
		rewriteEntry((entry) => {
			delete entry.fastModes;
		});
		expect(cachedCodexModelIds()).toEqual(["gpt-5.5", future]);
		expect(await discoverCodexModels()).toEqual(["gpt-5.5", future]);
		expect(codexFastModeSupport("gpt-5.5")).toBe(true);
		expect(codexFastModeSupport(future)).toBeUndefined();
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("sanitizes cache hints independently of ids, preserving only listed boolean values including false", async () => {
		const ids = ["yes", "no", "string", "number", "null", "record", "gpt-5.5", "constructor", "__proto__"];
		body = { models: ids.map((id) => listed(id)) };
		await discoverCodexModels();
		rewriteEntry((entry) => {
			entry.fastModes = Object.fromEntries([
				["yes", true],
				["no", false],
				["string", "true"],
				["number", 1],
				["null", null],
				["record", { supported: true }],
				["gpt-5.5", "false"],
				["constructor", false],
				["__proto__", true],
				["not-listed", true],
				["gpt-daybreak-blue-latest", true],
			]);
		});
		expect(cachedCodexModelIds()).toEqual(ids);
		expect(codexFastModeSupport("yes")).toBe(true);
		expect(codexFastModeSupport("no")).toBe(false);
		expect(codexFastModeSupport("constructor")).toBe(false);
		expect(codexFastModeSupport("__proto__")).toBe(true);
		expect(codexFastModeSupport("gpt-5.5")).toBe(true);
		expect(codexFastModeSupport("gpt-daybreak-blue-latest")).toBe(false);
		for (const id of ["string", "number", "null", "record", "not-listed", "toString"])
			expect(codexFastModeSupport(id)).toBeUndefined();
	});

	it.each([null, [], "false", 1, true])(
		"ignores a malformed whole fastModes value %j without losing ids",
		async (value) => {
			body = { models: [listed("gpt-5.5"), listed(future)] };
			await discoverCodexModels();
			rewriteEntry((entry) => {
				entry.fastModes = value;
			});
			expect(await discoverCodexModels()).toEqual(["gpt-5.5", future]);
			expect(codexFastModeSupport("gpt-5.5")).toBe(true);
			expect(codexFastModeSupport(future)).toBeUndefined();
			expect(fetch).toHaveBeenCalledTimes(1);
		},
	);

	it.each(["force", "ttl"])(
		"replaces rather than merges hints on a successful %s refresh, including empty lists",
		async (refresh) => {
			body = {
				models: [
					listed(future, { additional_speed_tiers: ["fast"] }),
					listed("gpt-5.5", { service_tiers: [] }),
					listed("gpt-daybreak-blue-latest", { additional_speed_tiers: ["fast"] }),
				],
			};
			await discoverCodexModels();
			body = { models: [listed(future), listed("gpt-5.5")] };
			if (refresh === "ttl") clock += 5 * 60_000;
			expect(await discoverCodexModels({ force: refresh === "force" })).toEqual([future, "gpt-5.5"]);
			for (const reload of [false, true]) {
				if (reload) resetDiscoveryCacheForTest();
				expect(codexFastModeSupport(future)).toBeUndefined();
				expect(codexFastModeSupport("gpt-5.5")).toBe(true);
				expect(codexFastModeSupport("gpt-daybreak-blue-latest")).toBe(false);
			}
			expect(storedEntry()).toEqual({ ids: [future, "gpt-5.5"], at: clock });
			body = { models: [] };
			expect(await discoverCodexModels({ force: true })).toEqual([]);
			expect(storedEntry()).toEqual({ ids: [], at: clock });
			expect(cachedCodexModelIds()).toEqual([]);
		},
	);

	it("drops old hints when fresh fields are malformed and replaces true with explicit false", async () => {
		body = {
			models: [
				listed(future, { additional_speed_tiers: ["fast"] }),
				listed("gpt-5.5", { service_tiers: [] }),
			],
		};
		await discoverCodexModels();
		body = { models: [listed(future, { service_tiers: [] }), listed("gpt-5.5", { service_tiers: [null] })] };
		await discoverCodexModels({ force: true });
		expect(codexFastModeSupport(future)).toBe(false);
		expect(codexFastModeSupport("gpt-5.5")).toBe(true);
		expect(storedEntry().fastModes).toEqual({ [future]: false });
		resetDiscoveryCacheForTest();
		expect(codexFastModeSupport(future)).toBe(false);
	});

	it.each(["offline", "malformed", "http"])(
		"retains the same unverified offline snapshot and hints after a failed %s refresh",
		async (failure) => {
			body = {
				models: [
					listed(future, { additional_speed_tiers: ["fast"] }),
					listed("gpt-5.5", { service_tiers: [] }),
				],
			};
			await discoverCodexModels();
			const before = readFileSync(codexModelsCachePath(), "utf8");
			clock += 5 * 60_000;
			if (failure === "offline") vi.mocked(fetch).mockRejectedValue(new Error("fixture offline"));
			if (failure === "malformed") body = { data: [] };
			if (failure === "http") vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 503 }));
			expect(await discoverCodexModels()).toBeNull();
			for (const reload of [false, true]) {
				if (reload) resetDiscoveryCacheForTest();
				expect(cachedCodexModelIds()).toEqual([future, "gpt-5.5"]);
				expect(freshCachedCodexModelIds()).toBeNull();
				expect(codexFastModeSupport(future)).toBe(true);
				expect(codexFastModeSupport("gpt-5.5")).toBe(false);
			}
			expect(readFileSync(codexModelsCachePath(), "utf8")).toBe(before);
		},
	);

	it("persists only boolean evidence, atomically and separately from credentials and public metadata", async () => {
		writeFileSync(catalogPath, "fixture public metadata");
		const before = readFileSync(authPath, "utf8");
		body = {
			models: [
				listed(future, {
					service_tiers: [
						{ id: "priority", name: "private-tier-name", description: "private-tier-description" },
					],
					extra: "private-account-field",
				}),
			],
		};
		await discoverCodexModels();
		const text = readFileSync(codexModelsCachePath(), "utf8");
		for (const value of [
			"fixture-access-token",
			"fixture-refresh-token",
			"fixture-id-token",
			"fixture-subject",
			"issued-fixture-client",
			"private-tier-name",
			"private-tier-description",
			"private-account-field",
		])
			expect(text).not.toContain(value);
		expect(statSync(codexModelsCachePath()).mode & 0o777).toBe(0o600);
		expect(readdirSync(dirname(authPath)).some((name) => name.endsWith(".tmp"))).toBe(false);
		expect(readFileSync(authPath, "utf8")).toBe(before);
		expect(readFileSync(catalogPath, "utf8")).toBe("fixture public metadata");
		expect(storedEntry().fastModes).toEqual({ [future]: true });
	});

	it("keeps live hints in memory if the account cache cannot be persisted", async () => {
		writeFileSync(catalogPath, "not a directory");
		vi.stubEnv("INK_CATALOG_PATH", join(catalogPath, "nested.json"));
		body = { models: [listed(future, { service_tiers: [] })] };
		expect(await discoverCodexModels()).toEqual([future]);
		expect(cachedCodexModelIds()).toEqual([future]);
		expect(codexFastModeSupport(future)).toBe(false);
		expect(existsSync(codexModelsCachePath())).toBe(false);
	});

	it("does not treat pi.dev catalog membership or cost tiers as Fast evidence", () => {
		writeFileSync(
			catalogPath,
			JSON.stringify({
				version: 1,
				providers: { "openai-codex": { models: [{ id: future, cost: { tiers: ["fast"] } }] } },
			}),
		);
		expect(codexFastModeSupport(future)).toBeUndefined();
		expect(cachedCodexModelIds()).toBeNull();
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe("Fast hints share account discovery scope", () => {
	it.each([
		"generation",
		"subject",
		"client",
		"host",
		"auth-path",
		"cache-path",
		"endpoint",
		"disabled",
		"logout",
	])(
		"invalidates account hints with %s changes in memory and on disk, while retaining generic fallback",
		async (change) => {
			body = {
				models: [
					listed("gpt-5.5", { service_tiers: [] }),
					listed(future, { additional_speed_tiers: ["fast"] }),
				],
			};
			await discoverCodexModels();
			const original = readFileSync(authPath, "utf8");
			const file = JSON.parse(original);
			if (change === "generation") file.codexRevision = "generation-b";
			if (change === "subject") file.codex.subject = "another-subject";
			if (change === "client") file.codex.clientId = "another-client";
			if (change === "host") file.hostId = "a73e4eec-dc3a-4000-9000-000000000002";
			if (change === "disabled") file.codex.scopes = ["openid"];
			if (change === "logout") delete file.codex;
			writeFileSync(authPath, JSON.stringify(file));
			if (change === "auth-path") {
				const alternate = join(dirname(authPath), "other-auth.json");
				writeFileSync(alternate, original);
				vi.stubEnv("INK_AUTH_PATH", alternate);
			}
			if (change === "cache-path")
				vi.stubEnv("INK_CATALOG_PATH", join(dirname(catalogPath), "other-catalog.json"));
			if (change === "endpoint") vi.stubEnv("OPENAI_CODEX_BASE_URL", "https://other-subscription.example/v1");
			for (const reload of [false, true]) {
				if (reload) resetDiscoveryCacheForTest();
				expect(cachedCodexModelIds()).toBeNull();
				expect(codexFastModeSupport("gpt-5.5")).toBe(true);
				expect(codexFastModeSupport(future)).toBeUndefined();
			}
			vi.stubEnv("INK_AUTH_PATH", authPath);
			vi.stubEnv("INK_CATALOG_PATH", catalogPath);
			vi.stubEnv("OPENAI_CODEX_BASE_URL", base);
			writeFileSync(authPath, original);
			expect(codexFastModeSupport("gpt-5.5")).toBe(false);
			expect(codexFastModeSupport(future)).toBe(true);
			expect(fetch).toHaveBeenCalledTimes(1);
		},
	);

	it("preserves hints across access/refresh token rotation", async () => {
		body = { models: [listed(future, { service_tiers: [] })] };
		await discoverCodexModels();
		const file = JSON.parse(readFileSync(authPath, "utf8"));
		file.codex.accessToken = "rotated-fixture-access";
		file.codex.refreshToken = "rotated-fixture-refresh";
		writeFileSync(authPath, JSON.stringify(file));
		resetDiscoveryCacheForTest();
		expect(codexFastModeSupport(future)).toBe(false);
		expect(await discoverCodexModels()).toEqual([future]);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("keeps independent endpoint snapshots, including test-injected discovery", async () => {
		body = { models: [listed(future, { service_tiers: [] })] };
		await discoverCodexModels();
		const otherBase = "https://other-subscription.example/v1";
		body = { models: [listed(future, { additional_speed_tiers: ["fast"] })] };
		await discoverCodexModels({ baseUrl: otherBase });
		expect(codexFastModeSupport(future)).toBe(false);
		vi.stubEnv("OPENAI_CODEX_BASE_URL", otherBase);
		expect(codexFastModeSupport(future)).toBe(true);
		resetDiscoveryCacheForTest();
		expect(codexFastModeSupport(future)).toBe(true);
		vi.stubEnv("OPENAI_CODEX_BASE_URL", base);
		expect(codexFastModeSupport(future)).toBe(false);
		expect(Object.keys(readCache().entries)).toHaveLength(2);
	});

	it("does not publish in-flight hints into a changed registration generation", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		vi.mocked(fetch).mockImplementation(async () => {
			await gate;
			return new Response(JSON.stringify({ models: [listed(future, { additional_speed_tiers: ["fast"] })] }));
		});
		const pending = discoverCodexModels();
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
		const file = JSON.parse(readFileSync(authPath, "utf8"));
		file.codexRevision = "replacement-login";
		writeFileSync(authPath, JSON.stringify(file));
		release();
		expect(await pending).toBeNull();
		expect(cachedCodexModelIds()).toBeNull();
		expect(codexFastModeSupport(future)).toBeUndefined();
		expect(existsSync(codexModelsCachePath())).toBe(false);
	});
});
