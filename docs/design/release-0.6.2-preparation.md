# Ink 0.6.2 release preparation

Date: 2026-11-12
Status: published and verified; documentation record independently reviewed;
remote documentation push pending separate confirmation.

> **Publication supersedes preparation-time pending statements.** The
> [Publication](#publication) section records completed source/tag pushes,
> exact-source CI, npm publication, registry verification and the formal Latest
> GitHub Release. Sections 1–6 preserve dated preparation and follow-up evidence,
> not a current claim that publication remains pending. No global installation
> was updated; this documentation record authorizes no new external operation.
Design review `86c9497f-a014-4191-88a0-9d0ff386c4e2` returned APPROVE before
metadata changes.
Branch/worktree: `release/0.6.2`, `.worktrees/ink-release-0.6.2`.
Base: main `2535855467b2a1dae80dc4dde3050ed175922818`.
Previous release: `ink-agent@0.6.1`, tag `v0.6.1`, source `5457731`.
Evidence root: `/tmp/ink-release-0.6.2.T6vS1Y/`.

## 1. Scope and approval boundaries

The owner requested pushing the reviewed changes and releasing 0.6.2. The
already-disclosed main push 5457731 -> 2535855 was approved and completed. Its
first attempt timed out with no output; remote inspection proved it unchanged
and no push process remained. A command-local gh credential helper then pushed
successfully without changing Git configuration. Initial CI run 43203792378 and
Pages run 43203792634 both completed successfully for 2535855; these are not
release-candidate results.

Prepare a maintenance patch containing the reviewed two original fixes and two
error-handling follow-ups: resume-only final-tool-batch recovery (including
malformed identity refusal), explicit-tier-only Fast guidance, fixed public
stream-interruption diagnostics and structured context-overflow classification.
No new behavior, dependencies, workflows, session format, auth/trust policy or
installation changes. Preserve all existing commits, branches and worktrees.
Use one preparation commit plus the required --no-ff merge, rather than splitting
metadata, notes and review records into extra commits.

Publication is not implied by preparation: separately confirm the exact
release-candidate main push, the annotated tag push that triggers real npm
publication, GitHub Release creation and any publication-record push. Never
force-push, reuse a version/tag, change gates or install/update global packages.
Do not alter real user sessions, credentials, configuration or the running Ink
installation. Global upgrade is not part of this request.

Read-only preflight on 2026-11-12 found exact npm 0.6.2 HTTP 404, no remote
v0.6.2 tag, and gates INK_NPM_PUBLISH_ENABLED=true / INK_NPM_PACKAGE=ink-agent.
These observations do not reserve the version/tag; recheck before publication.

## 2. Metadata and notes

Implementation starts only after independent adversarial design approval.
Change exactly five identity pins together: package.json version, both root
package-lock.json versions, src/format.ts VERSION, and the exact version
assertion in test/package-metadata.test.ts. Do not run npm version/install/ci
against shared dependencies or regenerate the lockfile. Verify parsed package
and lock contents are otherwise identical to the base, including all dependency
entries, pins and bin/engine declarations.

Keep an empty Unreleased heading and move the complete current notes into
`## [0.6.2] - 2026-11-12`. Preserve the 0.6.1-and-earlier changelog bytes. Keep
the four substantive fixes, their limited scope and no-replay/no-normal-fallback
caveats. Reword the release-documentation bullet only to avoid implying that
0.6.2 itself cannot be published. Describe the cause-message privacy fix without
claiming raw cause sanitization or confirmed real credential exposure.

Update RELEASING.md with an explicitly unpublished 0.6.2 candidate while keeping
0.6.1 as the current published observation, link this record and update its exact
smoke version example. Add one preparation entry to PROJECT_PLAN.md, preserving
historical entries. Existing bilingual behavior docs are already correct; no
new user-visible behavior is introduced by this metadata batch. Record only
checks and approvals actually completed, and correct the date if it changes.

## 3. Local validation, artifact freeze and independent review

Use worktree-local read-only shared node_modules and existing scratch runtimes;
never npm ci/install into that symlink. Isolate generated outputs, logs, HOME,
XDG, caches, fixtures and prefixes to workspace or private /tmp roots. Disable
npm update notifications; tests use the existing offline guard and fake/loopback
providers, never real model requests or user resources.

- Run source/test typechecks, lint, build, full tests, release identity and npm
  version guards, docs-site build and diff checks. Repeat full tests and both
  typechecks on existing macOS arm64 Node 22.19.0 and 24.22.1 runtimes, reporting
  these as local results, not Linux CI or official runtime-signature evidence.
- Run the existing offline package-smoke with read-only cache source
  `/tmp/ink-release-0.6.1.VVf5Da/npm-cache`; preserve the candidate tarball, file
  bodies/modes, installed exact Ink 0.6.2/help/local npm-exec evidence and archive
  digests. If dependency cache misses, report the failure rather than fetch or
  implicitly install scripts. Compare the packed content to this candidate.
- Verify relevant resume, Fast, privacy and context-recovery regressions plus
  package metadata/tar/guard tests against a fresh build. The full suite includes
  built CLI interruption and resume probes. Do not claim a new real-provider,
  entitlement, GUI/IME or full real-terminal PTY acceptance run.
- Obtain independent fresh-context source/notes/artifact review. Close required
  findings, then commit normally and merge --no-ff after checking main has not
  advanced. Confirm candidate/merge tree equality, rebuild and run integrated
  identity/package regressions. Retain/report nonempty test roots; no cleanup
  policy, deadline or assertion weakening.

## 4. External sequence (separately confirmed)

1. Present exact reviewed release main SHA and request its push. Confirm remote
   ancestry and push normally; use only command-local existing gh authentication
   if the default osxkeychain helper still blocks. Verify Linux Node 22.19.0/24
   CI and Pages for that exact SHA. Inspect any failures; do not silently rerun.
2. Recheck identity/date/version/tag availability, ancestry and unchanged gates.
   Present exact annotated v0.6.2 target and ask before tag creation/push. Explain
   that tag push triggers public npm publication with OIDC provenance; do not
   use dispatch, manual npm publish, token fallback or force operations.
3. Monitor run/attempt. Successful or uncertain real publish must never be
   automatically repeated, even if later registry visibility checks fail. Inspect
   complete logs plus registry state; a temporary 404 does not prove nonpublish.
   Verify exact/latest metadata, gitHead and official tarball integrity and file
   bodies/modes against the reviewed candidate, isolated installed version/help,
   and cryptographic registry/publish/provenance identity where available. Match
   digest, repository, release.yml, OIDC issuer, tag, SHA and actual run/attempt.
   Report unavailable checks instead of inferring them from a URL or green run.
4. Separately request creating the formal non-prerelease GitHub Release with
   only the approved dated changelog notes. Verify tag, body and latest state.
5. Record verified results in a separate docs worktree, independently review and
   merge --no-ff; request any remote documentation push separately. No global
   install/upgrade or production-state change follows automatically.

## 5. Local execution and evidence

Only the five version pins, dated candidate notes and preparation records changed.
`metadata-comparison.json` independently compares parsed package/lock objects
with base after replacing only their version fields; all dependency and other
metadata are identical. The `0.6.1` and earlier changelog bytes are unchanged.
Approved candidate notes are `release-notes.md`, 1,739 UTF-8 bytes, SHA-256
`640c3894fd16c5ac47d7517bd2bf2a4b0b57c0706e10e196cfab95db4bf03d23`.

All local runs used required search tools and the existing offline test boundary:

| macOS arm64 runtime | Both typechecks | Full files/tests passed | Skipped |
| --- | --- | --- | --- |
| Node 25.5.0 | passed | 191 / 6,278 | 0 |
| Node 22.19.0 | passed | 191 / 6,278 | 0 |
| Node 24.22.1 | passed | 191 / 6,278 | 0 |

Logs: `full-node25.5.0.log`, `full-node22.19.0.log`, `full-node24.22.1.log`.
Each suite used `CI_REQUIRE_SEARCH_TOOLS=1` and `--maxWorkers=6`; all exited 0.
They reported the unchanged ENOTEMPTY retention policy, leaving run roots
`ink-test-run-h50DmG`, `ink-test-run-xx60Ft` and `ink-test-run-rUWDRv` under the
OS temporary directory. No root was deleted or warning hidden.

`npm run lint` checked 352 files; script syntax, bilingual docs (11 topics per
language) and legacy-name checks passed. Build, release identity, npm 11.8.0
minimum-version guard, docs-site build (24 pages) and diff checks passed.

### Offline artifact and install

The first smoke failed with ENOTCACHED for `signal-exit@3.0.7`; its selected
`/tmp/ink-release-0.6.1.VVf5Da/npm-cache` did not contain usable cached tarballs.
The failed log and scratch artifact were retained. Read-only inventory found
all 13 source-lock production-marked tarball URLs in the previous successful
smoke's cache:
`/tmp/ink-release-0.6.1.VVf5Da/tmp/ink-package-smoke-wGPQdX/cache`.
The retry used that cache read-only, with no download, lifecycle scripts or
changes to product/dependency files. Logs: `cache-inventory.json`,
`package-smoke.log` (failure), `package-smoke-complete-cache.log` (success).

Successful smoke root:
`/private/var/folders/y5/4pt277ys42g1kz84rh0g922c0000gn/T/ink-package-smoke-aPL749`.
It verified 457 allowed application files/modes, isolated offline install,
help/exact `Ink 0.6.2` output and neutral-cwd local npm-exec inference.
Additional `verify-candidate-artifact.mjs` checks all 457 packed file bodies and
modes against both source/build and isolated installation, with no unexpected
application paths. It checks installed dependency name/version against the
production lock entries and executes installed help/version on all three local
runtimes with network blocked. Results: `candidate-artifact.json` and
`candidate-artifact-summary.json`; unexpected network attempts: 0.

Frozen artifact: `artifacts/ink-agent-0.6.2.tgz`, 871,300 bytes; SHA-256
`f7fdc4ea4e4b9931d8777e7237ac475c0efe940c23d4ef22e821f21dd1f01a36`.
Integrity:
`sha512-a6Axfy11siar8IBJ9OV+bRYgZQQH+W1UhvAuRhdFuErL1gwrEGpUeh8BFVvsjUSWGu1QHqOP75xyJZSiRHyNzA==`.
The isolated installation contains 12 lock-matching production packages,
including nested marked 18.0.11 rather than the extra source-root marked 18.1.0.
Dependency identity and npm integrity checks are not a separate byte-by-byte
audit of dependency files. Installed help/version and automated CLI regressions
are not a new full real-terminal or real-provider acceptance run.

### Independent review and remaining boundaries

Reviewer `49d7a642-b46b-44a4-8e37-4620f844c325` returned final APPROVE with no
required changes before the preparation commit. In addition to source/notes,
it independently parsed the real tar and cross-checked Python tarfile, all 457
file bodies/modes and the complete file set, a fresh build's 411 dist files,
a new private offline installation and local npm-exec, all three installed
runtime version/help outputs, dependency resolution and cached tarball SRI.
Its independent 10-file/950-test run, three-runtime typechecks, lint/docs and
identity checks passed. Evidence: `/tmp/ink-release-0.6.2-review-6plvx44k/`.

The scratch verifier alone does not prove a complete expected file set, fresh
build, full dependency resolution or actual runtime version; the independent
review supplied these additional checks. Initial reviewer probes had macOS
/tmp-alias and help-line-wrap assertion errors; corrected isolated probes
passed without modifying the candidate. No original evidence was overwritten.

Candidate main push, exact-SHA Linux CI, annotated v0.6.2 creation/push,
registry verification and GitHub Release creation are not yet performed or
approved by this record. No global installation change is included.

## 6. Hosted CI follow-up: API-key history-recall readiness

Status: design approved before test changes by independent reviewer
`3eda0931-2b7a-4d2b-9cf0-3c97541e107e`; implementation and independent review
complete; new exact-SHA hosted CI pending.
Follow-up worktree: `.worktrees/ink-ci-login-recall-readiness`, branch
`fix/ci-login-recall-readiness`, base `d48c4e8`.

The preceding pending-state paragraphs are the preparation snapshot. The owner
subsequently approved and completed the main push 2535855 -> d48c4e8. Pages
43213094074 passed. CI 43213094148 attempt 1 failed only Node 22.19.0 at
`test/login-dialog.test.ts:644`, case 10b: loadApiKey returned null instead of the
fake key. That job passed 6,275 tests with 1 failure and 2 platform skips; Node
24 passed 6,276 with 2 skips, including packaging. Logs/results are retained as
`ci-main-full.log`, `ci-main-summary.json`, `ci-main-watch.log` and
`pages-main-result.json`. An initial read-only run-summary API call timed out;
a subsequent API read succeeded. No CI rerun, tag or publication was performed.

The recall test used one fixed settle interval after submission before reading
an asynchronous, locked durable auth save. The production success status is
emitted only after save and dialog teardown. Replace its prompt-open and
save-completion timing assumptions with the existing bounded frameEventually
checks for the prompt and Saved API key status. Keep actual key persistence and
both recall/history privacy assertions. Do not increase OAUTH_BUDGET, Vitest
limits or sleeps as a purported fix; do not skip/retry the test or change CI
parallelism. Production auth/UI/runtime code remains untouched.

Add one contended-save variant of this same recall scenario using the existing
withAuthStoreLock and deferred helpers. Hold the real save lock, submit the fake
key, and start the completion waiter; show after an existing settle interval that
no key or success status is present and the waiter remains pending. Release the
lock in finally and await its actual owner before cleanup, then require the
normal success status, actual saved key and unchanged recall/privacy checks.
Immediately attach rejection handling when creating the waiter, recording its
fulfilled/rejected outcome; both outcomes mark it finished, so rejection cannot
look like pending. On every exit path release the lock and await both its owner
and any started waiter before fixture teardown. Preserve assertion, lock-owner
and waiter failures (aggregate simultaneous failures), rather than masking them
or racing cleanup against a timer. Propagate lock acquisition failures as well.
This proves state-based readiness, not that one larger delay usually succeeds.
Keep fixtures, fake credentials and lock paths under owned temp roots.

After design approval, implement only this test and update release records.
Run the login/nearby auth regressions, typecheck, lint and full suites on the
existing Node runtimes; obtain independent implementation review. Confirm all
457 frozen artifact files/modes still match source/build, since tests and
preparation records are not shipped and application bytes must not change.
Use one follow-up commit plus --no-ff merge; request its exact main push again.
Require new exact-SHA Linux CI before any separately confirmed v0.6.2 tag push.
Do not rerun the failed hosted job to bypass the failure or modify published
metadata/gates/global state.

### Follow-up verification

Only case 10b changed: ordinary and contended variants wait for the existing
prompt/saved status, preserving actual persistence and both recall assertions.
A real lock proves that one settle interval is insufficient. Immediate outcome
handling and finally-based convergence preserve primary and concurrent failures.
Independent implementation reviewer `8c29fd5d-22eb-4a54-bf76-19c525f2b8aa`
returned APPROVE with no required changes, including 30 login tests on each of
Node 22.19.0/24.22.1, nine expected-failure injection scenarios, no unhandled
rejections, and an independent fresh-build comparison of all 457 artifact files.
Evidence: `/tmp/ink-ci-login-review.CRO7ys/` and implementation probes under
`/tmp/ink-ci-login-readiness.0HxAJ5/`. The old fixed-wait assertion was reproduced
as a failure under the held lock; corrected variants passed.

Final coordinator full suites on macOS Node 25.5.0, 22.19.0 and 24.22.1 each
passed **191 files / 6,279 tests, 0 skipped**, with both typechecks on each
runtime. Lint (352 files), script/docs checks, build and diff checks passed.
Logs: `login-followup-full-node25.5.0.log`,
`login-followup-full-node22.19.0.log`, `login-followup-full-node24.22.1.log`.
All three returned exit 0 and retained nonempty run roots as before:
`ink-test-run-1q1lgK`, `ink-test-run-jBsC51`, `ink-test-run-eLUt6R`.
The extra test is the contended variant; no production file or shipped note
changed, and the original frozen artifact remains the candidate application.
New commit/merge and its separately confirmed push still require new Linux CI;
the failed run is retained rather than rerun. No tag or npm/GitHub Release has
been created by this follow-up.

## Publication

Published and verified on 2026-11-12. All evidence paths below are relative to
`/tmp/ink-release-0.6.2.T6vS1Y/` (canonical macOS alias `/private/tmp/...`).
This section records completed, separately approved operations, not authority
to repeat publication, push documentation or replace a global installation.

### Final source, CI, tag and Pages

- Final reviewed source: `1a808ce7f82e44810739773534f59d6a2854b706`, merged with
  --no-ff after test-only readiness correction `2a5e16a`. Its reviewed tree was
  `a3aaca6d6690664e91cc9b72ab8bee8995f25341`; the merge did not alter that tree.
- Initial candidate `d48c4e8` failed CI `43213094148` only on Node 22.19.0's
  existing fixed-wait login-recall test. The failed run was retained, not rerun.
  Section 6 records the independent design/implementation reviews and real-lock
  regression, without changing production code, timeouts, skips or concurrency.
- [CI `43218280738`](https://github.com/FishInSalt/ink/actions/runs/43218280738)
  passed on the exact final source. Ubuntu Node **22.19.0** and **24.22.2** each
  passed all gates and packaging: **191 files / 6,277 passed / 2 skipped**.
  The unchanged Darwin-only integration checks are platform skips, distinct from
  local macOS full suites of **6,279 passed / 0 skipped** after the follow-up.
- Pages `43213094074` succeeded for `d48c4e8`, not the final source. The three
  final changed paths were the test, PROJECT_PLAN and this internal design file;
  existing Pages path filters correctly excluded them. All site inputs remained
  identical, so no manual dispatch or new final-SHA Pages deployment was needed.
- Annotated tag `v0.6.2`, object
  `e8b8de7071e69b9d0d9637f1655f1a69e9fc6e19`, peels to the final source.
  The approved tag push created that exact ref; it was never moved or reused.

### Workflow and registry publication

[Release `43219715046`, attempt 1](https://github.com/FishInSalt/ink/actions/runs/43219715046/attempts/1)
completed gate and publish successfully on the tag-push event and final source.
Node **24.22.2** / npm **11.19.1** passed the release gate's 191 files / 6,277
passed / 2 skipped and both 457-file artifact smokes. The dry-run/skipped-publication
paths were skipped, not mistaken for publication. Real npm publish returned
`+ ink-agent@0.6.2` at `2026-11-12T12:41:51Z`; exact metadata/source verification
succeeded at `2026-11-12T12:45:28Z`. A 360-second local watch command timed out
while the workflow was still verifying visibility; later API/log reads confirmed
success. The workflow and publication were not rerun.

Registry exact/latest metadata select `ink-agent@0.6.2`, final gitHead and
`https://registry.npmjs.org/ink-agent/-/ink-agent-0.6.2.tgz`. Actual registry
archive: **873,302 bytes**, SHA-256
`fbb60b83d81c3580d6b373e23de9dea54610974bfd2eb210d5f49abbabc297c0`;
integrity:
`sha512-yVTZbhqfKY8G7Hro4EaYKj0f9GUio6V529kyv4cxNf70KhkDuHBW2jZxjVJrTtLzdjRUADvK0zrpuBWAX6Cj9Q==`.
Its strict-parsed **457 file bodies/modes** match the frozen 871,300-byte candidate
and final source/build. Different compressed archive digests are not content
changes. Candidate SHA-256 remains
`f7fdc4ea4e4b9931d8777e7237ac475c0efe940c23d4ef22e821f21dd1f01a36`.

### Cryptographic verification and isolated acceptance

Previously reviewed scratch tools were copied to new owned scratch and adapted
only in 23 added/removed identity/path/hash/receipt lines. Independent reviewer
`3b9d1f40-95f2-4bc5-a594-ada239973f84` approved the adaptation design and final
implementation/frozen inputs before real execution. Old tools/evidence and the
candidate smoke remained read-only. One preparation assertion initially rejected
the known unselected root marked 18.1.0 record; its failed evidence was retained
and the correction allowed only that exact exception, not arbitrary omissions.

The real verifier validated **2 registry signatures** for both exact and latest
metadata and exactly **one publish plus one provenance attestation**, including
DSSE, Fulcio certificate/SCT, authenticated TUF trust data, transparency inclusion
proof/checkpoint and every Rekor v1 signed entry timestamp. It bound artifact
SHA-512, repository, release.yml, OIDC issuer, tag, final commit and actual
run/attempt. Provenance transparency-log index: **3832544527**; publish index:
**3832586130**. All seven named controls rejected altered payload, wrong workflow,
wrong issuer, wrong artifact digest, wrong source, missing SET and altered
integrated time. The artifact/source controls are semantic binding checks, not
seven distinct signature-corruption tests.

Verifier success report:
`postpublish-prepared/registry-verification-C69MIx/registry-crypto-verification.json`.
Its SHA-256, observed from the final successful verifier output, is
`c98e988d80c47e7163ef30d8c2d6b59bc73f149ebc517a08ce790c38ff5d55cb`.
That external value was separately supplied to the installer, which first
validated all input/script/cache inventories and reverified signatures offline.

Installer report:
`postpublish-prepared/registry-install-DHQvoT/registry-install-verification.json`,
SHA-256 `d9a26cc21789d8b328da093032c7f3e29e971ef38841a035b6b4b88d035492da`.
It verified all 457 installed app files/modes, exactly **12** production package
identities and lockfile URL/integrity tuples, using SRI-checked cached tarballs
and one-version manifests. The selected marked was 18.0.11, not the source-root
18.1.0. This is dependency identity/integrity validation, not a byte-by-byte audit
of every dependency file. Installed version/help passed on macOS Node 22.19.0,
24.22.1 and 25.5.0; neutral-cwd local npm-exec passed on the Node 25.5.0 host.
The Node API blocker self-test passed, unexpected install network attempts were
**0**, and no lifecycle scripts, real credentials or global writes were used.
This is not an OS network sandbox, a new full CLI PTY/real-provider acceptance
run, or official runtime-signature verification.

The same independent reviewer approved the actual results after an additional
offline replay of saved TUF responses and real signatures. It checked all 17
installer command receipts, app/dependency/cache identities and unchanged old
smoke/global npm inventories. Independent replay evidence:
`/tmp/ink-062-evidence-review.Zh7mNN/result.json`.

### GitHub Release and retained evidence

The formal [GitHub Release v0.6.2](https://github.com/FishInSalt/ink/releases/tag/v0.6.2),
id **442971445**, title **Ink 0.6.2**, was created after separate owner approval
at `2026-11-12T13:16:10Z`. It is non-draft, non-prerelease and Latest. Its
**1,739-byte** UTF-8 body exactly equals the approved dated CHANGELOG notes and
`release-notes.md`, SHA-256
`640c3894fd16c5ac47d7517bd2bf2a4b0b57c0706e10e196cfab95db4bf03d23`.
No generated notes or uploaded assets were added; no tag or npm operation was
repeated during release-page creation.

Key original evidence is retained in `login-followup-ci-result.json`,
`login-followup-ci-full.log`, `pages-main-result.json`, `release-result-final.json`,
`release-full.log`, `registry-verification-attempt-001.log`,
`registry-install-attempt-001.log`, both reports and their inputs above,
`github-release-0.6.2.json`, `github-latest-release.json`,
`github-release-verification.json`, and `release-notes.md`.
The early cache-miss, hosted-CI failure, probe errors and nonempty test roots
remain preserved as described above. No npm/tag/GitHub publication remains
pending; global upgrade was not performed or authorized.

This three-document-only follow-up uses branch `docs/release-0.6.2-publication`,
base `1a808ce`. Independent reviewer
`fcfb1d9c-9d6c-4977-8a12-39ab7881f3f1` approved the design before edits and
returned final factual-review APPROVE with no required changes after checking
original run logs, registry files, signature/install receipts and release JSON.
`npm run lint` checked 352 files, script syntax and bilingual docs successfully;
all 26 relative links / 9 anchors in the three documents and `git diff --check`
passed. Sections 1–6 remain byte-identical. The product suite was not rerun for
this documentation-only batch; the source/hosted/artifact checks above remain
its product evidence. Integration uses one normal commit and --no-ff merge with
reviewed tree equality. The tagged product, source/metadata/dependency pins,
CHANGELOG and workflows remain unchanged. Its remote documentation push requires
separate confirmation and does not republish npm or update any global installation.
