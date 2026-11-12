# Review follow-ups after Ink 0.6.1

Date: 2026-11-12
Status: implemented; independent design and implementation reviews approved.
Independent adversarial design review `276125b3-4a73-4e51-b534-b19132f32eb8`
closed after preserving unknown_incomplete context-recovery compatibility.
Base: main `5c43548`, latest published `v0.6.1` / source `5457731`.
Branch/worktree: `fix/review-followups`, `.worktrees/ink-review-followups`.

## Scope and safety

Fix the three confirmed findings from the current-versus-release review:
malformed final-batch identities, unsafe stream-interruption detail, and
misclassified context recovery. The last two also reproduce on v0.6.1.
Update English/Chinese user docs, Unreleased notes and stale publication state.
Do not bump versions, change dependencies/workflows, publish/push, modify real
sessions or credentials, or change the global installation/configuration.
Use the existing main-resume-tail design's narrow boundary. No full-history
validator, navigation repair, persistent recovery flag or write state machine.

## A. Reject malformed final-batch identities before writing

In `src/core/session/resume-tail.ts`, validate the identity fields used for
matching: each final assistant tool call's `id` and `name`, and each contiguous
result's `toolCallId` and `toolName`, must be nonempty strings. Do not trim,
normalize, coerce or stringify untrusted values into errors. Keep IDs opaque.
Reject with a fixed `SessionError` before structural repair or synthetic append.
Existing duplicate/foreign-result checks remain. A no-tool assistant and earlier
history remain outside the helper's validation boundary. Do not redesign the
session parser or promise general validation of message schemas.

Tests must cover object/array/number/null/missing/empty identities on both sides,
including malformed final records without a newline. Assert byte-identical
files on refusal, no append, repeated refusal, and unchanged active conversation
for interactive failure. Existing valid/idempotent resume and bounded-history
checks must continue to pass. Exercise a real built CLI with isolated state for
the original object-ID regression, not only the analysis function.

## B. Publish only fixed stream-interruption diagnostics

`wrapStreamInterruptions` currently copies arbitrary cause messages into a
public `StreamInterruptedError.message`; the Runner logs that message. Replace
these details with a closed vocabulary: recognized socket codes
`UND_ERR_SOCKET`, `ECONNRESET`, `EPIPE` plus fixed `connection closed` wording;
recognized `terminated` / `fetch failed` wrappers without such a code get only
`connection closed`. Never copy arbitrary outer/cause messages or unknown codes.
Keep the original error as `cause` for explicit local debugging, existing error
type/provider and the `continue` hint; keep the 160-character public bound.
Only opt-in wrapping uses this policy; non-transport errors pass through and
abort handling, mid-stream non-retry and Fast classification are unchanged.
The public constructor may still format an explicitly supplied local detail;
the provider path must never pass untrusted text to it.

Tests cover normal and Fast provider paths, direct/nested socket codes,
code-less terminated wrappers, unrelated error identity, fake tokens/bearer
strings/URLs/control characters in all cause messages, and original cause
identity. Assert public message and Runner run_error payload omit the fake
secret while keeping the original raw cause accessible. Update the old test
that expected an arbitrary socket message, rather than retain that disclosure.

## C. Structured classification precedes context-message fallback

In `src/core/compaction.ts`, context overflow codes
`context_length_exceeded` / `context_window_exceeded` are authoritative.
A specific non-context `code` prevents message matching (and wins over a
conflicting `reason`). Only absent/empty/non-string codes or generic request
containers (`invalid_request_error`, `invalid_request`, `bad_request`, `error`,
`request_failed`) may consult `reason` and then legacy text. A specific reason
also prevents text fallback; generic status reasons `failed`, `incomplete`,
`error` and the provider's missing-reason sentinel `unknown_incomplete` may use
it. That sentinel is not positive evidence of a non-context failure. Check exact
strings, not substrings, and keep this local rather than introducing a shared
provider-error framework.

Remove the bare `context length` text alternative. Preserve established
positive text such as `prompt is too long`, `maximum context length`,
`context length exceeded`, `too many input tokens`, and literal context codes.
This is compatibility fallback, not arbitrary natural-language interpretation.
Do not swallow errors or change request tiers, summary accounting or retries.

Tests cover the negative structured tier/auth/quota/protocol/network cases
whose messages mention context limits, generic-container legacy positives,
explicit context code/reason positives, code/reason precedence and empty fields.
Use a real Codex provider with fake HTTP/SSE responses through main Runner and
runSubagent, with enough old history to compact, and assert a tier rejection
causes exactly one request, no summary/checkpoint or retry, original typed
error propagation (main) / crash reason (child), and preserved Fast selection.
Retain positive real-overflow recovery coverage so suppression does not disable
legitimate compact-and-retry behavior. In particular, a real SSE
`response.incomplete` with missing incomplete_details.reason and absent/generic
code plus `context length exceeded` must still recover through both main Runner
and runSubagent (three requests: original, summary, retry; a single checkpoint
on persisted paths). Test that a specific non-context code still suppresses
this sentinel/text combination, and that `content_filter` suppresses fallback
with a generic code.

