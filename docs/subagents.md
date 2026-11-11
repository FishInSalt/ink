# Subagents

Read this when you delegate work with the `task` tool, define named agent
profiles, or need worktree isolation.

## The task tool

`task` delegates a self-contained job to a fresh subagent with its own
context window: exploration bloat stays out of the main conversation, and
the subagent's final message comes back as the tool result (with a usage
trailer; oversized results are tail-truncated to 50KB).

Children run in-process with the parent's tools (minus `task` itself) and
the parent's working directory, uncapped — budget decisions stay with the
parent. Several `task` calls in one turn run concurrently (waves of up to
5); results keep a deterministic, call-ordered place in the conversation,
and on screen each call owns its own entry: a live overview under its own
`● task` header while running, its result landing under that header the
moment it settles, with its own duration.

A new child captures the live provider, model, and requested speed together at
dispatch, before asynchronous setup. This deliberately differs from the main
loop's run-entry snapshot: changing the selection during a run can affect a
newly dispatched child without changing the active main-loop requests. Once
started, the child keeps its own resolved speed through tool follow-ups,
auto-compaction and overflow summaries, including summarizer thinking retries.
In Fast mode, a failed summary is reported immediately as a child failure; the
child does not silently continue uncompressed or retry at later tool boundaries.
Normal mode retains its existing summarizer-failure tolerance. A valid Codex
summary or child answer is not a failure solely because its terminal tier differs
from the requested priority tier; actual failures and incomplete-tool safety are
unchanged. Child assistant observations persist separately from the base binding
and do not enter replay or summary prompts; see [providers.md](providers.md).

A task's parent session is captured by the run that issues it. Switching the
active conversation with `/new` or `/resume`, even during a summary, does not
move that run's task records or child parent links to the replacement session.
Continuing a child also resolves ownership against the issuing run's parent.
This does not freeze the live provider/model/speed or inherited thinking used
when a new child is dispatched. Without a captured parent store, the task has no
persisted child transcript, even if a saved session later becomes active.

Results contain only the last nonempty assistant text accepted during the
current attempt, for both fresh and continued children. Compaction and overflow
recovery cannot substitute a previous attempt's answer or a summary. A continued
attempt that completes without text reports no output; one that fails before
producing text is a tool error. On a crash, genuine partial text from the current
attempt remains available with its failure diagnostic, even after compaction
removes it from the replay context. Abort and timeout still return an error and
handoff information rather than inline partial text. Streamed text without an
accepted final message is not a saved partial result.

## Loop health

A shared loop-health monitor (same signals for the main loop and children)
reports degenerate patterns — repeated identical tool calls, repeated failed
edits — as honest task-result lines, a task-record field, and one dim REPL
note per signal (`INK_HEALTH=0` disables it). It never injects anything into
a child.

## Persistence and timing

- Every child transcript is persisted as a session file in a `children/`
  directory next to the parent's (`INK_CHILD_SESSIONS=0` opts out).
- Child launch records save optional Fast speed separately from the base model
  binding. Continuing a child uses its recorded speed, not the parent's current
  choice. Old records without speed mean normal.
- Wall-clock: no clock in the REPL (Ctrl+C is the backstop); a 60-minute
  hang guard in print/headless runs. A call's `timeoutMs` or an agent
  file's `timeout:` (seconds) always wins.

## Usage accounting

Child task records carry captured raw usage and optional per-call pricing
observations, including the child's own summary calls and retry hops. Fresh and
continued children preserve that attribution even when a task fails or transcript
persistence is disabled. The parent's current selection, the child's final tier
report, and a later resume do not relabel earlier calls. Normal/Fast mixtures are
estimated per call against the producing base model's current catalog rates;
raw token counters are never multiplied. These are reference estimates, not
actual subscription charges or allowance measurements.

