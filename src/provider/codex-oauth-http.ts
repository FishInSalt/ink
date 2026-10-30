import { createLocalJWKSet, type JSONWebKeySet, jwtVerify } from "jose";

const DEFAULT_AUTH_BASE_URL = "https://auth.openai.com";
export const CODEX_RESOURCE = "https://api.openai.com/v1";
export const DIRECT_SCOPE = "chatgpt.tokens.use.direct";
export const CODEX_SCOPES = `openid profile email offline_access resource.invoke ${DIRECT_SCOPE}`;
const OAUTH_FETCH_TIMEOUT_MS = 15_000;
const BODY_LIMIT = 256 * 1024;

export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function nonempty(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

export interface AuthEndpoints {
	issuer: string;
	authorize: string;
	token: string;
	discovery: string;
}

/** Only explicit API injection permits loopback HTTP. No environment override is read. */
export function authEndpoints(authBaseUrl?: string): AuthEndpoints {
	let url: URL;
	try {
		url = new URL(authBaseUrl ?? DEFAULT_AUTH_BASE_URL);
	} catch {
		throw new Error("Invalid ChatGPT authentication endpoint.");
	}
	const raw = authBaseUrl ?? DEFAULT_AUTH_BASE_URL;
	const loopback = authBaseUrl !== undefined && url.protocol === "http:" && url.hostname === "127.0.0.1";
	if (
		(url.protocol !== "https:" && !loopback) ||
		url.username ||
		url.password ||
		url.hash ||
		url.search ||
		raw.trim() !== raw ||
		/\/\/[^/?#]*@/.test(raw) ||
		raw.includes("#") ||
		raw.includes("?") ||
		url.pathname !== "/"
	) {
		throw new Error(
			"ChatGPT authentication requires an HTTPS origin without credentials, query or fragment.",
		);
	}
	const issuer = url.origin;
	return {
		issuer,
		authorize: `${issuer}/api/accounts/authorize`,
		token: `${issuer}/api/accounts/oauth/token`,
		discovery: `${issuer}/.well-known/openid-configuration`,
	};
}

// Exact SIWC refresh-grant failures only. Never infer terminal status from text,
// prefixes or an arbitrary server code; callers must also check operation and HTTP status.
const TERMINAL_REFRESH_CODES = [
	"invalid_grant",
	"invalid_refresh_token",
	"token_expired",
	"refresh_token_expired",
	"refresh_token_invalidated",
	"refresh_token_reused",
] as const;
type TerminalRefreshCode = (typeof TERMINAL_REFRESH_CODES)[number];

export function isTerminalRefreshCode(code: unknown): code is TerminalRefreshCode {
	return typeof code === "string" && (TERMINAL_REFRESH_CODES as readonly string[]).includes(code);
}

export class OAuthRequestError extends Error {
	constructor(
		public readonly code: TerminalRefreshCode | "invalid_client" | "other",
		public readonly temporary: boolean,
		public readonly status?: number,
	) {
		super(
			code === "invalid_client"
				? "ChatGPT client configuration was rejected (invalid_client); the saved credentials were not erased."
				: code === "invalid_grant"
					? "ChatGPT authorization is no longer valid (invalid_grant). Run ink login again."
					: `ChatGPT authentication request failed${status === undefined ? "" : ` (HTTP ${status})`}.`,
		);
	}
}

/** Bounded fetch AND body read; no redirects, response bodies, tokens or URLs in errors. */
export async function oauthRequest(
	url: string,
	init: RequestInit = {},
	signal?: AbortSignal,
	ignoreSuccessBody = false,
): Promise<Record<string, unknown>> {
	const timeout = new AbortController();
	const timer = setTimeout(() => timeout.abort(), OAUTH_FETCH_TIMEOUT_MS);
	const combined = AbortSignal.any([timeout.signal, ...(signal ? [signal] : [])]);
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let status: number | undefined;
	try {
		const response = await fetch(url, { ...init, redirect: "error", signal: combined });
		status = response.status;
		if (response.redirected || (response.status >= 300 && response.status < 400)) {
			await response.body?.cancel().catch(() => {});
			throw new OAuthRequestError("other", false, response.status);
		}
		reader = response.body?.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		if (reader) {
			while (true) {
				const part = await reader.read();
				if (part.done) break;
				size += part.value.byteLength;
				if (size > BODY_LIMIT) throw new OAuthRequestError("other", false, response.status);
				chunks.push(part.value);
			}
		}
		// RFC 7009 revocation only confirms HTTP success; its body need not be JSON.
		if (ignoreSuccessBody && response.ok) return {};
		const text = Buffer.concat(chunks).toString("utf8");
		let data: unknown;
		try {
			data = JSON.parse(text);
		} catch {
			if (!response.ok)
				throw new OAuthRequestError(
					"other",
					response.status >= 500 || [408, 429].includes(response.status),
					response.status,
				);
			throw new OAuthRequestError("other", false, response.status);
		}
		if (!response.ok) {
			const code = isRecord(data) ? data.error : undefined;
			throw new OAuthRequestError(
				isTerminalRefreshCode(code) || code === "invalid_client" ? code : "other",
				response.status >= 500 || [408, 429].includes(response.status),
				response.status,
			);
		}
		if (!isRecord(data)) throw new OAuthRequestError("other", false, response.status);
		return data;
	} catch (error) {
		if (error instanceof OAuthRequestError) throw error;
		throw new OAuthRequestError("other", true, status);
	} finally {
		clearTimeout(timer);
		await reader?.cancel().catch(() => {});
		reader?.releaseLock();
	}
}

export function tokenRequest(
	endpoints: AuthEndpoints,
	body: URLSearchParams,
	signal: AbortSignal,
): Promise<Record<string, unknown>> {
	return oauthRequest(
		endpoints.token,
		{
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
			body,
		},
		signal,
	);
}

export interface OidcConfiguration {
	jwksUri: string;
	revocationEndpoint?: string;
}

function sameOriginEndpoint(value: unknown, endpoints: AuthEndpoints): string {
	if (!nonempty(value)) throw new Error("ChatGPT OIDC configuration has an invalid endpoint.");
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("ChatGPT OIDC configuration has an invalid endpoint.");
	}
	if (
		url.origin !== endpoints.issuer ||
		url.username ||
		url.password ||
		url.hash ||
		value.includes("#") ||
		/\/\/[^/?#]*@/.test(value)
	) {
		throw new Error("ChatGPT OIDC configuration contains an untrusted endpoint.");
	}
	return url.href;
}

export async function discoverOidc(
	endpoints: AuthEndpoints,
	signal: AbortSignal,
): Promise<OidcConfiguration> {
	const data = await oauthRequest(endpoints.discovery, { headers: { accept: "application/json" } }, signal);
	if (
		data.issuer !== endpoints.issuer ||
		(data.authorization_endpoint !== undefined && data.authorization_endpoint !== endpoints.authorize) ||
		(data.token_endpoint !== undefined && data.token_endpoint !== endpoints.token)
	) {
		throw new Error("ChatGPT OIDC issuer or pinned endpoints did not match.");
	}
	return {
		jwksUri: sameOriginEndpoint(data.jwks_uri, endpoints),
		revocationEndpoint:
			data.revocation_endpoint === undefined
				? undefined
				: sameOriginEndpoint(data.revocation_endpoint, endpoints),
	};
}

export interface IdentityVerificationMaterial {
	issuer: string;
	keys: ReturnType<typeof createLocalJWKSet>;
}

/** Fetch trusted verification material before any operation that can rotate a refresh token. */
export async function loadIdentityVerificationMaterial(
	endpoints: AuthEndpoints,
	signal: AbortSignal,
	oidc?: OidcConfiguration,
): Promise<IdentityVerificationMaterial> {
	const configuration = oidc ?? (await discoverOidc(endpoints, signal));
	const jwks = await oauthRequest(configuration.jwksUri, { headers: { accept: "application/json" } }, signal);
	try {
		if (!Array.isArray(jwks.keys) || jwks.keys.length === 0 || jwks.keys.length > 32)
			throw new Error("Invalid JWKS");
		return { issuer: endpoints.issuer, keys: createLocalJWKSet(jwks as unknown as JSONWebKeySet) };
	} catch {
		throw new Error("ChatGPT OIDC verification keys are invalid.");
	}
}

/** Local JOSE verification only: an unknown kid must not initiate a post-rotation fetch. */
export async function verifyIdentityLocally(
	idToken: string,
	clientId: string,
	material: IdentityVerificationMaterial,
	options: { nonce?: string; subject?: string } = {},
): Promise<{ issuer: string; subject: string }> {
	try {
		const { payload } = await jwtVerify(idToken, material.keys, {
			issuer: material.issuer,
			audience: clientId,
			algorithms: ["RS256", "ES256", "PS256"],
			requiredClaims: ["iss", "sub", "aud", "exp", "iat", ...(options.nonce ? ["nonce"] : [])],
		});
		if (
			!nonempty(payload.sub) ||
			typeof payload.iat !== "number" ||
			!Number.isFinite(payload.iat) ||
			payload.iat > Date.now() / 1000 + 60 ||
			(options.nonce !== undefined && payload.nonce !== options.nonce) ||
			(options.subject !== undefined && payload.sub !== options.subject) ||
			(payload.azp !== undefined && payload.azp !== clientId) ||
			(Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId)
		)
			throw new Error("Identity mismatch");
		return { issuer: material.issuer, subject: payload.sub };
	} catch {
		throw new Error(
			"ChatGPT ID token verification failed (signature, issuer, audience, expiry, nonce or saved account). The saved registration cannot be used for a different account.",
		);
	}
}
