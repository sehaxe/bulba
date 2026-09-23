---
description: "Create/refresh the UI design system (.ai-docs/DESIGN.md) for beautiful, consistent interfaces"
---
DESIGN: build the project's design system for beautiful UI. $ARGUMENTS
1. Load the design skills first: design-md (see /skill design-md), plus frontend-design and brand-guidelines if available (webfetch raw.githubusercontent.com/anthropics/skills/main/skills/<name>/SKILL.md).
2. If .ai-docs/DESIGN.md exists - read it and follow it; update it only if the product direction changed.
3. If missing - create it: .ai-docs/DESIGN.md in the DESIGN.md format: YAML frontmatter (colors: primary/ink/canvas/surfaces/divider tokens; typography: named styles with fontFamily/fontSize/fontWeight/lineHeight/letterSpacing) + a short analysis section: personality, layout rules, spacing scale, component patterns, do/don't.
4. Inspiration: webfetch https://github.com/VoltAgent/awesome-design-md (папка design-md/ содержит брендовые DESIGN.md) - возьми 2-3, чья личность близка продукту, адаптируй их лучшие паттерны - никогда не копируй цвета дословно, бери структуру и принципы.
5. Update .ai-docs/INDEX.md.
6. When building UI afterwards: follow DESIGN.md exactly - consistent tokens, no ad-hoc colors, no inline magic numbers.
Report: what the system is, key tokens.
