# pi-tui 1.5.1 upgrade and Apple Terminal Shift+Enter

Date: 2026-11-10
Status: locally verified; independent design and final implementation reviews APPROVED.
Branch: `fix/pi-tui-1.5.1-shift-enter`
Base: `2e3d37b` (clean main).

## 1. Scope and authorization

The owner requested the upstream dependency upgrade, regression coverage, and
assessment of other affected behavior, and explicitly approved two independent
subagent review rounds (design and final implementation). Work is confined to
this checkout and task-owned scratch directories. Do not change global Ink,
macOS preferences, credentials, application version, other projects, or release
identity. No push, merge to main, publication, CI dispatch, or live model/API
request is authorized. Do not edit the neighboring pi checkout.

## 2. Observed failure and selected artifact

The owner's local Terminal.app (macOS 27.2 arm64) produces these samples:

| Key | Raw bytes | Native Shift |
| --- | --- | --- |
| Enter | `0d` | false |
| Shift+Enter | `1b0d` | true |
| Command+Shift+Enter | `0d` | true |

The pinned pi-tui 0.82.0 only normalizes a plain CR while native Shift is held.
ESC+CR therefore reaches Ink's Alt+Enter interception and submits rather than
inserting a newline. The native addon loads successfully. No permissions change
is needed; the exact macOS change that exposed this limitation is not proven.

Upstream issue #11559 and commit `86dc686cf` extend native normalization to
ESC+CR, preserving Alt+Enter without Shift. The fix is in 1.5.0. Select the exact
published 1.5.1 package, not a source checkout or a moving latest range:

- Registry: `https://registry.npmjs.org/@earendil-works%2Fpi-tui/1.5.1`
- Tarball: `https://registry.npmjs.org/@earendil-works/pi-tui/-/pi-tui-1.5.1.tgz`
- Integrity: `sha512-UZkaMYLuJrk2anJhZf06dNYdLWL8toqWNL807fhAorc8Lzy5vkxWNq/pC1f0CIM2EVdlctuRibWuIQGKYOgx+A==`
- Node minimum remains `>=22.19.0`.
- Runtime dependencies: get-east-asian-width 1.6.0 (unchanged), marked 18.0.11
  (was 18.0.5), and new marked-cjk-friendly 0.1.2.

The public tarball has been downloaded into task scratch, its SHA-512 verified
against registry metadata, and its regular-file/directory paths validated before
extraction. Install no package lifecycle scripts.

## 3. Compatibility changes already identified

1. The old runtime TUI class is now a type-only interface; select TuiMainScreen
   explicitly, exporting it as TUI at Ink's existing `src/tui.ts` boundary.
   Preserve regular main-screen/scrollback rendering; do not enable fullscreen,
   mouse capture, native clipboard integration, or upstream Markdown rendering.
2. Terminal now requires setProgramStatus(status). Real ProcessTerminal already
   implements it. Add no-op methods to test terminal implementations; do not add
   a new Ink program-status feature as part of this repair.
3. Hardware cursor mode now omits the old inverse-video cursor cell. Ink already
   passes true to the renderer; keep the hardware cursor for IME placement and
   accept the intentional removal of the duplicate software cursor. Verify that
   internal APC cursor markers never reach terminal output.
4. Upstream removed PI_HARDWARE_CURSOR/PI_CLEAR_ON_SHRINK environment defaults.
   Hardware cursor is already explicit in Ink; retain clear-on-shrink's normal
   false default. Document any obsolete upstream-only override behavior rather
   than introducing new Ink settings without a requirement.
5. ProcessTerminal adds OSC 7501 capability negotiation, native platform helpers,
   a transport-aware lone-Escape timeout, improved exit restoration, and input
   parsing fixes. Verify negotiation replies do not enter the editor, real
   Alt+Enter and interrupts remain intact, and stop restores terminal state.
6. Width, wrapping, fuzzy completion, CJK and shifted-symbol matching fixes may
   change edge cases. Review old/new shipped implementations at Ink's actual
   call sites and retain existing behavior contracts. Rendering differences must
   be explained; do not bulk-update snapshots to suppress failures.
7. Fullscreen, LaTeX, upstream Markdown, colors/theme-query, clipboard, and image
   features are not used by Ink through this boundary. Check import-time side
   effects, but do not adopt these features. Providers, session schemas, tools,
   and credential handling must not change.
