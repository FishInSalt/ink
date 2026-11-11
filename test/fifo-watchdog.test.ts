import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startFifoWatchdog } from "./helpers/fifo-watchdog.js";

describe("FIFO absolute and post-ownership watchdogs (no native processes)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
	});
	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
	});
	const create = (afterOwnershipMs = 1800) => {
		const expired = vi.fn();
		const watchdog = startFifoWatchdog({ deadline: 10_000, scenarioMs: 10_000, afterOwnershipMs }, expired);
		return { watchdog, expired };
	};

	it("does not spend the short fault budget waiting for ownership; arms once afterward", async () => {
		const { watchdog, expired } = create();
		await vi.advanceTimersByTimeAsync(2000); // Past the old pre-ownership 1800 ms assumption.
		expect(expired).not.toHaveBeenCalled();
		watchdog.armAfterOwnership();
		await vi.advanceTimersByTimeAsync(1000);
		watchdog.armAfterOwnership(); // Cannot restart or extend the short deadline.
		await vi.advanceTimersByTimeAsync(799);
		expect(expired).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(expired).toHaveBeenCalledExactlyOnceWith("ownership", 1800);
		expect(vi.getTimerCount()).toBe(0);
		watchdog.armAfterOwnership();
		watchdog.stop();
		await vi.advanceTimersByTimeAsync(20_000);
		expect(expired).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("keeps the original absolute cap when ownership never arrives", async () => {
		const { watchdog, expired } = create();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(expired).toHaveBeenCalledExactlyOnceWith("scenario", 10_000);
		watchdog.armAfterOwnership();
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([8200, 9000])("ownership at %s cannot delay or override the absolute cap", async (elapsed) => {
		const { watchdog, expired } = create();
		await vi.advanceTimersByTimeAsync(elapsed);
		watchdog.armAfterOwnership();
		await vi.advanceTimersByTimeAsync(10_000 - elapsed);
		expect(expired).toHaveBeenCalledExactlyOnceWith("scenario", 10_000);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("late construction uses the original absolute deadline, not a fresh duration", async () => {
		await vi.advanceTimersByTimeAsync(4000);
		const { expired } = create();
		await vi.advanceTimersByTimeAsync(6000);
		expect(expired).toHaveBeenCalledExactlyOnceWith("scenario", 10_000);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("an already elapsed deadline wins even if ownership arms before timer dispatch", async () => {
		vi.setSystemTime(10_001);
		const { watchdog, expired } = create();
		watchdog.armAfterOwnership();
		expect(expired).toHaveBeenCalledExactlyOnceWith("scenario", 10_000);
		await vi.advanceTimersByTimeAsync(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("stop seals both timers against late arming and callbacks", async () => {
		const { watchdog, expired } = create();
		watchdog.armAfterOwnership();
		watchdog.stop();
		watchdog.stop();
		watchdog.armAfterOwnership();
		await vi.advanceTimersByTimeAsync(20_000);
		expect(expired).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 10_001])(
		"rejects invalid duration %s before arming",
		(invalid) => {
			const expired = vi.fn();
			expect(() => startFifoWatchdog({ deadline: 10_000, scenarioMs: invalid }, expired)).toThrow(
				"Invalid FIFO watchdog budget",
			);
			expect(() =>
				startFifoWatchdog({ deadline: 10_000, scenarioMs: 10_000, afterOwnershipMs: invalid }, expired),
			).toThrow("Invalid FIFO watchdog budget");
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it("rejects an extended absolute deadline and a fault duration exceeding the hard budget", () => {
		expect(() => startFifoWatchdog({ deadline: 10_001, scenarioMs: 10_000 }, vi.fn())).toThrow();
		expect(() =>
			startFifoWatchdog({ deadline: 1000, scenarioMs: 1000, afterOwnershipMs: 1800 }, vi.fn()),
		).toThrow();
		expect(vi.getTimerCount()).toBe(0);
	});
});
