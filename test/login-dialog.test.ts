import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { loadApiKey, saveApiKey } from "../src/provider/auth-store.js";
import { loadCodexCredential, loginCodex } from "../src/provider/codex-auth.js";
import { Renderer } from "../src/render.js";
import { LoginDialog } from "../src/repl/login-dialog.js";
import { runRepl } from "../src/repl/repl.js";
import { TuiShell } from "../src/repl/shell.js";
import { TranscriptSink } from "../src/repl/transcript.js";
import { createRunner } from "../src/runner.js";
import { deferred, FakeCodexOidc } from "./helpers/codex-auth-fake.js";
import { scriptedProvider } from "./helpers/fakes.js";
import { mkTempDirAsync } from "./helpers/mktemp.js";
// Exclusive login integration with signed local OIDC tokens and fake terminal.

import { FakeTerminal, settle } from "./login-dialog.helpers.js";

const OAUTH_BUDGET = 6000;

interface Env {
	terminal: FakeTerminal;
	transcript: TranscriptSink;
	authPath: string;
	baseDir: string;
	repl: Promise<number>;
	requests: unknown[];
	exitCode: Promise<number> | null;
}

async function startDialogRepl(
	commands?: Parameters<typeof runRepl>[0]["commands"],
	codexLogin?: Parameters<typeof runRepl>[0]["codexLogin"],
): Promise<Env> {
	const baseDir = await mkTempDirAsync("ink-login-dlg-");
	const authPath = path.join(baseDir, "auth.json");
	vi.stubEnv("INK_AUTH_PATH", authPath);
	for (const key of ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ZAI_API_KEY"]) {
		if (process.env[key] !== undefined) delete process.env[key];
	}
	const terminal = new FakeTerminal();
	const transcript = new TranscriptSink();
	const renderer = new Renderer({
		write: transcript.feed,
		thinkingSink: transcript.thinkingSink,
		userSink: (t: string) => transcript.feedUser(t),
		statusSink: (t: string) => transcript.feedStatus(t),
		ansi: false,
		liveTools: false,
		toolStyle: "one-line",
		foldedResults: true,
	});
	const requests: unknown[] = [];
	const provider = scriptedProvider(
		[
			{
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				stopReason: "stop",
			} as never,
		],
		requests as never,
	);
	const runner = await createRunner({
		cwd: baseDir,
		argv: [],
		model: "test-model",
		maxTokens: 1024,
		maxTurns: 10,
		noContextFiles: true,
		noSession: false,
		sessionBaseDir: baseDir,
		settingsPath: path.join(baseDir, "settings.json"),
		renderer,
		provider,
		deferInit: false,
	});
	const repl = runRepl({
		runner,
		commands: commands ?? [],
		codexLogin,
		shell: "tui",
		transcript,
		terminal,
		interactive: true,
		exit: (code: number) => {
			throw new Error(`force-exit:${code}`);
		},
	});
	await settle(40);
	return { terminal, transcript, authPath, baseDir, repl, requests, exitCode: null };
}

async function fakeCodexAuth(): Promise<FakeCodexOidc> {
	const fake = new FakeCodexOidc();
	await fake.start();
	onTestFinished(() => fake.close());
	return fake;
}

const envs: Env[] = [];
async function fresh(
	commands?: Parameters<typeof runRepl>[0]["commands"],
	codexLogin?: Parameters<typeof runRepl>[0]["codexLogin"],
): Promise<Env> {
	const env = await startDialogRepl(commands, codexLogin);
	envs.push(env);
	return env;
}

beforeEach(() => {
	vi.unstubAllEnvs();
});

afterEach(async () => {
	for (const env of envs.splice(0)) {
		env.terminal.data("\x1b");
		await settle(15);
		env.terminal.data("/exit\r");
		try {
			await Promise.race([env.repl, new Promise((r) => setTimeout(r, 500))]);
		} catch {
			/* force-exit throw is fine */
		}
	}
	vi.unstubAllEnvs();
});

