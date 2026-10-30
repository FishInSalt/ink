import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { authFilePath, loadApiKey, resolveApiKey } from "./auth-store.js";
import { getCodexAccessToken, getCodexRegistrationKey, loadCodexCredential } from "./codex-auth.js";
import { DEEPSEEK_DEFAULT_BASE_URL, DEEPSEEK_SEED_MODELS, deepseekApiKey } from "./deepseek.js";
import {
	MOONSHOT_CN_DEFAULT_BASE_URL,
	MOONSHOT_DEFAULT_BASE_URL,
	MOONSHOT_SEED_MODELS,
	moonshotApiKey,
	moonshotCnApiKey,
} from "./moonshotai.js";
import type { ProviderName } from "./resolve.js";
import { ZAI_DEFAULT_BASE_URL, ZAI_SEED_MODELS, zaiApiKey } from "./zai.js";

/**
 * Model-list discovery (#model-discovery): ask each configured endpoint what
 * it actually serves. The /model picker shows the union — "what you can use
 * right now" — instead of a hardcoded table that both missed models (z.ai
 * serves ten GLMs; the static list had three) and invented availability
 * (claude ids on an endpoint whose own /v1/models never lists them).
 *
 * Truth sources per family:
 *   anthropic     GET {ANTHROPIC_BASE_URL|api.anthropic.com}/v1/models — the
 *                 Anthropic-compatible standard (verified live against z.ai)
 *   openai        GET {OPENAI_BASE_URL|api.openai.com}/v1}/models — the
 *                 OpenAI-compatible standard
 *   openai-codex  authenticated GET {subscription base}/models — only
 *                 visibility:list slugs, in server order. Public metadata
 *                 is never evidence of account availability.
 *
 * Results are cached 5 minutes per (family, baseUrl); subscription results
 * also carry the active registration generation and persist separately
 * from credentials and public metadata. Requests are bounded to 4s.
 */

const CACHE_TTL_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 4_000;
/** Page cap for cursor-paginated /v1/models listings (same spirit as the MCP
 *  tools/list cap): a lying cursor must bound the loop even if ids keep
 *  being "new". */
export const MODELS_PAGE_CAP = 10;

interface CacheEntry {
	ids: string[];
	at: number;
}

const cache = new Map<string, CacheEntry>();

/** Runtime window enrichment (#context-window-adapt): listings that carry
 *  contextWindow metadata (pi.dev's catalogs do; the first-party
 *  /v1/models endpoints do not) feed this map, which outranks the static
 *  table — a newly shipped model gets its REAL window before any registry
 *  update, so compaction neither fires absurdly early nor too late. */
const discoveredWindows = new Map<string, number>();

export function registerDiscoveredContextWindows(windows: Record<string, number>): void {
	for (const [id, ctx] of Object.entries(windows)) {
		if (Number.isFinite(ctx) && ctx > 0) discoveredWindows.set(id, ctx);
	}
}

export function resetDiscoveredWindowsForTest(): void {
	discoveredWindows.clear();
}

export function discoveredWindowFor(modelId: string): number | undefined {
	return discoveredWindows.get(modelId);
}

/** Injectable clock for tests. */
let now: () => number = Date.now;

export function setDiscoveryClockForTest(fn: () => number): void {
	now = fn;
}

export function resetDiscoveryCacheForTest(): void {
	cache.clear();
}

function anthropicBaseUrl(): string {
	return (process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/+$/, "");
}

