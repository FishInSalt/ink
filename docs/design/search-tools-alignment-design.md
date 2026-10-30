# Search tool alignment: grep and find

Status: design approved (including the D1 delta); implementation complete on `fix/search-tools-alignment`. Full tests, typecheck, lint, and docs-site build pass; independent code review approved.

Amendment: `release-small-regression-fixes.md` supersedes only the lexical
`resolvedPath` construction and shared-helper tilde expansion in D3/D5 and
§5.1, preserving filesystem traversal through `symlink/..` and trailing
separators for both preflight and the child process.

Worktree: `/Users/z/Z/Agent_demo/ink/.worktrees/ink-search-tools`

Branch: `design/search-tools-alignment`

Inspected base: `815a7cb` (`main`, merge of the strict read-EOF restoration)

Decision date: 2026-10-28

## 0. Review resolution

The first review returned "approve with changes"; the second review also returned "approve with changes"; a third narrow review returned "approve with changes" on two remaining ordering/test issues. This revision addresses:

- the preflight path mismatch caused by double normalization;
- the missing presentation integration for the result-limit notice;
- the stale `findPresentation` fallback and its incorrect visible-display rationale;
- the missing fd capability gate for both `--max-results` and `--no-require-git`;
- the capability probe's process/cancellation contract;
- the missing user-docs deliverable and docs-gate/site registration;
- path-glob handling for leading `./` and `/`, nested widening, and the search-root component case;
- the test that did not actually prove `--max-results` was used;
- the need to reconcile this design with the approved `tool-output-integrity-design.md`;
- the non-blocking items on singular copy, Unicode fixtures, `.git` probe isolation, Git-ancestor errors, symlink behavior, Windows, special files, abort ordering, control characters, and docs-gate claims;
- the third review's execution-order requirement and old-fd test gating;
- the docs-gate header/order, self-docs literal, description-assertion, and singular-notice documentation details.

The user later changed D1 after reviewing Claude Code 2.1.88: `grep --hidden` now excludes VCS metadata directories, so this revision replaces the earlier exact-pi decision. The delta was independently reviewed and approved; the rest of the design remains as reviewed.

## 1. Scope

Align `grep` and `find` path handling and search flags with the behavior we want from `read`-style path resolution and from pi/Claude Code, while keeping `read` unchanged.

In scope:

- Normalize and validate the `path` argument for `grep` and `find` before spawning `rg` or `fd`.
- `grep`: add `--no-config`, `--hidden`, `--with-filename`, and the six VCS `--glob !dir` exclusions from D1.
- `find`: change the default result limit to 1000, add `--max-results`, support path-containing globs, and add `--no-require-git` outside Git repositories when fd supports it.
- Add a result-limit notice to the shared `runSearch` output for `find`, and integrate it with the existing presentation layer.
- Add a bounded, abort-aware fd capability probe before find starts its search.
- Update tool descriptions, user docs, docs gates/site registration, and tests.

Explicit non-goals:

- No changes to `src/core/tools/read.ts`, its strict EOF error, logical-line counting, positive-integer validation, or P9 path quoting. The current read behavior is intentional.
- No change to `find`'s VCS-directory behavior. This batch adds VCS exclusions only to `grep`; `find` still uses its existing hidden-file behavior and Git-ancestor handling.
- No non-Git `.gitignore` handling for `grep`. ripgrep does not have fd's `--no-require-git`; this is a shared limitation with pi and needs separate ignore-file handling.
- No changes to grep's output-line limit semantics, context handling, timeout, 1 MiB collection guard, stderr retention, or cancellation/timeout wording.
- No changes to find's path output style, hidden-file behavior (already enabled), type filter, timeout, or collection guard.
- No new `hidden` parameter. `grep` always searches hidden files after this change.
- No Windows-specific path-glob handling. Windows is not supported (README); path globs are tested on macOS/Linux.
- No `--print0` / NUL-delimited find output. The result-limit notice remains line-count based; the limitation is documented.
- No cross-tool suggestions in errors, and no read-behavior changes.

## 2. Confirmed findings at the base

These were checked against the current source and local binaries.

