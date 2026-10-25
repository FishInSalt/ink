# Ink 0.4.4 local release preparation

Date: 2026-10-26
Status: prepared; publication pending.
Branch: `release/0.4.4`
Base: `23f6d79` (the compaction surrogate-pair fix, on top of `origin/main`
`9636090`).

## 1. Scope and authorization

Prepare `ink-agent@0.4.4`, a patch release for the surrogate-pair bug in the
summarization prompt serialization used by `/compact` and branch summaries.
The owner's request on 2026-10-26 was: “ok，请提交，合并，推送，然后发布版本”.
That request approves the release commit, the `--no-ff` merge to `main`, the
`main` push, the annotated `v0.4.4` tag push, npm publication through the
existing tag-triggered OIDC workflow, and the GitHub Release page for this
version. It does not approve a second post-publication push: the publication
record is prepared locally on a dedicated branch and is pushed only after
separate owner approval. Global installation, workflow/permission changes,
dependency changes, and historical-tag changes are not part of this release.

Pre-publication checks on 2026-10-26 01:13 +0800, to be repeated immediately
before the tag push:

- npm `latest` selects `0.4.3`; `npm view ink-agent@0.4.4 version` returns
  `E404`.
- `v0.4.4` is absent from `git ls-remote --tags origin`; the newest tag is
  `v0.4.3`.
- repository variables `INK_NPM_PUBLISH_ENABLED=true` and
  `INK_NPM_PACKAGE=ink-agent` are set.
- the release workflow is unchanged and publishes only from a tag push whose
  commit is on `origin/main` ancestry, with OIDC and `--provenance`.

## 2. Release contents and evidence

Commit `23f6d79` fixes the `/compact` request that DeepSeek rejected with
HTTP 400 `unexpected end of hex escape`:

- **Root cause.** `truncate()` in `src/core/compaction.ts` cut the summary
  transcript with `String#slice(0, max)`. A 4242-character `web_search`
  result whose 800th UTF-16 code unit was the high half of `📣` left a lone
  surrogate `U+D83D`. `JSON.stringify` escaped it as `\ud83d`; the strict
  `serde_json` gateway read the following `\n` where it required `\u` and
  rejected the request at byte 40280.
- **Fix.** The cut backs off one code unit when it lands on a high
  surrogate, and the final prompt passes through `wellFormed()` so unpaired
  surrogates from stored summaries, branch custom instructions, tool output,
  or pasted text become `U+FFFD`. This covers both `compactHistory` and
  `summarizeBranchSegment`.
- **Tests.** Three cases in `test/compaction.test.ts`: no split at the
  800-unit boundary (with an exact truncation count and no replacement
  character), lone high and low surrogates replaced, and a valid astral
  character preserved. The full local suite passed 148 files and 3449 tests.
- **Dated operator observations (2026-10-26, not CI evidence).**
  Reconstruction of the failing session after the fix produced a transcript
  with zero unpaired surrogates; the live resumed session compacted
  successfully, and the following turn completed with a measured
  38,387-token context.

No provider behavior beyond this fix, no automatic retry, no dependency
change, no workflow permission change, no session-schema change, and no
supported-runtime change are included.

## 3. Planned edits

- `package.json`: select `0.4.4`; retain name, executable, dependencies, and
  engines.
- `package-lock.json`: update only the top-level `version` and
  `packages[""].version`; do not regenerate the dependency graph or install.
- `src/format.ts`: update `VERSION` only.
- `test/package-metadata.test.ts`: update the deliberately pinned release
  expectation to `0.4.4`; retain the exact-output and identity assertions.
- `CHANGELOG.md`: keep an empty `## [Unreleased]` section and add
  `## [0.4.4] - 2026-10-26` as a candidate date (update it if publication
  moves) with the Fixed entry. The date follows the local +0800 release date
  used by prior entries.
- `RELEASING.md` before publication: select `0.4.4` in the current-version
  contract; change “This release is published” to “This version is prepared;
  publication is pending”; keep the heading “OIDC publication is live
  (through `0.4.3`)” because `0.4.3` remains the latest published version;
  add a truthful prepared/unpublished `0.4.4` paragraph; update the exact
  artifact-smoke version to `Ink 0.4.4`.
- `RELEASING.md` after publication: prepare, on a dedicated
  `release/0.4.4-record` branch and without pushing it in this request,
  the restored “This release is published” wording, the heading “through
  `0.4.4`”, and the dated publication record (merge commit, tag, workflow
  run, registry `gitHead`/integrity, GitHub Release URL).
- This record: add the plan-review outcome, local gate results, and the
  publication record after they are available.

No `dist/` content is tracked; it remains generated and ignored.

## 4. Validation and review

1. Independent adversarial approval of this plan is complete; findings and
   resolutions are recorded in section 6. No version or release-metadata edit
   was made before that review closed.
2. Run `npm run typecheck`, `npm run lint`, `npm run build`, then `npm test`.
   Build must precede test because `test/package-metadata.test.ts` copies the
   built CLI and compares its exact version output.
3. Run the targeted regressions after the fresh build:
   `node node_modules/vitest/vitest.mjs run test/package-metadata.test.ts
   test/package-tar.test.ts test/release-guards.test.ts`.
