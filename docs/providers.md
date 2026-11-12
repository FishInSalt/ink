# Providers and models

Read this when you sign in, switch models, or wonder which providers Ink
supports. CLI flags live in [cli.md](cli.md).

## Sign in: /login

`/login` in the REPL stores credentials in `~/.ink/auth.json` (0600). A
stored key beats the environment variable.

```
/login            → Z.AI · Anthropic · OpenAI · OpenAI (ChatGPT plan) ·
                    DeepSeek · Moonshot AI · Moonshot AI CN
/login zai        → straight to the key prompt; any family name works
/logout           → remove a stored credential (environment variables stay)
```

Rows show each provider's status (`signed in — stored key`,
`env: ZAI_API_KEY`, `not signed in`). The ChatGPT-plan row runs browser OAuth:
Ink displays an authorization URL and tries to open it. The TUI also accepts
the complete callback URL in a hidden prompt if automatic return fails.
Esc/Ctrl+C cancels without force-quitting. The readline REPL uses the browser
callback only, without a second input reader.

## Families

### Z.ai GLM Coding Plan

The official path is the zai family:

```bash
export ZAI_API_KEY=<your z.ai api key>
export INK_MODEL=glm-5.3   # or glm-5.2, glm-4.7, ... per your plan
```

or `/login` → Z.AI. A bare `glm-*` id routes to zai unconditionally; without
a credential Ink prints a sign-in pointer (`/login zai`), never a silent
fallback. `ZAI_BASE_URL` overrides (e.g. the CN mirror
`https://open.bigmodel.cn/api/coding/paas/v4`). Thinking: glm-5.2 =
off/high/max; glm-5.3 = low/high/max (cannot be disabled). The pre-zai
anthropic-compat setup (`ANTHROPIC_BASE_URL` at z.ai) still works when forced
explicitly (`ink -m anthropic/glm-5.3`), binary thinking knob only.

### Anthropic

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Or `/login anthropic`. `ANTHROPIC_AUTH_TOKEN` sends Bearer-style auth; a
stored `/login anthropic` key overrides it with x-api-key style — on a compat
endpoint prefer the env pair (next section).

### Any Anthropic-compatible service

```bash
export ANTHROPIC_AUTH_TOKEN=<token>          # or ANTHROPIC_API_KEY
export ANTHROPIC_BASE_URL=<your endpoint>
export INK_MODEL=<id the endpoint serves>
```

### OpenAI

API key: `export OPENAI_API_KEY=...`, or `/login openai`. This remains a
Chat Completions API-key connection. Any OpenAI-compatible service
(OpenRouter, MiniMax, …) works through `OPENAI_BASE_URL` + a model id that
endpoint serves.

ChatGPT plan: `ink login` (CLI) or `/login` → OpenAI (ChatGPT plan) opens
Sign in with ChatGPT in your browser. Authorize Ink once; a browser already
signed in may not need another password, but OpenAI can require verification.
The loopback callback listens only on `127.0.0.1`, normally port 1455 and an
available port if occupied. The CLI's interactive terminal and TUI can accept
a pasted callback URL without echoing it. Authorization expires after 10
minutes and Ctrl+C cancels. Ink verifies the returned identity and granted
permission before making the connection usable. Cancelling before the credential
file's atomic replacement is submitted preserves the previous credentials.
Once submitted, replacement completes; cancellation does not undo a saved login.

**Existing device-code logins must run `ink login` once again.** There is no
old-token conversion, legacy backend, or automatic fallback to API-key billing.
You do not need to log out first. Other providers' stored API keys are preserved.
The stable provider ID and model prefix remain `openai-codex`; the transport is
now `https://api.openai.com/v1/responses`, not the old ChatGPT backend.
`OPENAI_CODEX_BASE_URL` overrides this subscription API base (HTTPS required);
`OPENAI_BASE_URL` and `OPENAI_API_KEY` do not affect it.

`ink logout` / `/logout` attempt remote revocation, clear local subscription
tokens and retain the registration for later authorization. If revocation
cannot be confirmed, Ink says so; disconnect the app in ChatGPT settings if
needed. Other providers' keys stay intact. Refreshes are coordinated across
processes and rotating tokens are saved atomically with owner-only permissions.

The ChatGPT-plan provider (`openai-codex`) accepts tool arguments from
streamed fragments and from complete argument snapshots, including parallel
tool calls. On a completed response, missing finalization, missing argument
data, invalid JSON, or conflicting call identities produce a `Codex protocol
error`; no tools from that response are executed. Explicit `{}` remains
subject to each tool's required-field validation. Output-truncated responses
retain the existing behavior: their entire tool batch is refused, and the
model can issue complete calls on the next turn.

