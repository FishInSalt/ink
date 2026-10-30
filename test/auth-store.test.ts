import { existsSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withAuthStoreLock } from "../src/provider/auth-storage.js";
import {
	authFilePath,
	clearApiKey,
	loadApiKey,
	resolveApiKey,
	saveApiKey,
	storedApiKeyFamilies,
} from "../src/provider/auth-store.js";
import { getCodexRegistrationKey, loadCodexCredential, logoutCodex } from "../src/provider/codex-auth.js";
import { authChild } from "./helpers/auth-process.js";
import { deferred } from "./helpers/codex-auth-fake.js";
import { mkTempDir } from "./helpers/mktemp.js";

let dir: string;
let file: string;
beforeEach(() => {
	dir = mkTempDir("ink-auth-");
	file = path.join(dir, "auth.json");
	vi.stubEnv("INK_AUTH_PATH", file);
});
afterEach(() => vi.unstubAllEnvs());

const registration = {
	type: "chatgpt-oauth",
	provider: "openai-codex",
	clientId: "issued-local-client",
	issuer: "https://auth.openai.com",
	subject: "local-user",
	idToken: "local-id-token",
	scopes: ["openid", "chatgpt.tokens.use.direct"],
};
const direct = () => ({
	...registration,
	accessToken: "local-access",
	refreshToken: "local-refresh",
	expiresAt: Date.now() + 3600_000,
});

