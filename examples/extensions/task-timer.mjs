// examples/extensions/task-timer.mjs — live per-run timer in the TUI footer.
//
// Install: copy into <project>/.ink/extensions/ (or ~/.ink/extensions/) and
// restart Ink. While a run is in flight the footer shows "running M:SS",
// ticking once a second; when the run settles the line becomes "done in M:SS"
// and stays until the next run starts. Footer display only; nothing is
// written to session files, and print mode / the legacy shell are unaffected
// (setStatus is a safe no-op there).
//
// Timing model: run_start (a top-level run begins) to run_end (it settles).
// Steering and queued follow-up messages extend the SAME run — the timer
// keeps ticking across them, matching pi's "round" semantics. A crashed run
// fires run_error instead: the timer stops and the footer shows
// "failed after M:SS".
//
// Known limitations (task-timer design §3.3/§4.5):
//   - After /new, /resume, /tree, or /fork, a stale "done in …" persists
//     until the next run (Ink has no session-lifecycle events yet).
//   - The tick interval is unref'd so a leaked tick can never hold the event
//     loop open (host kill, or a crash shape that never reached run_error).
//     ANY timer an extension creates should be unref'd for the same reason.

function formatDuration(ms) {
	const totalSeconds = Math.floor(ms / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	const pad = (n) => String(n).padStart(2, "0");
	if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
	return `${minutes}:${pad(seconds)}`;
}

const STATUS_KEY = "task-timer";

/** @param {import("../../src/extensions/types.js").ExtensionApi} api */
export default function (api) {
	let roundStart = null; // Date.now() of the in-flight run's start
	let tick = null; // the 1 Hz painter (unref'd — see the header)

	const stopTick = () => {
		if (tick !== null) {
			clearInterval(tick);
			tick = null;
		}
	};

	api.on("run_start", () => {
		// An already-open round means the previous run died without a settled
		// end — a crash shape run_error did not cover (e.g. a host kill, or a
		// throw between run_start and the loop) — discard it and start fresh.
		stopTick();
		roundStart = Date.now();
		const paint = () => {
			if (roundStart === null) return;
			api.setStatus(STATUS_KEY, `running ${formatDuration(Date.now() - roundStart)}`);
		};
		paint();
		tick = setInterval(paint, 1000);
		tick.unref?.(); // never let a leaked tick hold the event loop open
	});

	api.on("run_end", () => {
		stopTick();
		if (roundStart === null) return;
		api.setStatus(STATUS_KEY, `done in ${formatDuration(Date.now() - roundStart)}`);
		roundStart = null;
	});

	// #run-error: the crash-side pair — a run that died to a provider throw
	// never reaches run_end, so this is the only stop signal for it. Without
	// it the tick would keep painting "running …" forever.
	api.on("run_error", () => {
		stopTick();
		if (roundStart === null) return; // no open round — nothing to close
		api.setStatus(STATUS_KEY, `failed after ${formatDuration(Date.now() - roundStart)}`);
		roundStart = null;
	});
}
