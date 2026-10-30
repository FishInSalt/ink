# Direct ChatGPT subscription access

Status: implemented, independently reviewed, offline verification complete;
user acceptance confirmed on feat/chatgpt-direct-subscription (not merged).
Follow-up scope cleanup implemented and independently reviewed on
feat/chatgpt-direct-subscription-cleanup; offline verification complete (not merged).

Metadata-source update (2026-10-30):
[codex-catalog-source-fix.md](codex-catalog-source-fix.md) supersedes this record's
choice of ordinary OpenAI public metadata. Subscription metadata now uses the
public `openai-codex` catalog with a new cache-source marker. OAuth, account
availability and public Responses transport remain unchanged.

## Goal and boundaries

Replace the sole `openai-codex` subscription implementation with OpenAI's
Sign in with ChatGPT (SIWC) public Responses API. Keep `ink login`, `/login`,
`ink logout`, provider ID `openai-codex`, model references and JSONL version 1.
There is no legacy device flow, token conversion, dual transport, fallback to
API-key billing, migration prompt or automatic credential migration. Existing
users run `ink login` once. Ordinary `openai` API-key Chat Completions is unchanged.
The pi checkout is a behavioral reference, not code to copy indiscriminately.
Explicit/configured/session subscription selections never auto-fallback to another
provider when credentials are absent. Adjust the runner's restored-model fallback
accordingly. Retain the current explicit model on login; select a discovered model
only for an unselected/builtin startup, never merely because credentials are absent.

Normative references (checked 2026-10-29):
- https://developers.openai.com/siwc/token-sharing-open-source/sign-in
- https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
- https://developers.openai.com/siwc/token-sharing-open-source/token-reference
- https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
- https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations

## Authentication and protected storage

Use a maintained JOSE library (`jose`, exact dependency) for ID-token signature,
issuer, audience, expiry and nonce validation, not a hand-written JWT verifier.
Use `proper-lockfile` (exact dependency, types exact) for the shared auth-store
read/modify/write lock. No global installation or dependency lifecycle scripts.

All credential writes, including API keys and logout, share an asynchronous
file lock and atomic owner-only temp-file/rename update. Lock timeout 30s,
refresh timeout 15s, bounded network/body reads. Never proceed unlocked.
Reads are synchronous snapshots for availability checks. Corrupt stores fail
writes rather than erase unrelated credentials; missing stores are empty.
Remove old flat-Codex read compatibility. Old sectioned tokens do not satisfy
new credential validation; API keys beside them remain preserved.

Keep `codex` as the one subscription section, with a new explicit `type:
"chatgpt-oauth"` discriminator. Store issued clientId, validated issuer/subject,
ID token, scopes, accessToken, refreshToken, expiresAt, and optional earliest
refresh time. No accountId claim is required. Preserve registration identity
when clearing unusable tokens or logging out, so reauthorization uses the issued
client ID. Store a stable random UUID host ID independently of tokens in the
same protected store; never derive it from personal or hardware data.
One active subscription registration is supported; no multi-account UI.

First authorization uses `dynamic_agent_client`, `agent_name_hint=Ink`, stable
`ext_agent_host_id=urn:uuid:...`, full identity/direct-use scopes, resource
`https://api.openai.com/v1`, fresh state/nonce and S256 PKCE. Subsequent login
uses the saved issued client ID and optional ID-token hint. A mismatching
returned client ID or verified subject/issuer fails without replacing tokens.
An explicit different-account facility is outside scope; a clear diagnostic
explains when the saved registration cannot be used for that account.
Eligibility is decided only from the token response's granted scopes. A validated
identity without chatgpt.tokens.use.direct retains registration but no usable
inference credentials; /login explicitly requests consent again with full scopes
and prompt=consent (not undeployed force_reconsent). Do not discover models or
infer with a disabled grant. First-registration code-exchange invalid_grant retains
the issued registration and requests a new authorization; never loop dynamic
registration. Invalid refresh grants clear unusable tokens only; invalid_client
reports configuration failure and does not erase credentials.

