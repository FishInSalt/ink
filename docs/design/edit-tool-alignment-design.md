# Edit tool alignment: paths, argument compatibility, and display line numbers

Status: implementation complete on `feat/edit-tool-alignment`; independent
design and code reviews approved. Full suite 3,567 tests passed; typecheck,
lint, and build passed.

Worktree: `/Users/z/Z/Agent_demo/.worktrees/ink-edit-alignment`

Branch: `feat/edit-tool-alignment`

Inspected base: `058810b` (`main`, merge of the Codex conversation-affinity fix)

Decision date: 2026-10-30

## 0. Review resolution

The first independent review returned NEEDS FIXES. This revision addresses the
four P1 findings and the applicable P2 findings:

- **P1-1 (line counters drift when `diffLines` skips equal lines).** The design
  no longer uses one header per edit plus a counter over changed lines. It
  emits one `@@ old … new … @@` header per contiguous changed block, with the
  old/new line numbers computed from the block's indices inside `oldText` /
  `newText`. Equal lines are not rendered and do not need to advance a visible
  counter.
- **P1-2 (live `tool-block.ts` renderer also parses the header).** A shared
  pure header parser and line-number helper will be used by both `fold.ts` and
  the two `tool-block.ts` render paths.
- **P1-3 (`prepareArguments` would desynchronize the gate from execution).**
  `prepareToolCall` carries the prepared record; both serial and chunk gate
  calls receive that prepared record, while history and `tool_start` keep the
  raw model arguments.
- **P1-4 (supersession was misquoted and incomplete).** Section 7 lists every
  existing design clause this batch supersedes, and only the numbering and
  `prepareArguments` clauses are superseded.
- P2 items are folded into the decisions and test plan: failing-test inventory,
  `tool-block` budget tests, the hook contract, raw-argument call-header
  degradation, pure `newLine` tests, a non-unified header syntax, the M4
  supersession, path/gate consequences, and public type/docs updates.
- **r2 P1 (guardian path gate).** The shipped `examples/extensions/guardian.mjs`
  resolves `write` / `edit` paths itself. This revision updates that example to
  mirror `resolveToCwd` for `~`, leading `@`, and Unicode spaces, and adds
  guardian tests. The core gate still receives raw arguments; the example
  remains the place that derives an absolute target.

## 1. Scope

Improve the `edit` and `write` tools without changing the exact-match edit
contract:

- Resolve `edit` and `write` paths with the same path helper `read` already
  uses, so `~`, `@`, and Unicode-space variants work.
- Add a generic, optional `prepareArguments` tool hook and use it to accept
  three malformed `edit` argument shapes that models still emit.
- Give every contiguous changed block in an edit diff its own old-file and
  new-file start line.
- Show old-file line numbers for removed lines in the edit diff fold, while
  keeping new-file numbers for added and context lines.
- Correct the "atomic" claim in the tool description and the stale
  "inherited from pi" comment in `edit-diff.ts`.

The model-facing success text remains one line. The exact-match contract,
BOM/line-ending preservation, per-file lock, and all-or-none validation before
a single write remain unchanged.

## 2. Current behavior and findings

