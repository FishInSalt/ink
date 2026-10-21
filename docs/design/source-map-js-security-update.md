# source-map-js security update for Ink 0.4.2

Date: 2026-10-17
Status: locally verified; independent design and final reviews approved.
Branch: `fix/source-map-js-security`
Worktree: `/Users/z/Z/Agent_demo/ink-source-map-js-security`
Base: `6cadcef` (main, already pushed with owner approval).

## 1. Scope and authorization

The owner approved a local dependency-security follow-up before publishing
`ink-agent@0.4.2`. Prepare and commit the fix on this isolated branch; do
not merge, push, tag, dispatch, publish, modify account settings, inspect
credentials, or change the global installation. Retain application version
`0.4.2`, which had not been published at the time of this task. Future
external actions require their own explicit approval.

This is a development dependency fix, not a production-runtime behavior
change. No provider, tool, session, workflow, dependency range, or supported
Node-version changes are planned. Existing worktrees must remain untouched.

## 2. Observed vulnerability and selected patch

Read-only GitHub Dependabot alert #5 reports
`GHSA-68fv-2mgg-jv7q` / `CVE-2026-93749`: indexed source-map section offsets
can cause event-loop denial of service in `source-map-js >=1.0.0 <1.2.2`.
The first patched version is `1.2.2`.

The current locked chain is:

`vitest@4.1.11 -> vite@8.3.0 -> postcss@8.5.28 -> source-map-js@1.2.1`.

The vulnerable package is marked `dev: true` with no production parent.
PostCSS requests `^1.2.1`, which permits `1.2.2`; an override or a new direct
package dependency is unnecessary.

Public registry metadata for exact `source-map-js@1.2.2` reports no runtime
dependencies, the same BSD-3-Clause license and Node `>=0.10.0` requirement,
and these artifact values:

- URL: `https://registry.npmjs.org/source-map-js/-/source-map-js-1.2.2.tgz`
- Integrity: `sha512-KGj/8Y43x35aZVDtt+J4mK1hoLGHULMYfSkODJNQjNDC3oW1PqPoxMwo0pLUsWM/UEGzON/NxeHywEfNXNP3Vw==`

Upstream fix commit `cf7658058ceeaa8619d5ae0ec90be6905209d016`
validates offset integers, caps individual and nested total offset lines at
10,000,000, avoids repeated empty-line insertion after generated code ends,
and removes repeated nested-source getter expansion. It also optimizes large
generated-line gap serialization. Trust the patched package via the exact
registry integrity; no vendored reimplementation is needed.

## 3. Planned changes

- `package-lock.json`: change only the `node_modules/source-map-js` version,
  resolved tarball URL and integrity to the observed `1.2.2` metadata.
  Preserve all other entries and flags; no range or dependency churn.
- `CHANGELOG.md`: add a Security subsection under the unpublished `0.4.2`
  candidate. Identify the development-only transitive update and advisory;
  do not claim this fixes a production-package vulnerability.
- `RELEASING.md`: include the security follow-up in the pending release
  contents, record the initial main push/CI result as historical evidence,
  and require fresh CI after the security follow-up is merged/pushed.
- This record: capture design/final reviews and observed validation results.

Do not rewrite the original release-preparation evidence; it describes its
own earlier candidate. The new artifact/test results supersede that
candidate for the security follow-up. English behavior docs need no change
because runtime behavior is unchanged.

## 4. Validation and installation isolation

Implementation starts only after an independent adversarial design approval.

1. Apply an allowlisted environment to every installation/validation
   command and its children, not only npm ci. Create private scratch HOME,
   XDG config/cache/data/state, npm cache and empty user/global npmrc paths.
   Point TMPDIR, TMP and TEMP to a task-owned scratch directory as well;
   this confines the test harness's stale-fixture sweep to this task. Allow
   only intentional PATH, locale, terminal and validation configuration.
   Do not inherit credentials, proxies, NODE_OPTIONS, npm settings or
   provider/harness configuration; test setup may add its own intentional
   network preload and temporary fixture configuration.
2. Run a clean `npm ci --ignore-scripts --no-audit --no-fund` in this new
   worktree, with an independently owned `node_modules`, explicit public
   registry and private scratch cache. Registry GET downloads are allowed
   as part of this local build/test loop; no audit submission, package
   lifecycle scripts, publication, or shared-cache writes are permitted.
   Do not use a writable dependency symlink or update global packages.
3. Verify installed `source-map-js@1.2.2` and its chain with `npm ls` and
   compare parsed lockfiles. The patched leaf must be the only dependency
   record change; the production graph and all package/app versions must
   remain identical to base.
4. Run bounded, in-memory vulnerability regressions in child processes with
   timeouts. Compare old `1.2.1` from main read-only with new `1.2.2` for
   rejection of oversized/invalid offsets and nested total offsets; creating
   a consumer alone is safe on the old version. Never serialize enormous
   offsets on the vulnerable version. Verify valid indexed-map behavior on
   the patched package and a bounded generated-code exhaustion case. Record
   counts and actual outcomes; do not simulate the expected result.
5. Run typecheck, lint, build and the full offline test suite using the
   repository's existing network blockers and fixtures. No live model calls.
