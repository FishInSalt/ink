# Run Error Event — `run_error` — Design

Branch `feat/run-error-event`. Feature batch, not a plan milestone.

Motivating consumer (ships in the same batch): the already-shipped
`examples/extensions/task-timer.mjs`. A user report observed that when the model
call fails mid-run (provider throw), the footer keeps showing `running M:SS`
and ticking, instead of stopping. Verification confirmed this is the documented
asymmetry of `task-timer-design.md` §3.3: `run_end` deliberately does not fire
on a crashed run, and the only extension-reachable signals are the five
normative events (`tool_call`, `tool_end`, `message_end`, `run_start`,
`run_end`), none error-shaped. This design closes that gap with a sixth
normative event, without touching the `run_end` contract.

---

## 1. Why the core must change (named-consumer argument)

M4's normative constraint — "the four-event set is normative; additions require
a named consumer (M5+)" (`m4-extensions-design.md` §17 risk 7, echoed at
`src/extensions/types.ts:245-246`) — applies. The named consumer is the shipped
task-timer extension, whose header already documents the exact gap this batch
closes ("Known limitations" item 1). No extension-side workaround exists: on
the crash path the extension's interval simply never gets cleared, because
nothing observable reaches it.

The observed symptom is precisely `task-timer-design.md` §5.3 ("Crash residue
in the consumer"), accepted then because the alternative was rewriting the
`run_end` contract. A dedicated event leaves that contract untouched.

## 2. Goals / non-goals

Goals:

1. A `run_error` extension event, fired exactly once per crashing top-level
   run, never alongside `run_end` for the same crash, never for subagent runs.
2. Payload: `message` (the crash message) only. `turns` is deliberately
   absent: the turn counter lives inside `runAgentLoop` as a local
   (`loop.ts:99,229`) — the runner has no live counter at the catch site, and
   no named consumer needs one (M4 §17 discipline: payload additions also
   need named consumers). Additive later without breaking the event.
3. `examples/extensions/task-timer.mjs` stops its interval and paints
   `failed after M:SS` on `run_error`; its header limitation list drops the
   first limitation (the `/new`, `/resume` residue limitation stays).
4. Tests for all of the above; the existing suite stays green.

Non-goals:

- Changing `run_end`'s crash semantics (rejected alternative, §5.1).
- Firing on aborts (§5.5).
- Subagent crashes (§3.3 — they never reach this emission site).
- Payload beyond `message` (YAGNI; additive later if a consumer names a need).
- Session-lifecycle events.

## 3. Current state (verified facts)

### 3.1 The crash path today

- `runner.ts:1500-1505`: `emitRunEnd` runs only after `runAgentLoop` returns.
  The catch at `runner.ts:1507-1509` logs `run_error` to the session log and
  rethrows; no extension event fires.
- `task-timer-design.md` §3.1 documents the same site and cites the explicit
  site comment ("a provider throw skips this emit entirely").
- `test/runner.test.ts:689-714` locks the asymmetry: "a provider crash emits
  run_start but no run_end". This test is AMENDED (not deleted): it gains a
  probe subscribing to `run_error` and asserts the emission too — a conscious
  contract change, recorded by the amendment.
- `types.ts:230-233`: the `RunStartEvent` doc block says consumers must
  tolerate an unpaired `run_start`; `task-timer.mjs`'s header lists the residue
  as limitation 1.

### 3.2 The emission site must be `runTurn`'s catch — not `runTurnInner`'s

`runTurn` (runner.ts:1280) → `runTurnOrRecoverFromOverflow` (runner.ts:1331) →
`runTurnInner` (runner.ts:1398). The failure surface is wider than
`runTurnInner`:

- `runTurnOrRecoverFromOverflow`'s recovery can fail at three sites inside its
  catch (compaction throw at runner.ts:1353, nothing-safe-to-compact at
  :1356, retry-overflow guidance at :1380-1388) — none re-enter `runTurnInner`'s
  catch.
- `runTurnInner`'s own catch (runner.ts:1507) rethrows into
  `runTurnOrRecoverFromOverflow`'s overflow filter.
- Emitting in `runTurnInner`'s catch would therefore miss overflow-recovery
  compaction crashes entirely.

`runTurn`'s entry-level emission of `run_start` already established the
"exactly once per run, before any retry layer" principle (task-timer design
§4.1). The crash-side mirror is the single `.catch` on
`runTurnOrRecoverFromOverflow`'s returned promise in `runTurn` — one site that
sees every crash shape exactly once.

### 3.3 Subagent crashes never surface here

`src/core/subagent.ts:414-464` catches child loop crashes (provider/protocol
error or overflow) and converts them to a settled `"crash"` outcome — the task
tool renders an error tool result. A child crash never propagates as a throw
through the parent's `runTurn`, so `run_error` stays top-level-only by
construction, symmetric with `run_start`/`run_end`. A second backstop holds
even if `runSubagent` itself threw: `runTool`'s never-reject invariant converts
any throw into an `isError` tool result inside the child loop.

### 3.4 The registry already generalizes

`KNOWN_EVENTS` (registry.ts:35-41) and `fireObservers` (registry.ts:613-623)
dispatch by name; an error event needs only registration, an emitter, and type
plumbing. Handler isolation (try/catch + promise catch + `reportHandlerError`)
covers sync throws and rejections in *handlers* — not throws on the emit path
itself (§6.1).

### 3.5 Crash shapes are bounded

A crash is a provider/protocol throw (`agent-loop.ts` API failures: auth,
rate-limit, network, malformed stream), an overflow-recovery failure (after its
one retry), or a compaction failure. All reach `runTurn`'s rejection handler
once. Aborts return `{stopReason: "aborted"}` instead of throwing (loop.ts:226)
and get `run_end`, not `run_error`. In-run compaction is never aborted into a
throw: both in-run `compactAndSplice` calls pass no signal (runner.ts:1349,
1467), so the "summarizer aborted" throw is unreachable on the run path.

## 4. Design

### 4.1 Event contract

```ts
/** `run_error` fires when a top-level run crashes — the provider (or the
 *  overflow-recovery/compaction path) threw, and the paired `run_end` will
 *  never arrive. Exactly one `run_error` per crashed run. Mutually exclusive
 *  with `run_end` for the same run: a run ends with either, never both.
 *  Subagent runs emit neither this nor `run_start`/`run_end`. */
export interface RunErrorEvent {
	type: "run_error";
	/** The crash message — the thrown error's `message` (or String of it),
	 *  first line, capped at 160 chars (`firstLine`'s default cap,
	 *  `format.ts:18`). */
	message: string;
}
```

Semantics (the short list a reviewer should attack):

1. **Exactly once per crashed run.** One crash shape, one site, one emit.
   Enforced by a try/catch around the emission body: a throwing coercion
   (e.g. a non-coercible thrown `Symbol`) must not swallow `run_error` AND
   replace the host's rejection with a `TypeError` (§6.1) — `throw err`
   runs unconditionally.
2. **Mutual exclusivity with `run_end`.** `runTurn` returns a result or
   rejects; the catch and the success-path emit are structurally exclusive.
3. **Top-level only.** By construction (§3.3).
4. **Not on abort.** An abort is an ended run; it keeps getting `run_end`.
5. **Timing class.** Synchronous handler invocation on the rejection path —
   the same timing class as `run_end`'s success emit (fire-and-forget, before
   the rejection reaches the host).