function openaiBaseUrl(): string {
	return (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
}

/** Which credential, if any, is present for each family. #login-repl: a
 *  stored /login key counts exactly like the env var (pi's credential
 *  store participates in the same gate). */
export function familyConfigured(family: ProviderName): boolean {
	switch (family) {
		case "anthropic":
			return (
				loadApiKey("anthropic") !== null ||
				process.env.ANTHROPIC_AUTH_TOKEN !== undefined ||
				process.env.ANTHROPIC_API_KEY !== undefined
			);
		case "openai":
			return resolveApiKey("openai", "OPENAI_API_KEY") !== null;
		case "openai-codex":
			return loadCodexCredential() !== null;
		case "zai":
			return zaiApiKey() !== null;
		case "deepseek":
			return deepseekApiKey() !== null;
		case "moonshotai":
			return moonshotApiKey() !== null;
		case "moonshotai-cn":
			return moonshotCnApiKey() !== null;
		default: {
			const exhaustive: never = family;
			throw new Error(`unreachable family: ${JSON.stringify(exhaustive)}`);
		}
	}
}

/** The ids an endpoint serves (wire ids, endpoint order), or null when
 *  unconfigured/unreachable. A subscription's successful empty list is
 *  authoritative; callers must not substitute metadata or static seeds. */
export async function discoverModels(family: ProviderName): Promise<string[] | null> {
	if (!familyConfigured(family)) return null;
	if (family === "openai-codex") return discoverCodexModels();
	// deepseek: mirror of the zai branch below (official endpoint serves an
	// OpenAI-style /models; seeds are the pi.dev offline floor).
	if (family === "deepseek") {
		const cacheKey = "deepseek";
		const hit = cache.get(cacheKey);
		if (hit !== undefined && now() - hit.at < CACHE_TTL_MS) return hit.ids;
		const redirected = process.env.DEEPSEEK_BASE_URL !== undefined; // #gateway-truth
		const base = (process.env.DEEPSEEK_BASE_URL ?? DEEPSEEK_DEFAULT_BASE_URL).replace(/\/+$/, "");
		const ids = await fetchJson(
			`${base}/models`,
			{
				accept: "application/json",
				authorization: `Bearer ${String(deepseekApiKey())}`,
			},
			cacheKey,
		).catch(() => null);
		return redirected ? ids : (ids ?? ([...DEEPSEEK_SEED_MODELS] as string[]));
	}
	// moonshotai / moonshotai-cn: Moonshot's official endpoints serve an
	// OpenAI-style /models; seeds are the pi.dev offline floor (both families
	// share MOONSHOT_API_KEY — the stored key is per family, and a key that
	// belongs to the other platform 401s into the seed fallback here).
	if (family === "moonshotai" || family === "moonshotai-cn") {
		const envVar = family === "moonshotai" ? "MOONSHOT_BASE_URL" : "MOONSHOT_CN_BASE_URL";
		const fallback = family === "moonshotai" ? MOONSHOT_DEFAULT_BASE_URL : MOONSHOT_CN_DEFAULT_BASE_URL;
		const redirected = process.env[envVar] !== undefined; // #gateway-truth
		const base = (process.env[envVar] ?? fallback).replace(/\/+$/, "");
		// per-(family, baseUrl) key, like the anthropic/openai path (review P3-5)
		const cacheKey = `${family}|${base}`;
		const hit = cache.get(cacheKey);
		if (hit !== undefined && now() - hit.at < CACHE_TTL_MS) return hit.ids;
		const key = family === "moonshotai" ? moonshotApiKey() : moonshotCnApiKey();
		const ids = await fetchJson(
			`${base}/models`,
			{
				accept: "application/json",
				authorization: `Bearer ${String(key)}`,
			},
			cacheKey,
		).catch(() => null);
		return redirected ? ids : (ids ?? ([...MOONSHOT_SEED_MODELS] as string[]));
	}
	// zai: the coding endpoint serves an OpenAI-style /models; the pi.dev
	// live catalog is the offline seed when it 404s or the family is
	// configured but unreachable.
	if (family === "zai") {
		// same cache + TTL discipline as the other families (a trailing
		// slash in ZAI_BASE_URL must not become .../v4//models)
		const cacheKey = "zai";
		const hit = cache.get(cacheKey);
		if (hit !== undefined && now() - hit.at < CACHE_TTL_MS) return hit.ids;
		const redirected = process.env.ZAI_BASE_URL !== undefined; // #gateway-truth
		const base = (process.env.ZAI_BASE_URL ?? ZAI_DEFAULT_BASE_URL).replace(/\/+$/, "");
		const ids = await fetchJson(
			`${base}/models`,
			{
				accept: "application/json",
				authorization: `Bearer ${String(zaiApiKey())}`,
			},
			cacheKey,
		).catch(() => null);
		// #gateway-truth: the static GLM seeds describe Z.ai's own endpoint. On a
		// redirected ZAI_BASE_URL gateway they would invent ids that gateway
		// never listed — return null so the picker's redirect-aware branch
		// shows the honest "unreachable" note instead (review P1).
		return redirected ? ids : (ids ?? ([...ZAI_SEED_MODELS] as string[]));
	}

	const baseUrl = family === "anthropic" ? anthropicBaseUrl() : openaiBaseUrl();
	const cacheKey = `${family}|${baseUrl}`;
	const hit = cache.get(cacheKey);
	if (hit !== undefined && now() - hit.at < CACHE_TTL_MS) return hit.ids;

	let url: string;
	const headers: Record<string, string> = { accept: "application/json" };
	if (family === "anthropic") {
		// Same precedence as the provider: stored key (x-api-key) wins; env
		// keeps the bearer/x-api-key split it always had.
		const stored = loadApiKey("anthropic");
		const token = process.env.ANTHROPIC_AUTH_TOKEN;
		if (stored !== null) headers["x-api-key"] = stored;
		else if (token !== undefined) headers.authorization = `Bearer ${token}`;
		else headers["x-api-key"] = String(process.env.ANTHROPIC_API_KEY);
		headers["anthropic-version"] = "2023-06-01";
		// z.ai's Anthropic-compat endpoint returns camelCase pagination
		// metadata ({data, firstId, hasMore, lastId}); the real Anthropic API
		// returns snake_case {has_more, last_id}. Follow either — the
		// no-new-ids stop makes an ignoring server degrade to a single page.
		return fetchAnthropicModelsPaged(baseUrl, headers, cacheKey);
	} else {
		url = `${baseUrl}/models`;
		headers.authorization = `Bearer ${String(resolveApiKey("openai", "OPENAI_API_KEY")?.key)}`;
	}

	return fetchJson(url, headers, cacheKey);
}

/** One page of a models listing plus its cursor metadata. Accepts bare
 *  arrays, {data:[...]} / {models:[...]} (OpenAI/Anthropic/codex shapes) and
 *  the pi.dev record map; pagination wrapper fields are read in both casings
 *  (camelCase on z.ai's compat endpoint, snake_case on the real API). */
export interface ModelsPage {
	ids: string[];
	hasMore: boolean;
	lastId: string | null;
}
type PageOrRetry = ModelsPage | null | "retry";

/** Fetch a models listing page; never touches the cache (the paged loop owns
 *  cache writes so a partial walk is never stamped — review P2-2). */
async function fetchPage(url: string, headers: Record<string, string>): Promise<PageOrRetry> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const response = await fetch(url, { headers, signal: controller.signal });
		if (response.status === 429 || response.status >= 500) {
			await response.text().catch(() => ""); // drain before retrying
			return "retry";
		}
		if (!response.ok) return null;
		const json = (await response.json()) as unknown;
		const asRecord = typeof json === "object" && json !== null ? (json as Record<string, unknown>) : {};
		// Three listing shapes in the wild: a bare array, {data:[...]} /
		// {models:[...]}, and pi.dev's record keyed by model id (parseCatalog's
		// Object.values branch in the reference project).
		const candidate = Array.isArray(json)
			? json
			: Array.isArray(asRecord.data)
				? asRecord.data
				: Array.isArray(asRecord.models)
					? asRecord.models
					: Object.values(asRecord).length > 0 &&
							Object.values(asRecord).every((v) => typeof v === "object" && v !== null && "id" in v)
						? Object.values(asRecord)
						: null;
		const list: Array<{ id?: unknown; slug?: unknown; contextWindow?: unknown }> | null =
			candidate !== null ? (candidate as Array<{ id?: unknown; slug?: unknown }>) : null;
		if (list === null) return null;
		const entries = list.filter((m): m is { id?: unknown; slug?: unknown; contextWindow?: unknown } => {
			const id = m?.id ?? m?.slug;
			return typeof id === "string" && id !== "";
		});
		const ids = entries.map((m) => (m.id ?? m.slug) as string);
		// enrich the runtime window map when the listing carries metadata
		const windows: Record<string, number> = {};
		for (const m of entries) {
			if (typeof m.contextWindow === "number" && Number.isFinite(m.contextWindow) && m.contextWindow > 0) {
				windows[(m.id ?? m.slug) as string] = m.contextWindow;
			}
		}
		if (Object.keys(windows).length > 0) registerDiscoveredContextWindows(windows);
		if (ids.length === 0) return null;
		// Pagination metadata, both casings; absent on non-paging endpoints.
		const rawHasMore = asRecord.hasMore ?? asRecord.has_more;
		const rawLastId = asRecord.lastId ?? asRecord.last_id;
		return {
			ids,
			hasMore: rawHasMore === true,
			lastId: typeof rawLastId === "string" && rawLastId !== "" ? rawLastId : null,
		};
	} catch {
		return null; // offline / timeout / bad shape — caller falls back
	} finally {
		clearTimeout(timer);
	}
}