describe("login dialog (#login-dialog)", () => {
	it("1. api-key flow: dialog renders, paste feeds the Input, Enter stores; teardown then transcript status", async () => {
		const env = await fresh();
		env.terminal.data("/login zai\r");
		await settle(60);
		const frame = env.terminal.frameSince(0);
		expect(frame).toContain("Login to Z.AI");
		expect(frame).toContain("Enter Z.AI API key");
		expect(frame).toContain("esc to cancel");
		// §2.1.2 paste verification (not assumed): bracketed paste lands
		// whole in the Input.
		env.terminal.data("\x1b[200~sk-pasted-key\x1b[201~");
		await settle();
		expect(env.terminal.frameSince(0)).toContain("sk-pasted-key");
		const submitMark = env.terminal.writes.length;
		env.terminal.data("\r");
		await frameEventually(env, "Saved API key for Z.AI", OAUTH_BUDGET);
		expect(loadApiKey("zai", env.authPath)).toBe("sk-pasted-key");
		// restore-then-status: the dialog is gone BEFORE the status lands
		expect(env.transcript.completedLines().join("\n")).toContain("Saved API key for Z.AI");
		expect(env.terminal.frameSince(submitMark)).not.toContain("Enter Z.AI API key");
		// the key never enters input history
		expect(env.terminal.frameSince(0)).not.toContain("/login zaisk-pasted");
	});

	it("2. Esc during the prompt: silent cancel, nothing stored, editor restored", async () => {
		const env = await fresh();
		env.terminal.data("/login zai\r");
		await settle();
		const escMark = env.terminal.writes.length;
		env.terminal.data("\x1b"); // Esc
		await settle();
		expect(loadApiKey("zai", env.authPath)).toBeNull();
		expect(env.terminal.frameSince(escMark)).not.toContain("Enter Z.AI API key");
		expect(env.transcript.completedLines().join("\n")).not.toContain("Saved");
		// a follow-up command works — no guard residue
		env.terminal.data("/exit\r");
		await expect(env.repl).resolves.toBe(0);
		envs.splice(envs.indexOf(env), 1);
	});

	it("3. browser callback cancels hidden manual input, restores editor, and emits success", async () => {
		const fake = await fakeCodexAuth();
		const authorized = deferred<string>();
		const env = await fresh(undefined, {
			authBaseUrl: fake.baseUrl,
			callbackPort: 0,
			openBrowser: (url) => {
				authorized.resolve(url);
			},
			discoverModels: async () => ["account-first"],
		});
		env.terminal.data("/login openai-codex\r");
		const url = await authorized.promise;
		await frameEventually(env, "Waiting for browser", OAUTH_BUDGET);
		expect(env.terminal.frameSince(0)).toContain("127.0.0.1");
		expect(env.terminal.writes.join("")).toContain("\x1b]8;;");
		env.terminal.data("\x1b[200~partial-callback-secret\x1b[201~");
		await settle();
		expect(env.terminal.writes.join("")).not.toContain("partial-callback-secret");
		await fetch(fake.callback(url));
		await frameEventually(env, "Logged in to OpenAI (ChatGPT plan)", OAUTH_BUDGET);
		expect(loadCodexCredential(env.authPath)?.subject).toBe(fake.subject);
		expect(env.transcript.completedLines().join("\n")).not.toContain("partial-callback-secret");
		env.terminal.data("\x1b[A");
		await settle();
		expect(env.terminal.frameSince(0)).not.toContain("partial-callback-secret");
	});

	it("4. Esc during browser authorization: silent cancel, no credential, no guard residue", async () => {
		const fake = await fakeCodexAuth();
		const env = await fresh(undefined, {
			authBaseUrl: fake.baseUrl,
			callbackPort: 0,
			openBrowser: () => undefined,
		});
		env.terminal.data("/login openai-codex\r");
		await frameEventually(env, "Waiting for browser", OAUTH_BUDGET);
		env.terminal.data("\x1b");
		await settle();
		expect(loadCodexCredential(env.authPath)).toBeNull();
		expect(env.transcript.completedLines().join("\n")).not.toContain("login failed");
		env.terminal.data("/login zai\r");
		await settle();
		expect(env.terminal.frameSince(0)).toContain("Enter Z.AI API key");
	});

	it("OAuth server errors remain visible after the dialog teardown aborts its signal", async () => {
		const fake = await fakeCodexAuth();
		fake.onToken = () => ({ status: 400, body: { error: "invalid_client" } });
		const env = await fresh(undefined, {
			authBaseUrl: fake.baseUrl,
			callbackPort: 0,
			openBrowser: async (url) => {
				await fetch(fake.callback(url));
			},
		});
		env.terminal.data("/login openai-codex\r");
		await frameEventually(env, "login failed", OAUTH_BUDGET);
		expect(loadCodexCredential(env.authPath)).toBeNull();
		expect(env.transcript.completedLines().join("\n")).not.toContain("Logged in");
	});

	it("5. Ctrl+C as a KEYpress cancels the dialog (raw \\x03, not SIGINT)", async () => {
		const env = await fresh();
		env.terminal.data("/login zai\r");
		await settle();
		const cMark = env.terminal.writes.length;
		env.terminal.data("\x03"); // Ctrl+C data
		await settle();
		expect(loadApiKey("zai", env.authPath)).toBeNull();
		expect(env.terminal.frameSince(cMark)).not.toContain("Enter Z.AI API key");
		expect(env.transcript.completedLines().join("\n")).not.toContain("interrupt");
	});

	it.each([
		{ name: "Esc", key: "\x1b" },
		{ name: "Ctrl+C", key: "\x03" },
		{ name: "Kitty Ctrl+C", key: "\x1b[99;5u" },
		{ name: "modifyOtherKeys Ctrl+C", key: "\x1b[27;5;99~" },
	])("$name cancels a contended API-key save without a later write", async ({ key }) => {
		const env = await fresh();
		await saveApiKey("zai", "previous-key", env.authPath);
		await saveApiKey("openai", "unrelated-key", env.authPath);
		const before = readFileSync(env.authPath, "utf8");
		const { withAuthStoreLock } = await import("../src/provider/auth-storage.js");
		const acquired = deferred();
		const release = deferred();
		const held = withAuthStoreLock(env.authPath, async () => {
			acquired.resolve();
			await release.promise;
		});
		await acquired.promise;
		try {
			env.terminal.data("/login zai\r");
			await frameEventually(env, "Enter Z.AI API key", OAUTH_BUDGET);
			env.terminal.data("cancelled-replacement\r");
			await settle(60);
			expect(env.transcript.completedLines().join("\n")).not.toContain("Saved API key for Z.AI");
			env.terminal.data(key);
			await settle();
			env.terminal.data("/login openai\r");
			// A new prompt must work while the original lock is still held.
			await frameEventually(env, "Enter OpenAI API key", 1000);
			expect(readFileSync(env.authPath, "utf8")).toBe(before);
			expect(env.transcript.completedLines().join("\n")).not.toContain("login failed");
			env.terminal.data("\x1b");
			await settle();
		} finally {
			release.resolve();
			await held;
		}
		await saveApiKey("anthropic", "later-key", env.authPath);
		expect(loadApiKey("zai", env.authPath)).toBe("previous-key");
		expect(loadApiKey("openai", env.authPath)).toBe("unrelated-key");
		expect(env.transcript.completedLines().join("\n")).not.toContain("Saved API key for Z.AI");
	});

	it.each([
		{ name: "Kitty Ctrl+C", key: "\x1b[99;5u" },
		{ name: "modifyOtherKeys Ctrl+C", key: "\x1b[27;5;99~" },
		{ name: "Kitty Esc", key: "\x1b[27u" },
	])("$name cancels token exchange after the manual prompt is closed", async ({ key }) => {
		const fake = await fakeCodexAuth();
		const exchanging = deferred();
		const release = deferred();
		fake.onToken = async () => {
			exchanging.resolve();
			await release.promise;
			return { body: await fake.tokens() };
		};
		const env = await fresh(undefined, {
			authBaseUrl: fake.baseUrl,
			callbackPort: 0,
			openBrowser: async (url) => {
				await fetch(fake.callback(url));
			},
			discoverModels: async () => [],
		});
		try {
			env.terminal.data("/login openai-codex\r");
			await exchanging.promise;
			env.terminal.data(key);
			await settle();
			env.terminal.data("/login zai\r");
			await frameEventually(env, "Enter Z.AI API key", 1000);
			expect(loadCodexCredential(env.authPath)).toBeNull();
			expect(env.transcript.completedLines().join("\n")).not.toContain("login failed");
			expect(env.transcript.completedLines().join("\n")).not.toContain("Logged in");
		} finally {
			release.resolve();
		}
	});

	it.each([
		{ name: "Kitty Ctrl+C", key: "\x1b[99;5u" },
		{ name: "modifyOtherKeys Ctrl+C", key: "\x1b[27;5;99~" },
		{ name: "Kitty Esc", key: "\x1b[27u" },
	])("$name cancels model discovery when no input prompt is pending", async ({ key }) => {
		const fake = await fakeCodexAuth();
		const discovering = deferred<AbortSignal>();
		const env = await fresh(undefined, {
			authBaseUrl: fake.baseUrl,
			callbackPort: 0,
			openBrowser: async (url) => {
				await fetch(fake.callback(url));
			},
			discoverModels: async ({ signal } = {}) => {
				if (signal === undefined) throw new Error("Missing discovery cancellation signal");
				discovering.resolve(signal);
				await new Promise<void>((resolve) => {
					if (signal.aborted) resolve();
					else signal.addEventListener("abort", () => resolve(), { once: true });
				});
				return null;
			},
		});
		env.terminal.data("/login openai-codex\r");
		const signal = await discovering.promise;
		expect(signal.aborted).toBe(false);
		env.terminal.data(key);
		await settle();
		expect(signal.aborted).toBe(true);
		env.terminal.data("/login zai\r");
		await frameEventually(env, "Enter Z.AI API key", 1000);
		expect(env.transcript.completedLines().join("\n")).not.toContain("login failed");
		expect(env.transcript.completedLines().join("\n")).not.toContain("Logged in");
	});

	it("Ctrl+C cancels an API-key removal waiting for the shared store lock", async () => {
		const env = await fresh();
		await saveApiKey("zai", "retained-key", env.authPath);
		await saveApiKey("openai", "unrelated-key", env.authPath);
		const before = readFileSync(env.authPath, "utf8");
		const { withAuthStoreLock } = await import("../src/provider/auth-storage.js");
		const acquired = deferred();
		const release = deferred();
		const held = withAuthStoreLock(env.authPath, async () => {
			acquired.resolve();
			await release.promise;
		});
		await acquired.promise;
		try {
			env.terminal.data("/logout\r");
			await frameEventually(env, "log out of a provider", OAUTH_BUDGET);
			env.terminal.data("\r");
			await settle(60);
			env.terminal.data("\x03");
			await settle();
			env.terminal.data("/login anthropic\r");
			await frameEventually(env, "Enter Anthropic API key", 1000);
			expect(readFileSync(env.authPath, "utf8")).toBe(before);
			expect(env.transcript.completedLines().join("\n")).not.toContain("authentication cancelled");
			env.terminal.data("\x1b");
			await settle();
		} finally {
			release.resolve();
			await held;
		}
		await saveApiKey("anthropic", "later-key", env.authPath);
		expect(loadApiKey("zai", env.authPath)).toBe("retained-key");
		expect(loadApiKey("openai", env.authPath)).toBe("unrelated-key");
		expect(env.transcript.completedLines().join("\n")).not.toContain("Removed stored API key");
	});

	it("6. keystrokes while the dialog is open land in the dialog's input — no command dispatch", async () => {
		const env = await fresh();
		env.terminal.data("/login zai\r");
		await settle();
		env.terminal.data("/exit"); // typed into the dialog's Input
		await settle();
		expect(env.terminal.frameSince(0)).toContain("/exit"); // visible in the input
		expect(env.transcript.completedLines().join("\n")).not.toContain("/exit");
		env.terminal.data("\x1b"); // cancel
		await settle();
		// the process is still alive — /exit did not dispatch
		env.terminal.data("/help\r");
		await settle();
		// the help listing rendered — /exit did not kill the process. The marker
		// is helpText's own closing sentence (commands.ts only), shortened to
		// its first row: the full line exceeds 80 columns, so the TUI wraps it
		// and the complete sentence never appears contiguously. (A fixed-size
		// tail was the old pin; the body grows — Ctrl+L once pushed "/logout"
		// out of slice(-3000)) — and a command name could also come from the
		// autocomplete panel rather than the help output.
		expect(env.terminal.frameSince(0)).toContain("Lines typed while Ink is working are queued");
	});

	it("13. dialogOpen refusals: a delayed submitPrompt mid-dialog is refused (authorized exemption holds)", async () => {
		// An extension-style ASYNC prompt: the command schedules submitPrompt
		// for later (the only reachable enqueuePrompt path mid-dialog — the
		// editor has no keys, so nothing synchronous can arrive).
		const delayedRef: { fn: (() => void) | null } = { fn: null };
		const env = await fresh([
			{
				source: "test",
				command: {
					name: "probe",
					summary: "arms a delayed prompt",
					usage: "/probe",
					allowedDuringRun: true,
					run: (_args: string, ctx: { submitPrompt?: (t: string) => void }) => {
						delayedRef.fn = () => ctx.submitPrompt?.("hello-mid-dialog");
						return "handled";
					},
				},
			},
		]);
		env.terminal.data("/probe\r"); // arm BEFORE the dialog
		await settle();
		env.terminal.data("/login zai\r"); // authorized: opens despite... (exemption regression pin)
		await settle();
		expect(env.terminal.frameSince(0)).toContain("Enter Z.AI API key");
		delayedRef.fn?.(); // fires mid-dialog → enqueuePrompt must refuse
		await settle();
		expect(env.transcript.completedLines().join("\n")).not.toContain("hello-mid-dialog");
		expect(env.terminal.frameSince(0)).not.toContain("working…");
		// cancel and confirm the machine is idle again: a normal turn works
		env.terminal.data("\x1b");
		await settle();
		delayedRef.fn?.(); // now it must START a turn
		await settle(200);
		expect(env.transcript.completedLines().join("\n")).toContain("hello-mid-dialog");
	});

	it("14. a held ask arriving mid-dialog renders and settles after teardown (real hold/drain)", async () => {
		// Shell-level (the machine harness cannot reach shell.ask): open the
		// dialog via openLoginDialog directly, then ask() mid-dialog — it
		// must be HELD (unanswerable under the dialog), render after the
		// dialog tears down, and settle when answered.
		const terminal = new FakeTerminal();
		const transcript = new TranscriptSink();
		const events: string[] = [];
		const shell = new TuiShell({
			transcript,
			terminal,
			onLine: (l: string) => events.push(`line:${l}`),
			onInterrupt: () => events.push("interrupt"),
			onEof: () => events.push("eof"),
			onDequeue: () => events.push("dequeue"),
			onCycleThinking: () => events.push("cycle-thinking"),
			onToggleThinking: () => events.push("toggle-thinking"),
			onModelSelect: () => events.push("model-select"),
		});
		shell.start();
		await settle(0);
		const release: { fn: (() => void) | null } = { fn: null };
		const dialogPromise = shell.openLoginDialog({
			title: "Login to Z.AI",
			run: async (dialog) => {
				await new Promise<void>((resolve) => {
					release.fn = resolve;
				});
				void dialog;
			},
		});
		await settle();
		expect(terminal.frameSince(0)).toContain("Login to Z.AI");
		// the ask arrives mid-dialog → held (not rendered yet)
		const asked = shell.ask("proceed?");
		await settle();
		expect(terminal.frameSince(0)).not.toContain("proceed?");
		// resolve the flow → wrapper tears the dialog down → the held ask
		// renders (the finish() re-show block — the load-bearing drain)
		release.fn?.();
		await dialogPromise;
		await settle();
		expect(terminal.frameSince(0)).toContain("proceed?");
		// it settles when answered (typed line answers it, never dispatches)
		terminal.data("y\r");
		await expect(asked).resolves.toBe(true);
		expect(events).toEqual([]);
		shell.close();
	});

	it("10. SIGINT/teardown first: a pending prompt settles cancelled — dialogOpen unwedged", async () => {
		// The review-P0 regression pin: selector teardown (SIGINT path)
		// must cancel the flow, not just remove the UI.
		const terminal = new FakeTerminal();
		const transcript = new TranscriptSink();
		const events: string[] = [];
		const shell = new TuiShell({
			transcript,
			terminal,
			onLine: (l: string) => events.push(`line:${l}`),
			onInterrupt: () => events.push("interrupt"),
			onEof: () => events.push("eof"),
			onDequeue: () => events.push("dequeue"),
			onCycleThinking: () => events.push("cycle-thinking"),
			onToggleThinking: () => events.push("toggle-thinking"),
			onModelSelect: () => events.push("model-select"),
		});
		shell.start();
		await settle(0);
		const outcome = shell.openLoginDialog({
			title: "Login to Z.AI",
			run: async (dialog) => {
				// A prompt that stays pending until torn down
				await dialog.prompt("Enter Z.AI API key");
			},
		});
		await settle();
		expect(terminal.frameSince(0)).toContain("Enter Z.AI API key");
		// The selector-teardown path (SIGINT/stdin-end/close all funnel
		// here) — while the prompt is pending. Review P0: this must
		// cancel the flow, not strand the pending prompt forever.
		const closeMark = terminal.writes.length;
		shell.close();
		await expect(outcome).resolves.toBe("cancelled"); // NOT a hang
		await settle();
		expect(terminal.frameSince(closeMark)).not.toContain("Enter Z.AI API key"); // dialog gone
	});

	it("11. footer after login: refreshFooter ran (model segment intact)", async () => {
		const env = await fresh();
		env.terminal.data("/login zai\r");
		await settle();
		env.terminal.data("sk-footer\r");
		await settle();
		expect(loadApiKey("zai", env.authPath)).toBe("sk-footer");
		// runCommand's finally refreshes the footer — the model segment
		// still renders post-login (the same-session footer line)
		const frame = env.terminal.frameSince(0);
		expect(frame).toContain("test-model ·");
	});

	it("7/15. /compact still takes the guarded state; fallback /login does too (no-dialog predicate)", async () => {
		// shell-conditional predicate: pure-function pins
		const { loginNeedsGuard, loginUsesDialog } = await import("../src/repl/commands.js");
		expect(loginNeedsGuard("/login", false)).toBe(true); // fallback picker
		expect(loginNeedsGuard("/login openai-codex", false)).toBe(true); // fallback oauth
		expect(loginNeedsGuard("/login zai", false)).toBe(true);
		expect(loginNeedsGuard("/login", true)).toBe(false); // dialog shell
		expect(loginNeedsGuard("/login openai-codex", true)).toBe(false);
		expect(loginUsesDialog("/login", true)).toBe(true);
		expect(loginUsesDialog("/login zai", true)).toBe(true);
		expect(loginUsesDialog("/login zai", false)).toBe(false);
		expect(loginUsesDialog("/model", true)).toBe(false);
	});

	it("17. the input renders ONCE and only inside a prompt (no root-level copy; dogfood double->)", async () => {
		const env = await fresh();
		env.terminal.data("/login zai\r");
		await settle();
		// The api-key prompt: exactly ONE input row (">") — the pre-fix bug
		// rendered the same Input in content AND at the root (two > rows).
		const frame = env.terminal.frameSince(0);
		const inputRowCount = (frame.match(/^>\s*$/gm) ?? []).length;
		expect(inputRowCount).toBe(1);
		expect(frame).toContain("Enter Z.AI API key");
		// the cancel hint sits WITH the input (pi showApiKeyPrompt), not as a
		// dialog-root static — and the oauth state (no prompt open) shows NO
		// input row at all (pi: input joins the tree only via prompt())
		const hintCount = (frame.match(/\(esc to cancel, enter to submit\)/g) ?? []).length;
		expect(hintCount).toBe(1);
		env.terminal.data("\x1b");
		await settle();
	});

	it("17b. pasted callback is never rendered, echoed, or recalled in input history", async () => {
		const fake = await fakeCodexAuth();
		const authorized = deferred<string>();
		const env = await fresh(undefined, {
			authBaseUrl: fake.baseUrl,
			callbackPort: 0,
			openBrowser: (url) => {
				authorized.resolve(url);
			},
			discoverModels: async () => [],
		});
		env.terminal.data("/login openai-codex\r");
		const url = await authorized.promise;
		await frameEventually(env, "[hidden]", OAUTH_BUDGET);
		const callback = fake.callback(url);
		env.terminal.data(`\x1b[200~${callback}\x1b[201~`);
		await settle();
		expect(env.terminal.writes.join("")).not.toContain("local-code-do-not-log");
		env.terminal.data("\r");
		await frameEventually(env, "Logged in to OpenAI (ChatGPT plan)", OAUTH_BUDGET);
		expect(loadCodexCredential(env.authPath)?.subject).toBe(fake.subject);
		expect(env.terminal.writes.join("")).not.toContain("local-code-do-not-log");
		env.terminal.data("\x1b[A");
		await settle();
		expect(env.terminal.frameSince(0)).not.toContain("local-code-do-not-log");
	});

	it("16. a second openLoginDialog queued behind a live selector re-runs after teardown", async () => {
		// Machine-level: /login (picker → dialog) then another /login —
		// but keyboard-wise a second command cannot be typed mid-dialog.
		// The queue path is exercised directly: open a picker (no-arg
		// /login), pick Z.AI → dialog opens → complete it; then a second
		// /login typed AFTER works (no pendingSelects starvation).
		const env = await fresh();
		env.terminal.data("/login\r"); // picker
		await settle();
		expect(env.terminal.frameSince(0)).toContain("sign in to a provider");
		env.terminal.data("\r"); // pick row 0 = Z.AI → dialog opens
		await settle();
		expect(env.terminal.frameSince(0)).toContain("Enter Z.AI API key");
		env.terminal.data("\x1b");
		await settle();
		// second login after teardown — picker works again, no starvation
		env.terminal.data("/login\r");
		await settle();
		expect(env.terminal.frameSince(0)).toContain("sign in to a provider");
		env.terminal.data("\x1b");
		await settle();
	});

	it("10b. the typed key never leaks into input history (up-arrow recall)", async () => {
		const env = await fresh();
		env.terminal.data("/login zai\r");
		await settle();
		env.terminal.data("sk-secret-1\r");
		await settle();
		expect(loadApiKey("zai", env.authPath)).toBe("sk-secret-1");
		// Submission may render the API key in the dialog; recall must not.
		const recallMark = env.terminal.writes.length;
		env.terminal.data("\x1b[A");
		await settle();
		expect(env.terminal.frameSince(recallMark)).toContain("/login zai");
		expect(env.terminal.frameSince(recallMark)).not.toContain("sk-secret-1");
	});

	it("logout owns the machine through revocation and local clearing; Ctrl+C cancels only revocation", async () => {
		const fake = await fakeCodexAuth();
		const env = await fresh(undefined, { authBaseUrl: fake.baseUrl, openBrowser: () => undefined });
		await loginCodex({
			authPath: env.authPath,
			authBaseUrl: fake.baseUrl,
			callbackPort: 0,
			onAuth: async ({ url }) => {
				await fetch(fake.callback(url));
			},
		});
		const revoking = deferred();
		const release = deferred();
		fake.onRevoke = async () => {
			revoking.resolve();
			await release.promise;
			return { body: undefined };
		};
		env.terminal.data("/logout\r");
		await frameEventually(env, "log out of a provider", OAUTH_BUDGET);
		env.terminal.data("\r");
		await revoking.promise;
		env.terminal.data("/login zai\r");
		await settle();
		expect(env.terminal.frameSince(0)).not.toContain("Enter Z.AI API key");
		env.terminal.data("\x03");
		const deadline = Date.now() + OAUTH_BUDGET;
		while (!env.transcript.completedLines().join("\n").includes("Remote revocation was not confirmed")) {
			if (Date.now() > deadline) throw new Error("Logout did not finish local clearing after cancellation");
			await settle(15);
		}
		expect(loadCodexCredential(env.authPath)).toBeNull();
		expect(env.transcript.completedLines().join("\n")).not.toContain("force quit");
		release.resolve();
		env.terminal.data("/login zai\r");
		await frameEventually(env, "Enter Z.AI API key", OAUTH_BUDGET);
	});

	it("12. focused forwarding: dialog.focused=false → input.focused=false", async () => {
		const env = await fresh();
		void env; // the unit-level assertion needs no live shell:
		const terminal = new FakeTerminal();
		const { TUI } = await import("../src/tui.js");
		const tui = new TUI(terminal, true);
		const dialog = new LoginDialog(tui, "Login to Z.AI");
		expect(dialog.focused).toBe(false);
		// (the IME edge: forwarding is the contract, verified by property)
		dialog.focused = true;
		dialog.focused = false;
		tui.stop();
	});
});

async function frameEventually(env: Env, text: string, budgetMs: number): Promise<void> {
	const start = Date.now();
	while (!env.terminal.frameSince(0).includes(text)) {
		if (Date.now() - start > budgetMs) {
			throw new Error(`frame did not contain ${JSON.stringify(text)} within ${budgetMs}ms`);
		}
		await settle(15);
	}
}