Listen only on 127.0.0.1; prefer port 1455 and fall back to an ephemeral port
if occupied. The exact selected redirect URI is shared by authorization and
exchange. Validate callback path, state (also for error callbacks), singular
query parameters and issued client ID. Allow pasted complete callback URLs only
when origin/path match. Ignore foreign-state HTTP callbacks rather than failing
the active login. Close listener and spare sockets on success/cancel/timeout.
Overall login timeout 10 minutes, fetch timeout 15s. No token/code/body in errors.
Production OIDC issuer/endpoints are pinned to https://auth.openai.com; discovery
must return the expected issuer and same-origin HTTPS JWKS/revocation URLs. All
credential-bearing fetches reject redirects, including inference/discovery. Reject
URL credentials/fragments in subscription base overrides and require HTTPS;
loopback HTTP is possible only through explicit injected test seams. Remove the
production INK_CODEX_AUTH_BASE override; context/test options remain injectable.

Expose `onAuth({url})` and optional scoped, cancellable manual-URL interaction.
URL display is always available; browser opening is best-effort and belongs in
the UI layer. Never log a URL containing id_token_hint; display/open a no-hint
URL when necessary or omit hints in UI-based login. Submitted callback URLs are
not echoed, logged or retained in history. Automatic callback cancels the manual
prompt. CLI signal listeners and readline resources always detach. REPL dialog
Esc/Ctrl+C uses existing cancellation behavior. Readline fallback may rely on
browser callback alone rather than create a second competing input reader.
Tests inject endpoints/fetch/callback port/browser opener; no production secrets.

Refresh inside the shared lock, re-read and recheck token/registration, use the
issued client ID and resource with the rotating refresh token. Once started,
caller cancellation returns promptly but does not cancel refresh/persistence;
15s timeout bounds it. Persist replacement credentials before releasing lock.
Refresh near expiry (5 min), respecting earliest_refresh_at when supplied and
never use an expired access token. Temporary network/5xx failures retain tokens;
terminal refresh grant errors clear only unusable tokens, retain registration,
and request login. Logout holds the shared lock across re-read, bounded OIDC
discovery/revocation and local clearing, so no refresh can race revocation of the
latest token. Revocation retries temporary failures once with bounded backoff;
local clearing completes even if cancelled or remote revocation fails, reporting
unconfirmed remote revocation without secrets. Never hold a lock across browser waiting;
login persists only if its starting credential snapshot is still current.

## Request contract and model discovery

Use POST https://api.openai.com/v1/responses with Bearer OAuth; no Codex account
header, originator or legacy beta headers. Keep existing optional
OPENAI_CODEX_BASE_URL as the subscription endpoint override, default ending in
/v1; test injection follows the same base. Authentication defaults remain fixed
at auth.openai.com; test-only injection is not a project-controlled endpoint.

Send store:false, stream:true, instructions, full input, reasoning effort,
reasoning.summary:"auto" when effort is enabled, include:["reasoning.encrypted_content"],
prompt_cache_key. Retain the existing
SHA-256 conversation key; send it as HTTP headers session_id and x-client-request-id, never
raw session IDs. No previous_response_id, temperature, max_output_tokens,
configuration_update or explicit cache-retention fields. Use additional_tools
input item with role:"developer" before the conversation for Ink's ordinary
functions (no hosted tool_search); no
new grammar/custom-tool or dynamic-tool-management feature.

Discover GET /v1/models with the same refreshed OAuth credential, filtering the
models array to visibility:list and using slug in server order. Cache per
endpoint and registration/host identity (not access token), invalidated across
registration/login changes. An empty successful list is authoritative. Never
advertise pi's legacy Codex model list as account availability. Metadata can be
sourced from pi.dev/openai under Ink's stable openai-codex identity, with an
explicit new cache schema/source boundary so old Codex metadata is not loaded.
Offline fallback is labeled metadata/unverified availability, not an entitlement
claim. Keep explicitly selected/session model IDs; backend rejection stays
visible, no silent model substitution. New login may choose the first listed
model only for a truly unselected/builtin model (track intent separately from
credential availability). Standalone login prints the first server-listed model
as a suggestion; unselected startup may use that account-scoped discovery cache.
Empty/offline account catalogs leave startup unresolved with /model guidance,
never select a hardcoded legacy Codex recommendation. No inference for login validation.