| Source | Observed behavior | Consequence |
| --- | --- | --- |
| `src/core/tools/grep.ts`, `find.ts` | `path` is passed to `rg`/`fd` without `normalizePath` or `resolveToCwd`. `grep` with `~/.ink/settings.json` fails with an rg "No such file or directory" error; `find` with `~/.ink` fails with fd "Search path ... is not a directory". | `read` supports `~`, `@`, and Unicode-space path variants; the search tools do not. |
| `src/core/tools/grep.ts` | A single-file search emits `2:match line` because `rg` omits the filename by default. | Output violates the documented `path:line:text` contract. |
| `src/core/tools/grep.ts` | No `--no-config`. A test with `RIPGREP_CONFIG_PATH` set to a config containing `--fixed-strings` changed regex behavior. | Search results depend on ambient user configuration. |
| `src/core/tools/grep.ts` | No `--hidden`; hidden files and directories are skipped. | `.github`, `.ink`, and other hidden code/config paths are silently omitted. |
| `pi` grep argv | `--no-config --json --line-number --color=never --hidden`, with no `.git` exclusion. In the ink repository, `rg --hidden --files` lists 4,202 files under `.git`. | This was the initial policy, but the user changed it after reviewing Claude Code. |
| Claude Code 2.1.88 GrepTool | `--hidden`, then `--glob !.git`, `!.svn`, `!.hg`, `!.bzr`, `!.jj`, `!.sl`; also `--max-columns 500`. No `hidden` input parameter. | The selected policy: search hidden working-tree files, exclude VCS metadata directories. |
| `src/core/tools/find.ts` | `--glob` matches the basename unless `--full-path` is used; `sub/*.ts` returns no matches. | Silent false negative for path-containing globs. |
| `src/core/tools/find.ts` | No `--no-require-git`; in a non-Git directory with `.gitignore`, fd lists the ignored file. | Silent false positive; the tool description says it respects `.gitignore`. |
| `src/core/tools/find.ts` | `DEFAULT_LIMIT` is 200; no `--max-results`; fd may traverse much more than the eventual 200-line preview. | Default differs from pi's 1000 and the traversal does unnecessary work. |
| `src/core/tools/presentation.ts` | `findPresentation` has a limit fallback of `"200"`. | It is a consistency sentinel: omitted non-path optional fields are not displayed, so this fallback is not a visible default, but it should still match the execution default. |
| `src/repl/tool-presentation.ts` | `notice()` recognizes `[stderr truncated...]` and `[Truncated:...]` for grep/find only; `conciseNotice()` special-cases `[Truncated:]`. | A new `[Results limited...]` notice would stay in the collapsible body and disappear from promoted metadata. |
| `fd` release notes / proposed argv | `--no-require-git` exists only in fd 8.7.0+; `--max-results` may be absent in older fd. The proposed argv would pass both unconditionally without a capability gate. | An old fd would fail every find with an unknown-flag error, or lose the requested limit behavior. |
| `scripts/check-docs.mjs`, `scripts/build-docs-site.mjs` | `REQUIRED_DOCS` and `DOC_FILES` are fixed lists (ten pages at the base); the docs site does not publish a new page automatically. | A `docs/search.md` link would not be parity-checked, mirror-checked, or published unless both lists and their labels/metadata are updated. |

## 3. Decisions

### D1: `grep --hidden` excludes VCS metadata directories

`grep` will pass `--hidden` and then exclude the VCS metadata directories used by Claude Code 2.1.88:

```ts
const VCS_DIRECTORIES_TO_EXCLUDE = [".git", ".svn", ".hg", ".bzr", ".jj", ".sl"] as const;
for (const dir of VCS_DIRECTORIES_TO_EXCLUDE) argv.push("--glob", `!${dir}`);
```

Hidden working-tree files and directories such as `.github`, `.ink`, and `.gitignore` remain searchable. VCS internals (commit messages, reflogs, hooks, config, refs) are not searched when the tool recursively searches a parent directory. If the caller explicitly sets `path` to `.git` or to a file/directory inside it, rg's explicit target is searched; this is the escape hatch for repository internals and must be documented. This supersedes the earlier exact-pi decision at the user's request, after comparing Claude Code 2.1.88.

Known consequences:

- Hidden files that are not ignored by `.gitignore` (for example `.env`) can still appear in results; VCS exclusion is not a complete secret boundary.
- A directory literally named `.git` that is not VCS metadata is also excluded from recursive searches; this is accepted for parity with Claude Code. An explicit `path` target still searches it.
- A later policy change must update this decision, the tool description, the user docs, and the regression tests together.

### D2: `find` default limit is 1000, with `--max-results`

`DEFAULT_LIMIT` becomes 1000. `find` passes `--max-results <limit>` so fd stops after the requested number of results instead of relying only on the 1 MiB collection guard and 50 KiB preview cap. The limit is both the default and the maximum (existing clamp 1–1000); the tool description and docs say to narrow rather than raise.

The result-limit notice follows ink's existing "narrow, don't raise" guidance rather than pi's literal `Use limit=N*2` wording. The mechanism matches pi; the copy stays consistent with ink's tool description. The notice reports only a proven lower bound; it must not claim an exact total. Exact singular and plural strings are defined in section 7.4.