/** One quiet retry on throttling: a single 429 must not collapse the
 *  picker into its fallback seeds (observed live against z.ai). */
async function fetchPageWithRetry(url: string, headers: Record<string, string>): Promise<ModelsPage | null> {
	for (let attempt = 0; attempt < 2; attempt++) {
		if (attempt > 0) await new Promise((r) => setTimeout(r, 400));
		const result = await fetchPage(url, headers);
		if (result !== "retry") return result;
	}
	return null;
}

/** Un-paged API-key-family fetch with cache stamping. Subscription
 *  listings use the separate authenticated, visibility-aware path below. */
async function fetchJson(
	url: string,
	headers: Record<string, string>,
	cacheKey?: string,
): Promise<string[] | null> {
	const page = await fetchPageWithRetry(url, headers);
	if (page === null) return null;
	if (cacheKey !== undefined) cache.set(cacheKey, { ids: page.ids, at: now() });
	return page.ids;
}

/** Cursor-paginated anthropic-family listing (design §4): follow
 *  after_id while the endpoint reports more pages, dedupe by id so a server
 *  that ignores the cursor (observed live on z.ai: limit/lastId ignored)
 *  terminates on the unchanged second page, hard-capped at MODELS_PAGE_CAP.
 *  Cache semantics (review P2-2): one merged write after the loop; any
 *  mid-walk failure returns null outright — no partial list is cached. */
