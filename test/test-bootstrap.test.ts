import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { mkTempDir } from "./helpers/mktemp.js";

it("real Vitest bootstrap contains worker and Node+tsx fixtures and inherits the offline preload", async () => {
	const repo = path.resolve(import.meta.dirname, "..");
	const report = path.join(mkTempDir("ink-bootstrap-"), "report.json");
	const child = spawn(
		process.execPath,
		[
			path.join(repo, "node_modules/vitest/vitest.mjs"),
			"run",
			"--config",
			"test/fixtures/bootstrap-probe.config.ts",
			"test/fixtures/bootstrap-probe.case.ts",
		],
		{
			cwd: repo,
			env: { ...process.env, INK_BOOTSTRAP_REPORT: report },
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let stdout = "";
	let stderr = "";
	let closed = false;
	let code: number | null = null;
	child.stdout.on("data", (data: Buffer) => {
		stdout = (stdout + data.toString()).slice(-16 * 1024);
	});
	child.stderr.on("data", (data: Buffer) => {
		stderr = (stderr + data.toString()).slice(-16 * 1024);
	});
	child.once("error", (error) => {
		stderr += error.message;
	});
	const close = new Promise<void>((resolve) =>
		child.once("close", (value) => {
			closed = true;
			code = value;
			resolve();
		}),
	);
	async function waitClose(ms: number): Promise<boolean> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				close.then(() => true),
				new Promise<false>((resolve) => {
					timer = setTimeout(() => resolve(false), ms);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}
	function signal(signal: NodeJS.Signals): void {
		if (!child.pid) return;
		try {
			if (process.platform === "win32") {
				if (!closed) child.kill(signal);
			} else process.kill(-child.pid, signal);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	}
	try {
		expect(await waitClose(20_000), `bootstrap deadline: ${stderr}\n${stdout}`).toBe(true);
		expect(code, `${stderr}\n${stdout}`).toBe(0);
		expect(stdout).toContain("1 passed");
		const probe = JSON.parse(readFileSync(report, "utf8"));
		expect(probe.fixture.startsWith(`${probe.root}/`)).toBe(true);
		expect(probe.child.tmpdir).toBe(probe.root);
		// The settings sandbox cleans itself, not its siblings. Retained
		// diagnostics (and tsx's cache) must survive both coordinators.
		expect(stderr).toContain(`[test-run-root] retained ${probe.root}:`);
		expect(existsSync(probe.root)).toBe(true);
		expect(existsSync(probe.home)).toBe(false);
		expect(readFileSync(path.join(probe.root, "bootstrap-diagnostic"), "utf8")).toBe("retained evidence");
	} finally {
		// Own the nested runner's whole group, including on timeout/assertion
		// failure; never leave a Vitest worker alive after killing its parent.
		signal("SIGTERM");
		await waitClose(300);
		signal("SIGKILL");
		expect(await waitClose(1700), `bootstrap failed to close: ${stderr}`).toBe(true);
	}
}, 25_000);
