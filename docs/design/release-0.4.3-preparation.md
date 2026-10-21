# Ink 0.4.3 local release preparation

Date: 2026-10-21
Status: local candidate verified; independent final release-diff review approved.
Branch: `release/0.4.3`
Base: `bbbb265` (`origin/main`, the Codex stream-interruption fix).

## 1. Scope and authorization

Prepare a local patch-release candidate for `ink-agent@0.4.3`. The owner
approved local release preparation only. Do not merge to `main`, create or
push a version tag, push the release branch, dispatch a workflow, publish to
npm or a GitHub Release, or change the global installation without separate
approval for each external action.

The release process remains `RELEASING.md`; this document does not replace
its external-action approval boundaries or change any workflow or guard.

## 2. Release contents and evidence

Use patch version `0.4.3` because `v0.4.2` is already tagged locally and on
the remote, npm `latest` selects `0.4.2` with `gitHead` `76d65cd`, and the
non-prerelease GitHub Release `v0.4.2` is published. Version `0.4.3` is
absent from the registry at preparation time. The candidate contains one
user-visible fix, already merged to `origin/main` as `bbbb265` (the
cherry-pick of `6417c41`):

- **Codex stream interruption diagnostics.** A mid-stream socket close from
  the ChatGPT-plan backend now reports `Codex stream interrupted — ...`
  instead of a bare `terminated`. The message includes the provider and the
  normalized transport detail, and suggests sending "继续" to resume.
- **Completed-response recovery.** A transport error after
  `response.completed` or `response.incomplete` no longer discards the
  completed response. `response.failed`, `error`, and protocol errors still
  fail the run.
- **Tests.** `test/provider-shared.test.ts` covers transport-error
  classification; `test/codex-responses.test.ts` covers interruption before
  the first event, mid-stream interruption, post-completion interruption, and
  terminal failures that must still throw.
- **Documentation.** `docs/providers.md` and `docs/zh-CN/providers.md` already
  describe the interruption behavior and resumability in the fix commit.

The `v0.4.2..bbbb265` range also contains the already-merged documentation
discovery/Search Console work (`ff614ca`, merged in `c2d6aac`): the Pages
workflow path trigger, README/docs-index links to the Chinese technical blog,
sitemap and structured data, Google Search Console verification, and
`test/docs-site.test.ts`. This preparation adds no additional provider
behavior beyond `bbbb265`, no automatic retry, UI rewind, dependency change,
workflow permission change, session-schema change, or supported-runtime
change. The docs-site changes are release-noted separately; the deferred
"continue manually" behavior remains the recovery path.

## 3. Planned edits

- `package.json`: select `0.4.3`; retain name, executable, dependencies and
  engines.
- `package-lock.json`: update only the top-level `version` and
  `packages[""].version`; do not regenerate the dependency graph or run an
  install.
- `src/format.ts`: update `VERSION` only; no runtime behavior change.
- `test/package-metadata.test.ts`: update the deliberately pinned release
  expectation to `0.4.3`; retain the exact-output and identity assertions.
- `CHANGELOG.md`: keep an empty `## [Unreleased]` section and add
  `## [0.4.3] - 2026-10-21` as a candidate date. Include the
  stream-interruption Fixed entry and a Documentation entry for the docs-site
  discovery/Search Console work. Update the date at publication if it moves.
  A candidate section is not evidence of publication.
- `RELEASING.md`: select `0.4.3` in the current-version contract; add a
  truthful prepared/unpublished `0.4.3` paragraph; update the exact
  artifact-smoke version to `Ink 0.4.3`; and correct the stale `0.4.2`
  publication state with a dated record of the observed npm/GitHub facts.
  Replace the stale `0.4.2` remaining-actions list with the current `0.4.3`
  gates rather than presenting completed actions as pending.
- `docs/design/release-0.4.2-preparation.md`: add a dated publication note
  recording that `v0.4.2` was subsequently tagged and published; keep the
  original pre-publication record verbatim as history.
- `docs/design/source-map-js-security-update.md`: add the same dated
  post-publication note and make its pre-publication wording past tense.