### D3: Path preflight is explicit, diagnostic-only, and uses one normalization

`grep` and `find` normalize the requested path exactly once, resolve that normalized string for `stat` without normalizing it a second time, and pass the same normalized string to the child process. Missing paths return a single clean error line with the absolute resolved path. No directory listing, similar-name suggestion, or raw `rg`/`fd` stderr is added. `read` keeps its existing error behavior.

### D4: The result-limit notice is separate and presentation-aware

The notice is appended after the existing `[Truncated: ...]` envelope, if any, and before any stderr diagnostic. It is not folded into the `[Truncated: ...]` reason grammar because the process completed successfully and the result set is deliberately capped, not collection-truncated.

The notice must be promoted by `src/repl/tool-presentation.ts`, not left in the collapsed body. It is classified as a truncation notice and displayed raw (already short); `conciseNotice()` does not need a shortened rewrite unless the review decides otherwise.

### D5: Output paths preserve the caller's relative/absolute shape where possible

The path passed to `rg`/`fd` is the normalized path, not the absolute resolved path:

- `"."` and relative paths remain relative, so existing relative result paths do not change.
- `~` expands to an absolute home path, so results for `~` paths are absolute (they previously failed).
- `@` prefixes are stripped and Unicode spaces are normalized.

The absolute resolved path is used only for `stat`, Git-ancestor detection, and error messages.

### D6: fd capabilities are probed before using feature flags

`find` probes `fd --help` once per fd path and caches the result. The probe detects both `--max-results` and `--no-require-git`.

- If `--max-results` is absent, find returns a clean upgrade error before spawning the search: `Error: fd is too old for find: --max-results is unavailable. Install fd 8.7.0 or later.`
- If `--max-results` is present but `--no-require-git` is absent, find works and omits `--no-require-git`. Non-Git `.gitignore` is then not respected; docs state the fd 8.7.0+ requirement.
- A probe spawn error, timeout, nonzero exit, or empty/malformed help output returns a clean capability error and is not cached; aborted probes return the existing cancellation result.
- The probe is a bounded, abort-aware child process. It is not part of `runSearch`, but it must preserve the approved zero-spawn guarantees for pre-aborted find.

Execution order for find is: binary detection → abort check → argument validation → normalize/stat preflight → abort check → capability probe → abort check → Git walk → build argv → `runSearch`. Path errors therefore win over capability errors, and a missing path never spawns `fd --help`.

### D7: Docs and the existing design document are part of the batch

This change updates the matching user-facing page and its zh-CN mirror, registers it in both docs gates and the docs site, lists it in the docs index, and adds a cross-reference in the approved `tool-output-integrity-design.md` so its "keep argv construction/ignore behavior" sentence is explicitly superseded for grep/find.

### D8: `grep` and `find` descriptions state the `.gitignore` boundary

`grep` respects `.gitignore` only inside Git repositories. `find` respects it inside Git repositories; outside Git it requires fd 8.7.0+ for `--no-require-git`. The tool descriptions and prompt snippets use that qualifier instead of an unconditional claim.

### D9: `find` result-count notice is line-count based

`--max-results` counts fd entries, but `runSearch` observes newline-delimited stdout. A filename containing an embedded newline can make the notice trigger before the true entry count. This is rare and consistent with the existing "Line limit" presentation label. `--print0` / NUL-delimited counting is out of scope and documented as a limitation.

## 4. Relationship to `tool-output-integrity-design.md`

The approved document says in §5: "Keep argv construction, defaults/clamping, ignore behavior, and process launch architecture." This design explicitly supersedes that sentence for `grep` and `find` argv construction, defaults, and ignore behavior. It adds one bounded `fd --help` capability probe before `runSearch`; it does not change `runSearch`'s launch, collection, counting, stderr, cancellation, or timeout architecture.

The find execution order is binary detection → abort check → argument validation → normalize/stat preflight → abort check → capability probe → abort check → Git walk → build argv → `runSearch`. A path error wins over a capability error; a missing path never spawns the probe. The probe is killed on abort, and the existing zero-spawn guarantees for pre-aborted find and abort-during-binary-detection remain in force.

It does not change:

- the shared `runSearch` decoding, collection, counting, stderr, cancellation, or timeout rules;
- the existing `[Truncated: ...]` envelope or its reason grammar;
- the presentation rules in §8, which require a matching presentation update and test in the same batch;
- the read contract.

