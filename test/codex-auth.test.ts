import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as authStorage from "../src/provider/auth-storage.js";
import { loadApiKey, saveApiKey } from "../src/provider/auth-store.js";
import {
	type CodexLoginOptions,
	getCodexAccessToken,
	getCodexRegistrationKey,
	loadCodexCredential,
	loginCodex,
	logoutCodex,
} from "../src/provider/codex-auth.js";
import { authEndpoints, CODEX_SCOPES, DIRECT_SCOPE } from "../src/provider/codex-oauth-http.js";
import { authChild } from "./helpers/auth-process.js";
import { deferred, FakeCodexOidc } from "./helpers/codex-auth-fake.js";
import { mkTempDir } from "./helpers/mktemp.js";

let fake: FakeCodexOidc;
let file: string;
beforeEach(async () => {
	file = path.join(mkTempDir("ink-auth-"), "auth.json");
	vi.stubEnv("INK_AUTH_PATH", file);
	fake = new FakeCodexOidc();
	await fake.start();
});
afterEach(async () => {
	await fake.close();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

async function login(changes: Partial<CodexLoginOptions> = {}) {
	let callback = "";
	return loginCodex({
		authPath: file,
		authBaseUrl: fake.baseUrl,
		callbackPort: 0,
		onAuth: ({ url }) => {
			callback = fake.callback(url);
		},
		onManualCallback: async () => callback,
		...changes,
	});
}
function rawStore(): Record<string, any> {
	return JSON.parse(readFileSync(file, "utf8"));
}
function editStored(changes: Record<string, unknown>): void {
	const store = rawStore();
	store.codex = { ...store.codex, ...changes };
	writeFileSync(file, JSON.stringify(store));
}
const options = () => ({ authPath: file, authBaseUrl: fake.baseUrl });
const terminalRefreshCodes = [
	"invalid_grant",
	"invalid_refresh_token",
	"token_expired",
	"refresh_token_expired",
	"refresh_token_invalidated",
	"refresh_token_reused",
] as const;

describe("ChatGPT authorization code + verified OIDC", () => {
	it("registers with stable random host, S256 PKCE, full scopes/resource, validates identity and stores 0600", async () => {
		await saveApiKey("openai", "unrelated-local-key");
		const credential = await login();
		const authorize = fake.lastAuthorize!;
		expect(authorize.pathname).toBe("/api/accounts/authorize");
		expect(authorize.searchParams.get("client_id")).toBe("dynamic_agent_client");
		expect(authorize.searchParams.get("agent_name_hint")).toBe("Ink");
		expect(authorize.searchParams.get("ext_agent_host_id")).toMatch(/^urn:uuid:[a-f0-9-]{36}$/);
		expect(authorize.searchParams.get("scope")).toBe(CODEX_SCOPES);
		expect(authorize.searchParams.get("resource")).toBe("https://api.openai.com/v1");
		expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
		expect(authorize.searchParams.get("state")!.length).toBeGreaterThanOrEqual(32);
		expect(authorize.searchParams.get("nonce")!.length).toBeGreaterThanOrEqual(32);
		const exchange = fake.exchanges[0]!;
		expect(exchange.get("client_id")).toBe(fake.clientId);
		expect(exchange.get("redirect_uri")).toBe(authorize.searchParams.get("redirect_uri"));
		expect(exchange.get("resource")).toBe("https://api.openai.com/v1");
		expect(createHash("sha256").update(exchange.get("code_verifier")!).digest("base64url")).toBe(
			authorize.searchParams.get("code_challenge"),
		);
		expect(credential).toMatchObject({
			type: "chatgpt-oauth",
			provider: "openai-codex",
			clientId: fake.clientId,
			issuer: fake.baseUrl,
			subject: fake.subject,
		});
		expect(loadCodexCredential(file)).toEqual(credential);
		expect(loadApiKey("openai")).toBe("unrelated-local-key");
		expect(statSync(file).mode & 0o777).toBe(0o600);
	});

	it("reauthorizes the issued registration, changes login generation but not host, and never exposes an ID-token hint", async () => {
		await login();
		const key = getCodexRegistrationKey(file);
		const host = rawStore().hostId;
		await login();
		expect(fake.lastAuthorize!.searchParams.get("client_id")).toBe(fake.clientId);
		expect(fake.lastAuthorize!.searchParams.get("prompt")).toBe("consent");
		expect(fake.lastAuthorize!.searchParams.has("id_token_hint")).toBe(false);
		expect(fake.lastAuthorize!.searchParams.has("agent_name_hint")).toBe(false);
		expect(rawStore().hostId).toBe(host);
		expect(getCodexRegistrationKey(file)).not.toBe(key);
		expect(getCodexRegistrationKey(file)).not.toContain("access-");
	});

	it.each(["signature", "issuer", "audience", "expired", "nonce", "subject-missing", "azp"])(
		"rejects a token with wrong %s without replacing credentials",
		async (kind) => {
			await login();
			const before = readFileSync(file, "utf8");
			fake.onToken = async () => {
				const claims =
					kind === "issuer"
						? { iss: "https://foreign.invalid" }
						: kind === "audience"
							? { aud: "another-client" }
							: kind === "expired"
								? { exp: 1 }
								: kind === "nonce"
									? { nonce: "wrong" }
									: kind === "subject-missing"
										? { sub: "" }
										: kind === "azp"
											? { azp: "another-client" }
											: {};
				return { body: await fake.tokens({ id_token: await fake.idToken(claims, kind === "signature") }) };
			};
			await expect(login()).rejects.toThrow(/verification failed/);
			expect(readFileSync(file, "utf8")).toBe(before);
		},
	);

	it("rejects account changes even when the replacement ID token is correctly signed", async () => {
		await login();
		const before = readFileSync(file, "utf8");
		fake.subject = "different-local-user";
		await expect(login()).rejects.toThrow(/different account/);
		expect(readFileSync(file, "utf8")).toBe(before);
	});

	it("rejects a returned issued client mismatch before exchanging a code", async () => {
		await login();
		fake.clientId = "different-issued-client";
		await expect(login()).rejects.toThrow(/different client ID/);
		expect(fake.exchangeCount).toBe(1);
	});

	it("retains only verified registration on a disabled grant and requests consent with that client next time", async () => {
		fake.onToken = async () => ({
			body: await fake.tokens({ scope: "openid profile email offline_access resource.invoke" }),
		});
		await expect(login()).rejects.toThrow(/Registration was saved without usable tokens/);
		expect(loadCodexCredential(file)).toBeNull();
		expect(rawStore().codex).toMatchObject({
			clientId: fake.clientId,
			subject: fake.subject,
			issuer: fake.baseUrl,
		});
		expect(rawStore().codex.accessToken).toBeUndefined();
		expect(rawStore().codex.refreshToken).toBeUndefined();
		fake.onToken = undefined;
		await login();
		expect(fake.lastAuthorize!.searchParams.get("client_id")).toBe(fake.clientId);
		expect(fake.lastAuthorize!.searchParams.get("prompt")).toBe("consent");
	});

	it("retains verified registration even when a disabled grant omits usable token fields", async () => {
		fake.onToken = async () => ({ body: { id_token: await fake.idToken(), scope: "openid profile" } });
		await expect(login()).rejects.toThrow(/Registration was saved without usable tokens/);
		expect(rawStore().codex.subject).toBe(fake.subject);
		expect(loadCodexCredential(file)).toBeNull();
	});

	it("retains a verified first registration if token fields are unusable", async () => {
		fake.onToken = async () => ({ body: await fake.tokens({ refresh_token: undefined }) });
		await expect(login()).rejects.toThrow(/missing valid token/);
		expect(rawStore().codex.clientId).toBe(fake.clientId);
		expect(rawStore().codex.subject).toBe(fake.subject);
		expect(loadCodexCredential(file)).toBeNull();
	});

	it("rejects a token-response client mismatch without replacing the saved credential", async () => {
		await login();
		const before = readFileSync(file, "utf8");
		fake.onToken = async () => ({ body: await fake.tokens({ client_id: "other-client" }) });
		await expect(login()).rejects.toThrow(/different client ID/);
		expect(readFileSync(file, "utf8")).toBe(before);
	});

	it("retains an issued first-registration client after invalid_grant, without looping dynamic registration", async () => {
		fake.onToken = () => ({
			status: 400,
			body: { error: "invalid_grant", error_description: "secret-code-do-not-log" },
		});
		await expect(login()).rejects.toThrow(/authorize the saved client/);
		expect(rawStore().codex.clientId).toBe(fake.clientId);
		expect(loadCodexCredential(file)).toBeNull();
		expect(fake.exchangeCount).toBe(1);
		fake.onToken = undefined;
		await login();
		expect(fake.lastAuthorize!.searchParams.get("client_id")).toBe(fake.clientId);
	});

	it.each(["exchange", "jwks"])(
		"saves the first issued client before temporary %s failure and reuses it on retry",
		async (failure) => {
			await saveApiKey("zai", "unrelated-key");
			if (failure === "exchange") {
				fake.onToken = () => {
					expect(rawStore().codex).toEqual({
						type: "chatgpt-oauth",
						provider: "openai-codex",
						clientId: fake.clientId,
						issuer: fake.baseUrl,
					});
					return { status: 503, body: { error: "temporarily_unavailable" } };
				};
			} else {
				fake.onJwks = () => {
					expect(rawStore().codex.clientId).toBe(fake.clientId);
					expect(rawStore().codex).not.toHaveProperty("accessToken");
					return { status: 503, body: {} };
				};
			}
			await expect(login()).rejects.toThrow(/authentication request failed/);
			expect(loadCodexCredential(file)).toBeNull();
			expect(rawStore().codex.clientId).toBe(fake.clientId);
			expect(loadApiKey("zai")).toBe("unrelated-key");
			const host = rawStore().hostId;
			fake.onToken = undefined;
			fake.onJwks = undefined;
			await login();
			expect(fake.lastAuthorize!.searchParams.get("client_id")).toBe(fake.clientId);
			expect(rawStore().hostId).toBe(host);
		},
	);

	it("logout after first-client persistence still prevents the in-flight login from restoring tokens", async () => {
		const exchanging = deferred();
		const resume = deferred();
		fake.onToken = async () => {
			expect(rawStore().codex.clientId).toBe(fake.clientId);
			exchanging.resolve();
			await resume.promise;
			return { body: await fake.tokens() };
		};
		const attempt = login();
		const assertion = expect(attempt).rejects.toThrow(/changed while login was pending/);
		await exchanging.promise;
		await logoutCodex(file, { authBaseUrl: fake.baseUrl });
		const afterLogout = readFileSync(file, "utf8");
		resume.resolve();
		await assertion;
		expect(readFileSync(file, "utf8")).toBe(afterLogout);
		expect(rawStore().codex.clientId).toBe(fake.clientId);
		expect(loadCodexCredential(file)).toBeNull();
	});

	it("merges API-key writes while browser interaction is pending without holding the auth lock", async () => {
		let callback = "";
		await login({
			onAuth: async ({ url }) => {
				callback = fake.callback(url);
				await saveApiKey("zai", "while-browser-waiting");
			},
			onManualCallback: async () => callback,
		});
		expect(loadApiKey("zai")).toBe("while-browser-waiting");
		expect(loadCodexCredential(file)).not.toBeNull();
	});

	it("does not overwrite a newer login/logout state while browser interaction is pending", async () => {
		await login();
		const shown = deferred();
		const resume = deferred();
		let callback = "";
		const attempt = login({
			onAuth: ({ url }) => {
				callback = fake.callback(url);
				shown.resolve();
			},
			onManualCallback: async () => {
				await resume.promise;
				return callback;
			},
		});
		await shown.promise;
		await logoutCodex(file, { authBaseUrl: fake.baseUrl });
		const newer = readFileSync(file, "utf8");
		resume.resolve();
		await expect(attempt).rejects.toThrow(/changed while login was pending/);
		expect(readFileSync(file, "utf8")).toBe(newer);
	});
	it("logout invalidates a pending first login even before any registration was saved", async () => {
		const ready = deferred();
		const resume = deferred();
		let callback = "";
		const attempt = login({
			onAuth: ({ url }) => {
				callback = fake.callback(url);
				ready.resolve();
			},
			onManualCallback: async () => {
				await resume.promise;
				return callback;
			},
		});
		await ready.promise;
		await logoutCodex(file, { authBaseUrl: fake.baseUrl });
		resume.resolve();
		await expect(attempt).rejects.toThrow(/changed while login was pending/);
		expect(loadCodexCredential(file)).toBeNull();
		expect(rawStore().codex).toBeUndefined();
	});
});

describe("callback lifecycle and cancellation", () => {
	describe.each(["manual", "HTTP"] as const)("%s callback client identity", (transport) => {
		it("accepts a returning callback without client_id and exchanges using the saved issued ID", async () => {
			await login();
			let callback = "";
			const credential = await login({
				onAuth: async ({ url }) => {
					const value = new URL(fake.callback(url));
					value.searchParams.delete("client_id");
					callback = value.href;
					if (transport === "HTTP") expect((await fetch(callback)).status).toBe(200);
				},
				onManualCallback: transport === "manual" ? async () => callback : undefined,
			});
			expect(credential.clientId).toBe(fake.clientId);
			expect(fake.exchanges.at(-1)!.get("client_id")).toBe(fake.clientId);
			expect(fake.lastAuthorize!.searchParams.has("agent_name_hint")).toBe(false);
		});

		it.each(["missing", "empty", "duplicate"])(
			"rejects a first-registration callback with %s client_id",
			async (kind) => {
				let callback = "";
				await expect(
					login({
						onAuth: async ({ url }) => {
							const value = new URL(fake.callback(url));
							if (kind === "missing") value.searchParams.delete("client_id");
							if (kind === "empty") value.searchParams.set("client_id", "");
							if (kind === "duplicate") value.searchParams.append("client_id", fake.clientId);
							callback = value.href;
							if (transport === "HTTP") await fetch(callback);
						},
						onManualCallback: transport === "manual" ? async () => callback : undefined,
					}),
				).rejects.toThrow(/valid issued client ID|duplicate parameters/);
				expect(fake.exchangeCount).toBe(0);
				expect(rawStore().codex).toBeUndefined();
			},
		);

		it.each(["empty", "duplicate", "different"])(
			"rejects a returning callback with %s client_id without replacing credentials",
			async (kind) => {
				await login();
				const before = readFileSync(file, "utf8");
				let callback = "";
				await expect(
					login({
						onAuth: async ({ url }) => {
							const value = new URL(fake.callback(url));
							if (kind === "empty") value.searchParams.set("client_id", "");
							if (kind === "duplicate") value.searchParams.append("client_id", fake.clientId);
							if (kind === "different") value.searchParams.set("client_id", "different-issued-client");
							callback = value.href;
							if (transport === "HTTP") await fetch(callback);
						},
						onManualCallback: transport === "manual" ? async () => callback : undefined,
					}),
				).rejects.toThrow(
					kind === "different" ? /different client ID/ : /valid issued client ID|duplicate parameters/,
				);
				expect(fake.exchangeCount).toBe(1);
				expect(readFileSync(file, "utf8")).toBe(before);
			},
		);
	});

	it("ignores foreign-state success and error HTTP callbacks, then accepts the right callback and aborts manual input", async () => {
		let manualSignal: AbortSignal | undefined;
		let callback = "";
		await login({
			onAuth: async ({ url }) => {
				callback = fake.callback(url);
				const wrong = new URL(callback);
				wrong.searchParams.set("state", "foreign");
				expect((await fetch(wrong)).status).toBe(400);
				wrong.searchParams.set("error", "access_denied");
				expect((await fetch(wrong)).status).toBe(400);
			},
			onManualCallback: async ({ signal }) => {
				manualSignal = signal;
				expect((await fetch(callback)).status).toBe(200);
				return null;
			},
		});
		expect(manualSignal?.aborted).toBe(true);
	});

	it("accepts browser callbacks even if the auth-notification callback has not returned", async () => {
		const never = deferred();
		await login({
			onAuth: async ({ url }) => {
				await fetch(fake.callback(url));
				await never.promise;
			},
			onManualCallback: undefined,
		});
		expect(loadCodexCredential(file)).not.toBeNull();
	});

	it.each([
		"duplicate-state",
		"duplicate-code",
		"foreign-origin",
		"foreign-path",
		"wrong-state",
		"missing-client",
		"error",
	])("rejects invalid manual callbacks: %s, without reflecting codes", async (kind) => {
		let callback = "";
		const attempt = login({
			onAuth: ({ url }) => {
				const value = new URL(fake.callback(url));
				if (kind === "duplicate-state") value.searchParams.append("state", value.searchParams.get("state")!);
				if (kind === "duplicate-code") value.searchParams.append("code", "other-secret");
				if (kind === "foreign-origin") value.hostname = "localhost";
				if (kind === "foreign-path") value.pathname = "/wrong";
				if (kind === "wrong-state") value.searchParams.set("state", "other");
				if (kind === "missing-client") value.searchParams.delete("client_id");
				if (kind === "error") value.searchParams.set("error", "secret-error-do-not-log");
				callback = value.href;
			},
			onManualCallback: async () => callback,
		});
		const error = await attempt.catch((reason: unknown) => reason);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).not.toMatch(
			/local-code-do-not-log|secret-error-do-not-log|other-secret/,
		);
		expect(fake.exchangeCount).toBe(0);
	});

	it("falls back to an ephemeral loopback port and exchanges the exact selected URI", async () => {
		const occupied = createServer();
		await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
		const address = occupied.address();
		if (!address || typeof address === "string") throw new Error("Missing address");
		try {
			await login({ callbackPort: address.port });
			expect(new URL(fake.exchanges[0]!.get("redirect_uri")!).port).not.toBe(String(address.port));
		} finally {
			await new Promise<void>((resolve) => occupied.close(() => resolve()));
		}
	});

	it.each([false, true])(
		"cancels the final login write before rename (reauthorization: %s)",
		async (reauthorize) => {
			await saveApiKey("openai", "unrelated-key");
			if (reauthorize) await login();
			const previousCredential = loadCodexCredential(file);
			const controller = new AbortController();
			const withRealLock = authStorage.withAuthStoreLock;
			let beforeCommit: string | undefined;
			const spy = vi.spyOn(authStorage, "withAuthStoreLock").mockImplementation((authPath, work, options) =>
				withRealLock(
					authPath,
					(locked) =>
						work({
							store: locked.store,
							write(writeOptions) {
								const next = locked.store.codex as { accessToken?: string } | undefined;
								if (next?.accessToken && !controller.signal.aborted) {
									beforeCommit = readFileSync(file, "utf8");
									const writing = locked.write(writeOptions);
									// The real write is awaiting temp-file creation, before rename.
									controller.abort();
									return writing;
								}
								return locked.write(writeOptions);
							},
						}),
					options,
				),
			);
			await expect(login({ signal: controller.signal })).rejects.toThrow(/cancelled/);
			expect(beforeCommit).toBeTypeOf("string");
			expect(readFileSync(file, "utf8")).toBe(beforeCommit);
			expect(loadCodexCredential(file)).toEqual(previousCredential);
			expect(loadApiKey("openai")).toBe("unrelated-key");
			expect(readdirSync(path.dirname(file))).toEqual(["auth.json"]);
			spy.mockRestore();
			await saveApiKey("anthropic", "later-key");
			expect(loadApiKey("anthropic")).toBe("later-key");
			expect(loadApiKey("openai")).toBe("unrelated-key");
			expect(readdirSync(path.dirname(file))).toEqual(["auth.json"]);
		},
	);

	it("enforces the ten-minute overall login timeout and cancels manual interaction", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const ready = deferred();
		let manualSignal: AbortSignal | undefined;
		try {
			const attempt = login({
				onManualCallback: async ({ signal }) => {
					manualSignal = signal;
					ready.resolve();
					return new Promise(() => {});
				},
			});
			const assertion = expect(attempt).rejects.toThrow(/timed out after 10 minutes/);
			await ready.promise;
			await vi.advanceTimersByTimeAsync(10 * 60_000);
			await assertion;
			expect(manualSignal?.aborted).toBe(true);
			expect(loadCodexCredential(file)).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("cancellation closes the listener and spare socket and cancels scoped manual interaction", async () => {
		const controller = new AbortController();
		const ready = deferred();
		let redirect = "";
		let manualSignal: AbortSignal | undefined;
		const attempt = login({
			signal: controller.signal,
			onAuth: ({ url }) => {
				fake.callback(url);
			},
			onManualCallback: async ({ signal, redirectUri }) => {
				redirect = redirectUri;
				manualSignal = signal;
				ready.resolve();
				return new Promise(() => {});
			},
		});
		await ready.promise;
		const target = new URL(redirect);
		const socket = connect(Number(target.port), "127.0.0.1");
		await new Promise<void>((resolve, reject) => {
			socket.once("connect", resolve);
			socket.once("error", reject);
		});
		const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
		controller.abort();
		await expect(attempt).rejects.toThrow(/cancelled/);
		await closed;
		expect(manualSignal?.aborted).toBe(true);
		await expect(fetch(redirect)).rejects.toThrow();
		expect(loadCodexCredential(file)).toBeNull();
	});
});

describe("refresh rotation and serialized logout", () => {
	it("returns a valid stored token without contacting OAuth", async () => {
		const credential = await login();
		expect(await getCodexAccessToken(options())).toEqual(credential);
		expect(fake.refreshCount).toBe(0);
	});

	it("refreshes once for simultaneous callers, uses issued client/resource and preserves cache identity/API keys", async () => {
		await login();
		await saveApiKey("zai", "unrelated-key");
		const key = getCodexRegistrationKey(file);
		editStored({ expiresAt: Date.now() - 1 });
		const [a, b] = await Promise.all([getCodexAccessToken(options()), getCodexAccessToken(options())]);
		expect(a).toEqual(b);
		expect(fake.refreshCount).toBe(1);
		expect(fake.refreshes[0]!.get("client_id")).toBe(fake.clientId);
		expect(fake.refreshes[0]!.get("resource")).toBe("https://api.openai.com/v1");
		expect(fake.refreshes[0]!.get("scope")).toBeNull();
		expect(getCodexRegistrationKey(file)).toBe(key);
		expect(loadApiKey("zai")).toBe("unrelated-key");
	});

	it("does not refresh or mix credentials between separate auth stores", async () => {
		await login();
		const otherFile = path.join(path.dirname(file), "other-auth.json");
		const other = rawStore();
		other.codex.subject = "separate-user";
		other.codex.accessToken = "separate-access";
		other.codex.refreshToken = "separate-refresh";
		writeFileSync(otherFile, JSON.stringify(other));
		editStored({ expiresAt: Date.now() - 1 });
		const [rotated, separate] = await Promise.all([
			getCodexAccessToken(options()),
			getCodexAccessToken({ authPath: otherFile, authBaseUrl: fake.baseUrl }),
		]);
		expect(rotated.accessToken).toBe("access-1-1");
		expect(separate.accessToken).toBe("separate-access");
		expect(separate.subject).toBe("separate-user");
		expect(fake.refreshCount).toBe(1);
	});

	it("loads OIDC/JWKS before rotation and persists replacements even if JWKS becomes unavailable immediately afterward", async () => {
		await login();
		editStored({ expiresAt: Date.now() - 1 });
		const oldToken = loadCodexCredential(file)!.refreshToken;
		const key = getCodexRegistrationKey(file);
		fake.requests = [];
		fake.onToken = async () => {
			fake.onJwks = () => ({ status: 503, body: {} });
			return { body: await fake.tokens() };
		};
		const refreshed = await getCodexAccessToken(options());
		expect(fake.requests).toEqual([
			"/.well-known/openid-configuration",
			"/jwks",
			"/api/accounts/oauth/token",
		]);
		expect(fake.consumedRefreshTokens.has(oldToken)).toBe(true);
		expect(refreshed.refreshToken).toBe(fake.activeRefreshToken);
		expect(loadCodexCredential(file)).toEqual(refreshed);
		expect(getCodexRegistrationKey(file)).toBe(key);
		await getCodexAccessToken(options());
		expect(fake.refreshCount).toBe(1);
	});

	it("temporary JWKS failure cannot consume the old refresh token and retry rotates it once", async () => {
		await login();
		editStored({ expiresAt: Date.now() - 1 });
		const before = readFileSync(file, "utf8");
		const oldToken = loadCodexCredential(file)!.refreshToken;
		fake.onJwks = () => ({ status: 503, body: {} });
		await expect(getCodexAccessToken(options())).rejects.toThrow(/authentication request failed/);
		expect(readFileSync(file, "utf8")).toBe(before);
		expect(fake.refreshCount).toBe(0);
		expect(fake.consumedRefreshTokens.has(oldToken)).toBe(false);
		fake.onJwks = undefined;
		await getCodexAccessToken(options());
		expect(fake.refreshCount).toBe(1);
		expect(fake.consumedRefreshTokens.has(oldToken)).toBe(true);
	});

	it.each(["unknown-kid", "malformed-tokens"])(
		"cannot resend a consumed refresh token after a successful response with %s",
		async (failure) => {
			await login();
			await saveApiKey("zai", "key");
			editStored({ expiresAt: Date.now() - 1 });
			const oldToken = loadCodexCredential(file)!.refreshToken;
			const identity = rawStore().codex.subject;
			fake.requests = [];
			fake.onToken = async () => {
				if (failure === "unknown-kid") fake.keyId = "new-key-after-prefetch";
				return { body: await fake.tokens(failure === "malformed-tokens" ? { expires_in: 0 } : {}) };
			};
			await expect(getCodexAccessToken(options())).rejects.toThrow(
				failure === "unknown-kid" ? /verification failed/ : /missing valid token/,
			);
			expect(fake.consumedRefreshTokens.has(oldToken)).toBe(true);
			expect(fake.requests).toEqual([
				"/.well-known/openid-configuration",
				"/jwks",
				"/api/accounts/oauth/token",
			]);
			expect(loadCodexCredential(file)).toBeNull();
			expect(rawStore().codex.subject).toBe(identity);
			expect(rawStore().codex).not.toHaveProperty("refreshToken");
			expect(loadApiKey("zai")).toBe("key");
			await expect(getCodexAccessToken(options())).rejects.toThrow(/ink login/);
			expect(fake.refreshCount).toBe(1);
		},
	);

	it("does not resend a consumed token when HTTP 200 contains an unreadable token response", async () => {
		await login();
		editStored({ expiresAt: Date.now() - 1 });
		const oldToken = loadCodexCredential(file)!.refreshToken;
		fake.onToken = () => ({ body: "not-json-private-body" });
		await expect(getCodexAccessToken(options())).rejects.toThrow(/unreadable successful response/);
		expect(fake.consumedRefreshTokens.has(oldToken)).toBe(true);
		expect(loadCodexCredential(file)).toBeNull();
		expect(rawStore().codex.clientId).toBe(fake.clientId);
		await expect(getCodexAccessToken(options())).rejects.toThrow(/ink login/);
		expect(fake.refreshCount).toBe(1);
	});

	it.each(
		terminalRefreshCodes.flatMap((code) =>
			["refresh-503", "discovery-400", "jwks-400"].map((failure) => ({ code, failure })),
		),
	)(
		"does not erase credentials for $code outside a terminal refresh response: $failure",
		async ({ code, failure }) => {
			await login();
			editStored({ expiresAt: Date.now() - 1 });
			const before = readFileSync(file, "utf8");
			const reply = { status: failure === "refresh-503" ? 503 : 400, body: { error: code } };
			if (failure === "refresh-503") fake.onToken = () => reply;
			else if (failure === "discovery-400") fake.onDiscovery = () => reply;
			else fake.onJwks = () => reply;
			await expect(getCodexAccessToken(options())).rejects.toThrow();
			expect(readFileSync(file, "utf8")).toBe(before);
			expect(fake.refreshCount).toBe(failure === "refresh-503" ? 1 : 0);
			expect(fake.consumedRefreshTokens.size).toBe(0);
			fake.onToken = undefined;
			fake.onDiscovery = undefined;
			fake.onJwks = undefined;
			await getCodexAccessToken(options());
			expect(loadCodexCredential(file)!.refreshToken).toBe(fake.activeRefreshToken);
		},
	);

	it("serializes refresh-token rotation across independent processes", async () => {
		await login();
		editStored({ expiresAt: Date.now() - 1 });
		await Promise.all(
			Array.from({ length: 3 }, () =>
				authChild(
					`
			import { getCodexAccessToken } from './src/provider/codex-auth.ts';
			await getCodexAccessToken({ authPath: process.env.INK_AUTH_PATH, authBaseUrl: process.argv[1] });
		`,
					[fake.baseUrl],
				),
			),
		);
		expect(fake.refreshCount).toBe(1);
		expect(loadCodexCredential(file)!.refreshToken).toBe("refresh-1-1");
	});

	it("does not rotate twice when a concurrent replacement has a short lifetime", async () => {
		await login();
		editStored({ expiresAt: Date.now() - 1 });
		const started = deferred();
		const finish = deferred();
		fake.onToken = async () => {
			started.resolve();
			await finish.promise;
			return { body: await fake.tokens({ expires_in: 120 }) };
		};
		const first = getCodexAccessToken(options());
		await started.promise;
		const second = getCodexAccessToken(options());
		finish.resolve();
		expect(await second).toEqual(await first);
		expect(fake.refreshCount).toBe(1);
	});

	it("returns promptly on caller abort but finishes an already-started rotation and persistence", async () => {
		await login();
		editStored({ expiresAt: Date.now() - 1 });
		const started = deferred();
		const release = deferred();
		fake.onToken = async () => {
			started.resolve();
			await release.promise;
			return { body: await fake.tokens() };
		};
		const controller = new AbortController();
		const attempt = getCodexAccessToken({ ...options(), signal: controller.signal });
		await started.promise;
		controller.abort();
		await expect(attempt).rejects.toThrow(/cancelled/);
		const following = getCodexAccessToken(options());
		release.resolve();
		expect((await following).refreshToken).toBe("refresh-1-1");
		expect(loadCodexCredential(file)!.refreshToken).toBe("refresh-1-1");
		expect(fake.refreshCount).toBe(1);
	});

	it.each([...terminalRefreshCodes, "invalid_client", "temporary"])(
		"handles %s without erasing unrelated keys or registration",
		async (kind) => {
			await login();
			await saveApiKey("zai", "z");
			editStored({ expiresAt: Date.now() - 1 });
			const before = readFileSync(file, "utf8");
			fake.onToken = () => ({
				status: kind === "temporary" ? 503 : 400,
				body: { error: kind, error_description: "sensitive-body" },
			});
			const error = await getCodexAccessToken(options()).catch((reason: unknown) => reason);
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).not.toContain("sensitive-body");
			expect(loadApiKey("zai")).toBe("z");
			expect(rawStore().codex.clientId).toBe(fake.clientId);
			if ((terminalRefreshCodes as readonly string[]).includes(kind)) {
				expect(loadCodexCredential(file)).toBeNull();
				expect(rawStore().codex.refreshToken).toBeUndefined();
			} else expect(readFileSync(file, "utf8")).toBe(before);
		},
	);

	it("does not treat unknown refresh errors as terminal just because their name or description resembles one", async () => {
		await login();
		editStored({ expiresAt: Date.now() - 1 });
		const before = readFileSync(file, "utf8");
		fake.onToken = () => ({
			status: 400,
			body: { error: "refresh_token_expired_unknown", error_description: "refresh_token_expired" },
		});
		await expect(getCodexAccessToken(options())).rejects.toThrow();
		expect(readFileSync(file, "utf8")).toBe(before);
	});

	it("clears consumed tokens instead of accepting changed identity or scopes on refresh", async () => {
		await login();
		editStored({ expiresAt: Date.now() - 1 });
		const oldToken = loadCodexCredential(file)!.refreshToken;
		fake.onToken = async () => ({
			body: await fake.tokens({ id_token: await fake.idToken({ sub: "other-user" }) }),
		});
		await expect(getCodexAccessToken(options())).rejects.toThrow(/verification failed/);
		expect(fake.consumedRefreshTokens.has(oldToken)).toBe(true);
		expect(loadCodexCredential(file)).toBeNull();
		expect(rawStore().codex.subject).toBe(fake.subject);
		await expect(getCodexAccessToken(options())).rejects.toThrow(/ink login/);
		expect(fake.refreshCount).toBe(1);
		fake.onToken = undefined;
		await login();
		editStored({ expiresAt: Date.now() - 1 });
		fake.onToken = async () => ({ body: await fake.tokens({ scope: "openid" }) });
		await expect(getCodexAccessToken(options())).rejects.toThrow(DIRECT_SCOPE);
		expect(loadCodexCredential(file)).toBeNull();
		expect(rawStore().codex.subject).toBe(fake.subject);
	});

	it("keeps the validated ID token if refresh omits it, and removes obsolete earliest-refresh restrictions", async () => {
		await login();
		const idToken = loadCodexCredential(file)!.idToken;
		editStored({ expiresAt: Date.now() - 1, earliestRefreshAt: 1 });
		fake.onToken = async () => {
			const data = await fake.tokens();
			delete data.id_token;
			return { body: data };
		};
		const refreshed = await getCodexAccessToken(options());
		expect(refreshed.idToken).toBe(idToken);
		expect(refreshed.earliestRefreshAt).toBeUndefined();
	});

	it("honors earliest_refresh_at without ever returning an expired access token", async () => {
		await login();
		editStored({ expiresAt: Date.now() + 1000, earliestRefreshAt: Date.now() + 60_000 });
		await getCodexAccessToken(options());
		expect(fake.refreshCount).toBe(0);
		editStored({ expiresAt: Date.now() - 1 });
		await expect(getCodexAccessToken(options())).rejects.toThrow(/expired before refresh/);
		expect(fake.refreshCount).toBe(0);
		editStored({ earliestRefreshAt: 1 });
		fake.onToken = async () => ({
			body: await fake.tokens({ earliest_refresh_at: Math.floor(Date.now() / 1000) + 1800 }),
		});
		const refreshed = await getCodexAccessToken(options());
		expect(refreshed.earliestRefreshAt).toBeGreaterThan(Date.now());
	});

	it("logout waits for rotating refresh and revokes the replacement token while blocking other writers", async () => {
		await login();
		await saveApiKey("zai", "z");
		editStored({ expiresAt: Date.now() - 1 });
		const refreshStarted = deferred();
		const finishRefresh = deferred();
		const revokeStarted = deferred();
		const finishRevoke = deferred();
		fake.onToken = async () => {
			refreshStarted.resolve();
			await finishRefresh.promise;
			return { body: await fake.tokens() };
		};
		fake.onRevoke = async () => {
			revokeStarted.resolve();
			await finishRevoke.promise;
			return {};
		};
		const refresh = getCodexAccessToken(options());
		await refreshStarted.promise;
		const logout = logoutCodex(file, { authBaseUrl: fake.baseUrl });
		finishRefresh.resolve();
		await refresh;
		await revokeStarted.promise;
		let saved = false;
		const writer = saveApiKey("openai", "o").then(() => {
			saved = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(saved).toBe(false);
		finishRevoke.resolve();
		expect(await logout).toEqual({ remoteRevoked: true });
		await writer;
		expect(fake.revoked[0]!.get("token")).toBe("refresh-1-1");
		expect(fake.revoked[0]!.get("client_id")).toBe(fake.clientId);
		expect(loadCodexCredential(file)).toBeNull();
		expect(rawStore().codex).not.toHaveProperty("accessToken");
		expect(rawStore().codex).not.toHaveProperty("refreshToken");
		expect(rawStore().codex).not.toHaveProperty("idToken");
		expect(rawStore().codex).toMatchObject({
			issuer: fake.baseUrl,
			subject: fake.subject,
			clientId: fake.clientId,
		});
		expect(rawStore().hostId).toBeTruthy();
		expect(loadApiKey("zai")).toBe("z");
		expect(loadApiKey("openai")).toBe("o");
	});

	it("retries temporary revocation once and reports confirmation; failure still clears locally", async () => {
		await login();
		fake.onRevoke = () => (fake.revoked.length === 1 ? { status: 503, body: {} } : {});
		expect(await logoutCodex(file, { authBaseUrl: fake.baseUrl })).toEqual({ remoteRevoked: true });
		expect(fake.revoked).toHaveLength(2);
		await login();
		fake.revoked = [];
		fake.onRevoke = () => ({ status: 503, body: {} });
		expect(await logoutCodex(file, { authBaseUrl: fake.baseUrl })).toEqual({ remoteRevoked: false });
		expect(fake.revoked).toHaveLength(2);
		expect(loadCodexCredential(file)).toBeNull();
	});

	it("confirms RFC 7009 revocation by HTTP status even if the success body is not JSON", async () => {
		await login();
		fake.onRevoke = () => ({ body: "revoked" });
		expect(await logoutCodex(file, { authBaseUrl: fake.baseUrl })).toEqual({ remoteRevoked: true });
		expect(loadCodexCredential(file)).toBeNull();
	});

	it("unsafe or mismatched revocation configuration cannot prevent local clearing", async () => {
		await login();
		expect(await logoutCodex(file, { authBaseUrl: "http://remote.invalid" })).toEqual({
			remoteRevoked: false,
		});
		expect(loadCodexCredential(file)).toBeNull();
		expect(rawStore().codex.clientId).toBe(fake.clientId);
		expect(fake.revoked).toHaveLength(0);
	});

	it("does not extend token expiry by slow token response delivery", async () => {
		await login();
		editStored({ expiresAt: Date.now() - 1 });
		const requestStarted = Date.now();
		fake.onToken = async () => {
			await new Promise((resolve) => setTimeout(resolve, 80));
			const data = await fake.tokens({ expires_in: 120 });
			delete data.id_token;
			return { body: data };
		};
		const refreshed = await getCodexAccessToken(options());
		expect(refreshed.expiresAt).toBeLessThanOrEqual(requestStarted + 120_040);
	});

	it("cancels an active revocation but still clears local tokens before returning", async () => {
		await login();
		const started = deferred();
		const resume = deferred();
		fake.onRevoke = async () => {
			started.resolve();
			await resume.promise;
			return {};
		};
		const controller = new AbortController();
		const logout = logoutCodex(file, { authBaseUrl: fake.baseUrl, signal: controller.signal });
		await started.promise;
		controller.abort();
		expect(await logout).toEqual({ remoteRevoked: false });
		expect(loadCodexCredential(file)).toBeNull();
		resume.resolve();
	});

	it("cancelled logout always clears local tokens, retains registration/host and reports unconfirmed revocation", async () => {
		await login();
		const host = rawStore().hostId;
		const controller = new AbortController();
		controller.abort();
		expect(await logoutCodex(file, { authBaseUrl: fake.baseUrl, signal: controller.signal })).toEqual({
			remoteRevoked: false,
		});
		expect(fake.revoked).toHaveLength(0);
		expect(loadCodexCredential(file)).toBeNull();
		expect(rawStore().hostId).toBe(host);
		expect(rawStore().codex.clientId).toBe(fake.clientId);
	});
});

describe("pinned destinations, bounded responses and secret-safe errors", () => {
	it("ignores the removed auth environment override and rejects unsafe explicit origins", () => {
		vi.stubEnv("INK_CODEX_AUTH_BASE", fake.baseUrl);
		expect(authEndpoints().issuer).toBe("https://auth.openai.com");
		for (const endpoint of [
			"http://remote.invalid",
			"https://user:secret@example.com",
			"https://@example.com",
			"https://example.com/?",
			"https://example.com/#",
			"https://example.com/?q=x",
			"https://example.com/path",
			"http://localhost:123",
		])
			expect(() => authEndpoints(endpoint)).toThrow();
	});

	it.each(["issuer", "jwks_uri", "revocation_endpoint", "token_endpoint"])(
		"rejects malicious discovery %s before code exchange",
		async (field) => {
			fake.discoveryOverrides[field] = "https://foreign.invalid/stolen";
			await expect(login()).rejects.toThrow(/OIDC/);
			expect(fake.exchangeCount).toBe(0);
		},
	);

	it("rejects token redirects and never fetches the destination", async () => {
		fake.onToken = () => ({
			status: 302,
			headers: { location: `${fake.baseUrl}/redirect-target` },
			body: "secret-token-body",
		});
		const spy = vi.spyOn(globalThis, "fetch");
		await expect(login()).rejects.toThrow(/authentication request failed/);
		expect(spy.mock.calls.some(([input]) => String(input).endsWith("redirect-target"))).toBe(false);
		for (const [, init] of spy.mock.calls) expect(init?.redirect).toBe("error");
	});

	it("rejects oversized JWKS bodies without including body contents in the error", async () => {
		fake.onJwks = () => ({ body: `private-body-${"x".repeat(300_000)}` });
		const error = await login().catch((reason: unknown) => reason);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).not.toContain("private-body");
		expect(loadCodexCredential(file)).toBeNull();
	});
});
