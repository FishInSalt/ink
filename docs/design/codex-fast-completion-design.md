# Codex Fast completion compatibility (batch 1)

Status: design independently approved in session
`b0714b42-cea8-48ce-a8c5-24ecccdc0ae8`; implementation independently approved in
session `2361ea2c-6531-4d8f-a50a-1c1ee4d188c6`. Verification: 4,717 tests across
165 files; build, source/test typecheck, lint and diff checks passed. The reviewer
independently ran 620 targeted tests across 8 files.
Branch/worktree: `fix/codex-fast-completion`, `.worktrees/ink-fast-completion`.

## Decision and evidence

Fast is a request for priority processing, not a priority-or-error guarantee.
Do not turn a valid terminal response into an API failure solely because its
reported service_tier differs from the requested one. This explicitly supersedes
the terminal downgrade rejection in codex-fast-mode-design.md. Structural request
validation, model identity, supported-model discovery, thinking and selection
persistence remain unchanged for all supported Codex models.

Evidence:

- Pi issue https://github.com/earendil-works/pi/issues/3188 describes faster priority
  requests despite default response metadata. PR https://github.com/earendil-works/pi/pull/3307
  explains its requested-tier fallback for local cost estimation, not attestation.
- https://github.com/openai/codex/issues/14204#issuecomment-4033184620 says the final
  service_tier is not reliable end-to-end confirmation in ChatGPT-authenticated
  Codex mode. This is not an explicit amendment to the SIWC public-route schema.
- Official Codex at fe8e540a80f17716bf2a3007f06e8a602192c704 does not include
  service_tier in its SSE ResponseCompleted completion structure.
- https://developers.openai.com/api/docs/guides/fast-mode permits some standard
  fallbacks even for the ordinary API; a priority request is not unconditional.
- The authorized follow-up experiment completed 42 requests (2 warm-ups + 20
  randomized formal pairs), 18,942 reported tokens, all correct, with no failures
  or exclusions. All terminal tiers were default; paired character delivery was
  +42.29% and total latency -23.62%. This is workload/window-specific performance,
  not internal-tier or billing confirmation. Raw artifacts are runtime-only at
  /tmp/ink-fast-rigorous.Xsv9E7; no new live requests belong to this change.

## Completion and errors

Remove the service_tier_downgrade gate from both existing accepted terminal paths:
response.completed and the already-supported max_output_tokens incomplete path.
Retain every other check: failed/cancelled/error events, unsupported incomplete
reasons, terminal status, terminal error, missing terminal, replay and output/tool
reconciliation. Never execute incomplete/invalid tool batches. Do not reinterpret
HTTP 200 alone as success.

Always send priority when speed=fast. Do not issue a normal fallback, alter speed,
model, thinking, credentials, endpoint or billing route. Existing same-body
pre-stream retry policy is untouched. No new strict Fast mode or global toggle.

Use HTTP error wording/status suffixes only for non-success HTTP statuses. A
stream/local error received over HTTP 200 remains a typed error with its status
available diagnostically, but its user-facing text must not claim API error 200.
Preserve upstream codes, redaction, bounded diagnostics and retry classification.

## Request/response observations

Add optional AssistantMessage.serviceTier with a pure shared ServiceTierReport:

    { requested: "omitted" | "priority", reported?: string }

The explicit omitted sentinel distinguishes a newly observed ordinary request
from a legacy message without metadata; it does not assert actual standard
processing. Only the Codex adapter emits it, on a valid message_end. Reported tier
is the terminal value, never created-event metadata or a requested-tier rewrite.
Accept bounded diagnostic-token strings (1..160 ASCII letters/digits, underscore,
period, brackets and hyphen); ignore malformed values. No raw payload/credentials.
A pure parser copies only validated fields and can be reused by status and later
pricing. Metadata never enters provider wire input, replay identity, model IDs,
context estimates, capability discovery or token arithmetic.

The existing message persistence/loop spreads retain this additive metadata;
legacy messages remain valid and session files are not rewritten. Batch 2 will
carry these observations into per-call pricing subdivisions; batch 1 does not
change prices or introduce incomplete aggregate pricing metadata.

/status can show the last matching base-reference assistant response's requested
and reported tiers, explicitly labelled LAST response, not confirmation of the
current selection. Examine only the most recent assistant for the current exact
modelReference; if it has no valid observation, do not reuse an older observation.
Do not display another model/provider's observation. An explicit requested=omitted
is shown as omitted, missing reported as unreported. Parser validation prevents
persisted control characters from reaching terminal output. No per-turn warning.

## Documentation and verification

Update the existing Fast design to mark the hard gate superseded, plus the
English/Chinese providers pages and CHANGELOG in this same batch. Explain request
versus report, normal successful completion and unchanged actual-error behavior.
Correct the stale live-probe-only wording with the qualified experiment result;
retain the lack of entitlement/billing guarantee. Other matching pages change only
where their statements are affected. Pricing documentation stays base-estimate
until batch 2.

Tests use injected transports and hermetic directories only. Cover completed and
allowed-incomplete terminals with priority/default/standard/flex/fast/unknown/
missing/malformed tiers, normal versus Fast observations, valid tools persisted
and executed, invalid tools/failed/truncated streams still refused, no fallback or
repeated request, base-only replay, summary/child compatibility, status scoping,
legacy/malformed observations and 2xx diagnostic formatting. Existing Fast errors
in children/summaries remain real failures. Run full tests, typecheck, lint, build,
diff checks, then independent implementation review before declaring batch done.
No real requests, auth refreshes, global install, publication or push.