The implementation must add a short "Amended by `search-tools-alignment-design.md` for grep/find argv, defaults, ignore behavior, and the fd capability probe" note to the approved document. The `runSearch` result-limit notice is an additive notice after the existing envelope, not a replacement for any §5 grammar.

## 5. Path contract

### 5.1 Normalization and resolution

For both tools, with `rawPath = typeof args.path === "string" && args.path !== "" ? args.path : "."`:

```ts
const normalizedPath = normalizePath(rawPath, {
	normalizeUnicodeSpaces: true,
	stripAtPrefix: true,
});
const childPath = normalizedPath === "" ? "." : normalizedPath;
const resolvedPath = resolveToCwd(childPath, cwd, {
	normalizeUnicodeSpaces: false,
	stripAtPrefix: false,
	expandTilde: false,
});
```

The option overrides are required: `resolveToCwd` otherwise normalizes again, which would make `@@foo` stat `/cwd/foo` while the child searches `@foo`, and similarly desynchronize `@@~` and `@@/abs`. This design intentionally normalizes once, matching read's one `resolveToCwd` pass for `@@` forms:

- `@@foo` → child `@foo`, stat/resolved `/cwd/@foo`.
- `@@~` → child `@~`, stat/resolved `/cwd/@~`.
- `@@/tmp/x` → child `@/tmp/x`, stat/resolved `/cwd/@/tmp/x`.
- `@foo` → child `foo`, stat/resolved `/cwd/foo`.
- `~/x` → child `/home/user/x`, stat/resolved `/home/user/x`.

`childPath` is passed to `rg`/`fd`; `resolvedPath` is used for `stat`, Git detection, and errors.

For the Git-ancestor walk, use `realpath(resolvedPath)` when it succeeds, otherwise `resolvedPath`. This matches the directory fd follows for a symlinked search root and avoids a false "inside Git" result from a symlink's lexical parent.

### 5.2 `grep` preflight

After binary detection and argument validation, but before building the final argv:

1. If `signal.aborted`, return the existing `Error: search aborted by user.` result.
2. `await stat(resolvedPath)`.
3. If `stat` throws and `signal.aborted`, return cancellation, not a path error.
4. `ENOENT` or `ENOTDIR`: return `Error: path not found: <safeResolvedPath>`.
5. Other `stat` errors: return `Error: cannot access path: <safeResolvedPath>: <safeErrorMessage>`.
6. If `!isFile() && !isDirectory()`: return `Error: path is not a file or directory: <safeResolvedPath>`.
7. If `signal.aborted`, return cancellation before spawning.

`grep` may search a regular file or a directory. Symlinks are followed by `stat`; a symlink to a file or directory is accepted. Special files such as character devices and FIFOs are rejected because searching them can block or produce meaningless results.

### 5.3 `find` preflight

Same normalization and abort checks. After `stat`:

- `ENOENT` or `ENOTDIR`: `Error: path not found: <safeResolvedPath>`.
- Other `stat` errors: `Error: cannot access path: <safeResolvedPath>: <safeErrorMessage>`.
- Existing entry but `!isDirectory()`: `Error: not a directory: <safeResolvedPath>`.

`find` requires a directory; a file path is not passed to fd. FIFOs, devices, and other non-directories receive the same not-a-directory error.

### 5.4 Error shape and control characters

Preflight errors are returned as `{ output, isError: true }` with no `stderr:\n` section and no child process. The message is one line.

Paths and OS error messages are sanitized for model-facing one-line output: CR, LF, tab, NUL, and other C0/C1 controls are rendered as visible escapes (for example `\n`, `\r`, `\t`, `\u0000`) before interpolation. A path containing a newline must not create a second line. No shell quoting is used because this is not a shell command; spaces are preserved. No tool name other than `grep`/`find` is suggested.

## 6. `grep` argv and behavior

The base argv becomes:

```ts
[
	"--no-config",
	"--color", "never",
	"--no-heading",
	"--line-number",
	"--hidden",
	// one --glob per VCS directory
	"--glob", "!.git",
	"--glob", "!.svn",
	"--glob", "!.hg",
	"--glob", "!.bzr",
	"--glob", "!.jj",
	"--glob", "!.sl",
	"--with-filename",
]
```

Then, in the existing order:

- `--ignore-case` when `ignoreCase === true`
- `--fixed-strings` when `literal === true`
- `--glob <glob>` when a non-empty glob is supplied
- `--context <n>` when `context > 0`
- `-- <pattern> <childPath>`

Notes:

