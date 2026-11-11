# Codex pre-stream retry hardening

Status: approved (2026-11-11; four independent design reviews; final reviewer
session `8ed1e544-f4b2-4d62-b7bb-fec6531e5966`).
Branch: `feat/codex-pre-stream-retry` (worktree
`/Users/z/Z/Agent_demo/.worktrees/codex-pre-stream-retry`).
Base: `main@0ef9bfa`.

## 1. Problem

`postResponses` (`src/provider/responses-transport.ts:88-160`) opens every
ChatGPT-plan Responses request. Today a pre-stream failure gets **three
attempts total** and fixed pauses of **600 ms and 1500 ms**. Each attempt has a
fresh 30 s timer covering DNS, TCP, TLS, request upload and the wait for response
headers. After the third failure it throws
`Codex request failed before the response stream opened` with
`code: "connection_failed", retryable: true`. The `catch` discards the
underlying cause, so neither the TUI nor `~/.ink/logs` records whether the last
failure was a timeout, a reset, or a DNS error.

Evidence on the owner's machine (Clash Verge / mihomo TUN, `utun1024`,
mixed-port 7897):

- 3 top-level `run_error` entries with this message in `~/.ink/logs`
  (2026-11-10 20:29, 2026-11-11 00:37, 2026-11-11 10:08 local).
- 2 subagent failures with the same message, visible only as
  `[task] child failed after N turns: ...` in the parent session
  (2026-11-11 00:45 and 10:29 local).
- The 33.6 s failures match one 30 s timeout plus two fast failures; the 17.1 s
  failure matches a slower connection failure. During healthy periods, curl and
  Node fetch reach `api.openai.com` in 0.3–3.2 s (12/12 and 20/20 in a spot
  check).
- The same period also contains mid-stream `stream interrupted` /
  `Body Timeout` / `UND_ERR_SOCKET` errors. Those are out of scope: the stream
  has already opened and output may have been emitted.

The current ~2.1 s of pauses is too short to ride out a proxy-node restart or a
route flap, and a 30 s timeout leaves only two immediate retries. Manual
recovery is "resend"; the transport should absorb short outages instead.

## 2. Goals and non-goals

**Goals**

- Raise the chance of surviving a transient pre-stream network failure without
  a user-visible interruption.
- Keep the worst-case wall clock bounded and close to today's worst case.
- Keep cancellation exact: user abort returns `null`, no further attempts, no
  error.
- Preserve security: never include raw network error messages or credentials;
  expose only a closed-allowlist cause label.
- Keep the change local to `postResponses` and its tests. No settings, UI, or
  turn-loop changes.

**Non-goals**

- No retry after the response stream has opened; mid-stream interruptions keep
  the current "send 继续" behavior.
- No turn-level retry (scope C) and no visible per-retry status line.
- No change to the 30 s per-attempt timeout, endpoint, auth, body, or
  `store:false` semantics.
- No change to other providers; `src/provider/shared.ts` retry constants are
  untouched.
- No `Retry-After` handling for 429; no jitter (single-user CLI, deterministic
  tests).
- No child-failure logging in this batch. It needs logger plumbing through the
  task tool and is an observability follow-up, not part of the retry fix.

## 3. Decisions

### D1 — Five network attempts; HTTP admission retries unchanged

Two schedules, two failure counters, one global attempt cap:

```
NETWORK_RETRY_DELAYS   = [1000, 2000, 4000, 8000]   // 5 attempts
ADMISSION_RETRY_DELAYS = [600, 1500]                // 3 attempts, unchanged
MAX_ATTEMPTS           = 5                          // global cap
```

- A fetch throw reads `delay = NETWORK_RETRY_DELAYS[networkFailures]`, then
  increments `networkFailures`; the first network pause is 1 s.
- A retryable HTTP response reads
  `delay = ADMISSION_RETRY_DELAYS[admissionFailures]`, then increments
  `admissionFailures`; the first admission pause is 600 ms.
