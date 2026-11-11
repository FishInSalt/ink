# Hosted CI follow-up: APT sandbox access and FIFO watchdog readiness

Date: 2026-11-11
Status: design and implementation independently approved; local verification passed; hosted acceptance pending.
Base: main@df22aacc1786da8e37d32cc52aab5d2062a61ebf.
Branch/worktree: maintenance/ci-hosted-followup, .worktrees/ink-ci-hosted-followup.
Evidence: /tmp/ink-ci-hosted-followup.AdXGmA/ and the preceding maintenance evidence
at /tmp/ink-ci-release-reliability.EmQ1Go/.

## Evidence and boundaries

The owner approved pushing only main@df22aac, triggering ordinary CI and Pages.
That push completed. Do not rerun those workflows or publish anything again.

- CI 43063656223 attempt 1 ran the exact commit on Ubuntu noble/amd64.
  Both jobs installed and verified ripgrep 14.1.0 and fdfind 9.0.0 using only
  archive.ubuntu.com/security.ubuntu.com sources; no Azure mirror was selected.
- Node 24 completed all gates and the 442-file offline artifact smoke:
  176 test files passed, 5186 tests passed and two existing platform cases skipped.
- Node 22.19.0 passed installation, typecheck, lint and build, then failed the
  existing parent-watchdog fixture case at test/fifo-fixture.test.ts:177:
  expected ownership.length >= 2, observed 0. Totals: 175 files passed, one
  failed; 5185 tests passed, one failed, two existing platform cases skipped.
  The expected watchdog error and SIGKILL assertions had already passed.
- The short watchdog starts before worker import and ownership verification,
  while the test assumes an owned holder must exist within 1800 ms. The log
  does not establish exactly which startup/audit stage was unfinished; it does
  establish that the required ownership observation was missing at expiry.
- Both APT jobs warned that _apt could not access the lists/archives download
  path and fell back to unsandboxed root downloads. Installation exit zero does
  not certify the intended sandbox. The logs do not identify the inaccessible
  ancestor; changing only the newly created child's mode is insufficient proof.
- Pages 43063656247 built and deployed successfully for df22aac.

The original maintenance implementation review approved the candidate with
hosted APT as an explicit remaining acceptance boundary. This follow-up addresses
observed hosted evidence, not an application regression or a republish request.
No src/, dependencies, lockfile, version, Vitest timeout, worker pool size,
production read/auth/provider behavior or publication gates may change.

Local execution must never run real sudo/APT, start Docker, install packages,
or access providers/credentials. Local tests remain offline command substitutes
and native owned FIFO fixtures. A future push/hosted CI needs separate approval.

## 1. APT sandbox-access correction

Supersede only the APT scratch-location requirement in
ci-release-reliability-maintenance.md; keep its signed official amd64-only
sources, update/install consistency, strict errors and acquisition/step bounds.

- Create the APT sources/lists/cache root with atomic mktemp under the canonical
  /tmp on the Ubuntu runner, not below a possibly private home/work/RUNNER_TEMP
  ancestor. Only the new owned root is chmod 755. Contents are public signed
  repository metadata and package archives, never credentials or GitHub output.
  Do not change permissions/ACLs on /tmp, runner home, RUNNER_TEMP or any other
  existing directory. Do not disable or select root for APT's sandbox.
- Keep the fd-alias tool directory under a separately owned RUNNER_TEMP root,
  since it is consumed by the runner user, not by _apt. Validate RUNNER_TEMP and
  GITHUB_PATH as before. Publish PATH only after all installation/version checks.
- Before invoking APT, perform the bounded, read-only access check
  sudo -n -u _apt /usr/bin/test -r "$sources". Noninteractive failure is fatal and runs no
  apt update/install. The source path includes the newly created common parent,
  so this verifies actual sandbox-user traversal rather than assuming mode bits
  are enough. Directories below that parent are created with the existing 022
  umask. Keep actual hosted logs as the final proof that no root fallback occurs.
- Pass APT::Sandbox::User=_apt explicitly and an explicit owned archives path
  along with the same source/list/cache options to BOTH update and install.
  No global APT, keyring, DNS, account, proxy or system configuration changes.
- Local sudo remains a non-executing stub. Extend its allowlist for the exact
  _apt/test argv, recording/simulating the result; unknown commands fail closed.
  It must never execute the supplied command, including the permission check.
