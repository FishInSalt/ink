# Codex Fast selection

Status: revised scope independently approved on 2026-11-10. The original design
passed two review rounds; after the user clarified that Fast must cover every
supported Codex model, a fresh adversarial reviewer approved the capability-based
revision. Child-dispatch decisions remain unchanged. **The terminal tier rejection
below is superseded** by [batch 1 completion compatibility](codex-fast-completion-design.md):
Fast requests priority, not priority-or-error. **The base-estimate-only pricing
rule below is superseded** by [batch 2 per-call reference pricing](codex-service-tier-pricing-design.md).
The original verification/review record below describes the earlier
implementation, not approval of batch 1 or batch 2.
Implementation completed and both independent code-review scopes approved.
Final verification: 4585 tests passed across 163 files; typecheck, lint and build
passed for that earlier implementation. Subscription Fast entitlement/billing
remains unverified; later experimental performance is workload/window-specific.

## Goal and scope

Offer two choices in `/model` for an eligible, account-listed subscription
model: `openai-codex/gpt-6.1-sol` and
`openai-codex/gpt-6.1-sol·fast`. The latter requests Fast processing without
changing the underlying model or the user's thinking level. The user agreed
that failures preserve the selection, surface an error, and never silently
retry normally or switch authentication/billing routes.

Every account-listed Codex model with positive Fast capability evidence gets
a Fast variant; Sol is only an example. No model-name pattern or Sol-specific
restriction. No global speed toggle, API-key Fast support, arbitrary tier values,
new provider, Ultrafast, account-wide preference, or startup precedence change.

## Evidence and limitation

Ink's subscription adapter uses `https://api.openai.com/v1/responses` with
subscription OAuth, not the legacy ChatGPT backend. Official references:

- https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
- https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
- https://developers.openai.com/api/docs/guides/fast-mode
- https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/protocol/src/config_types.rs#L539-L550

The public API documents both `service_tier:"fast"` and `"priority"` as
Fast. Official Codex maps its Fast configuration to wire value `priority`.
Use `priority` in Ink for the same explicit Fast request. Do not send a
boolean `fast`, or suffix the wire model ID.

On 2026-11-10, the user authorized one real subscription request. A minimal
`gpt-6.1-sol` request with `service_tier:"fast"`, `store:false`, and
`stream:true` returned HTTP 400. The probe did not retain a diagnostic that
identifies the reason. This does NOT establish that Fast is unavailable, nor
that it works with either spelling. A separately authorized follow-up experiment
completed 42 requests (2 warm-ups and 20 randomized formal pairs), 18,942 reported
tokens, all correct, no failures or exclusions. Paired character delivery improved
42.29% and total latency decreased 23.62%; all terminal tiers were `default`.
These are workload/window-specific observations, not proof of internal tier or
billing. No further real request is authorized by this design. Do not refresh
credentials or use real requests in tests.

Accordingly, the UI and documentation must describe a **Fast request**, not
verified entitlement or guaranteed acceleration. Account-list membership only
proves model listing. The variant is an opt-in request mode with unverified
subscription-tier availability; actual failures remain visible. Do not turn the
qualified performance experiment into an entitlement or acceleration guarantee,
or advertise a verified subscription cost multiplier.

## Capability evidence (revised scope)

Official Codex currently uses `models[].service_tiers`, an array of objects
with string `id`, `name`, and `description`. `id:"priority"` advertises Fast;
accept the API's equivalent `id:"fast"` too. Its deprecated compatibility
field is `additional_speed_tiers`, a string array where `"fast"` advertises
Fast. Modern and legacy evidence use OR, matching Codex's predicate.

Sources at revision `0d37c062de16c81caa1376e072ccd15cf3d68506`:

- https://github.com/openai/codex/blob/0d37c062de16c81caa1376e072ccd15cf3d68506/codex-rs/models-manager/models.json
- https://github.com/openai/codex/blob/0d37c062de16c81caa1376e072ccd15cf3d68506/codex-rs/protocol/src/openai_models.rs#L1122-L1149

