import { createServer, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { cancellationError } from "./auth-storage.js";

export interface AuthorizationResult {
	code: string;
	clientId: string;
}

function hasControlCharacters(value: string): boolean {
	return Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}

function parsedCallback(input: string, redirectUri: string): URL {
	try {
		if (input.length > 16_384) throw new Error("Too long");
		if (input.trim() !== input || /[\r\n\t]/.test(input)) throw new Error("Invalid callback characters");
		const url = new URL(input);
		const expected = new URL(redirectUri);
		if (
			url.origin !== expected.origin ||
			url.pathname !== expected.pathname ||
			url.username ||
			url.password ||
			url.hash ||
			input.includes("#") ||
			/\/\/[^/?#]*@/.test(input)
		)
			throw new Error("Wrong callback");
		return url;
	} catch {
		throw new Error(
			"Paste the complete ChatGPT callback URL with the exact local origin and path shown for this login.",
		);
	}
}

/** Validate state before interpreting even an OAuth error. Never include input in diagnostics. */
export function authorizationFromCallback(
	input: string,
	redirectUri: string,
	state: string,
	expectedClientId?: string,
): AuthorizationResult {
	const url = parsedCallback(input, redirectUri);
	for (const key of url.searchParams.keys()) {
		if (url.searchParams.getAll(key).length !== 1)
			throw new Error("ChatGPT callback contains duplicate parameters.");
	}
	if (url.searchParams.get("state") !== state)
		throw new Error("ChatGPT callback state did not match this login.");
	if (url.searchParams.has("error"))
		throw new Error("ChatGPT authorization was declined or failed. Run ink login to try again.");
	const code = url.searchParams.get("code");
	const returnedClientId = url.searchParams.get("client_id");
	// Returning sign-in may omit client_id; an explicitly empty value is still invalid.
	// First registration has no expected ID, so it must supply the issued ID here.
	const clientId = returnedClientId === null ? expectedClientId : returnedClientId;
	if (
		!code?.trim() ||
		hasControlCharacters(code) ||
		!clientId ||
		clientId === "dynamic_agent_client" ||
		clientId.length > 512 ||
		/\s/.test(clientId) ||
		hasControlCharacters(clientId)
	) {
		throw new Error("ChatGPT registration callback is missing a code or valid issued client ID.");
	}
	if (expectedClientId !== undefined && clientId !== expectedClientId) {
		throw new Error(
			"ChatGPT returned a different client ID. The saved registration cannot be used for a different account.",
		);
	}
	return { code, clientId };
}

export interface CallbackListener {
	redirectUri: string;
	result: Promise<AuthorizationResult>;
	close(): Promise<void>;
}

function send(response: ServerResponse, status: number, message: string): void {
	response.writeHead(status, {
		"content-type": "text/plain; charset=utf-8",
		"cache-control": "no-store",
		"referrer-policy": "no-referrer",
	});
	response.end(message);
}

export async function startCallbackListener(
	state: string,
	signal: AbortSignal,
	port = 1455,
	expectedClientId?: string,
): Promise<CallbackListener> {
	if (signal.aborted) throw cancellationError();
	if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("Invalid ChatGPT callback port.");
	let resolveResult!: (value: AuthorizationResult) => void;
	let rejectResult!: (error: Error) => void;
	const result = new Promise<AuthorizationResult>((resolve, reject) => {
		resolveResult = resolve;
		rejectResult = reject;
	});
	// The browser can arrive while the UI callback is still running.
	void result.catch(() => {});
	const sockets = new Set<Socket>();
	let redirectUri = "";
	const server: Server = createServer((request, response) => {
		let url: URL;
		try {
			url = new URL(request.url ?? "", redirectUri);
		} catch {
			send(response, 400, "Invalid callback.");
			return;
		}
		if (
			request.method !== "GET" ||
			url.origin !== new URL(redirectUri).origin ||
			url.pathname !== "/auth/callback"
		) {
			send(response, 404, "Callback not found.");
			return;
		}
		// Foreign requests, including error callbacks, cannot terminate the active login.
		if (url.searchParams.get("state") !== state) {
			send(response, 400, "This callback does not belong to the active login.");
			return;
		}
		try {
			const value = authorizationFromCallback(url.href, redirectUri, state, expectedClientId);
			send(response, 200, "ChatGPT authorization received. You may close this window.");
			resolveResult(value);
		} catch (error) {
			send(response, 400, "ChatGPT authorization callback was rejected.");
			rejectResult(error instanceof Error ? error : new Error("Invalid ChatGPT callback."));
		}
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	const abort = () => rejectResult(cancellationError());
	signal.addEventListener("abort", abort, { once: true });
	if (signal.aborted) abort();
	const close = async () => {
		signal.removeEventListener("abort", abort);
		const closed = new Promise<void>((resolve) => server.close(() => resolve()));
		server.closeAllConnections();
		for (const socket of sockets) socket.destroy();
		await closed;
	};
	const listen = (selected: number) =>
		new Promise<void>((resolve, reject) => {
			const error = (cause: Error) => {
				server.removeListener("listening", listening);
				reject(cause);
			};
			const listening = () => {
				server.removeListener("error", error);
				resolve();
			};
			server.once("error", error);
			server.once("listening", listening);
			server.listen(selected, "127.0.0.1");
		});
	try {
		try {
			await listen(port);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || port === 0) throw error;
			await listen(0);
		}
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("Missing callback address");
		redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
		server.on("error", () => rejectResult(new Error("ChatGPT callback listener failed.")));
		if (signal.aborted) throw cancellationError();
		return { redirectUri, result, close };
	} catch {
		await close();
		if (signal.aborted) throw cancellationError();
		throw new Error("Could not start the local ChatGPT callback listener.");
	}
}
