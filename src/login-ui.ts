import { spawn } from "node:child_process";

export type BrowserOpener = (url: string) => void | Promise<void>;

/** Authorization URLs are displayed and opened without an identity-token hint. */
export function visibleAuthorizationUrl(value: string): string {
	const url = new URL(value);
	url.searchParams.delete("id_token_hint");
	return url.href;
}

/** UI-only, no shell interpolation. A missing browser must never fail login. */
const openBrowser: BrowserOpener = (url) =>
	new Promise<void>((resolve) => {
		const command =
			process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
		const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
		const child = spawn(command, args, { stdio: "ignore", detached: true, windowsHide: true });
		child.once("error", () => resolve());
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	});

/** Do not await an opener: a browser process can outlive the authorization. */
export function openLoginBrowser(url: string, opener: BrowserOpener = openBrowser): void {
	void Promise.resolve()
		.then(() => opener(visibleAuthorizationUrl(url)))
		.catch(() => undefined);
}

export function logoutNotice(remoteRevoked: boolean): string {
	return remoteRevoked
		? "Logged out of OpenAI (ChatGPT plan). Remote revocation confirmed."
		: "Logged out of OpenAI (ChatGPT plan) locally. Remote revocation was not confirmed; you can revoke access in your ChatGPT settings.";
}
