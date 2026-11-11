# CI and release-verification reliability maintenance

Date: 2026-11-11
Status: design and implementation independently approved; local verification passed; hosted Linux acceptance pending.
Branch/worktree: `maintenance/ci-release-reliability`, `.worktrees/ink-ci-release-reliability`.
Base: `9b8bb53aeca723850cb13255bb3e5344a1f038c6` (clean local/remote main).
Evidence root: `/tmp/ink-ci-release-reliability.EmQ1Go/`.

## 1. Scope, evidence and authorization

The owner requested these three maintenance improvements, in this order:
CI search prerequisites, the fixed-delay login test, then registry visibility
verification. This authorizes preparation inside the workspace, not sensitive
external operations. Pushes/CI or deployment triggers and any privileged/system
installation require their own explicit confirmations.
Independent design approval was obtained before implementation; the review
record is below. No new remote workflow has been triggered for this batch.
Independent implementation review must close before local integration.

Keep ink-agent/application version 0.6.0, all lockfile/dependency records, Node
minimum, runtime source and published artifacts unchanged. Do not move/recreate
v0.6.0 or rerun its release workflow. Changes to release.yml apply to future refs
only, not historical tags. No new version or npm publication belongs here.

Observed facts:

- Ordinary CI run 43035069141, attempts 1/2/3, failed both Linux matrix jobs at
  search-prerequisite installation: temporary DNS resolution failure for
  azure.archive.ubuntu.com, apt exit 100, before code checks/tests. Failure logs
  are retained under `/tmp/ink-release-0.6.0.uIu0HL/logs/`.
- Logs show mirror+file:/etc/apt/apt-mirrors.txt with attempts against Azure,
  archive.ubuntu.com and security.ubuntu.com. Microsoft repository metadata was
  fetched. The image already has official fallback entries; adding another
  fallback alone is not an established fix. Image-level mirror selection and
  retry behavior must not be confused with proof of an application failure.
- Local DNS currently resolves all three Ubuntu names. This is not evidence
  that the hosted runner's resolver/path has recovered.
