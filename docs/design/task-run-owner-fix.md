# Bind task parent ownership to the issuing run

Status: implemented; independent design and implementation reviews approved.
Design APPROVE: `28ab513d-82cb-4599-b600-30fffa393048`.
Implementation APPROVE: `abc80da3-3899-4c2c-8b6e-7239cf00e49d`.
Local commits/--no-ff integration are coordinated separately; no external
publication, push or CI action is included.

Review clarifications: residual loop workers after an observer exception are
outside this ownership scope; do not redesign the scheduler. Exercise synchronous
pre-promise failure with an emitter spy because ordinary registry handlers have
their exceptions isolated. Include `test/runner.test.ts` in targeted validation.

- Worktree: `.worktrees/ink-task-run-owner`
- Branch: `fix/task-run-owner`
- Baseline: `639eec71c0b3c766fdfd21da3a8bc365b1179c62`

## 1. Problem and evidence

The previous [pricing design](codex-service-tier-pricing-design.md) deliberately
preserves a captured run's successful automatic/overflow compaction and subsequent
messages after `/new` or `/resume`. This is correct: run A continues using its
captured store/history; replacement session B owns the public history view.
Do not undo that fix or reject a successful summary because B became active.

There is a remaining mismatch at child dispatch:

1. `src/runner.ts: captureRunContext/runTurn` capture session A before `run_start`.
2. During a real automatic or overflow summary, the caller switches to B.
3. `runTurnInner.onMessage` still persists the original run's tool result,
   including its TaskRecord, in A.
4. The construction-time task tool's `getSession: () => this.sessionStore`
   instead reads B. `src/core/tools/task.ts: execute` captures that once as
   `parentStore`, then correctly uses that same value for fresh/resumed dispatch,
   TaskRecord.parentSessionId, child header.parent and launch.parentSessionId.
5. The internally consistent B identifiers therefore appear inside A's record.
   `findChildByLaunch(A, childId)` refuses ownership. With a lazy, unwritten B
   from `/new`, `findOrphanChildren` also reports the child as orphaned even
   though its real issuing parent A exists.

The supplied controlled reproduction was read and run against this baseline,
with injected streams, isolated settings/auth/catalog/HOME, and network guards:

- `/tmp/ink-review-y4bQAt/child-owner-controlled.mjs`, `--swap=new` and
  `--expect=mismatch`: one accepted checkpoint and one TaskRecord in A; zero
  TaskRecords in B; record.parentSessionId and child.header.parent both B;
  A lookup `not-owned`; B file absent; one orphan child.
  Result: `/tmp/ink-review-owner-task-run-owner-design-new-IH9Zu3/result.json`.
- Same probe, `--swap=none --expect=consistent`: one accepted checkpoint,
  consistent ownership, successful A lookup, zero orphan children.
  Result: `/tmp/ink-review-owner-task-run-owner-design-none-3SzldE/result.json`.
- Both executions reported zero fetch attempts and zero blocked nonlocal
  requests. These verify the baseline defect/control, not a completed repair.

Relevant existing tests inspected: `test/summary-receipts.test.ts` (the four
successful automatic/overflow × new/resume origin-continuation cases),
`test/codex-session-affinity.test.ts`, `test/codex-fast-runner.test.ts`,
`test/codex-fast-children.test.ts`, `test/task-tool.test.ts`, and
`test/task-source-identity.test.ts`. The four summary-receipt regressions end in
ordinary parent text; they do not dispatch the real task tool after the swap.

## 2. Required invariants and narrow scope

For a task executed as part of top-level run R:

- Parent ownership is `R`'s captured `SessionStore | null`, never the currently
  displayed session. For a persisted parent, the containing result file,
  TaskRecord.parentSessionId, child header.parent, launch.parentSessionId and
  continuation lookup must agree. This applies equally to rejected task
  records, fresh children, and attempts to resume an existing child.
- A captured **null** means no parent persistence. It must not fall back to a
  subsequently live B. No child transcript or parent ID is invented; the
  existing `no-parent-session` transcript result and resume refusal remain.
- This binding changes **only task parent ownership**. Fresh child
  provider/model/reference/speed/thinking still capture the live selection
  together at dispatch, before asynchronous setup, with existing agent override
  rules. Child continuation still uses its recorded model/speed, live compatible
  provider instance and existing thinking/environment validation rules.
- Parent request identity, provider/model/speed snapshot, history mirroring,
  accepted checkpoints, summary receipts, usage and event order remain as
  before. Capture stays before `run_start`; overflow retry uses the same run.
