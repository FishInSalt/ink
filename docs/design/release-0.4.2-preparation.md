# Ink 0.4.2 local release preparation

Date: 2026-10-17
Status: local candidate verified; independent design and final reviews approved.
Branch: `release/0.4.2`
Worktree: `/Users/z/Z/Agent_demo/ink-release-0.4.2`
Base: `056ab28` (local `main`).

## 1. Scope and authorization

Prepare a local patch-release candidate for `ink-agent@0.4.2`. The owner
approved local release preparation, not publication. Keep `main`, the
existing fix worktree, global installation, credentials, and account
configuration unchanged. Do not create a version tag, push, dispatch a
workflow, publish npm or a GitHub Release, or call a paid model API.

Dependencies are copied into an independently owned `node_modules` in this
worktree. Builds, test caches, and artifacts must not write into the main
checkout or the other fix worktree. Local smoke tests may use designated
scratch directories and read the existing npm cache without modifying it.

The release process remains `RELEASING.md`; this document does not replace
its external-action approval boundaries or change any workflow or guard.

## 2. Release contents and evidence

Use patch version `0.4.2`: both changes repair existing behavior, with no new
public API, dependency, supported runtime, or session schema.

- Session-cumulative cache hit rate: `73f38e3`, merged in `f9d001c`.
  Compute footer CH from recorded whole-session token totals rather than
  the last cache-reporting response. The existing aggregate scope and
  missing-counter interpretation remain unchanged.
- Codex tool arguments: `50489af`, merged in `056ab28`. Reconcile initial,
  incremental, and completion-event argument sources without mixing calls;
  reject malformed, unfinished, or conflicting completed tool batches
  before execution. Explicit `{}` still reaches tool-schema validation.
  Preserve cancellation and truncation protection.

Both changes have independent design and implementation approvals. The
owner's live session `8d2e7b81` used `openai-codex/gpt-6.1-sol` and contained
four tool calls in one response. All four had complete arguments and
succeeded on their first attempt, with no retries. Do not copy private
conversation contents into release notes. The original incident's raw SSE
was not recorded, so do not claim its exact upstream event was reproduced.

Read-only preflight on 2026-10-17 found remote `main` at `d6b8bf4`, npm latest
`0.4.1` at that commit, and a published GitHub Release `v0.4.1`. Registry
metadata advertises provenance for `0.4.1`; no independent verification of
that attestation's contents is claimed. Version `0.4.2` returned HTTP 404.
Availability must be checked again before any future publication.

## 3. Planned edits

- `package.json`: select `0.4.2`; retain name, executable and dependencies.
- `package-lock.json`: update only its top-level and root-package versions;
  no dependency regeneration or package installation.
- `src/format.ts`: update `VERSION` only, with no runtime behavior change.
- `test/package-metadata.test.ts`: update the deliberately pinned release
  expectation to `0.4.2`; retain exact-output and identity assertions.
- `CHANGELOG.md`: retain an empty Unreleased section and add a dated
  `0.4.2` Fixed section for both fixes. A candidate section is not evidence
  of publication; record its local-only state in `RELEASING.md`.
- `RELEASING.md`: select `0.4.2`, identify it as prepared/unpublished, update
  the exact smoke-test version, and record only the observed `0.4.1`
  registry/GitHub release facts. Correct the stale statement that docs are
  excluded from the artifact: top-level English/zh-CN docs are shipped;
  design documents are excluded.
- This record: add independent reviews and final local gate results after
  they are observed.

English behavior docs already describe both fixes. The zh-CN mirror lacks
those additions; translation synchronization is optional and deferred from
this narrowly scoped release preparation. No new Chinese file content is
introduced under the workspace's English-file-content rule. Do not weaken
structural docs checks or claim prose translation parity.

No changes to workflow permissions, publication gates, dependencies,
authentication, session accounting, or provider behavior are included.

## 4. Validation and review

1. Obtain independent adversarial approval of this plan before the edits
   in section 3.
2. Run typecheck, lint (including docs parity checks), build, and the full
   offline test suite. Existing merged main baseline: 147 files and 3436
   tests; report the actual candidate result, not an assumed count.
3. Run release identity and the npm minimum-version guard. Verify all five
   pinned identity values (package, two lock values, runtime, test) agree.
4. Run the existing artifact smoke with the read-only npm cache source.
   It packs into scratch, validates tar paths/modes, installs offline with
   isolated HOME/cache/prefix and a network blocker, and checks exact
   `Ink 0.4.2` help/version and local npm-exec behavior. Stop on a cache
   miss; do not add network fallback or run install scripts.
5. Run diff checks and inspect the final file list. No secrets, private
   transcripts, build output, or dependency files may enter the commit.
6. Obtain independent final review of the complete release diff and
   artifact results. Resolve findings before committing the local branch.
7. Leave the candidate committed on `release/0.4.2`, with the worktree
   clean, and report the commit, artifact and remaining external gates.
   Do not merge to main as part of this request.

Local Node 25.5.0 results do not replace CI on Node 22.19.0 and 24. After
separate approval to push, wait for both CI matrix entries before deciding
whether to authorize a tag push. Main pushes also deploy changed docs to
Pages. With the inspected publication gates enabled, a matching tag push
can publish npm automatically; this is a separately approved operation.
Any eventual merge to main must use `--no-ff`.

## 5. Review and verification record

Independent adversarial design review: APPROVE. The reviewer confirmed
patch-version selection, all five pinned identity values, truthful local-only
release status, offline artifact isolation, and the deferred CI/external-action
boundaries. No required design changes.

Local candidate validation on 2026-10-17:

- `npm run typecheck`, `npm run lint`, and `npm run build` passed. Lint
  checked 271 files; docs links, structure, and anchors passed.
- `npm test`: 147 files and 3436 tests passed. Output retained at
  `/tmp/ink-release-0.4.2-candidate-test.log`.
- Release identity passed for `ink-agent@0.4.2`; npm 11.8.0 satisfies the
  trusted-publishing minimum. All five pinned version values agree.
- A structural comparison against the base confirmed package/lock changes
  are release-version-only; the dependency graph is unchanged.
- Artifact smoke passed for 386 allowed files, including tar paths/modes,
  offline isolated install, exact help/version, and local npm-exec inference.
  Artifact: `$TMPDIR/ink-package-smoke-1nXnqS/artifacts/ink-agent-0.4.2.tgz`.
  SHA-512 (base64):
  `j8odWjgn/TTNoKvd4r+WYcwGtmu3cJqEIYFiNIElsbK2KzQTI0GO8R1oHI3xxvGlYxnWJy5qDUjbBPy9xu12QQ==`.
- `git diff --check` passed for the tracked release edits. The new record
  will also be checked after staging. Main remains at `056ab28`.

Independent final release-diff/artifact review: APPROVE, no required
changes. The reviewer independently checked all five version values,
package/lock version-only differences, truthful release records, and the
artifact. All 386 unique regular files matched their workspace counterparts
byte-for-byte; tar paths, modes, exclusions, version and SHA-512 matched.
The retained full-suite log confirmed 147 files and 3436 tests passed.

The only source-code change in this preparation is the VERSION constant;
its exact-output and identity tests passed and the independent review
covered it. No additional feature-code review is required for this batch.
No external release operation or main merge has been executed. Supported
Node CI, registry recheck and each external-action approval remain pending.
