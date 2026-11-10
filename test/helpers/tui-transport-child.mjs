// Automated transport fixture only: no provider, user configuration, or clipboard calls.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, symlinkSync, writeSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [root, scenario] = process.argv.slice(2);
const require = createRequire(import.meta.url);
const dependency = path.dirname(require.resolve("@earendil-works/pi-tui/package.json", { paths: [root] }));
const state = { shift: false, calls: 0 };
globalThis[Symbol.for("ink.test.native-shift")] = state;
const report = (value) => writeSync(1, `\nINK_TUI_TEST_RESULT=${JSON.stringify(value)}\n`);
const load = (relative) => import(pathToFileURL(path.join(root, relative)).href);

if (scenario === "native-addon") {
	const { getNativePlatformHelper } = await import(pathToFileURL(path.join(dependency, "dist/native-platform.js")).href);
	const helper = getNativePlatformHelper();
	report({ modifier: typeof helper?.isModifierPressed, text: typeof helper?.getText, image: typeof helper?.getImage });
	process.exit(0);
}

// The Apple-terminal branch and physical Shift state are simulated; the parser,
// shell routing and (in PTY cases) raw-mode lifecycle are the real implementation.
if (process.platform !== "darwin") Object.defineProperty(process, "platform", { value: "darwin" });
registerHooks({
	load(url, context, next) {
		if (scenario === "missing-helper" || scenario === "throwing-helper") {
			if (url.endsWith("/pi-tui/dist/native-platform.js")) {
				return {
					format: "module", shortCircuit: true,
					source: `export function getNativePlatformHelper() {
						const s=globalThis[Symbol.for("ink.test.native-shift")];s.calls++;
						return ${scenario === "missing-helper" ? "undefined" : '{isModifierPressed(){throw new Error("fixture native failure")}}'};
					}
					export const getNativeClipboard=getNativePlatformHelper;`,
				};
			}
		} else if (url.endsWith("/pi-tui/dist/native-modifiers.js")) {
			return {
				format: "module", shortCircuit: true,
				source: `export function isNativeModifierPressed(key) {
					const s=globalThis[Symbol.for("ink.test.native-shift")];s.calls++;
					return key==="shift" && s.shift;
				}`,
			};
		}
		return next(url, context);
	},
});

const allocationsBeforeImport = readdirSync(tmpdir());
const { TUI } = await load("dist/tui.js");
const allocationsAfterImport = readdirSync(tmpdir());