6. Run release identity/npm guards and artifact smoke using the private npm
   cache as a read-only source. The smoke itself remains offline, isolated
   and script-disabled. Verify development dependencies and design records
   are absent from the published tarball; record its integrity and location.
7. Run diff/whitespace checks, obtain independent final code/lock/artifact
   review, resolve findings, and commit locally. Inspect main and all other
   worktrees read-only to confirm no modifications from this task.

A local fix does not close the GitHub alert: closure is verified only after
an independently approved push updates the remote default branch. Local
Node 25.5.0 results do not replace CI on supported Node 22.19.0 and 24.
Even a previously successful main CI run does not cover the new lockfile.

## 5. Review and verification record

Design review round 1: required correction. The validation environment
must isolate every command and child, including all temporary-directory
variables, because the test setup sweeps stale fixtures under tmpdir().
Section 4 now specifies that boundary; no test-framework changes needed.

Design review round 2: APPROVE. The isolation correction is closed, with no
remaining required design changes. Implementation started after this approval.

### Local validation

Runtime and logs are under
`$TMPDIR/ink-source-map-js-security-7a8ms5yt/` (the task's initial scratch
root; validation commands use its private `tmp/` child as TMPDIR).

- Clean script-disabled npm ci installed 60 packages with private HOME,
  config, cache and temporary paths. No global/shared dependency writes.
- Installed chain ends in `source-map-js@1.2.2`. Parsed lock comparison
  confirms only the patched leaf's version, resolved URL and integrity
  changed; production graph and package/app versions are unchanged.
- Bounded baseline checks: old `1.2.1` accepted five unsafe maps (oversized
  line, fractional column, unsafe integer line, negative column, and nested
  total offset). The new version rejected all five. Five additional patched
  checks passed for valid indexed offsets, valid nested offsets,
  generated-code exhaustion, bounded nested sources getter access, and
  generated-line gap serialization. Each child had a 5-second timeout and
  128 MB heap cap; dangerous serialization was not run on the old version.
- Typecheck, lint (271 files plus docs checks), build, release identity and
  npm minimum-version checks passed for `ink-agent@0.4.2` / npm 11.8.0.
- The first full suite could not collect `test/search-tools.test.ts` because
  the intentional allowlisted PATH omitted the existing fd binary. It
  reported 146 files and 3427 tests passed, with one file failed. Added only
  a task-owned symlink to the existing fd executable, then enforced both
  search prerequisites without changing tests.
- A subsequent default-concurrency run reported 3435 passed / 1 failed:
  `test/bash-tool.test.ts` case 4b observed 28 of 30 output ticks. The file
  then passed all 8 tests in three isolated runs. A full lower-contention
  run (`--maxWorkers=2`) passed 147 files / 3436 tests, and a final default
  `npm test` also passed 147 files / 3436 tests. No test or timing assertion
  was changed. The transient output-timing failure remains recorded rather
  than attributed conclusively to this dependency or dismissed.
- Final default suite log: `full-test-default-final.log`; lower-contention
  log: `full-test-maxWorkers2.log`. Earlier failure logs are retained.
- Offline artifact smoke passed for 386 files, tar paths/modes, isolated
  install, help/version and local npm-exec inference. Artifact:
  `tmp/ink-package-smoke-xbaHxx/artifacts/ink-agent-0.4.2.tgz` under the task
  root; 749196 bytes. Integrity:
  `sha512-63pvyyudoM9rfDRdAYoCkst5gQFzLq1IUtQWChNzCnJOVNjvIFxQ/7tuyF3F/JaFIZdlvxl0EK9EdHXySZ630Q==`.
  Manual tar inspection confirms no node_modules, design, test or source
  tree. The production dependency declarations are unchanged.
- Main remains at `6cadcef`; other registered worktrees remain clean.
  Diff checks passed for tracked changes; stage the new record for its
  final whitespace check before committing.

Independent final lockfile/artifact review: APPROVE; no required repository
changes. The reviewer independently confirmed the exact registry metadata,
private cached tarball integrity, all 18 installed upstream package files,
lock-leaf-only differences, unchanged production graph and release identity,
and all 386 release artifact entries against workspace bytes. The strict tar
parser and observed test logs also passed review. Independent bounded
checks confirmed the five unsafe-map rejections and five valid behaviors.

The reviewer's initial extra probe expected column 2 but observed column 0.
An old/new baseline comparison confirmed both upstream versions return 0
for that map; the reviewer corrected the probe and all five valid checks
passed. This was a probe expectation error, not an update regression.

No runtime/source/test code changed, so additional application-code review
was unnecessary; independent dependency/artifact review was performed due
to the security-sensitive lock update. The remote alert remains open until
a separately approved push and GitHub rescan; no source push, merge, tag,
release or global install was performed by this task.

## Publication update (2026-10-21)

`ink-agent@0.4.2` was subsequently published from `76d65cd`: npm `latest`
selects `0.4.2` with `gitHead` `76d65cd`, and the non-prerelease GitHub
Release `v0.4.2` was published on 2026-10-17. The earlier "not been
published" statements describe the pre-publication state of this record.