- Existing direct `runner.tools` / `getTool("task")` execution remains supported,
  including omitted third execute argument and absent taskToolCallId. Outside
  an active issuing-run async context it uses the live store, as today, even
  when another run is suspended. A direct call inside an active run callback
  is associated with that run; it does not automatically append its result to
  the parent (the existing direct-call persistence contract is unchanged).
- Ownership must be isolated across overlapping/reentrant runs and different
  Runner instances. No new mutable Runner-wide/current-process owner slot.

Non-goals: repairing old misowned files, changing orphan/lookup safety rules,
forcing B onto disk, changing task result persistence, serializing/rejecting
runs, general same-file concurrent-writer support, moving child environment
assembly to run entry, or redesigning the existing `turnEventTap` event relay.
This fix does not claim to make every shared display/event field reentrant.

## 3. Alternatives and recommendation

### Recommended: one Runner-local AsyncLocalStorage, one binding per run

Use Node's built-in `AsyncLocalStorage` (already supported by the declared Node
engine; no dependency installation). Each Runner owns its own ALS instance.
Each `runTurn` creates a distinct scope, containing only an optional binding
whose `session` is the already captured `context.session`:

    scope.binding = { session: context.session }  // null is authoritative

The ALS object is not a single owner register: `run(scope, callback)` associates
a different value with each async execution chain and restores its caller's
context on return. Nested `runTurn` calls establish their own scope; overlapping
promise chains retain separate scopes. Do not use `enterWith`, a module-global
ALS instance, `turnEventTap`, or `this.activeTaskParent` for ownership.

Wire **only** the existing task `getSession` closure to a private owner resolver:

    binding = taskOwnerScopes.getStore()?.binding
    return binding === undefined ? this.sessionStore : binding.session

The absence check must be on the binding, not on `binding.session`. In
particular, `binding?.session ?? this.sessionStore` is incorrect. `execute`
continues to read the resolver once before any await and uses its existing
local `parentStore` for every fresh/resume path. No Tool arguments, schema,
provider request, TaskRecord format, session format or lookup API changes.
All other task getters remain live and retain their existing capture sites.

### Considered: extend the existing execute context

`Tool.execute` already receives optional `{ toolCallId }`; `runTool` supplies it
for both serial and concurrent execution. An optional explicit parent binding
would also distinguish absent from captured null and naturally avoid ambient
state. However, the current `RunAgentLoopOptions` has no host execution context.
Implementing this route requires threading the binding through batch execution,
serial execution, chunk plans and `runTool`, adding session-store knowledge to
the generic tool context (or a new resolver), while deliberately not forwarding
parent ownership into child loops. It changes more shared scheduling/tool API
surface than the one-getter defect needs.

A per-run task adapter could avoid that threading, but replacing entries in
`this.tools` is unsafe for overlaps; making copied/per-run tool tables adds
identity/live-tool-table questions unrelated to this repair. Prefer ALS here:
one functional source file, existing task API untouched, automatic propagation
through the already existing loop, gates and retry awaits. Explicit context is
a fallback only if independent review identifies an ALS correctness problem;
it is not an additional mechanism to implement alongside ALS.

## 4. Entry, lifetime and cleanup

1. Keep `captureRunContext()` at the current synchronous entry, before any
   `run_start` handler. Create the distinct ownership scope from that captured
   session, including null. Do not recapture after an observer or summary.
2. Execute the existing post-capture `runTurn` body inside `ALS.run(scope, ...)`,
   including `run_start` and its synchronous callbacks. Preserve model seeding,
   observer ordering, synchronous-returning Promise API and the existing
   run_error/run_end behavior. An observer that switches to B cannot change
   the outer binding; a nested run captures B and establishes its own binding.
3. The scoped body includes `runTurnOrRecoverFromOverflow`, its initial
   `runTurnInner`, the recovery summary, and its retry. Do not clear ownership
   in `runTurnInner.finally`: the first overflow leaves that method before
   recovery and must not lose the parent.
4. In the outer returned promise's existing finalization, invalidate only this
   scope by setting `scope.binding = undefined`, then dispose its health
   monitor. This happens on success, max-iterations, clean abort, provider or
   observer failure, failed summary, retry failure and second overflow. Clear
   the binding even if other cleanup can throw. A synchronous throw before a
   promise/finalizer is installed must likewise invalidate this scope and
   release any already-created health monitor without masking the primary
   error, then preserve the original synchronous error behavior.
