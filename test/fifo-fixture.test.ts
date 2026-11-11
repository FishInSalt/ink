import { existsSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertNoFifoBlockedNetwork,
	type FifoControl,
	type FifoOutcome,
	runFifoFixture,
} from "./helpers/fifo-fixture.js";
import { mkTempDir } from "./helpers/mktemp.js";

async function parentReadSentinel(): Promise<void> {
	const dir = mkTempDir("ink-parallel-");
	const file = path.join(dir, "parent-sentinel.txt");
	writeFileSync(file, "parent pool still reads\n");
	expect(await readFile(file, "utf8")).toBe("parent pool still reads\n");
}
function cleaned(outcome: FifoOutcome): void {
	if (!outcome.ok) console.info("FIFO failure containment:", JSON.stringify(outcome));
	expect(outcome.cleanup.conclusive, JSON.stringify(outcome)).toBe(true);
	expect(outcome.cleanup.directClosed).toBe(true);
	expect(outcome.cleanup.remaining).toEqual([]);
	// Zombies are dead, descriptor-free processes awaiting PID 1, not children
	// this supervisor claims to have reaped. Keep their external ps evidence.
	expect(outcome.cleanup.zombies.every((member) => member.stat.startsWith("Z"))).toBe(true);
	expect(existsSync(outcome.root)).toBe(false);
}
function owned(outcome: FifoOutcome, holderCount: number): void {
	expect(outcome.pgid).toBeGreaterThan(1);
	// tsx may also own an esbuild helper; audit it too, without mistaking it
	// for one of the explicitly reported and externally verified FIFO holders.
	expect(outcome.ownership.length).toBeGreaterThanOrEqual(holderCount + 1);
	expect(outcome.holderPids).toHaveLength(holderCount);
	expect(outcome.ownership.every((member) => member.pgid === outcome.pgid)).toBe(true);
	expect(outcome.ownership.some((member) => member.pid === outcome.pgid)).toBe(true);
	for (const holderPid of outcome.holderPids) {
		expect(outcome.ownership.some((member) => member.pid === holderPid && member.ppid === outcome.pgid)).toBe(
			true,
		);
	}
}