8. Preserve diagnostic confidentiality without restoring the old .pi path or
   accepting a shared fixed /tmp/pi-tui-crash.log. At the same thin boundary,
   wrap TuiMainScreen in the existing TUI constructor and supply a lazily created,
   process-local mkdtemp directory (mode 0700; production-only namespace refined
   in section 8) as its default
   log directory. Reuse that directory within one process; retain crash/debug
   files for inspection rather than deleting diagnostics on exit. An explicit
   constructor logDirectory remains supported for controlled tests. Normal
   frames/CLI output must not change; this introduces no new setting or global
   config. Log files may have normal umask permissions inside the private
   directory; the containing directory is the privacy boundary.

Additional required adaptation discovered by typecheck/tests is allowed only
when it preserves these contracts. An unexpected material behavior change is a
stop-and-assess finding, not automatic acceptance of the new library's defaults.

## 4. Planned edits

- package.json/package-lock.json: pin pi-tui 1.5.1 and change only its necessary
  transitive graph. Compare parsed lock records to the baseline; reject unrelated
  dependency churn. No overrides, application version, or Node minimum changes.
- src/tui.ts: keep the thin boundary; retain the TUI constructor name through a
  TuiMainScreen subclass and supply the private per-process diagnostic directory
  described above. Forward terminal, hardware-cursor and optional explicit log
  directory arguments. Other production changes require compatibility evidence.
- Test terminal helpers: add required setProgramStatus no-ops, and adapt direct
  component assertions only when they inspect newly internal cursor markers.
- Add real ProcessTerminal coverage using a mocked native modifier reader, not
  only pre-normalized CSI-u input: start, actual stdin buffer/splitting, native
  normalization, shell input routing, graceful cleanup. Cover plain Enter,
  native Shift+CR and Shift+ESC+CR, genuine Alt+ESC+CR, Command+Shift+CR-equivalent,
  CSI-u and modifyOtherKeys Shift+Enter, Ctrl+J, non-Apple sessions, key releases,
  bracketed paste, negotiation, and shutdown where applicable.
- CHANGELOG.md Unreleased plus docs/sessions.md and its Chinese mirror: describe
  the local Apple Terminal fallback, preserved Alt+Enter behavior, Ctrl+J and
  backslash+Enter alternatives, and the limitation of local modifier detection
  over SSH. Add relevant upgrade-impact notes, not claims about an OS regression.
- This record: retain review outcomes, exact test counts, dependency delta,
  expected behavior changes, and residual risks.

## 5. Verification and isolation

All installation/validation uses a task-owned HOME, XDG paths, npm cache/config,
TMPDIR/TMP/TEMP and an allowlisted PATH that includes Node, rg, and fd. Scrub
provider/proxy/harness credentials. Registry GET downloads are allowed for the
local dependency build loop; disable audit, funding, telemetry/update notifier,
and lifecycle scripts. No shared/global cache writes or native rebuilds.

After independent approval:

1. Capture baseline typecheck and focused TUI tests. Add the regression and show
   it fails against 0.82.0 if the test seam is available there; otherwise compare
   the exact native-normalization inputs against the installed baseline and
   demonstrate the old shell route before relying on new-version-only exports.
2. Install exact 1.5.1 with scripts disabled. Inspect parsed graph differences,
   native addon availability, all boundary exports and lock integrity.
3. Run typecheck, lint, build, focused TUI/keyboard/lifecycle/rendering tests and
   the full suite using the existing nonlocal-network blocker. Use the same
   recorded worker/threadpool settings for baseline comparisons; do not weaken
   timeouts or assertions to conceal failures. Isolate any failing test and
   compare old dependency behavior when attribution is uncertain.
4. Run offline artifact smoke seeded from the private cache, confirming CLI
   help/version and installed dependency/native-addon contents. Validate actual
   packaged TUI construction, not just --version's early exit.
5. Mandatory automated subprocess coverage: graceful close/whenSettled and final
   frame; direct process.exit without close; trust-shell to main-shell handoff;
   cursor, bracketed-paste, Kitty and modifyOtherKeys resets without later
   re-enabling; and normal-stop timer/input/resize-listener cleanup. Use a real
   pseudo-terminal for raw-mode restoration where supported, without adding a
   PTY dependency. Test native normalization through a child-process module hook
   targeting the real native-modifiers module, assert the hook was called, and
   label Shift as simulated. Do not synthesize physical OS key events or claim
   an actual Terminal.app key test. Ask the owner to verify physical Shift+Enter
   and Alt+Enter using the workspace build at the end.
   Also provoke a controlled over-width component with fixture-only content,
   verify the private diagnostic path/mode and captured crash data, then clean
   up task-owned fixture paths. No real transcript is used.