Preserve validated Fast support (`true`, `false`, or missing/unknown) when the
existing authenticated `/v1/models` discovery returns these optional fields.
The public sign-in guide does not promise them. Store optional `fastModes`
metadata alongside ids in the existing account/endpoint/registration-scoped
cache, using the same expiry, atomic persistence, and invalidation. Reset hints
on each successful list refresh; do not merge stale hints into fresh omissions.
Only retain hints for listed slugs. Old caches without hints remain valid.
Explicit valid empty tier arrays mean no Fast; missing/malformed fields mean
unknown. Do not read `cost.tiers`, model names, or pi.dev membership as capability.

When account-specific capability is unknown, consult a small generated snapshot
of ALL official Codex entries and their Fast capability, pinned with source URL,
revision, and date in a pure module. This is generic model capability, not an
account entitlement check. Account-specific positive or negative evidence always
wins over the public snapshot. Models absent from both sources remain unknown,
not false. Account metadata can therefore enable future Fast-capable models
without a release. Updating the bundled snapshot covers servers omitting hints;
no new background network service or API endpoint is added.

Expose `codexFastModeSupport(modelId): boolean | undefined` from discovery for
the picker. This consults the current account snapshot then the bundled source.
It never adds a base model to availability. No Fast row is automatically derived
for an unsupported or unknown model; an explicit current selection is retained.

Capability is not a persistence-schema invariant: models may be newly added,
retired, or change capability after a session is saved. A separate pure
`canRequestFastMode(provider, modelId)` validates only that the provider is
`openai-codex` and the base ID is nonblank, contains no whitespace, and has no
selection suffix/middle dot. Selection parsing, sessions, launch records, and
transport use this structural check, never a mutable capability allowlist.
An explicit `...·fast` reference for an unknown/unsupported Codex model remains
an opt-in request; the server is authoritative and any rejection stays visible.
This preserves intentional/custom/resumed choices without inventing picker rows.

## Selection and identity

Add `ModelSpeed = "fast"` and optional `speed?: ModelSpeed` to the existing
request contract. Normal is represented by absence, not a second sticky
preference. All runtime request paths carry the optional speed explicitly;
only the Codex adapter converts it into `service_tier:"priority"`.

Keep `parseModelRef()` and `qualifiedReference()`'s established routing and
identity behavior unchanged. Add these shared helpers in provider/resolve.ts:

- `canRequestFastMode(provider, modelId)`: structural guard in a pure module,
  re-exported from resolve for callers; it does not claim capability/entitlement.
- `parseModelSelection(reference)`: returns the base provider/model pair and
  optional speed; recognizes an exact trailing `·fast`, strips it once, and
  validates with the structural guard before any selection write/provider swap.
  Existing ordinary references are unchanged.
- `formatModelSelection(reference, speed)`: appends the display suffix when
  speed is Fast, preserving the existing bare-Anthropic display convention.

`resolveModel()` uses selection parsing so construction resolves the base wire
ID. `Runner.model`, `Runner.modelReference()`, metadata keys, pricing identity,
vision/thinking lookup, usage anchors, and assistant provenance remain base-only.
Expose `Runner.modelSelectionReference()` and readonly optional `speed` for
selection/display consumers. Do not weaken exact-model replay validation.
Normal and Fast for the same model can replay the same compatible history.

The suffix also works in `/model <reference>`, `-m`, `INK_MODEL`, and
`settings.defaultModel`. An ordinary selection always clears previous Fast.
No new `/model normal` command or separate settings field is introduced.

## Picker and status

The picker derives a Fast row immediately after EVERY discovered Codex base
row for which `codexFastModeSupport(id)` is true.
Never inject a subscription model from public metadata, create variants for
unconfigured families, or override an authoritative empty account list.
Retain the current explicit selection as the leading row, as today. Deduplicate
rows, and inherit stale/unverified notices from the base account listing.

Use base metadata for both descriptions. The Fast description must include
`Fast requested; higher usage; availability unverified` (or equivalent clear
wording). The current selection in the footer, `/status`, model-switch notes,
and default-model hints includes `·fast`. Internal context/usage queries still
use the base reference. Automatic startup/login recommendations remain normal;
login must not replace a deliberate Fast choice.

## State and persistence

`Runner.prepareModel()` parses and validates; selection persistence succeeds
before `applyModel()` changes live provider/model/speed/thinking. A failed
selection or session write must not partially change any of them.

