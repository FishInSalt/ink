import { mkdirSync } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS, findCutIndex } from "../src/core/compaction.js";
import { createSession } from "../src/core/session/manager.js";
import { SessionStore } from "../src/core/session/store.js";
import { runSubagent } from "../src/core/subagent.js";
import type { Tool } from "../src/core/tools/types.js";
import { getCodexAccessToken } from "../src/provider/codex-auth.js";
import { createCodexResponsesProvider } from "../src/provider/codex-responses.js";
import * as responseErrors from "../src/provider/responses-errors.js";
import { createRunner } from "../src/runner.js";
import { assistant, makeRenderer, user } from "./helpers/fakes.js";
import { mkTempDir } from "./helpers/mktemp.js";

// The injected provider must never fall back to credentials on disk.
vi.mock("../src/provider/codex-auth.js", () => ({
	getCodexAccessToken: vi.fn(() => {
		throw new Error("Credential reads forbidden in structured recovery tests");
	}),
}));

const MODEL = "gpt-5.5";
const BASE = `openai-codex/${MODEL}`;
const FAST = `${BASE}·fast`;
const SUMMARY = "## Goal\nSTRUCTURED-RECOVERY-SUMMARY";
const OVERFLOW = "context length exceeded";
const REQUEST_ID = "req_structured_context";
const sentinel: Tool = {
	name: "unused",
	description: "Distinguishes task requests from summaries",
	parameters: Type.Object({}),
	async execute() {
		return { output: "unused" };
	},
};

type WireBody = {
	model: string;
	service_tier?: string;
	input: Array<Record<string, unknown>>;
};

type FailureCase = {
	name: string;
	reply: () => Response;
	code?: string;
	reason?: string;
	status: number;
};

function sse(type: string, response: Record<string, unknown>): Response {
	return new Response(`data: ${JSON.stringify({ type, response })}\n\n`, {
		headers: { "content-type": "text/event-stream", "x-request-id": REQUEST_ID },
	});
}

function httpFailure(code?: string, message = OVERFLOW, status = 400): Response {
	return new Response(JSON.stringify({ error: { code, message, param: "service_tier" } }), {
		status,
		headers: { "content-type": "application/json", "x-request-id": REQUEST_ID },
	});
}

function incomplete(code?: string, reason?: string, message = OVERFLOW): Response {
	return sse("response.incomplete", {
		status: "incomplete",
		...(reason === undefined ? {} : { incomplete_details: { reason } }),
		error: { code, message },
	});
}

function completed(text: string): Response {
	return sse("response.completed", {
		status: "completed",
		service_tier: "priority",
		usage: { input_tokens: 10, output_tokens: 5 },
		output: [{ type: "message", content: [{ type: "output_text", text }] }],
	});
}

const refusals: FailureCase[] = [
	...["unsupported_service_tier", "invalid_service_tier", "tier_unavailable", "unsupported_parameter"].map(
		(code) => ({ name: `HTTP tier ${code}`, reply: () => httpFailure(code), code, status: 400 }),
	),
	{
		name: "SSE tier code overrides conflicting context reason",
		reply: () => incomplete("tier_unavailable", "context_length_exceeded"),
		code: "tier_unavailable",
		reason: "context_length_exceeded",
		status: 200,
	},
	{
		name: "SSE tier code overrides unknown_incomplete and overflow text",
		reply: () => incomplete("tier_unavailable"),
		code: "tier_unavailable",
		reason: "unknown_incomplete",
		status: 200,
	},
	{
		name: "HTTP authentication with overflow text",
		reply: () => httpFailure("invalid_api_key", OVERFLOW, 401),
		code: "invalid_api_key",
		status: 401,
	},
	{
		name: "HTTP quota with overflow text",
		reply: () => httpFailure("insufficient_quota"),
		code: "insufficient_quota",
		status: 400,
	},
	{
		name: "SSE protocol code with overflow text",
		reply: () => sse("response.failed", { error: { code: "invalid_response", message: OVERFLOW } }),
		code: "invalid_response",
		reason: "failed",
		status: 200,
	},
	{
		name: "SSE network code with overflow text",
		reply: () => sse("response.failed", { error: { code: "connection_failed", message: OVERFLOW } }),
		code: "connection_failed",
		reason: "failed",
		status: 200,
	},
	{
		name: "content_filter reason overrides generic code and overflow text",
		reply: () => incomplete("invalid_request_error", "content_filter"),
		code: "invalid_request_error",
		reason: "content_filter",
		status: 200,
	},
	{
		name: "content_filter reason overrides absent code and overflow text",
		reply: () => incomplete(undefined, "content_filter"),
		reason: "content_filter",
		status: 200,
	},
	{
		name: "bare context length is not an overflow",
		reply: () => httpFailure(undefined, "service tier is unavailable for this context length"),
		status: 400,
	},
];

