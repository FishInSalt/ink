# Interrupted main-session recovery and classified Fast diagnostics

Status: implemented; independent design and implementation reviews closed.
Review sessions: `c600562d-4757-41bf-97f3-f6a0d152a7a1` and
`d4edd471-feae-4bb2-bbd3-f4b1f2b612ed`. Both initially blocked on uncertain
writes and the real `/tree` user-leaf path; the first also required navigation
failure consistency. The revised write-invalid/reopen policy, position ordering,
transaction failure synchronization and command-level recovery tests closed all
design findings. Implementation review and final verification are recorded below.
Baseline: `5457731` (Ink 0.6.1). Scope: two reported defects, no release,
installation, credential changes, live inference, or edits to user sessions.

## Evidence and constraints

An interrupted main session persisted an assistant batch of four calls but no
results. Resume appended new user messages and Codex rejected its stateless
replay with `No tool output found`. Main startup and `/resume` load
`buildContext()` without the child's ordered recovery. The loop already closes
normal cancellation/turn-limit batches; arbitrary process death bypasses that.
Missing output does not establish whether a tool executed.

`withFastMode` currently annotates every Error in Fast mode, including this
history error and unrelated auth/network failures. Normal mode cannot repair
those failures. Typed fields, identity, retries, selection, and billing route
must not change.

No full-history scan per model iteration, ordinary user submission, or normal
compaction. No automatic tool replay. No rewriting accepted session entries.
Old valid sessions keep their format, metadata, and exact context behavior.
Child continuation's reviewed strict pairing/refusal policy is retained.

## A. Shared pairing analysis

Extract the existing ordered `scanToolPairs` into a provider-independent core
module. It returns missing IDs/names in declaration order or an inconsistency.
Keep child-specific refusal wording in the child adapter rather than importing
child lifecycle code into the runner. Retain the child helper's public exports
and synthetic-result marker compatibility. Main markers say no result was
recorded, the outcome is unknown and may have fully or partially executed, Ink
did not replay it, and state should be inspected before retrying.

Only a final assistant batch, followed exclusively by partial tool-result
messages, is automatically closable. Orphan/early/duplicate results, duplicate
call IDs, and a new user/assistant while results are pending refuse before any
new prompt or provider request. Do not pair across branches or resurrect calls
outside the effective compaction context.

Already-failed legacy branches with later user messages are not silently
reordered. The local error explains `/tree`: select the first failed continuation
user message to re-edit it (navigation moves before that message), or choose a
complete branch; `/new` is also available. Both real `/tree` command paths
(picker and numbered) must let a current-leaf USER selection reach the runner;
only a current-leaf NON-user remains an early no-op. Selecting that first user
message leaves the original unresolved batch as the new tail, which normal
recovery can close. The old failed branch is retained. Cover the real command
flows with one and multiple failed user messages, not only runner navigation.

## B. Main continuation boundary

Use one simple runner `continuationNeedsCheck` state. Set it when startup
resume, `/resume`, or `/tree`/`/fork` reconstructs history, and after an abnormal
run exit. Fresh conversations start clear. Reads, listing, replay, status and
opening a session remain pairing-repair-free.

Before a top-level `runTurn` captures its context or accepts the next user
message, and before manual `compactNow` captures its context, prepare only if
that state is set. Preparation is synchronous:

1. Rebuild from the selected store (or use in-memory ephemeral history after an
   abnormal run). Run the shared ordered scan once.
2. Refuse inconsistent history with actionable main-session guidance. No new
   user message, pair repair, or inference on this path.
3. Make a torn file append-safe before writing. Append one ordinary error
   `toolResult` for the missing tail IDs, retaining real results. Ephemeral
   recovery adds the same honest message in memory.
4. Synchronize effective live history and compaction boundary, then clear the
   state only after successful persistence. Print one concise recovery note
   when tool results were added. Failure must stop the action; an uncertain
   write requires reopening, not retrying the same cached store. Never claim
   recovery persisted when it did not.

The normal loop remains unchanged and validates/closes its own current batch,
not historical batches. Automatic/overflow compaction uses the already-prepared
run context and receives no extra scan. Successful normal runs and compaction
do not mark history unchecked. An exception marks only the originating
conversation if it still owns the live view; switching sessions mid-run must
not corrupt a replacement conversation's recovery state. A later reopen of the
old session is unchecked by construction.