Extend `SessionModel` with optional `speed:"fast"`. Validate locally without
loading provider runtimes, using the structural subscription/base-ID check,
not current capability or account availability. Include speed in equality checks, seeds, append-only session-model rows,
and restoration. Normal omits the field. Saved model records without speed
mean normal; model-less legacy sessions keep existing startup precedence,
including explicit `-m ...·fast`. No rewrite or schema-version bump. Restoring
a saved normal selection clears previous Fast.
`/new` retains the current selection. Existing explicit `-m` versus restored
session precedence is unchanged.

Capture speed alongside provider/model/settings/session at run entry, before
`run_start`. It remains fixed across main-loop tool follow-ups and overflow
recovery. A selection change affects the next top-level run, not the active
main loop or its recovery summaries. Existing child dispatch is a deliberate
exception: newly dispatched children snapshot the live selection at dispatch.

## Children and summaries

Thread optional speed through loop options, compaction/summarizer options,
child-run options, and task spawn snapshots. Do not store it as mutable state
on a shared provider instance.

Child policy:

- Add optional `TaskToolOptions.getSpeed`; the real runner supplies it and
  legacy callers default to normal. Capture live speed synchronously with
  provider/model reference, before any asynchronous child setup. Do not mix
  top-level captured speed with live child provider/model.
- Successful child resolution returns `{binding, speed?}`; one resolved speed
  supplies launch persistence, child loop requests, and child compaction.
- No agent model override: inherit the spawn-time speed.
- Explicit plain model override: normal, even if it names the parent's base.
- Explicit Fast-suffixed override: parse on the parent provider, enforce the
  existing cross-provider restriction and structural check, and keep the child binding
  base-only. Bare child IDs still route to the parent's provider.
- Persist optional speed outside the base-only model binding in child launch
  records. Validate it; old launch records mean normal. Child continuation
  uses its recorded choice, not the current parent's choice.

Main/child auto-compaction, manual compaction, branch summaries, and overflow
summaries inherit the captured active speed. Existing thinking retry keeps
that speed unchanged. Summary prompts remain without session IDs or native
reasoning ciphertext. Existing base-model context/output-budget lookup rules
remain intact.

## Transport, errors, and billing

A normal request has no added tier field; Fast requests send the base model
with `service_tier:"priority"`. Thinking remains separately configured.
Reject an invalid speed value or structurally invalid request speed/model
pair before credentials or network. Do not use mutable capability hints to
rewrite or silently clear a deliberately selected Fast request.

All HTTP retries reuse the same Fast body. Tier-related failures never trigger
normal retries, model substitution, credential switching, or legacy-backend
fallback. Preserve the selection after an error. Child automatic/overflow
compaction must surface live Fast summary errors immediately as a failed child,
not hide them in the normal-mode three-failure tolerance path. Cancellation
retains its existing aborted/timeout classification. Include a concise actionable
Fast recovery hint directing users to choose the normal model explicitly,
while retaining upstream diagnostics without leaking credentials.

**Superseded gate:** the original design rejected `default`, `standard`, or `flex`
on both accepted terminal paths (`response.completed` and output-token-limit
`response.incomplete`). Batch 1 removes only that rejection: valid responses
complete normally, and the existing summary thinking retry remains available.
Actual stream/terminal/replay errors and incomplete/invalid tool safety remain
unchanged. HTTP 200 is not by itself successful completion. Request `priority`
without fallback; retain bounded terminal observations unchanged as
`AssistantMessage.serviceTier`, with `requested:"omitted"|"priority"` and optional
`reported`. No reported value proves internal processing or charges. `/status`
may show only the LAST matching base-model assistant observation, with no older
substitution and no per-turn warning. See the approved batch 1 design for exact
parser and display rules. Do not infer processing tier from latency or cached tokens.