| Source | Current behavior | Consequence |
| --- | --- | --- |
| `src/core/tools/edit.ts:56`, `write.ts:30` | `path.resolve(cwd, requested)` | `~/x` becomes `<cwd>/~/x`; `@x` is not stripped; Unicode spaces are not normalized. `read` uses `resolveReadPath`, which wraps `resolveToCwd`. |
| `src/core/loop.ts:832-856` | Raw arguments are checked against TypeBox directly | Models that send `edits` as a JSON string, a single edit object, or legacy top-level `oldText/newText` fail before `execute`. pi 1.4.0 (workspace sibling `pi`, commit `84576c70c`) uses `prepareArguments` for these shapes (`pi/packages/coding-agent/src/core/tools/edit.ts:103-134`). |
| `src/core/tools/edit-diff.ts:14-22` | `AppliedEdit.line` is the 1-indexed original line | The display uses it as the hunk start for every edit, so a hunk after an insertion/deletion reports the wrong new-file position. |
| `src/core/tools/edit.ts:98-100` | Hunk header is `@@ line N @@` | It carries only one line number and cannot distinguish the old and new sides. |
| `src/core/tools/edit-diff.ts:116-120` | `diffLines` never emits equal lines | A single header plus a counter over changed lines drifts whenever the edit keeps a shared leading or middle line. |
| `src/repl/components/fold.ts:82-115` | `+` and context lines get a new-file number; `-` lines get no number and do not advance | Removed content has no line number at all, even though pi shows its old-file line. |
| `src/repl/components/tool-block.ts:355,457` | Both live render loops parse only `@@ line N @@` | A new header format would silently disable numbering in the live TUI. |
| `src/core/tools/edit.ts:46-47` | Description says "All edits apply atomically" | The implementation validates all edits first and performs one `writeFile`; that is not a filesystem transaction. |
| `src/core/tools/edit-diff.ts:4` | Comment says the semantics are inherited from pi | pi has since added a fuzzy fallback; ink intentionally remains exact-only. The comment is now misleading. |

## 3. Decisions

### D1: `edit` and `write` use `resolveToCwd`

Both tools will call `resolveToCwd(requested, cwd)` from
`src/core/tools/path-resolve.ts` instead of `path.resolve`.

This adds:

- `~` and `~/...` expansion through `homedir()`;
- one leading `@` stripped, matching `read`;
- Unicode spaces normalized to U+0020.

An absolute path still resolves as before. A literal filename that starts with
`@` is not reachable by the bare name; `./@file` remains a workaround because
only a leading `@` is stripped. The read-only macOS screenshot variants are not
used here: they solve image-name typos, not edit targets.

`write` keeps its existing `mkdir` before writing; only the resolved path
changes. Gates still see the raw `path` argument, not the resolved absolute
path. The shipped guardian example resolves `write` / `edit` paths itself, so it
must mirror `resolveToCwd` for these variants or its rules and audit would
name a different target than the tool writes. Update
`examples/extensions/guardian.mjs` with a local helper that performs the same
Unicode-space normalization, one-leading-`@` strip, and `~` expansion, and add
`test/guardian.test.ts` cases for all three. Other gates that resolve paths
outside the core still need to do the same; this batch does not add a
`resolvedPath` field to `ToolCallEvent`.

### D2: `Tool` gains an optional `prepareArguments` hook

Add to `src/core/tools/types.ts`:

```ts
prepareArguments?: (args: Record<string, unknown>) => Record<string, unknown>;
```

The hook is synchronous, receives the already-object-checked raw arguments,
and must return a plain object. A plain object has `Object.prototype` or a
`null` prototype; arrays, `Date`, class instances, and thenables/Promises are
contract violations. It must not mutate its input; `edits` arrays must be
copied before appending. The loop calls it in `prepareToolCall` after the
existing "arguments must be a JSON object" check and before `Value.Check`.
The returned object is used for schema validation, the gate, and execution.
`call.arguments` itself is not mutated, so history and `tool_start` continue to
carry exactly what the model sent; the gate event and `execute` carry the
prepared record. `tool_start` therefore may show the generic raw-argument call
header for a malformed edit shape instead of the readable replacement summary.
That degradation is accepted; execution and the gate use the prepared record.

If the hook throws or returns a non-plain-object (including `null`, an array,
`Date`, or a Promise), the call settles as an error result. A thrown hook or a
contract violation uses a distinct `prepareArguments failed` message; it must
not tell the model to "fix the arguments" when the tool hook is at fault. A
hook that returns a plain object that still fails TypeBox proceeds to the
normal schema error path.

The edit hook implements pi-compatible coercion:

1. `edits` is a string: parse JSON; use an array as-is, wrap a single
   `{oldText, newText}` object, otherwise leave the value for schema failure.
