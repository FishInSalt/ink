import { describe, expect, it } from "vitest";
import { isContextOverflowError } from "../src/core/compaction.js";
import { CodexResponseError, responseError } from "../src/provider/responses-errors.js";

describe("Responses diagnostic wording and classification", () => {
	it.each([undefined, 200, 201, 206, 299])(
		"does not describe successful HTTP status %s as an API failure",
		(status) => {
			const error = responseError(
				{ error: { code: "context_length_exceeded", param: "input", message: "too long" } },
				{
					status,
					requestId: "req_1",
					reason: "failed",
				},
			);
			expect(error).toBeInstanceOf(CodexResponseError);
			expect(error).toMatchObject({
				status,
				requestId: "req_1",
				reason: "failed",
				code: "context_length_exceeded",
				param: "input",
				retryable: false,
			});
			expect(error.message).toBe("Codex response error: too long");
			expect(isContextOverflowError(error)).toBe(true);
			expect(responseError({ detail: "refused" }, { status, label: "Codex stream error" }).message).toBe(
				"Codex stream error: refused",
			);
		},
	);

	it.each([
		{ status: 400, code: "unsupported_service_tier", retryable: false },
		{ status: 429, code: "rate_limit_exceeded", retryable: true },
		{ status: 503, code: "server_error", retryable: true },
		{ status: 503, code: "unsupported_service_tier", retryable: false },
		{ status: 200, code: "server_error", retryable: false },
	])("retains classification of $status/$code", ({ status, code, retryable }) => {
		const error = responseError({ error: { code, message: "detail" } }, { status });
		expect(error).toMatchObject({ status, code, retryable });
		expect(error.message).toBe(
			status === 200 ? "Codex response error: detail" : `OpenAI Codex API error ${status}: detail`,
		);
	});

	it("retains bounded redaction and safe diagnostic fields on HTTP 200", () => {
		const secret = "fake-access-token";
		const error = responseError(
			{
				error: {
					code: "failed",
					param: `param_${secret}`,
					message: `${secret}\r\nBearer other-secret ${"x".repeat(500)}`,
				},
			},
			{
				status: 200,
				requestId: `req_${secret}`,
				redactions: [secret],
			},
		);
		expect(error.status).toBe(200);
		expect(error.code).toBe("failed");
		expect(error.param).toBeUndefined();
		expect(error.requestId).toBeUndefined();
		expect(error.message).not.toMatch(/fake-access-token|other-secret|\r|\n|API error|200/);
		expect(error.message.length).toBeLessThanOrEqual("Codex response error: ".length + 240);
	});
});
