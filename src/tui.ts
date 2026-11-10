/**
 * The pi-tui boundary (M9 design: "thin boundary, not a thick adapter").
 *
 * Everything pi-tui reaches only through this module. Swapping back to a
 * different transport (or vendoring the library — the documented escape
 * hatch when we first need to modify its internals) means editing this
 * file alone.
 *
 * Also hosts the minimal editor theme: identity functions, no color —
 * parity with the pre-M9 plain aesthetic. Theming is a later milestone.
 */

import { lstatSync, mkdtempSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Terminal, TuiMainScreen, type TuiStopOptions } from "@earendil-works/pi-tui";

// pi-tui's autocomplete command shape (name/description/argumentHint).
// Aliased: Ink's own SlashCommand (commands.ts) is the dispatch shape —
// the alias keeps the two from blurring at this boundary.
export type { SlashCommand as AutocompleteSlashCommand } from "@earendil-works/pi-tui";
// Splits stdin bursts into per-key sequences (escape-aware) — the fake
// terminal reuses the production splitter so tests feed realistic chunks
// Core runtime — what the REPL shell composes with
// Test seam: production uses ProcessTerminal; tests inject a fake
// Autocomplete: the combined slash/@ provider the editor's panel runs on
// Autocomplete: item shapes the provider and the panel exchange
// Layout math for the width contract (pi-tui's own components use these;
// its renderer THROWS on component lines wider than the terminal)
export {
	type AutocompleteItem,
	type AutocompleteProvider,
	CombinedAutocompleteProvider,
	type Component,
	Container,
	Editor,
	type EditorOptions,
	type EditorTheme,
	type Focusable,
	Input,
	isKeyRelease,
	matchesKey,
	ProcessTerminal,
	SelectList,
	Spacer,
	StdinBuffer,
	sliceByColumn,
	type Terminal,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

interface PrivateLogDirectory {
	path: string;
	identity: Stats;
}

let privateLogDirectory: PrivateLogDirectory | undefined;

function defaultLogDirectory(): PrivateLogDirectory {
	if (privateLogDirectory === undefined) {
		const directory = mkdtempSync(path.join(tmpdir(), "ink-renderer-logs-"));
		privateLogDirectory = { path: directory, identity: lstatSync(directory) };
	}
	return privateLogDirectory;
}

/** Preserve Ink's regular-screen constructor across pi-tui's renderer split.
 * Crash dumps contain rendered text, so keep the upstream default filename in
 * a private process-local directory rather than a shared temporary directory.
 * Creation is lazy: importing this module (including --help/--version) is inert.
 */
export class TUI extends TuiMainScreen {
	private readonly privateDirectory: PrivateLogDirectory | undefined;

	constructor(terminal: Terminal, showHardwareCursor?: boolean, logDirectory?: string) {
		const directory = logDirectory == null ? defaultLogDirectory() : undefined;
		super(terminal, showHardwareCursor, logDirectory ?? directory?.path);
		this.privateDirectory = directory;
	}

	private validateLogDirectory(): void {
		if (!this.privateDirectory) return;
		const { path: directory, identity } = this.privateDirectory;
		try {
			const current = lstatSync(directory);
			if (
				current.isDirectory() &&
				current.dev === identity.dev &&
				current.ino === identity.ino &&
				current.uid === identity.uid &&
				current.gid === identity.gid &&
				(typeof process.getuid !== "function" || (current.mode & 0o777) === 0o700)
			) {
				return;
			}
		} catch {
			// Missing or uninspectable paths are unsafe, not a logging fallback.
		}
		this.stop();
		throw new Error("Private renderer diagnostic directory is missing or unsafe; restart Ink.");
	}

	protected override doRender(): void {
		if (this.stopped) return;
		this.validateLogDirectory();
		super.doRender();
	}

	protected override applyLineResets(lines: string[]): string[] {
		const result = super.applyLineResets(lines);
		// This runs after normal AND overlay component callbacks, before the
		// upstream logger. External filesystem changes afterward are not atomic.
		this.validateLogDirectory();
		return result;
	}

	protected override afterTerminalStop(options: TuiStopOptions): void {
		super.afterTerminalStop(options);
		this.terminal.write("\x1b]2;\x07"); // OSC 2 preserves Ink's window-only title behavior.
	}

	protected override getExitRestorePrefix(): string {
		// pi-tui restores modes synchronously on direct process.exit(). Let the
		// same handler release our window title; a second stop() would pop the
		// Kitty protocol stack twice and could alter a parent terminal app.
		return `${super.getExitRestorePrefix()}\x1b]2;\x07`;
	}
}

/** pi-tui's input-listener contract (the type itself is not exported upstream). */
export type TuiInputListener = (data: string) => { consume?: boolean; data?: string } | undefined;

/** The pre-interception hook TUI runs before the focused component sees keys. */
export type AddInputListener = (listener: TuiInputListener) => () => void;

/** Which interactive presentation shell to use (M9). INK_REPL=legacy keeps
 *  the pre-M9 readline path available as the documented escape hatch. */
export type ShellKind = "tui" | "legacy";

export function resolveShell(): ShellKind {
	return process.env.INK_REPL === "legacy" ? "legacy" : "tui";
}

/**
 * The [y/N] contract, unchanged from the readline era: only an explicit
 * y/yes (case-insensitive) approves. Kept in one place for both shells.
 */
export function isYes(answer: string): boolean {
	return /^y(?:es)?$/i.test(answer.trim());
}
