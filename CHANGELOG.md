# Changelog

All notable changes to Bulba are documented here.

## [0.1.0] - 2026-08-09

Initial release.

- MEA development loop (Manager-Execute-Audit, per arXiv:2608.01964) in both interactive mode and the headless driver.
- Intake gate: name/stack/success-criteria questions, plan waits for user approval (`AWAITING_APPROVAL` -> `/go`).
- Verify gates: clean git tree, ticked checklist, `## Review` with >= 2 findings, `verify.md` newer than the last commit, `features.json` all passing, CI check.
- Enforcer: idle nagging with stall detection, todo enforcement via the session todo API, memory compaction, auto-summarize.
- 14 specialist subagents (planner, implementer, reviewer, verifier, researcher, critic, debugger, benchmarker, paper-explainer, optimizer, webdev, security, skillfinder + primary bulba).
- 24 commands: develop, away, overhaul, plan, publish, goal, verify, audit, study, research, skill, test_ui, design, orchestrate, simplify, security_review, ci, go, critique, retro, danger, usage, docs, graph.
- Driver: MEA loop with structured audit verdicts, snapshot guard (fail-closed on mutation), worker pool with task dependencies, git worktrees, resume after crash, session timeouts, systemd/bwrap sandboxes, harness-agnostic (opencode/claude/codex).
- Memory: memory.md, session archive, lessons, search_memory tool, auto-summarize.
- No-slop: deterministic scan of edits (em-dashes, filler, commented-out code, comments repeating code).
- Hard guards: destructive git/fs commands denied, python/shell file edits blocked, AWAY auto-permission gate, strict mode (execution only via the driver).
- Danger mode: sudo via SUDO_ASKPASS with the password invisible to the model, safety-check rules.
- Cross-platform (Windows/macOS/Linux); sandbox is Linux-only and opt-in.
- Zero runtime dependencies, no telemetry.