- Each class schedule is an independent cap. An exhausted class schedule throws
  that class's final error even if global attempts remain (e.g., three 503s end
  the run at attempt 3). The global cap `MAX_ATTEMPTS - 1` is only an upper
  bound and ends either path at the fifth attempt.
- `attempt` counts total attempts across both classes and is used for the final
  message.

Consequences:

- pure network failures: 5 attempts, pauses 1/2/4/8 s;
- pure HTTP admission failures: 3 attempts, pauses 600/1500 ms (byte-identical
  to today);
- mixed sequences: at most 5 attempts; each class takes its next delay from its
  own schedule, and either the class cap or the global cap can end the
  sequence.

The previous draft applied the 5-attempt schedule to HTTP too. The first review
showed that this would turn a permanent 503 into a ~15 s wait without evidence
that admission retries need it. The split keeps the HTTP contract unchanged and
still gives network failures the longer window they need.

### D2 — 95 s opening budget

Start one `AbortController` with a 95 s timer before the first attempt; combine
it with the user signal (`stop`), and combine `stop` with each attempt's 30 s
timeout via `AbortSignal.any`. The budget covers the whole `postResponses`
call, not the response stream after headers.

Worst cases:

- all fast network failures: 5 attempts, pauses 1 + 2 + 4 + 8 = 15 s;
- all 30 s timeouts: 30 + 1 + 30 + 2 + 30 = 93 s, then the 4 s pause is cut by
  the deadline at 95 s → 3 attempts, final label `deadline`;
- four fast failures then a fifth 30 s timeout: pauses 1 + 2 + 4 + 8 = 15 s,
  fifth attempt times out at 45 s → 5 attempts, final label `timeout`;
- two 30 s timeouts, two fast failures, then a fifth hanging attempt: the fifth
  starts at ~75 s, so the 95 s deadline (not the 105 s per-attempt timer) aborts
  it → 5 attempts, final label `deadline`;
- mixed: bounded by 95 s and 5 attempts.

Today's worst case is 30 + 0.6 + 30 + 1.5 + 30 = 92.1 s, so the new bound is
+2.9 s. In timeout-heavy outages only three attempts fit; the five-attempt
policy mainly helps fast connection failures, which matches the observed
pattern.

### D3 — Cancellation, deadline, and terminal-error precedence

- After a **network** failure, check `args.signal?.aborted` first: return
  `null`, as today.
- Then check the deadline: if it fired, throw
  `connectionFailed(attempt + 1, "deadline")`; do not start another attempt.
- Otherwise, if the per-attempt 30 s timer fired, label the failure `timeout`;
  otherwise use a closed-allowlist cause code (D4).
- After **headers arrive**, do not discard a successful response because the
  deadline fired. There is no deadline check after `fetch` resolves; only the
  existing user-abort check remains. The deadline bounds the wait; a
  header-winning fetch returns the response. (Rare race: if the deadline aborts
  in the same tick that the headers resolve, undici may abort the body; that
  surfaces as a stream interruption, never a silent replay. See §6.)
- On the **HTTP error path**, once the error body has been read: user abort →
  `null`; a terminal (`!error.retryable`) HTTP error is thrown regardless of the
  deadline, preserving 401 login and quota guidance; a retryable HTTP error with
  the deadline fired → `connectionFailed(attempt + 1, "deadline")`; a retryable
  HTTP error with its class or the global cap exhausted → throw the HTTP error;
  otherwise pause and continue.
- Both pauses use `stop` (user + deadline), so the 4/8 s pauses cannot overrun
  the budget. The loop re-checks both signals after every pause.
- All timers (per-attempt, deadline, error-body) are cleared in `finally`.

### D4 — Closed-allowlist cause label

The current `catch {}` throws away the only diagnostic. Add a suffix to the
final network error:

```
Codex request failed before the response stream opened (5 attempts; last: ECONNRESET)
```

