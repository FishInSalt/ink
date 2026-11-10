# Ink 0.5.1 patch-release preparation

Date: 2026-11-10
Status: local candidate verified; independent design and final candidate/artifact reviews APPROVED; publication pending.
Branch: `release/0.5.1`
Base: `67a06302dd51f32ece344722c5d461ea42f73750` (clean local main).
Previous published version: `ink-agent@0.5.0`, tag `v0.5.0`.

## 1. Scope, authorization and release identity

The owner accepted the reviewed pi-tui 1.5.1 upgrade, confirmed physical
Shift+Enter in Terminal.app, approved local commit/integration and requested
continued progress through version publication. The reviewed fix is commit
`9922553`, integrated with --no-ff as `67a0630`; their trees match. No source
behavior changes belong in the release-preparation batch.

This goal does not bypass per-operation safety confirmations. New paid subagent
review, remote pushes, CI/deployment triggers, a version-tag push that can publish
to npm, and GitHub Release creation must be surfaced separately before execution.
The owner separately approved two new paid independent review rounds. Design
review 485f6ba7 returned APPROVE before version implementation; its two
non-blocking documentation findings (authorization and runtime provenance) are
corrected in this record. Candidate/artifact reviewer a70ccde9 subsequently
returned APPROVE for local commit/integration. No global
installation, credential/account configuration, system package install, workflow
change, live provider authorization or inference is included.

Select a patch release because this batch repairs terminal compatibility without
changing the public provider/tool/session contracts. Use only `ink-agent@0.5.1`
and the sole `ink` executable, with tag `v0.5.1`; never republish 0.5.0.

Read-only checks on 2026-11-10: remote main is still `2e3d37b`, no remote v0.5.1
tag exists, npm latest is 0.5.0, and the 0.5.1 metadata URL returns HTTP 404.
Evidence: `/tmp/ink-pi-tui-upgrade.p6K9wY/logs/release-availability.log` and the
recorded git ls-remote output. These checks do not reserve a version; repeat
relevant identity/availability checks immediately before any publication.

## 2. Proposed edits (seven files)

Implementation begins only after fresh-context independent design APPROVE.

- `package.json`: change only application version 0.5.0 -> 0.5.1.
- `package-lock.json`: change only the top-level version and root-package
  version. Preserve every installed dependency record byte-for-byte; do not
  regenerate the lock or retrieve a different dependency graph.
- `src/format.ts`: change only VERSION to 0.5.1.
- `test/package-metadata.test.ts`: update only the deliberate selected-version
  pin, retaining exact CLI/lock/metadata assertions and all negative controls.
- `CHANGELOG.md`: retain an empty Unreleased heading, move the existing approved
  notes into `## [0.5.1] - 2026-11-10`. This is a candidate date, not a claim of
  publication; correct it if the publication date changes. Preserve the entire
  0.5.0-and-older history byte-for-byte.
- `RELEASING.md`: select 0.5.1 as prepared/unpublished, link this record, retain
  the published 0.5.0 history and existing external gates, and update the exact
  smoke-output example. Do not claim npm latest changed before verification.
- This record: retain authorization, review outcomes, actual verification
  counts, artifact identity, residual limitations and eventual publication facts.

Published sessions documents already match the implementation. No new settings,
parser policy, output filtering, UI feature, Node minimum, dependency, schema,
launcher, release workflow or runtime-root change is part of this batch.

## 3. Verification and independent review

Use task-owned HOME/XDG/TMPDIR/npm cache/config and the existing network blocker,
with allowlisted PATH and UV_THREADPOOL_SIZE=16. New release scratch is
`/tmp/ink-release-0.5.1.aRJ55W/`; its run.py is the isolated command harness.
The existing production-dependency cache under
`/tmp/ink-pi-tui-upgrade.p6K9wY/cache` is a read-only source for offline artifact
smoke. Workspace node_modules is owned by this checkout; no installation or
native rebuild is needed. Missing dependencies/cache entries are a stop-and-report
condition, not permission to fetch or execute lifecycle scripts.

After plan approval:

1. Edit the six release files above, then inspect the full diff and all five
   version pins (package, two lock fields, app VERSION, deliberate test pin).
   Compare parsed dependency records and historical changelog bytes to the base.