async function fetchAnthropicModelsPaged(
	baseUrl: string,
	headers: Record<string, string>,
	cacheKey: string,
): Promise<string[] | null> {
	const ids: string[] = [];
	const seen = new Set<string>();
	let url = `${baseUrl}/v1/models?limit=1000`;
	for (let page = 0; page < MODELS_PAGE_CAP; page++) {
		const result = await fetchPageWithRetry(url, headers);
		if (result === null) return null;
		const fresh = result.ids.filter((id) => !seen.has(id));
		for (const id of fresh) {
			seen.add(id);
			ids.push(id);
		}
		if (fresh.length === 0) break; // cursor ignored → same page: stop, keep what we have
		if (!result.hasMore || result.lastId === null) break; // normal end
		url = `${baseUrl}/v1/models?limit=1000&after_id=${encodeURIComponent(result.lastId)}`;
	}
	if (ids.length === 0) return null;
	cache.set(cacheKey, { ids, at: now() });
	return ids;
}

/** The subscription endpoint is independent of OPENAI_BASE_URL/API keys.
 *  Explicit injection permits loopback HTTP only for offline test servers. */
function subscriptionBase(injected?: string): string {
	const url = new URL(injected ?? process.env.OPENAI_CODEX_BASE_URL ?? "https://api.openai.com/v1");
	const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
	if (
		url.username !== "" ||
		url.password !== "" ||
		url.hash !== "" ||
		url.search !== "" ||
		(url.protocol !== "https:" && !(injected !== undefined && loopback && url.protocol === "http:"))
	) {
		throw new Error("Invalid subscription base URL: HTTPS without credentials, query or fragment required");
	}
	return url.href.replace(/\/+$/, "");
}

