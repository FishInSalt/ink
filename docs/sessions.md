# Sessions

Read this when you resume or fork a conversation, navigate history, or want
to know how compaction works. Model/provider questions →
[providers.md](providers.md).

## Where sessions live

Sessions are append-only JSONL message trees saved under `~/.ink/sessions/`,
organized by working directory. Every turn — user messages, assistant
messages, tool calls and results, model changes, compaction checkpoints — is
preserved on disk; nothing is ever rewritten.

```bash
ink -c                  # continue the most recent session in this directory
ink -r                  # ink sessions lists them; -r <id> resumes (prefix ok)
ink --no-session        # ephemeral run; nothing persisted
```

In the REPL: `/sessions` lists, `/resume <id>` switches (history replays on
screen), `/new` starts a fresh session (the old one stays on disk), `/name
<name>` names the session for the picker, `/status` shows session, model,
context, and trust at a glance. `/sessions prune` sweeps orphaned child
sessions (subagent transcripts whose parent file no longer exists) after an
interactive confirm. The exit line always shows how to resume:
`ink -r <id>`.

ChatGPT subscription requests derive their cache/session fields from a hash
of the existing session ID: resume keeps it and `/new` replaces it. With
`--no-session`, one temporary identity lasts until `/new`. Children have
separate identities, retries keep the current identity, and summaries omit it.

Responses messages can include optional provider/model provenance and replay
metadata for finalized reasoning ciphertext, item IDs, text parts and phases.
The JSONL organization and version are unchanged; old sessions need no rewrite.
Only matching-provider, exact-model requests replay native metadata. Other
providers and summaries use canonical text/tool content, never ciphertext.
Compaction preserves metadata on retained messages and discards it from summary
prompts. Resuming a selected subscription model without a usable credential
requests login; it never silently switches the session to API-key billing.

Large `edit` insertions and deletions retain a short success receipt in model
history, while the detailed diff is display-only.

## Usage and reference cost

The interactive status bar's `↑` (ordinary input), `↓` (output), `R` (cache
read), and `W` (cache write) counts are cumulative across the whole session,
including all branches, subagent attempts, and summarization. Zero `R`/`W`
counts are omitted. `CH` is the cumulative, input-token-weighted cache hit
rate: `100 × R / (↑ + R + W)`, calculated from the raw counts and shown to
one decimal place. It is not the last response's rate or an arithmetic
average of response percentages; output tokens do not enter the formula.
A positive denominator with no cache reads shows `CH0.0%`; a zero denominator
omits CH. Compaction and model/branch changes do not reset these totals;
resuming restores them, while `/new` starts fresh. Without a session
(`--no-session`), these usage segments are absent. The rate reflects recorded
usage only: unreported cache counters contribute zero, and missing usage is
not reconstructed.

Reference cost uses each producer's base provider/model and current catalog
rates, with Codex service-tier adjustments attributed to the original call.
Normal/Fast/normal calls under one base model keep their separate observations;
changing the selection, navigating history, compacting, or reopening does not
relabel earlier work. Child attempts and summary retry hops likewise retain
their own per-call observations, not just the final hop's report. Pricing never
multiplies raw input, output, cache-read or cache-write counters.

