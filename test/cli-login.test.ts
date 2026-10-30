import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import vm from "node:vm";
import ts from "typescript";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { promptCallbackUrl, runCliLogin, runCliLogout } from "../src/cli-login.js";
import { openLoginBrowser, visibleAuthorizationUrl } from "../src/login-ui.js";
import { loadApiKey, saveApiKey } from "../src/provider/auth-store.js";
import { loadCodexCredential } from "../src/provider/codex-auth.js";
import { deferred, FakeCodexOidc } from "./helpers/codex-auth-fake.js";
import { waitUntil } from "./helpers/fakes.js";
import { mkTempDir } from "./helpers/mktemp.js";

afterEach(() => vi.unstubAllEnvs());

async function fixture(tty = false) {
	const fake = new FakeCodexOidc();
	await fake.start();
	onTestFinished(() => fake.close());
	const authPath = path.join(mkTempDir("ink-login-cli-"), "auth.json");
	vi.stubEnv("INK_AUTH_PATH", authPath);
	const input = Object.assign(new PassThrough(), { isTTY: tty });
	const signals = new EventEmitter();
	let stdout = "";
	let stderr = "";
	return {
		fake,
		authPath,
		input,
		signals,
		stdout: () => stdout,
		stderr: () => stderr,
		options: {
			auth: { authPath, authBaseUrl: fake.baseUrl, callbackPort: 0 },
			input,
			signals,
			output: {
				write: (text: string) => {
					stdout += text;
				},
			},
			error: {
				write: (text: string) => {
					stderr += text;
				},
			},
		},
	};
}

describe("standalone ChatGPT login", () => {
	it("displays URL, accepts automatic callback, then suggests only the first server-listed model", async () => {
		const env = await fixture();
		const discover = vi.fn(async () => ["account-z", "account-a"]);
		const code = await runCliLogin({
			...env.options,
			discoverModels: discover,
			openBrowser: async (url) => {
				await fetch(env.fake.callback(url));
			},
		});
		expect(code).toBe(0);
		expect(env.stdout()).toContain(`${env.fake.baseUrl}/api/accounts/authorize`);
		expect(env.stdout()).toContain("ink -m openai-codex/account-z");
		expect(env.stdout()).not.toContain("ink -m openai-codex/account-a");
		expect(env.stdout()).not.toContain("local-code-do-not-log");
		expect(env.stderr()).toBe("");
		expect(loadCodexCredential(env.authPath)?.subject).toBe(env.fake.subject);
		expect(discover).toHaveBeenCalledWith({ force: true, signal: expect.any(AbortSignal) });
		expect(env.signals.listenerCount("SIGINT")).toBe(0);
	});

	it("TTY manual callback is hidden and succeeds even when the injected browser opener fails", async () => {
		const env = await fixture(true);
		const authorized = deferred<string>();
		const pending = runCliLogin({
			...env.options,
			discoverModels: async () => [],
			openBrowser: (url) => {
				authorized.resolve(url);
				throw new Error("browser unavailable");
			},
		});
		const url = await authorized.promise;
		await waitUntil(() => env.stdout().includes("Paste the complete callback URL"));
		env.input.write(`${env.fake.callback(url)}\n`);
		expect(await pending).toBe(0);
		expect(env.stdout()).not.toContain("local-code-do-not-log");
		expect(env.stdout()).toContain("No selectable models");
		expect(env.stderr()).toBe("");
		expect(env.input.listenerCount("data")).toBe(0);
		expect(env.signals.listenerCount("SIGINT")).toBe(0);
	});

	it("automatic callback cancels a partially typed manual URL and detaches readline", async () => {
		const env = await fixture(true);
		const authorized = deferred<string>();
		const pending = runCliLogin({
			...env.options,
			discoverModels: async () => ["account-model"],
			openBrowser: (url) => {
				authorized.resolve(url);
			},
		});
		const url = await authorized.promise;
		await waitUntil(() => env.stdout().includes("Paste the complete callback URL"));
		env.input.write("partial-callback-secret");
		await fetch(env.fake.callback(url));
		expect(await pending).toBe(0);
		expect(env.stdout()).not.toContain("partial-callback-secret");
		expect(env.input.listenerCount("data")).toBe(0);
		expect(env.input.listenerCount("keypress")).toBe(0);
		expect(env.signals.listenerCount("SIGINT")).toBe(0);
	});

	it.each(["SIGINT", "keypress", "EOF", "empty input"])(
		"%s cancels the scoped CLI login and releases resources",
		async (mode) => {
			const env = await fixture(true);
			const pending = runCliLogin({
				...env.options,
				openBrowser: () => undefined,
				discoverModels: async () => [],
			});
			await waitUntil(() => env.stdout().includes("Paste the complete callback URL"));
			if (mode === "SIGINT") env.signals.emit("SIGINT");
			else if (mode === "keypress") env.input.write("\x03");
			else if (mode === "empty input") env.input.write("\n");
			else env.input.end();
			expect(await pending).toBe(1);
			expect(loadCodexCredential(env.authPath)).toBeNull();
			expect(env.stdout()).not.toContain("Logged in.");
			expect(env.input.listenerCount("data")).toBe(0);
			expect(env.input.listenerCount("keypress")).toBe(0);
			expect(env.signals.listenerCount("SIGINT")).toBe(0);
		},
	);

	it.each([{ models: [] }, { models: null }])(
		"empty/offline models ($models) never produce a static recommendation",
		async ({ models }) => {
			const env = await fixture();
			expect(
				await runCliLogin({
					...env.options,
					openBrowser: async (url) => {
						await fetch(env.fake.callback(url));
					},
					discoverModels: async () => (models === null ? null : []),
				}),
			).toBe(0);
			expect(env.stdout()).toContain("/model");
			expect(env.stdout()).not.toContain("ink -m openai-codex/");
		},
	);

	it("does not discover models after authorization fails", async () => {
		const env = await fixture();
		env.fake.onToken = () => ({ status: 400, body: { error: "invalid_grant" } });
		const discover = vi.fn(async () => ["not-authorized"]);
		expect(
			await runCliLogin({
				...env.options,
				openBrowser: async (url) => {
					await fetch(env.fake.callback(url));
				},
				discoverModels: discover,
			}),
		).toBe(1);
		expect(discover).not.toHaveBeenCalled();
		expect(env.stdout()).not.toContain("Logged in.");
		expect(env.signals.listenerCount("SIGINT")).toBe(0);
	});
});

