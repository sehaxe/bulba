# Bulba

Native OpenCode V2 setup: agents, commands, skills, always-on rules. Markdown only — zero plugin code (V1 plugins do not run in V2, so the old plugin was removed entirely, nothing ported).

## Layout

| Dir | What |
|---|---|
| `agents/` | 14 agents: `bulba` (primary router, default) + 13 subagents — planner, implementer, reviewer, verifier, debugger, benchmarker, paper-explainer, optimizer, webdev, security, skillfinder, researcher, critic |
| `commands/` | 29 commands: dev loop (`/develop` `/plan` `/go` `/verify` `/publish` `/status` `/goal`), research/docs/quality, tutor `/teach`, ponytail set `/ponytail*` |
| `skills/` | 14 skills (see Provenance) |
| `AGENTS.md` | Always-on rules: ponytail (full level) + Bulba core |

## Install

The repo is the source of truth; the global config gets symlinks:

```sh
ln -s "$PWD/agents"    ~/.config/opencode/agents
ln -s "$PWD/commands"  ~/.config/opencode/commands
ln -s "$PWD/skills"    ~/.config/opencode/skills
ln -s "$PWD/AGENTS.md" ~/.config/opencode/AGENTS.md
```

Plus `"default_agent": "bulba"` in `~/.config/opencode/opencode.jsonc`. Providers stay unset — pick the model in the TUI.

> Gotcha: a running opencode service rebuilds its agent registry on **config value changes** (or restart), not on plain edits to `agents/*.md` — edited agents show up after the next launch or a config change.

## Key flows

- `/develop` — Manage-Execute-Audit loop: plan → questions → tasks → subagents → commits → adversarial review → verify gate → report. No push without `/publish`.
- `/teach <topic>` — tutor mode: loads the `teach` skill (mission-grounded, evidence-based: retrieval, spacing, interleaving), HTML lessons + reference docs, stateful workspace the agent picks.
- `/away` — work autonomously until the user returns (plain prompt, no permission hacks — V2 allows all by default).
- `/research` — deep research on the built-in websearch/webfetch, cited report in `.bulba/research/`.
- `/overhaul`, `/critique`, `/simplify`, `/audit`, `/security-review`, `/graph`, `/test-ui`, `/design` …
- `/ponytail [lite|full|ultra|off]` — level switch; always-on at **full** via `AGENTS.md`.

## Philosophy

Trust, not enforcement: **zero deny-rules**. Read-only roles (planner, reviewer, security) are stated in prompts, not permissions. Outward actions (push, PR, delete, creating CI) ask the user. Nothing auto-nags; state lives in `.bulba/` (plan.md, goal.md, memory.md, lessons.md — per-project scratch, gitignored there).

## Provenance (skills keep their original IDs)

- `grilling`, `grill-me`, `teach`, `to-spec`, `diagnosing-bugs`, `writing-for-agents` — [mattpocock/skills](https://github.com/mattpocock/skills)
- `unslop`, `blast-radius` — [cursor/plugins](https://github.com/cursor/plugins) (pstack)
- `ponytail`, `ponytail-review`, `ponytail-audit`, `ponytail-gain`, `ponytail-debt`, `ponytail-help` — [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) (ruleset also inlined in `AGENTS.md`)

User-invoked-only skills (`grill-me`, `to-spec`, `blast-radius`, `teach`) carry `metadata.opencode/autoinvoke: false`; `unslop` stays model-visible. Slash entries for `teach` and `ponytail*` belong to the command files (`slash: false` on those skills).
