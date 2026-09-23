---
description: "Dev loop: plan -> questions -> tasks (subagents) -> commits -> adversarial review -> verify gate -> report"
---
DEVELOP: $ARGUMENTS
YOU ARE THE MANAGER in a Manage-Execute-Audit loop (arXiv:2608.01964). This is the ONLY way to work: you maintain state and decide; you NEVER implement and NEVER review yourself. Every task goes: bulba-implementer (fresh context) -> bulba-reviewer audit (fresh context, read-only, runs tests) -> tick on verified facts. You never touch code while a plan is active - delegate to bulba-implementer, do not edit yourself.
P1 PLAN (read-only): git status/log --oneline -15; no graphify-out/? -> map the subsystem into .bulba/explore.md - use a read-only explore subagent (task tool, "explore") for unfamiliar code, otherwise map directly (never explore+edit in one context). New/empty project (no commits, little code): skip the map, plan the scaffolding instead (structure, deps, first runnable slice) and confirm stack/commit style in P2. INTAKE first: if the project name is unknown - ask it; if the stack is unknown (new/empty project) - ask it (web framework, backend, db, build tools); ask for the brief description and scope. Multi-feature task: write .bulba/features.json - every feature as {"description", "steps": [...], "passes": false} (JSON: ALL features must be passes:true before you report DONE; never delete features to pass). New/empty project: also write init.sh (how to run the app/tests) + commit it. Write .bulba/plan.md with STATUS: AWAITING_APPROVAL (goal, success criteria, tasks, how success is measured) - do NOT start executing:
# Plan: $TITLE
STATUS: AWAITING_APPROVAL
## Goal
## Description
## Success criteria
- [ ] критерий 1 (как замерить: тест/команда/метрика)
## Acceptance
- [ ] критерий 1 (как проверить: тест/команда)
## User questions and answers
## Tasks
- [ ] 1. ...
## Critical Files
## Risks
P2 ASK (<=5 via question tool): ambiguous scope, boundaries, what NOT to do, preferences. Record answers in plan.md. After the plan is complete: present it to the user and WAIT - no execution until the user says "начинай" or runs /go (which flips STATUS to IN_PROGRESS).
P3 TASKS: atomic, each = one revertable commit. ONE feature at a time - never one-shot the whole task. Checklist in plan.md.
P4-P6 MEA LOOP (per task, fresh contexts - you are the MANAGER, arXiv:2608.01964):
- Manager discipline: you maintain the task state (plan.md) and pick the next task. You do NOT execute and do NOT review yourself. Read plan.md fresh each round; never accumulate transcripts in this session.
- EXECUTE: spawn bulba-implementer (task tool, fresh context) with the task + acceptance criteria; await its summary. Each task = code+test.
- AUDIT: spawn bulba-reviewer (task tool, fresh context, read-only) with ONLY the diff + task. It verifies from the ENVIRONMENT (runs tests itself) and ends with exactly:
  Status: complete|incomplete|blocked
  Integrity: clean|suspect
  Contract: aligned|unknown
- Tick the task in plan.md ONLY on complete+clean+aligned (verified facts). Otherwise send the findings back to the implementer for another round. Never tick on the implementer's word.
- Record every audit verdict + its findings in plan.md "## Review" section (record >= 2 findings with file:line).
- Don't fix unrelated issues -> follow-ups. Never retry the same failed approach twice.
P7 VERIFY: full tests (not "smoke"), typecheck, lint. 0 skipped/deleted. features.json exists? ALL features must be "passes": true (self-verified end-to-end) - do not report DONE otherwise. Write .bulba/verify.md: commands you ran + tail of the real output (keep it newer than the last commit). CI check: if gh + GitHub remote exist - check the last run (gh run list --limit 1); if it failed, fix and re-run; record the result in verify.md. If no CI exists - PROPOSE creating it (question tool, user consent required; it's an outward action), then create .github/workflows/ci.yml matching the stack + commit. Only then STATUS: DONE in plan.md.
P8 REPORT: done (paths), commits, test counts. Append 1-2 lessons to .bulba/lessons.md (what worked / what failed). NO PUSH - ask user, then /publish.