5. Never call `ALS.disable()` per run or clear another run's binding. The
   per-scope invalidation releases its stored SessionStore reference; it is
   not a new globally mutable owner slot. It also prevents detached callbacks
   that inherited an old ALS scope from acquiring A after the run has settled:
   a *new* direct task invocation in such a callback falls back to live B.
   Already-started tasks keep their local `parentStore` across awaits, including
   existing abort-grace/late-settlement behavior. Do not broaden this repair
   into changing how abandoned tool results are handled.

Manual `compactNow`/branch summaries do not create task owner scopes. Summary
receipts continue using their current captured-store/same-file routing. Parent
null versus session replacement is not deduced from a session ID or file path.
Reopening the same A file still uses the original run's captured store; this
batch does not introduce general store-to-store synchronization or redirect
accepted run results to a reopened instance.

## 5. Implementation boundary after approval

Expected functional change: `src/runner.ts` only (import/scope type and member,
resolver wiring, runTurn scope and exception-safe outer finalization). Correct
the constructor comment that currently treats `/new`/`/resume` parent ownership
as uniformly live. `src/core/tools/task.ts` needs at most a contract-comment
clarification for `TaskToolOptions.getSession`; its once-per-execute ownership
capture and all fresh/resume logic should remain intact.

Add focused Runner regressions in `test/task-run-owner.test.ts`, reusing existing
fakes/temp helpers. Retain the original affinity/summary tests unchanged unless
an independently justified fixture adjustment is necessary. New fixtures must
use an existing approved temporary prefix such as `ink-runner-`, not require a
fixture inventory or dependency update.

Because this corrects user-visible session/child behavior, the implementation
batch must also clarify issuing-run ownership versus live child selection in
`docs/sessions.md` and `docs/subagents.md`, with corresponding
`docs/zh-CN/sessions.md` and `docs/zh-CN/subagents.md` mirrors. The original
design-only batch left those pages unchanged; implementation updates them.
No schema migration, new command,
configuration switch, pricing change or other feature work.

## 6. Regression plan and acceptance criteria

Use the **real createRunner, built-in task, runSubagent, compaction and stores**.
Fake only provider streams (and a provider factory for a deliberate model-family
switch), not `compactSession`, `createTaskTool`, child creation or ownership
lookup. Gate summaries using deferred entered/release promises. Classify requests
by the summary system prefix / child suffix, not assumed request ordinal alone.
Always release gates and close runners in cleanup; use bounded waits, not sleeps.

### A. Real summary → fresh task: four mandatory interleavings

Parameterize automatic/overflow × new/resume-to-different-B. For automatic,
explicitly enable merged autoCompact and a suitable window; for overflow,
throw a recognizable context-overflow error on the initial main request without
first triggering automatic compaction. Seed enough old turns and retained tail
for a real cut. Assert the threshold/cut prerequisites and that the summary
actually entered, not merely that a fake scripted call happened.

Start A's run, wait at its summary, switch via public newSession/resumeSession,
snapshot B, release, then have the captured main request issue the real task
followed by a final parent response. Before any next B turn, assert:

- Exactly one accepted compaction in A, no duplicate summaryUsage receipt;
  summary unkeyed; main follow-ups still use A's request identity and history.
- Exactly one durable TaskRecord in A, zero in B; record.parentSessionId,
  child header.parent and launch.parentSessionId all equal A.header.id. Reopen
  files and check the same facts, not just the live arrays.
- B entries, leaf, context and stable public history are unchanged by A; with
  an intentionally unseeded ordinary `/new`, B can remain an absent lazy file.
- `findChildByLaunch(A, childId)` succeeds; B refuses ownership;
  `findOrphanChildren(baseDir)` does not include the child. Only enumerate
  orphans; do not run destructive pruning.
- Next issue a **task-producing run on B**, not only a text response. Its
  result, child header and launch all belong to B; A retains its original
  record unchanged. Neither child is an orphan once B has run.

### B. Continuation resolves against the issuing parent

Repeat the four interleavings with a previously completed, real task child of A.
The post-summary task uses `resume: childId`. It must find and continue that
child despite live B, keep the same child ID, and persist a second distinct
attempt in A with A ownership. Child history contains the new instruction;
lookup/lease/validation run normally. B cannot resume A's child in its own next
run and must receive the existing ownership refusal without a child request.
Do not weaken launch-environment or provider compatibility checks to pass this.

### C. Ownership is captured; child selection is still live

