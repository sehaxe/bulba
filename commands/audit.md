---
description: "Audit the diff for over-engineering and AI slop -> deletion list"
---
AUDIT git diff (ponytail ladder):
- Unneeded: deletable (YAGNI), replaceable by stdlib/platform/one line.
- Single-use abstractions, config for constants, "for later" boilerplate.
- AI slop: obvious comments, filler, bloated responses.
Output: file:lines -> remove what + why. Don't touch code. No praise.