Responses reasoning summaries stream as thinking blocks. Final encrypted
reasoning, message IDs, content-part boundaries and message phases are saved
as optional replay metadata. They are replayed only to this provider with the
same model; other providers, model changes and summaries never receive the
ciphertext. Old sessions still work without that metadata. On normal completion,
a missing or empty terminal `output` requires every streamed item to be finalized
by `output_item.done` with an omitted or `completed` status. Otherwise Ink reports
a protocol error without saving that assistant reply or executing its tools.
Nonempty final snapshots must remain complete and consistent. Existing session
files are not rewritten.

If the response stream closes mid-answer, Ink reports a stream interruption
instead of a bare `terminated`; it does not automatically replay partial
requests. Completed tool results stay in the session: resume with `ink -r <id>`
and send a message such as "continue". This is an ordinary message, not a
special command. A terminal event ends reading immediately. Only an explicit
output-token-limit incomplete response follows the truncation path; content
filtering and other incomplete reasons are reported as errors. A missing or
inaccurate response `Content-Type` does not reject valid SSE bytes; Ink validates
the stream itself and requires a terminal response event. JSON/HTML bodies are
not treated as successful streamed answers.

Ink uses a stable, hashed conversation ID for `prompt_cache_key` and the
`session_id` / `x-client-request-id` HTTP headers. The raw session ID is not
sent. HTTP requests include full history with `store:false` and `stream:true`;
there is no WebSocket or `previous_response_id` continuation. This does not
guarantee cache hits. The subscription route does not accept the CLI's
`--max-tokens` output cap, temperature or explicit cache-retention controls.

Subscription and app usage-limit errors link to ChatGPT usage settings and
are not retried as ordinary rate limits. Using this connection does not add
an allowance or unlock all API-key endpoints. Token cost displays are catalog
estimates, not actual subscription charges. See [sessions.md](sessions.md) for
resume, `/new` and child-session behavior.

### DeepSeek

```bash
export DEEPSEEK_API_KEY=...
ink -m deepseek/deepseek-v4-pro        # or deepseek/deepseek-flash
```

Or `/login deepseek`. `DEEPSEEK_BASE_URL` overrides; a stored key wins over
the environment variable.

### Moonshot / Kimi

```bash
export MOONSHOT_API_KEY=...
ink -m moonshotai/kimi-k3       # overseas: api.moonshot.ai/v1
ink -m moonshotai-cn/kimi-k3    # China: api.moonshot.cn/v1
```

Or `/login moonshotai` / `/login moonshotai-cn` (per-family stored keys).
`MOONSHOT_BASE_URL` / `MOONSHOT_CN_BASE_URL` override the endpoints.
Thinking: k2.6 toggles off/on; k2.7-code and k3 always think (k3 takes
`reasoning_effort` low/high/max; the `medium` startup level maps to `high`).

## Model resolution and /model

- With no credentials, Ink says so (`no model available — run /login to
  connect one`) instead of pretending. Unselected builtin placeholders are not
  persisted; deliberate subscription selections are preserved in sessions even
  without a credential, so resume cannot silently change the billing path.
- With exactly one provider configured, unselected new sessions start on that
  family's recommended model with a one-line note; for ChatGPT this is the first
  model in its fresh account-scoped listing, not a hardcoded recommendation.
  Empty, stale or unavailable account listings leave selection unresolved;
  `/model` changes it;
  `/settings defaultModel <id>` pins the startup default. Precedence:
  `-m` > `INK_MODEL` > settings `defaultModel` > session-saved >
  single-provider recommendation > builtin default.
- `/model [id]` applies from the next turn; Ctrl+L opens the picker.
  Switching model or thinking level prints one dim status line; consecutive
  switches merge.
- The picker first asks each configured endpoint for its models. If a default
  API-key endpoint is unavailable (including an authentication failure), it
  uses that family's cached public catalog, then the bundled static choices
  when no catalog is available. Static Moonshot choices include `kimi-k2.6`,
  `kimi-k2.7-code`, `kimi-k2.7-code-highspeed` and `kimi-k3` on both platforms.
  Offline choices do not verify credentials or access. An endpoint redirected
  with a `*_BASE_URL` variable gets no public-catalog or static fallback:
  Ink reports it unreachable rather than inventing models for that service.
  Your current selection remains pickable even when unlisted. ChatGPT-plan
  availability uses only its account listing, as described below.
- Thinking levels: `/think [level]` or Shift+Tab cycles; `--thinking` /
  `INK_THINKING` set the startup level; the choice persists in settings as
  the next session's default. Levels follow each model's catalog entry —
  some models cannot turn thinking off (gpt-5 base, o3, gpt-6), newer ones
  expose `xhigh`/`max`.

