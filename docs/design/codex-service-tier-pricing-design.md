# Codex service-tier reference pricing (batch 2)

Status: implemented after independent design approval in session
`ac8e07a5-b117-497b-a7fd-c823a6af6e9d`. Both independent implementation reviews
approved: pricing/accounting `c95462e7-b07e-48dd-ba81-b384fc7b02f7` and
persistence/compaction/runner `37e12b7e-d8fc-49a0-8b67-428ee221d87e`.
Verification: 4,870 tests passed across 170 files; build, source/test typecheck,
lint and diff checks passed. Batch 1 was integrated before implementation.
Worktree/branch: `.worktrees/ink-fast-pricing`, `feat/codex-service-tier-pricing`.

## Goal and boundaries

Include service-tier adjustments in the existing catalog-based reference cost,
without changing any raw usage counter, base provider/model identity, request,
selection, transport, credential route, capability decision or context estimate.
This is a local estimate, NOT actual charges, subscription allowance units,
processing-tier confirmation or a reason to reject a completed response.
No additional real inference requests, auth refreshes, installs or publication.

The accepted batch-1 AssistantMessage.serviceTier contains a validated
ServiceTierReport `{ requested: "omitted" | "priority", reported?: string }`.
Pricing must consume observations captured at the producing call, never current
runner speed, a display suffix, session model selection or model-name patterns.

## Pure rule and traceability

Pin a pure reference-pricing table to Pi revision
2cac4f1a934cdc4a80b05a7d8ff2543cf5ee623c, source
https://github.com/earendil-works/pi/blob/2cac4f1a934cdc4a80b05a7d8ff2543cf5ee623c/packages/ai/src/api/openai-codex-responses.ts#L623-L660.
Expose source/version constants and include the applied rules version in the
priced result when Codex estimates contribute. Current catalog rates remain
current estimates, as before; do not pretend to persist historical invoices.

Resolve an estimate WITHOUT rewriting ServiceTierReport:

- Reported default or absent: use captured requested priority, otherwise base.
- Reported priority or fast: priority (fast is the documented alias).
- Reported flex: flex, even when priority was requested.
- Reported standard, auto or scale: base reference rate, matching Pi's default
  multiplier behavior. This is not verification of those tiers' billing terms.
- Other reported values: retain the base-rate reference estimate but mark the
  tier adjustment incomplete, rather than silently asserting a known multiplier.
- Absent/invalid observations on legacy Codex usage: preserve the previous base
  estimate and mark tier adjustment incomplete for positive usage. Never infer
  historic normal/Fast from the current selection. Other providers are unchanged.

For openai-codex ONLY, priority multiplies all four monetary rate components by
2.5 for the EXACT base id gpt-5.5 and 2 for other ids; flex multiplies by 0.5;
base by 1. The otherwise-2 rule is explicitly a Pi-compatible estimate assumption,
not a guarantee for unknown/future models. Prefer no new live price discovery.
Unknown catalog rates stay unpriced. Zero rates remain zero estimates, not proof
of free subscription use. Missing usage remains unknown, not a zero-cost report.

## Per-report pricing slices, not a mutable global multiplier

Keep Usage numeric-only. Introduce a pure optional UsagePricingSlice sidecar:

    { usage: Usage, serviceTier?: ServiceTierReport }

A missing observation means legacy/base-only estimate, not a claim of standard
processing. Child outcomes/TaskRecords and summary results/entries carry an
optional `usagePricing` array of these slices. Parent assistant messages already
carry their own single observation. The producer collects each message_end's
usage and observation before observers, retries, history mutation or rejection;
all token categories are copied, never multiplied. Slices with identical reports
may be coalesced; preserve all four category totals. When there are no service-
tier observations, omit the optional sidecar and retain old behavior.

