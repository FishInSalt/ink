import type { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { PassThrough, type Readable, Writable } from "node:stream";
import { type BrowserOpener, logoutNotice, openLoginBrowser, visibleAuthorizationUrl } from "./login-ui.js";
import { type CodexLoginOptions, loginCodex, logoutCodex } from "./provider/codex-auth.js";
import { discoverCodexModels } from "./provider/discover.js";

interface Output {
	write(text: string): unknown;
}

export interface CliLoginOptions {
	/** Explicit embedding/test seams only; never supplied by environment variables. */
	auth?: Pick<CodexLoginOptions, "authPath" | "authBaseUrl" | "callbackPort">;
	openBrowser?: BrowserOpener;
	discoverModels?: typeof discoverCodexModels;
	input?: Readable & { isTTY?: boolean };
	output?: Output;
	error?: Output;
	signals?: Pick<EventEmitter, "on" | "off">;
}

/** One scoped readline, without terminal echo, history, or a competing REPL reader. */
export function promptCallbackUrl(
	input: Readable,
	output: Output,
	signal: AbortSignal,
	onCancel: () => void,
): Promise<string | null> {
	if (signal.aborted) return Promise.resolve(null);
	const muted = new Writable({ write: (_chunk, _encoding, done) => done() });
	// Node's keypress decoder leaves a data listener on its input after
	// readline.close(). Isolate it on a disposable stream, not process.stdin.
	const scoped = new PassThrough();
	const terminal = input as Readable & { isRaw?: boolean; setRawMode?: (raw: boolean) => unknown };
	const wasRaw = terminal.isRaw === true;
	terminal.setRawMode?.(true);
	const reader = createInterface({
		input: scoped,
		output: muted,
		terminal: true,
		historySize: 0,
		escapeCodeTimeout: 0,
	});
	return new Promise<string | null>((resolve) => {
		let settled = false;
		const finish = (value: string | null) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", abort);
			reader.removeListener("line", line);
			reader.removeListener("SIGINT", cancel);
			reader.removeListener("close", cancel);
			reader.close();
			input.unpipe(scoped);
			scoped.removeAllListeners();
			scoped.destroy();
			muted.end();
			terminal.setRawMode?.(wasRaw);
			input.pause();
			resolve(value);
		};
		const abort = () => finish(null);
		const cancel = () => {
			onCancel();
			finish(null);
		};
		const line = (value: string) => {
			if (value.trim() === "") cancel();
			else finish(value.trim());
		};
		reader.once("line", line);
		reader.once("SIGINT", cancel);
		reader.once("close", cancel);
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
		else if (input.readableEnded) cancel();
		else {
			// Raw/no-echo mode and listeners are ready before advertising paste.
			output.write(
				"Paste the complete callback URL here if the browser cannot connect (hidden; Ctrl+C cancels):\n",
			);
			input.pipe(scoped);
		}
	});
}

/** Browser opening is best-effort; URL display and callback login always remain usable. */
export async function runCliLogin(options: CliLoginOptions = {}): Promise<number> {
	const input = options.input ?? process.stdin;
	const output = options.output ?? process.stdout;
	const error = options.error ?? process.stderr;
	const signals = options.signals ?? process;
	const controller = new AbortController();
	const cancel = () => controller.abort();
	signals.on("SIGINT", cancel);
	try {
		await loginCodex({
			...options.auth,
			signal: controller.signal,
			onAuth: ({ url }) => {
				const visible = visibleAuthorizationUrl(url);
				output.write(
					`OpenAI (ChatGPT plan) login\n\nOpen this URL to sign in:\n${visible}\n\nWaiting for authentication (Ctrl+C cancels)…\n`,
				);
				openLoginBrowser(visible, options.openBrowser);
			},
			...(input.isTTY === true
				? {
						onManualCallback: ({ signal }: { signal: AbortSignal }) =>
							promptCallbackUrl(input, output, signal, cancel),
					}
				: {}),
		});
		output.write("Logged in. The credential is stored in the protected Ink authentication store.\n");
		const models = await (options.discoverModels ?? discoverCodexModels)({
			force: true,
			signal: controller.signal,
		}).catch(() => null);
		if (models?.[0] !== undefined) {
			output.write(`First account-listed model: ink -m openai-codex/${models[0]}\n`);
		} else if (models === null) {
			output.write("Account model list unavailable — use /model when connected; no model was selected.\n");
		} else {
			output.write("No selectable models were listed for this account — use /model to check again.\n");
		}
		return 0;
	} catch (err) {
		error.write(
			`ink: ${controller.signal.aborted ? "Login cancelled" : err instanceof Error ? err.message : String(err)}\n`,
		);
		return 1;
	} finally {
		signals.off("SIGINT", cancel);
	}
}

export async function runCliLogout(
	options: Pick<CliLoginOptions, "auth" | "output" | "signals"> = {},
): Promise<void> {
	const signals = options.signals ?? process;
	const controller = new AbortController();
	const cancel = () => controller.abort();
	signals.on("SIGINT", cancel);
	try {
		const result = await logoutCodex(options.auth?.authPath, {
			authBaseUrl: options.auth?.authBaseUrl,
			signal: controller.signal,
		});
		(options.output ?? process.stdout).write(`${logoutNotice(result.remoteRevoked)}\n`);
	} finally {
		signals.off("SIGINT", cancel);
	}
}
