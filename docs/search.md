# Search tools: grep and find

Ink has two read-only search tools. `grep` searches file contents with
ripgrep; `find` searches file and directory names with fd. Both are preferred
over running `grep`, `rg`, or `find` through the bash tool.

## Path handling

The `path` argument accepts relative paths, `~` home paths, `@` prefixes, and
the Unicode space variants commonly produced by terminals and rich-text paste.
Relative paths keep relative result paths; `~` paths produce absolute paths.

A missing path returns a one-line error with the resolved absolute path.
`grep` accepts a file or a directory; `find` requires a directory.

## grep

`grep` returns matching lines as `path:line:text`, including the filename for
single-file searches. It always includes hidden working-tree files, so
`.github`, `.ink`, and `.gitignore` are searchable, but it excludes VCS
metadata directories: `.git`, `.svn`, `.hg`, `.bzr`, `.jj`, and `.sl`.

The exclusion applies to recursive searches. If `path` explicitly points at
`.git` or a file inside it, ripgrep searches that explicit target; use this
deliberately when inspecting repository metadata. Hidden files that are not
ignored by `.gitignore`, such as `.env`, can still appear in results; VCS
exclusion is not a complete secret boundary.

`grep` respects `.gitignore` inside Git repositories. It does not read ambient
ripgrep configuration, so results are reproducible across user environments.
Output is limited to the first 100 output lines and 50KB by default; the
`limit` parameter can raise the line cap to 1000.

## find

`find` includes hidden files and uses fd's normal ignore handling. It respects
`.gitignore` inside Git repositories; outside Git repositories this requires
fd 8.7.0 or newer, because Ink uses fd's `--no-require-git` capability there.

The pattern is a glob. Path-shaped patterns such as `src/**/*.ts` are
supported. A leading `./` or `/` is normalized, and a leading `**/` matches an
ancestor at any depth, so `sub/*.ts` also matches `a/sub/file.ts`. If the search
root itself is named `sub`, a root-level file can match too. Patterns with
`..` segments are not normalized and are outside the supported path-glob forms.

`find` defaults to 1000 results, which is also the maximum. When the limit is
reached, the result includes a notice that at least that many results were
found. The notice is based on output lines; a filename containing a newline can
trigger it before the true result count. Narrow the pattern or path rather than
raising the limit.

## Versions and limits

A missing fd `--max-results` capability produces a clean upgrade error. Older
fd versions without `--no-require-git` still work, but non-Git `.gitignore`
is not respected there.

Both tools cap their output at 50KB. Windows is not supported; use WSL.
