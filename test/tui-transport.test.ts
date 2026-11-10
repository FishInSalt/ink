import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { StdinBuffer } from "../src/tui.js";
import { NETWORK_PRELOAD } from "./helpers/cli-fixture.js";
import { mkTempDir } from "./helpers/mktemp.js";

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const child = path.join(root, "test/helpers/tui-transport-child.mjs");
const pty = path.join(root, "test/helpers/tui-transport-pty.py");

async function probe(scenario: string, usePty = false) {
	const fixture = mkTempDir("ink-tui-transport-");
	for (const name of ["home", "tmp", "config", "cache", "data", "state"]) {
		mkdirSync(path.join(fixture, name));
	}
	const env: NodeJS.ProcessEnv = {
		PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
		HOME: path.join(fixture, "home"),
		TMPDIR: path.join(fixture, "tmp"),
		TMP: path.join(fixture, "tmp"),
		TEMP: path.join(fixture, "tmp"),
		XDG_CONFIG_HOME: path.join(fixture, "config"),
		XDG_CACHE_HOME: path.join(fixture, "cache"),
		XDG_DATA_HOME: path.join(fixture, "data"),
		XDG_STATE_HOME: path.join(fixture, "state"),
		TERM: "xterm-256color",
		TERM_PROGRAM: "Apple_Terminal",
		NODE_OPTIONS: `--require ${JSON.stringify(NETWORK_PRELOAD)}`,
		INK_TEST_NETWORK_LOG: process.env.INK_TEST_NETWORK_LOG,
	};
	const { stdout, stderr } = await run(
		usePty ? "/usr/bin/python3" : process.execPath,
		usePty ? [pty, process.execPath, child, root, scenario] : [child, root, scenario],
		{ cwd: fixture, env, timeout: 10_000, maxBuffer: 2 * 1024 * 1024 },
	);
	expect(stderr).toBe("");
	const transport = usePty ? JSON.parse(stdout) : undefined;
	const output = usePty ? Buffer.from(transport.outputBase64, "base64").toString() : stdout;
	const reports = [...output.matchAll(/INK_TUI_TEST_RESULT=([^\r\n]+)/g)];
	expect(reports).toHaveLength(1);
	const result: Record<string, any> = JSON.parse(reports[0]?.[1] ?? "null");
	if (usePty) {
		expect(transport.code).toBe(scenario === "width-crash" || scenario === "directory-crash" ? 1 : 0);
		expect(transport.rawRestored).toBe(true);
	}
	return { result, output, fixture };
}

const count = (output: string, sequence: string) => output.split(sequence).length - 1;