- `--no-config` is first so `RIPGREP_CONFIG_PATH` cannot change the tool contract.
- `--hidden` is unconditional. The six VCS metadata directories are excluded immediately after it. This is D1.
- The VCS `--glob` exclusions prune recursive searches. If `path` explicitly names `.git` or a file/directory inside it, rg searches that explicit target; docs and tests pin this escape hatch.
- `--with-filename` is unconditional. Directory searches already include filenames; single-file searches now match the `path:line:text` contract.
- `--with-filename` with context keeps rg's normal match/context separator behavior.
- The tool description is updated to say that hidden files are included, VCS metadata directories are excluded, and `.gitignore` is respected **inside Git repositories** (D8).
- The prompt snippet gets the same qualifiers.
- `grep` still returns raw rg text; no JSON formatting is introduced.

## 7. `find` argv and behavior

`DEFAULT_LIMIT` becomes 1000. The schema description and tool description are updated to state the 1000-result default, the 1000-result maximum, and the 50 KiB preview cap. `findPresentation` keeps the existing "Line limit" label (the approved presentation design deliberately calls this an output-line limit because fd paths containing newlines cannot be counted as entries from text), but its excluded fallback becomes `"1000"` for consistency. That fallback is not a visible default when `limit` is omitted; the schema/tool description is the observable contract.

The base argv becomes:

```ts
["--color", "never", "--hidden", "--glob"]
```

Then:

- Add `--type file` or `--type directory` for the existing `type` filter.
- Walk ancestors of the real search path looking for `.git` (a directory or a worktree file). If none is found **and** fd supports `--no-require-git`, add it. If the capability probe is false, omit it.
- Add `--max-results <limit>`.
- If the original pattern contains `/`, add `--full-path` and compute `effectivePattern`:
  - Strip any leading `./` segments and leading `/` characters. A leading `/` is treated as relative to the search root, not as an absolute filesystem glob.
  - If the result is non-empty, does not start with `**/`, and is not exactly `**`, prefix it with `**/`.
  - If the result becomes empty, use `**`.
  - Do not normalize `..` segments; they are outside the supported path-glob forms.
  - Do not add a Windows-specific `/` replacement. Windows is unsupported and untested; a future Windows batch must add a platform-gated test rather than an unverified translation.
- Append `-- <effectivePattern> <childPath>`.

Consequences to document and test:

- `sub/*.ts`, `./sub/*.ts`, and `/sub/*.ts` all become `**/sub/*.ts`.
- `**/sub/*.ts` is unchanged.
- A leading `**/` matches an ancestor at any depth. Therefore `sub/*.ts` also matches `a/sub/x.ts`, not only root-level `sub/x.ts`. This widening matches pi's behavior and must be stated in the user docs.
- If the search root itself is named `sub`, `sub/*.ts` can also match a root-level file through the `**/sub` component. Document and test this consequence.
- The output path style remains whatever fd prints for `childPath` (relative stays relative, absolute stays absolute).

### 7.1 Git-ancestor walk

Use `realpath(resolvedPath)` when available; otherwise use `resolvedPath`. Starting at that directory, check `path.join(current, ".git")` with a `stat`-based `pathExists` helper. Stop at the first existing `.git` (directory or worktree file). If the root is reached without finding one, mark the search as outside Git.

An unreadable or erroring ancestor is treated as "no `.git` found" rather than rejecting the search. This may add `--no-require-git` redundantly for a symlinked/odd root, but it avoids an unhandled rejection and does not break find. The behavior is documented as a harmless degradation.

### 7.2 fd capability probe

Add a cached `fdCapabilities(fdPath)` helper returning `{ maxResults: boolean; noRequireGit: boolean }`:

- Spawn `fdPath --help` with a 2-second timeout.
- Collect a bounded prefix of stdout and stderr (for example 64 KiB).
- `maxResults` is true only if the help text contains `--max-results`.
- `noRequireGit` is true only if the help text contains `--no-require-git`.
- On spawn error, timeout, nonzero exit, empty output, or malformed output, return a capability error rather than guessing.
- Cache only successful capability results per fd path for the process lifetime. Do not cache errors; an aborted probe must not poison later attempts.
- Check `signal.aborted` before spawning the probe, pass the signal into the probe, kill the probe on abort, and check again before `runSearch`. Aborted probes return the existing cancellation result.
- If `maxResults` is false, return `Error: fd is too old for find: --max-results is unavailable. Install fd 8.7.0 or later.` before spawning the search.
- If `maxResults` is true and `noRequireGit` is false, omit `--no-require-git`; do not error.

The probe is a capability check, not a version parser. The implementation should expose a pure `parseFdCapabilities(helpText)` helper for deterministic tests and a probe wrapper for lifecycle tests. `--max-results` is required for this batch; `--no-require-git` degrades gracefully.

