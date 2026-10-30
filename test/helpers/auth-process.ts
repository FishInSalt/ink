import { spawn } from "node:child_process";

/** Run real processes against the same sandboxed auth path and network guard. */
export function authChild(source: string, args: string[] = []): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source, ...args], {
			cwd: process.cwd(),
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error("Auth fixture process timed out."));
		}, 10_000);
		child.stdout.resume();
		let stderr = "";
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			if (code === 0) resolve();
			else reject(new Error(`Auth fixture process exited ${code}: ${stderr}`));
		});
	});
}