Extend recordUsageReport with an optional observation; AttemptUsage captures
attribution for BOTH task and summarizer reports. Snapshots deep-copy it. Forward
it through SubagentOutcome and BOTH fresh/resumed TaskRecord terminal paths, even
when transcripts are disabled or execution fails. Do not read child transcripts
for parent accounting. Existing task and summarizer raw subtotals, report counts,
call counts, missing flags and attemptId deduplication remain unchanged.

runSummarizer collects its local slices independently of a surrounding attempt
ledger. summarizeWithRetry concatenates/coalesces first and second hop slices;
never label combined usage with only the last report. Successful compaction and
branch summary results forward all slices to their single existing summary entry.
A child's shared attempt ledger is the sole parent-facing owner of its summary
usage; never also scan child entries or emit parent-side receipts for that work.

## Already-reported usage on rejected parent summaries

Current parent compaction/branch summaries lose captured reports when the summary
is capped, empty, aborted or a later hop throws. Fix this scoped accounting gap
rather than claiming those usage-bearing retries are priced.

Add an additive SessionEntry kind `summaryUsage`: accounting-only usage, optional
usagePricing, model/modelReference and usageMissing. It must not advance the
active leaf, become a navigable tree node, enter buildContext/retainedTail/replay,
change names/thinking/model, or count as a user/assistant turn. Treat it as a
file-level accounting receipt, similar to the non-positioning label mechanism;
raw whole-session totals scan it. New readers continue reading all old files;
older binaries need not understand this newly introduced entry kind. No existing
session file is rewritten and the session header version remains unchanged.
Restore must exclude receipts from the last positioning-entry index: a receipt
after a position marker must not supersede that marker. Reject receipt IDs as
navigation/position targets. Do not copy the current label restore-index behavior
without this receipt-specific check.

For compactSession WITHOUT an externally supplied child attempt ledger, create a
per-invocation local ledger and pass it to compactHistory. If summary computation
throws after any stream started, append one accounting-only receipt containing
all captured reports and missing flags, then preserve the original error. Null
(no summary call) creates no receipt. A successful summary is accounted ONLY in
the accepted compaction entry. Do not create failure receipts around a successful
checkpoint append, where write-error ambiguity could duplicate persisted usage.
The current-store resolver routes FAILED receipts only; it must not invalidate a
successful run-owned compaction. Accepted checkpoints and continuation history
belong to the captured run/store even after /new or /resume. Only mirroring into
the currently displayed history is conditional on still owning that live view.

For Runner.navigateTree, capture the original store, base model and reference
before the await, pass a local ledger to summarizeBranchSegment, and persist one
receipt if computation fails/aborts or a completed summary cannot be installed
because the active store changed. Receipt ownership is the original session/FILE
identity, not merely an object instance. If the runner reopened that SAME file
(canonical filePath plus header.id) as a new active store, perform the ONE durable
append through that replacement store so its in-memory entries/totals include it.
If the active store represents a different file/session, append to the original
store only. Apply this routing rule to runner-owned compaction receipts too; an
optional current-store resolver can be passed to the compaction wrapper. Never
append twice or synchronize by writing a duplicate. No general concurrent-writer
watcher is introduced. Receipts never change either store's leaf or context.
Normal accepted branch summaries carry usagePricing only on their existing entry.
Use one guarded receipt-finalization path so error handling plus the store-change
guard cannot account for the same invocation twice. The pure summarizer
API cannot persist by itself; external callers can supply their own ledger.
Receipt-write errors must not hide the primary failure; disclose persistence
failure through existing logging/diagnostics, without claiming durable accounting.
Do not broaden this batch to recovering server usage never exposed as message_end,
or repairing arbitrary filesystem-write failures. Such unknown work stays unknown.

## Aggregation and persisted-data validation

Keep raw parent/child/summarizer/total/byModel bucket counters and existing calls
semantics unchanged (one TaskRecord remains one contributing child bucket call,
not one per internal report). Add optional pricing subdivisions to ModelUsage;
each model's slices must cover exactly the corresponding four token totals.
Mixed old/new records need explicit legacy slices so ordinary/legacy work is not
multiplied by a later Fast choice. Incremental views and rebuilt views must agree.
Do not count retained-tail copies, receipts plus accepted summary entries, or
repeated task attemptIds twice. Receipts are global work facts, not branch context.