// Native Shift and the Apple-terminal platform branch are simulated in a fresh
// process; the actual ProcessTerminal/StdinBuffer/TuiShell path is not replaced.
describe("upgraded ProcessTerminal keyboard routing", () => {
	it.each([
		"native-shift-cr",
		"native-shift-esc-cr",
		"native-shift-split-esc-cr",
		"command-shift-cr",
		"csi-shift-enter",
		"modify-shift-enter",
		"ctrl-j",
	])("%s inserts one embedded newline without early submission", async (scenario) => {
		const { result, output } = await probe(scenario);
		expect(result.draftBeforeSubmit).toBe("one\ntwo");
		expect(result.events).toEqual([{ text: "one\ntwo", mode: "steer" }]);
		expect(result.nativeCalls).toBe(
			scenario.startsWith("native-") || scenario === "command-shift-cr" ? 2 : 1,
		);
		expect(result.interrupts).toBe(0);
		expect(output).not.toContain("\x1b_pi:");
	});

	it("plain Enter still submits normally", async () => {
		const { result } = await probe("plain-enter");
		expect(result.events).toEqual([{ text: "one", mode: "steer" }]);
		expect(result.nativeCalls).toBe(1);
	});

	it("ESC+Return without native Shift remains the follow-up binding", async () => {
		const { result } = await probe("alt-enter");
		expect(result.events).toEqual([{ text: "one", mode: "followUp" }]);
		expect(result.nativeCalls).toBe(1);
	});

	it.each(["non-apple-enter", "non-apple-alt-enter"])("%s never polls native Shift", async (scenario) => {
		const { result } = await probe(scenario);
		expect(result.events).toEqual([
			{ text: "one", mode: scenario.endsWith("alt-enter") ? "followUp" : "steer" },
		]);
		expect(result.nativeCalls).toBe(0);
	});

	it.each(["missing-helper", "throwing-helper"])(
		"%s degrades safely without mislabeling Alt+Enter",
		async (scenario) => {
			const { result } = await probe(scenario);
			expect(result.events).toEqual([{ text: "one", mode: "followUp" }]);
			expect(result.nativeCalls).toBeGreaterThan(0);
		},
	);

	it("a buffered Escape interrupts once while active and stays an editing key while idle", async () => {
		const { result } = await probe("escape");
		expect(result.interrupts).toBe(1);
		expect(result.eofs).toBe(0);
	});

	it("release events do not duplicate interrupt or EOF handling", async () => {
		const { result } = await probe("releases");
		expect(result.interrupts).toBe(1);
		expect(result.eofs).toBe(1);
	});

	it("bracketed paste preserves newlines without interpreting its Ctrl+C as an interrupt", async () => {
		const { result } = await probe("paste");
		expect(result.draft).toBe("one\ntwo");
		expect(result.events).toEqual([]);
		expect(result.interrupts).toBe(0);
		expect(result.nativeCalls).toBe(0);
	});

	it("complete status, Kitty and device replies never enter the editor", async () => {
		const { result } = await probe("negotiation");
		expect(result.draft).toBe("");
		expect(result.events).toEqual([]);
		expect(result.nativeCalls).toBe(0);
	});

	it.skipIf(process.platform !== "darwin")(
		"loads the packaged Darwin helper without calling the clipboard",
		async () => {
			const { result } = await probe("native-addon");
			expect(result).toEqual({ modifier: "function", text: "function", image: "function" });
		},
	);
});

describe("documented upstream response-buffer policy", () => {
	it("keeps a slow valid response whole instead of leaking its tail into text", () => {
		vi.useFakeTimers();
		const buffer = new StdinBuffer();
		const events: string[] = [];
		buffer.on("data", (data) => events.push(data));
		try {
			buffer.process("\x1b]11;rgb:ffff/");
			vi.advanceTimersByTime(5000);
			expect(events).toEqual([]);
			buffer.process("ffff/ffff\x07x");
			expect(events).toEqual(["\x1b]11;rgb:ffff/ffff/ffff\x07", "x"]);
		} finally {
			buffer.destroy();
			vi.useRealTimers();
		}
	});

	it("characterizes accepted raw-control suppression and arrow recovery for a truncated reply", () => {
		vi.useFakeTimers();
		const buffer = new StdinBuffer();
		const events: string[] = [];
		buffer.on("data", (data) => events.push(data));
		try {
			buffer.process("\x1b]7501;?");
			vi.advanceTimersByTime(5000);
			buffer.process("\x03\x04");
			expect(events).toEqual([]);
			expect(buffer.getBuffer()).toBe("\x1b]7501;?\x03\x04");
			buffer.process("\x1b[A\x03");
			expect(events).toEqual(["\x1b[A", "\x03"]);
			expect(buffer.getBuffer()).toBe("");
		} finally {
			buffer.destroy();
			vi.useRealTimers();
		}
	});
});