describe("isolated native FIFO fixture containment", () => {
	it("the finishing guard rejects synthetic blocked-network evidence despite an expected scenario failure", () => {
		const failure = "probe did not execute before EOF";
		const blockedNetwork = "Blocked nonlocal test network request (synthetic regression): example.invalid\n";
		// The hook uses this same pure guard after ordinary AND fallback cleanup.
		// No request is made, and the expected serial failure remains available
		// independently of the network evidence, even after its log is deleted.
		const outcome = { failure, blockedNetwork };
		expect(() => assertNoFifoBlockedNetwork(outcome)).toThrow(blockedNetwork.trim());
		expect(() => assertNoFifoBlockedNetwork(outcome)).toThrow(failure);
		expect(outcome).toEqual({ failure, blockedNetwork });
		expect(() => assertNoFifoBlockedNetwork({ failure, blockedNetwork: "" })).not.toThrow();
	});

	it.each(["overlap", "child"] as const)(
		"%s waits for a reader delayed beyond the former 300ms release",
		async (scenario) => {
			const outcome = await runFifoFixture(scenario, { control: "delayed-reader" });
			expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
			expect(outcome.report!.readerDelayMs).toBeGreaterThan(300);
			expect(outcome.report!.witness).toBe(true);
			expect(outcome.report!.executeSettled).toContain(scenario === "child" ? "k1" : "c1");
			expect(
				outcome.report!.holders.every((holder) => holder.ready && holder.closed && holder.code === 0),
			).toBe(true);
			expect(outcome.cleanup.code).toBe(0);
			expect(outcome.cleanup.signal).toBeNull();
			expect(outcome.cleanup.zombies).toEqual([]);
			owned(outcome, 1);
			cleaned(outcome);
			await parentReadSentinel();
		},
	);

	it("five native reads drain after abort on the default pool; two queued calls retain interrupted markers", async () => {
		const outcome = await runFifoFixture("abort");
		expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
		expect(outcome.report!.witness).toBe(true);
		expect(outcome.report!.executed).toEqual(["c1", "c2", "c3", "c4", "c5"]);
		expect([...outcome.report!.executeSettled].sort()).toEqual(outcome.report!.executed);
		expect(outcome.report!.results).toHaveLength(7);
		expect(outcome.report!.results.slice(5).map((result) => [result.id, result.content])).toEqual([
			["c6", "(interrupted before this tool ran)"],
			["c7", "(interrupted before this tool ran)"],
		]);
		expect(outcome.cleanup.zombies).toEqual([]);
		owned(outcome, 5);
		cleaned(outcome);
		await parentReadSentinel();
	});

	it.each([
		["owner-startup-loss", "startup"],
		["owner-before-open", "before-open"],
		["owner-paired-read", "paired-read"],
	] as const)("worker self-contains %s before supervisor cleanup can mask it", async (control, phase) => {
		const outcome = await runFifoFixture("child", { control });
		// Emergency termination is NOT successful execution of a read scenario.
		expect(outcome.ok).toBe(false);
		expect(outcome.failure, JSON.stringify(outcome)).toBe("owner-loss control: supervisor IPC disconnected");
		expect(outcome.report).toBeUndefined();
		expect(outcome.ownerLoss, JSON.stringify(outcome)).toMatchObject({
			phase,
			observed: true,
			directClosedBeforeCleanup: true,
			signalsBeforeObservation: 0,
			error: "",
		});
		expect(outcome.ownerLoss!.members.every((member) => member.stat.startsWith("Z"))).toBe(true);
		expect(outcome.cleanup.signal).toBe("SIGKILL");
		expect(outcome.cleanup.code).toBeNull();
		expect(outcome.cleanup.containmentSignals).toBe(0);
		if (phase === "startup") {
			expect(outcome.holderPids).toEqual([]);
		} else {
			owned(outcome, 1);
			if (phase === "paired-read") {
				expect(outcome.ownerLoss!.witness).toMatchObject({
					eofSent: false,
					executed: ["k1"],
					executeSettled: [],
				});
				expect(outcome.ownerLoss!.witness!.holders[0]).toMatchObject({ ready: true, closed: false });
			}
		}
		cleaned(outcome);
		await parentReadSentinel();
	});

	it("an actual serial child read fails the probe witness BEFORE any EOF release", async () => {
		const outcome = await runFifoFixture("child", { control: "serial" });
		expect(outcome.ok).toBe(false);
		expect(outcome.failure, JSON.stringify(outcome)).toBe("probe did not execute before EOF");
		expect(outcome.report!.holders[0]!.ready).toBe(true);
		expect(outcome.report!.witness).toBe(false);
		expect(outcome.report!.eofSent).toBe(false);
		expect(outcome.report!.executeSettled).toEqual([]);
		expect(outcome.report!.results).toEqual([]);
		owned(outcome, 1);
		cleaned(outcome);
		await parentReadSentinel();
	});

	it("a holder exiting without readiness fails and leaves no native read in the parent", async () => {
		const outcome = await runFifoFixture("child", { control: "holder-early-exit" });
		expect(outcome.ok).toBe(false);
		expect(outcome.failure, JSON.stringify(outcome)).toContain("holder");
		expect(outcome.report!.holders[0]!.ready).toBe(false);
		expect(outcome.report!.witness).toBe(false);
		cleaned(outcome);
		await parentReadSentinel();
	});

	it("worker exit after holder spawn but before ready audits and kills the still-live orphan group", async () => {
		const outcome = await runFifoFixture("child", { control: "orphan" });
		expect(outcome.ok).toBe(false);
		expect(outcome.failure).toBe("worker exited without verdict");
		expect(outcome.cleanup.code).toBe(23);
		expect(outcome.report).toBeUndefined();
		owned(outcome, 1);
		const holder = outcome.ownership.find((member) => member.pid === outcome.holderPids[0])!;
		expect(
			outcome.cleanup.before.some((member) => member.pid === holder.pid && !member.stat.startsWith("Z")),
		).toBe(true);
		cleaned(outcome);
		await parentReadSentinel();
	});

	it("the parent watchdog contains a worker with a holder blocked in open", async () => {
		const outcome = await runFifoFixture("child", { control: "watchdog", watchdogMs: 1800 });
		expect(outcome.ok).toBe(false);
		expect(outcome.failure).toBe("FIFO scenario watchdog expired (1800ms)");
		expect(outcome.cleanup.signal).toBe("SIGKILL");
		owned(outcome, 1);
		cleaned(outcome);
		await parentReadSentinel();
	});

	it.each([
		["spawn-error", "worker spawn/error:"],
		["malformed-ipc", "malformed worker IPC"],
		["early-exit", "worker exited without verdict"],
	] satisfies [FifoControl, string][])(
		"contains %s separately from FIFO readiness failure",
		async (control, failure) => {
			const outcome = await runFifoFixture("child", { control });
			expect(outcome.ok).toBe(false);
			expect(outcome.failure, JSON.stringify(outcome)).toContain(failure);
			expect(outcome.report).toBeUndefined();
			if (control === "spawn-error") expect(outcome.pgid).toBeUndefined();
			cleaned(outcome);
			await parentReadSentinel();
		},
	);
});