`~` marks incomplete reference pricing, including positive Codex usage with
unknown tiers or absent/invalid legacy observations priced at base rates.
`!` still marks known-missing usage; the two signals are independent. Valid raw
usage survives invalid pricing metadata. Unknown catalog rates remain unpriced;
no estimate reconstructs unreported work or measures actual subscription
allowance/billing. The rules and pinned source are in
[Codex reference pricing](providers.md#codex-reference-pricing).

Task-result accounting is captured before `tool_settled` or `tool_end`
observers receive it. Changing, replacing or deleting an observer's task record
cannot relabel the stored child identity, raw usage or pricing observations;
retained references cannot change them later either. The session store also
copies this metadata when appending messages and compaction tails, and when
reading files. Valid raw usage survives malformed advisory pricing; absent,
invalid or unsupported-version task records remain unknown rather than acquiring
invented usage. Task metadata never enters model input, summaries or token
estimates. This isolates accounting only, not tool content/status or arbitrary
host code that directly edits history or store entries. No old files are rewritten.

## Model selection and Fast

Sessions save the base provider/model plus optional `speed:"fast"` for a Codex
Fast selection. Restoring it preserves `·fast`, including custom models whose
capability is not advertised. A saved model without speed means normal;
restoring it clears any previous Fast selection. Old model-less sessions keep
the existing startup precedence, including an explicit `-m ...·fast`.
The existing explicit `-m` versus restored-session precedence is unchanged.
`/new` retains the current model and speed. No session rewrite or version change
is needed; speed-only changes are appended like other model selections.

Normal and Fast for the same base model share the same metadata and compatible
native replay history. Exact provider/base-model replay checks are unchanged;
the suffix is not part of assistant provenance or usage/pricing identity.
Thinking is independent of speed.

New Codex assistant messages also retain optional `serviceTier` observations:
`requested:"omitted"|"priority"` and optional bounded terminal `reported` text.
They do not enter provider replay, summary prompts or context estimates; they
can adjust the local reference cost as described above. Old messages remain
readable without observations and use legacy base-only Codex pricing when rates
are known, with the incomplete-pricing marker. `/status` can show the **LAST
response** for the current exact provider/base model in active history; if its
latest assistant has no valid observation, no older one is substituted. It is
not confirmation of the current selection or actual processing/billing. Valid
responses are not rejected solely for a different reported tier; actual errors
and non-execution of incomplete tool batches remain unchanged.

Each top-level run captures provider, model, and speed at entry, before
`run_start`. Its tool follow-ups and overflow recovery keep that snapshot;
changing `/model` affects the next top-level run, not the active main loop.
New child dispatch is the deliberate exception: it captures the **live**
selection at dispatch, not the parent run's earlier snapshot. Child continuation
uses the child's recorded speed, not the parent's current selection.

Session ownership is separate from live child selection. If `/new` or `/resume`
changes the displayed conversation during a run, including an automatic or
overflow summary, that run's accepted checkpoint, subsequent messages and task
records stay with its captured session. Child parent links and continuation
lookups use that same parent, not the replacement session; the next run belongs
to the replacement. A run captured without a parent store does not acquire child
transcript persistence merely because a saved session later becomes active.

## The tree

Every session's messages form a tree, not a line. Forking or jumping creates
a branch; the active branch supplies history for the next model request.

- `/fork` — branch the conversation before an earlier message. Pick one from
  the filterable user-message list, or `/fork <n>`. Jumping to a user
  message puts its text back in the input for re-editing.
- `/tree` — a visual picker over every turn and branch. Arrows move; Tab
  cycles the filter (default / no-tools / user-only / labeled-only / all);
  `f` folds a subtree; `L` labels the selected entry (labels are searchable
  bookmarks that survive every filter); typing searches; Enter jumps.
  ←/→/PgUp/PgDn page; alt+←/→ fold at branch points; ctrl+x copies the
  selected entry's text; deep rows pan automatically. The picker opens on
  your current position.
- Jumping away from a branch optionally summarizes the branch you left into
  the new position's context (a three-way ask: No summary / Summarize /
  custom prompt). `INK_BRANCH_SUMMARY=0` disables summaries entirely;
  `/settings branchSummary.skipPrompt true` skips the ask (straight to
  no-summary). `/settings treeFilterMode <mode>` remembers your default
  filter.
- The readline (non-TUI) shell renders the tree as a numbered list;
  `/tree <n>` jumps to row n.

## Compaction

Near the context window, older turns are LLM-summarized into a checkpoint:
subsequent model requests use the summary plus recent turns, while the full
history stays on disk. `/compact` triggers it manually (optionally with
custom instructions). `--no-session` also disables auto-compaction;
`INK_AUTOCOMPACT=0` or `"autoCompact": false` in settings turns it off.
`INK_CONTEXT_WINDOW` overrides the window estimate (default 131072).

Hidden Responses reasoning contributes to the context estimate only when its
native metadata can replay to the active provider and exact model. Switching
away excludes that hidden content and incompatible usage measurements; switching
back accounts for it again if still retained. Footer, `/status`, automatic
compaction and retained-tail selection use the same target-aware estimates.
Ciphertext length is never treated as a token count; cumulative recorded usage
is unchanged by model switches.

Branch summaries (from `/tree` jumps) are separate: they record an abandoned
branch in one entry. Both preserve the original entries — the tree is never
pruned.

Automatic compaction and overflow summaries use the active run's captured
speed. Manual `/compact` and branch summaries capture the current selection
when they start; child summaries use the child's own captured speed. A
summarizer retry that changes thinking keeps the same speed. Fast errors never
cause a normal-speed fallback summary.

