# Ink 0.6.0 release preparation

Date: 2026-11-11
Status: local candidate independently approved; publication pending.
Branch/worktree: `release/0.6.0`, `.worktrees/ink-release-0.6.0`.
Base: `21675349cd1360170449ca6bb1194151622954e4` (clean local main).
Previous published version: `ink-agent@0.5.1`, tag `v0.5.1`.
Evidence root: `/tmp/ink-release-0.6.0.uIu0HL/`.

## 1. Goal, release identity and authorization

The owner requested completion of the outstanding pre-release work followed by
publication. That goal does not waive the workspace's per-operation approval
requirements. Paid independent reviewer calls, remote pushes, CI/Pages triggers,
version-tag pushes that publish to npm, and GitHub Release creation must be
presented separately and explicitly approved before execution. The owner has
confirmed the independent design and final implementation/artifact review
rounds; both are closed. No external write has been approved or performed. Read-only remote inspection is allowed.

Propose `ink-agent@0.6.0`, sole executable `ink`, annotated tag `v0.6.0`.
Use a minor version because the pending changes add Codex Fast selections and
accounting behavior, including a new `summaryUsage` entry that older binaries
may not read. Do not change session format versions or migrate existing files.
The Unreleased notes already disclose this compatibility limitation.

Read-only observations on 2026-11-11: npm latest is 0.5.1 with gitHead `717bc88`;
0.6.0's registry metadata returns HTTP 404; no remote v0.6.0 tag exists; remote
main is `add43087a30034c96a742921590ef2adb2c769e8`. These observations reserve
nothing; repeat identity and availability checks before any publication.
The local Docker daemon is not running. Local macOS verification cannot replace
Linux Node 22.19.0/24 CI.

No global package/runtime installation, production configuration/state mutation,
credential changes, dependency updates, workflow changes, live model inference,
or paid provider experiments belong to this release batch.

## 2. Close the three low-priority review items

Implementation starts only after fresh-context adversarial design approval.
These are narrowly bounded hardening changes, not evidence of a normal-CLI
production blocker. Preserve all previously approved Fast and FIFO semantics.

### 2.1 Fast error annotation

`src/provider/codex-responses.ts:95-100` assumes every Error.message is writable.
An injected adapter can return a native DOMException or an immutable Error,
causing the hint to replace the original exception with a TypeError. The review
reproduced this with injected transport; default native-fetch reachability was
not established and must not be claimed.

Make hint annotation best-effort and incapable of replacing the original error.
Preserve exception identity, prototype and typed fields; do not wrap every error
in a new untyped Error. Keep existing annotation for ordinary writable errors.
For getter-only extensible errors, an own message property may provide the hint;
if neither assignment nor property definition is allowed, rethrow the original
unchanged error. Guard message access/annotation itself. Do not change request
validation, auth, retry count, tier selection, cancellation or tool execution.

Add offline injected-auth/body tests for native DOMException, frozen Error,
non-configurable read-only message, ordinary typed Codex errors and non-Error
throws. Include injected-auth errors with throwing message getters/setters so
existing body-interruption classification cannot mask the annotation boundary.
Assert original identity/typed fields and no additional provider calls.
Preserve normal-mode behavior and caller-abort behavior. Update the English and
zh-CN providers pages to state that recovery hints cannot replace the original
failure when annotation is unavailable; add accurate changelog notes.

### 2.2 FIFO supervisor loss

`test/helpers/fifo-fixture.ts` launches a detached process group. A forcibly
terminated supervisor cannot run its watchdog or hooks; the worker currently
has no unexpected-IPC-disconnect containment. This is test-only and is excluded
from the npm package. Do not claim the baseline could never leak external
holders, or that graceful test failures currently fail to clean up.

Add worker-side emergency containment for unexpected supervisor disconnection.
Arm the handler before creating holders or starting native FIFO work, and check
process.connected immediately after arming: the disconnect event may already
have occurred during startup/static imports. No guarantee applies before the
worker's own JavaScript can execute. Signal only the group led by this still-live
worker's own PID, established by the fixture's detached spawn; never accept a
signal target from IPC. Use synchronous SIGKILL of that owned group, with an
immediate process.exit(70) fallback if signaling fails or unexpectedly returns.
The fallback is bounded but cannot claim descendant containment on signal failure.
The handler must not need asynchronous filesystem work or an available libuv
thread. Do not unlink FIFO paths or claim to reap PID 1's zombie processes.