- Add a local mktemp stub that recognizes exactly the canonical APT template
  and RUNNER_TEMP tool template, and maps both into fixture-owned paths. This
  proves the production argument without creating loose local /tmp directories.
  Keep quoted-path cases, native amd64/foreign-architecture filtering, negative
  platform/configuration cases and strict required-tool collection regressions.
- Assert the APT paths are independent of the simulated private RUNNER_TEMP,
  owned archives are explicit, both calls share configuration and the sandbox
  probe precedes them. Inject access-check failure: no APT or PATH publication.

This is signed metadata download sandboxing, not protection from an adversary
running as the same CI user or a guarantee that every future Ubuntu image works.

## 2. FIFO watchdog: hard cap versus injected post-ownership timeout

Supersede only the short watchdog fault-test timing assumption in
fifo-test-isolation-fix.md. Keep its global maximum 10000 ms including startup,
2000 ms bounded cleanup, original 15000 ms test deadline and owned-group audits.
Do not increase timeouts, skip assertions or serialize/reduce the test pool.

Separate two purposes explicitly:

1. The absolute scenario deadline still begins before worker spawn/import.
   It contains missing IPC, hung startup and every other scenario. No readiness
   event may restart or extend this hard deadline. Cleanup retains its own
   unchanged 2000 ms budget.
2. The watchdog fault-control case injects a shorter timeout only AFTER the
   supervisor has externally verified the worker and holder PGID/PPID membership.
   Its 1800 ms measures the controlled held scenario, not an import-speed promise.
   The worker's existing watchdog control still holds indefinitely before any
   reader is created. The independent hard deadline wins if reached first.

Extract the small timer lifecycle into a test-only helper with a pure fake-time
unit seam. It receives the original absolute deadline/scenario duration, optional
post-ownership fault duration, and an expiry callback; it has idempotent
armAfterOwnership and stop operations. The first expiry stops all timers and
reports which deadline fired. Stop/expiry seals it against late arming. Input
budgets remain positive bounded integers. Creating the timer after synchronous
fixture setup must use the original absolute deadline, not reset the clock.

runFifoFixture keeps its existing overall watchdogMs option. Add a distinct
faultWatchdogMs option valid only for control=watchdog; configure it as 1800 ms
in the affected regression. The callback's error identifies absolute-scenario
versus post-ownership fault expiry. Arm only after a successful external audit,
never directly from untrusted IPC. Stop all timers before normal fixture cleanup.
No caller-supplied signal target or production seam is added.

Keep every existing real-process assertion: expected fault phase, abnormal worker
SIGKILL close, externally observed worker/holder identities, conclusive no-live-
member cleanup, root removal and parent ordinary-file-read sentinel. Include
JSON outcome context on ownership assertions so an unexpected failure preserves
phase/cleanup diagnostics instead of only printing a length mismatch.

Fake-time regressions, without native processes or a fake application scheduler:

- Advance beyond the old 1800 ms before ownership; no short fault may fire.
  After ownership, the short timer fires at its own deadline, once only.
- Never establish ownership; the original absolute 10000 ms deadline must fire.
- Establish ownership close to the hard cap; it cannot postpone the hard expiry.
- Late construction, duplicate arming, stop and expiry must not restart timers,
  extend budgets or leave timers active. Invalid durations fail before arming.

Negative control: restoring the old pre-ownership short countdown must fail the
new deterministic delayed-ownership regression. Real FIFO cases continue to run
with the default libuv pool and actual process-group containment, not fake time.

## Verification and review gates

- Independent adversarial design approval before any implementation edit.
- Implement in this dedicated worktree using the existing node_modules read-only
  symlink; never npm ci/install against it. Private HOME/npm config/cache for npm;
  preserve normal Git configuration for commits and do not edit global identity.
- Shell syntax; focused provisioning, watchdog and FIFO/concurrency regressions;
  repeat the real FIFO subset under the original pool. Existing network guards
  and finishing cleanup remain mandatory even for expected-failure controls.
- Both typechecks, lint, build, full suite and offline artifact smoke on available
  macOS Node 22.19.0/24.22.1. Do not claim local mocks certify Linux _apt access.
- Check npm version/runtime/lockfile/published changelog invariants; regenerate
  fixture-prefix inventory only with its existing generator if needed. Scripts,
  tests and design docs stay excluded from packages; no replacement 0.6.0 upload.