Accepted summaries carry all captured usage and per-call pricing observations
in their existing checkpoint/branch-summary entry. Rejected parent summaries
(for example, capped, empty, failed or aborted summaries, or branch summaries
that cannot be installed after a session change) can instead append a
`summaryUsage` accounting-only receipt for already-captured usage and missing
report flags. A later retry failure does not discard an earlier hop's report.
The receipt never contains rejected summary text and never supplies context or
provider replay. It is not a tree node or navigation target, does not move the
active position, and does not count as a user/assistant turn.

Receipts belong to the session file where the summary started, even if another
session becomes active. Reopening that same file during the operation routes the
single receipt through the reopened store, so live and reopened totals agree.
Installed summaries are counted only in their accepted entries; child summary
usage reaches the parent only through the child's task record, not an additional
parent receipt or a scan of the child's transcript.

No receipt or charge estimate is invented for a summary that never started.
Work whose usage was never reported remains unknown, not zero-cost. Receipt
write failures are diagnosed, not proof of durable accounting. Existing session
files remain readable without rewriting or a header-version change, but files
containing the new `summaryUsage` entry kind may not work with older binaries.

## Multi-line input and terminal behavior

Enter submits the editor. **Shift+Enter** or **Ctrl+J** inserts a newline;
backslash immediately before Enter is another newline alternative.

In local macOS Terminal.app sessions, Ink checks native Shift state when the
terminal sends plain Return or ESC+Return. With Shift held, both insert a
newline; without Shift, ESC+Return keeps its Alt+Enter behavior. This is
best-effort local detection, not a change to macOS shortcuts. It cannot inspect
the keyboard on another machine over SSH; use Ctrl+J there if necessary.

Ink stays on the regular terminal screen with native scrollback. The editor uses
the hardware cursor for input-method positioning, without a second inverse-video
cursor. PageUp/PageDown page through pickers and open completion menus;
Ctrl+PageUp/Ctrl+PageDown remain available for editor movement. The renderer no
longer reads the upstream `PI_HARDWARE_CURSOR` or `PI_CLEAR_ON_SHRINK` defaults;
Ink explicitly enables the hardware cursor and leaves clear-on-shrink off.

A rendering-width error can save rendered conversation text in a private
`ink-renderer-logs-*` directory under the OS temporary directory. The error names the
file; the directory is created lazily, reused within the process, and retained
for diagnosis. Upstream `PI_TUI_DEBUG_REDRAW=1` logs use the same private
directory. Treat those files as conversation data. Separate upstream opt-ins
are not redirected or covered by this private default: `PI_TUI_DEBUG=1` writes
to upstream `/tmp/tui`, and `PI_TUI_WRITE_LOG` writes to the chosen path.

Ink checks the default directory's identity and private permissions before
rendering and again before logging. If it detects a missing or unsafe directory,
it stops with an error; restart Ink. These checks are not atomic against
concurrent external filesystem changes and cannot undo exposure of saved files
if their permissions are changed externally.

## Steering and follow-ups (interactive)

Lines typed while Ink is working are queued, never dropped:

- **Enter** → a `steer:` line, injected into the running turn before the
  next model call. Default drain mode `all`: every queued steer joins the
  next boundary at once.
- **Alt+Enter** → a `follow-up:` line, consumed by the same run when the
  model would otherwise stop. Default `one-at-a-time`: one follow-up per
  answer, so a queued sequence advances without returning to idle.
- **Alt+Up / Esc+P** pulls every queued line back into the editor (draft
  preserved); Ctrl+C abort hands them back the same way.
- Modes are settings keys: `/settings steeringMode` and
  `/settings followUpMode` (`all` | `one-at-a-time`).

Terminal notes: WezTerm binds Option+Enter to fullscreen and Alacritty may
send plain Return — map both to `\x1b[13;3u`, or use Esc+P (dequeue has a
fallback; Alt+Enter does not).

## Known limits

- A recognized terminal response that never finishes can retain subsequent raw
  keyboard bytes, including Ctrl+C/Ctrl+D. This does not mean an unsupported
  query with no reply blocks input. A later terminator or new escape sequence
  can restore input; try an arrow key followed by Ctrl+C again. Earlier buffered
  keys are not replayed, and one Escape or repeated raw Ctrl+C is not reliable.
  OS signals still bypass this parser. `PI_PROGRAM_STATUS=0` optionally disables
  the upstream startup status query, but not responses caused by displayed
  content or unsolicited terminal input. Ink does not change this upstream
  policy or disable the query by default.
- The `/resume` picker's type-to-filter consumes committed text only — IME
  composition windows emit no keys mid-composition (kitty protocol), so CJK
  input filters once committed. A pasted block takes its first line.