2. `edits` is a single `{oldText, newText}` object: wrap it in a new array.
3. Top-level `oldText` and `newText` strings: append them to `edits`, then
   remove the top-level fields from the returned object. This follows pi: if
   `edits` is an array, copy it and append; if `edits` is absent or not an
   array (including an unparseable string or a number), start from an empty
   array and use the top-level pair. If both a valid array and top-level
   fields are present, the pair is appended and normal duplicate/overlap
   validation decides the outcome. Add tests for both the valid-array and
   invalid-`edits` cases.

A JSON parse failure leaves the original value untouched so the normal schema
error remains the model-visible instruction. Anything still invalid after the
hook goes through the normal TypeBox error path.

### D3: per-block old/new start lines

`AppliedEdit` keeps `line` as the 1-indexed old-file start and gains `newLine`
as the 1-indexed new-file start. After sorting edits by `start`, compute:

```text
newLine = line + sum(line-count(newText) - line-count(oldText))
         for all earlier edits
```

where `line-count(text) = text.split("\n").length`. This is sufficient because
edits are non-overlapping and sorted; every earlier edit lies entirely before
the current start. It handles insertions, deletions, replacements, and edits
that start mid-line.

`diffLines(before, after, numbers?)` keeps its current no-header behavior when
`numbers` is omitted. When `numbers` is provided, it emits one header per
contiguous changed block:

```text
@@ old <oldStart> new <newStart> @@
- old line
+ new line
```

The block header uses the block's first old index and first new index, both
**zero-based** indices into `before.split("\n")` and `after.split("\n")`:

```text
oldStart = numbers.oldLine + firstOldIndex
newStart = numbers.newLine + firstNewIndex
```

Equal lines are still not rendered; a new header starts after each run of
equal lines. A trailing remainder after the LCS loop joins the open block if
one exists; otherwise it starts one header. This avoids a single-counter drift
and keeps the compact changed-lines-only display. The header syntax is
deliberately not a unified diff header (`@@ -5 +7 @@` would look like a valid
patch with implicit counts); `@@ old 5 new 7 @@` is Ink-specific.

For a block with only additions, `oldStart` is the insertion point in the old
file (it may be one past the last old line); for a block with only deletions,
`newStart` is the deletion point in the new file (it may be one past the last
new line). The unused side appears in the header as that position, but no
content line is rendered and no gutter number is assigned on that side.

If the LCS table exceeds the 1,000,000-cell guard, numeric mode emits the
unparseable `@@ diff elided @@` reset marker before the existing `- N lines` /
`+ M lines (diff elided)` summary. Both renderers treat any `@@` line as a
header and `parseHunkHeader` returns null for this marker, so numbering is off
for the summary rows: they are not source lines and must not receive
source-line gutters. No-header mode keeps its current summary without a
marker.

`edit.ts` calls `diffLines(e.oldText, e.newText, { oldLine: e.line, newLine:
e.newLine })` and no longer prepends its own header. The old `@@ line N @@`
form remains parseable for compatibility and means `old = new = N`; for later
hunks that form is only a best-effort old/new fallback because it predates the
two-sided header.

### D4: removed lines show old-file numbers

A shared pure helper parses both header forms and advances two counters. Its
exports are:

```ts
type DiffNumbering = { old: number | null; new: number | null };
parseHunkHeader(line: string): { oldLine: number; newLine: number } | null
createDiffNumbering(header: ReturnType<typeof parseHunkHeader>): DiffNumbering
nextDiffLineNumber(state: DiffNumbering, kind: "add" | "remove" | "context"): number | null
```

`parseHunkHeader` accepts legacy `@@ line N @@` (old = new = N) and the new
`@@ old O new N @@`. `createDiffNumbering` resets both counters from the header,
or turns both off for an unsupported/foreign `@@` header. `nextDiffLineNumber`
returns the number to render and advances the matching counter(s):

- `-` line: render the old counter, then increment it;
- `+` line: render the new counter, then increment it;
- context line: render the new counter, then increment both.

