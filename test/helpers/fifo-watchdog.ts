/** Test-fixture deadlines only. No processes, I/O or application scheduling. */
export function startFifoWatchdog(
	options: { deadline: number; scenarioMs: number; afterOwnershipMs?: number },
	onExpire: (phase: "scenario" | "ownership", durationMs: number) => void,
): { armAfterOwnership: () => void; stop: () => void } {
	const { deadline, scenarioMs, afterOwnershipMs } = options;
	const duration = (value: number) => Number.isSafeInteger(value) && value > 0 && value <= 10_000;
	if (
		!duration(scenarioMs) ||
		!Number.isSafeInteger(deadline) ||
		deadline > Date.now() + scenarioMs ||
		(afterOwnershipMs !== undefined && (!duration(afterOwnershipMs) || afterOwnershipMs > scenarioMs))
	)
		throw new Error("Invalid FIFO watchdog budget");
	let sealed = false;
	let armed = false;
	let fault: ReturnType<typeof setTimeout> | undefined;
	const stop = () => {
		sealed = true;
		clearTimeout(hard);
		clearTimeout(fault);
	};
	const expire = (phase: "scenario" | "ownership", ms: number) => {
		if (sealed) return;
		stop();
		onExpire(phase, ms);
	};
	const hard = setTimeout(() => expire("scenario", scenarioMs), Math.max(0, deadline - Date.now()));
	return {
		stop,
		armAfterOwnership() {
			if (sealed || armed || afterOwnershipMs === undefined) return;
			if (Date.now() >= deadline) {
				expire("scenario", scenarioMs);
				return;
			}
			armed = true;
			fault = setTimeout(() => {
				// Prefer the absolute cap even if timer dispatch is delayed/reordered.
				if (Date.now() >= deadline) expire("scenario", scenarioMs);
				else expire("ownership", afterOwnershipMs);
			}, afterOwnershipMs);
		},
	};
}
