import { CodexResponseError, responseError } from "./responses-errors.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
/** Pre-stream network failures: five attempts, 1/2/4/8 s pauses. */
const NETWORK_RETRY_DELAYS = [1000, 2000, 4000, 8000];
/** Temporary admission/HTTP failures keep the existing three-attempt policy. */
const ADMISSION_RETRY_DELAYS = [600, 1500];
/** Hard cap shared by both classes; either class schedule may stop earlier. */
const MAX_ATTEMPTS = 5;
/** One attempt may spend this long from DNS through response headers. */
const ATTEMPT_TIMEOUT_MS = 30_000;
/** Whole-call budget; today's worst case is 30 + 0.6 + 30 + 1.5 + 30 = 92.1 s. */
const OPENING_BUDGET_MS = 95_000;
const MAX_ERROR_BYTES = 64 * 1024;
/** Closed allowlist: only these client-side socket/TLS codes may reach the UI. */
const SAFE_CAUSE_CODES = new Set([
	"ECONNRESET",
	"ECONNREFUSED",
	"ECONNABORTED",
	"EPIPE",
	"ETIMEDOUT",
	"ENETUNREACH",
	"EHOSTUNREACH",
	"ENOTFOUND",
	"EAI_AGAIN",
	"CERT_HAS_EXPIRED",
	"DEPTH_ZERO_SELF_SIGNED_CERT",
	"SELF_SIGNED_CERT_IN_CHAIN",
	"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
	"ERR_TLS_CERT_ALTNAME_INVALID",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_BODY_TIMEOUT",
	"UND_ERR_SOCKET",
	"UND_ERR_CLOSED",
	"UND_ERR_ABORTED",
]);

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

/** Only a closed allowlist of client-side codes may enter a user-visible
 * diagnostic; never the raw network error message. */
function safeCauseCode(error: unknown, redactions: string[] | undefined): string | undefined {
	try {
		if (error === null || typeof error !== "object") return undefined;
		const cause = (error as { cause?: unknown }).cause;
		if (cause === null || typeof cause !== "object") return undefined;
		const code = (cause as { code?: unknown }).code;
		if (typeof code !== "string" || !SAFE_CAUSE_CODES.has(code)) return undefined;
		if ((redactions ?? []).some((secret) => secret !== "" && code.includes(secret))) return undefined;
		return code;
	} catch {
		// A hostile/odd cause getter must not break the retry path.
		return undefined;
	}
}

function connectionFailed(attempts: number, label: string | undefined): CodexResponseError {
	const count = `${attempts} attempt${attempts === 1 ? "" : "s"}`;
	const detail = label === undefined ? ` (${count})` : ` (${count}; last: ${label})`;
	return new CodexResponseError(`Codex request failed before the response stream opened${detail}`, {
		code: "connection_failed",
		retryable: true,
	});
}

/** Retry only pre-stream temporary admission/network failures. Fetch never
 * follows redirects, including same-origin redirects carrying OAuth headers.
 *
 * Network attempts use 1/2/4/8 s pauses (five total); temporary HTTP admission
 * failures keep the existing 600/1500 ms pauses (three total). A 95 s opening
 * budget bounds both classes, and each attempt keeps its own 30 s timeout from
 * DNS through response headers. */
export async function postResponses(args: {
	url: string;
	headers: Record<string, string>;
	body: string;
	signal?: AbortSignal;
	fetch: typeof fetch;
	/** Known credential values to remove from untrusted server diagnostics. */
	redactions?: string[];
}): Promise<Response | null> {
	const deadline = new AbortController();
	const deadlineTimer = setTimeout(() => deadline.abort(), OPENING_BUDGET_MS);
	const stop = args.signal ? AbortSignal.any([args.signal, deadline.signal]) : deadline.signal;
	let networkFailures = 0;
	let admissionFailures = 0;
	try {
		for (let attempt = 0; ; attempt++) {
			if (args.signal?.aborted) return null;
			if (deadline.signal.aborted) throw connectionFailed(attempt, "deadline");
			const timeout = new AbortController();
			const timer = setTimeout(() => timeout.abort(), ATTEMPT_TIMEOUT_MS);
			let response: Response;
			try {
				response = await args.fetch(args.url, {
					method: "POST",
					headers: args.headers,
					body: args.body,
					redirect: "manual",
					signal: AbortSignal.any([stop, timeout.signal]),
				});
			} catch (error) {
				clearTimeout(timer);
				if (args.signal?.aborted) return null;
				const label = deadline.signal.aborted
					? "deadline"
					: timeout.signal.aborted
						? "timeout"
						: safeCauseCode(error, args.redactions);
				const delay = NETWORK_RETRY_DELAYS[networkFailures];
				networkFailures += 1;
				if (delay === undefined || attempt >= MAX_ATTEMPTS - 1 || deadline.signal.aborted) {
					throw connectionFailed(attempt + 1, label);
				}
				await pause(delay, stop);
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
			const body = await errorBody(response, stop);
			if (args.signal?.aborted) return null;
			const error = responseError(body, {
				status: response.status,
				requestId: response.headers.get("x-request-id") ?? undefined,
				redactions: args.redactions,
			});
			// Headers arrived: a terminal HTTP error keeps its login/quota guidance
			// even when the budget expired while its body was being read.
			if (!error.retryable) throw error;
			if (deadline.signal.aborted) throw connectionFailed(attempt + 1, "deadline");
			const delay = ADMISSION_RETRY_DELAYS[admissionFailures];
			admissionFailures += 1;
			if (delay === undefined || attempt >= MAX_ATTEMPTS - 1) throw error;
			await pause(delay, stop);
		}
	} finally {
		clearTimeout(deadlineTimer);
	}
}
