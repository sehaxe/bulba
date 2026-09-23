---
description: "Autonomous codebase overhaul: fewer lines, higher quality, ZERO functionality loss, maintainable"
---
OVERHAUL: autonomous codebase rewrite. Goal: fewer lines, higher quality, ZERO functionality loss, maintainable. $ARGUMENTS

P0 INVENTORY (read-only, into .bulba/overhaul/):
- inventory.md: modules, files, LOC per module, tech debt notes, current structure tree.
- behavior.json: THE functional contract - every observable behavior: CLI commands/flags, API endpoints, config keys, algorithms, edge cases, error behaviors. Format: [{"id","module","behavior","check":"test command or manual steps","passes":false}].
- conventions.md: target conventions/architecture (from AGENTS.md/docs/style; none? propose) + gap analysis per module: merge/split/delete/rename with reasons.
P1 BASELINE: run FULL tests + typecheck + lint now; record counts in .bulba/overhaul/baseline.md. The suite must NEVER go below this during the overhaul (0 skipped, 0 deleted).
P2 ARCHITECTURE (structure first, internals later): design the TARGET structure in conventions.md - directory tree, module boundaries, package/crate layout, split/merge/rename decisions, public API shape. Use the explore map/graphify to inform it. Apply it in MECHANICAL steps: one move/split/rename per commit (git mv + import updates, zero behavior change), full suite green after EVERY step. Never restructure and rewrite in the same step.
P3 REWRITE (MEA + adversarial review, one slice at a time - never the whole codebase at once):
- Slice = one module or one convention change, IN THE NEW STRUCTURE. For each slice:
  1. Rewrite it (fresh context: bulba-implementer subagent), follow conventions.md, keep the public API compatible.
  2. ADVERSARIAL REVIEW (Bun-style): spawn 2 bulba-reviewer subagents (fresh contexts), each gets ONLY the slice diff + "Assume the code is wrong. Find: bugs in untouched lines of modified functions, races, async close/resource release, lost await, inverted conditions, off-by-one, null derefs, swallowed errors, copy-paste renames. No praise - findings with path/line + why broken." No reasoning passed to reviewers. Fix each finding as own commit.
  3. AUDIT the slice: run its behavior.json checks + the FULL test suite. Slice done only when: all behavior checks pass, full suite green, review findings fixed.
  4. Commit the slice (revertable), tick it in plan.md, flip its behavior checks to "passes": true.
- Order: foundations first (utils, core), then dependents. Never leave the tree red between slices.
P4 FINAL VERIFY: full suite + typecheck + lint green; behavior.json ALL passes:true; nothing deleted (diff behavior against the pre-overhaul inventory).
P5 REPORT: before/after table (LOC, files, modules, structure tree, test count), what was merged/split/deleted/renamed, remaining debt. NO PUSH.
