---
description: "UI/E2E tests for the local app (webapp-testing skill)"
---
TEST-UI: QA the local web app. $ARGUMENTS
1. Load webapp-testing skill (see /skill webapp-testing): webfetch raw.githubusercontent.com/anthropics/skills/main/skills/webapp-testing/SKILL.md if not installed.
2. Follow its Playwright workflow: start app (dev/build per project), test critical paths of $ARGUMENTS, screenshot failures.
3. Report per test: pass/fail + evidence (screenshot/console). Fix nothing unless asked.
4. No Playwright? Say what to install; don't switch frameworks.
