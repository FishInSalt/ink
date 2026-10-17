# Session-cumulative cache hit rate

## Scope

Replace the TUI footer's last-cache-reporting-response CH with a cumulative,
input-token-weighted rate computed from the same session totals as the adjacent
usage counters. The user approved reusing those counters without changing
provider normalization or accounting.

## Contract

- Read `runner.usageTotals().total`, just as the existing footer does for
  input, output, cache-read and cache-write counts.
- Calculate `CH = 100 * R / (I + R + W)` from the raw numeric totals; `I`
  corresponds to the displayed input arrow, not output.
- Keep one decimal place. Do not average per-response percentages or use
  formatted/abbreviated token strings.
- Positive denominator with zero cache reads displays `CH0.0%`, even if no
  response carried a cache-read field. A zero denominator omits CH, including
  output-only usage. Cache-write-only input also displays `CH0.0%`.
- Scope is the existing durable whole-session aggregate: all recorded parent
  calls on all branches, managed child attempts and summarization. Compaction,
  model changes and branch changes do not reset those totals. Reopening the
  same session restores them; `/new` starts a new aggregate.
- Preserve the existing footer gating: without a session (`totals === null`)
  the usage segment remains absent. No new labels or missing-data markers.
- Remove the scan over live history for `lastCacheUsage` and its unused Usage
  type import. Context estimation remains unchanged.

## Non-goals and limitations

No provider, persistence, usage aggregation, pricing, refresh-cadence or context
changes. Existing missing-cache/usage interpretation is inherited from the
adjacent counters: the rate describes the recorded numeric totals, not a claim
that every provider reports complete cache usage. No new live/last-response CH,
rolling window, schema, settings or dependencies. Historical design documents
retain the previous behavior as historical context; this document supersedes
those descriptions of CH only.

## Changes

- `src/repl/repl.ts`: replace response-local CH with the aggregate formula.
- `test/repl-status.test.ts`: update the cumulative expectation; cover a
  positive-hit response followed by zero or absent cache reads, no-cache input,
  zero/output-only input, cache-read/write-only input and non-round counts
  that distinguish raw arithmetic from formatted token strings.
- `test/repl-tui.test.ts`: use the existing persisted-session seeding helper
  to verify all-branch parent, child and summary counts feed CH after reopen
  and compaction, then verify `/new` resets the statistic.
- `docs/sessions.md`: explain the counters, formula, scope, display conditions
  and recorded-data limitation within the existing session section.

## Validation and review

1. Obtain independent adversarial design review before implementation.
2. Change/add regression tests and run the focused suites against old code,
   recording failures that distinguish cumulative CH from the old selection.
3. Implement the minimal formula replacement and update user documentation.
4. Run focused tests, typecheck, lint, build and the full test suite. Use the
   repository's network blocker and fixture isolation; no real provider calls.
5. Obtain an independent implementation review because this changes a
   user-visible statistic and its edge cases. Resolve findings and reverify.
6. Leave the dedicated branch for the user; do not publish, install globally,
   merge or create a release as part of this change.

## Review record

Independent adversarial design review: APPROVE, no required corrections.
The reviewer confirmed the aggregate scope, inherited missing-data semantics
and regression plan. Test caution adopted: absence/reset assertions must use
post-action terminal write marks so historical frames cannot satisfy them.

Independent adversarial implementation review: APPROVE, no blocking findings.
The optional raw-versus-formatted-count regression was added: input 1049 and
cache reads 1951 display `CH65.0%`, not 66.7% from the abbreviated counters.

Validation results:

- Before implementation, focused regression run: 6 intended failures,
  3 passed, 248 skipped. Observed old 19.0% versus expected cumulative 25.5%,
  stale 90.0% versus expected 45.0%, and live-history 44.4% versus whole-session
  55.9%, plus missing CH0.0% cases.
- Initial related suites: 3 files, 275 tests passed. Independent review run:
  2 files, 257 tests passed.
- Final `npm run typecheck`, `npm run lint` (270 files, docs checks included),
  and `npm run build` passed.
- Final full test run with the repository network blocker:
  `npm test -- --no-cache --configLoader runner --reporter=default` —
  146 files, 3110 tests passed. No real provider calls.
- The test runs emitted MaxListenersExceededWarning diagnostics; they did
  not cause failures. The earlier lint formatting finding was fixed and
  the final lint run passed.