export interface CodexModelDiscoveryOptions {
	signal?: AbortSignal;
	/** Login uses force to recheck the newly granted account list. */
	force?: boolean;
	/** Test-only endpoint injection; production uses OPENAI_CODEX_BASE_URL. */
	baseUrl?: string;
}

interface CodexModelsFile {
	version: 1;
	source: "chatgpt-direct-models";
	entries: Record<string, CacheEntry>;
}

/** Separate from both the secret store and pi.dev's metadata cache. A
 *  relocated auth/catalog path also relocates this cache (hermetic tests). */
export function codexModelsCachePath(): string {
	const catalog = process.env.INK_CATALOG_PATH;
	if (catalog !== undefined) return `${catalog}.chatgpt-models.json`;
	if (process.env.INK_AUTH_PATH !== undefined) return `${authFilePath()}.chatgpt-models.json`;
	return join(dirname(authFilePath()), "chatgpt-models.json");
}

function codexCacheKey(base: string): string | null {
	if (loadCodexCredential() === null) return null;
	const registration = getCodexRegistrationKey();
	if (registration === null) return null;
	// Hash only non-secret identity. Token refresh must not create another
	// account cache, but login/registration generations must invalidate it.
	return createHash("sha256")
		.update(JSON.stringify([authFilePath(), base, registration]))
		.digest("hex");
}

function readCodexModelsFile(): CodexModelsFile {
	const empty: CodexModelsFile = { version: 1, source: "chatgpt-direct-models", entries: {} };
	try {
		const raw: unknown = JSON.parse(readFileSync(codexModelsCachePath(), "utf8"));
		if (typeof raw !== "object" || raw === null) return empty;
		const file = raw as Partial<CodexModelsFile>;
		if (
			file.version !== 1 ||
			file.source !== empty.source ||
			typeof file.entries !== "object" ||
			file.entries === null
		)
			return empty;
		for (const [key, entry] of Object.entries(file.entries)) {
			if (
				/^[a-f0-9]{64}$/.test(key) &&
				typeof entry === "object" &&
				entry !== null &&
				typeof entry.at === "number" &&
				Number.isFinite(entry.at) &&
				Array.isArray(entry.ids) &&
				entry.ids.every((id) => typeof id === "string" && id.trim() !== "")
			)
				empty.entries[key] = { at: entry.at, ids: [...entry.ids] };
		}
	} catch {
		// Missing/corrupt/unreadable availability is unknown, never seeds.
	}
	return empty;
}

function cachedCodexModelsEntry(): CacheEntry | null {
	try {
		const key = codexCacheKey(subscriptionBase());
		if (key === null) return null;
		const memoryKey = `chatgpt|${codexModelsCachePath()}|${key}`;
		return cache.get(memoryKey) ?? readCodexModelsFile().entries[key] ?? null;
	} catch {
		return null;
	}
}

function codexModelsFresh(entry: CacheEntry): boolean {
	const age = now() - entry.at;
	return age >= 0 && age < CACHE_TTL_MS;
}

/** Account-scoped picker fallback, potentially stale: availability must be
 *  labeled unverified. Never use this accessor for automatic selection.
 *  null means unknown; [] is the account's last successful empty list. */
export function cachedCodexModelIds(): string[] | null {
	return cachedCodexModelsEntry()?.ids.slice() ?? null;
}

/** Synchronous automatic-startup candidate list, only within the same
 *  5-minute freshness window as live discovery. Stale/future timestamps
 *  resolve to unknown; a fresh empty list remains authoritative. */
export function freshCachedCodexModelIds(): string[] | null {
	const entry = cachedCodexModelsEntry();
	return entry !== null && codexModelsFresh(entry) ? entry.ids.slice() : null;
}

