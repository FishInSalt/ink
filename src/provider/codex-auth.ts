import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	type AuthStore,
	cancellationError,
	delayWithSignal,
	type LockedAuthStore,
	readAuthStore,
	waitWithSignal,
	withAuthStoreLock,
} from "./auth-storage.js";
import { authFilePath } from "./auth-store.js";
import { authorizationFromCallback, startCallbackListener } from "./codex-oauth-callback.js";
import {
	type AuthEndpoints,
	authEndpoints,
	CODEX_RESOURCE,
	CODEX_SCOPES,
	DIRECT_SCOPE,
	discoverOidc,
	isRecord,
	isTerminalRefreshCode,
	loadIdentityVerificationMaterial,
	nonempty,
	OAuthRequestError,
	type OidcConfiguration,
	oauthRequest,
	tokenRequest,
	verifyIdentityLocally,
} from "./codex-oauth-http.js";

const REFRESH_MARGIN_MS = 5 * 60_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const HOST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOGIN_REQUIRED =
	"Not logged in to ChatGPT direct subscription access. Run ink login to authorize this installation.";

export interface CodexCredential {
	type: "chatgpt-oauth";
	provider: "openai-codex";
	accessToken: string;
	refreshToken: string;
	/** Epoch milliseconds after which accessToken must not be used (no refresh margin subtracted). */
	expiresAt: number;
	clientId: string;
	issuer: string;
	subject: string;
	idToken: string;
	scopes: string[];
	earliestRefreshAt?: number;
}

interface Registration {
	type: "chatgpt-oauth";
	provider: "openai-codex";
	clientId: string;
	issuer: string;
	subject?: string;
	idToken?: string;
	scopes?: string[];
}

export interface CodexAuthOptions {
	authPath?: string;
	/** Explicit endpoint injection for tests/embedding; never read from the environment. */
	authBaseUrl?: string;
	signal?: AbortSignal;
}

export interface CodexLoginOptions extends CodexAuthOptions {
	callbackPort?: number;
	onAuth?: (prompt: { url: string }) => void | Promise<void>;
	onManualCallback?: (prompt: { signal: AbortSignal; redirectUri: string }) => Promise<string | null>;
}

function registration(value: unknown): Registration | null {
	if (
		!isRecord(value) ||
		value.type !== "chatgpt-oauth" ||
		value.provider !== "openai-codex" ||
		!nonempty(value.clientId) ||
		value.clientId === "dynamic_agent_client" ||
		value.clientId.length > 512 ||
		/\s/.test(value.clientId) ||
		!nonempty(value.issuer) ||
		(value.subject !== undefined && !nonempty(value.subject)) ||
		(value.idToken !== undefined && !nonempty(value.idToken)) ||
		(value.scopes !== undefined && (!Array.isArray(value.scopes) || !value.scopes.every(nonempty)))
	)
		return null;
	try {
		if (authEndpoints(value.issuer).issuer !== value.issuer) return null;
	} catch {
		return null;
	}
	return {
		type: "chatgpt-oauth",
		provider: "openai-codex",
		clientId: value.clientId,
		issuer: value.issuer,
		...(value.subject === undefined ? {} : { subject: value.subject as string }),
		...(value.idToken === undefined ? {} : { idToken: value.idToken as string }),
		...(value.scopes === undefined ? {} : { scopes: [...(value.scopes as string[])] }),
	};
}

function directCredential(value: unknown): CodexCredential | null {
	const saved = registration(value);
	if (
		!saved ||
		!isRecord(value) ||
		!nonempty(value.accessToken) ||
		!nonempty(value.refreshToken) ||
		!nonempty(saved.subject) ||
		!nonempty(saved.idToken) ||
		!saved.scopes?.includes(DIRECT_SCOPE) ||
		typeof value.expiresAt !== "number" ||
		!Number.isFinite(value.expiresAt) ||
		value.expiresAt <= 0 ||
		(value.earliestRefreshAt !== undefined &&
			(typeof value.earliestRefreshAt !== "number" ||
				!Number.isFinite(value.earliestRefreshAt) ||
				value.earliestRefreshAt < 0))
	)
		return null;
	return {
		...saved,
		accessToken: value.accessToken,
		refreshToken: value.refreshToken,
		expiresAt: value.expiresAt,
		subject: saved.subject,
		idToken: saved.idToken,
		scopes: saved.scopes,
		...(value.earliestRefreshAt === undefined
			? {}
			: { earliestRefreshAt: value.earliestRefreshAt as number }),
	};
}