A branch summary is serialized text, not native tool replay. It needs no new
full scan of abandoned history. But appending a branch-summary entry at an
unresolved destination would turn a repairable tail into an inconsistent
history. For navigation with a summary, inspect the destination context before
starting inference; add optional `leafId` to read-only `buildContext()` so this
requires no temporary position mutation. Refuse bad destinations before a call.
After the await/session-identity guards and an explicit signal check immediately
before commit, move the position, close any destination crash tail, then append
the accepted summary. Mark the destination unchecked BEFORE fallible commit
writes. In a `finally`, synchronize live history and estimate floor from the
store's accepted in-memory entries only while that store still owns the view.
Clear the flag only on complete success. Thus a failed repair/summary append
never leaves live history pointing at the abandoned branch. An uncertain write
blocks further continuation until `/resume` reopens and reconciles disk state.
Cancelled navigation must not create pair repairs or move position. Navigation
without an accepted summary defers recovery to first continuation.

On summary installation failure, invoke the existing receipt path. An invalid
store must refuse this secondary append too: report receipt-write failure,
rather than risk duplicate accounting for a complete summary record written
before its append threw. After reopen, a retained complete summary owns its
usage; if the record never landed, durable accounting may be unavailable and
that is explicitly diagnosed, not invented. Existing successful accounting and
captured-session ownership are unchanged.

A pre-aborted action should not append pair repairs or turn an unresolved tail
into a later-user inconsistency. Keep this path explicit and tested.

## C. Structural append safety

A complete final JSON record without a newline, or an unparseable final
fragment, must be made append-safe before *any* append, including early
explicit model selection, `/name`, thinking changes and position markers.
Reuse `repairTornFinalLine`, which keeps accepted records and only terminates
or removes the uninterpretable fragment. Add a cheap flagged guard at the
central existing-store write path and before position writes/mutation; reads
remain unchanged. This is not tool-pair validation and does not add recurring
file reads to ordinary writes. Keep existing child continuation repair notes.

Existing-store append errors can leave zero, partial, or complete bytes that
were not indexed in memory. Fail closed: mark that store write-invalid, expose
a constant-time writable assertion, and require `/resume <id>` (or restart) to
reopen before ANY subsequent write or continuation. Preserve the initial error;
subsequent refusal explicitly explains the reopen requirement. Do not attempt
to repair/retry against the stale cache. First-write initialization failures
retain their existing separate fail-closed policy. A fresh `open()` reconciles
all accepted records and flags incomplete final bytes for the existing repair.

Position markers cease being best-effort: persist the proposed position before
committing its in-memory leaf, propagate failures and invalidate the store just
like other existing-store appends. This is necessary because a partial marker
can corrupt later appends. No recurring disk reconciliation or normal-path
reads are introduced. A repairTornFinalLine write/truncate failure also
invalidates the store. No external file access beyond existing session-store
behavior is introduced.

## D. Fast error classification

Add a narrow best-effort predicate for `CodexResponseError`:

- explicit `unsupported_service_tier`, `invalid_service_tier`, or
  `tier_unavailable` code; or
- `unsupported_parameter` with `param === "service_tier"`.

These are conservative structured diagnostics, not entitlement guarantees.
Do not match status alone, bare parameter, class alone or message substrings.
Unknown errors stay unchanged. Code spellings come from local fixtures, not a
new upstream guarantee. Protect classifier field access and annotation against
throwing accessors. Retain the same error object, typed fields, redactions,
normal-mode diagnostics and retry behavior.

Only classified failures in Fast mode get:
`To retry without Fast, explicitly select the normal model with /model.`
No hint for unrelated authentication, quota, network, timeout/interruption,
context, missing-tool-output, replay or protocol failures. No automatic normal
retry or fallback. Existing annotation immutability tests must exercise actual
positive tier cases, not become vacuous after narrowing classification.

## Verification and documentation

- Main startup `-r`/`-c`, `/resume`, deferred initialization, normal no-op,
  multi-call and partial-result tails, idempotent reopen, real results kept,
  old tools never executed, metadata/compaction boundary retained.
- Old poisoned branch refusal before prompt append plus `/tree` re-edit
  recovery; invalid/duplicate/early pairs refuse without mutation.
- Navigation into a call-only/partial-result position, with/without summary;
  original descendant results remain untouched, cancellation/session swaps
  preserve the existing transaction/ownership behavior.
- Runtime exception after tool execution/before persisted batch, ephemeral
  recovery, captured-run/session swap, recovery-write failure and reopen.
- Inject actual zero-byte, CJK partial, complete-without-newline and complete
  newline-terminated append failures. Further writes/inference on that store
  refuse; reopen preserves accepted records and avoids duplicate repairs.