## Codex Fast requests

Fast is a per-model request mode for the ChatGPT subscription provider
(`openai-codex`), not API-key `openai`, Ultrafast, or a global speed toggle.
`/model` (Ctrl+L) offers the base model followed by a `·fast` variant for
**every Fast-capable Codex model in the account listing**, not only Sol.
For example:

```text
/model openai-codex/gpt-6.1-sol·fast
/model openai-codex/gpt-6.1-sol
```

The second command selects normal processing and clears Fast. The suffix also
works with `-m` / `--model`, `INK_MODEL`, and settings `defaultModel`. The footer,
`/status`, and model-switch notes show it. Automatic startup/login suggestions
remain normal and do not replace a deliberate Fast choice.

Optional account-list capability hints take precedence over Ink's bundled,
pinned snapshot of the official Codex model catalog, including explicit
negative hints. `service_tiers` with `id:"priority"` or `id:"fast"`, or legacy
`additional_speed_tiers` containing `"fast"`, advertise capability. Either
positive field suffices; otherwise a valid array with no Fast entry (including
`[]`) is negative evidence. Missing/malformed fields alone mean unknown and use
the snapshot. If support is still unknown or negative, no Fast row is added.
Neither the snapshot nor pi.dev metadata adds an unlisted account model; model
names do not establish capability. Offline variants retain the base listing's
stale/unverified notice.

A deliberate, well-formed `openai-codex/<id>·fast` selection remains a valid
request even for a custom, unknown, or negatively advertised model, including
when resumed from a session. Capability changes do not erase it. The server
can reject unsupported requests; local acceptance is not proof of access.

The picker says `Fast requested; higher usage; availability unverified`.
Fast may consume more subscription allowance or incur additional cost. Catalog
reference estimates now include the per-call service-tier assumptions described
below; they are not actual subscription charges or verified allowance multipliers.
Listing and capability do not verify account entitlement or guarantee faster
responses. An initial 2026-11-10 subscription
probe with `service_tier:"fast"` returned **HTTP 400** without a retained diagnostic
reason. A separately authorized follow-up completed 42 requests (2 warm-ups and
20 randomized formal pairs), with 18,942 reported tokens, correct outputs and no
failures or exclusions. Paired character delivery improved 42.29% and total
latency decreased 23.62% in that workload and observation window. All terminal
tiers were `default`: these results are performance evidence for that experiment,
not confirmation of an internal processing tier, entitlement, billing, or a
general speed guarantee.

Ink sends the unchanged base model ID with `service_tier:"priority"`, the
Fast-equivalent value used by official Codex. Normal requests omit the tier
field. `·fast` is selection/display syntax, not a new model: context, vision,
pricing metadata and replay identity stay base-only. Thinking remains independent
(`/think`, `--thinking`); selecting Fast does not lower it.

Errors preserve the selection and show recovery guidance: explicitly choose
the normal model before retrying normally. Recovery hints never replace the
original failure if its error object cannot be annotated. Retries keep Fast;
there is no silent
normal retry, model substitution, credential/billing switch, or legacy-backend
fallback. A valid terminal response completes normally even if its reported tier
is `default`, `standard`, `flex`, unknown, or missing. This also applies to the
already-supported `max_output_tokens` incomplete path; incomplete tool batches
remain non-executable. Actual stream failures, terminal errors, unsupported
incomplete reasons, invalid tools/replay, and truncated streams still fail.
HTTP 200 alone is not completion; stream errors retain typed diagnostic status
without misleading `API error 200` wording.

Codex assistant messages save bounded `serviceTier` observations separately:
`requested` is `priority` for Fast or `omitted` for an ordinary request; optional
`reported` is the terminal value, never rewritten to match the request or taken
from a created event. Malformed reports are ignored. None of these values attest
to actual processing or charges. `/status` shows the **LAST response** observation
for the current exact provider/base model in active history, not confirmation of
the current selection. It shows `omitted` and `unreported` explicitly. If that
model's latest assistant has no valid observation, it does not substitute an
older one. Legacy sessions remain valid; there is no per-turn warning.

## Codex reference pricing