Explicit orderly disconnection must remain distinct: successful fully drained
workers and existing intentional early-exit/orphan controls keep their specified
outcomes. A failed worker with pending native I/O must keep IPC until the live
supervisor contains it; do not intentionally disconnect and disable protection
while unresolved work remains. Normal success still requires all read promises
and holder closes before disconnecting and a normal worker exit.

Add distinct owner-loss controls for already-disconnected startup (consume the
event before handler registration), a holder waiting before open, and an
admitted/paired real native read witnessed by holder readiness before EOF. The
latter controls sever the worker's IPC channel without its orderly-disconnect
flag after sending the evidence, triggering the same worker disconnect event
without killing Vitest itself. Keep the supervisor endpoint passive: an initial
experiment showed parent-side ChildProcess.disconnect can prevent the later
ChildProcess close event even after the group is empty on local Node 25.5.0.
Worker-side fault injection preserves the parent's real EOF/exit/close evidence.
The startup case
must exercise the post-registration connected-state check, not merely a queued
disconnect event caught by the handler.

Observe emergency SIGKILL direct-worker close (not a normal successful exit),
and independently audit no non-zombie group members within a bounded observation
period of at most 2 seconds. Record that the supervisor issued zero containment
signals BEFORE this predicate was established. This emergency-control outcome is
separate from ordinary scenario success: no verdict/signal exit still cannot
count as a successful read scenario. Only after the predicate succeeds or fails
may existing owned-group cleanup signal as a failure backstop and remove paths.
Missing handler/state-check negative controls must fail that predicate even if
later supervisor cleanup succeeds. Preserve watchdog and original 10000+2000 ms
scenario/cleanup budgets. Ordinary success still requires exit 0, no signal,
fully drained reads, normal holder closes and an empty group audit. Retain all
existing serial, abort, orphan, watchdog, spawn, malformed IPC and normal-exit
tests without longer deadlines, a larger UV_THREADPOOL_SIZE, weaker assertions
or nonlocal network access. Document this fault boundary and its startup limit
in the existing FIFO design and changelog.

### 2.3 Whitespace

Remove the extra blank line at EOF in `docs/design/fifo-test-isolation-fix.md`.
Verify `git diff --check v0.5.1..candidate`, not only the unstaged diff.

## 3. Release metadata and documentation

- Change only the application version in package.json to 0.6.0.
- Change only the top-level and root-package versions in package-lock.json.
  Preserve every dependency record; do not regenerate the dependency graph.
- Update src/format.ts VERSION and the deliberate version pin in
  test/package-metadata.test.ts. All five version pins must agree.
- Keep an empty Unreleased heading and move the complete pending notes plus
  accurate new hardening notes into `## [0.6.0] - 2026-11-11`. That is a candidate
  date, not a publication claim; correct it if the release date changes.
  Preserve the complete 0.5.1-and-earlier changelog section byte-for-byte.
- RELEASING.md selects 0.6.0 as prepared/unpublished, links this record and updates
  the exact smoke-version example. Retain the verified 0.5.1 publication history
  and distinguish the still-published latest from the new candidate.
- Record design review, actual verification, final independent implementation/
  artifact review and external approvals/results here. Never pre-record success.

## 4. Local validation and review

Use existing workspace dependencies read-only through a worktree-local symlink;
never npm ci/install against that shared target. Build output stays worktree-local.
Tests use the repository's network blocker, fake providers and controlled CLI
fixtures. Artifact smoke uses private HOME/XDG/cache/config/prefix in scratch and
reads the existing npm cache without modifying it or fetching missing packages.

1. Run new regressions and all affected Fast/FIFO/concurrency suites. Confirm
   owner-loss tests fail without the worker handler rather than passing because
   the supervisor killed the group. Preserve evidence from negative controls.
2. Run source/test typechecks, repository lint, build, the full original-deadline
   suite with six workers/default libuv pool, release identity/npm-version guards,
   documentation-site build in scratch and baseline-range whitespace checks.
3. Reuse existing temporary Node 22.19.0/24 runtimes only after inspecting their
   version and available checksum evidence; rerun relevant gates/full suites on
   these local macOS runtimes if available. Label them macOS, never Linux CI.
   Do not install system runtimes or silently download replacements.
4. Run offline package smoke on the rebuilt 0.6.0 candidate. Record packed file
   count, exact version/help/npm-exec results, tar path, size and digests.
   Verify no test helpers, source, design documents, runtime roots or secrets ship.