Preflight runs before this probe, and the probe runs before `runSearch`; path errors therefore win over capability errors, and a missing path never spawns `fd --help`.

### 7.3 Result-limit notice

`runSearch` accepts a new optional `resultLimit?: number`. `find` passes `resultLimit: limit`; `grep` does not.

On a successful close, after the existing preview/truncation text is built and before a stderr diagnostic is appended:

```text
if resultLimit is set and observed logical lines >= resultLimit:
  append a separate notice:
  - limit > 1:
    [Results limited to N; at least N results were found. Narrow the pattern or path if you need a complete list.]
  - limit == 1:
    [Result limited to 1; at least 1 result was found. Narrow the pattern or path if you need a complete list.]
```

Requirements:

- Use the logical-line count already computed by `runSearch`, not a byte heuristic. This is line-count based, not exact entry-count based (D9).
- The notice is emitted whenever `lines.length >= resultLimit`, even if `lines.length === resultLimit` and there might be no additional result. The wording is "at least N" and "if you need a complete list"; it does not assert that more results exist.
- If the existing `[Truncated: ...]` envelope is also present, keep it first and append the result-limit notice after it, separated by a blank line.
- Do not append the notice on abort, timeout, spawn error, nonzero exit, or guard-stopped output with fewer than `resultLimit` observed lines. The existing error/truncation handling covers those cases.
- Do not add this notice to `grep`.
- The notice is a separate line/paragraph because fd exited successfully and the collection was deliberately capped, unlike the collection-guard and preview-truncation cases in the existing `[Truncated: ...]` grammar.
- If `observed === 0`, keep the existing `No matches for LABEL` behavior; the notice is not emitted.

### 7.4 Presentation integration

Update `src/repl/tool-presentation.ts`:

- Extend the `name === "grep" || name === "find"` branch of `notice()` with an anchored regex matching both exact singular and plural result-limit notices.
- Leave `kind` as the existing `"truncation"` classification.
- `conciseNotice()` may return the raw notice; it is already short. If a shorter form is desired, it must be a pure display rewrite and must not change the source line.
- Add a `test/tool-presentation.test.ts` case with more than 1000 filler lines plus the notice, asserting the notice appears in `metadata` and survives the collapsed/expanded view.
- Add both singular and plural notices to the exact promoted-notice matrix in `test/output-integrity.test.ts`; that matrix is explicitly exhaustive for live and replay modes.

## 8. User docs and docs gates

Add and register:

- `docs/search.md` and `docs/zh-CN/search.md` with matching heading levels, fenced blocks (prefer none), and link targets.
- `docs/index.md` and `docs/zh-CN/index.md`: add a "Search files and contents" / equivalent bullet linking `search.md`.
- `scripts/check-docs.mjs`: add `"search.md"` to `REQUIRED_DOCS`, after `"cli.md"`; update the header comments that say "ten user-facing docs" to eleven. This enables zh-mirror existence, link checking, structural parity, and anchor checks.
- `scripts/build-docs-site.mjs`: add `"search.md"` to `DOC_FILES` in the same after-`cli.md` position, and add both English and Chinese `labels` and `docMetadata` entries (title and description in both languages).
- `src/core/self-docs.ts`: add a single-line topic entry `doc: "docs/search.md"` (the check-docs extractor is literal and single-line). Current rendered length is below the 1100-character budget; re-check after the addition (realistic paths measured 943 chars, deep Windows-style paths 1021 chars in review).
- `test/self-docs.test.ts` needs no new logic; its existing existence and length tests cover the new entry. The index-link check is enforced by `scripts/check-docs.mjs`, not by `test/self-docs.test.ts`.
- `README.md` / `README.zh-CN.md`: no new link required; the docs index is the routing surface.
- `docs/design/tool-output-integrity-design.md`: add a one-line amendment pointer to this design (section 4).

The search page must state, at minimum:

- `path` accepts `~`, `@`, and typed Unicode-space variants; relative result paths stay relative and `~` results are absolute.
- `grep` returns `path:line:text`, includes hidden working-tree files, excludes VCS metadata directories such as `.git` from recursive searches, and respects `.gitignore` only inside Git repositories. An explicit `path` into `.git` still searches that target.
- `find` includes hidden files, defaults to 1000 results (also the maximum), supports path-containing globs with the `**/` widening (including the search-root component case), and reports the result-limit notice.
- Non-Git `.gitignore` for `find` requires fd 8.7.0+; older fd silently omits `--no-require-git`. A missing `--max-results` produces a clean upgrade error.
- Windows is unsupported; path-glob coverage is macOS/Linux.
- The result-limit notice is line-count based; a filename with an embedded newline can trigger it early.
- A `limit: 1` notice says "at least 1 result was found"; this is expected, not a bug.

