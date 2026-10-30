# Ink 0.5.0 local release preparation

Date: 2026-10-30
Status: published from `8bc00e6`; see [Publication](#publication) for the final outcome.
Independent adversarial plan review `16eb303e`: PASS before implementation.
Branch: `release/0.5.0`
Base: `cd0535d` (clean local main); previous release `v0.4.4` / `e6d9194`.

## Scope and authorization

The owner confirmed the proposed `0.5.0` local preparation and validation
steps, including an independently reviewed local commit and `--no-ff` merge
to main. No push, local release tag, workflow dispatch, npm/GitHub publication,
account configuration, global installation, dependency install or live model
authorization/inference is approved. Existing `RELEASING.md` external gates
remain in force. Use 0.5.0 because the changed ChatGPT login and tool behavior
require explicit upgrade guidance.

Read-only checks on 2026-10-30: npm latest is 0.4.4, the 0.5.0 metadata URL
returns HTTP 404, and origin has no v0.5.0 tag. These observations neither
reserve the version nor replace checks immediately before publication.

## Planned edits (seven files only)

- `package.json`, `package-lock.json`: set the package and both lockfile
  version fields to 0.5.0; retain the dependency graph, package identity,
  sole executable, scripts and Node minimum. Do not regenerate the lockfile.
- `src/format.ts`: change only VERSION; update the deliberate version pin
  in `test/package-metadata.test.ts` without weakening any assertions.
- `CHANGELOG.md`: retain an empty Unreleased heading and move the candidate
  notes to `## [0.5.0] - 2026-10-30`. This is a provisional candidate date,
  not a publication claim; correct it if publication moves. Preserve all
  0.4.4-and-older entries byte-for-byte. Highlight the required `ink login`
  for old device-code users. Complete the notes for grep/find hidden/VCS,
  config/path/glob/limit behavior and fd capabilities, the prepareArguments
  extension hook, subscription catalog isolation, url_read diagnostics/text
  support, task timeout guidance and documentation discovery improvements.
- `RELEASING.md`: select 0.5.0 as prepared/unpublished, link this record and
  update the smoke-output version. Keep the published-history heading through
  0.4.4 and its historical records unchanged. Clarify the dated-candidate
  convention, without implying publication or changing external gates.
- This record: retain scope, review results, residual risks and verification.

Existing published feature docs already describe the merged behavior; no new
feature, schema, workflow, runtime or build-output edit belongs in this batch.
The checkout-only `.ink/settings.json` change is not an npm default-policy
change. Do not claim read EOF tail recovery (reverted) or guaranteed cache hits.

## Residual review findings

The user selected only the three small regression fixes, now merged. This
initial preparation did not fix the remaining extension-hook rejection/getter
containment, omitted terminal-output native replay boundary, legacy flat-token
logout cleanup, or relative-PATH fd capability identity. The later owner-approved
completion-check fix is tracked below; the other three findings remain deferred.
Preparing the candidate is not blanket risk acceptance.

## Verification and completion

After independent plan approval, run typecheck, lint, build, then full tests
with isolated HOME and the repository network blocker. Build precedes the CLI
version tests. Run release identity and npm >=11.5.1 guards, targeted package
regressions, docs-site checks and offline package smoke with the existing
read-only `/tmp/ink-npm-cache`; no network dependency fallback. Verify installed
help, exact Ink 0.5.0 output, npm-exec inference and tar contents. Compare the
lockfile and historical CHANGELOG sections against the base and inspect the
complete diff. Record artifact path/integrity and actual test counts.

Available runtime is macOS arm64 / Node 25.5.0, npm 11.8.0; do not substitute
it for Linux Node 22.19.0/24 CI. After final independent release-diff/artifact
review, commit and merge locally with --no-ff only if main has not advanced
unverified. Leave the worktree clean. Any push and resulting CI require new
approval; supported-Node CI and a separate publication approval gate the tag.

## Local results

- Final release-diff/artifact review `c7685bf5`: APPROVE for local preparation.
- Full suite: 157 files / 4,073 tests passed; targeted package tests: 3 files /
  211 tests passed. Typecheck, lint (296 files), build and diff checks passed.
- Docs site: 24 pages built. Identity and npm 11.8.0 minimum-version guards passed.
- All five version pins agree; only the two lockfile versions changed, and
  historical CHANGELOG entries from 0.4.4 onward are byte-identical to the base.
- Offline smoke: 427 allowed files; isolated install, Ink 0.5.0/help and local
  npm-exec passed. Artifact size: 815,136 bytes.
- Artifact: `/private/tmp/ink-release-0.5.0.dvdHUi/tmp/ink-package-smoke-yjqP55/artifacts/ink-agent-0.5.0.tgz`.
  Integrity: `sha512-7XcCKzO1btbToHgXW5Tt6VurO/vBewZxUIO1l+2dbG3Z8hAsbXwIUbjsRqd3VXahgmx5pr4G3MX/WVWszC95Fg==`.
- Logs: `/tmp/ink-release-0.5.0.dvdHUi/`. Linux Node 22.19.0/24 CI remains pending;
  no external release action or live model request has been performed.

## Terminal-output completion follow-up

The owner subsequently requested the minimal missing-output completion fix and
then publication of 0.5.0. The implementation design is
[responses-terminal-output-completion.md](responses-terminal-output-completion.md),
independently reviewed by `6d142385` (PASS before implementation). External
push/publication operations will still be surfaced for explicit confirmation.

Missing terminal output now follows the existing empty-aggregate check. Normal
responses with unfinished text/refusal/reasoning cannot enter assistant history
or execute a valid peer tool. Finalized omitted/empty aggregates, authoritative
nonempty snapshots and explicit token-limit truncation remain supported. Existing
session files and replay metadata formats are unchanged; old records are not
rewritten. The extension-hook, legacy-token and relative-PATH findings are not
part of this fix.

The regression tests were first run against unchanged production code: six
related files / 618 tests yielded 606 passes and 12 expected failures, with no
unrelated failure or nonlocal network attempt. The failures cover nine omitted
noncompleted-peer cases and three runner persistence/resume cases.

Integrated local results (macOS arm64 / Node 25.5.0):
- Focused tests: 6 files / 618 passed; full suite: 157 files / 4,105 passed;
  package regressions: 3 files / 211 passed. Typecheck, lint, build, identity,
  npm 11.8.0, docs-site (24 pages) and diff checks passed. No nonlocal test
  requests or live model calls occurred.
- The first full run had 4,103 passes and two failures: a fifth simplified
  successful fixture in `test/images.test.ts` was completed with item-done;
  the unrelated FIFO child-parity test timed out under the default threadpool.
  Unchanged `cb4f610` reproduced the same FIFO result (29 passes / 1 timeout).
  With `UV_THREADPOOL_SIZE=16`, all 30 tests in that file and the full suite
  passed. Only the local test environment changed; no concurrency code,
  assertions or repository/CI configuration was altered for this limitation.
- Independent source/artifact review `95659395`: APPROVE, including byte
  comparison of every packed file and 30 installed-assembler checks. The
  noncontiguous-content negative test retains its specific validation coverage.
- Offline smoke: 427 allowed files; isolated install, Ink 0.5.0/help and local
  npm-exec passed. Artifact size: 815,393 bytes.
- Artifact: `/private/tmp/ink-responses-release.kaKnDx/tmp/ink-package-smoke-0os1Vo/artifacts/ink-agent-0.5.0.tgz`.
  Integrity: `sha512-2eSxTfPtKHuNIi0CktDR4fOQtueZs3dVlCoTw4oYZAHkzoLPMcraxgo+uVmdN+9oLqLRbC0sS4/HKPDbEwrSMw==`.
- Logs: `/tmp/ink-responses-release.kaKnDx/`; pre-fix regressions:
  `/tmp/ink-responses-terminal-tests.QDy1cH/`. The missing-output finding is
  closed for new response admission, not retroactive cleanup. The other three
  residual findings remain deferred. New supported-Node CI, tag and publication
  await the external-action confirmation; version 0.5.0 remains unpublished.

## Publication

Published 2026-10-30. This final outcome supersedes the earlier pending
permission, CI and publication statements, which describe preparation stages.
The owner explicitly confirmed the main/Pages push, matching tag/npm publication,
GitHub Release creation and record push. Record-plan review `c0aef568`: PASS
before this documentation-only batch on `docs/release-0.5.0-publication`;
final independent evidence/diff review: APPROVE. Lint, diff checks and explicit
validation of 14 relative links / 3 anchors passed.

- Release commit: `8bc00e69911727985597ab8d4688b51693985356`.
  Annotated tag object: `3abdc53ec64323e079f03d5be69fd7cec2695afe`;
  `v0.5.0^{commit}` resolves to that release commit, not the later record merge.
- [CI `41071632874`](https://github.com/FishInSalt/ink/actions/runs/41071632874)
  passed on Linux Node 22.19.0 and 24.22.1: each had 157 test files / 4,104 tests
  passed, 1 macOS-only clipboard test skipped, and a 427-file artifact smoke.
  [Pages `41071632967`](https://github.com/FishInSalt/ink/actions/runs/41071632967)
  passed; the public provider page contains the missing/empty-output rule.
- [Release `41073919492`](https://github.com/FishInSalt/ink/actions/runs/41073919492),
  attempt 1: the Node 24.22.1 gate passed with the same test/file/smoke counts.
  The real npm publish succeeded at 14:44:42Z, but its final registry-visibility
  check failed at 14:47:45Z after 12 probes / nominal 180 seconds. npm reported
  processing in progress; individual probe errors were suppressed, so no deeper
  per-probe cause is asserted. No workflow rerun or second publish was attempted.
- Registry metadata reports publication at `2026-10-30T14:48:50.251Z`; independent
  polling first observed HTTP 200 at 14:48:53Z. npm `latest` selects `0.5.0`, with
  the release commit as `gitHead`. Published integrity:
  `sha512-yfml321lA4fQkN2VBnf7EQWeriHNTcg3UuQBJI0OuONQeLTshi6IaMurFH7e71btfyInsJtw+WTjj0+ZbQ4RTw==`.
  SHA-1: `79d6d6c93bc4fd5d0bbddc81787a8e47602728a0` (matches the publish log).
  The registry tarball is 816,766 bytes; its 427 packed files, bytes and modes
  exactly match the reviewed local artifact. Compressed archive bytes differ;
  the local smoke integrity above is not the registry integrity.
- Independent verification used existing npm Sigstore libraries and refreshed
  TUF-authenticated trust data. Registry signatures, the npm publish attestation,
  SLSA provenance, certificate identity and transparency-log inclusion passed
  cryptographic verification. Artifact digest and signed repository/workflow/
  tag/commit agree; provenance log index `3595620334`. Four tampering/identity
  negative controls were rejected. This is not an independent rebuild or a
  security audit of the workflow itself.
- An isolated offline install of the downloaded registry tarball passed exact
  `Ink 0.5.0` and help checks; all 427 installed files match, with no network
  attempts. No global installation, account configuration or live inference ran.
- [GitHub Release `v0.5.0`](https://github.com/FishInSalt/ink/releases/tag/v0.5.0)
  was published at `2026-10-30T15:05:55Z`, not draft or prerelease. Its body exactly
  matches the approved dated CHANGELOG notes plus the full-comparison link.
- Evidence: `/tmp/ink-ci-41071632874.dCarnI/`,
  `/tmp/ink-release-41073919492.bkmj8R/`,
  `/tmp/ink-publication-verify.q5MLJV/`, and
  `/tmp/ink-responses-release.kaKnDx/github-release-0.5.0.json`.

No further npm/tag publication remains pending. Do not rerun the release workflow
or replace the tag/version. The three deferred findings above are unchanged.