describe("standalone logout", () => {
	it.each([true, false])("awaits serialized clearing and reports remoteRevoked=%s", async (revoked) => {
		const env = await fixture();
		await saveApiKey("openai", "separate-api-key", env.authPath);
		await runCliLogin({
			...env.options,
			discoverModels: async () => [],
			openBrowser: async (url) => {
				await fetch(env.fake.callback(url));
			},
		});
		if (!revoked) env.fake.onRevoke = () => ({ status: 503, body: {} });
		await runCliLogout(env.options);
		expect(loadCodexCredential(env.authPath)).toBeNull();
		expect(loadApiKey("openai", env.authPath)).toBe("separate-api-key");
		expect(env.stdout()).toContain(
			revoked ? "Remote revocation confirmed" : "Remote revocation was not confirmed",
		);
		expect(env.fake.revoked).toHaveLength(revoked ? 1 : 2);
		expect(env.signals.listenerCount("SIGINT")).toBe(0);
	});

	it("SIGINT interrupts remote revocation but still awaits local clearing and detaches its listener", async () => {
		const env = await fixture();
		await runCliLogin({
			...env.options,
			discoverModels: async () => [],
			openBrowser: async (url) => {
				await fetch(env.fake.callback(url));
			},
		});
		const revoking = deferred();
		const release = deferred();
		env.fake.onRevoke = async () => {
			revoking.resolve();
			await release.promise;
			return { body: undefined };
		};
		const pending = runCliLogout(env.options);
		await revoking.promise;
		env.signals.emit("SIGINT");
		await pending;
		expect(loadCodexCredential(env.authPath)).toBeNull();
		expect(env.stdout()).toContain("Remote revocation was not confirmed");
		expect(env.signals.listenerCount("SIGINT")).toBe(0);
		release.resolve();
	});
});

describe("login UI safeguards", () => {
	it("sanitizes identity-token hints before display/open and ignores opener failures", async () => {
		const url = "https://auth.openai.com/authorize?state=public-state&id_token_hint=private-identity";
		expect(visibleAuthorizationUrl(url)).toBe("https://auth.openai.com/authorize?state=public-state");
		const opener = vi.fn(() => {
			throw new Error("no browser");
		});
		openLoginBrowser(url, opener);
		await Promise.resolve();
		await Promise.resolve();
		expect(opener).toHaveBeenCalledWith("https://auth.openai.com/authorize?state=public-state");
	});

	it("manual prompt restores raw mode and preserves pre-existing input/signal listeners", async () => {
		const input = Object.assign(new PassThrough(), {
			isRaw: false,
			setRawMode: vi.fn((raw: boolean) => {
				input.isRaw = raw;
			}),
		});
		const unrelated = () => undefined;
		input.on("data", unrelated);
		const controller = new AbortController();
		const pending = promptCallbackUrl(input, { write: () => undefined }, controller.signal, () =>
			controller.abort(),
		);
		expect(input.isRaw).toBe(true);
		controller.abort();
		expect(await pending).toBeNull();
		expect(input.isRaw).toBe(false);
		expect(input.listeners("data")).toEqual([unrelated]);
		expect(input.setRawMode.mock.calls).toEqual([[true], [false]]);
	});

	it("an already-ended terminal cancels a manual prompt instead of waiting forever", async () => {
		const input = new PassThrough();
		input.end();
		input.resume();
		await new Promise<void>((resolve) => input.once("end", resolve));
		const cancel = vi.fn();
		expect(
			await promptCallbackUrl(input, { write: () => undefined }, new AbortController().signal, cancel),
		).toBeNull();
		expect(cancel).toHaveBeenCalledOnce();
		expect(input.listenerCount("data")).toBe(0);
	});

	it("already-cancelled manual prompts attach no input listeners", async () => {
		const input = new PassThrough();
		const signal = AbortSignal.abort();
		const output = { write: vi.fn() };
		expect(await promptCallbackUrl(input, output, signal, () => undefined)).toBeNull();
		expect(input.listenerCount("data")).toBe(0);
		expect(output.write).not.toHaveBeenCalled();
	});

	it("CLI forwards configured and builtin modelSource without confusing it with credential availability", () => {
		const source = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
		const file = ts.createSourceFile("cli.ts", source, ts.ScriptTarget.Latest, true);
		const adapter = file.statements.find(
			(statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === "runnerOptions",
		);
		if (!adapter) throw new Error("Missing actual CLI runnerOptions adapter");
		const { outputText } = ts.transpileModule(adapter.getText(file), {
			compilerOptions: { target: ts.ScriptTarget.ES2022 },
		});
		for (const modelSource of ["builtin", "cli", "env", "global", "project"]) {
			const result = vm.runInNewContext(`${outputText}; runnerOptions(opts, [], {})`, {
				opts: { model: "openai-codex/deliberate", modelExplicit: false, modelSource },
				process: { cwd: () => "/isolated" },
			});
			expect(result.modelSource).toBe(modelSource);
		}
	});
});