The helper returns numbers only, not padded strings. `fold.ts` remains
responsible for computing the widest number and padding its `NNN│ ` gutter.
`tool-block.ts` keeps its existing unpadded `NNN ` prefix behavior; it only
starts prefixing removed lines as well. Exact expected rows for both renderers
are pinned in tests. The old per-renderer regexes are removed.

Example with a shared leading line, which the per-block header handles without
rendering the equal line:

```text
@@ old 3 new 3 @@
  3│ - deleted line
  3│ + new line
```

A deletion-only block still shows the removed line's old-file number. No
surrounding-file context lines are added; only changed blocks are rendered, and
each block's counters start from that block's header. Context line numbers, when
a context line is present in a foreign diff, remain new-file numbers.

### D5: descriptions and comments state the actual guarantees

- Replace "All edits apply atomically" with wording equivalent to: "All edits
  are validated before a single write; if any oldText is not found or matches
  more than once, nothing is written."
- In `edit-diff.ts`, state that the core multi-edit semantics match pi's
  exact-match path and that pi's fuzzy fallback is intentionally not ported.
- Document the two line-number spaces in `AppliedEdit`, `diffLines`, and
  `fold.ts`.
- Update `ToolCallEvent.args` and `docs/extensions.md` to say the gate receives
  prepared, schema-validated arguments: the same prepared object `execute()`
  receives. A gate that mutates it affects execution, matching the existing
  contract.
- Update the `Tool` interface comment: it is pure data plus optional
  presentation and argument-preparation hooks and one async function.

### D6: compatibility and non-goals

In scope only:

- the five changes above;
- the gate/prepared-argument alignment required by D2;
- the guardian example's path normalization and tests required by D1;
- tests for them;
- a changelog entry;
- a short `prepareArguments` note in the extension docs and the M4 design
  supersession.

Explicit non-goals:

- fuzzy matching, Unicode normalization for matching, or any change to the
  exact-match contract;
- structured `details` (`diff`, `patch`, `firstChangedLine`) or persistence
  changes;
- `constrainedSampling`, `EditOperations` injection, or remote filesystems;
- changing per-edit no-op rejection;
- permission prechecks, abort semantics, line-ending detection, or the file
  lock;
- showing surrounding-file context lines or adopting pi's diff format;
- `ctx.cwd` overrides; worktree isolation continues to rebuild tools with a
  new cwd;
- changes to `read` or to the model-facing one-line success text.

## 4. Implementation plan

1. `src/core/tools/types.ts`: add the optional `prepareArguments` hook and
   update the interface comment.
2. `src/core/loop.ts`:
   - call the hook after the object check and before schema validation;
   - turn throws and non-plain-object returns into error results;
   - make `ChunkPlan` carry the prepared record;
   - pass the prepared record to `onToolCall` in both `executeChunk` and
     `executeToolCall`.
3. `src/extensions/types.ts`: update `ToolCallEvent.args` to describe prepared,
     schema-validated arguments; keep the gate contract "the same object
     execute() receives".
4. `src/core/tools/edit.ts`:
   - implement `prepareEditArguments` and attach it;
   - use `resolveToCwd`;
   - pass both line numbers to `diffLines`;
   - update the description.
5. `src/core/tools/edit-diff.ts`: add `newLine`, compute it after sorting,
   add per-block headers in numbered mode, and update comments.
6. `src/core/tools/write.ts`: use `resolveToCwd`.
7. `src/repl/components/diff-numbering.ts`: add the shared header parser and
   line-counter helper.
8. `src/repl/components/fold.ts`: use the shared helper.
9. `src/repl/components/tool-block.ts`: use the shared helper in both parse
   loops and prefix removed lines.
10. `examples/extensions/guardian.mjs` and `test/guardian.test.ts`: mirror
    `resolveToCwd` for `~`, leading `@`, and Unicode spaces.
11. Tests and docs.

## 5. Tests

### Path resolution

