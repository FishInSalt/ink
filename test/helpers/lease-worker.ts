/** Plain Node + tsx worker: real production identity and contended lease calls. */
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { acquireChildLease } from "../../src/core/child-lease.js";

const [dir, roundsRaw, tag] = process.argv.slice(2);
const steps = Number(roundsRaw);
if (!dir || !tag || !Number.isSafeInteger(steps) || steps <= 0)
	throw new Error("lease worker requires <dir> <positive rounds> <tag>");
const childFile = path.join(dir, "child.jsonl");
const logFile = path.join(dir, "log");
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
writeFileSync(path.join(dir, `${tag}-ready`), "");
const deadline = Date.now() + 10_000;
while (!existsSync(path.join(dir, "go"))) {
	if (Date.now() >= deadline) throw new Error(`lease role ${tag} marker go timeout in ${dir}`);
	await pause(10);
}
let acquired = 0;
let refused = 0;
for (let step = 0; step < steps; step += 1) {
	// maxAttempts: 1 exposes contention instead of absorbing refusals in retries.
	const result = acquireChildLease(childFile, `${tag}-${step}`, { maxAttempts: 1 });
	if (!result.ok) {
		refused += 1;
		await pause(2);
		continue;
	}
	try {
		appendFileSync(logFile, `S ${tag} ${step}\n`);
		await pause(2);
		appendFileSync(logFile, `E ${tag} ${step}\n`);
		acquired += 1;
	} finally {
		result.lease.release();
	}
	// Yield so both workers must make progress, not just one tight re-acquirer.
	await pause(2 + Math.floor(Math.random() * 4));
}
appendFileSync(logFile, `D ${tag} ${acquired} ${refused}\n`);
if (acquired === 0) throw new Error(`lease role ${tag} acquired no leases`);