function persistCodexModels(key: string, entry: CacheEntry): void {
	const file = readCodexModelsFile();
	file.entries[key] = { ids: [...entry.ids], at: entry.at };
	// Bound endpoint/generation history; only one registration is active.
	file.entries = Object.fromEntries(
		Object.entries(file.entries)
			.sort((a, b) => b[1].at - a[1].at)
			.slice(0, 16),
	);
	let pending: string | undefined;
	try {
		const path = codexModelsCachePath();
		mkdirSync(dirname(path), { recursive: true });
		pending = `${path}.${process.pid}.${randomUUID()}.tmp`;
		writeFileSync(pending, `${JSON.stringify(file)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
		renameSync(pending, path);
		pending = undefined;
	} catch {
		// Unwritable cache must not prevent this process using a live list.
	} finally {
		if (pending !== undefined) {
			try {
				unlinkSync(pending);
			} catch {
				/* No temporary artifact to retain. */
			}
		}
	}
}

/** Bounded credential-bearing body read; errors never contain server data. */
async function readSubscriptionModels(response: Response, signal: AbortSignal): Promise<string[] | null> {
	if (response.body === null) return null;
	const reader = response.body.getReader();
	const abort = () => {
		void reader.cancel().catch(() => {});
	};
	signal.addEventListener("abort", abort, { once: true });
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		if (signal.aborted) return null;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > 2 * 1024 * 1024) return null;
			chunks.push(value);
		}
		if (signal.aborted) return null;
		const json: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		if (typeof json !== "object" || json === null || !("models" in json) || !Array.isArray(json.models))
			return null;
		return json.models.flatMap((model: unknown) => {
			if (typeof model !== "object" || model === null) return [];
			const item = model as { visibility?: unknown; slug?: unknown };
			return item.visibility === "list" && typeof item.slug === "string" && item.slug.trim() !== ""
				? [item.slug]
				: [];
		});
	} finally {
		signal.removeEventListener("abort", abort);
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

/** Authenticated subscription availability, never pi.dev or API-key
 *  discovery. Refresh happens through the shared OAuth accessor. */
export async function discoverCodexModels(
	options: CodexModelDiscoveryOptions = {},
): Promise<string[] | null> {
	if (!familyConfigured("openai-codex") || options.signal?.aborted) return null;
	const controller = new AbortController();
	const abort = () => controller.abort();
	options.signal?.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(abort, REQUEST_TIMEOUT_MS);
	timer.unref();
	try {
		const base = subscriptionBase(options.baseUrl);
		const keyBefore = codexCacheKey(base);
		if (keyBefore === null) return null;
		const memoryKey = `chatgpt|${codexModelsCachePath()}|${keyBefore}`;
		const hit = cache.get(memoryKey) ?? readCodexModelsFile().entries[keyBefore];
		if (!options.force && hit !== undefined && codexModelsFresh(hit)) return [...hit.ids];
		const auth = await getCodexAccessToken({ signal: controller.signal });
		// Refresh may advance the credential generation. Use the refreshed
		// snapshot's cache key, but never attribute an old in-flight token to
		// a different login which completed while authentication was pending.
		const current = loadCodexCredential();
		const key = codexCacheKey(base);
		if (
			key === null ||
			current === null ||
			controller.signal.aborted ||
			auth.accessToken !== current.accessToken ||
			auth.clientId !== current.clientId ||
			auth.subject !== current.subject
		)
			return null;
		const response = await fetch(`${base}/models`, {
			method: "GET",
			headers: { accept: "application/json", authorization: `Bearer ${auth.accessToken}` },
			redirect: "error",
			signal: controller.signal,
		});
		if (!response.ok) {
			await response.body?.cancel().catch(() => {});
			return null;
		}
		const ids = await readSubscriptionModels(response, controller.signal);
		if (ids === null || controller.signal.aborted || codexCacheKey(base) !== key) return null;
		const entry = { ids: [...ids], at: now() };
		cache.set(`chatgpt|${codexModelsCachePath()}|${key}`, entry);
		persistCodexModels(key, entry);
		return ids;
	} catch {
		return null; // quiet discovery; login/inference reports auth failures
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", abort);
	}
}
