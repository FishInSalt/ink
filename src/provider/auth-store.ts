import { homedir } from "node:os";
import path from "node:path";
import { readAuthStore, withAuthStoreLock } from "./auth-storage.js";

/** Families that take a plain API key via /login. Codex is OAuth-only. */
export type ApiKeyFamily = "anthropic" | "openai" | "zai" | "deepseek" | "moonshotai" | "moonshotai-cn";

/** Where a resolved key came from — /login's status rows and error hints. */
export interface ResolvedApiKey {
	key: string;
	source: "stored" | "env";
	envVar?: string;
}

export function authFilePath(authPath?: string): string {
	return authPath ?? process.env.INK_AUTH_PATH ?? path.join(homedir(), ".ink", "auth.json");
}

/** Read-only availability snapshot; malformed stores do not supply credentials. */
export function loadApiKey(family: ApiKeyFamily, authPath?: string): string | null {
	const key = readAuthStore(authFilePath(authPath)).apiKeys?.[family];
	return typeof key === "string" && key !== "" ? key : null;
}

export interface ApiKeyWriteOptions {
	signal?: AbortSignal;
}

/** Shared locked read/modify/atomic-write, cancellable until the atomic commit begins. */
export async function saveApiKey(
	family: ApiKeyFamily,
	key: string,
	authPath?: string,
	options: ApiKeyWriteOptions = {},
): Promise<void> {
	const { signal } = options;
	await withAuthStoreLock(
		authFilePath(authPath),
		async (locked) => {
			locked.store.apiKeys = { ...locked.store.apiKeys, [family]: key };
			await locked.write({ signal });
		},
		{ signal },
	);
}

export async function clearApiKey(
	family: ApiKeyFamily,
	authPath?: string,
	options: ApiKeyWriteOptions = {},
): Promise<void> {
	const { signal } = options;
	await withAuthStoreLock(
		authFilePath(authPath),
		async (locked) => {
			if (locked.store.apiKeys?.[family] === undefined) return;
			delete locked.store.apiKeys[family];
			if (Object.keys(locked.store.apiKeys).length === 0) delete locked.store.apiKeys;
			await locked.write({ signal });
		},
		{ signal },
	);
}

export function storedApiKeyFamilies(authPath?: string): ApiKeyFamily[] {
	const keys = readAuthStore(authFilePath(authPath)).apiKeys ?? {};
	return (Object.keys(keys) as ApiKeyFamily[]).filter(
		(family) => typeof keys[family] === "string" && keys[family] !== "",
	);
}

/** Stored credentials win over environment variables; no flat-Codex migration. */
export function resolveApiKey(
	family: ApiKeyFamily,
	envVar: string,
	authPath?: string,
): ResolvedApiKey | null {
	const stored = loadApiKey(family, authPath);
	if (stored !== null) return { key: stored, source: "stored" };
	const fromEnv = process.env[envVar];
	if (fromEnv !== undefined && fromEnv !== "") return { key: fromEnv, source: "env", envVar };
	return null;
}
