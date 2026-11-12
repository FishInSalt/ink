import { describe, expect, it } from "vitest";
import { type LeaseProcess, withLeaseProcesses } from "./helpers/lease-process.js";
import { mkTempDir } from "./helpers/mktemp.js";

function assertClosed(worker: LeaseProcess | undefined): void {
	expect(worker?.closed).toBe(true);
	if (worker?.pid) expect(() => process.kill(worker.pid!, 0)).toThrow();
}

describe("lease parent process ownership", () => {
	it.each(["marker-timeout", "parent-deadline", "assertion-failure"])(
		"contains a no-ready role on %s, escalates, and awaits actual close",
		async (failure) => {
			const dir = mkTempDir("ink-lease-control-");
			let worker: LeaseProcess | undefined;
			const started = Date.now();
			const outcome = withLeaseProcesses(
				async ({ start, waitForMarker }) => {
					worker = start("test/fixtures/lease-control.ts", dir, "no-ready");
					await waitForMarker(dir, "started");
					if (failure === "assertion-failure") expect("actual").toBe("expected");
					await waitForMarker(dir, "ready", failure === "marker-timeout" ? 100 : 10_000);
				},
				failure === "parent-deadline" ? 3500 : 5000,
			);
			await expect(outcome).rejects.toThrow(
				failure === "marker-timeout"
					? "marker timeout"
					: failure === "parent-deadline"
						? "parent deadline"
						: "expected",
			);
			await expect(outcome).rejects.toThrow(
				/marker=.*workers=.*no-ready.*"closed":true.*"signal":"SIGKILL".*ignored SIGTERM/s,
			);
			assertClosed(worker);
			expect(worker?.stderr).toContain("no-ready role started");
			expect(worker?.stderr).toContain("ignored SIGTERM");
			expect(worker?.signal).toBe("SIGKILL");
			expect(Date.now() - started).toBeLessThan(8000);
		},
	);

	it.each(["marker", "unchecked-exit"])("unknown real role fails with diagnostics (%s)", async (mode) => {
		const dir = mkTempDir("ink-lease-control-");
		let worker: LeaseProcess | undefined;
		const outcome = withLeaseProcesses(async ({ start, waitForMarker }) => {
			worker = start("test/helpers/lease-script-worker.ts", dir, "unknown-role");
			if (mode === "marker") await waitForMarker(dir, "never-ready");
			// Otherwise deliberately omit wait(): the parent must still check exit.
		});
		await expect(outcome).rejects.toThrow("unknown-role");
		await expect(outcome).rejects.toThrow(mode === "marker" ? "never-ready" : "lease worker failed");
		assertClosed(worker);
		expect(worker?.code).toBe(1);
		expect(worker?.stderr).toContain("unknown lease script role: unknown-role");
	});

	it("a synchronous role barrier timeout cannot be swallowed as an ordinary lease refusal", async () => {
		const dir = mkTempDir("ink-lease-control-");
		let worker: LeaseProcess | undefined;
		await expect(
			withLeaseProcesses(async ({ start }) => {
				worker = start("test/helpers/lease-script-worker.ts", dir, "a1", "100");
				await worker.wait();
			}),
		).rejects.toThrow("marker b-done timeout");
		assertClosed(worker);
		expect(worker?.code).toBe(1);
	});
});