5. Compare dependency records and historical changelog bytes to the base. Obtain
   independent fresh-context implementation/artifact approval, resolving required
   findings before commit/integration. Review scope includes new tests and the
   exact candidate artifact, not just a repeated reading of this design.
6. Commit without hook bypass. Confirm main has not advanced; integrate only
   with --no-ff and verify its tree matches the reviewed candidate. Rerun
   integrated checks as necessary. Keep the worktree clean and preserve evidence.

The earlier review's 175 files / 5073 passing tests and 442-file artifact are
baseline results, not verification of the amended 0.6.0 candidate.

## 5. Separately confirmed external stages

1. Request permission to push the reviewed local main to FishInSalt/ink. Explain
   that this publishes the pending commits, starts Linux Node 22.19.0/24 CI and
   deploys the changed documentation via Pages. No tag or npm publication in this
   operation. Verify the exact pushed commit's CI results and artifact checks;
   inspect and repair failures locally rather than bypassing them.
2. After supported-Linux CI passes, recheck package/tag availability, package,
   lock, app/test identity, main ancestry and read-only publication gates. Request
   separate permission to create/push annotated v0.6.0 for the reviewed commit,
   explicitly describing the resulting provenance-enabled npm publication.
   Do not change account/repository gates or introduce credential fallbacks.
3. Monitor the tag release workflow without rerunning a successful publish.
   A registry visibility timeout is not evidence that publication failed. Verify
   actual registry version/latest/gitHead, tarball integrity, packed contents and
   modes against the candidate, isolated installed version/help and cryptographic
   publication/provenance identity. Report any unavailable verification honestly.
4. Request separate permission to create the non-prerelease GitHub Release using
   only the approved dated changelog notes. Verify its tag, published state and
   body. Do not declare the requested release complete before this and registry
   artifact verification.
5. Record verified publication on a dedicated documentation branch, review/check
   it, merge with --no-ff, then request separate approval for its remote push.
   Never move an already-published tag. Global installation is not included.

## Review and execution record

- Design review round (owner-approved): reviewer `6ae5910a` requested R1
  already-disconnected startup coverage and R2 explicit emergency-exit evidence
  before supervisor signaling. This revision addresses both plus the throwing
  message accessor and mandatory paired-read recommendations. The same reviewer
  re-read the revision and returned APPROVE before implementation, closing R1/R2.
- Initial focused implementation tests: Fast transport and loop concurrency
  passed, but two new owner-loss probes failed because parent-initiated IPC
  disconnect suppressed direct-close evidence despite an empty group. No live
  fixture processes remained; roots were retained as required. Reviewer
  `6ae5910a` approved the narrow worker-side fault-stimulus amendment before
  implementation. This is disconnect-boundary injection, not a test that kills
  the supervisor process; direct-close/zero-supervisor-signal predicates remain.
- Implementation and local candidate validation: completed as recorded below.
  Fresh-context independent implementation/artifact reviewer `ad1b575d` returned
  APPROVE with no required changes. This record closes review before the local
  candidate commit/integration; those operations follow without hook bypass.
- External pushes, CI/Pages, tag/npm publication and GitHub Release: pending.

## Local candidate verification

All five version pins agree at 0.6.0. Parsed package/lock comparisons against
2167534 show changes only to the three application-version fields; all dependency
records are unchanged. CHANGELOG 0.5.1-and-earlier bytes are identical to the base.
The three P3 items are implemented: guarded Fast hints, test-only FIFO owner-loss
containment and the committed EOF whitespace correction.

| macOS arm64 runtime | Full test files | Full tests | Source/test typechecks |
| --- | --- | --- | --- |
| Node 22.19.0 | 175 passed | 5098 passed | passed |
| Node 24.22.1 | 175 passed | 5098 passed | passed |
| Node 25.5.0 | 175 passed | 5098 passed | passed |

The final Node 25 run took 40.41 s, Node 22 took 38.36 s, and Node 24 took
35.44 s. All used six workers, default libuv pool and unchanged test deadlines;
there were no failed/skipped/todo tests. The temporary 22/24 archives match their
saved official SHA-256 checksum lists, and each executable matches its archive
entry byte-for-byte. These are macOS results, not supported-Linux CI.

- Affected Fast/FIFO/concurrency subset: 3 files / 214 tests passed, including
  22 new immutable/native/accessor error cases and 3 new owner-loss controls.