- Read-only upstream evidence: [mirror configuration](https://github.com/actions/runner-images/blob/e06ccbf37708c99aa5d2db14c9e9c4a2664ed761/images/ubuntu/scripts/build/configure-apt-sources.sh),
  [bounded apt settings](https://github.com/actions/runner-images/blob/e06ccbf37708c99aa5d2db14c9e9c4a2664ed761/images/ubuntu/scripts/build/configure-apt.sh),
  and [issue 14594](https://github.com/actions/runner-images/issues/14594).
  These are external evidence, not implementation instructions. In particular,
  do NOT adopt examples that turn failed prerequisite installation into success.
- The existing TUI login test asserts saved-key UI after settle(), approximately
  30 ms, although saveApiKey awaits lock/fsync/rename. An isolated 150 ms delayed
  real-save diagnostic reproduced the assertion failure and passed with bounded
  completion observation. The sibling login/footer test already polls completion.
- v0.6.0 publish returned at 13:06:49Z; registry publication time was
  13:12:01.136Z. Its 180-second visibility check failed even though publication
  succeeded and was subsequently verified. Never publish again to resolve that.

No system/global package changes on the developer machine, Docker startup,
production configuration/credentials, paid inference, trust/account changes,
new dependencies or runtime feature changes are included. Docker is currently
not running, so local mocked shell tests do not certify real Linux apt behavior.

## 2. CI prerequisite provisioning

### 2.1 Shared helper and isolation

Add `scripts/install-ci-search-tools.sh`, used by ordinary ci/verify and the
release/gate job. Keep both existing verify steps and CI_REQUIRE_SEARCH_TOOLS=1.
Keep the Node 22.19.0/24 matrix and ubuntu-latest; do not mask missing binaries,
skip collection, add continue-on-error or weaken tests.

The helper is CI-only. Actual privileged apt execution happens only on an
explicitly approved hosted CI run, never during local development verification.

- Require Linux, dpkg architecture amd64 (the current hosted matrix), a valid
  Ubuntu codename from lsb_release, and usable RUNNER_TEMP/GITHUB_PATH paths.
  Reject unsupported/invalid configuration before invoking apt. Do not invent
  general distribution/architecture support or hardcode noble on a moving image.
- Create an owned unique directory below RUNNER_TEMP. Generate an explicit
  source list using only HTTPS archive.ubuntu.com/ubuntu for the codename and
  updates, and security.ubuntu.com/ubuntu for security; components main/universe.
  Restrict EVERY source entry with arch=amd64 even if dpkg has registered foreign
  architectures; do not request unsupported foreign indexes or reject unrelated
  foreign registrations. Use the image's Ubuntu archive keyring through signed-by.
  Do not fetch new signing keys, disable signatures/TLS or permit unauthenticated
  packages.
- Supply this source list and an empty sourceparts setting to BOTH apt update
  and install. Use isolated lists/cache directories under the owned temporary
  root so cached mirror-list/third-party indexes cannot select Azure again.
  Keep the system dpkg status database, since real package installation needs it.
  Arrange directory access for apt's existing sandbox user without writing any
  global apt source, resolver, proxy, certificate or account configuration.
- Pass explicit bounded acquisition options (Retries=1, HTTP/HTTPS Timeout=15)
  and APT::Update::Error-Mode=any. An update or install failure remains fatal;
  never continue with stale indexes. Install only ripgrep and fd-find with the
  existing --no-install-recommends policy. No upgrade/purge or bootstrap curl|sh.
- Report the chosen codename/architecture, source policy and retry bounds. These
  diagnostics contain public configuration only, never credential/proxy values.
  This bypasses the problematic image mirror list; it does not claim to repair
  arbitrary hosted DNS failures. If canonical hosts also fail, fail clearly.
- Verify real rg/fdfind availability/version after installation, create the fd
  alias in an owned tool directory, and append its path to GITHUB_PATH only after
  success. Paths containing spaces must work; reject newline-bearing paths.
- Put a 10-minute timeout on the workflow provisioning step. Native apt limits
  control ordinary retries; the hosted job/VM is the final containment boundary.
  Do not change Vitest timeouts, UV_THREADPOOL_SIZE or application scheduling.

### 2.2 Offline tests

Extend `test/ci-prerequisites.test.ts`, which currently asserts the exact inline
apt commands, to assert shared-helper use, timeout, strict verification and order.
Add mocked-command execution tests: sudo must be an explicit fixture stub that
records/validates argv and NEVER executes real privileged commands. Test valid
Ubuntu input, quoted paths, invalid platform/arch/codename/configuration, fatal
update/install/tool-verification failures and no PATH publication on failure.
Assert identical source/cache options on both calls, official signed HTTPS
sources, strict update error handling and absence of the image mirror list.
Include native amd64 plus registered foreign architectures and prove that every
source used by both apt calls remains amd64-only. Keep existing missing-tool
collection and optional-local-skip regressions intact.

Use the existing ink-search-prerequisites- fixture prefix when practical. If
additional prefixes are necessary regenerate the committed inventory; never edit
it manually. Local tests must not perform DNS, network or package installations.

## 3. TUI login readiness

In test/repl-tui.test.ts replace only the saved-key fixed-delay assumption with
existing bounded frameContains/vi.waitFor completion observation. Keep the key,
model hint, durable credential read, cancellation and history-exclusion assertions;
do not merely sleep longer or extend the 15-second test deadline.

Add a deterministic gated-save regression using the real saved credential path
in isolated HOME/auth fixtures. A wrapper may delay saveApiKey behind an explicit
promise gate: witness entry, prove the success UI is absent before release, then
release it and await real persistence/UI completion. Prefer a handshake over a
150 ms wall-clock threshold. Always release gates, restore spies/environment and
close the REPL on failure so a failed assertion cannot contaminate later tests.
No production auth/renderer code, real keys, provider requests or global state.

## 4. Registry metadata visibility after a successful publish

Add testable `scripts/check-registry-visibility.mjs` and call it from the existing
post-real-publish visibility step. Keep tag-only publication, both repository
variable gates, ancestry/identity/npm-version checks, OIDC permissions, dispatch
always-dry-run behavior and npm publish invocation unchanged. Do not add any
publish/retry/gh-dispatch command to the verifier.

### 4.1 Verification contract

- Validate package=ink-agent, supported stable version syntax and expected
  40-hex source commit before network/file output. Resolve the expected commit
  explicitly with git rev-parse "$GITHUB_REF^{commit}" in the workflow. Before
  that setup, the workflow emits a fixed, non-interpolated notice to stderr and
  best-effort GITHUB_STEP_SUMMARY: npm publish returned success, verification is
  pending, and publication must not be rerun. Thus a git/setup failure cannot
  prevent the already-published distinction from being reported.
- Use unauthenticated GET of the exact version metadata on registry.npmjs.org,
  never npm latest or a user-controlled endpoint. Do not consult npmrc/auth,
  follow redirects, send tokens or spawn npm publish. Do not treat HTTP 200 alone
  as success: require matching package/version/gitHead and the expected official
  tarball URL. Use manual redirect handling and reject 3xx/redirected responses.
  Metadata visibility is not cryptographic artifact/provenance verification;
  retain the separate post-publication operator verification.
- Default total monotonic budget: 600 seconds. Per-request cap: 15 seconds,
  bounded by remaining budget and covering headers AND body parsing. Bound
  response size (256 KiB). Pause 5/10/20 seconds, then at most 30 seconds between
  probes, never sleeping past the deadline. Clean up timers/readers and avoid
  unhandled rejections if aborted work settles late.
- Retry network/timeouts and HTTP 404/429/5xx. A 200 object with absent required
  fields is pending only while every supplied identity value is consistent with
  the request. Supplied wrong-type/mismatching identity or tarball values, invalid
  JSON/object shape, oversized bodies, redirects and other terminal HTTP errors
  fail verification immediately. A missing field cannot conceal another supplied
  mismatch. Cancel/discard unused response bodies. Specify these classifications
  in tests; never dump untrusted bodies or make a failure look like success.
- Exit 0 only after metadata verification. On deadline/final verification failure,
  exit nonzero and explicitly state that npm publish already returned success,
  registry verification is pending/failed, and the workflow must NOT be rerun to
  publish again. Add this distinction to GITHUB_STEP_SUMMARY as well as stderr.
  Never make an unverified publication look fully successful merely to turn the
  job green. Reporting failures are warnings: preserve the verifier's primary
  success/failure outcome and always emit its stderr notice even if summary
  append fails. Invalid verifier input must not write its summary; the earlier
  fixed workflow notice covers that path. Workflow step timeout: 12 minutes,
  leaving cleanup/reporting reserve.
- Export a pure/injectable verification seam (fetch, clock and sleep) so all unit
  tests use fake transport/time and import has no network/CLI side effect. CLI
  invalid-input cases must fail before requesting anything. Tests use private
  summary paths; no inherited GitHub output path may be written locally.

### 4.2 Tests

Add `test/registry-visibility.test.ts` for immediate and delayed success beyond
180 s, conserved request identity, 404/429/5xx/network recovery, redirect/error
classification, wrong/missing metadata, mismatched gitHead/tarball, malformed or
oversized bodies, stalled body/header requests, deadline/backoff boundaries and
summary/exit text. Fake time must make the entire budget deterministic and fast.
Extend release-workflow guards to prove that verification follows successful
real publication only, dispatch cannot reach it, and no publish guard was changed.
Exercise a pre-verifier git/setup failure, invalid CLI input and summary-write
failure offline, proving the fixed stderr notice and primary error/exit outcome
remain intact without any unintended network/file action.

## 5. Files, documentation and package invariants

Expected scope:

- .github/workflows/{ci,release}.yml; the two new scripts above.
- test/{ci-prerequisites,repl-tui,registry-visibility,release-guards}.test.ts.
- package.json lint:scripts adds node --check / bash -n for new scripts only;
  no version, dependency, engine, launcher or lifecycle behavior changes.
- RELEASING.md describes isolated CI provisioning and the future 10-minute
  verifier/timeout distinction. Preserve historical 180-second release evidence.
- CHANGELOG.md may add accurate maintenance notes under Unreleased; preserve
  the entire published 0.6.0-and-older section byte-for-byte.
- This design/review/validation record; generated fixture inventory only if needed.

No src/ changes, lockfile regeneration, install scripts or global installation.
The published 0.6.0 tarball/tag stay immutable. A future local development pack
may differ in package.json lint metadata/Unreleased notes; it is NOT a replacement
0.6.0 artifact and must not be uploaded under that already-published version.

## 6. Verification, reviews and external boundary

1. Obtain fresh-context independent design approval, closing required findings
   before implementation. The initial design review was separately owner-approved.
2. Implement sequentially in this worktree. Use existing dependencies read-only
   through a symlink; never npm ci/install against that shared target. All build,
   test, HOME/XDG/cache/config/output paths must be workspace/scratch owned.
3. Run shell/JS syntax checks and targeted offline regressions, including negative
   controls showing fixed-delay/weak visibility behavior fails the new assertions.
   Run both typechecks, lint, build, full suite with original deadlines/default
   pool, identity and whitespace checks. Use available verified temporary Node
   22/24 binaries for relevant local checks without installing runtimes. Clearly
   label macOS results; mock apt tests cannot certify real Linux installation.
4. Run offline packaging smoke with read-only cached dependencies. Check runtime
   dist output, dependencies, version pins and published changelog history against
   baseline; only the explicitly allowed development metadata/notes may differ.
5. Obtain independent implementation review (especially privileged-command mocks,
   source isolation and post-publish reporting). No merge or readiness declaration
   before findings close. Commit without hook bypass; merge only with --no-ff
   after checking main has not advanced, and verify reviewed/integrated trees.
6. Ask separately before pushing main. Describe that ordinary Linux Node22/24 CI
   will execute the real isolated apt helper and may install the two system tools
   on ephemeral hosted runners; Pages may run for changed docs/package files.
   This does not push tags or publish npm. Verify the exact new commit's CI,
   including effective official-source logs, real rg/fd and full tests/artifact.
7. No automatic CI reruns/dispatches, global changes or new release. If Linux
   provisioning still fails, retain diagnostics and report the failure rather
   than skipping prerequisites or relaxing signatures. Historical v0.6.0 release
   runs must never be used to test the new verifier.

## Review and execution record

- Owner-approved design reviewer `4717ca7d` requested two changes: amd64-only
  source filtering despite foreign registrations, and ownership of the fixed
  publication-success notice before verifier setup/input validation. This
  revision incorporates both and their offline regressions. The reviewer re-read
  the revision and returned APPROVE before implementation, closing both findings.
- Implementation/local verification: complete for the candidate below. This does
  not certify hosted-Linux acceptance.
- Independent implementation reviewer `cf5a290b` returned APPROVE, with zero
  required findings. The reviewer examined all tracked and untracked changes,
  verified 12/12 candidate-manifest hashes, checked the supplied Node22/24
  evidence, and independently passed 15 registry cases on Node 25.5.0 plus
  eight non-executing APT mock cases, including alias-verification failure.
  Review artifacts: `/tmp/ink-ci-maint-review.rOoavT/{registry-review,apt-mock-review}.log`;
  decision record: `/tmp/ink-ci-release-reliability.EmQ1Go/implementation-review.md`.
- One low-priority nonblocking suggestion remains: add a persistent regression
  forcing the gated-save test itself to time out and checking subsequent-test
  isolation. No corresponding defect was observed. Assertion-failure cleanup
  is already exercised by the negative control. No additional code change was
  necessary to close implementation review; the suggestion is future coverage.
- At review approval the changes were uncommitted on the dedicated maintenance
  branch. Only this document's factual review/authorization record was updated
  afterward; all reviewed code/config/test hashes remain unchanged. Local commit
  and --no-ff integration results are recorded in the evidence root.
- No remote push, CI/Pages trigger, system install, dispatch or publication has
  been performed for this maintenance batch.

### Local candidate verification

Platform: macOS arm64 (Darwin 27.2.0). Development dependencies were reused
read-only through this worktree's node_modules symlink; no install altered the
worktree/shared dependency tree and no lockfile was regenerated. Artifact
installations wrote only owned scratch prefixes. Final npm commands used private
HOME/config/cache paths under the evidence root, with inherited GitHub output
paths unset. Full suites
kept the default worker pool, original 15-second test deadline and strict
CI_REQUIRE_SEARCH_TOOLS=1; real local rg 15.2.0 and fd 10.4.2 were available.
All APT/sudo exercise was through non-executing fixture stubs.

| Local runtime | Typecheck / lint / build | Full test files | Full tests | Offline artifact smoke |
| --- | --- | --- | --- | --- |
| Node 22.19.0 / npm 10.9.3 | passed | 176 passed | 5188 passed | 442 allowed files; install, help/version, npm-exec passed |
| Node 24.22.1 / npm 11.19.1 | passed | 176 passed | 5188 passed | 442 allowed files; install, help/version, npm-exec passed |

Node 22's bundled npm is used only for local application checks; publication
continues to require npm >=11.5.1 on the Node 24 publication job. The available
Node 24/npm 11.19.1 pair also passed the unchanged npm-version guard.

Evidence under `/tmp/ink-ci-release-reliability.EmQ1Go/`:

- `final-node-{22.19.0,24.22.1}-{typecheck,lint,build,full-tests,package-smoke}.log`.
- `negative-fixed-delay-final.log`: replacing the gated completion observer with
  the original one-render-interval assumption causes the expected saved-UI
  assertion failure, without timeout or unhandled rejection. The real observer
  starts before gate release and stays pending beyond 30 ms. Cleanup releases
  and drains the real save/observer, closes the REPL and restores the spy/env.
- `negative-http-only-final.log`: accepting a 200 response without identity
  validation causes the wrong-package rejection regression to fail as expected.
  Both negative controls restored exact source bytes in finally before the full
  checks; neither mutation remains in the candidate.
- `artifact-comparison.json`: both development packs contain the same 442 paths
  and modes as the previously verified registry artifact. All 396 dist files
  and 440 total files are byte-identical. The only content differences are the
  allowed package.json lint:scripts addition and CHANGELOG.md Unreleased notes;
  the complete 0.6.0-and-older changelog remains byte-identical. Tests, scripts
  and design docs remain excluded. These are local development packs, not
  replacement publication artifacts for the immutable 0.6.0 version.
- `git diff --check` and identity guard passed. src/, package-lock.json,
  dependency/engine versions and launcher behavior are unchanged. Regenerating
  the 321-entry fixture-prefix inventory produced no diff.
- v0.6.0 remains tag object dde0127b514928b875adcf4d2d023057a441436e,
  source commit 5a4056b2f58558553c293e34e4d3a4211cb4ac49. Main remains
  9b8bb53aeca723850cb13255bb3e5344a1f038c6.

Design and implementation review are closed. Local integration uses commit and
--no-ff merge without bypassing hooks, after confirming main has not advanced;
see the evidence root's integration.json for commit/tree identities and results.
The remaining external acceptance gate requires separate approval before any
push/hosted CI. No real Ubuntu installation or live invocation of the new
post-publish verifier is claimed; do not test it by republishing or rerunning a
historical release workflow.