- Fail destination repair after a successful position move, then separately
  fail summary installation after repair. Verify live/store/estimate agreement,
  unchecked state, receipt diagnostic and accurate reopened continuation.
- Torn-tail variants before first model/name/position append, including CJK;
  valid old sessions unchanged until ordinary new writes.
- Assert the scan is not called again for normal top-level runs or model
  iterations/automatic compaction; use an exported shared-analysis spy.
- Offline built CLI resume test with isolated HOME, synthetic credentials,
  loopback provider, and outbound-network guard; seed the actual crash shape.
- Fast positive/negative classification including HTTP-200 SSE, conflicting
  param evidence, hostile/frozen error objects and unchanged retries.
- Update English and Chinese sessions/providers pages and stale replay comment.
- Run focused regressions, typecheck, lint, build, and full offline test suite.
  Independent code review is required after these changes.

## Implementation review amendments

The first implementation review found four integration gaps. The corrections
below passed independent design review in session
`086d42b5-8808-4487-8ca0-aa4f9008c929` before implementation. Close them without
widening pairing scans:

- Preserve `runTurn`'s existing synchronous run-start-hook failure contract.
  Return rejected promises only for the new continuation preflight failures;
  pre-aborted runs return resolved aborted outcomes. Do not make the whole
  method `async`.
- At every main/child model-request boundary, assert captured-store writability
  in constant time, independent of automatic-compaction settings. This is NOT
  another pairing scan. Guard summary inference too. An existing-stream request
  need not be undone, but no later request may start through an invalid store.
- Child compaction's normal provider-failure tolerance must not swallow a
  persistence failure. Record a caught checkpoint append error and rethrow it
  unchanged past the summarizer backstop; do not replace it with a later reopen
  refusal or overflow guidance. Existing provider retry/cancellation policies
  remain unchanged. Tests cover zero/partial/complete checkpoint writes.
- Force exit must try emergency result persistence, report failures, and still
  execute cleanup/exit/finish. Apply to REPL double Ctrl+C and print SIGINT.
  An invalid store remains unwritable; never bypass the refusal. Test real
  pending-tool plus invalid-store double-Ctrl+C and the print signal path.

## Completion and verification

Implementation reviewers were fresh-context sessions
`086d42b5-8808-4487-8ca0-aa4f9008c929` and
`47f32155-7d12-4068-9321-fbc8d65133c4`. They found the integration gaps above
and later identified retry-handler masking of filesystem errors whose paths
contain `context_length`. Four native ENOENT regressions cover main retry
assistant persistence, child initial/retry assistant persistence, and a second
child checkpoint inside overflow retry. The main-retry and child-checkpoint
regressions were observed failing before correction. Commit `b48e555` fixes the remaining
handlers. Reviewer `47f32155` explicitly approved that commit after 210 focused
tests and typecheck; all reported implementation blockers are closed. The
other reviewer's final attempt was interrupted by the external Codex stream,
not completed or counted as a final approval.

Final commands on `b48e555`:

- `npm run typecheck`, `npm run lint`, `npm run build`: passed. Lint checked
  352 files; docs checked 11 topics in each of 2 languages.
- `CI_REQUIRE_SEARCH_TOOLS=1 npm test -- --maxWorkers=6`: **6,005 tests passed
  across 191 files**, Node 25.5.0. Full output:
  `/tmp/ink-resume-verified-full-tests.log`.
- Node **22.19.0** and **24.22.1**: both TypeScript configurations passed;
  **619 tests across 8 files passed on each runtime**. Files: main-continuation,
  session-write-inference, session-append-safety, main-resume-cli,
  codex-fast-transport, child-resume, repl-commands, task-run-owner.
  Logs: `/tmp/ink-resume-node22.19.0-tests.log` and
  `/tmp/ink-resume-node24.22.1-tests.log`.
- `git diff --check`: passed.

The final full run exited 0 but its scratch teardown reported `ENOTEMPTY` and
retained its private `ink-test-run-RONXK9` directory under the OS temporary root.
The retained contents are test renderer/clipboard/tool-output fixtures; no
cleanup or user-state edits were attempted. The 619-test runtime runs completed
without this warning. No live inference or real session modification was used
for verification. The source fixes do not update the global Ink installation.

## Non-goals

No per-tool incremental persistence redesign, universal history state machine,
new recovery command, generic error hierarchy, provider-side hidden history
rewriting, automatic execution retries, or live-session modification.
