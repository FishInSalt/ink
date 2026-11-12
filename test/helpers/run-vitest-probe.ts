import { spawn } from "node:child_process";
import path from "node:path";

/** Bounded, noninteractive probe runner; owns the nested Vitest process group. */
export async function runVitestProbe(
	args: string[],
	env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
	const child = spawn(process.execPath, args, {
		cwd: path.resolve(import.meta.dirname, "../.."),
		env,
		detached: process.platform !== "win32",
		stdio: ["ignore", "pipe", "pipe"],
	});
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
	let failure: unknown;
	try {
		if (!(await waitClose(30_000))) throw new Error("probe parent deadline (30000ms)");
		if (code !== 0) throw new Error(`probe exited ${code}`);
	} catch (error) {
		failure = error;
	} finally {
		// Kill all owned descendants even if the direct runner closed first.
		signal("SIGTERM");
		await waitClose(300);
		signal("SIGKILL");
		if (!(await waitClose(1700))) failure = new Error(`probe did not close; parent: ${String(failure)}`);
	}
	if (failure)
		throw new Error(`${String(failure)}; args=${JSON.stringify(args)}; code=${code}\n${stderr}\n${stdout}`);
	return { stdout, stderr };
}