## Responses stream and canonical history

Keep Ink's canonical text/toolCall/thinking blocks and strict tool argument
validation. Add optional provider-scoped replay metadata to blocks, and optional
assistant provenance `{version:1, provider:"openai-codex", model}`. Text metadata
holds item ID, phase, contentIndex and kind (output_text or refusal). One block
per part retains order; adjacent parts sharing an item ID reassemble into one
message. Indices must be contiguous and IDs cannot reoccur after another item.
Tool metadata holds item ID/namespace; thinking metadata holds item ID, exact
summary/content parts and encrypted_content. Encrypted-only reasoning uses an
empty canonical thinking block. Only final output_item.done or reconciled terminal
reasoning snapshots supply replayable ciphertext; never retain added-event
provisional ciphertext. Reasoning support means exposed summaries/content events
and opaque ciphertext, not unavailable internal reasoning. Do not store
an entire raw response or duplicate raw tool arguments. Do not use Anthropic's
`thinking.signature` for Responses metadata. Ordinary blocks remain the display,
execution and summary representation; only this provider reads replay metadata.

Native fields replay only for matching version/provider/exact model. Different
models/providers and old sessions use canonical blocks without native IDs or
ciphertext. Preserve block/item order (do not group all text before calls).
Validate metadata from session input at the provider boundary and construct
wire fields explicitly. Native metadata cannot add calls or override canonical
names/arguments. Unknown metadata versions fall back; recognized malformed
metadata fails with a fixed diagnostic. Other providers and summarizer inputs
never see ciphertext or native metadata. Old messages remain readable unchanged.

Use a dedicated Responses SSE parser: data.type dispatch (event: fallback for
existing compliant fixtures), LF/CRLF chunk-safe framing, multiline data,
UTF-8 decoder flush and final EOF frame, comments and [DONE] handling, bounded
frames, explicit malformed-JSON errors without raw data, reader cancellation.
[DONE]/EOF alone is not completion. Stop reading at terminal response.

Assembler tracks output_index/item IDs/content indices for text, refusal,
reasoning and function calls, including interleaved slots and final snapshots.
Preserve current duplicate/conflicting call-ID, missing-arguments and
output_item.done requirements. Terminal output can enrich reasoning/text and
verify closed calls, but cannot introduce/finalize executable calls. Snapshot
corrections are authoritative at message_end; deltas stay append-only for UI.
Only explicit max_output_tokens incomplete maps to max_tokens (entire tool
batch refused); failed, cancelled, content-filtered and unknown incomplete
responses throw typed errors with structured code/status/reason. No successful
message_end for missing terminal, malformed output or unfinished normal calls.

Usage: input excludes cache reads/writes; output includes reasoning (never add
reasoning twice). Keep usageMissing semantics and optional reasoning count if
needed; do not claim catalog estimates equal subscription billing. Distinguish
quota/app-limit errors from transient failures before any stream retry; bounded
pre-stream retry for temporary failures only, no automatic mid-stream replay.
Keep 401 re-login guidance and structured overflow detection for compaction.

Session files preserve optional fields naturally; add explicit round-trip,
resume, child and compaction tests. Compaction uses final assembled summary
text (not stale deltas), excludes metadata from summaries, and estimates retained
hidden reasoning using reported output-token floor, not ciphertext length.

## Scope cleanup after user acceptance

User requested simplification after a read-only audit of 72 paths (29 source,
28 tests/helpers, 12 documentation, 2 manifests and one local scratch script).
Preserve accepted authentication, streaming, replay and offline model-list
behavior. No new dependencies, compatibility layer, live API calls or main merge.