describe("shared atomic authentication store", () => {
	it("asynchronously saves/loads/clears keys and keeps missing-key clearing idempotent", async () => {
		expect(loadApiKey("zai")).toBeNull();
		await clearApiKey("zai");
		expect(existsSync(file)).toBe(false);
		await saveApiKey("zai", "local-z-key");
		await saveApiKey("openai", "local-o-key");
		expect(storedApiKeyFamilies()).toEqual(["zai", "openai"]);
		await clearApiKey("zai");
		expect(loadApiKey("zai")).toBeNull();
		expect(loadApiKey("openai")).toBe("local-o-key");
		await clearApiKey("openai");
		await clearApiKey("openai");
		expect(storedApiKeyFamilies()).toEqual([]);
		expect(existsSync(file)).toBe(true);
	});

	it("writes owner-only atomic replacements, not partially visible JSON", async () => {
		await saveApiKey("zai", "before");
		const inode = statSync(file).ino;
		const operation = saveApiKey("zai", "after");
		for (let i = 0; i < 100; i++) expect(() => JSON.parse(readFileSync(file, "utf8"))).not.toThrow();
		await operation;
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(statSync(file).ino).not.toBe(inode);
		expect(readdirSync(dir)).toEqual(["auth.json"]);
	});

	it("stored keys take priority over environment keys and empty strings are absent", async () => {
		vi.stubEnv("ZAI_API_KEY", "env-local");
		expect(resolveApiKey("zai", "ZAI_API_KEY")).toEqual({
			key: "env-local",
			source: "env",
			envVar: "ZAI_API_KEY",
		});
		await saveApiKey("zai", "stored-local");
		expect(resolveApiKey("zai", "ZAI_API_KEY")).toEqual({ key: "stored-local", source: "stored" });
		await saveApiKey("zai", "");
		expect(loadApiKey("zai")).toBeNull();
		expect(storedApiKeyFamilies()).toEqual([]);
	});

	it.each(["{not-json", "null", "[]", '{"version":99}', '{"apiKeys":[]}'])(
		"corrupt snapshots supply no credentials and every writer refuses to erase them: %s",
		async (contents) => {
			writeFileSync(file, contents);
			expect(loadApiKey("zai")).toBeNull();
			expect(loadCodexCredential()).toBeNull();
			await expect(saveApiKey("zai", "local")).rejects.toThrow(/corrupt/);
			await expect(clearApiKey("zai")).rejects.toThrow(/corrupt/);
			await expect(logoutCodex()).rejects.toThrow(/corrupt/);
			expect(readFileSync(file, "utf8")).toBe(contents);
		},
	);

	it("preserves registration, host, unknown sections and unrelated API keys", async () => {
		const credential = direct();
		writeFileSync(
			file,
			JSON.stringify({
				version: 1,
				hostId: "stable-host",
				codexRevision: "generation",
				codex: credential,
				future: { retained: true },
				apiKeys: { openai: "o" },
			}),
		);
		const identity = getCodexRegistrationKey();
		await saveApiKey("zai", "z");
		await clearApiKey("openai");
		const stored = JSON.parse(readFileSync(file, "utf8"));
		expect(stored).toMatchObject({
			codex: credential,
			hostId: "stable-host",
			future: { retained: true },
			apiKeys: { zai: "z" },
		});
		expect(getCodexRegistrationKey()).toBe(identity);
	});

	it("does not accept or migrate flat credentials or old sectioned tokens", async () => {
		const legacy = {
			provider: "openai-codex",
			accessToken: "legacy",
			refreshToken: "legacy-r",
			accountId: "legacy-a",
			expiresAt: 9999999999999,
		};
		writeFileSync(file, JSON.stringify(legacy));
		expect(loadCodexCredential()).toBeNull();
		await saveApiKey("zai", "z");
		expect(JSON.parse(readFileSync(file, "utf8")).codex).toBeUndefined();
		writeFileSync(file, JSON.stringify({ version: 1, codex: legacy, apiKeys: { zai: "z" } }));
		expect(loadCodexCredential()).toBeNull();
		await saveApiKey("openai", "o");
		expect(loadApiKey("zai")).toBe("z");
		expect(JSON.parse(readFileSync(file, "utf8")).codex).toEqual(legacy);
	});

	it("never writes through a symlink with an independent lock identity", async () => {
		const target = path.join(dir, "other.json");
		writeFileSync(target, '{"apiKeys":{"zai":"original"}}');
		symlinkSync(target, file);
		await expect(saveApiKey("zai", "replacement")).rejects.toThrow(/symlink/);
		expect(JSON.parse(readFileSync(target, "utf8")).apiKeys.zai).toBe("original");
	});

	it("never proceeds unlocked when acquisition times out", async () => {
		const acquired = deferred();
		const finish = deferred();
		const held = withAuthStoreLock(file, async () => {
			acquired.resolve();
			await finish.promise;
		});
		await acquired.promise;
		try {
			await expect(
				withAuthStoreLock(
					file,
					async () => {
						throw new Error("Must not run");
					},
					{ timeoutMs: 30 },
				),
			).rejects.toThrow(/lock timed out/);
		} finally {
			finish.resolve();
			await held;
		}
	});

	it.each(["save", "clear"] as const)(
		"cancels a waiting API-key %s without writing after the shared lock is released",
		async (operation) => {
			await saveApiKey("zai", "before");
			await saveApiKey("openai", "unrelated-key");
			const before = readFileSync(file, "utf8");
			const acquired = deferred();
			const finish = deferred();
			const held = withAuthStoreLock(file, async () => {
				acquired.resolve();
				await finish.promise;
			});
			await acquired.promise;
			const controller = new AbortController();
			let settled = false;
			const attempt =
				operation === "save"
					? saveApiKey("zai", "after", file, { signal: controller.signal })
					: clearApiKey("zai", file, { signal: controller.signal });
			const result = attempt.then(
				() => {
					settled = true;
					return null;
				},
				(error: unknown) => {
					settled = true;
					return error;
				},
			);
			try {
				await new Promise((resolve) => setTimeout(resolve, 60));
				expect(settled).toBe(false);
				controller.abort();
				// Cancellation must settle while the other writer still holds the lock.
				expect(await result).toMatchObject({ message: expect.stringMatching(/cancelled/) });
				expect(readFileSync(file, "utf8")).toBe(before);
			} finally {
				finish.resolve();
				await held;
			}
			// A later writer proves the cancelled operation is no longer queued.
			await saveApiKey("anthropic", "later-key");
			expect(loadApiKey("zai")).toBe("before");
			expect(loadApiKey("openai")).toBe("unrelated-key");
			expect(loadApiKey("anthropic")).toBe("later-key");
			expect(readdirSync(dir)).toEqual(["auth.json"]);
		},
	);

	it.each(["save", "clear"] as const)(
		"rejects pre-aborted API-key %s before modifying the store",
		async (operation) => {
			await saveApiKey("zai", "before");
			const before = readFileSync(file, "utf8");
			const controller = new AbortController();
			controller.abort();
			const attempt =
				operation === "save"
					? saveApiKey("zai", "after", file, { signal: controller.signal })
					: clearApiKey("zai", file, { signal: controller.signal });
			await expect(attempt).rejects.toThrow(/cancelled/);
			expect(readFileSync(file, "utf8")).toBe(before);
		},
	);

	it.each(["before-write", "during-write"] as const)(
		"refuses a cancelled atomic commit %s, retains the file and releases the lock",
		async (timing) => {
			await saveApiKey("zai", "before");
			const before = readFileSync(file, "utf8");
			const controller = new AbortController();
			await withAuthStoreLock(file, async (locked) => {
				locked.store.apiKeys = { zai: "after" };
				if (timing === "before-write") controller.abort();
				const writing = locked.write({ signal: controller.signal });
				// write() has passed its first signal check and is awaiting temp-file creation.
				if (timing === "during-write") controller.abort();
				await expect(writing).rejects.toThrow(/cancelled/);
			});
			expect(readFileSync(file, "utf8")).toBe(before);
			expect(readdirSync(dir)).toEqual(["auth.json"]);
			await saveApiKey("openai", "later-key");
			expect(loadApiKey("zai")).toBe("before");
			expect(readdirSync(dir)).toEqual(["auth.json"]);
		},
	);

	it("serializes cross-process read/modify/write with API-key updates", async () => {
		await Promise.all(
			Array.from({ length: 4 }, () =>
				authChild(`
			import { withAuthStoreLock } from './src/provider/auth-storage.ts';
			for (let i = 0; i < 6; i++) await withAuthStoreLock(process.env.INK_AUTH_PATH, async (locked) => {
				const before = locked.store.fixtureCount ?? 0;
				await new Promise(resolve => setTimeout(resolve, 3));
				locked.store.fixtureCount = before + 1;
				await locked.write();
			});
		`),
			),
		);
		await Promise.all([
			authChild(
				`import { saveApiKey } from './src/provider/auth-store.ts'; await saveApiKey('zai', 'process-z');`,
			),
			authChild(
				`import { saveApiKey } from './src/provider/auth-store.ts'; await saveApiKey('openai', 'process-o');`,
			),
		]);
		expect(JSON.parse(readFileSync(file, "utf8")).fixtureCount).toBe(24);
		expect(loadApiKey("zai")).toBe("process-z");
		expect(loadApiKey("openai")).toBe("process-o");
		expect(readdirSync(dir)).toEqual(["auth.json"]);
	});

	it("honors explicit paths before the sandbox environment", () => {
		expect(authFilePath()).toBe(file);
		expect(authFilePath("/explicit.json")).toBe("/explicit.json");
	});
});
