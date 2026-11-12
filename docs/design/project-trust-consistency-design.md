# Project resource paths and session-trust plumbing

Status: COMPLETE; design and independent implementation reviews closed.
Independent adversarial design review 342be05f: APPROVE, no required fixes,
closed before implementation.
Base: main@ace8fa7

## Goal and bounds

Share the resource path facts currently duplicated by trust detection and
loaders, and pass one session trust decision into Runner and MCP. Do not add a
resource manager, common scanner, generic loading schema, permission registry,
or live configuration cache. This is a compatibility-preserving refactor of
normal CLI behavior, not a new trust policy or filesystem sandbox.

## A. Shared path facts

Add core/resource-paths.ts containing only relative path constants for the four
.ink resource directories (extensions, agents, commands, skills), settings.json,
SYSTEM.md, APPEND_SYSTEM.md, the .agents/skills relative path, and the ordered
project MCP names [.mcp.json, mcp.json]. A plain projectMcpConfigPaths(cwd) helper
joins these names; it performs no I/O, realpath, discovery, caching or consent.

Use the constants in trust detection, extensions/agents/commands/skills loaders,
settings path helpers, system-prompt discovery, MCP discovery and CLI's disabled
resource filtering. The existing exported settings and MCP path functions stay
available. The three global MCP paths and ordering are unchanged. Both MCP's
project gate Set and default discovery list use projectMcpConfigPaths; trust
detection uses the same names. Full paths overrides keep their existing lexical
matching semantics, not new realpath containment. User-global resources and
explicit CLI paths do not become project resources.

Preserve the current distinct checks: directories for four .ink tiers;
exists-only for project settings and ancestor skills; isFile for SYSTEM and MCP
trust detection. Preserve each loader's current error handling and symlink
behavior, collision precedence, source/origin labels and home==cwd behavior.
Do not move or reimplement the already shared ancestor skills traversal in this
batch. Context AGENTS/CLAUDE files remain ungated. Trust discovery order and
relative display strings remain unchanged.

## B. One Runner session option with a bounded compatibility adapter

Add optional RunnerOptions.projectTrusted. CLI supplies it, rather than setting
three resource-specific options at both startup call sites. A private Runner
entry adapter derives the effective settings, agents and system-prompt booleans
once. Existing optional fields remain accepted and documented as legacy scope
restrictions. The adapter follows this complete rule:

- New option false: all three project resources denied, regardless of old true.
- New option true: all three allowed unless that resource's old option is false.
- New option absent: retain each old value and existing defaults exactly:
  settings=false, agents=true, system prompt=false.

An explicit resource false must never be widened by the canonical true. A
settings-only legacy true must not authorize agents/system beyond their old
behavior. The new canonical option accepts only boolean true as a grant; an
invalid non-boolean JS input is not a new authorization path.

Keep Runner.projectSettingsAllowed as the effective settings permission for
/settings reads/writes and source labels; do not add a required Runner getter
that would break structural mocks/embedders. Settings stay construction-time
snapshots, agents load once, system-prompt refresh continues to use the captured
permission. Never re-query the trust store at a loader to derive session trust.

Independent extensions/agents loaders retain their legacy default-allow
contracts. Required settings/system/commands/skills/MCP booleans retain their
current meaning. Unifying their defaults would be a separate behavior change,
not a hidden consequence of this refactor.

## C. MCP gets the decision directly

The private CLI createMcpSetup(renderer, runner, projectTrusted) receives the same
required session bit as the other loaders; it no longer infers general trust
from a setting-specific permission. Use runner.runnerCwd for config and server
cwd; in actual CLI that equals the startup cwd. Keep INK_MCP=0, effective
settings.mcp.enabled, async handshakes, run boundaries and close behavior.

Keep the session boolean in scope for both interactive and print setup. No
changes to trust resolution order: disabled-resource filtering, no-resource
short circuit, explicit flags, nearest persistent ancestor, interactive ask,
then noninteractive denial. In particular session-only approval does not write
a record; cancellation and undecided print/pipes deny without writing. Global
and explicit resources still load after a project denial. The early startup
model trust-store lookup and /model's existing untrusted-settings hint probe
are deliberately not changed or represented as universally gate-before-read.