2. Run typecheck, lint and build before version-dependent CLI tests. Run the
   package-metadata/package-tar/release-guard regressions, identity guard and
   npm >=11.5.1 guard. Build the documentation site and check git diff whitespace.
3. Run the full suite with maxWorkers=2 on macOS arm64 Node 22.19.0 and 24.22.1
   from the SHA-256-verified official archives in task scratch, plus the existing
   local Node 25.5.0 at /opt/homebrew/bin/node. No global runtime is installed.
   Record actual pass/skip counts and any failures without weakening tests.
4. Run offline scripts/package-smoke.mjs against the private cache source.
   Verify exact Ink 0.5.1/help, single-bin npm-exec inference, installed pi-tui
   1.5.1 and forbidden-path/mode checks. Record artifact path and digests.
5. Reuse the task-owned installed-artifact transport driver with the new smoke
   path, without overwriting the prior upgrade evidence. Exercise keyboard,
   native-helper loading, diagnostics and PTY lifecycle/crash cases across the
   three local runtimes. Label simulated Shift separately from owner evidence.
6. Obtain fresh-context independent final release-diff/artifact review. Resolve
   required findings and rerun affected checks. Preserve the accepted parser
   limitation and documented non-atomic external-filesystem limitation.
7. Commit the reviewed candidate, verify main has not advanced untested, merge
   only with --no-ff and verify its tree equals the candidate. Keep the worktree
   clean; no force push, history rewriting, hook skipping or hidden stash.

The previous upgrade already passed 158 files / 4,147 tests on each local Node
runtime, 75 installed-artifact cases and final independent review. Those results
are baseline evidence, not a substitute for rebuilding/verifying version 0.5.1.
The owner confirmed physical Shift+Enter; physical Alt+Enter and Windows remain
unverified. Local macOS results do not replace the supported-Linux CI matrix.

The owner approved two new independent review rounds: design before
implementation, then candidate/artifact review, with focused follow-ups in the
same rounds as needed to close findings and assess publication evidence. These
are additional to the already completed upgrade reviews. Design review 485f6ba7
is APPROVE; final candidate/artifact review a70ccde9 used the second authorized
round and is also APPROVE.

## 4. External integration/publication gates

Each sensitive operation below requires its own explicit confirmation. Inspect
current refs/configuration read-only first; do not alter repository/account gates
or introduce credentials as a fallback.

1. Push the reviewed local main to `https://github.com/FishInSalt/ink.git`.
   This publishes the commits, starts Linux Node 22.19.0/24 CI, and deploys the
   changed public documentation through Pages. Wait for the exact commit's CI
   before proceeding; record actual platform-specific pass/skip counts.
2. After approved CI and renewed version/tag availability checks, create the
   matching annotated local tag and separately confirm its push. Only a tag
   push plus matching INK_NPM_PUBLISH_ENABLED/INK_NPM_PACKAGE gates reaches real
   npm publishing. workflow_dispatch is dry-run only. Verify the selected main
   ancestor, tag and all version identities; do not manually republish afterward.
3. Verify the actual npm 0.5.1 metadata, latest selection, release commit,
   registry artifact contents and source/provenance evidence. Use an isolated
   installation to verify exact version/help and the reviewed dependency.
   A late registry-visibility failure does not prove publish failed: inspect npm
   before deciding, and never rerun a workflow for an already published version.
4. Separately confirm creation of the non-prerelease GitHub Release for v0.5.1,
   using only the dated approved CHANGELOG section for its notes.
5. Record verified publication in this record and RELEASING.md on a dedicated
   documentation branch, validate/review the evidence changes as appropriate,
   integrate only with --no-ff, and separately confirm any record push (which
   again triggers CI/Pages as applicable). Do not mutate the release tag.

A global installation update remains a separate optional operator action after
publication and is not required to finish this release. No release is claimed
complete until the registry artifact and the requested release page are verified.

## 5. Local candidate results

