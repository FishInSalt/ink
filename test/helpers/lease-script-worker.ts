/** Plain Node + tsx role worker for deterministic real lease interleavings. */
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { acquireChildLease, type ChildLeaseOptions } from "../../src/core/child-lease.js";

let barrierError: Error | undefined;
const barrierTimeoutMs = Number(process.argv[4] ?? "10000");
if (!Number.isSafeInteger(barrierTimeoutMs) || barrierTimeoutMs <= 0)
	throw new Error("invalid lease barrier timeout");

function sleepSync(ms: number): void {
	try {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
	} catch {
		const end = Date.now() + ms;
		while (Date.now() < end) {
			// busy-wait fallback
		}
	}
}

function waitMarkerSync(dir: string, name: string, timeoutMs = barrierTimeoutMs): void {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (existsSync(path.join(dir, name))) return;
		sleepSync(10);
	}
	barrierError = new Error(`lease role ${process.argv[3]} marker ${name} timeout (${timeoutMs}ms) in ${dir}`);
	throw barrierError;
}

function writeMarker(dir: string, name: string): void {
	writeFileSync(path.join(dir, name), "");
}

function runRole(): void {
	const [dir, role] = process.argv.slice(2);
	if (!dir || !role) throw new Error("lease script worker requires <dir> <role>");
	const child = path.join(dir, "child.jsonl");
	const results = path.join(dir, "results");

	const seams: ChildLeaseOptions = { maxAttempts: 1 };
	const log = (outcome: { ok: boolean; code?: string }, attemptId: string) =>
		appendFileSync(results, `R ${role} ${outcome.ok ? "ok" : (outcome.code ?? "refused")} ${attemptId}\n`);

	if (role === "a1") {
		seams.onAfterCreate = () => writeMarker(dir, "a-created");
		seams.onBeforeScan = () => {
			waitMarkerSync(dir, "b-done");
			waitMarkerSync(dir, "d-done");
		};
		const result = acquireChildLease(child, "a1-attempt", seams);
		log(result, "a1-attempt");
		if (result.ok) result.lease.release();
		return;
	}
	if (role === "d1") {
		// Joins after B's refusal cleanup, while A is paused pre-scan: must
		// still be refused because A's candidate is visible (review finding 1).
		const result = acquireChildLease(child, "d1-attempt", seams);
		log(result, "d1-attempt");
		writeMarker(dir, "d-done");
		if (result.ok) result.lease.release();
		return;
	}
	if (role === "b1") {
		const result = acquireChildLease(child, "b1-attempt", seams);
		log(result, "b1-attempt");
		writeMarker(dir, "b-done");
		if (result.ok) result.lease.release();
		return;
	}
	if (role === "a2") {
		// Started while B2 HOLDS (parent spawns it after b-done): the scan
		// must see B's live claim and refuse — no third-party window.
		const result = acquireChildLease(child, "a2-attempt", seams);
		log(result, "a2-attempt");
		writeMarker(dir, "a-done");
		if (result.ok) result.lease.release();
		return;
	}
	if (role === "b2") {
		const result = acquireChildLease(child, "b2-attempt", seams);
		log(result, "b2-attempt");
		writeMarker(dir, "b-done");
		if (result.ok) {
			try {
				waitMarkerSync(dir, "a-done");
			} finally {
				result.lease.release();
			}
		}
		return;
	}
	if (role === "a4") {
		// Paused AFTER staging, BEFORE publication (the owner's window):
		// block until the parent has aged the staging and B has run.
		seams.onBeforeCandidatePublish = () => {
			writeMarker(dir, "a4-staged");
			waitMarkerSync(dir, "a4-go");
		};
		seams.onBeforeScan = () => waitMarkerSync(dir, "b4-done");
		const result = acquireChildLease(child, "a4-attempt", seams);
		log(result, "a4-attempt");
		writeMarker(dir, "a4-held");
		try {
			waitMarkerSync(dir, "c4-done");
		} finally {
			if (result.ok) result.lease.release();
		}
		return;
	}
	if (role === "b4") {
		const result = acquireChildLease(child, "b4-attempt", seams);
		log(result, "b4-attempt");
		writeMarker(dir, "b4-done");
		if (result.ok) result.lease.release();
		return;
	}
	if (role === "c4") {
		const result = acquireChildLease(child, "c4-attempt", seams);
		log(result, "c4-attempt");
		writeMarker(dir, "c4-done");
		if (result.ok) result.lease.release();
		return;
	}
	if (role === "b3" || role === "c3") {
		seams.onAfterCreate = () => writeMarker(dir, `${role}-created`);
		seams.onBeforeScan = () => waitMarkerSync(dir, "go");
		const result = acquireChildLease(child, `${role}-attempt`, seams);
		log(result, `${role}-attempt`);
		writeMarker(dir, `${role}-done`);
		if (result.ok) {
			// Hold until the other role finished (bounded): if both
			// acquired, this bounded wait is what surfaces the violation
			// without hanging the test.
			try {
				waitMarkerSync(dir, role === "b3" ? "c3-done" : "b3-done", 5_000);
			} finally {
				result.lease.release();
			}
		}
		return;
	}
	throw new Error(`unknown lease script role: ${role}`);
}

runRole();
// Production can convert seam exceptions into refusal results. A failed
// rendezvous must still fail the role, never look like a valid refusal.
if (barrierError) throw barrierError;