- This record: add the independent review outcome and observed local gate
  results after they are available.

No changes to `dist/` are planned; it is generated and ignored. The already
merged provider documentation needs no further release-only edit.

## 4. Validation and review

1. Obtain independent adversarial approval of this plan before making the
   edits in section 3.
2. Run `npm run typecheck`, `npm run lint`, `npm run build`, then `npm test`.
   Build must precede test because `test/package-metadata.test.ts` copies the
   built CLI and compares its exact version output. Lint must include the
   documentation structure/parity checks.
3. Run the release identity guard and verify all five pinned values agree:
   the guard checks `package.json`, both lockfile version fields, and
   `src/format.ts`; the package-metadata test checks the fifth pinned value.
   Also run `node scripts/release-guards.mjs npm-version "$(npm --version)"`.
4. Run the existing artifact smoke unconditionally with
   `node scripts/package-smoke.mjs --cache-source /home/li416/.npm`; do not
   add a network fallback. The isolated cache is empty otherwise, so a bare
   run is expected to fail offline. It must accept `Ink 0.4.3` and the local
   npm-exec inference.
5. Run `git diff --check`, inspect the final file list, and confirm that no
   dependency, build output, credential, or unrelated file entered the
   candidate.
6. Obtain independent final review of the complete release diff and gate
   results. Resolve findings before committing the local branch.
7. Leave the candidate committed on `release/0.4.3` with a clean worktree.
   Do not merge to `main` as part of this request.

The base `bbbb265` already passed GitHub CI run `39543990652` on Node 22.19.0
and 24 and Pages run `39543990645`. Those results validate the merged fix,
not this release-metadata diff; fresh CI is required after any separately
approved push. Local Node results do not replace supported-Node CI.

## 5. External gates

Each of the following requires separate explicit approval: pushing the
release branch, merging it to `main` with `--no-ff`, pushing `v0.4.3`, any
npm publication or GitHub Release, and any global installation. Registry
availability and publication state must be rechecked immediately before a
publication request; a previous result does not reserve the version.

## 6. Review and verification record

Independent adversarial design review: CHANGES on the first draft, then
APPROVE after revision. Blocking findings were the stale `0.4.2`
publication-state claims and the build/test ordering; P1 findings covered the
identity-guard scope, the missing npm-version gate, and the release-range
description; P2 findings covered the unconditional artifact cache, the
candidate CHANGELOG date, and the historical `0.4.2` preparation record. The
plan above was revised to address them.

Local candidate validation on 2026-10-21:

- `npm run build`, `npm run typecheck`, `npm run lint`, and `npm test` passed.
  Lint checked 272 files and docs links/parity/anchors; the suite reported 148
  files, 3445 tests passed and 1 skipped.
- Release identity passed for `ink-agent@0.4.3`; npm 11.8.0 satisfies the
  `>=11.5.1` gate. The default local npm is 10.9.9, below the minimum, so the
  npm-version guard and artifact smoke used npm 11.8.0 from the local npx
  cache. Publication must run with supported npm/CI, not this local default.
- Artifact smoke passed for 386 allowed files, including isolated install,
  exact `Ink 0.4.3` output, and local npm-exec inference. Artifact:
  `/tmp/ink-package-smoke-1FOH6D/artifacts/ink-agent-0.4.3.tgz`; SHA-512
  (base64):
  `l7s6zjnHzwPfGuc98zo/ABToWyv364+eNpH2Yz40y4PpgbOIctTL4q6mA+H4H+Ajtnnc4oGb8+Yzaq3L8MC4CA==`.
- `git diff --check` passed; no `dist/` content is tracked in the candidate.

Independent final release-diff/artifact review: APPROVE on the staged
nine-file candidate. The reviewer independently verified the five version
pins, the version-only lockfile diff, the unchanged 0.4.2 CHANGELOG section,
the npm/GitHub/tag publication facts, the artifact SHA-512 and 386-file
count, and the absence of dist/dependency/credential/unrelated files. The
reviewer's first pass requested restoring the original 0.4.2 preparation
sentences verbatim and a dated note in the security record; both were
addressed before this approval.