6. Obtain independent final source/dependency/test review; resolve required
   findings before declaring done. No global install until separate approval.

Local Node 25.5.0/macOS results do not replace Linux/Node 22.19.0 and 24 CI.
If compatible supported runtimes are available, use isolated local verification;
otherwise record that gap without triggering CI or installing global runtimes.

## 6. Review and results

Independent adversarial design review `58441cc1` initially returned REQUIRED
CHANGES; the revised plan subsequently received APPROVE before implementation.
The owner accepted the characterized parser risk and selected the upgrade.
Baseline typecheck passed; four focused TUI/login/trust files passed 303 tests
with UV_THREADPOOL_SIZE=16 and maxWorkers=2. The baseline emitted an existing
MaxListenersExceededWarning for Ink's persistent exit listeners. Implementation
starts after this approval, without weakening assertions or enabling live calls.

### Initial input-recovery finding (disposition reassessed below)

The reviewer and parent independently reproduced an input-recovery difference
using the actual 0.82.0, 1.5.0, and 1.5.1 packages. Feed a recognized but
unterminated terminal reply (`ESC ] 7501 ; ?`), wait 80 ms, then send raw Ctrl+C
or Ctrl+D and wait another 80 ms. Both new versions emit no input events and
retain the control byte in the reply buffer. Baseline 0.82.0 times out the
incomplete reply and delivers the later control key. A complete terminated
reply preserves Ctrl+C on all three versions. CAN cancellation recovers both
new versions; that does not make an ordinary user's Ctrl+C reliable.

This is a synthetic malformed/delayed-terminal-response test, not a report that
ordinary complete responses or physical Terminal.app keystrokes fail. The initial
assessment conservatively blocked the upgrade on this evidence. The extended
assessment below supersedes that categorical disposition: raw Ctrl+D is not
actual stream EOF, the event loop remains live, and several recovery paths work.
Downgrading the target to 1.5.0 does not change the observed parser policy. Do not
add private-buffer mutation, process-wide input monkeypatches, or install-time
dependency patches merely to force the upgrade through.

Evidence: `/tmp/ink-pi-tui-upgrade.p6K9wY/logs/preimplementation-comparison.jsonl`.
Four cases per version, twelve total; complete replies and CAN recovery are
controls, and both Ctrl+C/Ctrl+D blockage cases reproduce on 1.5.0 and 1.5.1.
An initial probe attempted to import a target terminal module before its runtime
transitives were installed; it failed to resolve get-east-asian-width. The final
comparison imports the dependency-free StdinBuffer module directly and does not
require or perform installation.

### Other identified migration impacts

- Runtime TUI export replacement, required setProgramStatus, and removal of the
  duplicate inverse cursor are intentional upstream API/UI changes. They require
  explicit adaptation and verification, not a silent version-only update.
- PageUp/PageDown in pickers/autocomplete, Ctrl+PageUp/Ctrl+PageDown editing, and
  revised slash/skill/file-completion matching are intentional upstream changes
  but have not yet been validated against Ink's full test suite.
- Diagnostics no longer use PI_CODING_AGENT_DIR/~/.pi/agent by default. A width
  error without an explicit log directory writes all rendered lines to the fixed
  `os.tmpdir()/pi-tui-crash.log`; redraw logging now uses PI_TUI_DEBUG_REDRAW and
  an explicit log directory. Transcript privacy, file collisions and permissions
  need a decision before adopting this behavior.
- Upstream adds a synchronous direct-exit restore listener before Ink's existing
  listener. Graceful exit, direct process.exit, trust-shell handoff, mode resets,
  and listener/timer cleanup need mandatory subprocess tests, not only fakes.
- The new Darwin platform helper must be loaded from the installed artifact and
  checked for isModifierPressed without invoking clipboard reads/writes.
- Validation must scrub every inherited PI_* setting, especially PI_TUI_WRITE_LOG,
  in addition to credentials, proxies and Ink settings.

### Extended parser-risk assessment (owner-requested follow-up)

