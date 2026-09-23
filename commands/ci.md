---
description: "CI/CD: check the last run, fix failures, or propose creating a pipeline"
---
CI: check the project's CI/CD. $ARGUMENTS
1. Detect: gh installed + git remote github? -> GitHub Actions. No gh/remote? -> say what CI would fit (GitLab/others) and stop.
2. Check: gh run list --limit 1 - the latest run status. If a run is failing: read its logs (gh run view --log), fix the cause, push, re-run (gh run rerun or push), wait for green.
3. No CI files? PROPOSE creating .github/workflows/ci.yml: match the stack (bun/npm/pnpm, cargo, pytest, go test...) - build + test + lint, cache deps. Ask the user FIRST (question tool) - creating CI is an outward action; without consent, just describe the plan.
4. Report: workflow file, run status, failure fixes.