/** Synchronous schema/eligibility snapshot, including refreshable expired credentials. No legacy shapes. */
export function loadCodexCredential(authPath?: string): CodexCredential | null {
	return directCredential(readAuthStore(authFilePath(authPath)).codex);
}

/** Non-secret identity, stable across rotation, invalidated by login/logout/disabled grants. */
export function getCodexRegistrationKey(authPath?: string): string | null {
	const store = readAuthStore(authFilePath(authPath));
	const saved = registration(store.codex);
	if (!saved) return null;
	return createHash("sha256")
		.update(
			JSON.stringify([
				store.hostId ?? null,
				saved.issuer,
				saved.clientId,
				saved.subject ?? null,
				store.codexRevision ?? null,
			]),
		)
		.digest("hex");
}

function snapshot(store: AuthStore): string {
	return JSON.stringify([store.codex ?? null, store.codexRevision ?? null, store.hostId ?? null]);
}

function requireSameIssuer(saved: Registration | null, endpoints: AuthEndpoints): void {
	if (saved && saved.issuer !== endpoints.issuer)
		throw new Error(
			"The saved ChatGPT registration belongs to a different issuer; no credentials were sent.",
		);
}

function usable(credential: CodexCredential): boolean {
	const now = Date.now();
	return (
		credential.expiresAt > now &&
		(credential.expiresAt - REFRESH_MARGIN_MS > now ||
			(credential.earliestRefreshAt !== undefined && credential.earliestRefreshAt > now))
	);
}

function grantedScopes(data: Record<string, unknown>): string[] {
	// An omitted scope is not evidence of permission to use direct inference.
	if (data.scope === undefined) return [];
	if (typeof data.scope !== "string") throw new Error("ChatGPT token response has invalid granted scopes.");
	return [...new Set(data.scope.trim().split(/\s+/).filter(Boolean))];
}

function tokenFields(
	data: Record<string, unknown>,
	scopes: string[],
	requestStartedAt: number,
): {
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
	scopes: string[];
	earliestRefreshAt?: number;
} {
	if (
		!nonempty(data.access_token) ||
		!nonempty(data.refresh_token) ||
		typeof data.expires_in !== "number" ||
		!Number.isFinite(data.expires_in) ||
		data.expires_in <= 0 ||
		!Number.isSafeInteger(Math.ceil(requestStartedAt + data.expires_in * 1000)) ||
		(data.token_type !== undefined &&
			(typeof data.token_type !== "string" || data.token_type.toLowerCase() !== "bearer")) ||
		(data.earliest_refresh_at !== undefined &&
			(typeof data.earliest_refresh_at !== "number" ||
				!Number.isFinite(data.earliest_refresh_at) ||
				data.earliest_refresh_at < 0 ||
				!Number.isSafeInteger(Math.ceil(data.earliest_refresh_at * 1000))))
	)
		throw new Error("ChatGPT token response is missing valid token, expiry or granted-scope fields.");
	return {
		accessToken: data.access_token,
		refreshToken: data.refresh_token,
		expiresAt: requestStartedAt + data.expires_in * 1000,
		scopes,
		// OAuth timestamps are epoch seconds; storage uses epoch milliseconds.
		...(data.earliest_refresh_at === undefined
			? {}
			: { earliestRefreshAt: (data.earliest_refresh_at as number) * 1000 }),
	};
}

function checkReturnedClient(data: Record<string, unknown>, clientId: string): void {
	if (data.client_id !== undefined && data.client_id !== clientId)
		throw new Error("ChatGPT returned a different client ID; the saved registration was not replaced.");
}

async function persistLogin(
	file: string,
	starting: string,
	next: Registration | CodexCredential,
	signal: AbortSignal,
): Promise<string> {
	return withAuthStoreLock(
		file,
		async (locked) => {
			if (snapshot(locked.store) !== starting)
				throw new Error(
					"ChatGPT credentials changed while login was pending. Run ink login again; the newer state was preserved.",
				);
			locked.store.codex = next;
			locked.store.codexRevision = randomUUID();
			await locked.write();
			return snapshot(locked.store);
		},
		{ signal },
	);
}