// Directory permission/symlink assertions below specify the POSIX privacy contract.
describe.skipIf(process.platform === "win32")("regular renderer diagnostics", () => {
	it("keeps default crash data in a lazy private process-local directory", async () => {
		const { result } = await probe("diagnostics-private");
		expect(result.mode).toBe("regular");
		expect(result.hardwareCursor).toBe(true);
		expect(result.allocationsAfterImport).toEqual(result.allocationsBeforeImport);
		expect(result.afterFirst).toHaveLength(result.allocationsAfterImport.length + 1);
		expect(result.afterSecond).toEqual(result.afterFirst);
		expect(result.directoryMode).toBe(0o700);
		expect(result.crashText).toContain("fixture over width");
		expect(result.crashText).toContain("Terminal width: 8");
	});

	it("preserves an explicitly supplied diagnostic directory", async () => {
		const { result } = await probe("diagnostics-explicit");
		expect(result.crash).toContain(`${path.sep}explicit-logs${path.sep}pi-tui-crash.log`);
		expect(result.directoryMode).toBe(0o700);
	});

	it("does not impose the default-directory guard on an explicit caller override", async () => {
		const { result } = await probe("diagnostics-explicit-recreated");
		expect(result.crash).toContain(`${path.sep}explicit-logs${path.sep}pi-tui-crash.log`);
		expect(result.directoryMode).toBe(0o777); // The fixture deliberately uses umask 000.
		expect(result.crashText).toContain("fixture over width");
	});

	for (const mutation of ["missing", "replaced", "symlink", "permissions", "normal", "overlay"]) {
		it.each(["", "-redraw"])(`${mutation}%s fails closed without new diagnostic content`, async (redraw) => {
			const { result } = await probe(`diagnostics-guard-${mutation}${redraw}`);
			expect(result.message).toBe("Private renderer diagnostic directory is missing or unsafe; restart Ink.");
			expect(result.message).not.toContain("fixture private diagnostic text");
			expect(result.mutated).toBe(true);
			expect(result.stopsOnFailure).toBe(1);
			expect(result.unsafeAfter).toEqual(result.unsafeBefore);
			expect(result.output).not.toContain("fixture private diagnostic text");
			expect(result.maskAfterFailure).toBe(0);
			if (["missing", "normal", "overlay"].includes(mutation)) {
				expect(result.originalExists).toBe(false);
				expect(result.unsafeAfter).toBeNull();
			}
			if (mutation === "normal" || mutation === "overlay") expect(result.normalRenders).toBe(2);
			if (mutation === "overlay") expect(result.overlayRenders).toBeGreaterThan(0);
		});
	}
});

describe.skipIf(process.platform === "win32")("real PTY terminal lifecycle", () => {
	it.each([
		"graceful",
		"direct-exit-kitty",
		"direct-exit-legacy",
		"handoff",
		"width-crash",
		"directory-crash",
	])("%s balances keyboard mode changes and restores raw mode", async (scenario) => {
		const { result, output } = await probe(scenario, true);
		expect(result.raw).toBe(true);
		const starts = scenario === "handoff" ? 2 : 1;
		expect(count(output, "\x1b[>7u")).toBe(starts);
		expect(count(output, "\x1b[<u")).toBe(starts);
		expect(count(output, "\x1b[?2004h")).toBe(starts);
		expect(count(output, "\x1b[?2004l")).toBe(starts);
		expect(output).not.toContain("\x1b[?1049h");
		expect(output).not.toContain("\x1b[?1003h");
		expect(output).not.toContain("\x1b_pi:");
		expect(output.lastIndexOf("\x1b[?25h")).toBeGreaterThan(output.lastIndexOf("\x1b[?25l"));
		expect(count(output, "\x1b]2;\x07")).toBe(starts);
		if (scenario === "width-crash" || scenario === "directory-crash") {
			expect(output).toContain("\x1b]2;fixture title\x07");
			expect(output).toContain(
				scenario === "width-crash"
					? "exceeds terminal width"
					: "Private renderer diagnostic directory is missing or unsafe",
			);
			if (scenario === "directory-crash") expect(existsSync(result.directory)).toBe(false);
		}
		if (scenario !== "direct-exit-kitty") {
			expect(count(output, "\x1b[>4;2m")).toBe(1);
			expect(count(output, "\x1b[>4;0m")).toBe(1);
		}
		if (scenario === "graceful" || scenario === "handoff") {
			expect(result.after).toEqual(result.before);
			expect(result.lateWrites).toBe(0);
			expect(result.rawAfterStop).toBe(false);
			expect(result.pausedAfterStop).toBe(true);
		}
		if (scenario === "graceful") expect(output).toContain("FINAL FIXTURE FRAME");
		if (scenario === "handoff") {
			expect(result.handoff).toEqual({ answer: "yes", paused: false, raw: true });
			expect(result.events).toEqual([{ text: "success", mode: "steer" }]);
		}
	});
});