The parent accounts for a child's summary usage through its task record only,
not by scanning child transcripts or adding parent summary receipts. Repeated
records for the same attempt are not counted again, and internal reports do not
turn one contributing task record into multiple child-call counts. A child that
never starts contributes no invented charge; started work without a usage report
remains unknown, not zero. `!` still marks missing usage. When rates are known,
legacy/unknown-tier Codex usage keeps base-only reference pricing with `~` for
incomplete pricing;
see [Codex reference pricing](providers.md#codex-reference-pricing) and
[sessions.md](sessions.md).

The loop snapshots each task record's identity, binding, raw usage and pricing
observations before exposing its result to `tool_settled` or `tool_end` observers.
An observer can still change its own record, but neither immediate edits nor
later edits through retained references change authoritative history or session
accounting. Missing, invalid and future-version records stay unknown; malformed
pricing alone does not discard valid raw usage. This does not make tool content
immutable or turn event observation into an accounting rewrite hook, and is not
a security boundary against host code editing history or store entries directly.

## Named agents

Agent profiles are markdown files with hand-parsed frontmatter — no YAML
dependency, no builtins. Locations: `<project>/.ink/agents/` (behind the
trust gate) and `~/.ink/agents/`; the project directory wins on name
collisions. Agent files load at startup — new files need a restart, like
extension changes.

```
.ink/agents/scout.md
---
name: scout
description: Explores a codebase to answer research questions
tools: read, grep, find     # optional subset of the parent pool
model: glm-5.3              # optional: same-provider override only
timeout: 300                # optional wall clock, seconds
thinking: high              # optional: off|minimal|low|medium|high|xhigh|max
worktree: true              # optional: run on an isolated git worktree
---

You are a code scout. Go broad before deep.
```

- `model:` overrides which model that agent's children run — on the
  **current provider only**: a bare id, or a `provider/id` prefix naming
  the same provider (the prefix is stripped). A cross-provider reference is
  rejected before the child starts, with an error that names the
  workaround. Omit to inherit the session's model **and speed at dispatch**;
  a blank `model:` is a configuration error (rejected the same way).
  An explicit plain override selects normal processing, even if it names the
  parent's base model. On `openai-codex`, an explicit `·fast` override such as
  `model: gpt-6.1-terra·fast` requests Fast; bare IDs still use the parent's
  provider. The same-provider restriction remains, and no API-key Fast mode is
  added. A valid explicit Fast request can still be rejected by the server;
  there is no silent normal-speed fallback.
- `thinking:` sets the level for that agent's children. Omit to inherit the
  session's current level at spawn; a blank value is a configuration error
  (the file is skipped with a startup warning). The level is clamped to
  what the child's model supports. Thinking and Fast speed are independent;
  requesting Fast does not lower the thinking level.
- Registered agents are advertised to the model in the system prompt's
  `<advertised_agents>` block; `task(agent: "scout", prompt: …)` runs one.

A ready-to-copy example lives in `examples/agents/scout.md` (a read-only
code scout: `tools: read, grep, find`).

## Worktree isolation

A `task` call may set `worktree: true` (or an agent file may declare
`worktree:`): the child runs on its own git worktree — a separate checkout
of the committed state under the system temp dir — with the builtin tools
rebuilt at that path, so it physically cannot touch the parent's files. The
child prompt is told to translate paths and to commit its work; the result
names the branch and change summary, and the parent merges with
`git merge --no-ff <branch>` after review. A worktree with no changes is
removed (branch and all); preserved work is never discarded. `/worktrees`
lists worktrees kept for a manual merge.

Extension tools are excluded from worktree children (their registered cwd
cannot move). Isolation is by default working directory — a child's `bash`
could still reference absolute paths outside it.

## Concurrency boundary

Concurrent subagents share the parent's working directory. `edit`/`write`
mutations to the same file serialize through a process-wide file lock, and
a failed `oldText` match degrades into a teaching error (re-read, retry) —
but `bash` mutations bypass the lock entirely, and a whole-file `write`
silently clobbers an earlier one. So: delegate independent subtasks in
parallel; same-file modifications sequentially (the task tool description
tells the model the same). Read-only agent profiles (`tools:` without
edit/write/bash) make that structural — and `worktree: true` removes the
shared surface entirely.
