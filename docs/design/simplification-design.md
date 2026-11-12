# Remove redundant implementation paths

Status: APPROVED (revision 2); implementation in progress.
Design review: independent adversarial reviewer d180068c, initial NEEDS-FIXES
(4 blocking concerns), revision 2 APPROVE; all four concerns closed before code.
Base: main@e02e464 (package 0.6.0)

## Goal

Reduce mechanisms identified by the repository-wide review without removing
supported workflows or weakening concurrency, recovery, authentication, terminal
sanitization, or accounting guarantees. Prefer deletion and ordinary functions;
do not introduce a resource framework, provider registry, or configuration service.

## Work packages

### A. Presentation

- Remove ReplMachine's unreachable private showResultFold path, its imports and
  private constants. Keep exported Shell/Fold compatibility APIs and legacy/print
  output behavior; removing package-visible APIs is not needed for this batch.
- Stop constructing argument blocks/labels for non-task activity rows. Keep the
  prepared call snapshot and hook timing used by the actual transcript sink.
  Keep exported activity fields if compatibility requires them, without computing
  an unused rich projection. Task/child labels, source identities, queue/running
  times, selector behavior and finalization must remain correct.
- Reuse physical-row offsets instead of rescanning graphemes where existing
  layout strategies permit. Delete the unused firstSuffix path. Preserve narrow
  terminal clipping, raw/semantic coverage, styles, diff numbering and row caps.
- Keep child result-hook invocation timing: it is an existing tested extension
  contract even though the current activity UI discards its return value.

### B. Providers

- Extract pure model-reference types/parse/format from provider construction.
  Preserve existing resolve.ts exports by re-exporting pure helpers; migrate
  metadata/core consumers to the pure module. Move the combined catalog/thinking
  max-output query out of catalog's bottom layer to break that remaining cycle;
  resolve.ts keeps its existing helper exports. modelMaxTokensFor moves to a
  model-limits module (including direct source/test imports); catalog must not
  re-export it, since that recreates the cycle. This undocumented internal
  module export relocation is an explicit exception, not a claim that all deep
  package imports are stable. Dependency direction: model-ref -> model-speed;
  catalog -> model-ref; thinking -> catalog; model-limits -> catalog + thinking;
  resolve -> model-ref + provider constructors. Preserve exact catalog-hit
  semantics, including omitted maxTokens/reasoning:false, not just known caps.
- Retain one catalog Map containing models and validation metadata. Remove the
  redundant overlay index and unused Last-Modified state; old extra disk fields
  remain harmless. Preserve source boundaries, ETag, TTL, single flight, atomic
  writes, offline behavior and input sanitization.
- Discovery returns endpoint results or null, not hidden static fallback data.
  The model-list policy alone applies catalog then a shared static seed set.
  Preserve the union of currently available static choices (Moonshot included),
  authoritative empty subscription listings, redirected-endpoint honesty,
  credential routing, current selection and Fast behavior. Cover the real wiring,
  not just a picker with a mocked discovery return. Update providers.md.

### C. Settings

- Read global/project settings once per /settings projection and derive both
  effective values and sources from that snapshot. Keep effectiveSettings as a
  convenience wrapper. A small snapshot function is sufficient, with no cache.
- Preserve live /settings reads vs construction-time Runner snapshots, nested
  merge, unknown-key writes, env shadows, trust gating and all startup/resume
  precedence. Do not combine this refactor with changing startup trust timing or
  collapsing independently exported trust parameters.

### D. Child maintenance

- Remove the redundant Runner-supplied getToolsForCwd factory. Keep task's older
  optional host interface as a compatibility fallback for non-Runner callers.
- Keep the exported continuation-verdict diagnostics and return behavior in this
  batch; removing them is not a private dead-code deletion. Do not add a second
  fast/diagnostic validation API just to avoid this scan. Keep abandoned-branch
  settled-record tests, refusal reasons, fingerprints and post-lease re-read.