## D. Documentation and test-root observation

Update `docs/sessions.md` and its Chinese mirror for malformed-tail refusal;
`docs/providers.md` and its mirror for fixed public interruption diagnostics
and structured context recovery. Describe limits without claiming raw causes
are scrubbed or that older broken sessions are repaired.
Add Unreleased notes for the already-unreleased tail recovery/Fast hint fix
and these corrections. Correct `RELEASING.md`, the release-preparation status
and `PROJECT_PLAN.md` using read-only npm/GitHub observations. Preserve dated
historical preparation evidence; do not claim fresh cryptographic verification,
publication or a global upgrade. No version change is part of this work.

The reported ENOTEMPTY is the intentional nonrecursive run-root policy, not a
failed test: the reviewed root contains six deliberately retained visual
fixtures and an explicit bootstrap retention probe, enough to require retention.
There are also contained tsx caches, empty renderer roots and test-generated
output/image files. Keep the retention warning and its evidence; no recursive
root cleanup, OS-temp scanning, TTL, cache redirection or renderer lifecycle
redesign in this correctness batch. Record this investigation and its limits.

## Verification and integration

First close an independent adversarial design review, then implement. Prefer
small disjoint source/test edits. Reuse workspace dependencies without installs.
Use private temp fixtures, fake credentials and the offline network blocker.
Run targeted tests, source/test typechecks, lint, build, the full offline suite,
docs checks and diff checks. Where existing supported Node binaries are available,
run focused regressions on Node 22.19.0 and Node 24; do not download/install tools.
Require independent implementation review before completion. Record exact test
counts, failures and retained temp warnings. Commit normally and integrate to
local main with `--no-ff` after confirming main/worktree state; no remote push.

## Completion and verification

The production changes are confined to three existing files:
`src/core/session/resume-tail.ts` validates only the four tail identity fields;
`src/provider/shared.ts` publishes a fixed interruption vocabulary while
preserving raw causes; `src/core/compaction.ts` applies the approved structured
precedence and retains unknown_incomplete fallback. No Runner, store, provider
request, child-continuation, file-format, version, dependency or workflow change
was needed.

Independent implementation reviews closed with APPROVE and no required fixes:

- `2c7fcf2b-d6ac-4616-85ba-7ad12982865a`: resume-tail, real built CLI regressions
  and sessions documentation; independently verified 186 tests and compiled
  runtime equality, plus a fresh object-ID baseline/current comparison.
- `2fa044b2-ef7a-419d-a6fc-13bd83d8a1f8`: interruption privacy, classification,
  real Runner/child/log persistence and documentation; independently ran 810
  tests across 12 files in a private copy, both typechecks and docs validation.

Final coordinator verification on macOS arm64:

| Runtime | Verification | Result |
| --- | --- | --- |
| Node 25.5.0 | npm run typecheck, npm run lint, npm run build | passed; lint checked 352 files |
| Node 25.5.0 | CI_REQUIRE_SEARCH_TOOLS=1 npm test -- --maxWorkers=6 | 191 files, 6,278 tests passed |
| Node 22.19.0 | both TypeScript configurations, 7 changed/new test files | 739 tests passed |
| Node 24.22.1 | both TypeScript configurations, 7 changed/new test files | 739 tests passed |
| Node 25.5.0 | docs site build, docs checks, git diff --check | 24 pages; 11 topics in each language; passed |

The full suite has 345 more tests than baseline (5,933). Runtime matrix checks
used existing scratch Node binaries, not new downloads or installations. Logs:
`/tmp/ink-review-followups-full-tests.log`,
`/tmp/ink-review-followups-node22.19.0-tests.log`, and
`/tmp/ink-review-followups-node24.22.1-tests.log`.

Tests first demonstrated the original failures before the implementation fixes.
One worker's initial npm typecheck invocation under the offline preload was
blocked attempting a registry check; both direct equivalent tsc commands and
the final coordinator npm typecheck subsequently passed. An isolated-copy docs
check initially lacked README inputs; it passed after those inputs were copied.
These tooling failures did not require changing product behavior or disabling
the network guard.

The final full suite exited 0 and intentionally retained nonempty run root
`/var/folders/y5/4pt277ys42g1kz84rh0g922c0000gn/T/ink-test-run-N8LrT0` with an
ENOTEMPTY report. Supported-runtime focused runs had no retained-root warning.
The earlier review-root investigation confirmed deliberate visual and bootstrap
artifacts plus contained caches/output/image files; this batch does not claim
all test-produced contents have a cleanup owner. No warning was hidden and no
old root was deleted. Raw causes remain unsanitized local debugging data;
public diagnostics and Runner logs alone are covered by this privacy fix.

No real model request, Linux run, fresh registry-artifact verification, remote
push/publication, global upgrade or real-session/configuration change was
performed. npm/GitHub availability was checked read-only; published 0.6.1 and
its tag remain unchanged. Final local integration uses the approved --no-ff
merge, with candidate/merge tree equality checked separately.