Upstream commit `edb2eb966` deliberately keeps recognized terminal strings until
their terminator. Its tests preserve replies across 5,000 ms delays. The purpose
is to avoid turning a delayed response tail into editor text or its BEL byte
into Ctrl+G. Related issues #10256 (mintty/Windows) and #10657 (WezTerm/ConPTY/
WSL2/embedder) describe real reply-fragment pollution. Those are not reports of
this owner's local macOS terminal or evidence of a Ctrl+C outage rate. Ink does
not wire pi's external-editor shortcut, but prompt pollution still matters.

Expanded local evidence:

- `logs/parser-risk-matrix.json`: 51 scenarios, 17 each for 0.82.0, 1.5.0 and
  1.5.1. Slow valid replies stay whole on the new versions while the baseline
  exposes a printable tail. No response and complete responses preserve raw
  controls. A recognized unterminated reply suppresses raw controls, but later
  DA1, an arrow, CSI-u/modifyOtherKeys controls, CAN/SUB or bracketed paste recover
  input. A lone Escape is insufficient; Escape plus raw Ctrl+C can become one
  Alt-modified event. A later terminator restores future input but does not
  replay an already buffered Ctrl+C.
- `logs/transport-risk-pty.json`: 18 real ProcessTerminal subprocess cases,
  comprising 16 automated pseudo-terminal cases and two pipe-EOF controls.
  Both versions ran with real raw mode in PTY cases. The new-version raw-control
  failure and DA1/arrow/CSI recovery reproduce. Event-loop heartbeat continues;
  an actual OS SIGINT still reaches its handler. Actual stdin end is delivered
  even while a Ctrl+D byte was buffered. This is not a process deadlock.
- `logs/program-status-optout.json`: two isolated startup comparisons confirm
  PI_PROGRAM_STATUS=0 removes OSC 7501 negotiation while retaining Kitty/DA1
  queries and working raw Ctrl+C/Ctrl+D without a partial reply.

All scripts and evidence are under `/tmp/ink-pi-tui-upgrade.p6K9wY/`. They use
isolated environments, injected bytes and local child processes. No physical
Terminal.app keystroke, actual terminal-response capture, live model call,
clipboard operation, project dependency install or global mutation is claimed.
A single existing get-east-asian-width 1.6.0 directory was copied read-only from
Ink into scratch so the published terminal module could resolve its dependency.

Ink makes no explicit terminal-color, theme, XTVersion or graphics-response
query API calls; automatic cell-size queries use CSI, not these delimited string
replies. The new ProcessTerminal makes an OSC 7501 capability query on start,
followed by DA1. No response creates no pending string; a later DA1 can recover
an incomplete OSC reply. However, absence of explicit query API calls does not
exclude control queries embedded in displayed content; the current-code audit
below establishes those additional sources. Ordinary complete ordered
fragmentation does not by itself lose a terminator. Persistent suppression
requires a recognized prefix without its terminator or a recovering sequence
before affected raw keyboard input. Frequency on the owner's Terminal.app is
unmeasured; do not characterize all exposure as startup-only.

Conditional severity is significant: while a raw-control session is affected,
editing, submit, abort and double-Ctrl+C force-exit can fail; a running model/tool
operation may continue because its abort handler was not reached. Existing
session/provider logic is not directly changed. OS SIGINT and actual stream end
bypass this parser; EOF during a running turn still follows Ink's existing
wait-for-completion semantics. Non-TUI print/piped/legacy modes do not use this
input path. Extended-protocol Ctrl+C/D can themselves trigger recovery, so do not
apply the raw-byte result uniformly to VS Code/Kitty sessions.

The same independent design reviewer reassessed this evidence and withdrew the
parser-specific categorical blocker. Revised judgment: waiting for a complete
recognized response is an intentional, reasonable trade-off; raw-control
recovery is imperfect, but normal-path exposure in current Ink appears limited
and has no measured incidence. Explicit residual-risk characterization and
acceptance are proportionate; a private parser modification is not required.

### Current-code exposure and containment audit

The owner requested an audit of actual Ink paths rather than generic protocol
possibilities. Source inspection and `logs/output-surface-probe.json` establish
that queries can also be emitted during a session:

- Assistant text passes through Renderer.raw/markdown-lite and TranscriptSink
  wrapping without a terminal-control sanitizer (src/render.ts:486-522,
  src/repl/transcript.ts:329-336,439-443).
- Visible semantic thinking uses the same unsanitized wrapping path; hidden
  thinking shows a placeholder rather than its content.
- Bang output reaches Renderer.writeLine without the normal tool-fold sanitizer
  (src/repl/repl.ts:1162-1211, src/render.ts:230-235). It is collected until
  bash.execute resolves, so this output path cannot block interruption of that
  same still-running command. It can affect subsequent prompts/queued work.
