---
description: "Publish: push + PR (with git safety)"
---
PUBLISH current branch. $ARGUMENTS
1. git status, git diff HEAD, git diff default...HEAD (ALL commits, not just latest), gh pr view --json number.
2. Safety: no git config changes, no skipped hooks, no force-push, no interactive flags, no secrets.
3. Uncommitted? Commit it (git log style; no history -> conventional).
4. Push branch.
5. PR: gh pr create (title < 70 chars):
## Summary
## Test plan
PR exists? Update description. Report: branch, commits, PR link.