During the summary gate, change the live provider/model/speed/thinking before
dispatch, using injected providers and known offline metadata. Exercise both
normal→Fast and Fast→normal selection, and a fake cross-provider factory route.
The parent and summary keep their captured provider/model/speed, while the new
child uses the dispatch-time live provider/model/speed/thinking; all its parent
IDs nevertheless remain A. Check actual request capture and persisted binding/
launch speed. Existing agent overrides and resumed-child recorded speed remain
covered by `test/codex-fast-children.test.ts` and `test/task-tool.test.ts`.

### D. Null owner and direct live fallback

- With `noSession: true`, run a real task without a store: no parent/child ID
  and no transcript; no file created for that child.
- To distinguish **captured null** from **no active run binding**, gate a
  no-session run before its task and use public `resumeSession(B)` to make a
  seeded B live. The Runner API currently permits this; do not add a production
  seam or change no-session policy. The old task must retain null, report
  `no-parent-session`, and leave B untouched. A variant issuing
  `task({ resume: knownBChildId, prompt: "continue" })` from that null-owned run
  must refuse for lack of an owning parent, rather than resolve B's child.
  The next B run can persist a correctly owned child. This case uses a
  parent-stream gate, since no-session disables compaction.
- Directly execute the task obtained from `runner.tools` with only args/signal,
  before a run and while an unrelated async chain's A run is gated. It must
  read the live B/null as appropriate, keep absent taskToolCallId, and retain
  live child selection. Seed a persisted parent for these direct-call fixtures
  so its own lazy-file behavior is not mistaken for this defect. Direct
  invocation must not start a top-level run or acquire an unrelated run's
  binding.

### E. Isolation and cleanup are observable, not just implementation claims

- Overlap real A and B runs, holding both before task dispatch. Complete them
  in both orders, including finishing A while B is still pending. Assert each
  record/child owner, then a later B task. This rejects a shared slot and
  cleanup that accidentally clears another run.
- A one-shot `run_start` observer switches to B and synchronously starts a
  nested run; outer A was captured before that callback. Both runs dispatch
  real tasks with their own ownership. Guard reentry in the fixture and await
  both promises outside the synchronous observer. Also exercise different
  Runner instances so ambient ownership cannot cross instances.
- After success, child failure, parent provider rejection, cooperative abort,
  summary failure and exhausted overflow recovery, invoke a direct task and a
  next top-level task on B. Neither may inherit A. Overflow success must retain
  A *through* recovery, not just release it correctly at the end.
- Schedule a deferred direct invocation from inside an A event callback; release
  it only after A's promise settles. Despite its inherited async resources it
  must use live B. This specifically tests the scope invalidation, rather than
  only ALS restoration to an independent caller. Verify the same for failure
  and abort. Cover synchronous pre-promise failure with a controlled throwing
  observer/emitter seam without changing the public event contract.

Cancellation/summary signal behavior is otherwise unchanged: automatic and
overflow compaction currently call `compactAndSplice(context)` without the
run's signal. Release any blocked fake summary during abort tests and verify
existing abort outcomes; do not silently add signal propagation in this batch.
Task ownership must not change tool-result order, call IDs, source IDs, usage,
child transcript opt-out, or task continuation refusal behavior.

## 7. Verification and review gates

After independent design APPROVE, implementation verification must include the
new focused file plus `test/task-tool.test.ts`, `test/task-record.test.ts`,
`test/task-source-identity.test.ts`, `test/child-resume.test.ts`,
`test/child-launch.test.ts`, `test/child-launch-validation.test.ts`,
`test/codex-session-affinity.test.ts`, `test/codex-fast-runner.test.ts`,
`test/codex-fast-children.test.ts`, `test/summary-receipts.test.ts`, and
`test/runner.test.ts`; then build, source/test typecheck, lint and
`git diff --check`. The coordinating agent runs the full integrated test suite.

Use the already symlinked node_modules read-only; invoke installed binaries,
not dependency installation or npx downloads. Provider/catalog/auth inputs stay
hermetic; fake stream tests assert zero unexpected fetches and retain the
existing network blocker. No real API/network, main changes, merge, push,
publish, account configuration changes or global installation is part of this
work. The controlled external probe can be repeated with the source pointed at
this worktree; it supplements, rather than replaces, committed real Runner
regressions. Report exact test counts and commands only after running them.

