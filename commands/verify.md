---
description: "Verify gate: honest proof that everything works"
---
VERIFY (readiness gate): prove everything works. $ARGUMENTS
1. Find + run FULL tests (package.json/README): bun test / npm test / pytest / cargo test etc. "Smoke"/"should work" don't count.
2. Confirm tests ran: sane count, 0 skipped, 0 deleted by you.
3. Typecheck + lint if present.
4. Red? Fix CODE (not tests, no skipping), repeat to green.
5. Report: commands, pass/fail/skip counts. Not ready? Say so.
