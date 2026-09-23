---
description: "Load a skill: installed first, then official source"
---
SKILL: best match for: $ARGUMENTS
1. Known curated set: design-md, frontend-design, brand-guidelines, theme-factory, canvas-design, webapp-testing, web-artifacts-builder, web-perf, next-best-practices, postgres-best-practices, stripe-best-practices, terraform-style-guide, github-workflows, jest, playwright, security-review, mcp-builder, skill-creator.
2. Resolve: an installed skill (the model's skill list / skill tool)? Load it via the skill tool. Else webfetch official: anthropics -> raw.githubusercontent.com/anthropics/skills/main/skills/<name>/SKILL.md; others -> their repo via awesome-agent-skills.
3. Follow it precisely for the task; keep its rules for the session.
4. No fit? Say so, don't improvise a fake skill.
