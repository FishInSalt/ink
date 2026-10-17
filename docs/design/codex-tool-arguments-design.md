# Codex tool argument reconciliation

Status: implemented; independent design and implementation reviews approved.
Branch: `fix/codex-tool-arguments`.
Base: `d6b8bf454e12dd5d5884e31de43fae922650707a` (Ink 0.4.1).

## 1. Evidence and scope

Session `3e4b4d4c` used `openai-codex/gpt-6.1-sol`. Its first two
single-tool responses had nonempty arguments; a later four-tool response
had `{}` for every call. Provider-level logging already contained `{}`.
Raw SSE was not recorded, so the historical trigger is unproven.

The confirmed defect is in `src/provider/codex-responses.ts`: only argument
`.delta` events enter the buffer. Initial `item.arguments`,
`function_call_arguments.done.arguments`, and final
`output_item.done.item.arguments` are ignored. Offline streams reproduce
nonempty arguments becoming `{}`. Correctly indexed interleaved deltas
already work. The installed and source-checkout adapter builds matched
at diagnosis time.

Fix this adapter and its wire-level tests. Document its user-visible
failure behavior in `docs/providers.md`. Do not change other providers,
transport framing, tool schemas, parallel scheduling, auth, usage
normalization, or global installations. No paid API calls or raw stream
logging are required. Do not claim this proves the original model response
contained nonempty arguments.

## 2. State and identity

Maintain output slots keyed by a nonnegative integer `output_index`.
A tool slot owns its block, raw argument buffer, optional wire item ID,
index, and argument/item completion flags. Index 0 is valid. Text slots
retain existing text behavior; reasoning remains ignored. Final assistant
blocks are sorted by ascending output index, regardless of discovery or
completion order, so done-only creation cannot reverse tool execution.
Streaming events remain in arrival order.

- Creating a function slot requires an index, nonempty string `call_id`,
  and nonempty string `name`; `item.id` is optional for compatibility with
  current fixtures. Do not invent executable call IDs or tool names.
- Track tool item IDs separately for routing argument events with no
  `output_index`. A missing index is recoverable only when a supplied
  `item_id` uniquely identifies an existing tool slot.
- A supplied index must be a nonnegative integer. If both index and item ID
  are present, they must identify the same slot. A valid index may bind a
  previously absent wire item ID when the supplied ID is a nonempty string
  and is unclaimed; this is not a mismatch. Once bound, an ID cannot change.
  An unknown index is not silently overridden by a known item ID. Reject
  mismatches, unknown argument targets, duplicate slot additions, and
  duplicate call/item IDs. Index-less routing always requires an already
  bound item ID.
- When a final item supplies ID, call ID, or name, verify it against the
  existing slot. A final item may bind a previously absent, unclaimed ID
  under the same rules. Omitted final metadata preserves existing values.
- `output_item.done` can create a tool slot if `output_item.added` was
  absent, but only with a valid index and full creation identity. Emit one
  `tool_call_start`, not a second block for an existing call.
- Do not coerce strings to indices or place multiple calls in a `-1` slot.
  Reject a recognized tool event that collides with a text slot.

Protocol errors must identify the event/index without including raw
arguments, credentials, or a full response body. Catch JSON parse failures
and replace the native parser message with a fixed diagnostic; native
parser messages can contain raw-input excerpts.

## 3. Argument sources and stream events

Use source order within a correctly ordered Responses stream:

1. Seed from string-valued `output_item.added.item.arguments`, if present.
2. Append each string argument delta to that slot only.
3. Replace the raw buffer with a nonblank string snapshot from
   `function_call_arguments.done.arguments`.
4. Replace with a nonblank final `output_item.done.item.arguments` snapshot.

A missing or blank snapshot does not erase a known nonblank buffer. A
present argument field of a non-string type is a protocol error; an
arguments-done event must carry a string field. A genuine `"{}"` remains a
valid empty object. No data is not equivalent to `"{}"` on a completed call.
Do not append a full snapshot to already accumulated deltas.

Initial arguments and snapshot suffixes should produce `tool_call_delta`
events when they extend the prior buffer. If a snapshot corrects rather
than extends it, replace the final buffer without inventing an append-only
reset event: `message_end` is authoritative, and the existing event
interface has no reset. Existing delta-only streams keep their events.

After arguments-done or item-done, reject further argument deltas. Reject
repeated arguments-done/item-done events rather than accepting conflicting
snapshots. A final item may still replace an earlier arguments-done value.

`response.completed.response.output` is not another assembly path in this
fix: normal tool finalization is `output_item.done`. Creating or guessing
slots from a terminal output array adds identity/order ambiguity and is
outside this batch. Text snapshot repair and reasoning are also excluded.