4. Run `node scripts/release-guards.mjs identity`. It checks four pinned
   values: `package.json`, both lockfile version fields, and
   `src/format.ts`. `test/package-metadata.test.ts` checks the fifth pinned
   value, the exact `0.4.4` expectation.
5. Run `node scripts/release-guards.mjs npm-version "$(npm --version)"`.
   Local npm is 11.8.0, above the required 11.5.1.
6. Run `node scripts/package-smoke.mjs --cache-source "$HOME/.npm"` with no
   network fallback.
7. Run `git diff --check`, inspect the final file list, and confirm that no
   dependency, build output, credential, or unrelated file entered the
   candidate.
8. Obtain independent final review of the complete release diff and gate
   results. Resolve findings before committing the candidate.
9. Commit the candidate on `release/0.4.4`, merge to `main` with `--no-ff`,
   and push `main`. Wait for the `ci` workflow on the merge commit to finish
   green on both Node `22.19.0` and Node `24`; local results do not replace
   that CI. Only then create and push the annotated tag.

## 5. Publication sequence and external gates

The owner approved the actions listed in section 1. The sequence is:

1. Re-run the section 1 pre-publication checks immediately before tagging.
2. Create annotated tag `v0.4.4` on the merge commit on `main`, with message
   `Ink 0.4.4 — compaction prompt survives split surrogate pairs`, and push
   it. The tag push is the only publication trigger; the workflow publishes
   through OIDC trusted publishing with provenance.
3. Monitor the `release` workflow. A green gate, publish, and registry
   visibility check are required. If the publish succeeded but a later step
   failed, verify the registry artifact and provenance manually; do not
   re-run the tag workflow, because republishing an existing version fails.
4. Verify `npm view ink-agent@0.4.4 version dist.tarball gitHead`, the
   provenance attestation, and the exact `0.4.3`-style integrity match
   against the publish output.
5. Create the non-prerelease GitHub Release `v0.4.4` from the dated
   CHANGELOG section, matching the `v0.4.3` release-page shape.
6. Prepare the post-publication record on a dedicated
   `release/0.4.4-record` branch and leave it local. Pushing that record is
   a separate external action: request owner approval, then merge it to
   `main` with `--no-ff` and push. The release itself is complete without
   that push; the remote `RELEASING.md` remains in its committed
   pre-publication state (accurate until the tag push) until the record is
   approved.

Reusing the `0.4.4` version or tag is prohibited; any defect found after
publication ships as a new patch release. Global installation remains a
separate operator action.

## 6. Review and verification record

Independent adversarial plan review: CHANGES on the first draft. Blocking
findings were the missing post-merge CI gate before the tag push and the
unrecorded approval/GitHub Release boundary. Major findings were the
misstated identity-guard scope, the missed `RELEASING.md` current-state
lines, the missing post-publication verification/record, and pre-publication
checks that were point-in-time only. All findings were addressed in this
revision: CI now gates the tag, the owner request and GitHub Release are
explicitly recorded, the guard scope is split into four checked values plus
the test's fifth pin, both pre- and post-publication `RELEASING.md` edits are
planned, the checks are repeated before tagging, and the publication sequence
now includes registry/provenance/GitHub Release verification and a record
commit.

Re-review after the first revision: CHANGES on one remaining blocking point —
the post-publication record commit/push was not in the approved action list
and bypassed the dedicated-branch plus `--no-ff` process. Resolved by
removing that push from this request: the record is prepared on
`release/0.4.4-record` and requires separate approval before it reaches
`main`. Follow-up review: APPROVE.

Local candidate validation on 2026-10-26:

- `npm run typecheck` passed; `npm run lint` checked 272 files, 10 docs ×2
  languages, 9 topic routes, links/parity/anchors OK, and the `imp` gate
  reported 45 matches in 17 survivor files.
- `npm run build` passed before `npm test`; the suite reported 148 files and
  3449 tests passed.
- Targeted regressions passed: `package-metadata.test.ts` (10),
  `package-tar.test.ts` (146), `release-guards.test.ts` (55), 211 tests total.
- Release identity passed for `ink-agent@0.4.4`; npm 11.8.0 satisfies the
  `>=11.5.1` gate.
- Artifact smoke passed for 386 allowed files, including isolated install,
  exact `Ink 0.4.4` output, and local npm-exec inference. Artifact:
  `/private/var/folders/y5/4pt277ys42g1kz84rh0g922c0000gn/T/ink-package-smoke-PWxEYj/artifacts/ink-agent-0.4.4.tgz`;
  SHA-512 (base64):
  `utCgxQgqElBNWlZXcVf+/wrSfF0+HfVPIHsOVFseMy+TjXhzkLfO3CrCNQnOrU58k46p3O898x1QMLIrM+wYCg==`.
- `git diff --check` passed; no `dist/` content is tracked in the candidate.

Independent final release-diff review: APPROVE on the working tree. The
reviewer re-ran the gates and reproduced the artifact SHA-512. One minor
wording finding — the post-publication window was described as a truthful
`RELEASING.md` state even though its “no `v0.4.4` tag” sentence stops being
true at the tag push — was fixed before commit by describing it as the
committed pre-publication state, accurate until the tag push.

## 7. Publication record

Pending.
