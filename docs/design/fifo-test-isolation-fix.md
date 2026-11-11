# Isolate native FIFO concurrency fixtures

Status: approved for implementation after independent adversarial review.
Date: 2026-11-11
Baseline: `main@ebf4278`
Branch/worktree: `fix/fifo-test-isolation`, `.worktrees/ink-fifo-test-isolation`

## Evidence, contract and scope

Investigation reproduced the actual six-worker failure: the five-FIFO abort
case leaves four unpaired native opens occupying the worker's default libuv pool;
its loop returns after grace, but the following child test cannot open its FIFO.
The child probe still runs, so scheduling is concurrent. The child test also
independently races by killing its writer after a fixed 300 ms before reader
readiness. Investigation: `/tmp/ink-fifo-investigation.b5DkK5/RESULT.md`, with
application and independent native traces linked there.

Fix test fixture ownership/readiness, not production read semantics, scheduler,
concurrency limits, AbortSignal policy, grace duration, pricing or task behavior.
Do not change testTimeout=15000, enlarge UV_THREADPOOL_SIZE, skip cases or alter
assertions to accept a missing concurrency witness. No install/API/push/publish.
The earlier readiness-only draft was not approved: killing writers on readiness
failure can still strand native opens. This design uses OS process isolation
for every real FIFO case, including the earlier two-read overlap fixture.

## Proposed structure

1. Add test-only worker and supervisor helpers under test/helpers. The worker
   imports real runAgentLoop/runSubagent/createReadTool and scripted mock provider
   support, never Vitest. Launch installed Node plus the already installed tsx
   loader explicitly; no downloads/build-to-run indirection. A test-created FIFO
   holder script lives under its temporary fixture root, not shipped source.
2. The supervisor launches a fresh detached POSIX process group per scenario.
   The worker and its holders inherit that group (holders must not detach).
   Use bounded IPC for a structured result or failure; cap stdout/stderr capture.
   Worker env is allowlisted with isolated HOME/TMP/XDG/auth/settings/catalog,
   and the existing nonlocal network blocker. Only loopback mocks are allowed.
   Temp roots are outside the source package. Dependencies are read-only.
