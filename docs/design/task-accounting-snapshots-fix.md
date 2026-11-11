# Task accounting snapshots before tool observers

Status: implemented; revised design and implementation independently approved.
Date: 2026-11-11
Baseline: `main@639eec7`
Branch/worktree: `fix/task-accounting-snapshots`, `.worktrees/ink-task-accounting-snapshots`

## Scope and evidence

Fix release-review finding 3 only: observers of tool_end/tool_settled can mutate
TaskRecord usage/pricing/identity shared with authoritative history and stores.
The mock gpt-5.5 priority report of 1M input tokens costs $2.50 at $1/M base;
changing only reported priority to flex gives $0.50, preserving raw counters and
passing conservation checks. Immediate mutation reaches disk; delayed mutation
can disagree with cached totals and reopened disk. This concerns reference
estimates only, not actual billing. Ordinary extension tool_end projections do
not expose TaskRecord; the demonstrated entry is runTurn({onEvent}).

Do not change issuing-run parent ownership (separate fix), provider routing,
requests, pricing multipliers, token arithmetic, taskResult classification,
scheduler order/concurrency/abort-grace, schemas, session entry kinds or versions.
Do not deep-copy tool content/images or all history. No true API calls, credential
refresh, installs, push, publication or CI dispatch.

Read contracts: SA-03 task-record design; Codex service-tier-pricing design;
docs/sessions.md, docs/subagents.md and docs/extensions.md. The pricing design
requires immutable producing-call accounting, but its previous observer fix
covered assistants and not the tool-result carrier.

## Proposed boundaries

1. Add a pure TaskRecord snapshot helper in task-record.ts, using the existing
   parseTaskRecord validation/copying path. It produces an independent v1 record
   with preserved original timestamp/IDs, copied binding/tools/transcript/worktree/
   health, raw usage and strictly validated copied pricing slices. Do not call
   buildTaskRecord again (it would restamp timestamp/rebound text).
   An absent or structurally invalid record yields no authoritative record;
   valid raw usage survives malformed advisory pricing exactly as today.
   Unsupported/malformed metadata must not crash a valid tool result or acquire
   invented usage: it remains a record-less/unknown-accounting result. Preserve
   unknown extra fields as the parser already does; no promise of deep isolation
   for fields outside the v1 accounting/identity vocabulary. Keep the helper
   provider-runtime-free: extract the existing pure isModelBinding predicate
   unchanged to core/model-binding.ts, re-export it from child-model.ts for
   compatibility, and let task-record.ts import that pure predicate directly.
   Its ChildModelBinding import remains type-only. Do not change validation.
2. At runTool's explicit TaskRecord forwarding, before returning a result to any
   batch observer, retain an independent authoritative snapshot. Keep the
   event-facing result and its original TaskRecord available to observers.
   Use a module-private WeakMap keyed by ToolResult to associate the protected
   snapshot, including an explicit undefined sentinel for absent/invalid input.
   No mutation/freeze of observer objects and no retention after results die.
3. Before first exposure, stamp IDs/duration onto the loop-owned ToolResult
   projection in place, avoiding spreads that would lose its WeakMap association.
   This never mutates the tool producer's returned object. Synthesized,
   validation/gate and truncation results capture their initial absent record
   before exposure too. Use WeakMap.has(), not get() !== undefined, to distinguish
   an already-captured absent/invalid record; never recapture observer data.
4. persistableResult keeps its existing two non-accounting behaviors:
   - If display/duration are absent, history historically aliases the event
     result. Return a metadata-only view: an ordinary object with an independent
     authoritative taskRecord, while its other existing own enumerable fields
     use forwarding getters/setters to the original result. Thus immediate and
     delayed content replacement/isError changes still reach history. This
     view is not a Proxy, does not freeze anything, and adds no bookkeeping to
     model wire content. Key-enumeration/object-identity equivalence is not a
     new guarantee; provider-visible fields retain their existing values.
   - If display/duration are present, retain the existing plain spread that
     removes them and snapshots the other top-level fields at prefix flush.
     Inject only the protected TaskRecord into that result. tool_settled content
     changes before flush remain visible; tool_end top-level changes afterward
     remain excluded, exactly as today. Content block objects remain shared.
   The first concurrent exposure is tool_settled, BEFORE prefix flush, so the
   WeakMap capture must already exist. Observers can still replace/delete their
   own taskRecord without changing history. Non-task tools with legitimate
   records use the same mechanism; absent/invalid records cannot be forged.