if (scenario.startsWith("diagnostics")) {
	const writes = [];
	let stops = 0;
	const terminal = {
		columns: 8, rows: 20, kittyProtocolActive: false,
		start() {}, stop() { stops++; }, drainInput: async () => {}, write: (s) => writes.push(s),
		moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {},
		clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
	};
	const explicit = scenario.startsWith("diagnostics-explicit") ? path.join(tmpdir(), "explicit-logs") : undefined;
	if (explicit) mkdirSync(explicit, { mode: 0o700 });
	const oldMask = process.umask(0);
	const tui = new TUI(terminal, true, explicit);
	const afterFirst = readdirSync(tmpdir());
	const second = new TUI(terminal, true, explicit);
	const afterSecond = readdirSync(tmpdir());
	second.stop();
	const directory = explicit ?? path.join(tmpdir(), afterFirst.find((name) => name.startsWith("ink-renderer-logs-")));
	const guard = scenario.startsWith("diagnostics-guard-");
	if (scenario.endsWith("-redraw")) process.env.PI_TUI_DEBUG_REDRAW = "1";
	const snapshot = () => existsSync(directory)
		? Object.fromEntries(readdirSync(directory).map((name) => [name, readFileSync(path.join(directory, name), "utf8")]))
		: null;
	let mutated = false;
	let unsafeBefore;
	const mutate = () => {
		if (mutated) return;
		if (scenario.includes("-permissions")) chmodSync(directory, 0o755);
		else {
			renameSync(directory, `${directory}.retained`);
			if (scenario.includes("-replaced")) mkdirSync(directory, { mode: 0o700 });
			if (scenario.includes("-symlink")) {
				const target = path.join(tmpdir(), "fixture-link-target");
				mkdirSync(target, { mode: 0o755 });
				symlinkSync(target, directory, "dir");
			}
		}
		mutated = true;
		unsafeBefore = snapshot();
	};
	let value = "ok";
	let normalRenders = 0;
	let overlayRenders = 0;
	let mutateInRender = false;
	tui.addChild({ render() {
		normalRenders++;
		if (mutateInRender && scenario.includes("-normal")) mutate();
		return [value];
	}, invalidate() {} });
	tui.start();
	tui.renderNow();
	const stopsBeforeFailure = stops;
	value = guard ? "fixture private diagnostic text" : "fixture over width";
	if (guard) {
		if (scenario.includes("-normal") || scenario.includes("-overlay")) mutateInRender = true;
		else mutate();
		if (scenario.includes("-overlay")) tui.showOverlay({ render() {
			overlayRenders++;
			mutate();
			return ["overlay"];
		}, invalidate() {} }, { width: 8 });
	} else if (scenario === "diagnostics-explicit-recreated") {
		renameSync(explicit, `${explicit}.retained`);
	}
	let message = "";
	try { tui.renderNow(); } catch (error) { message = error.message; }
	const stopsOnFailure = stops - stopsBeforeFailure;
	if (!guard) tui.stop();
	const maskAfterFailure = process.umask();
	process.umask(oldMask);
	if (guard) {
		report({ message, mutated, normalRenders, overlayRenders, stopsOnFailure,
			unsafeBefore, unsafeAfter: snapshot(), originalExists: existsSync(directory),
			maskAfterFailure, output: writes.join("") });
	} else {
		const crash = /Debug log written to: ([^\n]+)/.exec(message)?.[1];
		if (!crash) throw new Error(`Missing controlled width failure: ${message}`);
		report({
			mode: tui.mode, hardwareCursor: tui.getShowHardwareCursor(),
			allocationsBeforeImport, allocationsAfterImport, afterFirst, afterSecond,
			crash, directoryMode: statSync(path.dirname(crash)).mode & 0o777,
			crashText: readFileSync(crash, "utf8"), output: writes.join(""),
		});
	}
	process.exit(0);
}

