/** Exclusive, cancellable API-key/browser login UI. Callback URLs are hidden
 *  while typed and removed when submitted, cancelled, or superseded by HTTP. */
import { dim } from "../format.js";
import { visibleAuthorizationUrl } from "../login-ui.js";
import {
	type Component,
	Container,
	type Focusable,
	Input,
	matchesKey,
	Spacer,
	Text,
	type TUI,
} from "../tui.js";

export interface LoginPromptOptions {
	signal?: AbortSignal;
	/** Never render or echo callback URLs, including the authorization code. */
	sensitive?: boolean;
}

export interface LoginDialogView {
	prompt(message: string, placeholder?: string, options?: LoginPromptOptions): Promise<string>;
	auth(info: { url: string }): void;
	waiting(message: string): void;
	message(line: string): void;
	signal: AbortSignal;
}

export interface LoginDialogOptions {
	title: string;
	/** The shell owns teardown. Login cancelled is the silent-cancel channel. */
	run: (dialog: LoginDialogView) => Promise<void>;
}

class DialogBorder implements Component {
	invalidate(): void {}
	render(width: number): string[] {
		return [dim("─".repeat(Math.max(1, width)), true)];
	}
}

/** Input retains editing/paste behavior, but its render never reads the value. */
class HiddenInput extends Input {
	override render(width: number): string[] {
		return ["> [hidden]".slice(0, Math.max(0, width))];
	}
}

interface PendingPrompt {
	finish: (value?: string) => void;
}

export class LoginDialog extends Container implements Focusable, LoginDialogView {
	private readonly tui: TUI;
	private input: Input;
	private readonly content: Container;
	private readonly abort = new AbortController();
	private pendingPrompt: PendingPrompt | null = null;
	private inputFocused = false;
	get focused(): boolean {
		return this.inputFocused;
	}
	set focused(value: boolean) {
		this.inputFocused = value;
		this.input.focused = value;
	}

	constructor(tui: TUI, title: string) {
		super();
		this.tui = tui;
		this.addChild(new DialogBorder());
		this.addChild(new Text(title, 1, 0));
		this.content = new Container();
		this.addChild(this.content);
		this.input = this.makeInput();
		this.addChild(new DialogBorder());
	}

	private makeInput(sensitive = false): Input {
		const input = sensitive ? new HiddenInput() : new Input();
		input.focused = this.inputFocused;
		input.onSubmit = (value) => this.pendingPrompt?.finish(value);
		input.onEscape = () => this.cancel();
		return input;
	}

	get signal(): AbortSignal {
		return this.abort.signal;
	}

	cancel(): void {
		this.abort.abort();
		this.pendingPrompt?.finish();
	}

	teardownNow(): void {
		this.cancel();
	}

	prompt(message: string, placeholder?: string, options: LoginPromptOptions = {}): Promise<string> {
		if (this.signal.aborted || options.signal?.aborted) return Promise.reject(new Error("Login cancelled"));
		this.pendingPrompt?.finish();
		this.input = this.makeInput(options.sensitive);
		const start = this.content.children.length;
		this.content.addChild(new Spacer(1));
		this.content.addChild(new Text(message, 1, 0));
		if (placeholder !== undefined) this.content.addChild(new Text(dim(`e.g., ${placeholder}`, true), 1, 0));
		this.content.addChild(this.input);
		this.content.addChild(new Text(dim("(esc to cancel, enter to submit)", true), 1, 0));
		const result = new Promise<string>((resolve, reject) => {
			const abort = () => finish();
			const finish = (value?: string) => {
				if (this.pendingPrompt?.finish !== finish) return;
				this.pendingPrompt = null;
				options.signal?.removeEventListener("abort", abort);
				this.signal.removeEventListener("abort", abort);
				this.content.children.splice(start);
				if (value !== undefined) {
					this.content.addChild(new Text(options.sensitive ? "> Callback URL received" : `> ${value}`, 1, 0));
				}
				// Discard the Input's undo/paste/kill buffers, not just its value.
				this.input = this.makeInput();
				this.tui.requestRender();
				if (value === undefined) reject(new Error("Login cancelled"));
				else resolve(value);
			};
			this.pendingPrompt = { finish };
			options.signal?.addEventListener("abort", abort, { once: true });
			this.signal.addEventListener("abort", abort, { once: true });
		});
		this.tui.requestRender();
		return result;
	}

	auth(info: { url: string }): void {
		this.content.clear();
		this.content.addChild(new Spacer(1));
		const url = visibleAuthorizationUrl(info.url);
		this.content.addChild(new Text(`\x1b]8;;${url}\x07${url}\x1b]8;;\x07`, 1, 0));
		const platformHint = process.platform === "darwin" ? "Cmd+click to open" : "Ctrl+click to open";
		this.content.addChild(new Text(dim(`\x1b]8;;${url}\x07${platformHint}\x1b]8;;\x07`, true), 1, 0));
		this.tui.requestRender();
	}

	waiting(message: string): void {
		this.content.addChild(new Spacer(1));
		this.content.addChild(new Text(dim(message, true), 1, 0));
		this.tui.requestRender();
	}

	message(line: string): void {
		this.content.addChild(new Text(dim(line, true), 1, 0));
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "ctrl+c") || matchesKey(data, "escape")) {
			this.cancel();
			return;
		}
		if (this.pendingPrompt !== null) this.input.handleInput(data);
	}
}