Independent implementation review is warranted for this async ownership change,
even if the source diff is small. Review must inspect null/absence handling,
run_start reentry, both overlap settlement orders, detached async callbacks,
terminal cleanup and unchanged live selection, as well as fresh/resume lookup
and orphan behavior. Design approval is recorded above; implementation approval
is recorded in section 10.

## 8. Questions for the independent design reviewer

- Confirm ALS is the smallest safe boundary for this host-side ownership fix,
  versus extending the generic Tool execution context. In particular, examine
  the stated behavior of direct calls inside active callbacks versus unrelated
  caller chains, and explicit invalidation of inherited, detached scopes.
- Same-file reopening can leave the reopened live store's in-memory view behind
  the original run's accepted writes. Existing run/summary behavior intentionally
  uses the captured instance; this proposal fixes ownership only, not general
  concurrent store synchronization. Confirm that boundary is kept explicit.
- `turnEventTap` is already a mutable Runner-wide relay; overlapping runs may
  still have unrelated event-routing limitations. New owner tests must verify
  durable ownership independently of that relay, without claiming it is fixed
  or using it as an owner carrier.

## 9. Implementation and initial local verification

Implemented the Runner-local ALS scope, explicit null-aware task parent
resolver, whole-run/overflow lifetime, and async plus synchronous scope
invalidation. `src/core/tools/task.ts` changed only its getter contract comment;
no scheduler, task execution, persistence schema or selection behavior changed.
Published sessions/subagents pages were updated in both languages, and the
CHANGELOG fix was inserted immediately before `Child results after compaction`.
No commit, merge, shared-dependency change or full integrated test run was made.
Independent implementation review remains for the coordinating agent to arrange.

The new `test/task-run-owner.test.ts` has 25 data-driven real Runner tests:
eight automatic/overflow × new/resume × fresh/continued-child cases, three live
selection cases, two captured-null cases, direct-call compatibility, two overlap
settlement orders, synchronous run_start reentry, different-Runner isolation,
and seven terminal/detached cleanup cases. The latter schedule detached work
from run_start callbacks; the synchronous failure uses an emitter spy rather
than an ordinary throwing handler. Every fixture asserts zero fetch attempts,
releases gates and settles tracked work before removing its temporary directory.

Observed local results:

- Before the Runner change: 25 tests, 19 failed, 6 passed, 0 skipped. Failures
  reproduced misowned records/children, continuation ownership, null fallback,
  overlapping runs and run_start capture. Test source typechecking passed before
  implementation; the initial fixture-only return-type errors were corrected.
- Final focused run: 25 passed, 0 failed, 0 skipped in one file.
- Related validation: 527 passed, 0 failed, 0 skipped across the 12 files listed
  in section 7, including `test/runner.test.ts`.
- `node_modules/.bin/tsc --noEmit`, `node_modules/.bin/tsc -p
  tsconfig.test.json --noEmit`, and `node_modules/.bin/tsc` all exited 0.
- Full lint-script equivalents exited 0: Biome checked 315 files; docs checked
  11 pages × 2 languages and 10 topic routes; the identity gate checked 45
  matches in its 17 allowed files. `git diff --check` passed.
- The controlled external probe with `--swap=new --expect=consistent` now
  observes exactly one accepted checkpoint and one A-owned TaskRecord, matching
  child parent A, successful A lookup, absent lazy B file, zero orphans and
  zero fetch attempts. Its result is
  `/tmp/ink-review-owner-task-run-owner-implemented-9Dmhyu/result.json`.

Logs and exact command manifest: `/tmp/ink-task-run-owner-check.YYbvDt/`:
`red.json`, `green.json`, `related.json`, corresponding `.log` files,
`types-build.log`, `lint.log`, `controlled.log`, and `commands.json`.
The full integrated suite is deferred to the coordinating agent as requested.

## 10. Independent review and final branch verification

Fresh-context implementation review `abc80da3-3899-4c2c-8b6e-7239cf00e49d`
returned APPROVE with no blocking findings. The reviewer ran 527 related tests
and seven independent boundary probes, including already-started tasks across
parent settlement, nested synchronous failure and cleanup exceptions. No source
changes were required after review. Shared turnEventTap routing, same-file store
synchronization and residual workers after observer failure remain out of scope.

The coordinating agent ran typecheck, lint, build and the full offline suite on
this branch: 4,934 passed, 0 failed, 0 skipped across 172 files. Logs and JSON are
under `/tmp/ink-task-fixes.PT7HAq/owner-*`. Final combined validation with the
separate accounting snapshot repair follows local integration. No real provider
requests, credential refreshes, publication or push were performed.
