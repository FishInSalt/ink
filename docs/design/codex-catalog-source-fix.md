# Restore the subscription model catalog source

Status: implemented; independent design review 7a6eb65e and code review 1232ebf1 PASS.

## Problem and approved scope

The user explicitly requested that the entire `openai-codex` metadata catalog
use `https://pi.dev/api/models/providers/openai-codex` again, rather than the
ordinary `openai` catalog. The latter deliberately caps GPT-6.1 Sol metadata at
272000 for API pricing; the subscription catalog reports 500000. A separately
approved read-only account query also returned `context_window: 500000`.

This is a metadata-source correction, including all fields Ink currently
consumes (windows, output caps, thinking maps, vision and estimated costs).
It is not a transport rollback or an account-metadata discovery feature.

## Changes

1. In `src/provider/catalog.ts`, fetch each family's own catalog. Remove the
   `openai-codex` to `openai` URL remapping; keep base-URL overrides, sanitation,
   ETag handling and the existing four-hour refresh window unchanged.
2. Change the subscription source marker from `openai:chatgpt-direct-v1` to
   `openai-codex:chatgpt-direct-v2`. Retain cache schema version 2 and require
   the exact source marker. Reject the prior OpenAI-derived entry, even if
   fresh, together with its ETag. Preserve other provider entries. Do not
   reinterpret old version-1 or unmarked Codex caches as verified new data.
3. Keep the existing conservative missing-metadata fallback, static tables and
   unscoped runtime-discovery exclusion. When offline before the first successful
   new-source fetch, subscription metadata can remain unknown and the window
   falls back to 131072; do not manufacture 500000 or edit the user's cache.
4. Correct source comments and both published provider pages. Add a short
   supersession note to the original direct-subscription design record; its
   authentication and protocol decisions remain unchanged.

## Boundaries

- Continue OAuth inference at `https://api.openai.com/v1/responses` and account
  availability discovery at authenticated `/v1/models`. Catalog `api`, `baseUrl`
  and model IDs must not configure inference transport or grant account access.
- Do not change credentials, login, billing path, tool protocol, dependencies,
  account-cache schema, thinking fallback tables or compaction policy.
- Existing runner compaction-settings snapshots are not redesigned in this
  source-only batch. Tests must distinguish resolved catalog policy from an
  already-running runner's snapshot; do not claim a live refresh resynchronizes
  both. Existing explicit model selection reconstructs compaction settings.
- No network or inference is required for automated verification. No writes
  to the original checkout, user configuration, sibling pi, or global install.

## Verification

Use injected catalogs with the same model ID and contrasting complete metadata
under `openai` (272000) and `openai-codex` (500000). Assert correct URLs and
provider isolation for context, output caps, cost, thinking and vision; verify
normalization ignores transport fields. Round-trip the new source cache.

Seed a fresh prior-source cache with an ETag: assert it is rejected while other
providers survive, the first fetch goes to the Codex catalog without the old
validator or a forced refresh, and the result persists/reloads as the new source.
Cover rejection while offline and preservation of a valid new-source cache on
failed revalidation. Retain version-1/unknown-source rejection coverage.

Run focused catalog, model/compaction, thinking and Responses transport tests;
then typecheck, lint, build, the offline full suite and `git diff --check`.
Obtain an independent implementation review before completion. Do not commit,
merge, push or install globally without a separate user request.

## Reviews and results

- Independent design review 7a6eb65e: PASS, no blockers. Confirm the source-marker
  boundary rejects old freshness/ETags, test new-source 304 reuse, preserve
  transport/account separation, and do not imply runner snapshot synchronization.
- Independent code review 1232ebf1: PASS, no blockers. Remaining source/test
  comments were corrected to describe the subscription catalog or frozen
  offline fallback accurately; no fallback behavior changed.
- Test-only reduction review 170615a3: PASS. Removed formatting/compaction
  assertions and two redundant cases; migration, 304 and cached-network-failure
  coverage remain intact. Runtime code and published docs were not changed.
- Final verification on Node 25.5.0: focused 6 files / 169 tests, full offline
  suite 156 files / 4039 tests, typecheck, lint, build and `git diff --check`
  passed. The full suite emitted two MaxListenersExceededWarning messages from
  test subprocesses; no tests failed. No live credentials or inference were used.
- Work is isolated on fix/codex-catalog-source in a temporary worktree; the
  original checkout is left to the other session. No commit, merge, publish,
  global install or user-cache edit was performed.
