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
- Thinking levels: `/think [level]` or Shift+Tab cycles; `--thinking` /
  `INK_THINKING` set the startup level; the choice persists in settings as
  the next session's default. Levels follow each model's catalog entry —
  some models cannot turn thinking off (gpt-5 base, o3, gpt-6), newer ones
  expose `xhigh`/`max`.

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