Implemented bounded corrections (independent design review f88323f1 PASS before implementation):

1. Login selection: do not replace any usable model, including an automatically
   resolved builtin model. For automatic selection require both an unusable
   current model and pending selection intent. Retain deliberate subscription
   selections without credentials. Do not change API-key-only selection policy
   again in this batch; broader intent protection remains as documented.
2. Delete unused verifiedIdentity wrapper, diagnostic-only bodyShape and
   unconsumed reasoningTokens accounting, plus the local cache-seeding script.
   Keep output_tokens inclusive of reasoning, retry classification, bounded
   diagnostics and pre-rotation verification-material loading.
3. Make hidden-reasoning estimation target-aware using one optional qualified
   active model reference on existing estimators/cut-point/compactHistory APIs.
   Reuse native replay's provenance/whole-message metadata eligibility rather
   than duplicate its rules. The shared selection helper stays strict for
   conversion; estimation catches malformed metadata and uses canonical counts.
   Only exact openai-codex/version-1/model native replay with finalized ciphertext
   and reported usage gets the existing output-token floor, never ciphertext
   length. No declared target means no native floor. Ordinary histories retain
   their existing estimates and cache arithmetic.
4. Responses-marked messages (provenance, responses metadata or subscription
   producer reference) cannot anchor measured usage under an incompatible or
   unknown target. Messages whose provenance/metadata causes whole-message
   canonical fallback, including recognized malformed metadata caught only by
   estimation, provide neither a native floor nor a measured anchor even for a
   matching target. Strict conversion still rejects recognized malformed data.
   Metadata-free legacy messages with an exact subscription producer reference
   may keep matching-target anchors, but never gain native replay or a floor;
   bare message.model is never identity evidence. Returning to the original
   model must not reuse a newer ordinary-provider anchor that did not include
   now-replayable ciphertext: ignore such anchors after the first eligible
   encrypted native item anywhere in the effective history, including retained
   items before minAnchorIndex. Ciphertext presence is independent of whether
   usage was reported. Preserve earlier matching anchors and boundary rules;
   with no eligible anchor estimate all messages. Ordinary anchors recover when
   compaction removes all eligible ciphertext; no sticky switch state.
5. Thread the active/captured reference into runner resume, automatic/manual
   compaction and overflow estimates, child compaction (both session paths),
   status and footer. Keep the captured run/child identity during in-flight
   switches. compactHistory forwards the same target to tokensBefore, cut-point
   selection and tokensAfter, and honors the caller's existing minAnchorIndex.
   compactHistory adds optional minAnchorIndex (default zero) for anchor
   selection, not retained-content counting. The sessionless child forwards its
   childFloor. compactSession forwards its existing modelReference and store boundary;
   direct compaction callers may derive the estimation-only target from their
   concrete provider.name/model. Never infer persisted pricing identity.
6. Keep account model-list persistence, manual callback entry, socket cleanup
   and catalog version-2/source boundary. Duplicate public metadata fetching
   was evaluated separately: safe sharing needs validator-keyed per-pass result
   memoization, body-consumption/retry/cancellation handling and distinct family
   publication. Defer that optimization rather than add machinery to a cleanup
   (normally one redundant public GET per successful four-hour stale refresh;
   transient retries can make more requests). No change to
   authenticated picker freshness or existing per-provider metadata isolation.

Regression gate: usable builtin/automatic models survive both login UI paths;
first unselected login still resolves and deliberate subscription stays selected.
Test target-matching/foreign/unknown/malformed replay, mixed known/unknown peer
metadata with no measured anchor and later valid-anchor recovery, away-and-back anchors,
compaction boundaries, cut points, retained metadata, status/footer and captured
run/child identity. Summaries remain canonical-only. Preserve all acceptance SSE
and tool-finalization regressions. Update providers/sessions EN/ZH, then independent
code review, typecheck/lint/build/full tests/diff check and offline package smoke.
No live inference or credential modifications are needed for this cleanup.