/** Browser authorization + loopback callback, S256 PKCE and fully verified OIDC identity. */
export async function loginCodex(options: CodexLoginOptions = {}): Promise<CodexCredential> {
	const endpoints = authEndpoints(options.authBaseUrl);
	const file = authFilePath(options.authPath);
	const timeout = new AbortController();
	const timer = setTimeout(() => timeout.abort(), LOGIN_TIMEOUT_MS);
	const signal = AbortSignal.any([timeout.signal, ...(options.signal ? [options.signal] : [])]);
	let callback: Awaited<ReturnType<typeof startCallbackListener>> | undefined;
	const manualAbort = new AbortController();
	try {
		const initial = await withAuthStoreLock(
			file,
			async (locked) => {
				const saved = registration(locked.store.codex);
				requireSameIssuer(saved, endpoints);
				if (locked.store.hostId === undefined) {
					locked.store.hostId = randomUUID();
					await locked.write();
				} else if (typeof locked.store.hostId !== "string" || !HOST_ID.test(locked.store.hostId)) {
					throw new Error("Authentication store contains an invalid host ID; login was not started.");
				}
				return { saved, hostId: locked.store.hostId, starting: snapshot(locked.store) };
			},
			{ signal },
		);
		const oidc = await discoverOidc(endpoints, signal);
		const verifier = randomBytes(32).toString("base64url");
		const state = randomBytes(32).toString("base64url");
		const nonce = randomBytes(32).toString("base64url");
		callback = await startCallbackListener(state, signal, options.callbackPort, initial.saved?.clientId);
		const url = new URL(endpoints.authorize);
		url.search = new URLSearchParams({
			client_id: initial.saved?.clientId ?? "dynamic_agent_client",
			...(initial.saved === null ? { agent_name_hint: "Ink" } : {}),
			ext_agent_host_id: `urn:uuid:${initial.hostId}`,
			response_type: "code",
			redirect_uri: callback.redirectUri,
			resource: CODEX_RESOURCE,
			scope: CODEX_SCOPES,
			state,
			nonce,
			code_challenge: createHash("sha256").update(verifier).digest("base64url"),
			code_challenge_method: "S256",
			prompt: "consent",
		}).toString();
		// Intentionally omit id_token_hint from UI-visible/browser URLs.
		// A browser callback must also win over a UI notification that has not returned.
		const notified = Promise.resolve().then(() => options.onAuth?.({ url: url.href }));
		const manualSignal = AbortSignal.any([signal, manualAbort.signal]);
		const redirectUri = callback.redirectUri;
		const getManualCallback = options.onManualCallback;
		const manual = notified.then(async () => {
			if (manualSignal.aborted || !getManualCallback) return new Promise<never>(() => {});
			const input = await getManualCallback({ signal: manualSignal, redirectUri });
			if (input === null) return new Promise<never>(() => {});
			return authorizationFromCallback(input, redirectUri, state, initial.saved?.clientId);
		});
		const result = await waitWithSignal(Promise.race([callback.result, manual]), signal);
		manualAbort.abort();
		await callback.close();
		callback = undefined;
		let expectedSnapshot = initial.starting;
		if (initial.saved === null) {
			// A state-validated issued client is registration identity, not an inference grant.
			// Save it before any exchange/key fetch so temporary failures cannot register again.
			expectedSnapshot = await persistLogin(
				file,
				expectedSnapshot,
				{
					type: "chatgpt-oauth",
					provider: "openai-codex",
					clientId: result.clientId,
					issuer: endpoints.issuer,
				},
				signal,
			);
		}
		const verification = await loadIdentityVerificationMaterial(endpoints, signal, oidc);
		let data: Record<string, unknown>;
		// Use the request start conservatively; slow delivery/verification must not extend token life.
		const requestedAt = Date.now();
		try {
			data = await tokenRequest(
				endpoints,
				new URLSearchParams({
					grant_type: "authorization_code",
					client_id: result.clientId,
					code: result.code,
					code_verifier: verifier,
					redirect_uri: redirectUri,
					resource: CODEX_RESOURCE,
				}),
				signal,
			);
		} catch (error) {
			if (isTerminalRefreshGrantError(error) && error.code === "invalid_grant" && initial.saved === null) {
				throw new Error(
					"ChatGPT issued a registration but the code exchange expired. Run ink login again to authorize the saved client; no new registration is needed.",
				);
			}
			throw error;
		}
		checkReturnedClient(data, result.clientId);
		if (!nonempty(data.id_token)) throw new Error("ChatGPT token response did not include an ID token.");
		const identity = await verifyIdentityLocally(data.id_token, result.clientId, verification, {
			nonce,
			subject: initial.saved?.subject,
		});
		const scopes = grantedScopes(data);
		const saved: Registration = {
			type: "chatgpt-oauth",
			provider: "openai-codex",
			clientId: result.clientId,
			...identity,
			idToken: data.id_token,
			scopes,
		};
		if (!scopes.includes(DIRECT_SCOPE)) {
			await persistLogin(file, expectedSnapshot, saved, signal);
			throw new Error(
				`ChatGPT grant did not include ${DIRECT_SCOPE}. Registration was saved without usable tokens. Run ink login to request consent again.`,
			);
		}
		let fields: ReturnType<typeof tokenFields>;
		try {
			fields = tokenFields(data, scopes, requestedAt);
			if (fields.expiresAt <= Date.now())
				throw new Error("ChatGPT access token expired during login. Run ink login again.");
		} catch (error) {
			// A verified first registration must not be dynamically registered again
			// merely because this response cannot provide usable inference tokens.
			if (initial.saved === null) await persistLogin(file, expectedSnapshot, saved, signal);
			throw error;
		}
		const credential: CodexCredential = {
			...saved,
			...fields,
			subject: identity.subject,
			idToken: data.id_token,
		};
		await persistLogin(file, expectedSnapshot, credential, signal);
		if (credential.expiresAt <= Date.now())
			throw new Error("ChatGPT access token expired during login. Run ink login again.");
		return credential;
	} catch (error) {
		if (options.signal?.aborted) throw cancellationError();
		if (timeout.signal.aborted)
			throw new Error("ChatGPT login timed out after 10 minutes. Run ink login again.");
		throw error;
	} finally {
		clearTimeout(timer);
		manualAbort.abort();
		await callback?.close();
	}
}