- Variable host notes/diagnostics and replayed assistant/thinking content can
  carry the same bytes (Renderer.note; src/repl/replay.ts:116-125). Literal
  printable backslash-x text is not an actual terminal control query.
- Normal tool-result folds and extension status strings use sanitizeDisplay and
  remove the tested OSC queries. A tool result therefore does not automatically
  have the same exposure as bang output. Extensions are ordinary in-process
  imports, not a sandbox; direct stdio from trusted code could bypass host paths.

The capture probe covers six surfaces, two complete OSC query payloads and two
renderers: 24 cases, 16 retaining query bytes and eight filtering them. It uses
existing Ink dist classes with baseline TUI or target TuiMainScreen, not a fully
rebuilt upgraded Ink. All rendering was captured by fake terminals. No query
was sent to a real terminal, no response was generated, and these counts are
not incident-frequency estimates. Both dependency versions preserve the tested
queries in the unfiltered surfaces; this pre-existing output policy combines
with the new dependency's response-buffer policy rather than being introduced
by the upgrade itself.

A content-generated query need not have startup's trailing DA1 query, so that
particular automatic recovery opportunity cannot be assumed. Failure still
requires a real terminal to answer with a recognized incomplete string and no
recovering sequence before affected raw controls. Emitting a query alone does
not demonstrate that failure. No measured rate supports a percentage or a
claim of negligible/common incidence.

Existing containment is partial:

- OS SIGINT and actual stdin end bypass the parser (shell.ts:543-558).
- CLI SIGTERM/SIGHUP handlers kill tracked detached children and exit
  (cli.ts:399-405). Those are emergency termination paths, not lossless UI
  recovery or a promise to preserve every in-flight message.
- Parser terminator/cancellation/new-escape recovery works as previously tested;
  Keyboard Ctrl+C/double-Ctrl+C itself is not independent of the parser.
- Select deadlines are optional and decline on timeout; they do not clear the
  parser. The owner's currently read guardian.json has askTimeoutMs=600000
  (10 minutes), which protects unanswered guardian confirmations only. Other
  prompts can have no deadline; no approval is inferred from timeout.
- Bash execution timeout is optional (bash.ts:137-143), and bang passes no
  timeout argument (repl.ts:1175). The 2,000 ms wait-child cap starts after child
  exit, not after launch. Output size caps are not execution deadlines.
- Interactive maxTurns is Infinity unless explicitly set (cli.ts:456-464).
  Loop health is observation-only (core/health.ts:7-17), not an automatic abort.
  Returning to idle does not restart ProcessTerminal or clear its buffer.

The same independent reviewer verified these findings. There is no universal
parser watchdog or wall-clock termination guarantee for interactive work. The
risk is ongoing and content-reachable, not just a startup concern. The upper
bound on conditional impact matters for long tasks even though actual response
failure probability remains unknown.

Proportionate mitigation options: suppress unused startup status negotiation;
filter untrusted terminal-control strings at appropriate text boundaries while
preserving host styling/hyperlinks and streamed-fragment handling; document
independent emergency signals and tested key recovery; and, if stronger automatic
containment is required, separately design interruption-safe parser recovery.
Blind flushing or injecting data through private buffer fields would risk
reintroducing reply tails as user input. None of these additional production
changes has been implemented or claimed verified here.

### Updated disposition and remaining review gates

The recommended route is again the original exact 1.5.1 upgrade, retaining the
upstream parser and documenting this bounded-scope but potentially serious
malformed-input limitation rather than concealing it. PI_PROGRAM_STATUS=0 is a
supported optional per-process mitigation that removes Ink's currently unused
status-query source; it is not a parser fix and does not prevent unsolicited
replies. Making it a new default requires an explicit scope/precedence decision;
current evidence does not require that behavior change.

The owner subsequently chose to proceed with the upgrade and defer further
parser/output hardening until the problem is encountered in actual use. Accept
this characterized residual risk for this batch. Do not modify the parser,
filter additional output surfaces, or disable status negotiation by default.
Document the limitation and the supported optional PI_PROGRAM_STATUS=0 setting;
that setting does not eliminate content-generated/unsolicited responses.

