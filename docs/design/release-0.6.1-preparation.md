# Ink 0.6.1 release preparation

Date: 2026-11-12
Status: published and verified; global upgrade and publication-record independent review/integration pending.
Branch/worktree: `release/0.6.1`, `.worktrees/ink-release-0.6.1`.
Base: `c0a0c0adaaea234d572778e10183443c9c225bac` (clean local main).
Previous release: `ink-agent@0.6.0`, tag `v0.6.0`, source `5a4056b`.
Evidence root: `/tmp/ink-release-0.6.1.VVf5Da/`.

> **Publication supersedes earlier pending statements.** The
> [Publication record](#publication) below records completed main push, hosted
> CI/Pages, tag/npm publication and the formal Latest GitHub Release on
> 2026-11-12. It supersedes their preparation-time `pending` / `not performed`
> statements. The preparation branch/base above, design §§1–5, early execution
> record and local-candidate results remain historical snapshots, not a claim
> that publication is still outstanding. Global upgrade is still pending;
> publication-record review/integration and its separately approved push are
> also not complete.

## 1. Goal, identity and approval boundaries

Prepare a maintenance patch, `ink-agent@0.6.1`, sole executable `ink`, annotated
release tag `v0.6.1`. The owner requested release preparation, publication and
then updating the installed application. This goal does not waive standalone
confirmation for pushes, a tag that publishes to npm, GitHub Release creation,
publication-record push or the global package update. Do not perform any such
operation until its exact resources/effects are presented and approved.

The release includes the reviewed changes already on main since v0.6.0:
post-trust startup defaults, project trust consistency, model-list fallback,
bounded implementation simplification, owned test fixtures and CI/release
reliability. No additional feature, dependency, workflow, session format,
credential, trust-store or account/gate change belongs to this batch. Existing
child version-drift safeguards remain; do not modify old child launch records.

Read-only observations on 2026-11-12: remote main is `e02e464`, local main has
29 unpublished commits, npm 0.6.1 returns HTTP 404, and no remote v0.6.1 tag
exists. GitHub latest is v0.6.0. The new publication gate is `true`, selected
package is `ink-agent`, and the legacy gate is absent. Recheck these observations
before each relevant external step; they reserve neither a version nor a tag.

Installed state: `/opt/homebrew/lib/node_modules/ink-agent` is a real directory,
not a source link; `/opt/homebrew/bin/ink` points to its `bin/ink.js`. Both the
package and command report 0.6.0. The observed global npm prefix is
`/opt/homebrew`. Do not change `~/.ink`, `~/.imp`, npm/git/shell configuration or
other packages. A running session will not be claimed to have upgraded merely
because a new process reports 0.6.1.

## 2. Metadata and documentation implementation

Implementation starts only after an independent adversarial design review closes.

- Bump exactly five pins: package.json version, package-lock.json top-level and
  root-package versions, src/format.ts VERSION, and the exact version assertion
  in test/package-metadata.test.ts. Do not regenerate dependencies or weaken the
  assertion. Verify parsed package/lock equality except those version fields.
- Retain an empty Unreleased heading. Put the complete pending notes under
  `## [0.6.1] - 2026-11-12`, with user-visible startup/fallback fixes first.
  Preserve the 0.6.0-and-earlier section byte-for-byte. Update the candidate date
  if publication moves. Do not advertise a new feature or security emergency.
- Keep the lease refusal and preflight trust-persistence caveats. Mention the
  internal modelMaxTokensFor relocation accurately, without claiming stable
  undocumented deep imports. Do not claim real provider/entitlement validation.
- Update RELEASING.md to select 0.6.1 as prepared/unpublished, retain verified
  0.6.0 publication history and point to this record. Update its exact smoke
  output example. Record preparation in PROJECT_PLAN.md without rewriting
  historical entries. Public behavior documentation is already in the base;
  no unrelated documentation rewrite is needed.
- Record real checks, reviews and approvals here as they occur, never in advance.

## 3. Local validation, artifact freeze and integration

Use a worktree-local symlink to existing node_modules for read-only dependency
use. Never run npm ci/install against that shared target. All build output,
site output, logs, caches, fixtures and installation prefixes remain inside the
workspace or owned scratch. Disable the npm update notifier; local validation
is offline except explicit unauthenticated public-metadata reads. Use the
existing test network guard, fake credentials and loopback providers only.

1. Run typecheck, lint, build, full npm test, identity and npm-version guards,
   documentation-site build, and `git diff --check v0.6.0..candidate`.
2. Reuse existing macOS arm64 Node 22.19.0 and 24.22.1 scratch runtimes after
   checking executable version/architecture, archive hashes against saved
   checksums and executable bytes against the archive. The saved lists lack
   signature evidence: label these consistency checks, not official signature
   verification. Run full suites and source/test typechecks on both runtimes.
   These local checks do not replace Linux Node 22.19.0/24 CI.
3. Run offline package-smoke using the existing npm cache as a read-only source.
   Preserve the produced tarball and SHA-256/SHA-512 evidence. Verify allowlisted
   paths, modes, exact 0.6.1 output, isolated install and local npm-exec. Do not
   fetch missing smoke dependencies or run install lifecycle scripts.
4. Run a real PTY full-CLI probe against the isolated candidate installation,
   with temporary HOME/XDG/auth/settings/catalog/log/history, sanitized env,
   absent installation .env, local synthetic OpenAI-compatible provider and
   network preload. Cover first trust accepting a project default, denial using
   global default, saved-session restoration preserving its saved model, model
   switching and orderly exit/terminal restoration. This is terminal input to
   bin/ink.js, not merely component tests or injected shell events. Do not call
   a real model, load user extensions/MCP or write production state. Keep the
   harness only in scratch; do not expand runtime code to make acceptance pass.
5. Obtain independent fresh-context implementation/artifact review, including
   exact metadata changes, release-note scope, dependency/history preservation,
   validation evidence and candidate artifact. Close required findings first.
6. Commit without bypassing hooks; confirm main has not advanced; merge with
   --no-ff. Verify the merged tree equals the reviewed candidate. Rebuild and
   run integrated identity/package regressions as needed; keep both trees clean.

## 4. External publication sequence (each separately confirmed)

1. Request approval to push reviewed main to FishInSalt/ink. This publishes all
   pending main commits and triggers supported-Linux CI and changed documentation
   Pages deployment, but no npm publication. Confirm remote ancestry before a
   normal fast-forward push. Verify both Linux matrix jobs for that exact SHA;
   inspect failures rather than bypassing checks or automatically rerunning.
2. After CI success, recheck exact identity, date, version/tag availability,
   main ancestry and unchanged publication gates. Request approval to create
   and push annotated v0.6.1 at the reviewed main commit, explicitly explaining
   that its tag-push workflow publishes publicly to npm with OIDC provenance.
   Never force-push, move a published tag, change gates or use token fallback.
3. Monitor release workflow. A successful npm publish followed by visibility
   failure is still a publication: never rerun to repair it. If publish times
   out, is cancelled, disconnects or otherwise has an uncertain acceptance
   result, also stop all reruns and investigate registry plus full run/attempt
   logs read-only; missing success output or temporary 404 is not proof that
   nothing was published. Only a proven failure before real publish begins may
   lead to a separately requested rerun. A green skipped/gate-disabled run is
   not publication and does not authorize gate changes. Every rerun/dispatch
   request must identify run/attempt, tag, SHA, gates and possible registry writes.
   Inspect registry metadata/latest/gitHead, fetch the official tarball and verify
   integrity, every file body/mode against the reviewed candidate, isolated
   installed help/version and cryptographic registry signatures/publish/provenance
   identity. Match artifact digest, repository, release.yml, OIDC issuer, tag,
   merged SHA and actual run/attempt; report unavailable checks rather than
   inferring them from URL presence.
4. Request approval to create the non-prerelease GitHub Release using only the
   dated approved CHANGELOG section. Verify tag, latest/published state and body.
5. Record the verified outcome on a separate docs branch/worktree, independently
   review it, validate and merge --no-ff; separately request its remote push.

## 5. Post-publication local upgrade (separately confirmed)

Only after the registry artifact and provenance checks pass, present the exact
pinned upgrade operation and wait for standalone approval. Recheck that the
existing module is still a normal ink-agent directory and the bin link still
belongs to it; unexpected/foreign entries block the update.

Do not replace the installation used by a live Ink session. Lazy module and
native dependency loads make an in-session replacement unsafe, even if most
modules are already loaded. Prepare and independently review a standalone
scratch upgrade/verification script. Present its exact command and effects for
approval, then ask the owner to exit all relevant Ink sessions normally and run
it from a separate terminal, outside Ink. The script must refuse if relevant
Ink processes still use the target or process ownership is uncertain; it must
not kill them. If this handoff cannot be established, report upgrade pending
and provide the approved command rather than claim completion. There is no
automatic background scheduling or implicit approval to replace a live runtime.

Pin both application and actual production dependencies. After registry artifact
verification, install that verified official 0.6.1 tarball into a fresh scratch
prefix using an owned offline cache containing only the lockfile-pinned
production manifests/tarballs. Check every installed production dependency's
name/version/integrity against the candidate lock, and run installed acceptance
on that exact set. Range dependencies must not silently resolve to newer bytes.
Keep this tested cache for the upgrade; recheck its evidence and the installed
0.6.0 dependency inventory before any global write. Unexpected dependency or
installation state blocks the update pending investigation.

The standalone upgrade uses npm install -g with that verified local registry
tarball, --offline, explicit /opt/homebrew prefix, scripts/audit/fund/update-
notifier disabled, the tested scratch cache and empty scratch npm configuration.
This installs exactly ink-agent@0.6.1 without obtaining a different range
resolution from the live registry. No sudo, npm upgrade, other global package,
user configuration or state migration. Compare installed application file
bytes/modes and production dependency identity with the pretested artifact/set.
Run installed help/version from a neutral directory with isolated HOME and
network blocking. Verify the real shell command resolves to that same
installation and reports Ink 0.6.1; preserve a machine-readable result and logs
in scratch for inspection from the next session. Merely replacing files or
printing a version does not establish successful full acceptance.

Preserve a verified 0.6.0 registry tarball in scratch as recovery evidence if
available, but never automatically downgrade, restore user state or delete the
new installation on failure. Describe partial results and request a separate
recovery operation. No process termination or credential refresh is authorized.

## Review and execution record

- Design review round 1 (832c0b02): NEEDS-FIXES. Revision 2 adds a quiescent
  independent-terminal upgrade handoff, lockfile-pinned offline production
  dependency acceptance and explicit uncertain-publish/rerun refusal. The same
  fresh-context reviewer re-read revision 2 and returned APPROVE before any
  metadata implementation. Concrete upgrade script review remains required.
- Metadata/documentation implementation: complete locally. Exactly five version
  pins select 0.6.1. Parsed package/lock comparisons allow only the three
  application-version changes; dependency records and the 0.6.0-and-earlier
  CHANGELOG bytes are unchanged. Candidate notes retain all pending changes,
  lead with startup/fallback fixes and disclose the internal helper relocation.
- Local validation: complete as recorded below. Independent implementation/
  artifact reviewer 77a8ae59 returned APPROVE with no required fixes, independently
  checking metadata/history, all tar entries, rebuilt modules and 1,967 installed
  dependency files. Independent PTY reviewer 62be434b returned APPROVE after
  checking frozen scripts, original input/output, HTTP/session/termios evidence
  and four separate negative/control probes. Both reviews closed before the
  release candidate commit/integration; their conclusions do not authorize any
  external action. Concrete upgrade-script review remains pending.
- Main push, Linux CI, tag/npm publication, GitHub Release and record push: pending.
- Global installation approval and verification: pending.

## Local candidate validation

All results below are macOS arm64, not hosted Linux CI. Logs are under the
evidence root named above. No real provider, user configuration or global
installation was used. Worktree dependencies were reused read-only.

| Runtime | Full test files | Full tests | Source/test typechecks |
| --- | --- | --- | --- |
| Node 25.5.0, default workers | 187 passed | 5,763 passed | passed |
| Node 22.19.0, six workers | 187 passed | 5,763 passed | passed |
| Node 24.22.1, six workers | 187 passed | 5,763 passed | passed |

- npm 11.8.0 satisfies the >=11.5.1 publication CLI guard. Identity guard,
  typecheck, lint (347 files, docs and legacy-name gates), build and baseline-
  range whitespace checks passed. Package metadata/tar/release-guard regressions:
  3 files, 211 passed. Documentation site: 24 pages plus robots and sitemap.
- The first Node 22/24 runs used an overly narrow PATH that omitted the existing
  fd executable: each had 5,740 passed and 23 skipped, not full coverage. Both
  were rerun with the original PATH and CI_REQUIRE_SEARCH_TOOLS=1, producing
  the complete results in the table without changing code or assertions.
- Existing runtime archives match saved SHA-256 lists and current bin/node
  matches each archive byte-for-byte; runtime-consistency.json records actual
  version/architecture. Saved lists have no signature evidence, so official
  signature verification is not claimed.
- Offline package smoke passed: 454 allowed application files, modes, isolated
  install, exact Ink 0.6.1/help and local npm-exec. Frozen candidate:
  `/tmp/ink-release-0.6.1.VVf5Da/candidate-artifacts/ink-agent-0.6.1.tgz`,
  864,816 bytes, SHA-256
  `f68d0fa0ae3e3c9b61c9a4defc42e8eb48aeeb62db12399b085a7ab177ed4f31`.
  candidate-artifact.json records SHA-512/integrity. All 454 file bodies/modes
  match the current candidate source/build. Remote publication repacks, so
  compare unpacked files/modes rather than require identical compressed bytes.
- The isolated installed production set contains 12 packages; each actual
  name/version/resolved/integrity matches a source-lock record and canonical-
  prefix npm ls exits 0. This standalone installation selects marked 18.0.11;
  the source lock's additional shared/dev-root marked 18.1.0 is not installed.
  This exact tested set, not an assumed identical filesystem layout, must be
  preserved for the later offline global upgrade. Evidence:
  candidate-production-set.json and candidate-installed-dependencies-canonical.json.
  An initial npm ls through macOS's /tmp alias reported the local file reference
  invalid; repeating from canonical /private/tmp resolved the tooling diagnostic.
- Real full-entry PTY acceptance ran directly against the smoke's installed
  artifact: 3 scenarios, 161 assertions passed. First trust selects project
  default; refusal never reads project settings and selects global; /model
  switches on the next turn; restore preserves saved model/history against
  changed project/global/env defaults. Three normal exits returned 0 with exact
  termios restoration observed before any cleanup. Final attempt made 19
  loopback HTTP requests (4 inference, 14 catalog, 1 listing), no nonlocal
  attempts or forced termination. Evidence: pty/REPORT.zh-CN.md and
  pty/attempt-003/summary.json. The first two scratch driver attempts failed
  (audit recursion, then macOS PTY ENOTTY after controller exit); only the
  harness changed, with original failures retained and no deadline relaxation.
  Cumulative attempts made 29 loopback requests, distinct from the final 19.
- PTY coverage is Node 25.5.0 and synthetic OpenAI-compatible SSE, not GUI/IME,
  real credentials, subscription entitlement or a Linux/runtime matrix. Existing
  automated tests cover additional temporary trust/cancellation/abort paths.
  Nonempty test roots were retained as required. No external push/tag/release,
  real npm publication, production-state migration or global upgrade occurred.

## Publication

Published and verified on 2026-11-12. This section records completed operations
and retained evidence; it authorizes no new publication, rerun, push or global
installation. The preparation-time observations above remain historical.

### Source, tag and supported Linux CI

- Reviewed candidate: `c03a169fcc1926ee0070153f56b52598aec5ae0b`.
  Main release merge: `5457731e30539046d4a9c93283c2b4a34bb3d8bb`, integrated
  with `--no-ff`. Both have tree `3c370309b588d019b438f105ef52d0d89c8623dc`;
  the merge did not change the reviewed candidate's files.
- Annotated `v0.6.1` tag object:
  `48e05bcf0f76507d29e541350b5df9fa84014adb`. Its peeled commit is the release
  merge, not a later publication-documentation commit. Do not move or recreate it.
- [CI `43159647864`](https://github.com/FishInSalt/ink/actions/runs/43159647864)
  succeeded on that exact merge. Both Ubuntu jobs passed prerequisite checks,
  source/test typechecks, lint, build, release identity and packaging smoke.
  Full-suite results from `ci-main-result-retry.json` and `ci-main-full.log`:

  | Linux runtime | npm | Test files passed | Tests passed | Skipped |
  | --- | --- | --- | --- | --- |
  | Node 22.19.0 | 10.9.3 | 187 | 5,761 | 2 |
  | Node 24.22.2 | 11.19.1 | 187 | 5,761 | 2 |

  The two unchanged Darwin-only skips are the named-pasteboard JXA integration
  in `test/images-resize.test.ts` and real packaged-helper load in
  `test/tui-transport.test.ts`. These Linux results supplement the macOS matrix
  above; they do not mean 5,763 tests executed on Linux.
- [Pages `43159647894`](https://github.com/FishInSalt/ink/actions/runs/43159647894)
  completed both build and deployment successfully for the same merge, as
  recorded in `pages-main-result.json`.
- Integrated local evidence (`integrated-verification.json`) also records
  candidate/main tree equality and all 454 artifact files matching. No source,
  lockfile, CHANGELOG or workflow changes were needed after the reviewed merge.

### Release workflow and registry visibility

[Release run `43160272629`, attempt 1](https://github.com/FishInSalt/ink/actions/runs/43160272629/attempts/1)
was a `v0.6.1` tag-push run at the release merge. `release-result.json` and
`release-full.log` show successful gate and publish jobs, the real npm publish
step and registry visibility check; dry-run and skipped-publication notices
were skipped, not mistaken for publication.

The Node 24.22.2/npm 11.19.1 gate passed 187 files / 5,761 tests with the same
two Darwin-only skips. Gate and publish-job 454-file artifact smokes passed.
Real `npm publish --ignore-scripts --provenance --access public` returned
`+ ink-agent@0.6.1` at `2026-11-12T05:19:29Z`. The workflow recorded successful
publication separately from pending registry verification, then reported
matching exact-version metadata/source at `2026-11-12T05:23:06Z`.

This was the **first release use of the new 10-minute visibility window**, and
it passed on attempt 1. There was no workflow rerun, publish retry or dispatch.
A successful visibility check is not itself cryptographic artifact/provenance
verification; that separate verification is recorded next. No npm publication
remains pending; do not rerun this workflow or reuse the version/tag.

### Registry artifact, signatures and provenance

- Exact-version and `latest` registry metadata both select `ink-agent@0.6.1`,
  `gitHead` `5457731e30539046d4a9c93283c2b4a34bb3d8bb`, and the official
  `https://registry.npmjs.org/ink-agent/-/ink-agent-0.6.1.tgz` tarball.
- Downloaded registry archive: 866,810 bytes; SHA-256
  `ea0b8eb565fee60f9cc53ada0ccc43bcdf2ae29eab9bd1024d5c1d2630eb7a95`;
  SHA-1 `a44b5bda9ef1bae087b0da4e4a51a5422e3c2ef1`.
  Integrity:
  `sha512-cxuX1c3G5q2f79E5QQGyAQ2xh7wo9LDnCPPznu8ofR2lxzh7xMHHcDwrwhO3yVA/B5LnRJcyVXmu1zrKXka0LA==`.
  All **454 file bodies and modes** match the reviewed local candidate, whose
  SHA-256 remains
  `f68d0fa0ae3e3c9b61c9a4defc42e8eb48aeeb62db12399b085a7ab177ed4f31`.
  The differing compressed archive digests are not application-content changes.
- Two registry signatures verified for both exact-version and latest metadata.
  The npm publish attestation and SLSA provenance both passed cryptographic
  verification using existing Sigstore libraries and refreshed TUF-authenticated
  trust data in a private scratch cache. Verification includes DSSE, certificate
  chain/SCT, transparency inclusion proof/checkpoint and signed entry timestamps
  (SETs), which authenticate Rekor v1 `integratedTime`.
- Verified artifact digest, repository `https://github.com/FishInSalt/ink`,
  `.github/workflows/release.yml`, issuer
  `https://token.actions.githubusercontent.com`, `refs/tags/v0.6.1`, merged
  source SHA and run `43160272629` / attempt `1` all match. Provenance
  transparency-log index: `3825553002`; publish-attestation index: `3825606814`.
- Seven named negative controls were all rejected: `changed-signed-payload`,
  `wrong-workflow-identity`, `wrong-oidc-issuer`, `wrong-artifact-digest`,
  `wrong-source-commit`, `missing-rekor-v1-set` and
  `tampered-rekor-integrated-time`. These include semantic identity/digest
  controls, not seven distinct signature-corruption tests. The time-tampering
  control specifically failed with `TLOG_INCLUSION_PROMISE_ERROR`.
- Successful schema-2 report:
  `postpublish-prepared/registry-verification-DjEE8u/registry-crypto-verification.json`.
  Its SHA-256, retained from the verifier's final `VERIFICATION_SUCCESS` output,
  is `ee1955f6577d57aa14a33ac579d8aece49a3bd1647e564529c9cef8edc065fbf`.
  This is the external handoff value used by the installer, not a hash taken
  from an arbitrary self-consistent report as proof of its origin.

Before those real runs, independent reviewer `06c991da` identified two P1
issues in the **temporary scratch verification tools**, not the product:
self-consistent report/TUF-cache replacements lacked an independently retained
report digest, and proof/checkpoint alone did not authenticate Rekor v1
`integratedTime` when SET was absent. The reviewed fixes require an external
success-report SHA-256 with complete input/script/cache inventories, and valid
SETs for every attestation entry. They also add the two SET/time controls.
Reviewer `06c991da` approved the design and closed the implementation and
negative-control review before the actual verifier and installer runs. No product bug
is attributed to these tools, and no tagged product file, dependency, workflow
or tag was changed. Earlier scratch `FIX-PLAN.md`, `FIX-IMPLEMENTATION.md` and
README pending statements are retained as pre-execution history; the actual
successful run reports and logs below establish the executed results.

### Isolated registry installation

`postpublish-prepared/registry-install-SFuP0K/registry-install-verification.json`
records a passed schema-2 installation at `2026-11-12T06:31:51.955Z`. Its
`sourceReportSha256` equals the externally retained verifier digest above.
It reverified the fixed evidence cryptographically offline, including all seven
negative controls, before installation in a fresh scratch prefix.

- All 454 installed application file bodies/modes match the verified registry
  archive and reviewed candidate, with no unexpected application files.
- The actual production set is exactly **12 lockfile-pinned packages**, checked
  by name/version/resolved/integrity against the reviewed set and isolated
  cache. It retains pi-tui 1.5.1 and marked 18.0.11, not the additional source
  dev/shared-root marked 18.1.0. The tested set digest is
  `12df297ae09fdc59c95883a17d10c426a9a9b9892773ba6abb4562112c5736c4`.
  This verifies dependency identity and tarball integrity, not independent
  byte-by-byte comparison of every dependency file.
- Installed `--help` and exact `Ink 0.6.1` version output passed on local macOS
  arm64 Node **22.19.0, 24.22.1 and 25.5.0**. Saved runtime-byte consistency was
  checked; official Node runtime-signature verification is not claimed.
- Neutral-cwd npm-exec inferred the sole bin from the verified local registry
  tarball and passed; its application files and exact production set matched.
  There was no plain `ink` package lookup or global installation.
- Installation used offline mode, no lifecycle scripts, isolated state/config
  and a Node API network blocker. The intentional blocker self-test passed and
  was recorded separately; unexpected network attempts: **0**. This guard is
  not an operating-system network sandbox. No credentials or original evidence
  were written, and no global upgrade was authorized or performed.

These are installed help/version/npm-exec and artifact/dependency checks, not a
new full-CLI PTY acceptance run against the registry artifact or a real-provider
or entitlement test. The reviewed candidate's earlier 3-scenario/161-assertion PTY
evidence remains separate.

### GitHub Release

The non-draft, non-prerelease
[GitHub Release v0.6.1](https://github.com/FishInSalt/ink/releases/tag/v0.6.1),
id **`442614558`**, titled **Ink 0.6.1**, was published at
`2026-11-12T07:27:59Z`. The saved tag-specific and latest-release API responses
both identify this release as Latest. Its **4,020-byte UTF-8 body** equals
`release-notes.md` and exactly the approved `## [0.6.1] - 2026-11-12` CHANGELOG
section's notes, byte-for-byte; no earlier notes or generated additions are
included. It has no separately uploaded release assets.

### Evidence, global upgrade and documentation follow-up

All evidence paths below are relative to `/tmp/ink-release-0.6.1.VVf5Da/`
(`/private/tmp/...` is its canonical macOS alias):

- `ci-main-result-retry.json`, `ci-main-full.log`, `pages-main-result.json`;
- `release-result.json`, `release-full.log`;
- `github-release-0.6.1.json`, `github-latest-release.json`, `release-notes.md`;
- `registry-verifier-live-attempt-001.log`, `registry-install-live-attempt-001.log`;
- `postpublish-prepared/registry-verification-DjEE8u/registry-crypto-verification.json`
  and its retained registry inputs, tarball and private TUF cache;
- `postpublish-prepared/registry-install-SFuP0K/registry-install-verification.json`
  and its retained installation, verified registry-tarball copy and tested cache;
- `postpublish-prepared/FIX-PLAN.md`, `postpublish-prepared/FIX-IMPLEMENTATION.md`,
  `postpublish-prepared/before-fix-06c991da/` and offline regression evidence;
- `GLOBAL-UPGRADE-PLAN.md`: a separate upgrade design, not an executed upgrade.

No npm/tag/GitHub Release publication remains pending. The local global package
at `/opt/homebrew/lib/node_modules/ink-agent` remains **0.6.0**, a real directory;
`/opt/homebrew/bin/ink` still points to its `bin/ink.js`. Concrete upgrade-script
preparation, independent reviews and standalone upgrade approval remain
incomplete. Do not replace the installation used by any live Ink session or
claim that it has upgraded. Section 5's normal-exit, separate-terminal handoff
and verified offline artifact/dependency requirements still apply; no background
upgrade, process termination or production-state/configuration change is part
of this documentation batch.

This documentation-only follow-up implements approved section 4, step 5 in
`.worktrees/ink-release-0.6.1-publication`, branch
`docs/release-0.6.1-publication`, based on `5457731`. It changes only this record,
RELEASING.md and PROJECT_PLAN.md. Source, version/dependency pins, lockfiles,
CHANGELOG, workflows and the published tag remain unchanged. Independent
fresh-context documentation reviewer 369f1f18 returned APPROVE with no required
fixes after checking original CI, registry, installation and GitHub evidence,
including a separate offline cryptographic recheck. This closes the document
review before its local commit. Integration must preserve concurrent main work,
use `--no-ff` by default and obtain separate approval for any remote push. The
full product suite is not rerun for these documentation-only changes; the
candidate and hosted results above remain the product-test evidence.

Documentation validation: `npm run lint` checked 347 files without fixes;
script syntax, bilingual docs links/parity/anchors and the legacy-name guard
passed. A separate check of these three changed documents passed **23 relative
links / 8 anchors**, with 0 failures; `git diff --check` passed. Validation logs
are under `/tmp/ink-release-0.6.1-docs.YmEqYL/`. Shared dependencies were used
read-only through a temporary worktree-local symlink, removed afterward; no
`npm ci` or install was run. These checks supplement, rather than replace, the
independent documentation review recorded above.