- Counterfactual copies under evidence scratch deliberately disable only the
  disconnect handler (2 expected failures / 1 pass / 11 unselected tests) or only
  the connected-state check (1 expected failure / 13 unselected tests). The
  relevant owner-loss predicate fails before supervisor fallback; those expected
  failures are not candidate test failures. No source checkout was changed for
  the negative runs. Process scans afterward found no live fixture workers or
  holders. Inconclusive initial-run roots remain retained, not silently removed.
- Final lint: 321 files, zero warnings/fixes; script syntax, documentation
  structure/links/parity and identity guards passed. An initial confusing
  never|void annotation warning was corrected to void before the final runs.
- Build, identity, npm 11.8.0 minimum-version guard and working-tree plus
  v0.5.1-to-candidate whitespace checks passed. The docs-site build generated
  24 pages in scratch; no deployment was performed.
- Offline artifact smoke: 442 allowed files; tar paths/modes, isolated install,
  exact Ink 0.6.0/help and neutral-cwd npm-exec passed. Additional installed CLI
  version/help checks passed on all three runtimes, with no blocked-network
  evidence. The supplemental probe initially expected one-line Usage text;
  correcting it to the smoke's whitespace-tolerant assertion required no code
  changes. No production credentials/provider endpoints or network fallback.

Candidate artifact (local identity, not registry publication/provenance):

- Path: `/tmp/ink-release-0.6.0.uIu0HL/ink-package-smoke-klvPce/artifacts/ink-agent-0.6.0.tgz`.
- Size: 861269 bytes.
- SHA-256: `9f0fb838de7ccafdfef2b44f3f5d3ec1dad8877a95fa4f76d65ed9cdcc8452c9`.
- Integrity: `sha512-XSy1ALlTD+crmA+r5vCd7QLCUDmDb5JixCDtDTROZ0jNSgvmgYjhz4LeDOIs70Yyk/r0uh+ID/w8ELWHGNKPNg==`.

Evidence under `/tmp/ink-release-0.6.0.uIu0HL/`: full-22.19.0.log,
full-24.22.1.log, full-25-final.log, typecheck-*.log, focused-initial.log,
focused-amended.log, counterfactual-{no-handler,no-state-check}.log,
lint-final.log, build-final.log, artifact-smoke.log, artifact-identity.json,
installed-cli-runtimes.log and docs-site/. A future registry archive can have a
different compressed digest; compare its packed file bytes/modes separately.
Independent candidate review is closed as recorded below. Local commit and
integration follow this record; supported-Linux CI and all external publication
operations remain outstanding.

## Independent candidate review

Owner-approved fresh-context reviewer `ad1b575d-16e6-45d2-9042-93a04da7ea5f`
returned APPROVE for the local candidate and exact artifact, with no actionable
findings. The reviewer inspected all 14 modified tracked files, this complete
new record, relevant full source/tests/callers and approved design constraints.
Review evidence is under `/private/tmp/ink-review-060-kz5dvnh8/`.

Independent verification included:

- Source build and test typecheck, full Node 25.5.0 suite: 175 files / 5098 tests
  passed in 38.96 s with six workers/default pool and original deadlines.
- Both counterfactual controls reproduced the intended failures independently;
  fallback containment did not satisfy the worker-observation predicate.
- Biome checked 321 files without fixes; identity, script syntax, legacy-name
  guard, baseline whitespace and 11-page bilingual documentation checks passed.
  The documentation site generated 24 pages in review scratch.
- Exact artifact digest/size, all 442 file bodies/modes and exact expected file
  set matched the candidate and existing isolated installation. All 396 build
  outputs matched an independent fresh compilation byte-for-byte. No forbidden
  runtime roots, credentials, source, tests or design records were packaged.
- The installed CLI independently produced exact Ink 0.6.0/help with isolated
  state and blocked network. Existing offline install/npm-exec evidence was
  inspected, not repeated because the reviewer was instructed not to install.
- Node 22/24 full-result logs, unchanged dependencies and historical changelog
  bytes were independently inspected; those two full suites were not rerun by
  this reviewer. Final scans found no live FIFO workers or holders.

The review's first copied-repository run had 14 environment-induced failures:
its fixture TMPDIR was inside the copied repository and exposed package/context
ancestry. Moving fixture scratch to a sibling temporary directory produced the
passing full run without candidate code changes. These are review-harness
results, not a claim that the initial run passed.

Approval does not authorize remote pushes, CI/deployment triggers, tags, npm or
GitHub publication. It does not establish live native-CLI error reachability or
actual supervisor-death behavior beyond the documented disconnect probes.