- `edit` with `@file` edits `file`, not a literal `@file`; `./@file` still
  addresses a literal `@` name.
- `edit` with a Unicode-space path edits the ASCII-space file.
- `edit` with `~/...` edits a file under a stubbed home directory.
- `write` covers the same path variants.
- A gate sees the raw `path`, not the resolved absolute path.
- The guardian example resolves `~`, leading `@`, and Unicode-space paths like
  `resolveToCwd`; absolute-home rules match `~/...` and `@/absolute/home/...`,
  while a cwd-relative `@file` resolves under the caller cwd. Unicode-space
  targets are normalized before matching. `test/guardian.test.ts` is in the
  targeted suite.
- `@file` and `file` share the same per-file lock key.
- Absolute and ordinary relative paths still behave as before.

### Argument compatibility

- Each of the three shapes reaches `execute` with `edits` normalized.
- Invalid JSON, a non-edit single object, and a non-array after coercion still
  produce the existing schema error.
- The raw `call.arguments` object in history is unchanged after a loop-level
  call; the gate sees the prepared record and `execute` sees the same object.
  The core `ToolCallEvent.args.path` stays raw; the guardian derives its own
  normalized absolute match text.
- A hook that throws or returns `null`, an array, `Date`, a Promise, or another
  non-plain object produces an error result and does not execute the tool; a
  thrown hook or contract violation uses `prepareArguments failed`, not "fix
  the arguments". An empty thrown message is still sanitized and bounded.
- `{path, edits: [...], oldText, newText}` follows pi: the top-level pair is
  appended and normal duplicate/overlap validation decides the outcome.
- A tool without the hook behaves exactly as before.
- Serial and concurrency-safe chunk paths both pass prepared args to the gate.
- A malformed edit shape may show the generic raw-argument call header; this
  is documented degradation, not a silent execution mismatch.

### Line numbers

- A single-line replacement fixture displays `@@ old 2 new 2 @@` and numbers
  added/removed lines from 2.
- Pure `applyEdits` tests assert `line` / `newLine` for insertion, deletion,
  replacement, mid-line edits, same-line multiple edits, and the invariant
  `newLine >= 1`.
- Two edits with an insertion before the second display the second header with
  its real new-file start.
- A deletion-only edit shows the removed line's old-file number.
- A replacement with a shared leading line (`a\nb` → `a\nc`) shows the removed
  and added lines at the real lines, not at the edit start (`@@ old 3 new 3 @@`).
- A replacement with a shared middle line (`a\nb\nc\nd` → `a\nX\nc\nY`) emits
  two headers with the correct old/new starts.
- A replacement with no shared lines emits one header.
- An insertion after the last line and a deletion to an empty file report the
  insertion/deletion point on the unused side; the inserted/removed content is
  numbered on its own side (for `a` → `a\nb`, `+ b` is new line 3).
- A fragment over the LCS guard emits the `@@ diff elided @@` reset marker
  before the summary, so the summary rows stay unnumbered.
- Legacy `@@ line N @@` still numbers both sides from N.
- An unparseable header still disables numbering.
- Gutter width accounts for both counters.
- `tool-block.ts` collapsed and expanded rows number removed, added, and
  context lines correctly for both header forms; long removed lines respect
  the 8-row collapsed budget and narrow/wide expanded width budgets. Existing
  notice/retention suites cover promotion and omission behavior; this batch
  adds the numbering-prefix width case.

### Existing assertions to update

- `test/edit-write.test.ts:97,248` — `@@ line 2 @@` / `@@ line 1 @@` become the
  two-sided header.
- `test/repl-fold.test.ts:219` — the removed line now gets an old-file number.
- `test/tool-display-colors.test.ts:126` — `"    - old"` / `"    7 + new"`
  become numbered old/new rows.
- `test/loop-hooks.test.ts:91-95` — the gate sees prepared args; add a hook
  case alongside the existing schema-validated case.