Validate additive sidecars at every persisted boundary: numeric finite nonnegative
slice counters, optional cache counts, validated copied observation fields, and
componentwise conservation against the authoritative aggregate. Pricing validation
must reject a supplied malformed reported value BEFORE the batch-1 sanitizing
parser can silently drop it and retain requested=priority; sanitization success
alone is not strict pricing validity. Apply this to persisted individual message
observations as well as aggregate slices. Invalid sidecar
metadata must never erase valid raw usage or invalidate an otherwise usable
TaskRecord. Fall back to its base estimate with an incomplete-tier marker, never
silently apply a partial subset or create negative residuals. Snapshots/builders/
parsers deep-copy nested arrays, counters and observations. A valid slice without
an observation is retained as legacy, not reclassified using other slices.

priceUsageTotals prices each slice once against the producer's base catalog
rates; do not additionally price the aggregate. Multipliers never apply to other
providers. Add an optional pricingIncomplete result/format flag, separate from
known-missing usage: `~` indicates incomplete reference pricing; `!` still means
missing usage. Preserve all existing unknown-rate/subscription markers. Update
all three money consumers (session stats, footer, /status). Detailed status/docs
explain base-only legacy/unknown-tier estimates and Pi-compatible rules; no
per-turn warning or claims of actual charges. No configuration/strict-mode knob.

## Verification and rollout

Hermetic tests cover pure rule/source version, all four token categories,
priority gpt-5.5/other/future ids, fast alias, flex mismatch, default/missing,
unknown tiers, legacy malformed sidecars/conservation, zero and unknown rates,
ordinary/Fast/ordinary under one base, provider/model changes, selection changes,
reload/branch/incremental equivalence, summaries with mixed retry reports,
first report then retry failure, both capped, empty, aborted and session-swapped
branch summaries, receipt non-positioning/context/tree/replay behavior (including position markers
followed by receipts, null positions and rejection of receipt navigation targets),
same-session reopen during a gated failed or successful-but-not-installable
summary (ONE durable receipt, unchanged leaf/context, live versus reopened totals
identical), and no receipt for successful/never-started summaries. Cover child fresh/resume, disabled
transcript, failure outcomes, missing flags and defensive dedupe. Verify no
pricing metadata reaches provider wire content and token totals remain identical.

Update English/Chinese providers, sessions, subagent/CLI pages where affected,
CHANGELOG and superseded Fast design statements in this batch. Run build,
typecheck, lint, full tests and diff checks. Obtain independent code reviews of
accounting/persistence and pricing/display scopes before completion. Main merge
uses --no-ff; no push/global installation is included.

## Implementation review and regression record

Full integration first exposed two existing Codex conversation-affinity tests:
blanket invalidation of successful compaction on /new or /resume broke captured
run continuation. Remove that extra gate and preserve captured session/history;
four gated automatic/overflow regressions now protect the origin and replacement
views. The 23 original affinity tests remain unchanged and pass.

Independent review then reproduced accounting mutation through observers. The
accepted parent message now snapshots all counters, missing status and strict
copied tier metadata before provider-event observers. Persistence owns copied
usage/tier data, and extension message_end/run_end payloads do not own history or
returned accounting. Content-block sharing and event order are unchanged. Eighteen
parent-observer and twelve real Runner/ExtensionRegistry regressions cover
immediate, replacement and delayed mutation, live/rebuilt/reopened totals, prices
and context anchors. The reviewers independently repeated the failing probes and
confirmed both fixes before approval.

Final worktree verification report: /tmp/ink-fast-pricing-check.keWvPI/tests.json
(4,870 passed, 0 failed, 0 skipped; 170 files). The independent pricing reviewer
also exercised malformed observations, invalid sidecars and mixed grouping;
the persistence reviewer independently ran 303 tests across 10 files.