## Regression evidence

- Literal resource path/order expectations independent of shared constants,
  plus actual loader/detection tests so merely changing both sides cannot pass.
- Resource-kind matrix: directory vs file, settings exists-only, SYSTEM/MCP
  file-only; preserve symlink behavior and canonical home exemption. Repair the
  mislabeled agents cwd==home test so it really uses the same directory.
- MCP: five-path order, both project names, gate-before-content-read, one skipped
  note, globals retained, full paths override unchanged. Keep real no-spawn CLI
  tests for denied MCP files.
- Runner option matrix across all old booleans/undefined and canonical states;
  assert settings, advertised project agent, actual SYSTEM/APPEND contents and
  refresh behavior. Retain old loader default tests without rewriting them to
  assume a different policy.
- Exercise the actual resolveProjectTrust session-only and cancel branches,
  without importing CLI's top-level main. Existing TypeScript-AST extraction is
  acceptable; supply real sandbox trust/path helpers. Assert no store creation
  or changes to unrelated records. Cover resolved grant and denial reaching
  real Runner resource loaders and MCP discovery. Check actual interactive and
  print call wiring (not merely a copied boolean in a test helper); test private
  MCP setup with a differing process cwd vs runner cwd.
- Verify explicit -e/--skill and global resources survive denial, nearest
  ancestor behavior, disabled discovery and existing empty-resource behavior.

## Delivery

Use dedicated worktrees, preserve pre-existing user changes, and merge --no-ff.
Run focused tests during implementation, then typecheck, lint, build, all tests,
and offline package smoke (read-only source cache, workspace-local destinations).
No external API requests, global installation, trust-store migration or
publication. Disable npm update notifier and use an offline workspace-local npm
cache for verification. Independent implementation review is required because
this touches security-related plumbing. Document canonical option/legacy
compatibility and session-only authorization in published docs in both languages;
update CHANGELOG and PROJECT_PLAN with exact results after review closes.

## Acceptance

- Implemented in dedicated project-trust paths/wiring worktrees and integrated
  with --no-ff. Only path facts are shared; no generic scanner or policy
  registry was introduced. Existing resource-kind checks, source precedence,
  alias handling and old independent-loader defaults remain unchanged.
- Independent design review 342be05f APPROVE before implementation. Independent
  implementation reviews 644a04ec (paths/loaders) and 5b3b63c3 (CLI/Runner)
  both APPROVE; no required fixes remain.
- Added 364 cases: 2 literal path checks, 66 real filesystem path/kind/boundary
  cases, 270 canonical/legacy permission combinations and 26 actual private-CLI
  declaration integration tests. Tests include session-only no-store creation
  and unchanged existing trust bytes, both CLI startup paths and independent
  MCP session permission/runner cwd. CLI tests replace terminal and selected
  setup boundaries; they are not full real-terminal end-to-end tests.
- Verification: npm run typecheck PASS; npm run lint PASS (345 files, docs
  parity/routes/anchors and legacy-name checks PASS); npm run build PASS;
  npm test PASS (185 files, 5,648 tests). Local log:
  .vitest-cache/trust-integration-tests.log (not committed).
- Offline package smoke PASS: 454 allowed files, modes, isolated install,
  help/version and local npm-exec inference. Existing source npm cache was
  read-only and all artifact/cache writes remained under worktree runtime.
- A child's workspace-local temp override produced two environment-dependent
  baseline failures (Git ancestry / cwd-substring assumptions), reproduced
  without changes. Integrated full tests use the standard private run roots
  and pass without altering those assertions or weakening isolation.
- Public index/settings pages are updated in English/Chinese; CHANGELOG and
  PROJECT_PLAN record this batch. No credential/trust-store migration, external
  API request, global package change or publication was performed.