async function clearUnusable(locked: LockedAuthStore, saved: Registration): Promise<void> {
	locked.store.codex = saved;
	locked.store.codexRevision = randomUUID();
	await locked.write();
}

function isTerminalRefreshGrantError(error: unknown): error is OAuthRequestError {
	return (
		error instanceof OAuthRequestError &&
		isTerminalRefreshCode(error.code) &&
		!error.temporary &&
		error.status !== undefined &&
		error.status >= 400 &&
		error.status < 500
	);
}

async function refreshCredential(
	locked: LockedAuthStore,
	credential: CodexCredential,
	endpoints: AuthEndpoints,
): Promise<CodexCredential> {
	// Caller cancellation must not interrupt an in-progress refresh-token rotation.
	const timeout = new AbortController();
	const timer = setTimeout(() => timeout.abort(), 15_000);
	const signal = timeout.signal;
	try {
		// Fetch discovery/JWKS before consuming the rotating token. A temporary key
		// failure must leave an unused refresh token available for the next attempt.
		const verification = await loadIdentityVerificationMaterial(endpoints, signal);
		const requestedAt = Date.now();
		let data: Record<string, unknown>;
		try {
			data = await tokenRequest(
				endpoints,
				new URLSearchParams({
					grant_type: "refresh_token",
					client_id: credential.clientId,
					refresh_token: credential.refreshToken,
					resource: CODEX_RESOURCE,
				}),
				signal,
			);
		} catch (error) {
			// A 2xx response whose body cannot be read/parsed may already have
			// consumed the token. Do not retain it for a subsequent refresh attempt.
			if (
				error instanceof OAuthRequestError &&
				error.status !== undefined &&
				error.status >= 200 &&
				error.status < 300
			) {
				await clearUnusable(locked, registration(credential)!);
				throw new Error(
					"ChatGPT refresh returned an unreadable successful response. Registration was retained. Run ink login again.",
				);
			}
			// Only the refresh endpoint's nontemporary terminal grant response can
			// invalidate the stored grant. Discovery/JWKS errors never reach here.
			if (isTerminalRefreshGrantError(error)) {
				await clearUnusable(locked, registration(credential)!);
				throw new Error(
					"ChatGPT refresh grant expired or was revoked. Registration was retained. Run ink login again.",
				);
			}
			throw error;
		}
		let saved = registration(credential)!;
		let replacement: CodexCredential;
		try {
			checkReturnedClient(data, credential.clientId);
			const scopes = grantedScopes(data);
			let idToken = credential.idToken;
			if (data.id_token !== undefined) {
				if (!nonempty(data.id_token)) throw new Error("ChatGPT refresh returned an invalid ID token.");
				await verifyIdentityLocally(data.id_token, credential.clientId, verification, {
					subject: credential.subject,
				});
				idToken = data.id_token;
			}
			saved = { ...saved, idToken, scopes };
			if (!scopes.includes(DIRECT_SCOPE)) {
				throw new Error(
					`ChatGPT grant no longer includes ${DIRECT_SCOPE}. Run ink login to request consent again.`,
				);
			}
			const fields = tokenFields(data, scopes, requestedAt);
			replacement = { ...credential, ...fields, idToken };
			// Do not retain an old earliest-refresh restriction when the replacement omits it.
			if (fields.earliestRefreshAt === undefined) delete replacement.earliestRefreshAt;
		} catch (error) {
			// A successful token response consumed the old refresh token. If its
			// replacement cannot be verified (including an unknown kid), retain
			// registration only. Never fetch again or resend the consumed token.
			await clearUnusable(locked, saved);
			throw error;
		}
		locked.store.codex = replacement;
		await locked.write();
		if (replacement.expiresAt <= Date.now())
			throw new Error("ChatGPT returned an expired access token. Run ink login again.");
		return replacement;
	} finally {
		clearTimeout(timer);
	}
}