3. Use a parent watchdog below the existing 15-second test deadline, with a
   bounded cleanup reserve. IPC success is not test success until the worker
   exits normally, all holders have been observed closed, and real read promises
   are settled. On spawn error, failure verdict, malformed IPC, early exit or
   watchdog expiry, terminate only the owned process group with SIGKILL and
   await its closure before deleting FIFO paths. Do not depend on a timer or
   async fs inside the possibly blocked worker for containment. Also register
   parent-test cleanup in case the test body fails unexpectedly. Concrete budget:
   10000 ms scenario watchdog (including startup), then 2000 ms cleanup; bounded
   ps calls/polls are included in cleanup, leaving reserve within the original
   15000 ms test timeout. Fault tests may use shorter deadlines, never longer.
   Group auditing uses an external `ps -axo pid=,ppid=,pgid=,stat=` subprocess,
   filtered by the PGID captured from our own detached spawn, not worker IPC.
   Each ps call has a timeout capped by the remaining cleanup budget. Await
   direct-worker close AND no non-zombie entries in that group; poll boundedly
   after SIGKILL. Record zombie entries separately: these have no running code
   or open descriptors, but an orphan's ultimate reaping belongs to PID 1 and
   is NOT claimed as ours. A successful scenario requires normal holder close
   events as well as worker close, and an empty group audit. Failure cleanup
   permits only already-dead zombies and reports them explicitly. If the group
   cannot be audited, a live member remains, or direct-worker close is missing
   at the deadline, fail cleanup and retain paths plus diagnostics; never delete
   paths or claim cleanup on an inconclusive check. The helper owns its temp
   root directly (not mkTempDir's unconditional removal hook); its after-test
   fallback only repeats bounded ownership-aware cleanup, never unconditional
   deletion. Stop signaling once absence is established. No arbitrary PGID API.
4. Holders perform the blocking write-end open in separate OS processes. After
   open succeeds they send a buffered `ready\n` marker, then wait for a line
   command on stdin: either write the overlap payload and close, or close at
   EOF. No sleeps or PID guesses. Queued EOF commands are read only AFTER the
   actual open completes, so the writer cannot disappear before pairing.
5. Track actual tool execute promises as well as the loop promise. Record holder
   spawn/ready/close states and result order in the verdict. On a successful
   path require all real I/O and holder closes before reporting success. On any
   failure the supervisor's whole-group termination is the final containment
   boundary; never describe Promise.race, abort, unlink or writer-kill alone as
   physical cleanup. No worker_threads: they share the process-level pool.

## Preserve the three existing regression purposes

- Real read overlap: first read is a FIFO, second is a plain file. Wait for the
  FIFO writer's actual readiness and the second read's tool_settled event while
  the ordered tool_end prefix is still blocked. Then command payload+close.
  Assert real output strings in call order, completed loop and real I/O cleanup.
- Seven-read cancellation: five FIFO reads claim the five slots; c6/c7 remain
  queued. After five execute/admission witnesses, abort and enqueue EOF to all
  holders, NOT SIGKILL. The external writers remain available until their opens
  pair, even when reads are waiting in the four-thread pool. Await loop and true
  execute completion; preserve seven paired results, c6/c7 interrupted and c1–c5
  real results (not interrupted/abandon placeholders). Existing fake-tool tests
  and CLI grace e2e retain coverage of legitimately signal-ignoring tools.
- Child parity: real FIFO read plus safe probe in runSubagent. Wait for actual
  writer readiness AND probe execution before sending EOF. Capture the Boolean
  fact that the probe ran while the gate was open, not millisecond inequality.
  Assert completed child, real empty EOF and probe result in original order.

The worker uses bounded readiness waits shorter than the parent's watchdog.
It reports errors to its supervisor rather than pretending to drain unrecoverable
I/O. Parent cleanup covers delayed/no reader, premature holder exit, serial
execution negative controls and unexpected script errors without contaminating
Vitest's pool. Use existing temporary prefixes where possible; if a new prefix
is needed update the generated fixture inventory via its existing script.

## Validation before completion

- Retain pre-fix causal failure evidence. Add committed regression cases for a
  read delayed beyond the old 300ms, early-writer/no-ready failure, actual serial
  pool failure, timeout and spawn/early exit cleanup. These are bounded fixture
  control modes only, not production seams or changes to tool scheduling.
- A serial control must fail because the probe cannot run before EOF, not pass
  after cleanup releases it. The parent normal-file read sentinel must work
  after successful AND deliberately failed worker scenarios.
- Include an explicit worker-exits-after-holder-spawn-before-ready regression:
  worker close alone must NOT pass cleanup; audit/kill the still-live holder
  using the owned group and require no non-zombie members afterward. Confirm
  parent file I/O still works. Exercise missing-executable and malformed/early
  exit separately. Verify worker/holder IDs belong to the launched group and no
  live child remains after cleanup; record zombies without claiming reaping.
  IPC must not permit untrusted arbitrary PID/group selection.
  Preserve failed evidence, no uncontrolled sleep or blocked fs request left in
  the parent; do not claim signal(0) alone proves every descendant reaped.
- Run all loop-concurrency tests, new fixture tests, repeated six-worker causal
  subset and full parallel suite with original test deadlines and default pool.
  Source/test typecheck, lint, build, docs/fixture-inventory and diff checks.
  All test/cache/temp paths must be isolated; never npm ci with shared symlinks.
- Update the readonly-parallel design with an explicit superseding fixture note.
  No public CLI behavior changes, so no new user-facing feature documentation
  is required. Do not claim production special-file I/O has been repaired.
- Obtain independent implementation review; close findings, commit on the
  dedicated branch, merge locally with --no-ff, and repeat integrated gates.

## Review record

Round 1: independent reviewer required a concrete whole-group termination
predicate, bounded budgets and early-worker-exit regression (R1). Revised above:
external ps audit, direct close plus no live members, explicit zombie distinction,
10000+2000 ms budgets, preserve roots on inconclusive cleanup.
Round 2: independent reviewer `984e2f92-d901-4b95-b7ea-6183027f818f`
APPROVED; R1 closed before implementation. Cross-platform implementation and
runtime validation are still required; design approval is not test certification.

## Implementation review and local verification

Implementation adds `test/helpers/fifo-fixture.ts`, `fifo-worker.ts` and eleven
regressions in `test/fifo-fixture.test.ts`, replacing only the three native FIFO
cases in `test/loop-concurrency.test.ts`. No src, dependency, Vitest timeout or
thread-pool changes. Successful cases await real execute completion and normal
holder/worker exits. Failure cleanup audits the owned group externally and
retains paths if inconclusive. Network-block evidence independently fails the
finishing hook, including expected-failure controls and fallback cleanup.

Independent implementation reviewer `bcd02ca0-a4c0-4b56-95a7-8263683c973b`
required removal of an incidental abort-before-all-ready assertion and prevention
of expected failures masking blocked-network evidence. Both were corrected and
independently re-tested, including two deliberately failing actual hook probes
with synthetic evidence and no network request. Implementation APPROVED;
follow-up review also approved the historical note, CHANGELOG and inventory.

Recorded Darwin arm64 / Node 25.5.0 verification before local merge:

- Source/test typecheck, repository lint, build and diff checks passed.
- Original six-file causal subset: 149 passed, repeated three times after the
  review corrections, with six workers and default libuv pool.
- Seven-file affected subset: 160 passed; independent focused run: 41 passed.
- Full original-config run: 175 files, 5073 passed, zero failed/skipped/todo,
  six workers, 39.54 seconds. A second full run with default worker settings:
  175 files, 5073 passed, zero failed/skipped/todo, 34.74 seconds. No increased
  test deadlines.
- Offline artifact smoke: 442 allowed files; modes, isolated install,
  help/version and local npm-exec inference passed. Dependencies were seeded
  read-only from the existing cache, with no network fallback.
- The existing prefix generator exposed three pre-existing missing Fast-test
  prefixes. Regenerated the inventory to include them; second generation is
  byte-identical. They do not overlap production diagnostics or other prefixes.
- Actual full-run FIFO scenarios: overlap 424.002 ms, abort 449.602 ms, child
  439.629 ms. The eleven-control regression file took 8929.772 ms; these are
  single-run observations, not a cross-version performance benchmark.

Evidence: `/tmp/ink-fifo-fix.wbksKT/` (`integrated-full-parallel.json`,
`integrated-full-default.json`, `integrated-package-smoke.log`,
`integrated-gates-final.log`, `review-six-workers-{1,2,3}.log`). Independent
re-review evidence: `/tmp/ink-fifo-rereview.MeY97V/`. Process scans found no
surviving fixture worker/holder. Inconclusive-cleanup behavior is intentionally
fail-closed; zombie records describe dead processes, not a claim to reap PID 1's
children. A captured numeric PGID is not a general PID-reuse-proof capability.

Linux Node 22.19.0/24 CI has not been run or triggered. This batch does not
repair production special-file reads, bump a version, push, publish or release.
Post-merge integrated results are recorded separately in the local run report.

## Release 0.6.0 supervisor-loss follow-up

The release preparation adds worker-side emergency containment on unexpected
supervisor IPC disconnection, plus an immediate connected-state check after
arming the handler and before creating holders/native reads. Only the detached
worker's own live PID selects its process group; no IPC message chooses a signal
target. Emergency group SIGKILL uses no asynchronous filesystem work, with an
immediate exit fallback if signaling fails. The fallback cannot establish
that descendants stopped. No guarantee applies before worker JavaScript runs.

Normal drained success and intentional no-I/O/orphan controls retain orderly
disconnection. A failed worker with pending I/O keeps its owner-loss protection
until the supervisor contains it. Three disconnect-boundary regressions cover
an already-consumed startup disconnect, a holder waiting in open, and a paired
native read before EOF. They require direct emergency SIGKILL close and no live
group members before any supervisor containment signal; later fallback cleanup
cannot satisfy the regression. They inject IPC disconnection, not an actual
supervisor-process kill. Zombie observations do not claim PID 1 reaping. Normal
success requirements, original deadlines and production read behavior are unchanged.
See [release-0.6.0-preparation.md](release-0.6.0-preparation.md) for the approved
design, negative controls and actual candidate verification results.
