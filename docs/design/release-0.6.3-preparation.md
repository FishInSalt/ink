# Ink 0.6.3 release preparation

Date: 2026-11-18 (UTC)
Status: independent adversarial design review approved before identity-pin
changes; local validation complete. Publication pending.
Base: reviewed Codex history fix on local main, `528acda` (`1aa17c7`).
Branch: `release/0.6.3`.

## Scope and local preparation

This is a patch for cross-model Codex history serialization. Send assistant
history without a replayable message ID as plain assistant text, rather than
an invalid `input_text` content array. Preserve exact-model native replay,
tool pairing and the existing session format. The source correction and its
bilingual user docs are already reviewed. This batch introduces no new
behavior, dependencies, workflow or authentication changes.

Read-only preflight on 2026-11-18 found npm `latest` at `ink-agent@0.6.2`,
remote `main` at `95f1a88`, and HTTP 404 for both the exact npm version
`0.6.3` and GitHub tag `v0.6.3`. These observations do not reserve either.

After independent design approval, bump the package, both lockfile versions,
the CLI `VERSION`, and the exact package-metadata test to `0.6.3`. Preserve all
other package/lockfile fields. Add a dated Fix entry in the CHANGELOG; leave
Unreleased empty and preserve historical notes. Document the candidate as
unpublished in RELEASING and the project ledger. If publication moves to a
new date, reconcile the notes before tagging.

## Verification

Follow the [release contract](../../RELEASING.md). Use a worktree-owned copy
of the matching dependencies, not a shared symlink: Vitest/Vite may write
loader scratch files under `node_modules` even for a targeted test. Start
all local gates with sanitized environment and private HOME, XDG, temp and
cache paths, empty npm configs and no production dotenv. Require `rg`/`fd`
with `CI_REQUIRE_SEARCH_TOOLS=1`; use fresh worktree-owned build outputs.
Run typecheck, lint, build, full tests, release identity and npm version
checks, local docs-site build, and the offline package/install smoke. Supply
its cache source separately by absolute path and read it only. Report the
exact host/runtime; local checks do not replace supported Linux CI. Stop on
missing cached dependencies; do not enable network access or lifecycle
scripts to make smoke pass.

Retain the reviewed tarball and a complete path/mode/content-digest manifest.
Compare every packed file to the intended candidate or fresh build, not only
the path list and file sizes. Record artifact identity and digests.
Independently review the source diff, release notes and artifact results;
address blocking findings before a normal commit and `--no-ff` local merge.
Check that the merge tree equals the validated candidate tree. No tag,
production credentials, existing user sessions or global installations are
needed for local preparation.

### Local validation results

- macOS arm64, Node `25.5.0`, npm `11.8.0`: typecheck, lint, build, release
  identity, npm version and `git diff --check` passed. The local docs build
  produced 24 pages plus robots.txt and sitemap.xml.
- The full offline suite passed 191 files / 6,280 tests with required search
  tools enabled. These results are not the supported Linux CI results or
  a live Codex request.
- The offline package smoke passed version/help, local installation and
  local npm-exec. All 457 packed file bodies and modes match both the
  candidate worktree/fresh build and the isolated installation. No pinned
  dependency changed, and historical CHANGELOG notes are byte-identical.
- Candidate archive integrity:
  `sha512-Ku86YXBwyHX3fxAB23SKTAuxSolw9fkCSx/hx0jxV43UFWys5SirJ86h5fLSJizDEkr5PTLBnxS6aoV7WQ2AXw==`.
  Manifest SHA-256: `f86bca949fb3ad04355c075b6a76b295fdbeba1ae6454c3668a00b68ae3fc7eb`.
  The tarball and full manifest were retained in private local scratch;
  neither is a registry or provenance observation.

## External sequence: separately approved

1. Stop and wait for approval of the exact single-ref `main` push to
   `FishInSalt/ink`, with tag auto-follow disabled. This triggers Linux CI
   and a Pages deployment for the changed docs/package metadata, but not
   npm publication. Check Pages and require both Linux Node 22.19.0/24 CI
   jobs green for that SHA. If the date changes after the push, review and
   validate the revised tree and seek fresh push approval and exact-SHA CI.
   For date-only CHANGELOG changes, record matching Pages build inputs with
   the prior green deployment instead of dispatching Pages.
2. Recheck identity/date, remote ancestry, exact npm version and tag absence,
   and both release gates without changing them. Stop and wait for separate
   approval to push the new annotated `v0.6.3` tag at the exact reviewed
   `main` commit. This starts `release.yml` and can publish `ink-agent@0.6.3`
   publicly to npm with OIDC provenance.
3. Verify the run, exact registry version, `latest`, and source identity.
   Check the registry archive against `dist.integrity` and compare its full
   file bodies/modes to the reviewed manifest. CI repacks, so compressed
   bytes need not equal the local archive. Cryptographically verify
   provenance for the peeled commit, tag, workflow and run. Never rerun an
   accepted or uncertain publication just because registry verification is
   pending. Investigate without changing gates or switching publishers.
4. Stop and wait for separate approval to create the GitHub Release against
   the existing verified tag and with the exact approved CHANGELOG notes.
   Record actual publication evidence. Stop again for separate approval of
   any independently reviewed evidence-only push. Approvals do not carry
   forward between operations. Do not move tags or update global Ink.