## 9. Tests

Add tests to `test/search-tools.test.ts` (real `rg`/`fd`; existing skip behavior remains) covering:

### Path handling

- `grep` with `path: "@keep.ts"` returns `keep.ts:2:...`.
- `grep` with `path: "@@keep.ts"` proves single normalization and a real file/dir named `@keep.ts` is statted the same way the child searches it.
- `grep` and `find` with an ASCII-space directory name typed with U+00A0 resolve correctly. Do not claim that a directory literally named with U+00A0 is resolved; document that as current resolver behavior, matching read.
- With a controlled `HOME`, `grep` with `path: "~/keep.ts"` and `find` with `path: "~"` resolve; restore `HOME` in `finally`.
- `grep` with a missing path returns `Error: path not found: <absolute>` and does not contain `rg exited` or `stderr:`.
- `find` with a missing path returns the same shape and does not contain `fd exited`.
- `find` with `path: "keep.ts"` returns `Error: not a directory: <absolute>`.
- A FIFO path for `grep` returns `Error: path is not a file or directory: <absolute>` without blocking or spawning; skip on platforms without `mkfifo`.
- A path containing a newline produces a one-line escaped error, not an extra output line.
- A pre-aborted signal with a missing path returns the cancellation message, not the path error. Add a deterministic abort-during-stat test if the implementation exposes a testable stat hook; otherwise record it as an untested timing risk.

### `grep` flags and hidden files

- A single-file search includes the filename (`keep.ts:2:`), not `2:`.
- With `RIPGREP_CONFIG_PATH` pointing at a config containing `--fixed-strings`, a regex search still matches regex text; restore the environment variable in `finally`.
- A hidden file such as `.hidden.ts` is found.
- A hidden file ignored by `.gitignore` is not found.
- A file under `.github` is found, proving hidden working-tree directories remain searchable.
- A probe file under `.git` is **not** found when searching the repository root, pinning D1. Isolate it with a controlled `HOME` and `GIT_CONFIG_GLOBAL=/dev/null`, use a unique marker, and locate the git dir with `git rev-parse --git-dir` rather than assuming `dir/.git`.
- The same probe **is** found when `path` explicitly points at `.git` or the probe file, documenting the explicit-target escape hatch.
- A probe file under a nested `.git` directory is not found from the repository root.
- A probe file under `.svn` (or another listed VCS directory) is not found from the repository root, covering the list beyond `.git`.

### `find` behavior

All real-fd `find` tests run only when `fdCapabilities(fd).maxResults` is true (find hard-requires the flag per D6); otherwise they skip with that reason, and the fake-fd argv/parser tests cover the old-fd path. The non-Git `.gitignore` assertion additionally requires `noRequireGit` true.

- `pattern: "sub/*.ts"`, `"./sub/*.ts"`, and `"/sub/*.ts"` all find root `sub/other.ts`.
- `pattern: "**/sub/*.ts"` finds both root and nested `a/sub/x.ts`; pin the documented `**/` widening.
- If the search root itself is named `sub`, `sub/*.ts` matches a root-level file; pin the documented search-root component case.
- A path glob with `..` is documented as unsupported; no test claims otherwise.
- In a fresh non-Git directory with `.gitignore`, an ignored `.txt` file is not listed; a kept `.txt` file is. Skip the assertion when fd lacks `--no-require-git`.
- A default search over 1001 short-named `.txt` files returns 1000 result lines, the result-limit notice, and **no** `[Truncated:` envelope. This proves `--max-results` is actually used; without it, the 1001st line would trigger the existing preview note.
- A search with an explicit `limit: 2` over at least three matches returns two result lines, the plural notice, and no `[Truncated:` envelope.
- A search with `limit: 1` returns the singular notice exactly.
- A search with fewer results than the limit does not emit the result-limit notice.
- A search with results exactly equal to the limit emits the notice ("at least N" is still true).
- Existing hidden-file, type-filter, no-match, and `.gitignore` tests continue to pass.
- A symlinked search root inside a Git repository does not receive a spurious `--no-require-git` if the capability is present; at minimum, find still returns the expected files. Add a fake argv or two-repo symlink test that actually distinguishes realpath-based detection from lexical-parent detection.

### Argv and capability tests

