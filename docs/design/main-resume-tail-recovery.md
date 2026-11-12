# Main-session resume: repair only the interrupted final tool batch

Status: approved for implementation. Independent adversarial review
`dd7d7b4f-2a90-43e9-87ce-c4ee24095fcc` closed after adding the same-active-file
repair precondition; no other scope expansion was requested. Implementation
review remains required.

## Scope and rollback

The user explicitly approved reverting merge `ef1eba0` in a new worktree without
rewriting main, preserving independent Fast diagnostics commit `8f71557`, and
redoing only main-session process-interruption recovery. Keep all old commits
and worktrees. Do not modify real sessions, global configuration/installations,
or publish anything. The old broad design is withdrawn with the revert.

After design approval, commit this document, revert `ef1eba0` with mainline 1,
and reapply `8f71557`. The resulting implementation baseline is `5457731` plus
the five Fast-only files. This mechanical rollback must not retain the previous
main recovery flag, generic full-history checker, navigation repair, provider
write guards, or unrelated persistence/child/force-exit changes. The preexisting
child-resume implementation and normal tool error/cancellation handling stay
unchanged. Fast request classification and its independent tests/docs stay.

## Behavior

Run one small main-specific helper ONLY when actually restoring a saved main
session: startup `-r`, startup `-c`, and interactive `/resume`. These entrances
already build effective context from the freshly opened store; reuse it rather
than rebuilding after adding results. Merely listing sessions or replaying
history does not call the helper. Actual resume may append repair records even
if the user subsequently only reads the restored conversation.

Inspect only the final assistant tool batch and contiguous following
`toolResult` messages:

1. Walk backward over trailing tool-result messages. The immediately preceding
   message must be an assistant. If the suffix ends in a user message, or the
   assistant contains no tool calls, return unchanged. Do not search across user
   messages, inspect earlier batches, or validate the whole history.
2. Match IDs within this batch only; preserve real outputs. Duplicate calls,
   duplicate results, or results belonging to another batch make this tail
   ambiguous: refuse before adding synthetic results rather than guess. This
   is a local safety check, not a validator for earlier history.
3. For each missing call, in original declaration order, append one ordinary
   `toolResult` error entry (one message containing all missing results). Say
   no result was recorded, outcome is unknown, it may have fully or partially
   executed, Ink did not replay it, and inspect state before deciding to retry.
4. Reuse the already-built messages plus the appended result. Keep the existing
   compaction boundary, native replay/provenance, usage and model selection.
   Reopening a successfully repaired session must not add another result.

A suffix such as assistant(call) -> user(continue) is explicitly outside the
repair rule. Do not backfill, reorder, discard calls, or claim it was fixed.
Old deeper inconsistencies are outside this feature. The server may still
reject such a legacy history; docs explain selecting a complete branch or
starting a new session. Do not expand navigation or runtime recovery to cover it.

## Integration and persistence

Call the helper on the freshly resolved store BEFORE explicit startup model
selection can append and BEFORE installing that store/history as the runner's
active conversation. Both warmup and `/resume` use the same helper. A recovery
failure aborts startup or leaves the previous interactive conversation active;
no new user message or model request is accepted by the failed resume action.
Do not reuse its failed candidate store; the next resume reopens disk state.
A partial or complete append followed by an error is reconciled on that next
open, avoiding a new global write-invalid or pending-recovery state machine.

One alias case needs a resume-only precondition: if interactive `/resume` would
write repairs to the SAME file as the currently active persisted store, refuse
BEFORE any repair with guidance to `/new` then `/resume <id>`, or restart with
`ink -r <id>`. Otherwise a failed candidate append could invalidate the still-
active store's view of that same file. Compare the file path first and, for
persisted files with different paths, file device/inode identity (also covers
symlinks/hard links). Do this only when structural or missing-result repair is
actually needed. A valid self-resume remains allowed. Startup has no old active
store and is unaffected. No persistent flag or normal-turn check is introduced.

Reuse the existing `SessionStore.repairTornFinalLine()` at this resume boundary
before ANY append (including startup model selection), even if no tool result
is missing. It already preserves accepted records, terminates missing newlines,
and drops only the uninterpretable final fragment. Do not redesign store writes
or add markers. Ambiguous tool-tail refusal precedes structural repair.

Print one concise note if missing results were added, and optionally report an
existing structural-tail repair. No repeated warning during normal iterations.
The helper must not execute tools, invoke tool hooks, or manufacture task records
or usage. No repair is deferred until a later user submission or compaction.

## Explicit exclusions

No `continuationNeedsCheck` or equivalent flag. No new work in `runTurn`,
`onBeforeTurn`, ordinary model requests, normal/overflow compaction, `/tree`,
`/fork`, or runtime exception handling. No full-history pairing scan, trusted
prefix cache, file-format change or periodic tool-health checks. Do not modify
the existing child continuation logic. Existing file loading/buildContext may
still traverse the selected branch; this change adds only suffix analysis.

## Verification

- Tail analysis: no calls; one/many missing calls; partial/out-of-order real
  results; last message user; old broken prefix untouched; ambiguity refusal.
- All resume entrances, deferred warmup, preserved model/speed/thinking/native
  metadata and compaction boundary; no old-tool executions or hooks.
- Assert analysis does not visit older messages using throwing property getters
  on a synthetic older prefix; do not rely solely on timing benchmarks.
- Actual resume repairs before replay/new prompts, unchanged valid-session
  bytes, and idempotent second resume. No helper calls during ordinary turns,
  auto-compaction or history navigation.
- Complete unterminated and unparseable final records, including CJK; explicit
  startup model override cannot append ahead of repair.
- Inject zero/partial/complete result writes that then throw; failed different-
  file `/resume` leaves old session/history/model active; a fresh resume
  preserves accepted bytes and neither duplicates real results nor appends
  behind torn bytes. A write-requiring same-file resume refuses before the
  injected write can run; valid self-resume still succeeds. Cover alias paths
  and `/new` then resume as the supported escape without changing old bytes.
- Built CLI smoke with isolated HOME, fake credentials, loopback provider and
  network blocker: four-call interruption, partial results, -r/-c/piped resume,
  and actual abrupt process death if practical.
- Restore the preexisting broad-batch tests to baseline with the revert; add
  focused new tests for this narrow contract, not the withdrawn behavior.
- Update English/Chinese sessions docs and the stale replay comment. Run
  typecheck, lint, build, targeted tests and full offline suite. Independent
  implementation review is required before --no-ff merge to main.