For `openai-codex` only, Ink adjusts the current base-model catalog rates using
observations captured at each producing call. The rules version is
`pi-2cac4f1a9`, pinned to [Pi revision 2cac4f1a934cdc4a80b05a7d8ff2543cf5ee623c](https://github.com/earendil-works/pi/blob/2cac4f1a934cdc4a80b05a7d8ff2543cf5ee623c/packages/ai/src/api/openai-codex-responses.ts#L623-L660).
This is a local reference estimate, not an invoice, subscription allowance
measurement, or confirmation of actual processing. It changes neither requests
nor model identity, selection, capability, authentication, retries or errors.

| Captured terminal `reported` value | Tier used only for the estimate |
|---|---|
| `priority` or `fast` | Priority (`fast` is an alias) |
| `flex` | Flex, even if priority was requested |
| `default` or missing | Priority if that call captured `requested:"priority"`; otherwise base |
| `standard`, `auto` or `scale` | Base, following Pi's reference rule, not verification of billing terms |
| Other value | Base-only estimate with incomplete tier pricing |

Priority multiplies all four monetary rate components (input, output, cache
read and cache write) by **2.5 for the exact base ID `gpt-5.5`**, and by **2 for
other IDs**. The otherwise-2 rule is a Pi-compatible assumption, not a verified
rate for unknown or future models. Flex uses **0.5**, and base uses **1**.
These are monetary adjustments only: raw token counters and cache-hit rates are
never multiplied. Other providers are unchanged. The raw `reported` value stays
unchanged, including `default`; requested-tier fallback is for estimation only,
not a rewrite or evidence that priority processing occurred.

For identified Codex usage with known rates, missing or invalid tier observations
(including legacy records) leave positive usage at a base-only estimate with
incomplete tier pricing. Malformed or inconsistent pricing metadata does not
erase valid raw usage; it falls back rather than
pricing only part of a report. Missing catalog rates remain unpriced; a zero
catalog rate is a zero reference estimate, not proof of free subscription use.
Estimates use current catalog rates, not preserved historical billing rates.

Session cost displays (footer, `/status` and session statistics) use `~` for
incomplete reference pricing, including unknown tiers or legacy base-only Codex
estimates. `!` still means known-missing usage, not an unknown multiplier; existing
unknown-rate and subscription indicators remain. No multiplier reconstructs
unreported work. Normal/Fast mixtures, history navigation, reopening, children
and summary retries retain each call's original attribution rather than using
the current selection or the last response's tier. See [sessions.md](sessions.md)
for accounting and rejected-summary receipts.

## Model catalog (pi.dev)

Model metadata — context windows, cost rates, thinking ladders, vision
capability, family model lists — comes from the public catalog service at
`pi.dev`. A disk cache (`~/.ink/models-catalog.json`) makes it offline-safe:
at startup Ink loads the cache synchronously (bundled static tables are the
frozen last-resort floor) and refreshes non-blocking when the cache is older
than 4 hours; opening `/model` re-checks the same window. No periodic
polling. On a successful fetch the catalog always wins over the bundled
tables, so new models and price changes arrive without an Ink release.

ChatGPT subscription **availability** comes from authenticated `/v1/models`:
only selectable (`visibility:list`) slugs appear, in server order. Successful
empty listings stay empty. Account listings are cached separately for five
minutes; the offline picker can show a stale account snapshot with an explicit
unverified notice. Metadata is not evidence of account access. Login selects a
model only when the current model is unusable and none was deliberately chosen.
A usable builtin or automatically selected model is never replaced merely by
logging in to another provider; Ink shows a manual `/model` suggestion instead.
Configured and resumed model choices remain unchanged, including when their
credential is missing.

For `openai-codex`, all consumed metadata comes from that family's own public
catalog at `https://pi.dev/api/models/providers/openai-codex`: context windows,
output limits, estimated costs, thinking maps and vision. Ordinary `openai`
continues to use its separate catalog. For example, GPT-6.1 Sol currently has
a 500,000-token subscription window; the ordinary OpenAI catalog's 272,000-token
value is a default intended to avoid API long-context pricing. This metadata
choice does not change authentication, account-scoped availability or the
`https://api.openai.com/v1/responses` inference endpoint.

Subscription cache entries previously derived from the ordinary OpenAI catalog,
including their ETags, are ignored. The next startup or `/model` refresh fetches
the subscription catalog even if that old entry was less than four hours old.
A successfully cached new-source entry remains usable offline; before the first
successful fetch, the conservative missing-metadata fallback still applies.

The status bar's context window and `/status` usage percentage query the catalog
using the selected provider and model together. Loading a valid cached catalog
is enough to display that provider's window without first opening `/model`.
`INK_CONTEXT_WINDOW` overrides the lookup. If the catalog has no window, API-key
families try runtime discovery metadata, then the bundled static table and the
131,072-token default. The direct subscription family deliberately skips legacy
discovery/static windows and uses 131,072 without catalog metadata, unless
overridden.

```bash
INK_CATALOG_BASE_URL=https://mirror.example   # redirect the catalog source
INK_CATALOG_PATH=/path/to/models-catalog.json # relocate the cache
```