The remaining review findings now have explicit dispositions in sections 3-5:
private per-process diagnostic directories at the TUI boundary, and mandatory
subprocess/direct-exit/handoff/mode-reset tests. The revised plan received independent APPROVE before production implementation.
The reviewer additionally requires balanced Kitty push/pop assertions because
upstream synchronous exit restoration followed by Ink's old stop-on-exit handler
can pop twice; contract-preserving coordination is within approved scope.
Private diagnostics do not redirect upstream's separate PI_TUI_DEBUG or explicit
PI_TUI_WRITE_LOG destinations; validation scrubs both, and privacy claims must
retain that limitation. The second approved review round (final implementation)
remained reserved for the resulting diff at the end of design review. Final
implementation evidence follows; no earlier section implies that it was already
validated before implementation.

## 7. Implementation and initial verification (before final-review remediation)

### Production and dependency changes

- Pin 1.5.1 exactly and keep Ink 0.5.0 / Node >=22.19.0 unchanged. Parsed lock
  records differ only at the root pin, pi-tui, its nested marked 18.0.11, the new
  marked-cjk-friendly 0.1.2, and the existing root marked 18.1.0 changing from
  dev-only to production because it now satisfies the plugin's marked peer.
  Ten unrelated Linux libc metadata removals from npm install were restored;
  subsequent npm ci preserved the narrowed lockfile.
- src/tui.ts now subclasses TuiMainScreen. It forwards explicit diagnostics
  directories, lazily creates one private 0700 directory per process otherwise,
  and propagates creation errors rather than falling back to a shared path.
  Importing the boundary is inert. Override the synchronous exit prefix only
  to add Ink's window-title clear sequence.
- src/repl/shell.ts removes its permanent exit listener; upstream now owns direct
  exit restoration. Normal close/whenSettled remains unchanged. PTY tests count
  Kitty push/pop, bracketed paste and modifyOtherKeys enable/reset sequences;
  verify cursor/title, raw-mode restoration, regular-screen mode, no cursor
  marker leakage, and no timer writes after stop. Trust-to-main handoff restores
  the first shell before starting the second and still accepts its next input.
- Eight test terminals add the newly required setProgramStatus no-op. The
  fixture-prefix inventory was regenerated, not hand-edited; the generator also
  reconciled pre-existing stale/missing entries. No snapshots were replaced.
- CHANGELOG Unreleased and both published sessions documents describe input,
  cursor/paging, obsolete upstream environment defaults, diagnostics retention
  and opt-in exceptions, and the accepted response-buffer limitation. The
  parser and status-negotiation defaults are untouched.

### Baseline and Esc-test attribution

Baseline typecheck and the original focused 303 tests passed. Before dependency
installation the new Shift+ESC+CR transport regression failed with draft `two`
rather than `one\ntwo`: `one` had already been submitted. Evidence:
logs/baseline-new-regression.log. This is an input-routing failure, not a missing
export or a test harness import failure.

The first upgraded full suite passed 4,126 tests but failed the two Esc repro
files. Isolated rerun reproduced both. Their old assertion scanned accumulated
terminal writes for absence of an active hint; the upgraded renderer can emit
one final active frame before the buffered lone Escape is dispatched, so that
historical output never disappears from the accumulated string. The tests now
require a positive idle frame within the same deadlines, retain interruption /
no-force-exit / graceful-double-Ctrl+C assertions, await the REPL promise, and
explicitly check the mocked provider's abort signal. A separate real
ProcessTerminal test checks active-versus-idle lone Escape dispatch. No timeout
was extended and no production abort logic was changed. Both Esc tests and all
26 transport cases pass in the focused rerun and the final full suites.

### Initial automated results (superseded by closing verification below)

All commands used task-owned HOME/XDG/npm/TMPDIR settings, scrubbed credentials,
UV_THREADPOOL_SIZE=16, and the existing nonlocal-network blocker. Full suites
used `node node_modules/vitest/vitest.mjs run --maxWorkers=2` throughout.
Temporary official Darwin arm64 Node archives were verified against their
SHASUMS256 records and extracted only under task scratch; no global runtime or
package was installed. npm remains 11.8.0.

| Runtime on macOS arm64 | Full test files | Full tests | Typecheck |
| --- | --- | --- | --- |
| Node 22.19.0 (declared minimum) | 158 passed | 4,131 passed | passed |
| Node 24.22.1 | 158 passed | 4,131 passed | passed |
| Node 25.5.0 (existing local runtime) | 158 passed | 4,131 passed | passed |