- Replace automatic migration of the pre-release single-file lease artifact with
  conservative refusal when a non-directory occupies the lease path. Do not
  unlink that artifact. Current directory-candidate leases and all cross-process
  exclusion/recovery rules remain unchanged. Classify with lstat before any
  read: files, FIFOs, symlinks and other non-directories refuse without reading,
  unlinking or creating candidates. Test dead/old/fresh/foreign cases for byte
  preservation and refusal. Document manual inspection in subagents.md.

### E. Test infrastructure and CI

- Replace string-derived stale-prefix inventory with private run roots. Vitest
  global setup creates a unique 0700 root under the original OS temp directory
  and redirects TMPDIR/TMP/TEMP before workers are created. Existing per-test
  cleanup, settings-setup sandbox cleanup and FIFO-owned cleanup remain the
  only recursive deletion mechanisms. No global recursive run-root deletion.
- Global teardown restores exact original environment (delete originally absent
  keys) and attempts only rmdir on its own root: nonempty roots are retained and
  their path reported. Thus retained visual artifacts, unknown FIFO containment
  and killed-worker leftovers cannot be erased by ancestor cleanup. Cancellation
  and global-setup errors restore environment and never delete nonempty roots.
  Do not enumerate the OS tmpdir, infer ownership from names, or implement an
  automatic stale-data sweep. Abandoned/nonempty runs are intentionally retained
  for manual inspection; they add one OS-temp entry per run rather than placing
  all fixtures there. This changes the old test-only 24h sweep behavior; update
  the fixture-hygiene document and artifact comments accordingly. The root has no
  marker/PID protocol because it never authorizes deletion of any contents.
- Retire the obsolete prefix inventory/generator and replace their tests with
  tests of the real root lifecycle (empty vs nonempty, external/diagnostic data
  untouched, exact env restoration, setup failure). Add a real Vitest bootstrap
  probe proving worker and Node+tsx child tmpdir containment and inherited
  network preload. Preserve offline guard, sandboxed HOME/config and FIFO tests.
- Convert lease roles to plain Node + tsx workers, not nested Vitest runs. Keep
  real lease calls, readiness barriers, scenarios, network preload, isolated
  configuration, stderr diagnostics, bounded termination and exit-code checks.
  Every barrier timeout throws rather than silently continuing. The parent
  owns a deadline and cleanup handle; use finally to terminate and await child
  close on failed parent assertions too, with bounded escalation and stderr,
  role/marker/exit diagnostics. Node+tsx uses --import (not a supervising tsx
  CLI), and the inherited network preload runs before source modules. Parent
  tests remain Vitest; role files are no longer placeholder tests. Test a worker
  that never signals readiness and a failed/unknown role as well as real races.
- Exclude docs/design/** from Pages path triggers; retain manual dispatch and
  all real site input/build/dependency triggers. Add a structural regression.

## Intentionally not included

Do not remove exported Fold APIs, change child result-hook timing, rewrite trust
policy, aggregate pricing slices without measurement, or redesign package-smoke's
npm cache format. These have compatibility or evidence gaps. Keep the agent loop,
session format, compaction algorithm, MCP protocol layers, OAuth and pricing
semantics intact. No package/global installs, network publication, or user-state
migration is part of this work.

## Verification and acceptance

Each package adds or adapts focused regression tests and runs its focused tests
plus typecheck/lint as appropriate. Tests should assert current behavior rather
than preserve removed private computations. No removal of safety regressions.
After integration: npm run typecheck, npm run lint, npm run build, npm test.
Run npm run package:smoke when changes affect install/runtime module layout,
using workspace-local runtime destinations and the existing offline fixture.

An independent implementation review must check safety boundaries and production
call chains, including unchanged output paths, real discovery-to-picker fallback,
setting values/source consistency, fixture ownership and process liveness. Fix
blocking findings and repeat relevant tests before completion. Integrate reviewed
work through --no-ff merges; main must remain clean. Record exact results here
and summarize the batch in CHANGELOG.md and PROJECT_PLAN.md.
