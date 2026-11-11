# Child attempt output isolation after compaction

Status: implemented; independent design and implementation reviews approved.
Date: 2026-11-11
Baseline: `main@e28f673`
Branch/worktree: `fix/child-resume-output`, `.worktrees/ink-child-resume-output`

## Scope and failure

Fix release-review finding 1 only. Do not change task ownership during parent
session replacement or TaskRecord accounting/event isolation (findings 2/3).
No release/version change, real inference, credential refresh, push or publish.

SA-07 requires result text to come from this runSubagent invocation only.
Its seeded-message identity filter predates pricing snapshots. The new
SessionStore copies assistant messages in retained tails; rebuilding persisted
context after compaction changes their identities. A silent or immediately
failed resumed attempt can therefore return the previous attempt's answer.
A crash incorrectly becomes the existing crash-with-partial-result form.
The release review reproduced this through the real task resume pipeline with
default compaction settings; v0.5.1 does not return the old answer.

## Proposed change

Keep one invocation-local `lastAttemptText: string | undefined`, initially
undefined, rather than deriving result text from mutable/rebuilt history.

Wrap only the task loop's onMessage callback in runSubagent. For each assistant
accepted by runAgentLoop, use the existing finalAssistantText helper on that
single message to join ordered text parts, preserving exact whitespace while
ignoring an entirely whitespace-only result. Save a nonempty string before
forwarding to options.onMessage. User/tool messages do not change the value.
An empty/thinking-only/tool-only assistant does not erase earlier text from
this attempt. Both initial and overflow-recovery loop launches share the same
invocation-local value. Return it from every settled outcome; remove the seeded
identity set and final history scan. No message array or mutable object is kept
for result extraction, and memory is bounded by the last nonempty answer.

Capture before forwarding onMessage: the loop already inserted the assistant
into history, so the existing behavior can return its text even if transcript
persistence throws. Preserve that behavior and the callback's exception/order.
Provider onEvent content semantics remain unchanged; this is not a broader
observer-isolation change. Summarizer messages never pass this task-loop callback,
and seeded messages are never re-emitted through it. Neither can become output.

Keep SessionStore's defensive copies and pricing metadata unchanged. Do not
modify taskResult classification: a real current-attempt partial result remains
available on crash; a crash without such text must remain isError:true.
Usage ledgers, calls, thinking/speed, request history, replay, persistence,
timeouts/abort classification, leases and continuation validation are unchanged.

This supersedes SA-07 section 8's implementation claim that message identities
survive compaction. Its attempt-scoped output contract is unchanged.

## Verification before implementation completion

1. Add real task-tool resume regressions using existing child-resume fixtures:
   create and persist a child, continue once to produce an old answer and a
   default-window-sized usage anchor, then resume again so auto-compaction
   actually occurs. Assert a checkpoint, request counts and attempt accounting.
   Cover silent completion, immediate provider failure, a new multipart answer,
   and a current-attempt text/tool turn followed by failure. Historical answers
   and summary text must not become results; taskRecord.textPresent/isError
   must distinguish real current partial output from no output.
2. Exercise runSubagent directly with/without SessionStore and both automatic
   compaction and overflow recovery. Ensure old text cannot reappear, current
   partial text survives even when removed from replay history, empty/whitespace
   replies do not overwrite it, and summary text is not collected. Include a
   persistence-callback failure and a cancellation path; no timing races or real
   services are needed.
3. Run the new negative cases before source edits and retain failure evidence.
   Existing tests remain unchanged unless their claim about object identity
   needs a comment correction; do not weaken assertions to fit the new behavior.
4. Update Unreleased CHANGELOG, English/Chinese subagent user docs and SA-07's
   superseded implementation description in the same batch.
5. Run related child/resume/compaction/overflow/pricing tests, source/test
   typecheck, lint, build, full offline tests and git diff --check. Test workers
   use the repository's network blocker and temporary HOME. Reuse installed
   dependencies read-only; keep Vitest caches within this worktree or scratch,
   never run npm ci against a shared dependency symlink.
6. Obtain an independent implementation review, close findings, commit on the
   dedicated branch and merge to local main with --no-ff. No external action.

## Review record

Independent adversarial design review approved before implementation in session
`bbf2797a-d55d-43a9-84a4-c77a1d8515f8`. The reviewer independently reproduced the
failure through task resume and confirmed callback/observer acceptance ordering.
Implementation verification must explicitly cover retained historical assistants,
current partial output removed from replay history, both loop launches, delta-only
abort/crash, provider observer mutation/throw, and persistence callback failure.

Independent implementation review approved and closed in session
`e2990ace-7fde-4ebc-a2be-d110c228827e`. The reviewer reproduced the two task-resume
failures against the baseline and independently exercised 14 additional cases.
Its follow-up approved the clarified abort/timeout documentation and permanent
expanded tests. No source changes were required after implementation review.

Pre-fix evidence: the initial 21 engine tests produced 10 failures / 11 passes;
the four default-settings task-resume regressions produced 2 failures / 2 passes.
The completed change adds 35 engine tests and 4 task-resume integration tests.
The engine matrix covers persisted/ephemeral automatic compaction and overflow,
silent/crash/abort outcomes, partial text removed from history, replacement by
new answers, observer/persistence ordering and accepted-message mutation.

Final worktree verification: 4,909 tests passed, 0 failed, 0 skipped, across 171
files. Source/test typecheck, lint (314 files), build, documentation checks and
git diff --check passed. Offline artifact smoke validated 439 packed files,
permissions, isolated installation, help/version and local npm-exec inference.
Evidence: `/tmp/ink-child-output-fix.oyxF6f/` (full-tests.json, gate and smoke logs).
Environment: macOS arm64, Node 25.5.0. Supported Linux/Node 22.19.0 and 24 CI was
not triggered; no real inference, credential refresh, push or publication.
