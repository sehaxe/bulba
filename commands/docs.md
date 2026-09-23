---
description: "Generate/refresh AI docs (.ai-docs, compact and factual)"
---
DOCS: refresh .ai-docs/ for agents: facts only, no prose. $ARGUMENTS
1. INDEX.md - index: file, one-line desc, "read when" (<=30 lines).
2. CODEBASE.md - map: top-level folders, one line each (agent TOC). Huge repos: per-directory doc files.
3. Files (<=80 lines each): architecture.md (modules, data flow, connections), commands.md (real commands + gotchas), conventions.md (style, what NOT to do), decisions.md (decision -> why -> revisit when).
4. No dupes (index -> files), stale -> "STALE: reason", don't describe the obvious.
5. Move stale/reference from memory.md into docs; memory keeps fresh only.
6. Report: created/updated + line counts.