- Extract or expose a pure `buildGrepArgv` helper and assert the exact base argv includes `--no-config`, `--hidden`, followed by all six `--glob !…` VCS exclusions, and `--with-filename`.
- Extract or expose a pure `buildFindArgv` helper and assert exact flags: `--max-results 1000`, `--no-require-git` presence/absence, `--full-path`, `effectivePattern`, and `-- <pattern> <childPath>` ordering.
- Add a fake-fd argv-capture test proving `--max-results` is present even if the preview would otherwise hide the difference.
- Test `parseFdCapabilities` with help text containing both flags, only `--max-results`, only `--no-require-git`, neither, empty, and malformed output.
- Test the probe wrapper with a fake executable or mocked spawn: success, missing `--max-results` -> clean upgrade error, missing `--no-require-git` -> find continues without it, spawn error, timeout, nonzero exit, and caching.
- Test abort before the probe and abort during the probe: cancellation, child killed, no unhandled rejection, no poisoned cache. Preserve the existing `test/output-streams.test.ts` zero-spawn guarantees for pre-aborted find and abort during binary detection.

### Presentation, docs, and self-docs

- `test/tool-presentation.test.ts`: the result-limit notice is promoted from hidden body text and appears in metadata for both singular and plural forms.
- `test/output-integrity.test.ts`: add both singular and plural result-limit notices to the exact promoted-notice matrix in live and replay modes.
- `findPresentation` fallback is `1000`; the label remains "Line limit" (documented rationale). Because omitted non-path fallbacks are not displayed, test the schema/tool description for the 1000 default rather than claiming a visible fallback.
- Assert the grep and find tool descriptions and prompt snippets contain the "inside Git repositories" qualifier and not the old unconditional `.gitignore` claim; assert the grep description mentions VCS metadata exclusion.
- `npm run lint` runs `scripts/check-docs.mjs`; the new `docs/search.md` page is parity-checked, its zh mirror exists, and the topic is reachable from `docs/index.md`.
- `npm run docs:site` builds the new page in both languages.
- `test/self-docs.test.ts` length budget still passes with the new topic.

### Shared behavior

- Existing grep/find tests for `context`, `literal`, `ignoreCase`, `glob`, truncation, timeout/abort, and no matches must remain unchanged unless the new flags intentionally change their output (single-file filename is the only expected output-shape change).
- Existing read tests are untouched. No read source changes are planned.

Verification: `npm run build && npm test`, `npm run typecheck`, `npm run lint`, `npm run docs:site`. The current full-suite baseline is 148 files / 3,466 tests; new tests add to that count. After implementation, an independent code review is required.

## 10. Risks and open review questions

Risks:

- Hidden-file search is intentional: `.github`, `.ink`, and similar working-tree paths are visible, while `.git`, `.svn`, `.hg`, `.bzr`, `.jj`, and `.sl` are excluded. Hidden non-ignored files such as `.env` can still enter model context; VCS exclusion is not a complete secret boundary. This is recorded in D1 so it is not mistaken for an implementation bug.
- Raising the find default to 1000 can produce much more output before the 50 KiB preview cap; the existing truncation envelope still applies. The result-limit notice is separate and must not claim a total.
- Normalizing paths changes `~` results from errors to absolute paths; relative-path output should remain unchanged.
- `--no-config` intentionally ignores user ripgrep configuration, including globs and hidden settings.
- Rejecting special files in `grep` is a new restriction; it is intended to avoid blocking on FIFOs/devices.
- Old fd versions without `--max-results` receive a clean upgrade error; versions with `--max-results` but without `--no-require-git` degrade gracefully. Docs state both.
- The capability probe adds a child process before find; it must stay abort-aware and must not weaken the existing zero-spawn guarantees for pre-aborted find.
- The 1001-file test creates a large fixture; use short names and parallel creation. If it makes the suite noticeably slower, keep the fake-argv test and `limit: 2` proof and verify the default through schema/tool description.
- The Windows path-glob branch is intentionally omitted because Windows is unsupported; a future Windows batch must add a platform-gated test.
- A path containing control characters is escaped in errors; the actual child path is unchanged.
- The result-limit notice is line-count based; filenames containing newlines can trigger it early (D9).

Review questions:

1. Is a separate result-limit notice acceptable, or should it extend the existing `[Truncated: ...]` reason grammar?
2. Confirm the VCS exclusion list stays `.git`, `.svn`, `.hg`, `.bzr`, `.jj`, `.sl` (the user selected the Claude Code list).
3. Should `grep` reject only special files, or allow all `stat`-able paths and let rg decide?
4. Is "at least N results were found" the right wording, or should it copy pi's `Use limit=N*2` text and update the tool description?
5. Is the fd capability probe (`--help`) plus a clean error for missing `--max-results` acceptable, or should the design require a minimum fd version up front?
6. Is it acceptable to make `--max-results` a hard requirement for find on old fd, or should find degrade to preview-only behavior instead?