6. **`message` is first-line, capped.** A footer line is one line; the
   transcript already shows the full error. Multi-line messages collapse to
   their first line, capped at 160 chars.

### 4.2 Emission site (exact)

In `runTurn` (runner.ts:1280), change the final statement from

```ts
return this.runTurnOrRecoverFromOverflow(...).finally(() => health?.dispose());
```

to

```ts
return this.runTurnOrRecoverFromOverflow(...).then(
	(result) => result,
	(err) => {
		try {
			this.options.extensions?.emitRunError({
				type: "run_error",
				message: firstLine(errorText(err), 160),
			});
		} catch {
			// The emission must never mask the crash itself: a throwing
			// coercion (non-coercible Symbol) or emitter must not swallow
			// run_error AND replace the host's rejection with a TypeError
			// (design §4.1 item 1 / §6.1) — `throw err` below is unconditional.
		}
		throw err;
	},
).finally(() => health?.dispose());
```

with `errorText` defined beside the call (three lines, mirroring
`registry.ts:107-109` — it is module-private there, not exported) and
`firstLine` imported from `../format.js` (registry.ts:6's existing source).

Why not in `runTurnInner`'s catch: §3.2 — it would miss overflow-recovery
crash shapes. Why not a `finally`: it must not fire on success or abort.

### 4.3 Plumbing (four files, no more)

1. `src/extensions/types.ts`: `RunErrorEvent`; `on("run_error", ...)` overload;
   `ExtensionEventName += "run_error"`; `ExtensionEventHandlerMap` entry;
   `RunStartEvent`'s JSDoc gains one sentence pointing to `run_error` as the
   crash-side signal.
2. `src/extensions/registry.ts`: `KNOWN_EVENTS += "run_error"`; `emitRunError`
   beside its peers.
3. `src/runner.ts`: the emission (§4.2) + imports.
4. `examples/extensions/task-timer.mjs`: new handler + header update.

No loader changes (subscribe is name-generic). No shell/UI changes (status
channel already generic). No docs beyond the two pages that enumerate the
event set (§6 item 4).

### 4.4 The consumer (task-timer)

On `run_error`: `stopTick()`; if a round is open, paint `failed after M:SS`
and close the round (`roundStart = null`). A `run_error` without an open round
(should be impossible) is a no-op. The "already-open round means the previous
run crashed" logic in `run_start` stays — it now also covers host restarts
between crash and next run, where no `run_error` was observed by the new
process. The `/new`/`/resume` residue limitation stays (session-lifecycle
events remain a non-goal).

Header: drop the first "Known limitations" bullet (the crash residue) AND
reword the third bullet ("on the crash path nothing clears it" — false once
`run_error` clears the tick; the `unref` advice itself stays correct for
host-kill and early-throw shapes). Add a line to the Timing model note:
crash ⇒ `run_error` stops the timer and paints `failed after M:SS`.

The "already-open round" branch in `run_start` stays — its residual value is
the uncovered shapes (a sync preamble throw between `emitRunStart` and the
promise; a report-sink throw), not host restarts (a restarted process
re-instantiates the module with `roundStart === null`, so the branch cannot
fire there).

### 4.5 Docs

- `src/extensions/types.ts` JSDoc (§4.3 item 1).
- `docs/extensions.md` (and `docs/zh-CN/extensions.md`) event enumeration: add
  `run_error` beside `run_end`.
- `docs/extensions.md:83-85` / `docs/zh-CN/extensions.md:74-75` — the "run_end
  does NOT fire if the run crashes / tolerate an unpaired run_start"
  sentence gets the same `run_error` pointer `RunStartEvent`'s JSDoc gets
  (types.ts:230-233), so JSDoc and user docs stay aligned in the exact spot
  being edited.
- `examples/README.md` task-timer row: the description already says "live
  per-run timer"; no change needed. — verified: `examples/README.md:34` lists
  the file; description unchanged.
- `task-timer-design.md` gets a closing "superseded" note on §5.3 (one
  paragraph, appended under that heading — history stays, decision updated):
  the crash-residue acceptance is superseded by the `run_error` batch; the
  `run_end` contract itself is unchanged.

### 4.6 Tests

Runner tests (extend `test/runner.test.ts`, the `run_start` describe block):

1. Provider crash ⇒ `run_start`, then `run_error` (with `message` first-line
   capped), and still no `run_end`. Amends the existing
   "documented asymmetry" test (§3.1).
2. Overflow-recovery FAILURE: the first provider call throws a live
   `context_length_exceeded`, and the recovery summarizer call also throws ⇒
   exactly one `run_start`, one `run_error` whose `message` is the GUIDANCE
   text ("…compaction failed:…" / "still over the window…"), no `run_end`.
   Pinning the guidance message content is what distinguishes the outer
   emission site from the rejected inner-catch alternative (§5.6): an
   inner-catch emission would fire on the FIRST throw and carry the raw
   overflow message instead. (A pre-prompt-compaction throw alone does NOT
   lock this — its catch lives inside `runTurnInner`.)
3. Overflow-recovery SUCCESS ⇒ `run_end` and NO `run_error` — the one path
   where a naive inner-catch emission would double-fire. Extend the existing
   test (`runner.test.ts:534-571`, "overflow recovery: one run_start and one
   run_end") with a no-`run_error` assertion.
4. Abort ⇒ `run_start`, `run_end` with `stopReason: "aborted"`, and NO
   `run_error` — the negative case, guarding against a `finally`-style
   mistake.
5. Subagent provider crash ⇒ parent emits `run_start` + `run_end` only (the
   child crash becomes a tool result); NO parent `run_error`. Locks §3.3.
6. Ordering: `run_error` fires before the promise rejects to the host (probe
   records event sequence vs an outer `await expect(...).rejects`).
7. Emission isolation: a thrown non-coercible value (e.g. `Symbol()` via a
   provider whose `complete` does `throw Symbol()`) still rejects to the host
   with the ORIGINAL value and does not crash the process (§4.1 item 1).

Registry tests (extend `test/extensions-registry.test.ts`):

8. `subscribe("run_error", fn)` accepted (KNOWN_EVENTS grows); an unknown
   event name still rejected.
9. A throwing `run_error` handler is isolated (reported, not rethrown into
   the runner) — mirroring the `tool_end` isolation tests.
10. AMEND the existing KNOWN_EVENTS diagnostic pin (`extensions-registry.test.ts:281`,
   `'…known events: tool_call tool_end message_end run_start run_end'`) to
   include `run_error` — the same amendment treatment `runner.test.ts:689`
   gets (§2 goal 4's "existing suite stays green" is a contract-change
   amendment, not a silent pass).

Consumer tests (extend `test/extension-status.test.ts`):

11. `run_start` → advance fake timers → `run_error` ⇒ status is
   `failed after M:SS` (fake clock), interval cleared (no further paints), and
   a subsequent `run_start` resets cleanly.
12. `run_error` with no open round ⇒ no status change, no throw.

E2E (`test/cli-run-start.test.ts` already runs a crashed print-mode run):

13. Keep it as-is (it pins liveness: the unref'd interval doesn't block exit);
    assert additionally that the crashed run's output/status mentions the
    failure — or leave untouched if wiring a probe costs more than it pins
    (implementer's judgment; note the decision in the PR description).

### 4.7 Implementation checklist

1. `src/extensions/types.ts` — `RunErrorEvent`, `on` overload,
   `ExtensionEventName`, `ExtensionEventHandlerMap`, `RunStartEvent` JSDoc.
2. `src/extensions/registry.ts` — `KNOWN_EVENTS` += `"run_error"`;
   `emitRunError`.
3. `src/runner.ts` — the emission (§4.2) + the three-line `errorText` helper
   + the `firstLine` import.
4. `examples/extensions/task-timer.mjs` — handler + header.
5. Tests per §4.6; full suite + typecheck + lint.
6. Docs per §4.5.

## 5. Alternatives considered

1. **Synthesize `run_end` with `stopReason: "error"`.** Rejected — rewrites the
   documented `run_end` contract (`runner.ts` site comment, `types.ts` JSDoc)
   and perturbs every shipped observer (`notify.mjs` switches on `stopReason`)
   for one consumer. This was alternative 2 in the task-timer design's §6, and
   it stays rejected for the same reason.
2. **New stop reason "error" on `run_end` via finally-emit.** Rejected — same
   contract rewrite as 1, plus a `finally` would also fire on aborts unless
   guarded, duplicating `run_end`.
3. **Extension-side heuristics (watchdog timer: "no event for N seconds ⇒
   treat as crashed").** Rejected — false positives on long tool calls and
   long model turns with no in-flight events; complexity in every consumer,
   moved nowhere useful.
4. **`session_shutdown` cleanup.** Rejected — broader scope; solves residue
   across `/new`/`/resume` too, but needs its own consumer-driven design and
   the crash case is solved exactly by `run_error`.
5. **A `run_error` that also fires on aborts.** Rejected — an abort is an
   ended run (`run_end` fires); firing both would break mutual exclusivity
   (§4.1 item 2) and confuse consumers deciding between "done" and "failed".
6. **Fire `run_error` from `runTurnInner`'s catch.** Rejected — misses the
   overflow-recovery crash shapes (§3.2): compaction failures inside
   `runTurnOrRecoverFromOverflow` never pass through `runTurnInner`'s catch.

## 6. Risks & mitigations

1. **Emission on the rejection path delays crash reporting to the host.**
   Handlers are synchronous (registry emits never await), bounded by handler
   count; the same class as `run_start`/`run_end`. fireObservers isolation
   covers throwers.
1b. **A throwing coercion inside the emission swallows both halves of the
   contract.** `String(err)` throws for a non-coercible thrown value (e.g. a
   `Symbol`): without a guard, `run_error` never fires AND the host's
   rejection carries a `TypeError` instead of the crash. Mitigation: the
   emission body is wrapped in try/catch and `throw err` runs unconditionally
   (§4.1 item 1, §4.2). fireObservers isolation covers *handler* throws only —
   not the emit path itself; the guard is what closes that gap.
2. *test/runner.test.ts:689* **already locks "no run_end on crash" — this
   batch makes a documented contract change.** Mitigation: the test is
   amended, not deleted; the new assertion documents the new behavior; the
   design doc supersession note (§4.5) records the decision.
2b. *test/extensions-registry.test.ts:281* **pins the exact KNOWN_EVENTS
   diagnostic string — adding `run_error` changes it.** Mitigation: amend that
   pin alongside (§4.6 item 10) — same treatment as finding 2.
3. **A future observer treats `run_error` as fatal.** Out of scope; handler
   isolation bounds the damage; JSDoc says "crash message, not actionable
   state".
4. **The 160-char cap drops detail.** Intentional — the footer is one line;
   the transcript and session log carry the full error.
5. **`run_error` + `setStatus` interaction.** Non-issue by construction — the
   status channel is generic; task-timer's own handler paints the failure
   line.
6. **Docs drift.** Two docs pages enumerate events; both get the new row
   (§4.5). The zh-CN mirror must not be forgotten — including the "tolerate an
   unpaired run_start" sentence both carry.

## 7. Review focus for the adversarial reviewer

1. Mutual exclusivity argument (§4.1 item 2) — is the structural argument
   sound for every path through `runTurn`?
2. Emission site (§3.2/§4.2) — any crash shape that skips the outer catch?
3. Payload choice (§4.1) — is `message`-only right for v1, and is the
   absence of `turns` correctly argued?
4. Consumer behavior (§4.4) — "already-open round" handling sound?
5. Test list (§4.6) — does any test pin the wrong thing?
6. Scope discipline (§2) — does anything here leak toward the rejected
   alternatives (§5)?

## 8. Review record

- Rev1 (fresh-context adversarial review): verdict **NOT CLOSED** — 5 × P2,
  3 × N, 0 × P1. Architecture confirmed on all eight attack axes (mutual
  exclusivity across every `runTurn` path, the outer rejection handler as the
  single vantage over all five crash shapes, double subagent containment,
  abort ⇒ `run_end` only, consumer state machine, `run_end`/notify.mjs
  untouched). P2s: test item 2 tested the wrong site (inner-catch shapes, not
  recovery-path throws — re-specified to the overflow-then-summarizer-throw
  scenario with the guidance-message pin); missing recovery-success negative
  (added as item 3); `extensions-registry.test.ts:281` KNOWN_EVENTS diagnostic
  pin breaks unlisted (added §4.6 item 10, risk 2b); emission body not
  isolated against non-coercible throws (guard added to §4.1/§4.2, risk 1b,
  test item 7); task-timer header bullet 3 goes stale (rewording added to
  §4.4). Ns: §4.4's host-restart rationale confused (fixed — residual value is
  the uncovered shapes); docs "tolerate unpaired run_start" sentence gets the
  pointer too (§4.5); citation drift corrected throughout (types.ts:245-246
  for the normative set; runner.ts:1280/1331/1500-1509; loop.ts:226;
  subagent.ts:414-464; registry.ts:35-41; format.ts:18). All incorporated.
