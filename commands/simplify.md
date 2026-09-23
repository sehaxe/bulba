---
description: "Clean up the changed code quality (Claude /simplify style): 4 angles in parallel + fixes"
---
SIMPLIFY the current diff (Claude /simplify style):
1. Gather git diff, then launch 4 review subagents in parallel (task tool, "general", same message) - each gets the diff + ONE angle:
  a) Reuse: duplication replaceable by an existing helper.
  b) Simplification: over-complex expressions, needless branches.
  c) Efficiency: repeated work, sequential independent ops, heavy hot paths, closure leaks.
  d) Altitude: special cases on top of general infra -> generalize the mechanism, not patches.
2. Wait for all 4; dedupe by line/mechanism; fix directly (each fix = own commit, tests after).
3. Skip (with a note, no arguing): intentional behavior change, far outside diff, false positive.
4. Final: "fixed / skipped" summary or "already clean". This is quality cleanup, not bug hunting (that's /critique).