Cleanup reviews and results:
- Design review f88323f1: initial blocker on matching-target canonical-fallback
  anchors revised; follow-up PASS before implementation.
- Login/removal review 8cc6f55d: PASS; final status/footer tests and bilingual
  documentation follow-up PASS.
- Estimation/history review 8c8cfa62: cross-message duplicate native IDs initially
  bypassed estimator eligibility. Fixed with one forward history-wide ID set,
  shared eligibility for anchors/floors/cut selection, and revalidation against
  the rebuilt retained history. Malformed messages reserve no partial IDs.
  Follow-up PASS; 100,000 adversarial conversion histories matched the baseline.
- Final gate on Node 25.5.0: typecheck, lint (294 files / 11 bilingual doc pairs),
  build, 156 test files / 4001 tests, git diff --check and offline package smoke
  (424 allowed files; isolated install/help/version/npm-exec) passed. Logs:
  .ink/chatgpt-direct-cleanup-tests.log and
  .ink/chatgpt-direct-cleanup-package-smoke.log. No Node 22.19.0 execution.
- Scope accounting is not a file-count reduction: 72 became 75 changed paths
  versus main because four existing compaction regression files were newly
  exercised and the scratch script was removed. Source paths remain 29; tests
  and helpers are 32, docs 12, manifests 2, scratch 0. Against the accepted
  cleanup baseline, source net +97 lines reflects correctness and target
  plumbing despite removing the unused wrapper and fields; tests net +1353
  lines / +97 cases. No new runtime module, dependency or compatibility path.
- Authentication/storage/callback cleanup, model caches/catalog, SSE/parser,
  tool-output assembly/transport and manifests are byte-identical to the
  accepted baseline. No real credentials or live API requests were used during
  cleanup. Main remains 058810b; no commit, merge, push or publish.

### Final small-redundancy cleanup

User approved the final audit's small, behavior-preserving reductions on
feat/chatgpt-direct-subscription-final-cleanup. Independent design review
62568027 PASS closed before implementation for this exact scope:

- Delete the conditional-assertion public-metadata test in model-discovery; keep
  the explicit account-only, empty-list and stale-account-label coverage.
- Make OAuth default-origin/timeout, Responses index/frame-limit helpers and
  the default browser opener module-private. Remove the unused default-origin
  import/re-export from codex-auth. Retain all implementations and values.
- Remove only the two synchronous API-key callback-entry cancellation checks
  and their now-unused import. The shared lock still checks abort immediately
  before the synchronous read/callback, and atomic writes still check abort
  before creating the temp file and before rename; do not change those checks.
- Remove LoginDialog.cancel's unused reason parameter and its three identical
  literal arguments. Keep silent cancellation, abort and prompt cleanup intact.

Do not remove the inherited dialog.message interface, change model-selection
policy, caches, protocol behavior, security boundaries or dependencies. No
user-facing behavior changes, so published documentation needs no new wording.
Bounded comparison against /tmp/ink-subscription-small-cleanup.S4hF70:
7 source files (+10/-15 lines) and 1 test file (-12 lines); no new runtime module,
dependency or changed constant value. Independent code review e278968f PASS
confirmed cancellation sequencing, retained coverage and no consumer of the
removed exports. The design record is the only other changed file in this batch.

Verification on Node 25.5.0: focused 10 files / 716 tests, typecheck, lint
(294 files / 11 bilingual doc pairs), build, full 156 files / 4000 tests,
git diff --check and offline package smoke (424 allowed files, isolated
install/help/version/npm-exec) passed. The full count decreased by exactly the
one ineffective test deleted. Logs: .ink/chatgpt-direct-final-cleanup-tests.log
and .ink/chatgpt-direct-final-cleanup-package-smoke.log. No real credentials or
live API calls; no commit, main merge, publish or push.

## Scope exclusions