- npm run lint: Biome passed; scripts syntax, 11 documents in two languages,
  topic links/parity/anchors and identity gate passed. npm run build passed.
  The new JavaScript and Python transport helpers also passed syntax checks.
- npm ci --ignore-scripts --no-audit --no-fund installed 68 packages in the
  checkout using the private cache/config, without changing the reviewed lock.
- Offline scripts/package-smoke.mjs passed: 427 allowed files, modes, isolated
  installation, help/version, and local npm-exec inference. The installed app
  reports 0.5.0 and resolves pi-tui 1.5.1, not the checkout/global dependency.
- The actual installed artifact additionally passed 30 TUI/native/privacy/PTY
  cases (10 each on Node 22/24/25), including the regression and genuine
  Alt+Enter, actual Darwin native-addon loading without clipboard operations,
  diagnostic data/mode/reuse, graceful/direct exits, and trust handoff.
- Two committed buffer tests preserve the accepted policy as characterization:
  a valid slow response remains whole; an unterminated recognized response
  retains raw Ctrl+C/Ctrl+D until a later arrow sequence restores dispatch.
  They do not assert that ordinary Ctrl+C is a reliable recovery.

Evidence root: `/tmp/ink-pi-tui-upgrade.p6K9wY/`; final logs are under logs/:
full-{22,24,25}-final.log, typecheck-{22,24}.log, post-adapt-typecheck.log,
retry-esc-transport.log, lint-final.log, rebuild-final.log, clean-install.log,
artifact-smoke.log, and artifact-tui-checks.json. Earlier failing runs are
retained as full-first.log and esc-isolated.log. Baseline/focused logs and parser/PTY/output-risk JSON are also in logs/.

### Remaining limitations and approval boundary

The supported Node versions are now exercised locally, but only on macOS arm64;
Linux CI, Windows, and a physical Terminal.app key test are not claimed. Native
Shift state is simulated in automation; the real packaged native helper loads,
but no GUI-terminal keys or OS keyboard events were generated. The owner should
check physical Shift+Enter and Alt+Enter using the workspace build before asking
for any global update. Incomplete-response risk remains explicitly accepted.

No live model/API requests, external publication, CI dispatch, main merge, global
installation, OS preference, credential, application-version or release-identity
change was performed. The global installation remains Ink 0.5.0/pi-tui 0.82.0.
The second authorized review round must close before workspace completion.

## 8. Final-review findings and proposed remediation

Final reviewer e9d612e1 returned REQUIRED CHANGES: (P1) upstream can recreate a
removed default diagnostics directory with public umask permissions, and the
fixture sweep's ink-tui- prefix can remove that production directory; (P2)
upstream stops itself before throwing a width error, removing the process-exit
hook before Ink's title reset runs. Review reproductions are retained under
logs/review-{recreated-diagnostic-permissions,diagnostic-filemode,uncaught-width-title}.log.
The findings are valid and must close; earlier passing counts are pre-remediation.

The same reviewer approved the refined design below before production edits:

- Reserve a production-only ink-renderer-logs- prefix outside existing broad
  fixture prefixes; explicitly exclude it and descendant literals from the
  fixture generator. Add a regression rejecting inventory overlap in either
  direction (an ancestor fixture prefix or a descendant production literal).
- Capture default-directory device/inode, owner/group and private permissions.
  At doRender entry, preserve the stopped-state return and validate using lstat;
  override protected applyLineResets to preserve its behavior and validate again
  after both normal and overlay component rendering, before upstream logging.
  Detected missing/replaced/symlinked/widened directories or inspection errors
  stop the running TUI and throw a content-free error. Do not recreate, adopt,
  chmod or redirect the suspect path. Explicit overrides retain their contract.
  Do not change the process-wide umask: concurrent asynchronous tool writes
  could otherwise receive different permissions. Do not patch the filesystem.
  These checks detect unsafe state at both validation points, not atomically:
  external filesystem changes after the final check, between upstream mkdir and
  write, or to ancestor resolution remain possible. Checks cannot undo exposure
  of previously saved files after an external permission change. This separate
  filesystem limitation is not the accepted input-parser risk.
- Use protected afterTerminalStop (preserving the superclass hook) to clear the
  title for upstream-initiated stops,
  keep the direct-exit prefix, and remove the now-redundant shell title clear.
  Never restore the removed process exit listener or pop keyboard modes twice.