- `attempts` is the number of attempts actually made (the deadline can stop at
  three).
- `last` is `timeout`, `deadline`, or a code from a **closed allowlist** of
  Node/undici socket/TLS codes. A shape-only regex is not enough: a string such
  as `PRIVATE_NETWORK_DATA` matches `[A-Z_]+` and would leak. The draft list:
  `ECONNRESET`, `ECONNREFUSED`, `ECONNABORTED`, `EPIPE`, `ETIMEDOUT`,
  `ENETUNREACH`, `EHOSTUNREACH`, `ENOTFOUND`, `EAI_AGAIN`, `CERT_HAS_EXPIRED`,
  `DEPTH_ZERO_SELF_SIGNED_CERT`, `SELF_SIGNED_CERT_IN_CHAIN`,
  `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `ERR_TLS_CERT_ALTNAME_INVALID`,
  `UND_ERR_CONNECT_TIMEOUT`, `UND_ERR_HEADERS_TIMEOUT`, `UND_ERR_BODY_TIMEOUT`,
  `UND_ERR_SOCKET`, `UND_ERR_CLOSED`, `UND_ERR_ABORTED`.
- As defense in depth, drop a code that contains any non-empty `args.redactions`
  entry. Read `error.cause` inside `try/catch` so a throwing getter cannot break
  the retry path.
- Never include `error.message`, stack, headers, URL, body, or credentials. The
  existing "does not expose PRIVATE_NETWORK_DATA" test stays.
- `code: "connection_failed"` and `retryable: true` stay unchanged. The exact
  message string changes; the stable part is the prefix before ` (`.

Why a message suffix rather than a new field: the TUI shows `message`, and
`~/.ink/logs` records it; a closed-allowlist code is the smallest useful
diagnostic. The `reason` field is not surfaced today.

### D5 — No retry after headers

Once `response.ok` and a body exist, return the response; SSE failures are
handled by the provider and are not replayed. This is existing behavior and
remains out of scope.

## 4. Implementation

`src/provider/responses-transport.ts` only:

- constants: `NETWORK_RETRY_DELAYS`, `ADMISSION_RETRY_DELAYS`, `MAX_ATTEMPTS`,
  `ATTEMPT_TIMEOUT_MS = 30_000`, `OPENING_BUDGET_MS = 95_000`; keep
  `MAX_ERROR_BYTES`.
- In `postResponses`: create `deadline` plus its timer, and
  `stop = args.signal ? AbortSignal.any([args.signal, deadline.signal]) : deadline.signal`
  once. Wrap the loop in `try/finally` and clear the deadline timer there.
- Loop state: `attempt` (zero-based current attempt; the existing
  `for (let attempt = 0; ; attempt++)` header increments it on `continue`, so do
  **not** increment it in the body), `networkFailures`, `admissionFailures`.
- Each attempt: fresh `timeout` controller plus a 30 s timer; call fetch with
  `signal: AbortSignal.any([stop, timeout.signal])`; clear the timer in
  `finally`.
- Network catch: user abort → `null`; deadline → `connectionFailed(attempt + 1, "deadline")`;
  label = `timeout` or `safeCauseCode`; read
  `delay = NETWORK_RETRY_DELAYS[networkFailures]`; increment `networkFailures`;
  stop if `delay === undefined`, `attempt >= MAX_ATTEMPTS - 1`, or the deadline
  fired; otherwise pause on `stop` and continue (the loop header increments
  `attempt`).
- HTTP error path: pass `stop` to `errorBody`; user abort → `null`; terminal
  error → throw it; deadline → `connectionFailed(attempt + 1, "deadline")`;
  read `delay = ADMISSION_RETRY_DELAYS[admissionFailures]`; increment
  `admissionFailures`; stop if `delay === undefined` or
  `attempt >= MAX_ATTEMPTS - 1`; otherwise pause on `stop` and continue.
- Add private `connectionFailed(attempts, label?)` and
  `safeCauseCode(error, redactions)` helpers.
- Loop-top checks: `args.signal?.aborted` → `null`; `deadline.signal.aborted` →
  `connectionFailed(attempt, "deadline")`, where `attempt` is the number of
  completed attempts.
- Comments: record the budget arithmetic and why HTTP has its own schedule.

No changes to `src/provider/codex-responses.ts`, `src/provider/shared.ts`, the
runner, settings, or `docs/providers.md`.

## 5. Tests

`test/responses-transport.test.ts`:

- Update "bounds network retries to three attempts..." to five attempts; assert
  attempt timestamps 1 / 2 / 4 / 8 s apart; the message contains `5 attempts`;
  private data still never appears.
- Add: four failures then success → five calls and a usable response.
- Add: all 30 s timeouts → three calls, `3 attempts` + `deadline`, elapsed 95 s.
- Add: four fast failures then a fifth 30 s timeout → five calls, `5 attempts` +
  `timeout`, elapsed 45 s.
- Add: user abort during the first 1 s pause → one call, `null`, no error.
- Add: user abort during a hanging fetch → `null`, one call.
- Add: abort after headers → body canceled, `null`, no stream.
- Add: two 30 s timeouts, two fast failures, then a fifth hanging attempt →
  five calls, `5 attempts` + `deadline`, elapsed 95 s (the per-attempt timer
  would fire at 105 s, so the deadline wins).
- Add: deadline cuts the 4 s pause after the third timeout → three calls,
  `deadline`, elapsed 95 s.
- Add: two 30 s timeouts (attempts 1–2), one fast network failure (attempt 3,
  ~63 s), then a 503 with a stalled body at attempt 4 (its 15 s body timer ends
  at ~82 s), then a 401 with a stalled body at attempt 5 (starts at ~82.6 s):
  the 95 s deadline aborts the attempt-5 body read, and the terminal 401 wins
  over `connection_failed`.
- Add: the same timing but attempt 5 returns a 503 with a stalled body: the
  deadline aborts the read and the final error is `connection_failed` with
  `last: deadline`.
- Add (provider level, same-tick body abort): fetch resolves at the 30 s
  per-attempt timer while ignoring the abort, with a response whose body is
  already errored by the aborted signal (use an undici-shaped
  `UND_ERR_SOCKET` cause so the existing wrapper classifies it); the provider
  reports a stream interruption and does not issue a second fetch. The same
  body-abort shape covers an abort that lands in the same tick as the headers.
- Add: `ECONNRESET` appears; `PRIVATE_NETWORK_DATA`, a secret-shaped code, and a
  code containing a redaction do not; a throwing `cause` getter is tolerated.
- Add: mixed network → 503 → network → network → success → five calls, pauses
  1 s / 600 ms / 2 s / 4 s.
- Add: network → 503 → 503 → 503 → the third 503 exhausts the admission class
  at attempt 4; the error is the 503 (not `connection_failed`), four calls.
- Add: 503 → network × 4 → the fifth attempt is the last; `connection_failed`
  with `5 attempts`.
- Add: timer cleanup after success (`vi.getTimerCount()` is 0).
- Keep: unclassified 429 / quota / 401 stay single-attempt; success on the
  third retryable HTTP attempt still succeeds; a permanently retryable 503
  still stops at three attempts.
- Use fake timers and a hanging fetch that rejects on `signal` abort; record
  `Date.now()` to assert delays. No real network.

`test/codex-fast-transport.test.ts`:

- The "exhausts network retries..." fixture supplies three failures and asserts
  three calls. Supply five failures and assert five calls; the Fast suffix
  assertion stays.
- The `it.each([429, 503, "network"])` retry test (two failures then success)
  still expects three calls for both classes; keep it as the HTTP/network
  success-path check.

Verification in the worktree: `npm ci`, targeted
`npx vitest run test/responses-transport.test.ts test/codex-fast-transport.test.ts`,
then `npm run typecheck`, `npm run lint`, `npm test`.

## 6. Risks

- The fast-failure path now takes up to 15 s to surface instead of 2.1 s. This
  is deliberate; the spinner is the only feedback (no status line in this
  batch).
- The timeout path is +2.9 s in the worst case; bounded.
- A header/deadline race can hand back a body that an abort (deadline or
  per-attempt timeout) aborted in the same tick; it surfaces as a stream
  interruption (the existing "send 继续" path), never a silent replay.
- More attempts can consume subscription allowance if the server started a
  response but headers never arrived. `store:false` means no server-side state;
  no tool call was received, so retrying cannot duplicate tool effects.
- A misconfigured proxy now fails after ~15 s (fast) or ~95 s (timeouts) instead
  of ~2 s / ~92 s. The error suffix makes the cause visible.
- `AbortSignal.any` adds a listener per attempt; bounded by five. All timers are
  cleared; no process hold.
- The user-visible error string changes by an appended suffix. The prefix
  `Codex request failed before the response stream opened` remains stable for
  scripts that match it.

## 7. File list

| File | Change |
|---|---|
| `src/provider/responses-transport.ts` | schedules, deadline, labels, helpers |
| `test/responses-transport.test.ts` | update + new cases |
| `test/codex-fast-transport.test.ts` | five-failure fixture/assertion |
| `CHANGELOG.md` | Unreleased entry |
| `docs/design/codex-pre-stream-retry-design.md` | this document |

## 8. Process and review disposition

- Fresh-context adversarial design review before any code edit; this revision
  addresses the first two reviews.
- Implementation in the worktree; targeted tests, typecheck, lint, full test.
- Independent code review after implementation.
- Merge to main with `--no-ff` only after approval.
- Code review: approved (2026-11-11, fresh-context reviewer session
  `106a2bfd-6fd1-4c02-8fee-391b4b8d01a8`).

First-review blockers and fixes:

1. §5 contradicted the 95 s deadline for all-timeout runs → corrected to
   `3 attempts; last: deadline` at 95 s; added the fifth-attempt timeout case
   for the `timeout` label.
2. The Fast transport test also exhausts network retries → added to §5/§7 and
   updated to five failures/calls.
3. Pause signal was unspecified → both paths now pause on `stop`.
4. The deadline could override terminal HTTP errors → terminal HTTP errors win;
   the deadline applies only to retryable failures.
5. The cause whitelist was shape-only → closed allowlist, redaction check, and
   guarded `cause` access; added secret-shaped tests.

Second-review blockers and fixes:

1. Counter increment/index order was ambiguous → index-then-increment is now
   explicit; the first network pause is 1 s and the first admission pause is
   600 ms.
2. Mixed class-cap behavior was undefined → each class cap terminates its own
   path even when global attempts remain; the global cap is only an upper
   bound. Added mixed exhaustion tests.
3. "Deadline during a hanging fetch" was not expressible on the first attempt →
   replaced with two timeouts + two fast failures + a fifth hang, which puts
   the deadline inside the fifth attempt.
4. `attempt` would double-increment if the `for` header stayed → the loop keeps
   the header and does not increment in the body.
5. Header/deadline race and retryable error-body deadline were untested → added
   the header-winning, same-tick race, and stalled-503 cases.

Third-review blockers and fixes:

1. The same-tick body-abort path lacked a provider-level test → added a fetch
   that resolves while the per-attempt abort fires, with a body already errored
   using an undici-shaped socket cause; the provider must report a stream
   interruption and issue no second fetch.
2. The late 401/503 body tests could not reach the 95 s deadline (the fifth
   attempt at ~75 s plus a 15 s body timer ends at ~90 s) → specified the
   two-timeouts + one-fast-failure + stalled-503 attempt-4 sequence, which puts
   attempt 5 at ~82.6 s and lets the deadline cut its body read.