- `test/tool-block`-backed fixtures in
  `test/tool-display-previews.test.ts`, `test/tool-presentation.test.ts`,
  `test/builtin-display-layout.test.ts`, and `test/render.test.ts` — update
  only where exact diff rows or header strings are asserted.

### Regression suites

Targeted:

```text
npx vitest run test/edit-write.test.ts test/loop.test.ts \
  test/loop-hooks.test.ts test/repl-fold.test.ts \
  test/tool-display-colors.test.ts test/tool-display-previews.test.ts \
  test/tool-presentation.test.ts test/builtin-display-layout.test.ts \
  test/builtin-tool-presentation.test.ts \
  test/builtin-tool-presentation-integration.test.ts test/render.test.ts \
  test/guardian.test.ts
```

Then `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build`.
Report exact pass/skip counts.

## 6. Documentation

- New design document: this file.
- `CHANGELOG.md` under `[Unreleased]`: one fixed entry covering path
  normalization, edit argument compatibility, and corrected diff line numbers.
- `docs/extensions.md` and `docs/zh-CN/extensions.md`: a short note that
  `prepareArguments` may coerce raw model arguments before schema validation;
  gates see the prepared object. This is a public, optional hook; absent hooks
  are unchanged.
- `src/extensions/types.ts`: update the `ToolCallEvent.args` comment.
- No published page currently documents edit tool argument details. The tool
  descriptions and changelog carry the user-visible behavior; no new docs page
  is added in this batch.
- `examples/extensions/guardian.mjs`: update the file-rule comment and the local
  path-resolution helper so it mirrors `resolveToCwd`; add guardian tests for
  `~`, leading `@`, and Unicode-space paths.
- `docs/design/guardian-design.md`: add a short note at the file-path matching
  clause that edit/write targets are normalized like `resolveToCwd` before the
  lexical `path.resolve`; no realpath is added.

## 7. Superseded design clauses

This batch changes edit/write path normalization, line-number behavior, and
adds `prepareArguments`. It explicitly supersedes only these clauses; all other
requirements in the cited documents remain:

| Document | Clause | Superseded part |
| --- | --- | --- |
| `docs/design/builtin-display-polish-design.md:18` | Preserve edit result diff colors, line numbering, eight-row budget | Numbering semantics only; colors and budget remain. |
| `docs/design/builtin-display-polish-design.md:95` | Edit output parsing, content, display, hunk colors, numbering and eight-row preview remain unchanged | Numbering and hunk-header syntax only. |
| `docs/design/builtin-display-polish-design.md:173` | Edit result red deletions, green additions, cyan hunk headers, context line numbering, eight-row budget, expanded sections and replay behavior remain intact | Numbering and header syntax only; colors, budget, sections and replay remain. |
| `docs/design/builtin-display-layout-design.md:59` | Preserve diff numbering prefixes unchanged | Numbering prefixes now include old-file numbers for removed lines. |
| `docs/design/tool-display-previews-design.md:181` | Retain current gutter line-number semantics; continuation rows must not invent source line numbers | Removed lines now carry old-file numbers; continuation rows still must not invent numbers. |
| `docs/design/tool-display-polish-design.md:57-58,81` | Preserve diff colors and meaningful line numbers; no second ornamental gutter | Colors and single-gutter rule remain; line-number semantics change. |
| `docs/design/tool-presentation-hooks-design.md:177` | Real diffs retain current colors/line numbering | Numbering semantics only; colors and gutters remain. |
| `docs/design/tool-display-previews-design.md:14` | Existing diff decoration supplies colors and new-file line numbers | Descriptive finding; removed lines now also carry old-file numbers. |
| `docs/design/tool-display-polish-design.md:334` | Golden layout test checklist includes diff colors/line numbers | The checklist's numbering expectations follow this batch; colors remain. |
| `docs/design/m4-extensions-design.md:224-228` | No `prepareArguments` shim; extensions reuse `Tool` verbatim | The optional hook is now part of `Tool`; the rationale changed from legacy stored args to model-emitted malformed shapes and generic tool authoring. |
| `docs/design/guardian-design.md:63,136-137` | `write` / `edit` match text is the resolved absolute path via `path.resolve` against the caller cwd | The target is first normalized like `resolveToCwd` (Unicode spaces, one leading `@`, `~`) and then resolved lexically; no realpath is added. |