The approved seven-file scope is implemented. The five version pins agree at
0.5.1. Direct byte comparisons against base 67a0630 confirm that the package and
lock files change only the intended three version fields, src/format.ts and its
metadata test change only their selected-version literals, and CHANGELOG adds
only the 0.5.1 heading/date. All dependency records and the entire 0.5.0-and-older
CHANGELOG history remain unchanged. RELEASING selects an unpublished candidate;
no workflow, runtime behavior, dependency or account setting changed.

All results below are from the version 0.5.1 build, not reused 0.5.0 results.

| Local macOS arm64 runtime | Full test files | Full tests | Typecheck |
| --- | --- | --- | --- |
| Node 22.19.0 (verified temporary archive) | 158 passed | 4,147 passed | passed |
| Node 24.22.1 (verified temporary archive) | 158 passed | 4,147 passed | passed |
| Node 25.5.0 (existing local runtime) | 158 passed | 4,147 passed | passed |

- Package metadata/tar/release-guard regressions: 3 files / 211 tests passed.
- Lint: 297 files, scripts syntax, documentation structure/links/parity and
  identity gate passed. Build, release identity, npm 11.8.0 minimum-version
  guard and whitespace checks passed. Documentation site: 24 pages generated
  under task scratch, not deployed.
- Offline artifact smoke: 427 allowed files, tar bytes/paths/modes, private
  installation, exact Ink 0.5.1/help and neutral-cwd local npm-exec passed.
- The copied artifact driver now selects the NEW release scratch/smoke result,
  asserts installed ink-agent@0.5.1 and pi-tui@1.5.1, and retains only read-only
  references to the prior task's Node 22/24 binaries. It writes no old evidence.
  All 75 installed-artifact cases passed (25 each on Node 22/24/25), including
  input routing, real native helper loading, diagnostics and PTY crash/cleanup.
- No unexpected blocked network attempts were recorded. Provider credentials,
  endpoints, HOME/XDG/TMPDIR and npm configuration remained isolated.

Candidate artifact (local identity, not a registry publication claim):

- Path: `/private/tmp/ink-release-0.5.1.aRJ55W/tmp/ink-package-smoke-RHyG8j/artifacts/ink-agent-0.5.1.tgz`
- Size: 819,888 bytes.
- SHA-256: `06a8afcc3e26612cd7e5e4fd2d8d2e3a3c637fef44abf794ff6c4ba2db1d7209`
- Integrity: `sha512-7ZNj23pFxpfSOrT6rAdosf371KYJIwAqhj4S84WCiDB479rkxPygKDzNasV2STEpoROR04CV+F3McsRzQsLWKQ==`

Evidence: `/tmp/ink-release-0.5.1.aRJ55W/logs/`: full-{22,24,25}.log,
typecheck-{22,24,25}.log, lint.log, build.log, identity.log, npm-version.log,
package-regressions.log, docs-site.log, artifact-smoke-final.log,
artifact-tui-final.log, artifact-tui-final-checks.json and artifact-identity.json.
The uncompressed packed file contents must be compared separately if npm
publication later repacks the archive; this local integrity is not automatically
the registry integrity or a provenance attestation.

Final independent candidate/artifact reviewer a70ccde9 returned APPROVE, with no
required candidate changes. The reviewer independently verified all 427 packed
files and installed application bytes/modes, reproduced all 381 build outputs
with a clean scratch-only Node 22 compilation (normalizing source-map output
paths), and compared 12 installed dependencies / 1,967 regular files, including
six native binaries, against integrity-verified cached lockfile archives.
Independent reruns passed the 211 package regressions, all 75 installed-artifact
cases and exact installed version/help on all three runtimes. The reviewer
also audited the detailed 158-file / 4,147-test results for each recorded runtime
without rerunning those three complete suites. Scratch audit-script expectation
corrections required no candidate edits.

Review logs include review-artifact-audit-final.log,
review-package-regressions.log, review-installed-tui.log,
review-installed-cli.log, review-release-invariants.log and review-final-state.log
under the same release evidence directory.

This closes both authorized release-review rounds for local commit/integration.
At review closure no release commit/tag, remote push, CI/Pages deployment,
npm/GitHub publication or global installation had been performed. Local commit
and --no-ff merge follow this record; supported-Linux CI and all external
publication operations remain gated as described above.