5. SessionStore's copyMessagePricing handles toolResult separately: copy its
   message/results envelopes and independently snapshot TaskRecords at append,
   read and compaction retained-tail boundaries. Use the same metadata-only
   forwarding view for each result, so existing content/status references are
   not accidentally severed by this accounting-only change. This prevents later
   producer/history TaskRecord mutation from changing store accounting while
   preserving non-accounting values. Keep assistant copying intact; do not
   revert the prior output-isolation fix. Invalid records remain excluded from
   accounting rather than repaired. Old files are not rewritten; raw valid
   usage with invalid pricing is retained.

The WeakMap approach keeps authoritative metadata independent from event-facing
ToolResult identity, including observer replacement/deletion of taskRecord.
It does not attempt to prevent arbitrary host code from directly mutating
runner.history/getEntries(), nor make untrusted in-process extensions safe.
Existing provider converters, summarizers and token estimators remain unchanged:
TaskRecord never enters model wire content. No content observer behavior is
newly guaranteed; event observation is not a supported accounting rewrite hook.

## Verification and rollout

- Add negative tests before source edits. Reproduce priority->flex via both
  tool_end and tool_settled immediately and through retained references.
- Cover serial and concurrent results, including out-of-order settlement and
  a result waiting for prefix flush; mutate/replace/delete usage, pricing,
  identity/binding and the whole taskRecord. Missing records cannot be forged
  by observers. Assert original token totals, rates, missing flags, calls and
  identity in history, store, cached/rebuilt totals and reopened disk.
- Pin the four non-accounting controls: serial without display tool_end changes
  content/isError immediately and later; serial with display tool_end does not;
  concurrent tool_end does not; concurrent tool_settled does (including delayed
  changes while waiting for prefix flush). Check shared content blocks too.
  Pin absent metadata through grace abandon and reject a later returned record.
- Validate valid legacy records without pricing, malformed pricing with valid
  raw usage, wholly invalid/future records, absent records, rejected/launched
  task statuses and non-task tools. No accidental valid-record restamping.
- Exercise SessionStore directly: producer/history mutation after append and
  compaction/read copies; preserve model-facing tool content and incomplete
  accounting flags. Run real createRunner/task integration as well as loop
  mocks, including multiple child attempts and disabled child transcripts.
- Keep record parsing tests, pricing/accounting tests, loop/task scheduling and
  event ordering, child resume/output isolation, wire/replay and summary receipt
  regressions passing. Typecheck both configs, lint, build, full offline tests,
  artifact smoke and diff checks; reuse installed dependencies read-only.
- Update matching English/Chinese sessions/subagents documentation, Unreleased
  CHANGELOG and SA-03's superseded live-reference transport description.
- Obtain independent implementation review. Commit on the dedicated branch,
  merge locally with --no-ff after approval, then run integrated verification
  with the separate parent-ownership repair. No external release actions.

## Review record

Initial independent review session `55b87451-39b9-4a14-9478-9c3294e4065b`
blocked an always-independent envelope because it changed serial content/status
observer behavior. The revision above explicitly preserves all four existing
paths using metadata-only views and a plain snapshot only where already used.
It also avoids stamp/spread association transfer and keeps store imports pure.
The revised design received explicit APPROVE in the same independent review
session before implementation. Required implementation checks: forwarding fields
must remain enumerable/serializable, getters/setters read/write current source
fields, protected TaskRecord never enters the forwarding set, and pure guard
extraction must retain identical validation and its compatible re-export.

Independent implementation review `6e07361e-5cba-4cb0-953b-ab62cbb9e5ed`
returned APPROVE with no blocking findings. The reviewer independently ran 383
tests (including five additional boundary probes), verified all four content/
status paths and the unchanged binding predicate, and checked validation hashes.

Initial negative evidence: 89 tests, 79 failed and 10 passed before source edits;
the same group passed after repair. Final additions: 128 tests in two files.
Branch verification: related 674 passed across 21 files; full isolated-source
suite 5,037 passed, 0 failed, 0 skipped across 173 files. Source/test typecheck,
lint, build and whitespace checks passed. The no-install artifact check covered
442 files, tar/modes, help and exact version. Complete evidence and hash manifest:
`/tmp/ink-task-accounting-verification-20261111/REPORT.md`. Final combined gates
follow local integration with the separate issuing-run ownership repair.

Two intermediate related runs timed out in the existing loop-concurrency FIFO
case at line 1185. Subsequent single-file 30/30, related 674/674, full suite and
independent review passed; the timeout root cause is unproven. No scheduler or
timeout changes were made. Initial tooling also generated four ~/.npm debug
logs and temporary shared-workspace .vite-temp config artifacts before cache
isolation was corrected. No dependency packages/configuration were changed and
no external cleanup was attempted. Later verification used isolated HOME/cache
and scratch copies with runner config loading. This execution deviation was
disclosed to the user; do not claim every initial tool artifact was isolated.

No true inference, credential refresh, publication, push or CI dispatch occurred.
