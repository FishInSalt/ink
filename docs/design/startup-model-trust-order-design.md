# Resolve startup model defaults after session trust

Status: APPROVED; implementation in progress.
Independent adversarial design review 8e983a26: APPROVE, no required fixes;
closed before implementation.
Base: main@7ce141f

## Problem and scope

CLI currently resolves project defaultModel while parsing arguments, using only
pre-existing persistent trust. First --trust, an interactive yes, false-to-true
--trust, and session-only approval therefore load project resources without
applying their model default to that startup. Print may fail credential checks
before even evaluating the new trust decision. Interactive may announce a
builtin fallback before it learns the project has a configured model.

Fix the CLI ordering only. Do not change Runner's saved/model-less recovery
policy, subscription billing protection, builtin model, auth probes, catalog
refresh timing, trust resolution policy or the unrelated /model hint's content
probe of untrusted settings. Do not add a configuration service or new framework.

## Selection stages

1. parseArgs captures command-line flags and the current INK_MODEL selection.
   requestedModel becomes pure env-or-builtin initialization; neither it nor the
   parser reads settings/trust, performs discovery, or applies provider fallback.
   Only -m/--model sets modelExplicit. Keep INK_MODEL !== undefined semantics,
   including empty strings; preserve last-model/last-trust-flag wins. Do not
   pre-scan raw argv (a flag-looking prompt is a value, not a trust decision).
2. During actual startup resolveProjectTrust runs exactly once as before. Its
   returned session bit, including temporary approval, is the only permission
   used for the project default. Never re-query persistent trust for selection.
3. One private CLI helper applies configured defaults unless the selection is
   already CLI or env: project defaultModel (if permitted), then global, then
   builtin. Use loadSettingsSnapshot to derive both value and source from the
   same reads. Update opts.model/modelSource together, never modelExplicit.
4. Apply existing D2 decision only after defaults. Explicit configured sources
   never get replaced under the fresh-start policy. Usable builtin remains
   preferred as before; an unusable builtin can use existing unique-family
   fallback. No login, model discovery or new network operation is introduced.

The parser may retain the builtin placeholder in its existing required model
field; RunnerOptions.model need not become optional. No source state is persisted
before the existing Runner persistence points. Global settings reads needed for
interactive display still happen as before, but parser/quick-exit model selection
has no config/trust I/O. sessions/login/logout remain unchanged quick branches.

## Interactive order

Renderer and startup-note deferral -> trust -> configured defaults -> existing
D2 decision/note -> extension/skill/command setup -> Runner -> MCP -> REPL.
The fallback note must not claim no default was configured after a project
default was approved. Cancellation/denial uses global or builtin, never reads
project settings for selection. Stored/temporary grants behave identically for
this startup; only the existing resolver decides persistence.

## Print order and observable effects

Attachment validation stays first. Then trust -> configured defaults -> existing
printModelUnusable (including D2) -> all extension/skill setup -> Runner -> MCP.
No extension, even global or explicit -e, and no Runner/session/log/MCP is created
before successful preflight. Preserve exit 1 and empty stdout for any startup
trust/credential failure before loaders. Actual streaming/provider failures and
resume notes retain existing output behavior.

Buffer only renderer.note calls emitted while resolving print startup trust.
Restore the original note method on every exit. On successful preflight flush
notes through the original method before loading extensions, preserving successful
output order. On failed preflight or trust/setup selection error emit pending
notes on stderr before the existing error, keeping stdout empty. Noninteractive
unknown-directory warnings already use stderr and remain there. A small local
array/drain is sufficient; do not add another renderer or generic sink framework.

This intentionally moves trust processing before credential failure even for
explicit/env selections. Therefore --trust/--no-trust can persist their decision
(or rebuild a corrupt store) and then fail model preflight. With resources, a
corrupt store without a recovery flag is diagnosed before missing credentials.
Document these effects. Trust writes are an explicit exception to no session/log
side effects. No-resource short circuit still precedes flags/store, and filtered
resources, canonical home behavior, session-only/cancel/noninteractive no-write
rules stay unchanged. Do not add an early preflight optimization in this batch.
main's pre-existing catalog refresh means this is not a promise of zero startup
I/O; only the existing session/log/code-loading boundaries are guaranteed.

## Restore and speed semantics: unchanged

Fresh startup: -m > env > allowed project default > global default > builtin,
then existing D2. Actual session restore: only startup -m overrides saved model;
saved {provider, modelId, speed} otherwise wins over env/settings defaults.
A model-less resume starts with the newly resolved defaults, then follows the
existing Runner D3 rule, including its non-Codex fallback behavior. Do not change
D3 to match fresh-start D2 in this batch. Existing subscription choices must not
silently switch to API-key billing; Fast stays part of the complete selection.
Restore without explicit -m continues to skip print's preliminary credential
check. Missing -c history and --no-session resume are fresh-start cases; invalid
or ambiguous resume errors remain Runner's responsibility. /resume after startup
and session persistence behavior remain unchanged.

## Regression and delivery

Write regression tests before source changes and demonstrate the first --trust
or session default bug fails on base. Reuse actual CLI AST extraction for the
in-memory TUI decision; do not import cli.ts and invoke top-level main. Use real
selection/trust/settings/D2/preflight code, not mocked requestedModel/preflight,
for the new integration assertions. Simulating terminal/stream execution is fine.

Cover first trust/yes/session, prior false->trust, denial/cancel/noninteractive,
recorded true->no-trust, repeated trust flags, flag-looking prompt, source and
explicit provenance, no project content read before trust, empty/blank selection,
project-specific unavailability vs builtin fallback, corrupt-store precedence,
no-resource short circuit, actual new defaults with Fast and saved/model-less
restore. Existing Runner/session tests must remain unchanged unless adapting a
parser-specific assumption. Revise old parser tests to distinguish pure parse
from post-trust defaults; do not remove their priority coverage.

Add real offline CLI fixture probes for first --trust print and pipe selection,
preflight failures with physical no session/log assertions (logging enabled),
loader execution witnesses, attachment-error priority, and help/version not
reading project settings even in a persistently trusted directory. Subcommand
quick paths can use AST main with injected command handlers; never actually log
in or contact an external provider. Local HTTP fixtures and network preload only.

Update English/Chinese CLI/settings/providers docs, distinguishing fresh vs saved
restore precedence rather than repeating the currently inaccurate linear chain.
Run typecheck, lint, build, full tests and offline artifact smoke; independent
implementation review is required. Use dedicated worktrees/branch and --no-ff
integration. Disable npm update notifier, offline workspace-local npm cache;
source artifact cache read-only, no global installs/publication/user-state edits.