The "removed lines get no number" assertion is in the current code and tests
(`src/repl/components/fold.ts:82-88`, `test/repl-fold.test.ts:219`), not in the
cited design document. Those assertions are updated by this batch.

## 8. Risks and edge cases

- `@` stripping changes access to literal `@`-prefixed filenames. `./@file`
  remains a workaround; this is accepted for parity with `read` and pi.
- `~` expansion depends on `homedir()`; tests must stub and restore `HOME`.
- The guardian example's local path helper duplicates `resolveToCwd`; tests pin
  the three supported variants. Other third-party gates that derive absolute
  paths must mirror the same normalization; core does not expose a
  `resolvedPath` field in this batch.
- A `prepareArguments` hook is public API. The loop must not mutate raw
  arguments and must not let a hook bypass the JSON-object check. A gate that
  rewrites its `args` object can still affect execution because the gate and
  `execute` share the prepared object, matching the existing contract.
- Per-block headers are not unified-diff headers. External consumers must not
  treat the display string as a patch. `tool-block.ts` and `fold.ts` are the
  only parsers; the shared helper makes that explicit.
- `newLine` depends on edits being sorted and non-overlapping. Both are already
  guaranteed before computation; pure tests cover insertion, deletion,
  replacement, mid-line edits, and multiple edits on one line.
- Adding numbers to removed lines consumes prefix width in `tool-block.ts` and
  can change wrapping and the collapsed 8-row budget. Tests must cover narrow
  widths and long removed lines.
- Old sessions persist model content, not display text. The display format
  change does not affect resume; the old header parser remains for any existing
  display strings.
- Deleted-line numbering is display-only; the file content and model result are
  unchanged.

## 9. Acceptance criteria

- All five behaviors work end-to-end.
- Gate and `execute` receive the same prepared record; history keeps raw
  arguments.
- Existing exact-match, BOM/CRLF, atomic-failure, and lock tests still pass.
- `fold.ts` and both `tool-block.ts` paths share one parser and one numbering
  helper; no duplicate header regex remains.
- No model-facing success text or session schema changes.
- The targeted suites, full test suite, typecheck, lint, and build pass.
- An independent design review approves this document before implementation;
  a separate independent code review follows implementation.

## 10. Review log

- r1 independent adversarial review: NEEDS FIXES — P1-1 diff counter drift,
  P1-2 `tool-block.ts` parser, P1-3 gate/prepared-argument mismatch, P1-4
  incomplete supersessions; plus P2 test/docs/budget items.
- r2: per-block headers, shared parser/helper, prepared args to both gates,
  supersession table, guardian path normalization, and P2 contract/test
  precision.
- r2 re-review: NEEDS FIXES — guardian path-gate mismatch (now fixed by
  mirroring `resolveToCwd` in the example), plus P2 index-base, elided-path,
  helper API/padding, plain-object, legacy-precedence, boundary, assertion
  inventory, and expanded-row coverage. This revision addresses them.
- r3 re-review: APPROVE WITH CHANGES — the guardian fix is sound; add the
  guardian-design supersession row/intro and resolve the P3 precision notes.
  The required row and notes are now in this revision; implementation may
  start.
- code review r1: APPROVE WITH CHANGES — no P1; add a closed edit schema and
  loop-level real-edit integration tests, harden hook contract checks, fix
  legacy-pair presentation, and remove numbering from elided summaries.
- code review r2: APPROVE — elided marker resets all three render paths,
  revoked-Proxy hardening is complete, and gate/execute identity is pinned.
  Full suite 3,567 passed; typecheck/lint/build passed. Branch is ready for
  commit and merge review.