const recoveries: FailureCase[] = [
	...[
		undefined,
		"",
		"invalid_request_error",
		"invalid_request",
		"bad_request",
		"error",
		"request_failed",
	].map((code) => ({
		name: `missing incomplete reason with ${JSON.stringify(code)} code and overflow text`,
		reply: () => incomplete(code),
		code: code || undefined, // The real provider omits empty diagnostic fields.
		reason: "unknown_incomplete",
		status: 200,
	})),
	...["context_length_exceeded", "context_window_exceeded"].map((code) => ({
		name: `explicit ${code} code overrides content_filter reason and unrelated text`,
		reply: () => incomplete(code, "content_filter", "request refused"),
		code,
		reason: "content_filter",
		status: 200,
	})),
	...["context_length_exceeded", "context_window_exceeded"].map((reason) => ({
		name: `explicit ${reason} reason with generic code and unrelated text`,
		reply: () => incomplete("invalid_request_error", reason, "request refused"),
		code: "invalid_request_error",
		reason,
		status: 200,
	})),
	{
		name: "generic HTTP request container with legacy prompt overflow text",
		reply: () => httpFailure("invalid_request_error", "prompt is too long"),
		code: "invalid_request_error",
		status: 400,
	},
];

let root: string;
let cwd: string;
let sessionBaseDir: string;
beforeEach(() => {
	root = mkTempDir("ink-structured-recovery-");
	cwd = path.join(root, "project");
	sessionBaseDir = path.join(root, "sessions");
	mkdirSync(cwd);
	vi.clearAllMocks();
	vi.stubEnv("INK_LOG", "0");
	vi.stubEnv("INK_AUTOCOMPACT", "0");
	vi.stubEnv("INK_HEALTH", "0");
	vi.stubEnv("INK_CATALOG_PATH", path.join(root, "catalog.json"));
	vi.stubEnv("OPENAI_API_KEY", "fake-api-key-must-not-be-used");
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("Non-injected network forbidden in structured recovery tests");
		}),
	);
});
afterEach(() => {
	expect(getCodexAccessToken).not.toHaveBeenCalled();
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

function savedHistory() {
	// Larger than the real Runner's 20k retained tail, not just tiny child settings.
	const history = [
		user(`OLD-HISTORY-TO-SUMMARIZE ${"history ".repeat(12_000)}`),
		assistant([{ type: "text", text: "old answer" }]),
		user(`recent history ${"history ".repeat(12_000)}`),
	];
	expect(
		findCutIndex([...history, user("continue work")], DEFAULT_COMPACTION_SETTINGS.keepRecentTokens),
	).toBeGreaterThan(0);
	const session = createSession(cwd, sessionBaseDir);
	session.seedModel({ provider: "openai-codex", modelId: MODEL, speed: "fast" });
	for (const message of history) session.appendMessage(message);
	return { history, session };
}

function harness(failure: FailureCase) {
	const bodies: WireBody[] = [];
	const errors = vi.spyOn(responseErrors, "responseError");
	const auth = vi.fn(async () => ({ accessToken: "fake-structured-recovery-access" }));
	const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
		const body = JSON.parse(String(init?.body)) as WireBody;
		bodies.push(body);
		if (bodies.length === 1) return failure.reply();
		if (bodies.length > 3) throw new Error("Unexpected recovery request");
		// If a refusal is misclassified, summary and retry succeed, exposing masking.
		return completed(body.input[0]?.type === "additional_tools" ? "recovered" : SUMMARY);
	});
	const provider = createCodexResponsesProvider({ baseUrl: "https://api.openai.com/v1", auth, fetch });
	return { bodies, errors, auth, fetch, provider };
}

function originalError(h: ReturnType<typeof harness>, failure: FailureCase) {
	expect(h.errors).toHaveBeenCalledTimes(1);
	const error = h.errors.mock.results[0]?.value;
	expect(error).toBeInstanceOf(responseErrors.CodexResponseError);
	expect(error).toMatchObject({
		code: failure.code,
		reason: failure.reason,
		status: failure.status,
		requestId: REQUEST_ID,
		retryable: false,
	});
	return error as responseErrors.CodexResponseError;
}

function expectRequests(h: ReturnType<typeof harness>, count: number) {
	expect(h.fetch).toHaveBeenCalledTimes(count);
	expect(h.auth).toHaveBeenCalledTimes(count);
	expect(h.bodies).toHaveLength(count);
	for (const body of h.bodies) expect(body).toMatchObject({ model: MODEL, service_tier: "priority" });
	expect(h.bodies[0]?.input[0]?.type).toBe("additional_tools");
	if (count === 3) {
		expect(h.bodies[1]?.input[0]?.type).not.toBe("additional_tools");
		expect(JSON.stringify(h.bodies[1]?.input)).toContain("OLD-HISTORY-TO-SUMMARIZE");
		expect(h.bodies[2]?.input[0]?.type).toBe("additional_tools");
		const retry = JSON.stringify(h.bodies[2]?.input);
		expect(retry).toContain(SUMMARY.replace(/\n/g, "\\n"));
		expect(retry).not.toContain("OLD-HISTORY-TO-SUMMARIZE");
		expect(retry.match(/continue work/g)).toHaveLength(1);
	}
}

