# Ink 0.6.1 release preparation

Date: 2026-11-12
Status: published; read-only publication metadata confirmed on 2026-11-12.
The original preparation evidence below remains a historical snapshot; see
[Publication](#publication) for the observation that supersedes pending claims.
This follow-up performs no global upgrade or new publication.
Branch/worktree: `release/0.6.1`, `.worktrees/ink-release-0.6.1`.
Base: `c0a0c0adaaea234d572778e10183443c9c225bac` (clean local main).
Previous release: `ink-agent@0.6.0`, tag `v0.6.0`, source `5a4056b`.
Evidence root: `/tmp/ink-release-0.6.1.VVf5Da/`.

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

Read-only follow-up on 2026-11-12, during the bounded review-fix batch:

- `https://registry.npmjs.org/ink-agent/latest` reports version `0.6.1` and
  `gitHead` `5457731e30539046d4a9c93283c2b4a34bb3d8bb`.
- Local annotated tag `v0.6.1` peels to the same release merge. Current source
  changes after that commit are Unreleased, not part of the registry artifact.
- `https://api.github.com/repos/FishInSalt/ink/releases/latest` reports
  `tag_name: v0.6.1`, `draft: false`, `prerelease: false`, published at
  `2026-11-12T07:27:59Z`. Its public page is
  [Ink 0.6.1](https://github.com/FishInSalt/ink/releases/tag/v0.6.1).

These observations supersede the earlier preparation-time `pending`, `404`,
`not performed` and latest-0.6.0 statements for publication availability only.
They are not a new cryptographic artifact/provenance verification, hosted-CI
result or global-installation check. The preparation tests and installation
observations retain their original dates and scope. This documentation update
performed no push, tag operation, publication, real-state migration or global
upgrade, and authorizes none. Do not republish `0.6.1` or move/reuse `v0.6.1`.