## 4. Completion and failure safety

Keep the existing requirement for a terminal response event and silent
abort behavior. On a successful completed response, every tool slot must:

- have received `output_item.done`;
- contain nonblank argument text;
- parse as JSON (the loop still owns object/schema validation).

Otherwise throw a descriptive Codex protocol error before `message_end`;
no tools from that response are dispatched. Do not turn unknown or
unfinished arguments into executable `{}`. This uses existing provider
error semantics, including the current limitation that usage on a rejected
response is not emitted as a successful `message_end`. It does not add an
automatic retry or execute earlier valid calls from an invalid batch.

For `response.incomplete` / status `incomplete`, preserve `max_tokens`,
usage, and any partial blocks even when a tool has not closed or its raw
arguments are incomplete. Retain `safeParseJson` for this non-executable
partial representation. The existing loop rejects the entire truncated
batch; test this end to end. This avoids replacing the existing truncation
recovery behavior with a protocol exception. Routing/identity violations
still fail rather than guessing, including on incomplete streams.

Explicit valid `{}` is passed through unchanged. A required-field schema
can still reject it; do not fabricate paths, patterns, or commands. On
completed streams malformed JSON is a provider error, not a synthetic
`_parseError` object that an optional-argument tool could accept.

## 5. Test plan

Use the existing localhost HTTP/SSE harness with fake auth. First add
regressions and record failures on the baseline, then implement.

- Initial arguments + final item without an argument field.
- Arguments-done snapshot + final item without an argument field.
- Final-item-only snapshot; final-item-only slot creation. A lower-index
  done-only call discovered after a higher-index call must retain final
  block order and serial execution order by index.
- Partial deltas repaired by either done snapshot; precedence of the final
  item; complete snapshots do not duplicate streamed JSON.
- Four interleaved calls with text/reasoning, nonzero/noncontiguous indices,
  repeated tool names, different argument-source combinations, and Unicode.
- Index-less deltas/done snapshots routed by item ID; reject inconsistent
  IDs, invalid/missing/unknown indices, duplicate indices/call IDs/item IDs,
  text collisions, conflicting final metadata, late/duplicate events, and
  non-string argument fields. A previously absent item ID can be bound by
  an indexed argument event or final item; subsequent conflicts still fail.
- Explicit `{}`, primitives/arrays (left to schema validation), malformed
  completed JSON, no argument data, and missing tool finalization.
- Existing text, request shape, usage, replay, error, and abort tests.
- Incomplete response with unclosed tools keeps `max_tokens` and usage;
  loop integration proves no tools execute. Abort during a tool stream
  emits no final message and does not execute tools.
- Local loop integration with required `path`/`pattern` schemas proves
  snapshot arguments reach tool execution and tool-result replay intact.

Run targeted tests, typecheck, lint, build, and the full offline suite.
An independent adversarial implementation review must close before the
work is reported complete. Worktree-local dependencies/build/cache avoid
concurrent writes to the original checkout.

## 6. Review record

Round 1 (independent adversarial reviewer): not approved; two findings.

- High: done-only slot creation could reverse final/tool execution order.
  Resolved in section 2 and tests: final blocks sort by output index.
- Medium: optional item ID needed a first-binding rule rather than treating
  unknown identity as conflicting. Resolved in section 2 and tests.
- Also made JSON error redaction explicit to avoid native parser excerpts.

Round 2: APPROVE; both findings closed. Design review completed before
implementation.

Implementation review round 1: one P2 finding. A consumer aborting at
`tool_call_start` could still advance the same item's suspended generator,
emitting a snapshot delta or throwing on a deferred non-string snapshot.
Resolved by `untilAborted`, which checks before advancing the assembler
again after every emitted event, plus a post-dispatch stream abort check.
Eight new provider/loop regressions first produced 6 failures and 2 passes,
then all passed after the fix.

Implementation review round 2: APPROVE; cancellation finding closed, no
remaining actionable findings. Reviewer independently reran 341 targeted
tests and eight additional in-memory cancellation cases.

## 7. Verification

- Baseline existing adapter tests: 15 passed.
- New regression file before source changes: 318 tests, 278 failed and
  40 passed. The independent test author recorded the baseline failures.
- Final targeted adapter tests: 2 files, 341 passed (326 new, 15 existing).
- Final full offline suite: 147 files, 3428 tests passed.
- `npm run typecheck`, `npm run lint`, `npm run build`, and
  `git diff --check` passed. Lint checked 271 files.
- Fake-auth localhost SSE and in-memory streams only; no live model API
  reproduction, credential reads, global installation changes, or merge to
  the other session's checkout. This verifies the confirmed parser defect,
  not the unknown original upstream payload.
