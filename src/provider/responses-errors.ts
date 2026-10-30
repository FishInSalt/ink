/** Typed, bounded diagnostics for the subscription Responses boundary. No raw
 * frame, tool arguments, ciphertext or credential is retained in these errors. */
export class CodexResponseError extends Error {
	readonly status?: number;
	readonly code?: string;
	readonly param?: string;
	readonly reason?: string;
	readonly requestId?: string;
	readonly retryable: boolean;

	constructor(
		message: string,
		fields: {
			status?: number;
			code?: string;
			param?: string;
			reason?: string;
			requestId?: string;
			retryable?: boolean;
		} = {},
	) {
		super(message);
		this.name = "CodexResponseError";
		this.status = fields.status;
		this.code = fields.code;
		this.param = fields.param;
		this.reason = fields.reason;
		this.requestId = fields.requestId;
		this.retryable = fields.retryable ?? false;
	}
}

export function protocolError(event: string, index: unknown, reason: string): CodexResponseError {
	const location = typeof index === "number" ? ` at output_index ${index}` : "";
	return new CodexResponseError(`Codex protocol error (${event}${location}): ${reason}`, {
		code: "invalid_response",
	});
}

export function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

export function diagnosticField(value: unknown): string | undefined {
	return typeof value === "string" && /^[a-zA-Z0-9_.\-[\]]{1,160}$/.test(value) ? value : undefined;
}

export function responseError(
	value: unknown,
	fields: {
		status?: number;
		reason?: string;
		requestId?: string;
		label?: string;
		redactions?: string[];
	} = {},
): CodexResponseError {
	const body = record(value) ?? {};
	const error = record(body.error) ?? body;
	const safeField = (value: unknown) => {
		const field = diagnosticField(value);
		return field !== undefined &&
			!(fields.redactions ?? []).some((secret) => secret !== "" && field.includes(secret))
			? field
			: undefined;
	};
	const code = safeField(error.code);
	const errorType = safeField(error.type);
	const param = safeField(error.param);
	const temporaryCodes = new Set([
		"subscription_sharing_usage_unavailable",
		"subscription_sharing_user_unavailable",
		"rate_limit_exceeded",
		"server_error",
		"internal_server_error",
	]);
	const category = code ?? errorType;
	const terminalCode = category !== undefined && !temporaryCodes.has(category);
	const raw = error.message ?? body.detail;
	const quotaDetail =
		category === undefined &&
		typeof raw === "string" &&
		/quota|usage limit|app.{0,16}limit|billing|usage cap/i.test(raw);
	const retryable =
		!terminalCode &&
		!quotaDetail &&
		((fields.status === 429 && temporaryCodes.has(code ?? errorType ?? "")) ||
			[500, 502, 503, 504].includes(fields.status ?? 0));
	let hint = "";
	if (fields.status === 401) hint = " — run: ink login";
	else if (code === "subscription_sharing_usage_limit_exceeded" || code === "insufficient_quota") {
		hint = " — ChatGPT plan/app usage limit reached; check https://chatgpt.com/settings/usage";
	}
	// Server diagnostics are useful for admission detail-only bodies too. Never
	// stringify unknown objects; collapse controls and redact bearer credentials.
	let diagnostic = typeof raw === "string" ? raw : (code ?? fields.reason ?? "request was not completed");
	for (const secret of fields.redactions ?? []) {
		if (secret !== "") diagnostic = diagnostic.split(secret).join("[redacted]");
	}
	const detail = diagnostic
		.replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
		.replace(/\p{Cc}/gu, " ")
		.slice(0, 240);
	return new CodexResponseError(
		`${fields.label ?? "OpenAI Codex API error"}${fields.status === undefined ? "" : ` ${fields.status}`}${hint}: ${detail}`,
		{
			...fields,
			reason: safeField(fields.reason),
			requestId: safeField(fields.requestId),
			code,
			param,
			retryable,
		},
	);
}
