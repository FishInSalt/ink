import { createServer, type Server, type ServerResponse } from "node:http";
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from "jose";
import { CODEX_SCOPES } from "../../src/provider/codex-oauth-http.js";

export interface FakeReply {
	status?: number;
	body?: unknown;
	headers?: Record<string, string>;
}

/** Local OIDC fixture with genuine asymmetric signatures; it never calls a real endpoint. */
export class FakeCodexOidc {
	baseUrl = "";
	clientId = "issued-test-client";
	subject = "local-test-user";
	nonce = "";
	keyId = "fixture-key";
	/** Successful refresh responses consume the submitted token, like a rotating provider. */
	enforceRefreshRotation = true;
	activeRefreshToken: string | null = null;
	consumedRefreshTokens = new Set<string>();
	requests: string[] = [];
	lastAuthorize: URL | undefined;
	exchangeCount = 0;
	refreshCount = 0;
	revoked: URLSearchParams[] = [];
	exchanges: URLSearchParams[] = [];
	refreshes: URLSearchParams[] = [];
	discoveryOverrides: Record<string, unknown> = {};
	onToken?: (body: URLSearchParams) => Promise<FakeReply> | FakeReply;
	onRevoke?: (body: URLSearchParams) => Promise<FakeReply> | FakeReply;
	onJwks?: () => Promise<FakeReply> | FakeReply;
	onDiscovery?: () => Promise<FakeReply> | FakeReply;
	private server: Server | undefined;
	private key: Awaited<ReturnType<typeof generateKeyPair>> | undefined;

	async start(): Promise<void> {
		this.key = await generateKeyPair("RS256");
		this.server = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (chunk: Buffer) => chunks.push(chunk));
			req.on("end", () => {
				const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
				void this.handle(req.url ?? "", body, res).catch(() => {
					if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
					res.end("{}");
				});
			});
		});
		await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
		const address = this.server.address();
		if (address === null || typeof address === "string") throw new Error("Missing fake address");
		this.baseUrl = `http://127.0.0.1:${address.port}`;
	}

	async close(): Promise<void> {
		if (!this.server) return;
		await new Promise<void>((resolve) => {
			this.server!.close(() => resolve());
			this.server!.closeAllConnections();
		});
	}

	async idToken(changes: JWTPayload = {}, wrongKey = false): Promise<string> {
		const key = wrongKey ? await generateKeyPair("RS256") : this.key!;
		const now = Math.floor(Date.now() / 1000);
		return new SignJWT({
			iss: this.baseUrl,
			sub: this.subject,
			aud: this.clientId,
			iat: now,
			exp: now + 3600,
			nonce: this.nonce,
			...changes,
		})
			.setProtectedHeader({ alg: "RS256", kid: this.keyId })
			.sign(key.privateKey);
	}

	async tokens(changes: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
		return {
			access_token: `access-${this.exchangeCount}-${this.refreshCount}`,
			refresh_token: `refresh-${this.exchangeCount}-${this.refreshCount}`,
			token_type: "Bearer",
			expires_in: 3600,
			scope: CODEX_SCOPES,
			id_token: await this.idToken(),
			...changes,
		};
	}

	callback(url: string, changes: Record<string, string> = {}): string {
		this.lastAuthorize = new URL(url);
		this.nonce = this.lastAuthorize.searchParams.get("nonce") ?? "";
		const callback = new URL(this.lastAuthorize.searchParams.get("redirect_uri")!);
		callback.search = new URLSearchParams({
			code: "local-code-do-not-log",
			state: this.lastAuthorize.searchParams.get("state")!,
			client_id: this.clientId,
			...changes,
		}).toString();
		return callback.href;
	}

	private async handle(route: string, body: URLSearchParams, res: ServerResponse): Promise<void> {
		this.requests.push(route);
		let reply: FakeReply;
		if (route === "/.well-known/openid-configuration") {
			reply = {
				body: {
					issuer: this.baseUrl,
					authorization_endpoint: `${this.baseUrl}/api/accounts/authorize`,
					token_endpoint: `${this.baseUrl}/api/accounts/oauth/token`,
					jwks_uri: `${this.baseUrl}/jwks`,
					revocation_endpoint: `${this.baseUrl}/revoke`,
					...this.discoveryOverrides,
				},
			};
			if (this.onDiscovery) reply = await this.onDiscovery();
		} else if (route === "/jwks") {
			reply = this.onJwks
				? await this.onJwks()
				: {
						body: {
							keys: [
								{ ...(await exportJWK(this.key!.publicKey)), kid: this.keyId, alg: "RS256", use: "sig" },
							],
						},
					};
		} else if (route === "/api/accounts/oauth/token") {
			if (body.get("grant_type") === "refresh_token") {
				this.refreshCount++;
				this.refreshes.push(body);
			} else {
				this.exchangeCount++;
				this.exchanges.push(body);
			}
			const refreshing = body.get("grant_type") === "refresh_token";
			const usedToken = body.get("refresh_token");
			if (
				refreshing &&
				this.enforceRefreshRotation &&
				(usedToken !== this.activeRefreshToken || this.consumedRefreshTokens.has(usedToken ?? ""))
			) {
				reply = { status: 400, body: { error: "invalid_grant" } };
			} else {
				reply = this.onToken ? await this.onToken(body) : { body: await this.tokens() };
				if ((reply.status ?? 200) >= 200 && (reply.status ?? 200) < 300) {
					if (refreshing && usedToken) this.consumedRefreshTokens.add(usedToken);
					const data = reply.body as { refresh_token?: unknown } | undefined;
					if (typeof data?.refresh_token === "string") this.activeRefreshToken = data.refresh_token;
				}
			}
		} else if (route === "/revoke") {
			this.revoked.push(body);
			reply = this.onRevoke ? await this.onRevoke(body) : { body: undefined };
		} else reply = { status: 404, body: {} };
		res.writeHead(reply.status ?? 200, { "content-type": "application/json", ...reply.headers });
		res.end(
			reply.body === undefined
				? ""
				: typeof reply.body === "string"
					? reply.body
					: JSON.stringify(reply.body),
		);
	}
}

export function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
