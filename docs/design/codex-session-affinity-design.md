# Minimal Codex session affinity

Status: implementation and runner RunContext refactor independently reviewed;
prior full offline verification complete.

## Problem and scope

Codex requests lacked stable conversation-affinity metadata. Keep the
three-field affinity bundle as the leading minimal candidate from the
synthetic investigation, not a guaranteed cache-hit fix.

Production changes are limited to src/runner.ts, src/core/loop.ts,
src/core/subagent.ts, src/provider/types.ts and src/provider/codex-responses.ts.
There is no new production module or dependency. Native replay,
encrypted-content include, diagnostics, usage-counter changes, MCP changes
and developer experiment tools are outside this deliverable. Existing session
schema, history conversion, tool validation, logging and usage stay unchanged.

## Conversation identity

- `sessionId` is optional on LLMRequest and loop options; existing direct
  callers may omit it. Other providers ignore the field.
- The runner captures the persisted session header ID once per run. Resume
  restores it; `/new` replaces it. With sessions disabled, one in-memory UUID
  lasts for the conversation until `/new`.
- Tools, steering, follow-ups and overflow retries keep the captured identity.
  A live session change affects the next run's identity, not the active run.
- Children use their own persisted ID or a fresh UUID per no-store invocation,
  retained across that invocation's retries. Never inherit the parent ID.
- Summarization requests remain unkeyed. No session-file fields are added.

## Codex wire contract

Hash the complete nonempty string with SHA-256 and domain prefix
`ink-codex-session-v1\0`. Do not trim or truncate it. Use the same 64-character
lowercase hexadecimal digest in `prompt_cache_key`, `session-id` and
`x-client-request-id`. Missing, empty or non-string IDs omit all three fields.

This produces bounded, header-safe values without sending the raw ID in these
fields. It is not an anonymity guarantee or a separately measured cache
optimization. Keep the three fields together: the investigation did not
isolate their individual effects. All other Codex request/response behavior
remains unchanged.

## Runner snapshot

The module-private `RunContext` groups exactly model, provider, settings,
session, sessionId and modelReference. Capture it synchronously before
`emitRunStart`; derive the qualified model reference from the captured model
and the runner's providerName, not LLMProvider.name.

Pass the same context through runTurnOrRecoverFromOverflow and every
runTurnInner invocation, including retries. Keep RunTurnOptions and the
per-run health monitor separate. At the runAgentLoop boundary, pass individual
options explicitly; do not expose RunContext or SessionStore to loop/provider
APIs or bind identity to a shared provider instance.

Readonly is shallow and compile-time only; do not freeze or clone its objects.
This is parameter grouping, not full run isolation. Preserve existing live
this.sessionStore reads in onMessage/compactAndSplice, live summary budget
and thinking reads, and history, cancellation, event and accounting behavior.
Do not introduce implicit/global identity state.

## Evidence and limits

Attribution report: `.ink/codex-cache-experiment-g9Rs2h/report.json`.
SHA-256: `4fe8dac3d8ae8b61a291d9186aef77660af6bf57864a4a715317f258a36b5d0e`.
The report and preserved research records are local, not package contents.

Affinity-only A1I0N0 reported 5376/5627 cached tokens (95.5394%), versus
0/5627 for A0I0N0. All four A0 cells were zero, but two other A1 cells were
also zero. Each cell had one conversation, and all N0 cells preceded N1,
creating time/order confounding. Native replay/include were not necessary
for the observed affinity-only hit; they are not part of this implementation.

Two initial final-code batches stopped before any current-provider requests:
NETWORK_FAILURE (2 attempts), then a 45-second baseline-continuation deadline
(3 attempts, HTTP 200 but no terminal/usage). Their observations are not pooled.

The third batch used the actual final provider build and pinned original
baseline, with 300-second call and 1800-second total deadlines. One isolated
probe and 12 stepwise-interleaved comparison calls completed without retries;
all had terminal usage/cache counters and normal EOF. Excluding the probe:
- Cold: both variants 0/11118 cached input tokens, two calls each.
- Continuation: baseline 0/22644; current 16384/22644 (72.3547%), four calls each.
  Current had cache reads in 3/4 continuations; one explicitly reported zero.
- Two conversations per variant, reversed execution order in the second pair;
  independent histories, balanced early nonces and aligned affinity verified.

Report: `.ink/codex-cache-experiment-final-minimal-v3/run-EpWkof/report.json`.
SHA-256: `6e40d82597ac5abb403b5ef21c3dfde4f66d0daf3f0b7176d8ecf3f835e5a4ca`.
Independent result audit passed (`0e206816`). This is measured improvement in
a small synthetic direct-provider workload, not full CLI/runner execution or
a universal cache-hit, individual-header, latency or billing guarantee. Time,
backend and conversation variability remain. The batch used 13 POST attempts,
49 cumulative. Preserve all evidence and consumed reservations; no further
inference is authorized under this batch.

## Review and verification

Both designs passed independent review before implementation; both
implementations passed independent review. Review references: minimal design
`d495fede`, implementation `8a8ba3d4`; RunContext design `2eca5ae0`,
implementation `027852ad`.

Latest prior offline verification:
- `npm run typecheck`, `npm run lint`, `npm run build` and `git diff --check`
  passed, including documentation links/parity/anchors.
- Full suite: **149 files / 3500 tests passed**, including 29 Codex provider
  tests and 21 affinity lifecycle tests. Coverage includes exact wire deltas,
  Unicode/CRLF and long IDs, invalid-ID omission, resume/new/no-session,
  child/retry isolation, unkeyed summaries, and model switches at run_start
  and tool_end followed by overflow recovery.
- Build inventory: 114 sources / 342 outputs, with no missing or orphaned
  outputs. Withdrawn codex-replay/codex-diagnostics generated modules are absent.
