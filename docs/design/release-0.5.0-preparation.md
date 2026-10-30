# Ink 0.5.0 local release preparation

Date: 2026-10-30
Status: local candidate validated and independently approved; unpublished.
Independent adversarial plan review `16eb303e`: PASS before implementation.
Branch: `release/0.5.0`
Base: `cd0535d` (clean local main); previous release `v0.4.4` / `e6d9194`.

## Scope and authorization

The owner confirmed the proposed `0.5.0` local preparation and validation
steps, including an independently reviewed local commit and `--no-ff` merge
to main. No push, local release tag, workflow dispatch, npm/GitHub publication,
account configuration, global installation, dependency install or live model
authorization/inference is approved. Existing `RELEASING.md` external gates
remain in force. Use 0.5.0 because the changed ChatGPT login and tool behavior
require explicit upgrade guidance.

Read-only checks on 2026-10-30: npm latest is 0.4.4, the 0.5.0 metadata URL
returns HTTP 404, and origin has no v0.5.0 tag. These observations neither
reserve the version nor replace checks immediately before publication.

## Planned edits (seven files only)

- `package.json`, `package-lock.json`: set the package and both lockfile
  version fields to 0.5.0; retain the dependency graph, package identity,
  sole executable, scripts and Node minimum. Do not regenerate the lockfile.
- `src/format.ts`: change only VERSION; update the deliberate version pin
  in `test/package-metadata.test.ts` without weakening any assertions.
- `CHANGELOG.md`: retain an empty Unreleased heading and move the candidate
  notes to `## [0.5.0] - 2026-10-30`. This is a provisional candidate date,
  not a publication claim; correct it if publication moves. Preserve all
  0.4.4-and-older entries byte-for-byte. Highlight the required `ink login`
  for old device-code users. Complete the notes for grep/find hidden/VCS,
  config/path/glob/limit behavior and fd capabilities, the prepareArguments
  extension hook, subscription catalog isolation, url_read diagnostics/text
  support, task timeout guidance and documentation discovery improvements.
- `RELEASING.md`: select 0.5.0 as prepared/unpublished, link this record and
  update the smoke-output version. Keep the published-history heading through
  0.4.4 and its historical records unchanged. Clarify the dated-candidate
  convention, without implying publication or changing external gates.
- This record: retain scope, review results, residual risks and verification.

Existing published feature docs already describe the merged behavior; no new
feature, schema, workflow, runtime or build-output edit belongs in this batch.
The checkout-only `.ink/settings.json` change is not an npm default-policy
change. Do not claim read EOF tail recovery (reverted) or guaranteed cache hits.

## Residual review findings

The user selected only the three small regression fixes, now merged. This
preparation does not fix or declare resolved the remaining extension-hook
rejection/getter containment, omitted terminal-output native replay boundary,
legacy flat-token logout cleanup, or relative-PATH fd capability identity.
These conditional/low-priority findings remain recorded for an explicit
publication decision; preparing the candidate is not blanket risk acceptance.

## Verification and completion

After independent plan approval, run typecheck, lint, build, then full tests
with isolated HOME and the repository network blocker. Build precedes the CLI
version tests. Run release identity and npm >=11.5.1 guards, targeted package
regressions, docs-site checks and offline package smoke with the existing
read-only `/tmp/ink-npm-cache`; no network dependency fallback. Verify installed
help, exact Ink 0.5.0 output, npm-exec inference and tar contents. Compare the
lockfile and historical CHANGELOG sections against the base and inspect the
complete diff. Record artifact path/integrity and actual test counts.

Available runtime is macOS arm64 / Node 25.5.0, npm 11.8.0; do not substitute
it for Linux Node 22.19.0/24 CI. After final independent release-diff/artifact
review, commit and merge locally with --no-ff only if main has not advanced
unverified. Leave the worktree clean. Any push and resulting CI require new
approval; supported-Node CI and a separate publication approval gate the tag.

## Local results

- Final release-diff/artifact review `c7685bf5`: APPROVE for local preparation.
- Full suite: 157 files / 4,073 tests passed; targeted package tests: 3 files /
  211 tests passed. Typecheck, lint (296 files), build and diff checks passed.
- Docs site: 24 pages built. Identity and npm 11.8.0 minimum-version guards passed.
- All five version pins agree; only the two lockfile versions changed, and
  historical CHANGELOG entries from 0.4.4 onward are byte-identical to the base.
- Offline smoke: 427 allowed files; isolated install, Ink 0.5.0/help and local
  npm-exec passed. Artifact size: 815,136 bytes.
- Artifact: `/private/tmp/ink-release-0.5.0.dvdHUi/tmp/ink-package-smoke-yjqP55/artifacts/ink-agent-0.5.0.tgz`.
  Integrity: `sha512-7XcCKzO1btbToHgXW5Tt6VurO/vBewZxUIO1l+2dbG3Z8hAsbXwIUbjsRqd3VXahgmx5pr4G3MX/WVWszC95Fg==`.
- Logs: `/tmp/ink-release-0.5.0.dvdHUi/`. Linux Node 22.19.0/24 CI remains pending;
  no external release action or live model request has been performed.
