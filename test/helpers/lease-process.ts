import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface LeaseProcess {
	role: string;
	pid: number | undefined;
	closed: boolean;
	code: number | null;
	signal: NodeJS.Signals | null;
	stderr: string;
	wait(): Promise<number>;
	stop(): Promise<void>;
}

/** No tsx CLI supervisor and no nested Vitest: NODE_OPTIONS preloads before tsx/source. */
function startLeaseProcess(file: string, args: string[]): LeaseProcess {
	const child = spawn(process.execPath, ["--import", loader, path.join(repoRoot, file), ...args], {
		cwd: repoRoot,
		env: { ...process.env, NO_COLOR: "1" },
		stdio: ["ignore", "ignore", "pipe"],
	});
	let spawnError = "";
	let close!: () => void;
	const closed = new Promise<void>((resolve) => {
		close = resolve;
	});
	const handle: LeaseProcess = {
		role: `${file} ${args.join(" ")}`,
		pid: child.pid,
		closed: false,
		code: null,
		signal: null,
		stderr: "",
		async wait() {
			await closed;
			if (spawnError || handle.code !== 0 || handle.signal !== null)
				throw new Error(`lease worker failed: ${JSON.stringify(handle)}; ${spawnError}`);
			return 0;
		},
		async stop() {
			if (handle.closed) return;
			child.kill("SIGTERM");
			if (await waitForClose(300)) return;
			child.kill("SIGKILL");
			if (!(await waitForClose(1700)))
				throw new Error(`lease worker did not close after SIGKILL: ${JSON.stringify(handle)}`);
		},
	};
	async function waitForClose(ms: number): Promise<boolean> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				closed.then(() => true),
				new Promise<false>((resolve) => {
					timer = setTimeout(() => resolve(false), ms);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}
	child.stderr.on("data", (chunk: Buffer) => {
		handle.stderr = (handle.stderr + chunk.toString("utf8")).slice(-16 * 1024);
	});
	child.once("error", (error) => {
		spawnError = error.message;
		handle.stderr += `\nspawn error: ${spawnError}`;
	});
	child.once("close", (code, signal) => {
		Object.assign(handle, { closed: true, code, signal });
		close();
	});
	return handle;
}

export interface LeaseProcesses {
	start(file: string, ...args: string[]): LeaseProcess;
	waitForMarker(dir: string, name: string, timeoutMs?: number): Promise<void>;
}

/** The parent owns the deadline AND all cleanup, including failed assertions. */
export async function withLeaseProcesses<T>(
	body: (processes: LeaseProcesses) => Promise<T>,
	deadlineMs = 25_000,
): Promise<T> {
	const workers: LeaseProcess[] = [];
	let closing = false;
	let marker = "none";
	const diagnostics = () => `marker=${marker}; workers=${JSON.stringify(workers)}`;
	const processes: LeaseProcesses = {
		start(file, ...args) {
			if (closing) throw new Error("lease parent already closing");
			const handle = startLeaseProcess(file, args);
			workers.push(handle);
			return handle;
		},
		async waitForMarker(dir, name, timeoutMs = 20_000) {
			marker = path.join(dir, name);
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				if (closing) throw new Error("lease parent closed while waiting");
				for (const worker of workers) {
					if (worker.closed && worker.code !== 0) throw new Error("lease worker exited before marker");
				}
				if (existsSync(path.join(dir, name))) return;
				await pause(10);
			}
			throw new Error(`lease marker timeout (${timeoutMs}ms)`);
		},
	};
	let timer: ReturnType<typeof setTimeout> | undefined;
	let result!: T;
	let failure: Error | undefined;
	try {
		result = await Promise.race([
			Promise.resolve().then(async () => {
				const value = await body(processes);
				// Even a caller that forgets wait() cannot accept an unchecked exit.
				await Promise.all(workers.map((worker) => worker.wait()));
				return value;
			}),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`lease parent deadline (${deadlineMs}ms)`)), deadlineMs);
			}),
		]);
	} catch (error) {
		failure = new Error(String(error), { cause: error });
	} finally {
		closing = true;
		clearTimeout(timer);
		const stopped = await Promise.allSettled(workers.map((worker) => worker.stop()));
		const failures = stopped.flatMap((result) =>
			result.status === "rejected" ? [String(result.reason)] : [],
		);
		if (failures.length > 0)
			failure = new Error(`lease cleanup failed: ${failures.join("; ")}; parent: ${String(failure)}`, {
				cause: failure,
			});
	}
	// Format after cleanup so timeout/assertion failures include final exit,
	// signal and stderr evidence, rather than a pre-termination snapshot.
	if (failure) throw new Error(`${failure.message}\n${diagnostics()}`, { cause: failure });
	return result;
}