No WebSocket pool/incremental continuation, no migration framework, no API-key
provider rewrite, no multi-account manager, no new hosted tools, no broad pi
registry port. Existing runner conversation identity lifecycle remains intact.

## Verification and delivery

Design first passes fresh-context adversarial review. Implement independent
auth/store/UI, stream/history, and discovery/metadata batches with disjoint file
ownership where possible. Re-read changes and obtain independent security and
protocol review; close blocking findings before completion.

Offline verification: focused OAuth/JWKS fake servers and callback cancellation;
wrong token claims/signatures/scopes; cross-process lock/rotation; atomic-store
preservation and corruption; CLI/dialog cancellation; SSE framing; native replay
and cross-provider isolation; current tool-argument regressions; model visibility
and cache isolation; session/compaction. Run npm run typecheck, npm run lint,
npm run build, complete npm test, git diff --check, package smoke if applicable.
Tests use HOME/INK_AUTH_PATH sandbox and network guard. Never launch browser in
automated tests. Production dependency changes use --ignore-scripts.

User approved real credentials/login/limited inference on 2026-10-29. Prefer
isolated test credentials; never print secrets or modify other providers. If a
new browser grant needs the user's click, do not impersonate consent. Live
verification, if available, is limited to at most 3 small inference requests,
with exact request counts reported; no old-token conversion experiment.

## Design review

Initial independent review fff92ec1 requested changes in selection intent,
permission/re-consent states, serialized logout, replay-part representation and
credential destination/redirect policy. The revisions above address all five;
follow-up review fff92ec1 PASS closed all design blockers before implementation.

Stop on feature branch before merge to main. Report paths, review outcomes,
exact test counts, acceptance steps and unverified live behavior. No publish,
push, main merge or unrelated changes.

## Implementation reviews and verification

- Design review fff92ec1: PASS after five requested revisions.
- Auth/security review 3ad382bf: PASS after rotation-material prefetch,
  immediate non-usable issued-registration persistence and narrow terminal
  refresh-error handling. Final callback/client-ID and cancellable-write delta
  independently passed (127 focused tests).
- Protocol review 02d10fda: PASS after schema-valid native messages, rejecting
  empty conflicting terminal arguments, multipart child-output preservation,
  frame-boundary UTF-8 validation and message-level unknown-version fallback.
- Integration review 134dd81c: all blockers closed after durable subscription
  selection intent, cancellation-aware API-key writes, encoded Ctrl+C and
  freshness-checked startup availability; remaining documentation wording fixed.
- Delivery audit 96f34322: PASS; package content matched source and all 126
  source modules had runtime output. Subscription context-window fallback wording
  corrected afterward in both languages. Logout additionally drops retained ID
  tokens; registration/subject/client ID and installation identity remain.

Final offline gate on Node 25.5.0: npm run typecheck, npm run lint (294 files;
11 bilingual documentation pairs), npm run build and git diff --check passed.
Full suite: 156 files / 3861 tests passed. Full logs are local ignored artifacts
under .ink/chatgpt-direct-tests.log. Package smoke uses --cache-source
/tmp/ink-npm-cache: 424 allowed files; integrity/modes, isolated offline install,
help/version and local npm-exec resolution passed. Initial smoke attempts lacked
cached production tarballs; seeding the 11 lockfile-pinned tarballs resolved this
without relaxing the network guard. No dependency lifecycle scripts ran.

Initial live verification: public OIDC discovery matched pinned production
endpoints; no credentials or inference were used at the initial delivery. Node
22.19.0 minimum was not executed locally. Main remains at 058810b; no commit,
merge, publish or push.

### Acceptance correction: response media type

User completed browser authorization in isolated /tmp acceptance credentials and
reported `Codex response is not an SSE stream`. One bounded diagnostic inference
with gpt-6.1-sol confirmed HTTP 200, a nonempty SSE-framed body and the complete
response.completed sequence, but no Content-Type header. No raw response or
credential was persisted or printed; default user credentials were untouched.