- Independent implementation approval and closure of required findings before
  commit/--no-ff local integration. Record exact reviewed and integrated trees.
- Ask separately before any new push. Hosted acceptance requires both supported
  Node jobs to pass all gates, official sources and actual _apt access without
  root-download fallback warnings. Existing platform skips must stay identified;
  no new missing-tool, FIFO or test skip is permitted. No workflow rerun/dispatch,
  tag modification, npm publication or global package installation is included.

## Execution record

Independent design reviewer 8ad30420-d0b7-4080-b3f7-dfccd5f2906c returned
APPROVE with zero required findings before implementation. Adopt both optional
coverage refinements: timer stopping at the common cleanup entry, and elapsed /
simultaneously eligible deadline cases with exactly-once expiry and no timers.
Independent implementation reviewer 0f0b91d7-d33d-4bca-a7b2-f30e1d1ccc0f
returned APPROVE with zero required findings. The reviewer verified 11/11 file
hashes before and after review, inspected the complete diff/new files, cached
artifact comparison and supplied evidence, and independently passed 10 timer
lifecycle checks and eight non-executing provisioning checks. No repository
changes, network, real sudo/APT or installation were performed by the reviewer.
Decision record: /tmp/ink-ci-hosted-followup.AdXGmA/implementation-review.md.

Two nonblocking coverage suggestions remain for a future batch: commit explicit
alias-verification/tool-directory-creation failure cases, and force the fault
callback to dispatch first when both deadlines are eligible. Independent
diagnostics confirmed all three existing implementation behaviors are correct;
no corresponding defect or required code change was found. Only this factual
design review record changed after approval; reviewed code/test/config hashes
remain unchanged. No hosted follow-up run has been authorized.

### Local candidate evidence

Platform: Darwin arm64. Both final runs kept the original default worker pool,
CI_REQUIRE_SEARCH_TOOLS=1 and the unchanged 15000 ms test deadline. Dependencies
were reused read-only; npm HOME/config/cache were private scratch paths. No
actual local sudo/APT, system installation or network/provider call was used by
the regressions. The sudo and mktemp fixtures never execute their supplied commands.

| Node / npm | Typecheck, lint, build | Full test files | Full tests | Offline smoke |
| --- | --- | --- | --- | --- |
| 22.19.0 / 10.9.3 | passed | 177 passed | 5203 passed | 442 allowed files; install/help/version/npm-exec passed |
| 24.22.1 / 11.19.1 | passed | 177 passed | 5203 passed | 442 allowed files; install/help/version/npm-exec passed |

Evidence in /tmp/ink-ci-hosted-followup.AdXGmA/:

- node-{22.19.0,24.22.1}-{typecheck,lint,build,full-tests,package-smoke}.log.
- focused-initial.log: 82 tests passed across four files.
- node-22-fifo-repeat-{1,2}.log: real FIFO/concurrency subset repeated twice,
  each 44 tests passed across two files, with unchanged default pool/deadlines.
- negative-preownership-timeout.log: restoring the pre-ownership short timer
  causes the deterministic delayed-ownership assertion to fail as expected.
- negative-missing-sandbox-check.log: bypassing the access probe causes its
  fatal-before-APT regression to fail as expected. Both controls failed exactly
  one assertion with no timeout/unhandled rejection; exact original source
  bytes were restored in finally before the complete supported-Node checks.
- artifact-comparison.json: all 396 runtime files and all file modes match the
  previously verified registry artifact. The only packed content differences
  are CHANGELOG.md Unreleased notes and the preceding maintenance's package.json
  lint:scripts addition. This follow-up changes no package metadata. Published
  0.6.0-and-older changelog bytes remain identical; new tests/helpers/designs are
  excluded from all 442 packed paths. These are local development packs only.
- git diff --check, release identity and shell syntax checks passed. src/, bin/,
  package.json, package-lock.json and vitest.config.ts remain unchanged relative
  to df22aac. Regenerating the 321-entry fixture inventory produced no diff.
- The two existing Linux skips are Darwin-only cases in images-resize.test.ts
  and tui-transport.test.ts; no skip was added or changed by either maintenance.

Independent reviews are closed. Local commit/--no-ff integration and post-merge
verification identities are recorded in the evidence root's integration.json.
Real _apt sandbox access without root fallback and the complete Linux Node22/24
matrix remain a separately authorized future hosted acceptance gate.
