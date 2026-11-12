import { chmodSync, mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEMP_KEYS = ["TMPDIR", "TMP", "TEMP"] as const;

/** Owns only the directory entry, never any of its contents (including FIFOs). */
export function createTestRunRoot(
	options: { env?: NodeJS.ProcessEnv; parent?: string; report?: (message: string) => void } = {},
): { root: string; restoreEnvironment(): void; teardown(): void } {
	const env = options.env ?? process.env;
	const original = TEMP_KEYS.map((key) => [key, env[key]] as const);
	const report = options.report ?? console.warn;
	const root = mkdtempSync(join(options.parent ?? tmpdir(), "ink-test-run-"));
	const restoreEnvironment = () => {
		for (const [key, value] of original) {
			if (value === undefined) delete env[key];
			else env[key] = value;
		}
	};
	const teardown = () => {
		restoreEnvironment();
		try {
			// Never recursive: retained artifacts and inconclusive FIFO cleanup
			// must survive even when a worker or global setup fails.
			rmdirSync(root);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT")
				report(`[test-run-root] retained ${root}: ${String(error)}`);
		}
	};
	try {
		chmodSync(root, 0o700);
		for (const key of TEMP_KEYS) env[key] = root;
	} catch (error) {
		teardown();
		throw error;
	}
	return { root, restoreEnvironment, teardown };
}