Correction design: a successful non-null response body enters the existing
strict SSE parser regardless of media-type header (as OpenAI SDK stream mode
already does). Content-Type is not evidence of protocol completion. Do not add
JSON/NDJSON response adaptation, synthetic tool finalization or a media-type
whitelist. Missing bodies still fail with bounded status/request-ID diagnostics;
JSON, HTML, [DONE] and empty bodies must fail without message_end or tool execution.
Keep all terminal, malformed-frame, cancellation and tool finalization checks.
Regression tests cover absent/JSON/text/octet-stream/NDJSON labels over valid
SSE bytes, non-SSE bodies and missing-body diagnostics. Independent design
review bca8f2d2 PASS closed before implementation. Independent code review
a2c29e40 PASS; focused 5 files / 482 tests passed before live tool verification.

### Acceptance correction: empty terminal output snapshot

The second live request (a no-side-effect acceptance tool) passed transport but
failed protocol assembly before message_end; no tool executed. The third and
last allowed live request collected allowlisted event structure only: complete
function_call argument deltas, arguments.done and output_item.done with completed
status arrived, then response.completed carried output:[]. The strict aggregate
snapshot check incorrectly treated this empty aggregate as deletion of all
streamed items. Three live inference requests total; no additional requests will
run without extending the acceptance budget with the user.

Correction design (independent review a2c29e40 PASS before implementation): interpret
an empty terminal output array as absent aggregate data, not as deletion, ONLY
when every streamed item has output_item.done and its final status is omitted
or completed for a normal completed response. Still parse and validate all tool
arguments before message_end. Final text/reasoning data and ciphertext come from
the finalized items. A nonempty terminal array still verifies every streamed
item, identity/order and final arguments; missing or conflicting entries fail.
No terminal-only tool introduction or finalization, no synthetic events and no
skipping malformed arrays. For explicit max_output_tokens incompletion, permit
empty aggregate data while retaining the existing entire-tool-batch refusal.
Add success coverage for finalized text/reasoning/tool output with output:[],
negative coverage for unfinished or non-completed items, missing/invalid tool
arguments, and partial nonempty aggregates; assert zero executions on failures.
Independent code review eb1e4919 PASS, including 35 additional offline adversarial
cases. Its optional added-only ciphertext suggestion is now covered by two
checked-in tests and follow-up review PASS. Final gate on Node 25.5.0: typecheck,
build, lint (294 files / 11 bilingual doc pairs), 156 files / 3904 tests,
git diff --check and package smoke (424 allowed files; isolated install,
help/version and local npm-exec) passed. Logs remain under
.ink/chatgpt-direct-tests.log and .ink/chatgpt-direct-package-smoke.log.

User acceptance: PASS. After both corrections and rebuilding dist, the user
explicitly confirmed: “这次验收成功了。” This closes user acceptance on the feature
branch; it does not authorize merging or publishing. Individual acceptance steps
were not separately reported. No additional agent-run live requests were made;
the earlier three diagnostic requests exposed both defects and executed no tools.

The diagnostic script was removed; no credentials, raw inference frames or
ciphertext were written to workspace artifacts. Existing isolated acceptance
credentials remain available without another login. Default credentials were
untouched. Main remains 058810b; no commit, merge, publish or push.

Acceptance from the source checkout:
1. `cd ink && npm run build`. Reuse the isolated acceptance INK_AUTH_PATH and
   INK_CATALOG_PATH when retrying; no new login is needed after these fixes.
   For a genuinely new credential store only, run `node bin/ink.js login` and
   complete browser consent. Other provider keys must remain intact.
2. Start `node bin/ink.js`, inspect `/model`, select an account-listed model under
   openai-codex if not already deliberately selected, and run a small tool task.
3. Resume the same session; confirm text/tool history continues. Model switches
   must not send native replay fields to another provider.
4. Optional: cancel `/login` and verify return to the editor; run logout and check
   the remote-revocation confirmation or explicit unconfirmed warning.