**Superseded pricing rule:** this design originally kept catalog estimates at
base-model rates without a Fast multiplier. The approved
[batch 2 reference-pricing design](codex-service-tier-pricing-design.md) instead
uses per-call observations with rules pinned to
[Pi revision 2cac4f1a9](https://github.com/earendil-works/pi/blob/2cac4f1a934cdc4a80b05a7d8ff2543cf5ee623c/packages/ai/src/api/openai-codex-responses.ts#L623-L660).
For `openai-codex` only, priority (including reported `fast`) multiplies the four
monetary rate components by 2.5 for the exact base ID `gpt-5.5`, otherwise 2 as a
Pi-compatible assumption; flex uses 0.5. Reported `default` or missing uses that
call's captured request only for estimation; the raw report is never rewritten.
Unknown tiers or missing/invalid legacy observations keep base-only estimates
with incomplete-pricing marker `~`; `!` still indicates missing usage. Unknown
catalog rates stay unpriced. Raw token counters are never multiplied, and mixed
modes, history/reopen, children and summary retries retain original per-call
attribution. Accounting-only receipts preserve already-reported usage from
rejected parent summaries, never their rejected text or context; never-started
work gets no invented charge and unreported work remains unknown. Old files
remain readable, but the new receipt kind may not work with older binaries.
These are current-catalog reference estimates, not actual subscription charges,
allowance units or processing-tier confirmation. No unknown/future-model rate,
entitlement or billing multiplier is verified. All model, capability, identity,
selection, request and batch 1 completion/error behavior remains unchanged.

## Verification and rollout

Use only mocks/injected fetch and hermetic temp directories for automated tests.
Cover at least:

1. Selection parse/format across multiple Codex model generations and future
   IDs, invalid provider/structure and ordinary routing compatibility; no suffix
   on wire/catalog/provenance keys. Discovery hint sanitization, round trips,
   account scoping, refresh invalidation, positive/negative precedence over the
   bundled snapshot, legacy fields, malformed/missing hints, and old caches.
   Multiple supported models get rows; negative/unknown models do not.
2. Picker ordering/deduplication, normal plus Fast, empty/offline/unconfigured
   accounts, clear cost/availability wording, and visible selected suffix.
3. Normal/Fast request body, unchanged thinking, same-tier retries, meaningful
   rejection, and no fallback request. The original downgrade-rejection cases on
   completed and incomplete paths are superseded by batch 1 acceptance/observation
   tests, while actual failures and tool safety remain covered.
4. Session and default/CLI selection round trips, old-session normal, speed-only
   changes, normal clearing, and failed-persistence atomicity.
5. Run-entry and child-spawn snapshots, override rules, child continuation,
   all compaction paths and unchanged speed on summarizer thinking retry.
6. Base context/vision/replay/usage identities stay equal for normal and Fast.

Update the user-facing providers, sessions, CLI/settings, and subagent docs in
the same batch, including the live-verification limitation. Run typecheck,
lint, build, and the full test suite. Obtain an independent code review before
completion. Leave work on the dedicated feature branch unless integrating by
an explicit no-fast-forward merge; no publish/global install is included.

## Implementation review record — 2026-11-10

Two fresh-context adversarial code reviewers covered separate scopes:

- Discovery/cache/capability/picker/transport/documentation: approved; reviewer
  independently ran 367 hermetic tests across 8 files.
- Runner/session/child/compaction/replay: approved after fixing child summary
  error propagation. Automatic compaction originally hid Fast failures in the
  normal three-failure tolerance path. The first fix exposed a second case:
  summary-origin context overflow was mistaken for task overflow. Preserve
  summary-error origin and fail the child before that classifier. Twelve
  regression cases originally covered stored/in-memory, automatic/overflow, and
  downgrade, unsupported-parameter, and context-overflow errors. Batch 1 replaces
  the locally synthesized downgrade error fixture with an actual upstream
  tier-unavailable error; a mistaken second summary
  would succeed, proving the original failure cannot be hidden by recovery.
  Normal-mode tolerance and abort/timeout behavior remain covered.

Final parent verification, with the repository's nonlocal-network blocker:

- `npm run build`: passed.
- `npm run typecheck`: passed (source and test configurations).
- `npm run lint`: passed, including 11 user-facing docs in both languages.
- `npm test -- --reporter=dot`: 4585 tests passed across 163 files.
- `git diff --check`: passed.
- `node bin/ink.js --version`: `Ink 0.5.1` (unreleased feature; no version bump).

No additional real inference requests, credential refreshes, API-key fallback,
publishing, or global installation were performed during implementation/tests.
