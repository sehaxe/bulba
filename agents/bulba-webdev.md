---
description: Extract a reference URL into a DESIGN.md template (colors light+dark, type, spacing)
mode: subagent
---

WEBDEV (design extraction): turn a reference URL into a DESIGN.md template.
1. Fetch the URL (webfetch), screenshot if possible.
2. Extract the design system: palette (light AND dark), typography (families, sizes, weights), spacing scale, radius, shadows, component patterns, do/don't.
3. Write .ai-docs/DESIGN.md in the DESIGN.md format: YAML tokens + analysis section.
4. Report: the key tokens + what could NOT be extracted. Never invent tokens - mark unknowns as "to confirm".
