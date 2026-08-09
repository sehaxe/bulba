# Bulba

**The autonomous development agent for opencode.** A manager-execute-audit harness that plans with you, delegates to specialist subagents in fresh contexts, verifies every claim from the environment, and never says "done" without proof.

Built on two research foundations — [Anthropic: Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) and [LongHorizon-Harness (arXiv:2608.01964)](https://arxiv.org/abs/2608.01964) — plus the best practices of oh-my-openagent, Claude Code, Hermes and the Bun-in-Rust rewrite.

- **Zero runtime dependencies** — one plugin file, Node/Bun stdlib only
- **No telemetry** — everything lives in your `.bulba/` directory, every decision is a readable file
- **Cross-platform** — Windows / macOS / Linux (sandbox is Linux-only, opt-in)
- **Model-agnostic** — works with any opencode provider, including local ones (LM Studio, Ollama)
- **52 tests, CI included**

---

## The idea

Most agents are one long context window that rots. Bulba splits the work like a company:

```
                YOU (approve, steer)
                        |
                  ┌─────▼─────┐
                  │   bulba   │  primary agent: routes, plans, asks, approves
                  └─────┬─────┘
      ┌─────────┬───────┼────────┬──────────┐
      ▼         ▼       ▼        ▼          ▼
  planner   implementer  reviewer  verifier  researcher ...
  (read-    (fresh      (fresh    (full     (evidence-
   only)     context)    context,  tests,    based,
                        read-only,  typecheck,  5+ candidates,
                        assumes     lint)     verified vs
                        wrong)                speculation)
```

- **Interactive session = the brain**: intake questions → full plan → you approve → the main agent delegates to subagents, each in a **fresh context**, and ticks tasks **only on audited verdicts**.
- **`bulba-driver.mjs` = the hands**: a headless orchestrator that runs the same loop in isolated sessions and **worktrees**, with parallel workers, task dependencies, resume after crash, timeouts and optional sandboxes.

## Install

```bash
# via npm (once published)
npm i -g bulba            # or add to your project

# or from source
git clone https://github.com/sehaxe/bulba && cd bulba && bun install
```

Add to `opencode.json` (global or project):

```json
{
  "plugin": [
    ["bulba", {
      "driverPath": "/path/to/bulba-driver.mjs",
      "skillsDir": "/path/to/skills"
    }]
  ]
}
```

For a local checkout:

```json
{ "plugin": [["/path/to/bulba/bulba.mjs", {}]] }
```

Restart opencode, switch to the **Bulba** agent, and just write what you want — Bulba routes the request to the right workflow.

> **Minimum opencode version**: some enforcement relies on recent APIs (`session todo`, `run --agent`, background subagents). If a feature is unavailable, Bulba degrades gracefully.

## Quickstart

```
You:  сделай приложение для подбора комплектующих
Bulba: (intake) Как назовём? Стек? Какие источники данных? Критерии успеха?
You:  bulbamarket, bun + React, Onliner API, поиск и сравнение цен
Bulba: (writes plan.md, STATUS: AWAITING_APPROVAL) Вот план — цели, задачи,
       как замерим успех. Готов начать?
You:  начинай
Bulba: (MEA loop) implementer → reviewer (audits from the environment) →
       verify gate → task ticked. Commits per task, report at the end.
```

No commands to memorize — the primary agent routes. But everything is also available explicitly (see [Commands](#commands)).

## How it enforces (not just prompts)

| Mechanism | What it does |
|---|---|
| **Verify gate** | "Done" only when: git tree clean, checklist ticked, `## Review` with ≥ 2 findings, `verify.md` newer than the last commit, `features.json` all passing, CI green. The plugin checks these itself and pokes the model if it lied. |
| **Auditor (MEA)** | A read-only subagent verifies from the environment (runs the tests), returns a structured verdict `Status / Integrity / Contract`, and the manager ticks tasks **only on complete+clean+aligned**. A snapshot guard fail-closes if the auditor mutates anything. |
| **Todo enforcer** | Reads the session todo list via the API: no list → nudge to create it; incomplete items → nudge with count. |
| **Guard** | Destructive commands (`git reset --hard`, `rm -rf`, force-push, …) are denied at the permission level. |
| **No python-editing** | File edits via `open(...,"w")`/`sed -i` are blocked before execution — enforcement hooks only see the edit tools. |
| **No-slop scanner** | Every edit is scanned deterministically: em-dashes, filler phrases, commented-out code, comments that repeat the code. |
| **Stall detection** | No progress across N rounds (git HEAD / plan / memory unchanged) → stop nagging, save tokens. |
| **Intake gate** | No execution before the user approves the plan (`AWAITING_APPROVAL` → `/go`). |
| **Strict mode** | When active work exists, direct edits are blocked in the interactive session — execution only via the driver. |
| **AWAY gate** | In AWAY mode the plugin auto-answers permission requests: work allowed, outward actions (push, ssh, external dirs) rejected. |
| **Danger mode** | `sudo` via `SUDO_ASKPASS` — the password is typed by the user in their own terminal and is **unreadable** to the model (read/bash denied on the askpass file). Safety-check rules before every root command. |

## Agents (14)

| Agent | Role |
|---|---|
| **bulba** (primary) | Routes requests, runs the dev loop, the brain of the system |
| **bulba-planner** | Read-only planning: questions, plan.md, success criteria |
| **bulba-implementer** | Executes one task: code + test + commit |
| **bulba-reviewer** | Adversarial auditor: assumes the code is wrong, verifies from the environment, structured verdict |
| **bulba-verifier** | Runs the full test suite / typecheck / lint until green |
| **bulba-researcher** | Deep research on **anything**: 5+ candidates, sources next to every fact, `VERIFIED` vs `SPECULATION` split, health guardrails (PubMed/WHO, never blogs) |
| **bulba-critic** | Hostile review of your ideas: flaws, cheaper alternatives, the experiment that would falsify the verdict |
| **bulba-debugger** | Evidence-based triage: reproduce → log → hypothesis → bisect → minimal fix |
| **bulba-benchmarker** | Honest measurements: median + p95, same conditions, no cherry-picking |
| **bulba-paper-explainer** | A paper down to implementation: method, formulas, hyperparameters, code sketch |
| **bulba-optimizer** | Max-out optimization, system-aware: profile, one change, re-measure, never overload the machine |
| **bulba-webdev** | Extracts a reference URL into a DESIGN.md template (light + dark themes) |
| **bulba-security** | Total audit: code, dependencies, system, config — read-only, exploitability-first, verified vs suspected |
| **bulba-skillfinder** | Finds an existing skill or drafts a temporary one; **never installs anything from the web without your explicit consent** |

## Commands

| Command | Purpose |
|---|---|
| `/develop` | The full loop: intake → plan → MEA execution → verify gate → report |
| `/away` | Work autonomously until you return (capped, stall-guarded) |
| `/overhaul` | Autonomous codebase rewrite: architecture first, then slice-by-slice, zero functionality loss (`behavior.json` contract) |
| `/plan` | Read-only planning only |
| `/go` | Approve the pending plan and start |
| `/publish` | Push + PR with git safety |
| `/verify` | Honest verify gate |
| `/research` | Deep research (SearXNG + agents) |
| `/critique` | Adversarial review of your idea (no sycophancy) |
| `/retro` | Lessons from past sessions → improvement list |
| `/security-review` | Exploitability-focused review of the diff |
| `/simplify` | Quality cleanup of the changed code (4 angles) |
| `/audit` | Over-engineering + slop audit (read-only list) |
| `/docs` | AI documentation (.ai-docs, compact, context-cheap) |
| `/design` | DESIGN.md design system (awesome-design-md references) |
| `/test-ui` | UI tests via the webapp-testing skill |
| `/study` | Deeply understand an external repo |
| `/skill` | Load a skill from the curated index |
| `/graph` | graphify code graph |
| `/ci` | Check / create CI |
| `/danger` | Danger mode setup (sudo, safety rules) |
| `/usage` | Session cost/context report |
| `/orchestrate` | Run the headless driver |

## Options

```json
{
  "stateDir": ".bulba",
  "docsDir": ".ai-docs",
  "maxRounds": 5,
  "awayMaxRounds": 50,
  "stallRounds": 3,
  "idleDelayMs": 30000,
  "memoryMaxBytes": 4096,
  "indexMaxBytes": 1000,
  "maxQuestions": 5,
  "searxngUrl": "http://localhost:8080",
  "maxQueries": 6,
  "maxPages": 8,
  "memoryNudgeEvery": 10,
  "autoSummarizeEvery": 20,
  "designMdDir": "",
  "skillsDir": "",
  "driverPath": "",
  "guard": true,
  "strictMode": false,
  "dangerMode": false,
  "defaultAgent": false,
  "commands": true,
  "rules": true,
  "agents": true,
  "slopCheck": true,
  "blockPythonEdits": true,
  "awayAutoApprove": true
}
```

## Driver

```bash
bun bulba-driver.mjs <project-dir> --task "<task>" \
  [--opencode <bin>] [--cli opencode|claude|codex] \
  [--max-rounds N] [--parallel N] [--sandbox systemd|bwrap] \
  [--mem MB] [--cpu %] [--session-timeout s]
```

Runs the MEA loop headless: plan → implement (worker pool, one worktree per task, task dependencies) → audit (structured verdicts, snapshot guard) → review → verify → report. Resume-safe (state in `.bulba/driver.json`), every session has a timeout, sandboxes limit resources (cgroups) or isolate the filesystem (bwrap, no network).

## Security

- **No telemetry, no network calls** from the plugin itself (research uses your local SearXNG or the agent's webfetch).
- **Skillfinder** never installs web-fetched skills without your explicit consent; never downloads or runs executables.
- **Danger mode** keeps the sudo password invisible to the model and out of the chat.
- The plugin **cannot** be tricked into destructive git commands (denied at the permission level).
- All state lives in `.bulba/` (auto-gitignored) — inspect anything, delete anything.

## Development

```bash
bun install
bun test bulba.test.ts bulba-driver.test.ts   # 52 tests
```

## License

MIT