- Cover missing/replaced directories, symlinks, widened permissions and mutation
  during both normal and overlay rendering, with/without PI_TUI_DEBUG_REDRAW=1.
  Require no recreation or new diagnostic content on detected failure and retain
  explicit override behavior. Cover uncaught width and directory-failure paths
  with real PTY raw/cursor/title/keyboard restoration.
  Rerun affected tests, all full-runtime suites, lint/typecheck/build and the
  actual installed-artifact scenarios before closing the same final review.

Remediation design APPROVE received within the same final-review round before
implementation. No process-wide umask, filesystem monkeypatch or vendored renderer
was introduced. Closing evidence follows.

## 9. Closing implementation verification

The section 8 plan is implemented. The default directory now uses the reserved
ink-renderer-logs- namespace, with identity/owner/POSIX-mode checks at render
entry and after both normal and overlay component callbacks. Detected failures
stop the TUI and throw a content-free restart error; the suspect directory is
not recreated. Explicit caller overrides are not subjected to this guard.
The fixture generator excludes the namespace and descendant literals after
legacy-name normalization, and the inventory regression rejects overlap in
either direction. The remaining external-filesystem race is documented in both
published languages; no atomic security guarantee is made.

afterTerminalStop preserves the upstream hook and emits Ink's original OSC 2
window-title clear. Its ProcessTerminal setTitle API emits OSC 0 instead, so the
first remediation run correctly failed four exact OSC 2 assertions; using the
original window-only escape resolved this without relaxing the tests. Ordinary
close no longer writes a redundant title clear, while direct exit keeps its
synchronous prefix. The uncaught width-error and directory-validation-error
subprocesses both exit 1 with the intended error, clear the title once, restore
raw/cursor modes and balance Kitty, paste and modifyOtherKeys transitions.

The final transport file has 41 tests: retained keyboard/response/lifecycle
coverage plus 12 guard cases (missing/replaced/symlink/permissions/normal-render/
overlay-render mutations, each with redraw logging off/on), explicit override
recreation, and the two uncaught PTY failures. The fixture-sweep file has 5 tests.
Focused closing rerun: 4 files / 48 tests passed, including both Esc repros.

| Runtime on macOS arm64 | Closing full test files | Closing full tests | Typecheck |
| --- | --- | --- | --- |
| Node 22.19.0 | 158 passed | 4,147 passed | passed |
| Node 24.22.1 | 158 passed | 4,147 passed | passed |
| Node 25.5.0 | 158 passed | 4,147 passed | passed |

The same maxWorkers=2 / UV_THREADPOOL_SIZE=16 / isolated / network-blocked
configuration was retained. Build, lint, docs/identity checks and helper syntax
checks passed. Regenerating the fixture inventory is reproducible.
Offline package smoke again passed 427 allowed files and an isolated install.
The actual installed artifact additionally passed 75 cases (25 per Node version),
including all new diagnostics and uncaught-crash cases as well as input routing,
real native-addon loading, ordinary shutdown and trust handoff.

Closing evidence under the same scratch logs/ directory:
closing-full-{22,24,25}.log, closing-typecheck-{22,24,25}.log,
remediate-focused-final.log, remediate-build-title.log, closing-lint.log,
artifact-smoke-final.log, artifact-tui-final.log and artifact-tui-final-checks.json.
Final reviewer e9d612e1 returned APPROVE, closing the same second authorized
review round and both required findings. The reviewer independently reran 4
files / 48 tests, reproduced all 318 generated inventory entries without writing
repository files, checked closing evidence and found no remaining required
changes. Review evidence: review-closing-{focused,generator-readonly,evidence-readonly}.log.
The earlier design APPROVE and this final implementation APPROVE complete the
two authorized independent review rounds. At review closure, physical
Terminal.app input and non-macOS execution were unverified. Subsequent owner
acceptance is recorded below. No main merge, global install, external
publication, CI dispatch or live provider call occurred during implementation.

## 10. Owner acceptance and integration authorization

On 2026-11-10 the owner reported running the latest workspace build in the real
Terminal.app and confirmed that Shift+Enter works correctly. This closes the
physical Shift+Enter acceptance check with owner-supplied evidence; it does not
claim a physical Alt+Enter test or Linux/Windows execution.

After reviewing the change breakdown and release sequence, the owner approved
local commit and --no-ff integration of this fix and requested continued progress
toward a 0.5.1 patch release. Version preparation and artifact validation belong
to a separate release batch. Sensitive external actions and additional paid
review operations remain subject to the required per-operation confirmations.
No global installation update is included in the release goal.
