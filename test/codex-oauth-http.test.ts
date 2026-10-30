import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authEndpoints, discoverOidc, oauthRequest } from "../src/provider/codex-oauth-http.js";
import { FakeCodexOidc } from "./helpers/codex-auth-fake.js";

let fake: FakeCodexOidc;
beforeEach(async () => {
	fake = new FakeCodexOidc();
	await fake.start();
});
afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	await fake.close();
});

describe("OAuth bounded transport", () => {
	it("enforces the 15-second timeout through a stalled response body, not only response headers", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		let requestSignal: AbortSignal | undefined;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			requestSignal = init?.signal ?? undefined;
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						requestSignal?.addEventListener("abort", () => controller.error(new Error("private-body")), {
							once: true,
						});
					},
				}),
			);
		});
		const request = oauthRequest(`${fake.baseUrl}/stalled`).catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(15_000);
		const error = await request;
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe("ChatGPT authentication request failed (HTTP 200).");
		expect(error).toHaveProperty("status", 200);
		expect(requestSignal?.aborted).toBe(true);
	});

	it("cancels an oversized body and does not expose any response content", async () => {
		const cancel = vi.fn();
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(`secret-body-${"x".repeat(300_000)}`));
					},
					cancel,
				}),
			),
		);
		await expect(oauthRequest(`${fake.baseUrl}/too-large`)).rejects.toThrow(
			/^ChatGPT authentication request failed \(HTTP 200\)\.$/,
		);
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	it("requires exact issuer and same-origin URLs without embedded credentials or fragments", async () => {
		const endpoints = authEndpoints(fake.baseUrl);
		fake.discoveryOverrides.jwks_uri = `${fake.baseUrl}/jwks#`;
		await expect(discoverOidc(endpoints, new AbortController().signal)).rejects.toThrow(/untrusted endpoint/);
		fake.discoveryOverrides.jwks_uri = `${fake.baseUrl.replace("http://", "http://user:secret@")}/jwks`;
		await expect(discoverOidc(endpoints, new AbortController().signal)).rejects.toThrow(/untrusted endpoint/);
	});

	it("rejects redirects for JWKS and revocation as well as token requests", async () => {
		fake.onJwks = () => ({ status: 302, body: {}, headers: { location: `${fake.baseUrl}/target` } });
		await expect(oauthRequest(`${fake.baseUrl}/jwks`)).rejects.toThrow(/authentication request failed/);
		fake.onRevoke = () => ({ status: 307, body: {}, headers: { location: `${fake.baseUrl}/target` } });
		await expect(
			oauthRequest(`${fake.baseUrl}/revoke`, { method: "POST", body: "token=fixture" }),
		).rejects.toThrow(/authentication request failed/);
	});
});