/** Re-read under the cross-process lock; one rotating refresh per stored generation. */
export async function getCodexAccessToken(options: CodexAuthOptions = {}): Promise<CodexCredential> {
	if (options.signal?.aborted) throw cancellationError();
	const endpoints = authEndpoints(options.authBaseUrl);
	const file = authFilePath(options.authPath);
	const stored = directCredential(readAuthStore(file).codex);
	if (!stored) throw new Error(LOGIN_REQUIRED);
	requireSameIssuer(stored, endpoints);
	if (usable(stored)) return stored;
	const work = withAuthStoreLock(
		file,
		async (locked) => {
			const current = directCredential(locked.store.codex);
			if (!current) throw new Error(LOGIN_REQUIRED);
			requireSameIssuer(current, endpoints);
			if (
				usable(current) ||
				(current.expiresAt > Date.now() && JSON.stringify(current) !== JSON.stringify(stored))
			)
				return current;
			if (current.earliestRefreshAt !== undefined && current.earliestRefreshAt > Date.now()) {
				throw new Error(
					"ChatGPT access token expired before refresh is permitted. Try again later or run ink login.",
				);
			}
			return refreshCredential(locked, current, endpoints);
		},
		{ signal: options.signal },
	);
	return waitWithSignal(work, options.signal);
}

async function revokeLatest(
	credential: CodexCredential,
	endpoints: AuthEndpoints,
	signal: AbortSignal,
): Promise<boolean> {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const oidc: OidcConfiguration = await discoverOidc(endpoints, signal);
			if (!oidc.revocationEndpoint) return false;
			await oauthRequest(
				oidc.revocationEndpoint,
				{
					method: "POST",
					headers: { "content-type": "application/x-www-form-urlencoded" },
					body: new URLSearchParams({
						token: credential.refreshToken,
						token_type_hint: "refresh_token",
						client_id: credential.clientId,
					}),
				},
				signal,
				true,
			);
			return true;
		} catch (error) {
			if (signal.aborted || !(error instanceof OAuthRequestError) || !error.temporary || attempt !== 0)
				return false;
			await delayWithSignal(100, signal).catch(() => {});
		}
	}
	return false;
}

/** Serialized with refresh and API-key writers, including remote revocation of the latest token. */
export async function logoutCodex(
	authPath?: string,
	options: Omit<CodexAuthOptions, "authPath"> = {},
): Promise<{ remoteRevoked: boolean }> {
	// Deliberately do not cancel lock acquisition/local clearing when logout is cancelled.
	return withAuthStoreLock(authFilePath(authPath), async (locked) => {
		const saved = registration(locked.store.codex);
		const current = directCredential(locked.store.codex);
		let remoteRevoked = false;
		try {
			if (current && !options.signal?.aborted) {
				const endpoints = authEndpoints(options.authBaseUrl);
				if (current.issuer !== endpoints.issuer) throw new Error("Unmatched revocation issuer");
				const timeout = new AbortController();
				const timer = setTimeout(() => timeout.abort(), 15_000);
				try {
					remoteRevoked = await revokeLatest(
						current,
						endpoints,
						AbortSignal.any([timeout.signal, ...(options.signal ? [options.signal] : [])]),
					);
				} finally {
					clearTimeout(timer);
				}
			}
		} catch {
			// A destination/configuration/network failure cannot prevent local logout.
			remoteRevoked = false;
		} finally {
			// Even logout during a first, still-pending login must invalidate its snapshot.
			// Preserve registration identity, never access, refresh or ID tokens on logout.
			if (saved) {
				delete saved.idToken;
				locked.store.codex = saved;
			} else delete locked.store.codex;
			locked.store.codexRevision = randomUUID();
			await locked.write();
		}
		return { remoteRevoked };
	});
}