function expectPersisted(session: SessionStore, checkpoints: number) {
	const reopened = SessionStore.open(session.filePath);
	expect(reopened.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(checkpoints);
	expect(reopened.getEntries().filter((entry) => entry.type === "summaryUsage")).toHaveLength(0);
	expect(reopened.getModel()).toEqual({ provider: "openai-codex", modelId: MODEL, speed: "fast" });
	if (checkpoints > 0) {
		expect(reopened.getEntries().find((entry) => entry.type === "compaction")).toMatchObject({
			summary: SUMMARY,
			model: MODEL,
			modelReference: BASE,
		});
		expect(reopened.buildContext().messages[0]).toMatchObject({
			role: "user",
			content: expect.stringContaining(SUMMARY),
		});
	}
}

async function mainRunner(h: ReturnType<typeof harness>, session: SessionStore) {
	const { renderer, output } = makeRenderer();
	const live = await createRunner({
		cwd,
		argv: [],
		model: FAST,
		modelExplicit: true,
		maxTokens: 1024,
		maxTurns: 5,
		noContextFiles: true,
		noSession: false,
		resume: session.header.id,
		sessionBaseDir,
		settingsPath: path.join(root, "settings.json"),
		agentsHomeDir: root,
		agentsProjectAllowed: false,
		systemPromptHomeDir: root,
		renderer,
		provider: h.provider,
		tools: [sentinel],
	});
	onTestFinished(() => live.close());
	return { live, output };
}

describe("structured context recovery through the real Codex provider and main Runner", () => {
	it.each(refusals)("does not compact or retry $name", async (failure) => {
		const { session } = savedHistory();
		const h = harness(failure);
		const { live, output } = await mainRunner(h, session);
		const actual = await live.runTurn({ userMessage: "continue work" }).catch((error: unknown) => error);
		expect(actual).toBe(originalError(h, failure));
		expectRequests(h, 1);
		expectPersisted(session, 0);
		expect(live.modelSelectionReference()).toBe(FAST);
		expect(live.speed).toBe("fast");
		expect(live.history.filter((message) => message.role === "assistant")).toHaveLength(1);
		expect(live.history[0]).toMatchObject({ content: expect.stringContaining("OLD-HISTORY-TO-SUMMARIZE") });
		expect(output()).not.toContain("compacting once and retrying");
	});

	it.each(recoveries)("compacts once and retries $name", async (failure) => {
		const { session } = savedHistory();
		const h = harness(failure);
		const { live } = await mainRunner(h, session);
		expect(await live.runTurn({ userMessage: "continue work" })).toMatchObject({ stopReason: "completed" });
		originalError(h, failure);
		expectRequests(h, 3);
		expectPersisted(session, 1);
		expect(live.modelSelectionReference()).toBe(FAST);
		expect(live.history.at(-1)).toMatchObject({ blocks: [{ type: "text", text: "recovered" }] });
	});
});

describe.each([false, true])(
	"structured context recovery through runSubagent (persisted=%s)",
	(persisted) => {
		async function run(h: ReturnType<typeof harness>, history: ReturnType<typeof savedHistory>) {
			return runSubagent({
				provider: h.provider,
				model: MODEL,
				modelReference: BASE,
				speed: "fast",
				system: "Structured context recovery fixture",
				tools: [sentinel],
				prompt: "continue work",
				initialHistory: history.history,
				autoCompact: false,
				...(persisted
					? { session: history.session, onMessage: (message) => history.session.appendMessage(message) }
					: {}),
			});
		}

		it.each(refusals)("does not compact or retry $name", async (failure) => {
			const history = savedHistory();
			const h = harness(failure);
			const outcome = await run(h, history);
			expect(outcome).toMatchObject({ status: "crash", reason: originalError(h, failure).message, turns: 0 });
			expect(outcome.usageDetail.summarizerCalls).toBe(0);
			expectRequests(h, 1);
			expectPersisted(history.session, 0);
		});

		it.each(recoveries)("compacts once and retries $name", async (failure) => {
			const history = savedHistory();
			const h = harness(failure);
			const outcome = await run(h, history);
			expect(outcome, outcome.reason).toMatchObject({ status: "completed", text: "recovered", turns: 1 });
			expect(outcome.usageDetail.summarizerCalls).toBe(1);
			originalError(h, failure);
			expectRequests(h, 3);
			expectPersisted(history.session, persisted ? 1 : 0);
		});
	},
);
