# Responses missing terminal output: completion check

Date: 2026-10-30
Status: implemented and locally verified; external release actions pending.
Design review `6d142385`: PASS before implementation.
Branch: `fix/responses-terminal-output-0.5.0`
Base: `cb4f610`; target: unpublished `ink-agent@0.5.0`.

## Scope

The owner requested this fix followed by the 0.5.0 release. Keep the existing
release procedure in [RELEASING.md](../../RELEASING.md); separately surface
external push/publication operations for confirmation before executing them.
No dependency, workflow, authentication, history-schema or global-install change;
no live model calls, session migration or fixes to unrelated residual findings.

Before this correction, a parsed normal terminal response with absent `output`
returned from `CodexOutput.reconcile` before the check used for `output: []`.
Unfinished text/refusal/reasoning can become successful assistant history and
native replay; a separate finalized valid tool can execute. Acceptance of partial
ordinary text predates 0.5.0; preserving native reasoning metadata adds exposure.
Production occurrence and real-provider rejection have not been established.

## Correction

In `src/provider/responses-output.ts`, route exactly `undefined` through the
existing empty-array branch instead of returning. On normal completion, every
streamed slot must have `output_item.done` and final status omitted or
`completed`. Otherwise throw a protocol error before `message_end`, assistant
history admission, persistence or tool execution. Use an error description
covering both missing and empty aggregate output.

Preserve complete per-item output with an omitted/empty aggregate, including
final ciphertext; the real acceptance record establishes `[]`, not omission.
Keep nonempty authoritative text/reasoning snapshots and all function-call
checks unchanged. Keep explicit `max_output_tokens` partial-history retention
and entire-tool-batch refusal. `null` and other nonarrays still fail. Do not add
a blanket item-done check to `blocks()` or use `output ?? []`.

## Tests and documentation

- Correct the existing simplified successful fixtures with actual finalization;
  do not weaken assertions or hide provisional-ciphertext protection.
- Cover omitted and empty aggregates for finalized peers, missing item-done,
  `in_progress`/`incomplete` text/refusal/reasoning peers, and a valid tool peer.
  Assert no successful message, assistant history/persistence or tool execution
  for rejected responses. Reopen the JSONL and capture the next real adapter's
  serialized input to show rejected content cannot reappear on resume.
- Retain authoritative-snapshot, malformed-nonarray, no-output/no-item and
  explicit token-limit coverage. The latter must still refuse every tool.
- Update `docs/providers.md`, its zh-CN mirror and the 0.5.0 CHANGELOG entry.
  This prevents new admissions only: old session files are not rewritten and
  previously accepted incomplete items cannot reliably be identified afterward.
- Record closure of this one residual finding in the release preparation record;
  preserve the unrelated extension-hook, legacy-token and relative-PATH findings.

## Verification and release boundary

Use isolated HOME/TMP/cache and `test/helpers/network-blocker.cjs`, with fake
auth/fetch or loopback fixtures. Run focused Responses tests, typecheck, lint,
build, full tests, release identity/npm-version checks, docs build, diff check
and offline artifact smoke using the existing read-only `/tmp/ink-npm-cache`.
Obtain independent code/artifact review, commit and merge with `--no-ff`.
Before external actions, list the exact commit/package/tag and confirm the
push/publication scope. Push main for Node 22.19.0/24 CI and Pages; only after
those gates pass and version/tag availability is rechecked, push annotated
`v0.5.0` to trigger the existing OIDC workflow. Verify registry artifact,
provenance, then create the matching GitHub Release from the dated CHANGELOG
section. Never retry a successful publication or force/replace a tag. No global
installation is included.

## Local result

Independent source/artifact review `95659395`: APPROVE. Focused tests: 618
passed; full suite: 157 files / 4,105 tests passed. The local full run used
`UV_THREADPOOL_SIZE=16`; the default-pool FIFO timeout was also reproduced on
unchanged `cb4f610`, with no unrelated implementation/test edits. Typecheck,
lint, build, docs and offline package gates passed. Detailed artifact evidence
and the initial failed run are recorded in the release preparation record.