const { TuiShell } = await load("dist/repl/shell.js");
const { TranscriptSink } = await load("dist/repl/transcript.js");
const { askTrustViaTui } = await load("dist/repl/trust-ask.js");
const before = {
	input: process.stdin.listenerCount("data"), resize: process.stdout.listenerCount("resize"),
	exit: process.listenerCount("exit"), sigint: process.listenerCount("SIGINT"),
};
const events = [];
let interrupts = 0;
let eofs = 0;
const transcript = new TranscriptSink();
const makeShell = () => new TuiShell({
	transcript, onLine: (text, mode) => events.push({ text, mode: mode ?? "steer" }),
	onInterrupt: () => interrupts++, onEof: () => eofs++,
	onDequeue() {}, onCycleThinking() {}, onToggleThinking() {}, onModelSelect() {},
});
const inject = (text, shift = false) => {
	state.shift = shift;
	process.stdin.emit("data", text);
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
if (scenario.startsWith("non-apple")) process.env.TERM_PROGRAM = "vscode";
else process.env.TERM_PROGRAM = "Apple_Terminal";
let shell;
let handoff;
if (scenario === "handoff") {
	const question = askTrustViaTui({ transcript, cwd: root, resources: ["fixture resource"] });
	inject("1");
	const answer = await question;
	shell = makeShell();
	shell.start();
	inject("\x1b[?1;2c"); // Main-shell fallback must be enabled before its reset is asserted.
	await pause(80);
	handoff = { answer, paused: process.stdin.isPaused(), raw: process.stdin.isRaw === true };
	inject("success\r");
} else {
	shell = makeShell();
	shell.start();
}
const raw = process.stdin.isRaw === true;
if (scenario === "width-crash" || scenario === "directory-crash") {
	inject("\x1b[?1;2c");
	shell.setTitle("fixture title");
	const tui = shell.tui; // Fixture-only inspection of Ink's own shell, not parser mutation.
	let value = "ok";
	tui.addChild({ render: () => [value], invalidate() {} });
	tui.renderNow();
	await pause(40);
	report({ raw, directory: tui.logDirectory });
	if (scenario === "directory-crash") renameSync(tui.logDirectory, `${tui.logDirectory}.retained`);
	value = "x".repeat(tui.terminal.columns + 1);
	tui.renderNow(); // Deliberately uncaught: upstream/boundary stop must restore the terminal.
	throw new Error("Expected controlled rendering failure did not occur");
}
let draftBeforeSubmit;
if (["native-shift-cr", "native-shift-esc-cr", "native-shift-split-esc-cr", "command-shift-cr", "csi-shift-enter", "modify-shift-enter", "ctrl-j"].includes(scenario)) {
	inject("one");
	if (scenario === "native-shift-split-esc-cr") {
		inject("\x1b", true); inject("\r", true);
	} else {
		const key = scenario === "native-shift-esc-cr" ? "\x1b\r"
			: scenario === "csi-shift-enter" ? "\x1b[13;2u"
			: scenario === "modify-shift-enter" ? "\x1b[27;2;13~"
			: scenario === "ctrl-j" ? "\n" : "\r";
		inject(key, scenario.startsWith("native-") || scenario === "command-shift-cr");
	}
	inject("two");
	draftBeforeSubmit = shell.getText();
	inject("\r");
} else if (scenario === "plain-enter" || scenario === "non-apple-enter") {
	inject("one"); inject("\r", scenario === "non-apple-enter");
} else if (["alt-enter", "non-apple-alt-enter", "missing-helper", "throwing-helper"].includes(scenario)) {
	shell.setActive(true);
	inject("one"); inject("\x1b\r", scenario !== "alt-enter");
} else if (scenario === "paste") {
	inject("\x1b[200~one\ntwo\x03\x1b[201~", true);
} else if (scenario === "negotiation") {
	inject("\x1b]7501;?\x1b\\\x1b[?7u\x1b[?1;2c");
} else if (scenario === "escape") {
	shell.setActive(true);
	inject("\x1b");
	await pause(30);
	shell.setActive(false);
	inject("\x1b");
	await pause(30);
} else if (scenario === "releases") {
	inject("\x1b[99;5:3u\x1b[100;5:3u");
	inject("\x03\x04");
}
if (scenario.startsWith("direct-exit") || scenario === "graceful") {
	inject(scenario === "direct-exit-kitty" ? "\x1b[?7u" : "\x1b[?1;2c");
	shell.setTitle("fixture title");
	transcript.feed("FINAL FIXTURE FRAME\n");
	await pause(40);
}
const draft = shell.getText();
if (scenario.startsWith("direct-exit")) {
	report({ events, interrupts, eofs, nativeCalls: state.calls, draft, raw });
	process.exit(0); // Deliberately skips shell.close(): exercises upstream synchronous restoration.
}
let writeCount = 0;
const originalWrite = process.stdout.write;
process.stdout.write = function (...args) { writeCount++; return originalWrite.apply(this, args); };
shell.close();
await shell.whenSettled();
const stoppedCount = writeCount;
await pause(60);
process.stdout.write = originalWrite;
const after = {
	input: process.stdin.listenerCount("data"), resize: process.stdout.listenerCount("resize"),
	exit: process.listenerCount("exit"), sigint: process.listenerCount("SIGINT"),
};
report({
	events, interrupts, eofs, nativeCalls: state.calls, draft, draftBeforeSubmit, raw, handoff,
	before, after, lateWrites: writeCount - stoppedCount, pausedAfterStop: process.stdin.isPaused(),
	rawAfterStop: process.stdin.isRaw === true,
});
process.exit(0);
