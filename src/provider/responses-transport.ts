import { CodexResponseError, responseError } from "./responses-errors.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const RETRY_DELAYS = [600, 1500];
const MAX_ERROR_BYTES = 64 * 1024;

/** A production override may select HTTPS, never credentials/fragments/query.
 * HTTP is allowed only with explicit endpoint + injected auth/fetch, on loopback. */
export function responsesEndpoint(base: string | undefined, injected: boolean): string {
	let url: URL;
	try {
		url = new URL(base ?? DEFAULT_BASE_URL);
	} catch {
		throw new CodexResponseError("Invalid OpenAI Codex base URL", { code: "invalid_endpoint" });
	}
	const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
	if (
		url.username ||
		url.password ||
		url.hash ||
		url.search ||
		(url.protocol !== "https:" && !(injected && loopback && url.protocol === "http:"))
	) {
		throw new CodexResponseError(
			"OpenAI Codex base URL must use HTTPS without credentials, query or fragment",
			{
				code: "invalid_endpoint",
			},
		);
	}
	return `${url.href.replace(/\/+$/, "")}/responses`;
}

async function pause(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return;
	await new Promise<void>((resolve) => {
		const finish = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", finish);
			resolve();
		};
		const timer = setTimeout(finish, ms);
		signal?.addEventListener("abort", finish, { once: true });
	});
}

async function errorBody(response: Response, signal?: AbortSignal): Promise<unknown> {
	if (!response.body) return undefined;
	const reader = response.body.getReader();
	const cancel = () => {
		void reader.cancel().catch(() => {});
	};
	signal?.addEventListener("abort", cancel, { once: true });
	if (signal?.aborted) cancel();
	const chunks: Uint8Array[] = [];
	let length = 0;
	let expired = false;
	const timer = setTimeout(() => {
		expired = true;
		void reader.cancel().catch(() => {});
	}, 15_000);
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			length += value.length;
			if (length > MAX_ERROR_BYTES) return undefined;
			chunks.push(value);
		}
		if (expired) return undefined;
		try {
			return JSON.parse(Buffer.concat(chunks).toString("utf8"));
		} catch {
			return undefined;
		}
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", cancel);
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

/** Retry only pre-stream temporary admission/network failures. Fetch never
 * follows redirects, including same-origin redirects carrying OAuth headers. */
export async function postResponses(args: {
	url: string;
	headers: Record<string, string>;
	body: string;
	signal?: AbortSignal;
	fetch: typeof fetch;
	/** Known credential values to remove from untrusted server diagnostics. */
	redactions?: string[];
}): Promise<Response | null> {
	for (let attempt = 0; ; attempt++) {
		if (args.signal?.aborted) return null;
		const timeout = new AbortController();
		const timer = setTimeout(() => timeout.abort(), 30_000);
		let response: Response;
		try {
			response = await args.fetch(args.url, {
				method: "POST",
				headers: args.headers,
				body: args.body,
				redirect: "manual",
				signal: args.signal ? AbortSignal.any([args.signal, timeout.signal]) : timeout.signal,
			});
		} catch {
			clearTimeout(timer);
			if (args.signal?.aborted) return null;
			if (attempt >= RETRY_DELAYS.length) {
				throw new CodexResponseError("Codex request failed before the response stream opened", {
					code: "connection_failed",
					retryable: true,
				});
			}
			await pause(RETRY_DELAYS[attempt]!, args.signal);
			continue;
		} finally {
			clearTimeout(timer);
		}
		if (args.signal?.aborted) {
			await response.body?.cancel().catch(() => {});
			return null;
		}
		if (response.status >= 300 && response.status < 400) {
			await response.body?.cancel().catch(() => {});
			throw new CodexResponseError("Codex credential-bearing request rejected a redirect", {
				status: response.status,
				code: "redirect_rejected",
			});
		}
		if (response.ok) {
			if (!response.body) {
				throw responseError(
					{ error: { code: "invalid_response", message: "expected a response stream body" } },
					{
						status: response.status,
						requestId: response.headers.get("x-request-id") ?? undefined,
						redactions: args.redactions,
						label: "Invalid Codex response",
					},
				);
			}
			// The direct endpoint can omit Content-Type. Validate the actual SSE
			// frames and terminal event, not the advisory media-type header.
			return response;
		}
		const body = await errorBody(response, args.signal);
		if (args.signal?.aborted) return null;
		const error = responseError(body, {
			status: response.status,
			requestId: response.headers.get("x-request-id") ?? undefined,
			redactions: args.redactions,
		});
		if (!error.retryable || attempt >= RETRY_DELAYS.length) throw error;
		await pause(RETRY_DELAYS[attempt]!, args.signal);
	}
}
