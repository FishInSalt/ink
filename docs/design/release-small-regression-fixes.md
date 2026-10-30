# Three small release regression fixes

Status: fixes and cleanup implemented; independent reviews passed.
Original design/code reviews: `e28d4031` / `fd9f7105`.
Cleanup design/code reviews: `bfa53fc0` / `2cd63515`.
Cleanup branch: `cleanup/release-regression-fixes-minimal`.
Base: `d812de5` (original main snapshot), reviewed against release `v0.4.4`.

## Scope

Fix only large edits reporting false failure, login persistence ignoring
cancellation, and search preflight rejecting `symlink/..` paths. No dependency,
public API, transport, generic hook, legacy credential or fd capability changes.

## Decisions

1. **Edit diff:** replace the large spread call with individual pushes.
   Preserve diff content, headers, the LCS guard and compact success receipt;
   no catch-all success fallback.
2. **Login:** pass the existing signal to `locked.write({ signal })` in
   `persistLogin`. Cancellation before rename submission preserves the prior
   credentials; it cannot undo an already-submitted rename. Earlier host or
   registration writes may remain. Refresh and logout persistence are unchanged.
3. **Search:** normalize Unicode spaces and one leading `@` once; expand `~`
   by substitution and prefix cwd without collapsing components. Preserve
   relative/absolute output shape, `symlink/..`, invalid intermediate entries
   and trailing separators. Keep find's existing realpath-based Git check;
   do not change shared helpers or read/edit/write path policy.

Decision 3 supersedes only lexical `resolvedPath` construction and shared-helper
tilde expansion in `search-tools-alignment-design.md` D3/D5 and §5.1; all other
search contracts remain unchanged.

## Regression tests

- Pure diff and real-tool tests cover 150,000-line insertions and deletions;
  retain one deletion case at loop level to verify the model's success receipt.
- Local OIDC tests cover cancellation during final temporary-file creation for
  first login and reauthorization, preserving prior state/API keys, cleaning
  temporary files and releasing the lock; refresh/logout tests remain unchanged.
- Separate real rg/fd tests cover path forms, symlink/.. in cwd, conflicting
  lexical targets, invalid intermediate entries, trailing separators and files.
  Keep the existing search test file's CI-pinned collection count unchanged.

## Documentation and verification

Keep CHANGELOG, matching bilingual user docs and the search-design amendment.
Cleanup changes no production code: remove the redundant loop direction,
move the session receipt explanation beside history metadata and shorten it
to one sentence per language, and compress this record.

Integration with main `be0adf1` passed independent review `29f39c3a`.
On macOS arm64 / Node 25.5.0, 4,073 tests passed across 157 files; typecheck,
lint, build, diff/identity checks and offline package smoke (427 allowed files)
passed. Tests used isolated HOME and the network blocker; no real auth/model
calls, publication or version bump.
