# Ink 0.6.2 release preparation

Date: 2026-11-12
Status: independent design and final implementation/artifact reviews approved;
local candidate verified; publication pending.
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
