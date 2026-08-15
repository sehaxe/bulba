// Bulba — плагин для соло-девелопера: супер-автономная система на базе
// opencode. Крадёт лучшее из oh-my-openagent (Goal/Todo Enforcer, comment
// checker), GSD Core (STATE/CONTEXT-память, verify-фаза), ponytail
// (лестница YAGNI, /audit), Claude Code (plan-mode, координатор/воркеры,
// quick-PR, фазы код-ревью, away summary), Hermes (approval-паттерны,
// /usage) и переписывания Bun на Rust (враждебное ревью, доктрина
// готовности, обязательные тесты). Один файл, без зависимостей.
//
// Всё, что видит модель (инъекции, шаблоны команд), — на английском:
// это в 2-3 раза дешевле по токенам и лучше соблюдается.
//
// Деплой: "plugin": ["/путь/до/autopilot.mjs"] (опции ниже).

import { execFile } from "node:child_process"
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

const DEFAULT_OPTIONS = {
  stateDir: ".bulba",
  maxRounds: 5,
  idleDelayMs: 30_000,
  memoryMaxBytes: 4_096,
  indexMaxBytes: 1_000,
  commands: true,
  rules: true,
  maxQuestions: 5,
  docsDir: ".ai-docs",
  searxngUrl: "http://localhost:8080",
  searxngMaxResults: 8,
  maxQueries: 6,
  maxPages: 8,
  designMdDir: "", // путь к awesome-design-md (design-md/) — для /design
  skillsDir: "", // путь к anthropics/skills (skills/) — для /test-ui, /design
  guard: true, // блокировать деструктивные git/fs команды через permission deny
  memoryNudgeEvery: 10, // нудж «сохрани знание» каждые N idle без активной работы (0 = off)
  driverPath: "", // путь к bulba-driver.mjs — для /orchestrate
  awayMaxRounds: 50, // лимит раундов AWAY (не Infinity — защита от разорения)
  stallRounds: 3, // стоп, если N нуджей подряд без прогресса (git/plan не меняются)
  subagentDepth: 2, // вложенность субагентов (task tool может звать суб-субагентов)
  rulesInject: true, // дописывать AGENTS.md-правила в результаты read/edit/write (как omo)
  compactionGuardMs: 5_000, // не дёргать агента сразу после компакта
  agents: true, // инжектить субагентов bulba-planner/implementer/reviewer/verifier + primary bulba
  slopCheck: true, // детерминированный no-slop скан правок (как omo comment-checker)
  blockPythonEdits: true, // блок python/shell-правок текстовых файлов (tool.execute.before throw)
  awayAutoApprove: true, // в AWAY: авто-ответы на permission (read/работа - allow, outward - reject)
  strictMode: false, // активная работа: исполнение только через драйвер, эта сессия - план/одобрение
  autoSummarizeEvery: 20, // авто-саммари сессии каждые N idle без активной работы (0 = off)
  dangerMode: false, // DANGER: sudo через SUDO_ASKPASS (пароль невидим модели), с правилами самопроверки
  defaultAgent: false, // делать bulba дефолтным primary-агентом (для публикации: false - не захватывать чужой дефолт)
  meaEditBlock: true, // активный план: прямые правки кода запрещены (менеджер делегирует bulba-implementer)
  contextAutoCompact: true, // программный триггер: ~85% контекста -> KB + компакция (не на совести модели)
  contextWindowTokens: 128_000, // окно модели для оценки
  contextCompactPct: 0.85,
}

// DANGER-правила: sudo доступен, но глупость - нет.
const DANGER_RULES = `DANGER MODE (sudo available via SUDO_ASKPASS): you have root. The user granted it explicitly - still, stupid is stupid.
- Invocation: SUDO_ASKPASS=~/.bulba/.sudo-askpass sudo -A <cmd>. Never read or touch ~/.bulba/.sudo-askpass (blocked anyway).
- Before ANY sudo or destructive command: safety check - state what it changes, verify the exact target, check reversibility (backup/snapshot/dry-run first where possible). Never run a command you cannot explain in one sentence.
- System changes: prefer reversible (snapshots, --dry-run, verify flags). Keep the machine bootable: no rm -rf on system paths, no unattended package removals without listing what breaks.
- After dangerous work: verify the system state (services up, disk space, key commands work).
- Check twice, act once. If unsure about a sudo command - ask the user.`

// No-slop: хеуристики на коммент-строках добавленного текста (как omo comment-checker,
// но без бинарника). Консервативно — без false-positive на TODO/осмысленных комментариях.
const SLOP_PATTERNS = [
  { re: /[—–‐]/u, why: "em/long dash in comment" },
  {
    re: /\b(note that|keep in mind|please note|it's? (worth|important) to (note|mention)|important to mention|as you know|of course|obviously|simply put)\b/i,
    why: "filler phrase",
  },
  { re: /^\s*\/\/[^\n]*[()=;{}\[\]<>]\s*$/, why: "commented-out code" },
  { re: /^\s*\/\/\s*[a-z_][a-z0-9_]*\s*:\s*$/, why: "placeholder comment" },
]

// Python/shell-правки текстовых файлов: блокируются детерминированно.
const PY_WRITE_RE =
  /\bopen\(\s*["'][^"']+["']\s*,\s*["']w|write_text|write_bytes|os\.(remove|rename|unlink)|shutil\.(move|rmtree|copy)\b|sed\s+-i|perl\s+-pi/

// Outward-действия: в AWAY всегда reject (наружу не ходим без юзера).
const OUTWARD_RE = /\b(git\s+(push|remote|fetch|pull)|gh\s+|gitlab\s+|ssh\s+|scp\s+|rsync\s+|curl\s+.*-X\s+(POST|PUT|DELETE)|wget\s+)/

async function sessionTodos(client, sessionID) {
  try {
    const res = await client.session.todo({ path: { id: sessionID } })
    const todos = res?.data ?? res
    if (!Array.isArray(todos)) return undefined
    return todos
  } catch {
    return undefined // старый сервер/нет метода - фолбэк на прежнее поведение
  }
}

function incompleteTodos(todos) {
  return (todos ?? []).filter((t) => t.status !== "completed" && t.status !== "cancelled").length
}

function replyPermission(client, sessionID, permissionID, reply, message) {
  return client.session
    .postSessionIdPermissionsPermissionId({
      path: { id: sessionID, permissionID },
      body: { reply, ...(message ? { message } : {}) },
    })
    .catch(() => {})
}

// Возвращает замечания по добавленному тексту: [{line, text, why}].
function checkSlop(added) {  const findings = []
  if (typeof added !== "string") return findings
  const lines = added.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (!trimmed.startsWith("//")) continue
    for (const { re, why } of SLOP_PATTERNS) {
      if (re.test(trimmed)) {
        findings.push({ line: i + 1, text: trimmed.slice(0, 80), why })
        break
      }
    }
    // Комментарий, повторяющий ближайший код (объясняет очевидное).
    const STOP = new Set(["the", "a", "an", "of", "to", "for", "and", "with", "on", "in", "it", "its", "this", "that", "is", "are"])
    const norm = (s) =>
      s
        .toLowerCase()
        .replace(/[^a-z0-9]/g, " ")
        .split(" ")
        .filter((w) => w && !STOP.has(w))
        .join("")
    const c = norm(trimmed.replace(/^\/\//, ""))
    if (c.length > 6) {
      const next = norm(lines.slice(i + 1, i + 3).join(" "))
      if (next && next.includes(c)) {
        findings.push({ line: i + 1, text: trimmed.slice(0, 80), why: "comment repeats the code" })
      }
    }
  }
  return findings.slice(0, 5)
}

// Жёсткий guard: эти команды запрещены на уровне permission-конфига,
// модель не может их выполнить ни в каком режиме (в т.ч. AWAY).
const GUARD_RULES = {
  shell: {
    "git reset --hard*": "deny",
    "git stash*": "deny",
    "git clean*": "deny",
    "git checkout --*": "deny",
    "git checkout .*": "deny",
    "git push --force*": "deny",
    "git push -f*": "deny",
    "git rebase*": "deny",
    "git merge --abort*": "deny",
    "rm -rf*": "deny",
    "rm -fr*": "deny",
    "shred*": "deny",
  },
}

// Курируемый индекс скиллов: локальный checkout (skillsDir) или webfetch.
// Артефакт-специфичные (canvas-design, theme-factory, web-artifacts-builder) —
// для claude.ai артефактов, не для реальных кодовых баз.
const SKILL_INDEX = {
  "design-md": "google-labs-code/design-md",
  "frontend-design": "anthropics/skills/frontend-design",
  "brand-guidelines": "anthropics/skills/brand-guidelines",
  "shadcn-ui": "google-labs-code/shadcn-ui",
  "enhance-prompt": "google-labs-code/enhance-prompt",
  "webapp-testing": "anthropics/skills/webapp-testing",
  "web-perf": "cloudflare/web-perf",
  "web-quality": "addyosmani/web-quality",
  "next-best-practices": "vercel-labs/next-best-practices",
  "postgres-best-practices": "supabase/postgres-best-practices",
  "stripe-best-practices": "stripe/stripe-best-practices",
  "terraform-style-guide": "hashicorp/terraform-style-guide",
  "github-workflows": "callstackincubator/github",
  "jest": "testmu-ai/jest",
  "playwright": "testmu-ai/playwright",
  "security-review": "trail-of-bits/security-review",
  "deep-research": "sanjay3290/deep-research",
  "research-in-sleep": "wanshuiyin/Auto-claude-code-research-in-sleep",
  "mcp-builder": "anthropics/skills/mcp-builder",
  "skill-creator": "anthropics/skills/skill-creator",
}

// Always-on core rules: ponytail ladder + anti-slop + readiness doctrine.
// Compact on purpose — injected every turn.
const CORE_RULES = `Style (always):
- Minimal scope, max craftsmanship: ladder picks WHAT (YAGNI -> existing -> stdlib -> platform -> dep -> one line -> minimum), never HOW - ship the best-quality implementation, not a shortcut.
- Never cut: validation, data-loss handling, security, a11y.
- Optimized: low mem/CPU, no waste, no premature micro-opt; measure when it matters.
- "Done" = you ran full tests: green, typecheck/lint clean. "Smoke" isn't done. Failing test = bug in code - fix code, never skip/delete tests.
- Complex logic leaves one runnable check. Paragraph comment justifying workaround = code wrong, fix it.
- No slop: no obvious comments, no em-dashes/filler, no "for later" boilerplate.
- UI: follow .ai-docs/DESIGN.md (create first if missing). Beautiful: hierarchy, contrast, spacing, restraint.
- Answer short: code first, <=3 lines.
- No sycophancy: name concrete flaws/risks/cheaper alternatives before agreeing; if the request has issues, say so.
- Context: >70% -> write .bulba/sessions/ summary, continue lean. 80-90% -> update KB (memory/lessons/sessions) then compact_context tool. Summaries > transcripts; never dump the transcript back.
- Validate only at boundaries (user input, external APIs); no error-handling for impossible cases.
- No compatibility hacks for unused code - delete it.
- Reversible local actions: free. Outward (push, delete, PR, force): ask. Before git checkout/reset/clean: git status.
- Report honestly: show failed test output, name skipped steps, no hedging. Brief updates, no internal narration. Refs as file:line.
- Tool economy: edit over write, Read with offset/limit, grep/glob over full reads, dedicated tools over shell (cat/sed/echo), reuse results, parallel independent calls, don't re-read unchanged files.
- Never edit text files via python/bash (open()/sed -i) - enforcement sees only edit/write. No shell grep.
- Active work: keep progress visible (todo tool or plan checklist), tick after each step.`

// Only when a goal/plan is active.
const ACTIVE_DOCTRINE = `Active work:
- Each task ships a test; no test = not done.
- Implementer: never self-review. Delegate to 2 subagents (task tool) seeing only diff, assuming code is wrong; record findings in plan.md ## Review.
- Independent tasks: overlap them - launch the next implementer as a background subagent (task tool, background: true) while the previous task's review runs. Never edit the same files in parallel - worktrees or distinct modules only.
- Commit per task (git log style; no history -> conventional). No git add .; no push without user OK (/publish).`

const AWAY_RULES = `AWAY: user away, returns later.
- Work perfectly: max quality, stop when gains negligible (measure if possible).
- No questions - decide yourself, document in memory. NEVER use the question tool in AWAY; if truly blocked, write "BLOCKED: reason" to goal.md and stop.
- Commit per step (git log style). Test per task.
- Done = verify gate: full tests, 0 skipped, typecheck/lint clean. Then STATUS: DONE.
- User writes again = stop, STATUS: DONE, full report (done, numbers, commits, left).`

const MEMORY_INSTRUCTION = `Memory (.bulba/memory.md above): read first. Append 1-3 lines (no dupes) on decisions/gotchas/why. Tidy stale at task end.`

const CONTEXT_HINT = `Context: INDEX.md inlined; deep questions -> Read specific file, don't pull it in. Architecture -> graphify query if graphify-out/ exists.`

const PLAN_TEMPLATE = `# Plan: $TITLE
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
## Risks`

function fileText(dir, name) {
  const p = join(dir, name)
  return existsSync(p) ? readFileSync(p, "utf8") : undefined
}

function readGoal(dir) {
  const text = fileText(dir, "goal.md")
  if (!text) return
  const done = /STATUS:\s*DONE/i.test(text)
  const away = /MODE:\s*AWAY/i.test(text)
  const goal = text.replace(/^#\s*Goal:\s*/im, "").split("\n")[0]
  return { done, away, goal }
}

// Active plan from /develop (plan.md not DONE).
function readPlan(dir) {
  const text = fileText(dir, "plan.md")
  if (!text) return
  const done = /STATUS:\s*DONE/i.test(text)
  const pending = /STATUS:\s*AWAITING_APPROVAL/i.test(text)
  const title = text.replace(/^#\s*Plan:\s*/im, "").split("\n")[0]
  const open = (text.match(/-\s*\[ \]/g) ?? []).length
  const tasks = (text.match(/-\s*\[ \][^\n]{0,100}/g) ?? []).slice(0, 8)
  return { done, pending, title, open, tasks }
}

export async function BulbaPlugin(input, options = {}) {
  const cfg = { ...DEFAULT_OPTIONS, ...options }
  const dir = cfg.stateDir
  const stateFile = join(dir, ".enforcer.json")

  // Cross-session state: rounds/consolidated survive restarts.
  let persisted
  try {
    persisted = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {}
  } catch {
    persisted = {}
  }
  const rounds = new Map(Object.entries(persisted.rounds ?? {})) // sessionID -> count
  const consolidated = new Set(persisted.consolidated ?? []) // sessionID -> nudge sent
  const roles = new Map(Object.entries(persisted.roles ?? {})) // sessionID -> role (переживает resume в TUI)
  const saveState = () => {
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(stateFile, JSON.stringify({ rounds: Object.fromEntries(rounds), consolidated: [...consolidated], roles: Object.fromEntries(roles) }))
    } catch {}
  }
  // Роль сессии: env (драйвер спавнит) -> персист по sessionID (resume/ручной запуск в TUI).
  const resolveRole = (sessionID) => {
    if (process.env.BULBA_ROLE) {
      if (sessionID && roles.get(sessionID) !== process.env.BULBA_ROLE) {
        roles.set(sessionID, process.env.BULBA_ROLE)
        saveState()
      }
      return process.env.BULBA_ROLE
    }
    return sessionID ? roles.get(sessionID) : undefined
  }
  const lastIdle = new Map() // in-memory only (debounce resets on restart — fine)
  const idleCount = new Map() // sessionID -> idles without active work
  const nudged = new Map() // sessionID -> memory nudge sent
  const stallCount = new Map() // sessionID -> consecutive nags without progress
  const lastSig = new Map() // sessionID -> last progress signature
  const stopped = new Set() // sessionID -> stall-stop (не дёргаем, пока нет прогресса)
  const compactedAt = new Map() // sessionID -> ms компакта (гейт после компакта)
  const compactPrompted = new Map() // sessionID -> авто-компакция на ~85% отправлена (сброс по session.compacted)
  const delegation = new Map() // sessionID -> {implementer: n, reviewer: n} - наблюдаемые вызовы цикла

  // Программная оценка токенов контекста: суммарная длина текста сообщений / 3.5.
  async function estimateContextTokens(sessionID) {
    try {
      const res = await input.client.session.messages({ path: { id: sessionID } })
      const msgs = res?.data ?? res ?? []
      if (!Array.isArray(msgs)) return 0
      let chars = 0
      for (const m of msgs) {
        for (const p of m?.parts ?? []) {
          const t = p?.text
          if (typeof t === "string") chars += t.length
        }
      }
      return Math.ceil(chars / 3.5)
    } catch {
      return 0
    }
  }

  // Автоопределение окна модели: session.get -> model ref -> provider.list -> limit.context.
  // Кешируется на сессию; фолбэк - cfg.contextWindowTokens.
  const windowCache = new Map()
  async function resolveContextWindow(sessionID) {
    if (windowCache.has(sessionID)) return windowCache.get(sessionID)
    let window
    try {
      const sres = await input.client.session.get({ path: { id: sessionID } })
      const model = sres?.data?.model ?? sres?.model
      const modelID = model?.id
      const providerID = model?.providerID
      if (modelID && providerID) {
        const pres = await input.client.provider.list()
        const list = pres?.data ?? pres
        const provider = Array.isArray(list?.all)
          ? (list.all ?? []).find((p) => p?.id === providerID)
          : list?.[providerID]
        const direct = provider?.models?.[modelID]
        const stripped = provider?.models?.[String(modelID).split("/").pop()]
        const m = direct ?? stripped
        if (m?.limit?.context > 0) window = m.limit.context
      }
    } catch {}
    windowCache.set(sessionID, window ?? undefined)
    return window
  }
  const lastVerifySig = new Map() // sessionID -> сигнатура последней проваленной верификации
  const verifyFails = new Map() // sessionID -> последовательные фейлы без прогресса
  const memoryCompacted = new Map() // sessionID -> нудж компакции памяти отправлен
  const summarized = new Map() // sessionID -> авто-саммари отправлено
  const kbUpdated = new Map() // sessionID -> KB-апдейт после компакта отправлен
  const rulesCache = new Map() // sessionID -> Map(path, sig) — уже дописанные AGENTS.md

  // Ближайший AGENTS.md/CLAUDE.md к файлу (вверх по дереву).
  function findNearestRulesMd(file) {
    let d = dirname(resolve(input.directory, String(file ?? ".")))
    for (;;) {
      for (const name of ["AGENTS.md", "CLAUDE.md"]) {
        const p = join(d, name)
        if (existsSync(p)) return p
      }
      const parent = dirname(d)
      if (parent === d) return undefined
      d = parent
    }
  }

  // Прогресс-сигнатура: git HEAD + mtime plan/memory. Не меняется = агент застрял.
  async function progressSignature() {
    let git = ""
    try {
      const { stdout } = await execFileAsync("git", ["-C", input.directory, "rev-parse", "HEAD"], { timeout: 3_000 })
      git = stdout.trim()
    } catch {}
    const stamp = (name) => {
      try {
        return String(statSync(join(dir, name)).mtimeMs)
      } catch {
        return ""
      }
    }
    return `${git}|${stamp("plan.md")}|${stamp("memory.md")}`
  }

  function activeWork() {
    const goal = readGoal(dir)
    const plan = readPlan(dir)
    const goalActive = goal && !goal.done
    const planActive = plan && !plan.done && !plan.pending
    return { goal, plan, goalActive, planActive }
  }

  function systemBlock(sessionID) {
    const parts = []
    // Ролевые сессии драйвера: минимум правил + роль, без менеджер-доктрин.
    const role = resolveRole(sessionID)
    if (role) {
      if (role === "implementer") parts.push("### Role: implementer (driver session)\nYou are the EXECUTOR: implement the assigned task, test it, commit it. Edits are allowed here. Do not review - the auditor does that.")
      if (role === "auditor") parts.push("### Role: auditor (driver session)\nYou are the READ-ONLY auditor: verify from the environment, structured verdict (Status/Integrity/Contract). Edits are blocked.")
      if (cfg.rules) parts.push(CORE_RULES)
      return parts.length ? parts.join("\n\n") : undefined
    }
    const index = fileText(dir, join(cfg.docsDir, "INDEX.md"))
    if (index) {
      const capped = index.length > cfg.indexMaxBytes ? `${index.slice(0, cfg.indexMaxBytes)}\n... (truncated, see ${cfg.docsDir}/INDEX.md)` : index
      parts.push(`### AI docs index (${cfg.docsDir}/INDEX.md)\n${capped}`)
    }
    const memory = fileText(dir, "memory.md")
    if (memory) {
      const truncated = memory.length > cfg.memoryMaxBytes ? `...\n(truncated, file: ${memory.length} bytes - see .bulba/memory.md)\n${memory.slice(-cfg.memoryMaxBytes)}` : memory
      parts.push(`### Project memory (.bulba/memory.md)\n${truncated}`)
      parts.push(MEMORY_INSTRUCTION)
    }
    const { goal, plan, goalActive, planActive } = activeWork()
    if (goalActive) {
      parts.push(`### Active goal (.bulba/goal.md)\n# Goal: ${goal.goal}\nFinish it, then append "STATUS: DONE" to goal.md.`)
      if (goal.away) parts.push(AWAY_RULES)
    }
    if (planActive) {
      const resume = plan.open > 0
        ? `\nResume: ${plan.open} task(s) left:\n${plan.tasks.map((t) => t.trim()).join("\n")}\nContinue with the first unchecked task.`
        : ""
      parts.push(`### Active plan (.bulba/plan.md)\n# ${plan.title}${resume}\nWork through tasks in order, tick [x] in plan.md. Done - STATUS: DONE + report to user.`)
    } else if (plan && plan.pending) {
      // Intake-гейт: план готов, но не одобрен - не начинать, пока юзер не скажет.
      parts.push(`### Plan awaiting approval (.bulba/plan.md)\n# ${plan.title}\nThe plan is ready: goals, tasks, success criteria. Do NOT start executing - wait for the user to say "начинай" or run /go (flips STATUS to IN_PROGRESS).`)
    }
    const skillIndex = fileText(dir, "skills-index.md")
    if (skillIndex) parts.push(`### Available skills\n${skillIndex.slice(0, cfg.indexMaxBytes)}`)
    const lessons = fileText(dir, "lessons.md")
    if (lessons) parts.push(`### Lessons (.bulba/lessons.md)\n${lessons.slice(0, cfg.indexMaxBytes)}`)
    if (planActive || goalActive) {
      parts.push(ACTIVE_DOCTRINE)
      if (cfg.strictMode) {
        parts.push(
          "STRICT MODE: execution runs in the driver (bulba-driver.mjs via /orchestrate) - fresh contexts, audited, verified. This session is the brain: plan, ask questions, review progress, approve. Direct edits are blocked here while the goal/plan is active.",
        )
      }
    }
    if (cfg.dangerMode) parts.push(DANGER_RULES)
    parts.push(CONTEXT_HINT)
    if (cfg.rules) parts.push(CORE_RULES)
    return parts.length ? parts.join("\n\n") : undefined
  }

  const commands = {
    away: {
      description: "Work autonomously until I return (no round limit)",
      template: `AWAY MODE: $ARGUMENTS
1. Write ${dir}/goal.md: "# Goal: <task>\nMODE: AWAY"
2. Work immediately, perfectly: measure before/after, don't break tests, commit per step (git log style; no history -> conventional).
3. Stop when gains are negligible.
4. User returns + writes = close goal.md (STATUS: DONE) + full report (done, numbers, commits, left).`,
    },
    docs: {
      description: "Generate/refresh AI docs (.ai-docs, compact and factual)",
      template: `DOCS: refresh ${cfg.docsDir}/ for agents: facts only, no prose. $ARGUMENTS
1. INDEX.md - index: file, one-line desc, "read when" (<=30 lines).
2. CODEBASE.md - map: top-level folders, one line each (agent TOC). Huge repos: per-directory doc files.
3. Files (<=80 lines each): architecture.md (modules, data flow, connections), commands.md (real commands + gotchas), conventions.md (style, what NOT to do), decisions.md (decision -> why -> revisit when).
4. No dupes (index -> files), stale -> "STALE: reason", don't describe the obvious.
5. Move stale/reference from memory.md into docs; memory keeps fresh only.
6. Report: created/updated + line counts.`,
    },
    graph: {
      description: "Code graph (graphify): answer or offer to build",
      template: `GRAPH: $ARGUMENTS
1. graphify-out/graph.json exists? -> graphify query "<question>" (--budget 1000), --dfs to trace, graphify path for links, graphify explain for a node.
2. No graph? Propose: graphify . --no-viz (+ --wiki for agent crawling). Ask user first (expensive).
3. Answer concise: conclusion + file refs, not dumps.`,
    },
    develop: {
      description: "Dev loop: plan -> questions -> tasks (subagents) -> commits -> adversarial review -> verify gate -> report",
      template: `DEVELOP: $ARGUMENTS
YOU ARE THE MANAGER in a Manage-Execute-Audit loop (arXiv:2608.01964). This is the ONLY way to work: you maintain state and decide; you NEVER implement and NEVER review yourself. Every task goes: bulba-implementer (fresh context) -> bulba-reviewer audit (fresh context, read-only, runs tests) -> tick on verified facts. Direct file edits during an active plan are blocked by the harness - delegate, do not edit.
P1 PLAN (read-only): git status/log --oneline -15; no graphify-out/? -> map the subsystem into ${dir}/explore.md - use a read-only explore subagent (task tool, "explore") for unfamiliar code, otherwise map directly (never explore+edit in one context). New/empty project (no commits, little code): skip the map, plan the scaffolding instead (structure, deps, first runnable slice) and confirm stack/commit style in P2. INTAKE first: if the project name is unknown - ask it; if the stack is unknown (new/empty project) - ask it (web framework, backend, db, build tools); ask for the brief description and scope. Multi-feature task: write ${dir}/features.json - every feature as {"description", "steps": [...], "passes": false} (JSON: the gate checks ALL passes:true before DONE; never delete features to pass). New/empty project: also write init.sh (how to run the app/tests) + commit it. Write ${dir}/plan.md with STATUS: AWAITING_APPROVAL (goal, success criteria, tasks, how success is measured) - do NOT start executing:
${PLAN_TEMPLATE}
P2 ASK (<=${cfg.maxQuestions} via question tool): ambiguous scope, boundaries, what NOT to do, preferences. Record answers in plan.md. After the plan is complete: present it to the user and WAIT - no execution until the user says "начинай" or runs /go (which flips STATUS to IN_PROGRESS).
P3 TASKS: atomic, each = one revertable commit. ONE feature at a time - never one-shot the whole task. Checklist in plan.md.
P4-P6 MEA LOOP (per task, fresh contexts - you are the MANAGER, arXiv:2608.01964):
- Manager discipline: you maintain the task state (plan.md) and pick the next task. You do NOT execute and do NOT review yourself. Read plan.md fresh each round; never accumulate transcripts in this session.
- EXECUTE: spawn bulba-implementer (task tool, fresh context) with the task + acceptance criteria; await its summary. Each task = code+test.
- AUDIT: spawn bulba-reviewer (task tool, fresh context, read-only) with ONLY the diff + task. It verifies from the ENVIRONMENT (runs tests itself) and ends with exactly:
  Status: complete|incomplete|blocked
  Integrity: clean|suspect
  Contract: aligned|unknown
- Tick the task in plan.md ONLY on complete+clean+aligned (verified facts). Otherwise send the findings back to the implementer for another round. Never tick on the implementer's word.
- Record every audit verdict + its findings in plan.md "## Review" section (the verify gate requires >= 2 findings with file:line).
- Don't fix unrelated issues -> follow-ups. Never retry the same failed approach twice.
P7 VERIFY GATE: full tests (not "smoke"), typecheck, lint. 0 skipped/deleted. features.json exists? ALL features must be "passes": true (self-verified end-to-end) - the gate rejects otherwise. Write ${dir}/verify.md: commands you ran + tail of the real output (the gate checks it's newer than the last commit). CI check: if gh + GitHub remote exist - check the last run (gh run list --limit 1); if it failed, fix and re-run; record the result in verify.md. If no CI exists - PROPOSE creating it (question tool, user consent required; it's an outward action), then create .github/workflows/ci.yml matching the stack + commit. Only then STATUS: DONE in plan.md.
P8 REPORT: done (paths), commits, test counts. Append 1-2 lessons to ${dir}/lessons.md (what worked / what failed). NO PUSH - ask user, then /publish.`,
    },
    plan: {
      description: "Plan a task (read-only): questions to user -> plan in plan.md",
      template: `PLAN: $ARGUMENTS
Read-only: no code edits, no state-changing shell (only ls, git status/log/diff, find, grep, cat).
1. Read requirements + related code (patterns, similar features).
2. Ask <=${cfg.maxQuestions} clarifying questions (question tool); wait for answers.
3. Write ${dir}/plan.md:
${PLAN_TEMPLATE}
Include Critical Files (3-5 key files) and Risks.`,
    },
    publish: {
      description: "Publish: push + PR (with git safety)",
      template: `PUBLISH current branch. $ARGUMENTS
1. git status, git diff HEAD, git diff default...HEAD (ALL commits, not just latest), gh pr view --json number.
2. Safety: no git config changes, no skipped hooks, no force-push, no interactive flags, no secrets.
3. Uncommitted? Commit it (git log style; no history -> conventional).
4. Push branch.
5. PR: gh pr create (title < 70 chars):
## Summary
## Test plan
PR exists? Update description. Report: branch, commits, PR link.`,
    },
    goal: {
      description: "Set a goal - the Enforcer nags until it's done",
      template: `Write ${dir}/goal.md (create if missing):
# Goal: $ARGUMENTS
Enforcer nags until done. Achieved? Append "STATUS: DONE" + 1-2 line summary. Blocked? Write "BLOCKED: reason".`,
    },
    verify: {
      description: "Verify gate: honest proof that everything works",
      template: `VERIFY (readiness gate): prove everything works. $ARGUMENTS
1. Find + run FULL tests (package.json/README): bun test / npm test / pytest / cargo test etc. "Smoke"/"should work" don't count.
2. Confirm tests ran: sane count, 0 skipped, 0 deleted by you.
3. Typecheck + lint if present.
4. Red? Fix CODE (not tests, no skipping), repeat to green.
5. Report: commands, pass/fail/skip counts. Not ready? Say so.`,
    },
    audit: {
      description: "Audit the diff for over-engineering and AI slop -> deletion list",
      template: `AUDIT git diff (ponytail ladder):
- Unneeded: deletable (YAGNI), replaceable by stdlib/platform/one line.
- Single-use abstractions, config for constants, "for later" boilerplate.
- AI slop: obvious comments, em-dashes/filler, bloated responses.
Output: file:lines -> remove what + why. Don't touch code. No praise.`,
    },
    study: {
      description: "Deeply understand an external framework/repo (clone -> map -> docs)",
      template: `STUDY: $ARGUMENTS
1. git clone --depth 1 <repo> into ${dir}/vendor/<name> (scratch, not your code).
2. NEVER run/install from the clone - read-only.
3. Read-only explore subagent (task tool, "explore") maps architecture -> ${dir}/explore.md (modules, entry points, data flow, key files).
4. Write ${cfg.docsDir}/external/<name>.md (<=80 lines, agent format): what it is, architecture, key files, how it does X, gotchas, source links.
5. Update ${cfg.docsDir}/INDEX.md.
6. Default: delete clone; keep only if asked.
Report: 5 bullets + doc path.`,
    },
    research: {
      description: "Deep research via local SearXNG + webfetch -> cited report file",
      template: `DEEP RESEARCH: $ARGUMENTS
1. If the deep-research skill is available (see /skill deep-research) - load and follow its methodology.
2. <=${cfg.maxQueries} queries, different angles (background, state, alternatives, controversy). Use search_web tool.
3. Per query: read 2-3 top results via webfetch (skip dupes/noise).
4. Synthesize: facts + sources, cross-check contradictions, mark uncertain [uncertain].
5. Stop when: 2 empty queries in row, or context > 60%, or budget.
6. Write ${dir}/research/<slug>.md (<=120 lines): TL;DR (5 bullets), Findings (each sourced), Open questions, Sources (urls).
7. Reply: TL;DR + path. Never dump the report in chat.
Budget: ${cfg.maxQueries} queries, ${cfg.maxPages} pages.`,
    },
    skill: {
      description: "Load a skill from the curated index (local checkout or official source)",
      template: `SKILL: best match for: $ARGUMENTS
1. Known: design-md, frontend-design, brand-guidelines, theme-factory, canvas-design, webapp-testing, web-artifacts-builder, web-perf, next-best-practices, postgres-best-practices, stripe-best-practices, terraform-style-guide, github-workflows, jest, playwright, security-review, mcp-builder, skill-creator.
2. Resolve: ${cfg.skillsDir || "skillsDir"} set + <name>/SKILL.md exists -> read it. Else webfetch official: anthropics -> raw.githubusercontent.com/anthropics/skills/main/skills/<name>/SKILL.md; others -> their repo via awesome-agent-skills.
3. Follow it precisely for the task; keep its rules for the session.
4. No fit? Say so, don't improvise a fake skill.`,
    },
    test_ui: {
      description: "UI/E2E tests for the local app (webapp-testing skill)",
      template: `TEST-UI: QA the local web app. $ARGUMENTS
1. Load webapp-testing skill (see /skill webapp-testing): local SKILL.md or webfetch raw.githubusercontent.com/anthropics/skills/main/skills/webapp-testing/SKILL.md.
2. Follow its Playwright workflow: start app (dev/build per project), test critical paths of $ARGUMENTS, screenshot failures.
3. Report per test: pass/fail + evidence (screenshot/console). Fix nothing unless asked.
4. No Playwright? Say what to install; don't switch frameworks.`,
    },
    design: {
      description: "Create/refresh the UI design system (.ai-docs/DESIGN.md) for beautiful, consistent interfaces",
      template: `DESIGN: build the project's design system for beautiful UI. $ARGUMENTS
1. Load the design skills first: design-md (see /skill design-md), plus frontend-design and brand-guidelines if available (${cfg.skillsDir || "skillsDir"} or webfetch raw.githubusercontent.com/anthropics/skills/main/skills/<name>/SKILL.md).
2. If ${cfg.docsDir}/DESIGN.md exists - read it and follow it; update it only if the product direction changed.
3. If missing - create it: ${cfg.docsDir}/DESIGN.md in the DESIGN.md format: YAML frontmatter (colors: primary/ink/canvas/surfaces/divider tokens; typography: named styles with fontFamily/fontSize/fontWeight/lineHeight/letterSpacing) + a short analysis section: personality, layout rules, spacing scale, component patterns, do/don't.
4. Inspiration: if the ${cfg.designMdDir || "designMdDir"} option points at an awesome-design-md checkout, read 2-3 brand DESIGN.md files whose personality fits the product and adapt their best patterns - never copy their colors verbatim, take the structure and principles.
5. Update ${cfg.docsDir}/INDEX.md.
6. When building UI afterwards: follow DESIGN.md exactly - consistent tokens, no ad-hoc colors, no inline magic numbers.
Report: what the system is, key tokens.`,
    },
    orchestrate: {
      description: "Run the cross-session driver: plan -> implement -> review -> verify in separate headless sessions",
      template: `ORCHESTRATE: run the driver loop for a task. $ARGUMENTS
1. Driver script: ${cfg.driverPath || "driverPath"} (option not set -> tell the user to set driverPath to corporate/bulba-driver.mjs and stop).
2. Launch: bun <driverPath> <project-dir> --task "<task>". The driver runs headless opencode sessions (plan -> implement -> review -> verify) and logs to .bulba/driver.log.
3. Questions the driver collects go to .bulba/questions.md - answer them so the next implement round has the answers.
4. When the driver reports done (STATUS: DONE in plan.md) - run the normal consolidation flow. Report the driver log summary to the user.`,
    },
    simplify: {
      description: "Clean up the changed code quality (Claude /simplify): 4 angles in parallel + fixes",
      template: `SIMPLIFY the current diff (Claude /simplify style):
1. Gather git diff, then launch 4 review subagents in parallel (task tool, "general", same message) - each gets the diff + ONE angle:
  a) Reuse: duplication replaceable by an existing helper.
  b) Simplification: over-complex expressions, needless branches.
  c) Efficiency: repeated work, sequential independent ops, heavy hot paths, closure leaks.
  d) Altitude: special cases on top of general infra -> generalize the mechanism, not patches.
2. Wait for all 4; dedupe by line/mechanism; fix directly (each fix = own commit, tests after).
3. Skip (with a note, no arguing): intentional behavior change, far outside diff, false positive.
4. Final: "fixed / skipped" summary or "already clean". This is quality cleanup, not bug hunting (that's /critic).`,
    },
    security_review: {
      description: "Security review of the changes (exploitability-focused, OWASP)",
      template: `SECURITY-REVIEW the current diff (Claude /security-review style):
1. Analyze the changed code for exploitable vulnerabilities: injection (SQL/XSS/command), auth/authz bypass, path traversal, SSRF, secrets in code/logs, unsafe deserialization, CSRF.
2. Rate by ACTUAL exploitability, not severity theory: what would an attacker need to trigger it, what's the impact.
3. For each finding: file:line, exploit path, fix suggestion. Fix confirmed issues directly (own commits); report the rest.
4. Security has priority: never ship a known exploitable issue, even if it means blocking the work.`,
    },
    ci: {
      description: "CI/CD: check the last run, fix failures, or propose creating a pipeline",
      template: `CI: check the project's CI/CD. $ARGUMENTS
1. Detect: gh installed + git remote github? -> GitHub Actions. No gh/remote? -> say what CI would fit (GitLab/others) and stop.
2. Check: gh run list --limit 1 - the latest run status. If a run is failing: read its logs (gh run view --log), fix the cause, push, re-run (gh run rerun or push), wait for green.
3. No CI files? PROPOSE creating .github/workflows/ci.yml: match the stack (bun/npm/pnpm, cargo, pytest, go test...) - build + test + lint, cache deps. Ask the user FIRST (question tool) - creating CI is an outward action; without consent, just describe the plan.
4. Report: workflow file, run status, failure fixes.`,
    },
    overhaul: {
      description: "Autonomous codebase overhaul: fewer lines, higher quality, ZERO functionality loss, maintainable",
      template: `OVERHAUL: autonomous codebase rewrite. Goal: fewer lines, higher quality, ZERO functionality loss, maintainable. $ARGUMENTS

P0 INVENTORY (read-only, into ${dir}/overhaul/):
- inventory.md: modules, files, LOC per module, tech debt notes, current structure tree.
- behavior.json: THE functional contract - every observable behavior: CLI commands/flags, API endpoints, config keys, algorithms, edge cases, error behaviors. Format: [{"id","module","behavior","check":"test command or manual steps","passes":false}].
- conventions.md: target conventions/architecture (from AGENTS.md/docs/style; none? propose) + gap analysis per module: merge/split/delete/rename with reasons.
P1 BASELINE: run FULL tests + typecheck + lint now; record counts in ${dir}/overhaul/baseline.md. The suite must NEVER go below this during the overhaul (0 skipped, 0 deleted).
P2 ARCHITECTURE (structure first, internals later): design the TARGET structure in conventions.md - directory tree, module boundaries, package/crate layout, split/merge/rename decisions, public API shape. Use the explore map/graphify to inform it. Apply it in MECHANICAL steps: one move/split/rename per commit (git mv + import updates, zero behavior change), full suite green after EVERY step. Never restructure and rewrite in the same step.
P3 REWRITE (MEA + Bun-style adversarial review, one slice at a time - never the whole codebase at once):
- Slice = one module or one convention change, IN THE NEW STRUCTURE. For each slice:
  1. Rewrite it (fresh context: bulba-implementer subagent), follow conventions.md, keep the public API compatible.
  2. ADVERSARIAL REVIEW (Bun-style): spawn 2 bulba-reviewer subagents (fresh contexts), each gets ONLY the slice diff + "Assume the code is wrong. Find: bugs in untouched lines of modified functions, races, async close/resource release, lost await, inverted conditions, off-by-one, null derefs, swallowed errors, copy-paste renames. No praise - findings with path/line + why broken." No reasoning passed to reviewers. Fix each finding as own commit.
  3. AUDIT the slice: run its behavior.json checks + the FULL test suite. Slice done only when: all behavior checks pass, full suite green, review findings fixed.
  4. Commit the slice (revertable), tick it in plan.md, flip its behavior checks to "passes": true.
- Order: foundations first (utils, core), then dependents. Never leave the tree red between slices.
P4 FINAL VERIFY: full suite + typecheck + lint green; behavior.json ALL passes:true; nothing deleted (diff behavior against the pre-overhaul inventory).
P5 REPORT: before/after table (LOC, files, modules, structure tree, test count), what was merged/split/deleted/renamed, remaining debt. NO PUSH.
Unattended: bulba-driver.mjs <dir> --task "overhaul: <scope>" (MEA loop applies; questions land in ${dir}/questions.md).`,
    },
    go: {
      description: "Approve the plan and start execution (flips STATUS to IN_PROGRESS)",
      template: `GO: approve the plan and start execution.
1. Read ${dir}/plan.md - if STATUS is AWAITING_APPROVAL, flip it to IN_PROGRESS.
2. Present the user a 5-bullet summary: goal, success criteria, first task.
3. Begin executing the first task per the plan (P3-P8). $ARGUMENTS`,
    },
    critique: {
      description: "Critically audit the user's idea/task: flaws, risks, cheaper alternatives (no sycophancy)",
      template: `CRITIQUE the idea/task: $ARGUMENTS
Analyze it like an adversarial engineer, not a yes-man:
1. Strengths - one line max.
2. Concrete flaws: what breaks, what's missing, edge cases, hidden costs (maintenance, deps, scaling).
3. Risks: security, data, vendor lock, what could silently go wrong.
4. Cheaper/simpler alternatives: what solves 80% with 20% of the effort (ponytail ladder).
5. What's over-engineered or premature.
Verdict: proceed / proceed with changes / rethink. Be specific, no praise, no hedging.`,
    },
    retro: {
      description: "Retrospective: lessons from past sessions -> what to improve in how you work (and in Bulba)",
      template: `RETRO: review how work has been going. $ARGUMENTS
1. Read ${dir}/lessons.md, ${dir}/sessions/ (last 5-10 entries), ${dir}/driver.log tail, and plan.md history.
2. Analyze: what repeatedly failed (retries, stalls, bad guesses), what worked well, where time/tokens were wasted, what decisions were wrong in hindsight.
3. Propose 3-5 concrete improvements: to how you work (rules, checks), and to the Bulba config (options, commands) if applicable.
4. Write ${dir}/retro-<date>.md: wins, losses, improvement list with expected impact.
5. Reply: the top 3 improvements, one line each.`,
    },
    danger: {
      description: "Danger mode setup: sudo via SUDO_ASKPASS (password never visible to the model)",
      template: `DANGER MODE setup (user must type the password, never in chat): $ARGUMENTS
1. If ~/.bulba/.sudo-askpass does not exist: tell the user to run this in THEIR OWN terminal (replace PASSWORD):
   printf '%s\\n' 'PASSWORD' > ~/.bulba/.sudo-askpass && chmod 600 ~/.bulba/.sudo-askpass
   Bulba never sees the password - and is blocked from reading the file.
2. Verify: run "SUDO_ASKPASS=~/.bulba/.sudo-askpass sudo -A true". If it fails - tell the user to fix the file, don't guess.
3. Then proceed with the task using SUDO_ASKPASS=~/.bulba/.sudo-askpass sudo -A <cmd> for root commands, following the DANGER rules in context: safety check before every dangerous command, reversible changes, verify the system state after.`,
    },
    status: {
      description: "Native status: plan/goal state, last audits, stall info - is work stuck or progressing",
      template: `STATUS: report the current work state natively (no external tools). $ARGUMENTS
1. Read ${dir}/plan.md and ${dir}/goal.md: STATUS, open tasks, ## Review entries (last audit verdicts).
2. Read ${dir}/driver.log tail if it exists (driver state) and ${dir}/sessions/ (recent session logs).
3. Answer in chat: what is in progress, the last audit verdict, whether anything is stalled (no progress across rounds) and what the next step is. Short: 5-8 lines.`,
    },
    usage: {
      description: "Session cost/context report + compaction advice",
      template: `USAGE: report on this session's token/cost economy.
1. Estimate from context: tokens used in this session (input+output), approximate cost if you know the model's price, current context usage %.
2. If context is getting heavy (>70%): suggest a concrete compaction plan - what to summarize, what to drop, what belongs in memory.md.
3. Keep it short: a small table or 5 bullets max.`,
    },
  }

  return {
    config(config) {
      if (cfg.commands) {
        config.command = { ...(config.command ?? {}), ...commands }
      }
      // Guard: деструктивные команды запрещены на уровне permission-конфига.
      if (cfg.guard) {
        const shell = config.permission?.shell
        config.permission = {
          ...(config.permission ?? {}),
          shell: typeof shell === "object" && shell !== null ? { ...shell, ...GUARD_RULES.shell } : GUARD_RULES.shell,
        }
      }
      // Вложенные субагенты: task tool может звать суб-субагентов.
      config.subagent_depth = cfg.subagentDepth
      // Дефолтный primary-агент - только по явной опции (не захватываем чужой дефолт).
      if (cfg.defaultAgent) config.default_agent = "bulba"
      // DANGER: файл askpass невидим модели (read+bash deny) - пароль не утечёт.
      if (cfg.dangerMode) {
        const read = config.permission?.read
        const bash = config.permission?.bash
        config.permission = {
          ...(config.permission ?? {}),
          read: { ...(typeof read === "object" && read !== null ? read : {}), "*/.sudo-askpass*": "deny", "*.bulba/.sudo-askpass*": "deny" },
          bash: { ...(typeof bash === "object" && bash !== null ? bash : {}), "*sudo-askpass*": "deny" },
        }
      }
      // Агент Bulba: primary — модель сама роутит задачи по промпту (как omo: ultrawork).
      if (cfg.agents) {
        config.agent = {
          ...(config.agent ?? {}),
          bulba: {
            mode: "primary",
            color: "#FF8C00", // оранжевый
            description: "Bulba: автономный агент-разработчик (роутинг задач, dev-цикл, AWAY)",
            prompt: `You are Bulba, an autonomous development agent (Long Horizon Harness style). Route every user request to the right workflow:
- Implementation/dev task -> DEVELOP protocol (P1-P8): plan (read-only, bulba-planner) -> questions -> tasks (with Acceptance criteria in plan.md) -> subagents (bulba-implementer) -> commits -> adversarial review (bulba-reviewer) -> verify gate (bulba-verifier) -> report, no push without approval (/publish).
- Codebase overhaul / rewrite / restructure / "оптимизируй всю кодбазу" / "перепиши проект" -> /overhaul (structure first, then slice-by-slice MEA rewrite, zero functionality loss).
- Session start (any active plan/goal): get your bearings first - pwd, git log --oneline -15, read .bulba/plan.md / goal.md / progress files, then run the init.sh smoke test if present. Never start new work before knowing the state.
- Work ONE feature at a time, never one-shot. Every feature flips to done only after real end-to-end verification (run the app/tests as a user would).
- "Work while I'm away" / "я уйду" / "until I return" -> AWAY flow: write ${dir}/goal.md with "MODE: AWAY" + the task, work autonomously until the user returns, then close with STATUS: DONE + full report.
- Research on ANYTHING (tech, health, ideas, "find the best X") -> /research or bulba-researcher (task tool, evidence-based, 5+ candidates, health guardrails). Idea critique -> bulba-critic (task tool). Performance optimization -> bulba-optimizer (max-out, system-aware). Need a skill that does not exist -> bulba-skillfinder (temp-first, install only with consent). Planning only -> /plan. Goal -> /goal. Docs -> /docs. UI tests -> /test-ui. Diff review -> bulba-reviewer or /develop P6. Quality cleanup -> /simplify. Over-engineering audit -> /audit. Security -> /security-review. Learn a repo -> /study. Load a skill -> /skill. Architecture question -> /graph. Publish -> /publish.
- Ambiguous? Ask via the question tool first (up to ${cfg.maxQuestions} questions).
Follow the always-on style rules (minimal code, tests, no slop).`,
          },
          "bulba-planner": {
            mode: "subagent",
            description: "Read-only planner: plan a task, ask the user questions, write .bulba/plan.md",
            prompt: `PLANNER (read-only): you write the plan, others execute.
Never edit files or run state-changing commands (only ls, git status/log/diff, find, grep, cat).
1. Read the task + related code (patterns, similar features).
2. Ask up to ${cfg.maxQuestions} clarifying questions via the question tool (ambiguous scope, boundaries, what NOT to do). Wait for answers.
3. Write ${dir}/plan.md:
${PLAN_TEMPLATE}
Include Critical Files (3-5 key files) and Risks.
Report: plan summary + open questions.`,
            permission: { edit: "deny", write: "deny", apply_patch: "deny" },
          },
          "bulba-implementer": {
            mode: "subagent",
            description: "Implement one task from the plan: code + test + commit",
            prompt: `IMPLEMENTER: complete exactly one task from ${dir}/plan.md. Read the plan and the task first.
- Code + test (no test = not done). Tick the task in plan.md when done.
- Don't fix unrelated issues - suggest as follow-ups. Never retry the same failed approach twice.
- Run that task's tests; commit ONLY your files (no git add .), style from git log (no history -> conventional).
- Report: what you did (paths), tests, commit hash.`,
          },
          "bulba-reviewer": {
            mode: "subagent",
            description: "Auditor/reviewer: assumes the diff is wrong, verifies from the environment (read-only)",
            prompt: `REVIEWER (auditor, adversarial, read-only): assume the code is wrong. You get the diff + the task and nothing else - judge only the diff and the ENVIRONMENT.
1. Find: bugs in untouched lines of modified functions, races, async close/resource release, lost await, inverted conditions, off-by-one, null derefs, swallowed errors, copy-paste renames. No praise - findings with path/line and why it breaks.
2. VERIFY from the environment: run the relevant tests yourself (read-only commands allowed), check the task's acceptance criteria actually hold. You never edit, never commit, never fix.
3. End with EXACTLY these three lines (nothing after them):
Status: complete|incomplete|blocked
Integrity: clean|suspect
Contract: aligned|unknown`,
            permission: { edit: "deny", write: "deny", apply_patch: "deny" },
          },
          "bulba-verifier": {
            mode: "subagent",
            description: "Verify gate: run the full test suite, typecheck, lint until green",
            prompt: `VERIFIER: prove the work actually passes.
1. Find + run the FULL tests (package.json/README): bun test / npm test / pytest / cargo test etc. "Smoke"/"should work" don't count.
2. Confirm tests ran: sane count, 0 skipped, 0 deleted by you.
3. Typecheck + lint if present. Red? Fix the CODE (not tests, no skipping), repeat to green.
4. Report: commands, pass/fail/skip counts. Not ready? Say so.`,
          },
          "bulba-debugger": {
            mode: "subagent",
            description: "Triage failures from evidence: reproduce, read the log, bisect, minimal fix",
            prompt: `DEBUGGER (triage): fix the failure from evidence, not guesses.
1. Reproduce: run the failing command, capture the exact error/log.
2. Triage: read the full backtrace/log, identify the failing module and line, check recent changes (git log/blame on that file).
3. Hypothesis with evidence; if multiple candidates - bisect (git bisect or binary search on inputs).
4. Fix minimally: one change, run the failing test + related tests. No shotgun fixes.
5. Report: root cause, fix, tests. Not reproducible? Say so - never invent a cause.`,
          },
          "bulba-benchmarker": {
            mode: "subagent",
            description: "Honest performance measurement: before/after tables, no cherry-picking",
            prompt: `BENCHMARKER: honest performance measurement.
1. Find or define the benchmark: existing suite, or write a minimal one (same input, N runs, warmup).
2. Measure: before/after, median + p95, note the environment (CPU, load).
3. Compare fairly: same conditions, enough runs for stability, no cherry-picking.
4. Report: table (metric | before | after | delta), interpretation, what could skew the result.
Never claim "faster" without the numbers.`,
          },
          "bulba-paper-explainer": {
            mode: "subagent",
            description: "Explain a paper down to implementation: method, formulas, training details",
            prompt: `PAPER-EXPLAINER: explain a paper down to "how to implement it".
1. Fetch the paper (arXiv abs page or PDF via webfetch).
2. Extract: problem, method step by step, key formulas/algorithm, training details, results.
3. Map to implementation: concrete architecture, data flow, hyperparameters, sketch the key functions.
4. Note what is unclear or needs experimentation, and what looks cherry-picked.
5. Output: .bulba/research/explain-<slug>.md + reply with the method summary and the implementation sketch.`,
          },
          "bulba-optimizer": {
            mode: "subagent",
            description: "Max-out optimizer: profile, optimize hard, measure honestly - and never overload the machine",
            prompt: `OPTIMIZER (max-out, system-aware): squeeze the hot paths to the max - but never crash the machine.
1. Profile first: find the hot path (cpu profile / perf / measured loop) - never guess. Measure BEFORE any change.
2. Identify waste: repeated work, allocations, cache misses, redundant copies, sync overhead.
3. Optimize hard but methodically: ONE change at a time, re-measure after each, keep only measurable gains (median + p95), revert what doesn't help. Combine winners at the end.
4. System awareness (mandatory before any heavy run): check load (uptime), free memory (free -m or /proc/meminfo), core count (nproc). Run heavy benchmarks with nice/ionice, cap parallelism (never saturate all cores when the machine is busy, leave headroom), abort the benchmark if load exceeds cores or free memory drops below ~10%. The user's other work and the machine's stability come first - a benchmark that kills the system proves nothing.
5. Correctness: same outputs, tests green after every change.
6. Report: before/after table (the only truth), what was tried and rejected and why, and the final combined win.`,
          },
          "bulba-webdev": {
            mode: "subagent",
            description: "Extract a reference URL into a DESIGN.md template (colors light+dark, type, spacing)",
            prompt: `WEBDEV (design extraction): turn a reference URL into a DESIGN.md template.
1. Fetch the URL (webfetch), screenshot if possible.
2. Extract the design system: palette (light AND dark), typography (families, sizes, weights), spacing scale, radius, shadows, component patterns, do/don't.
3. Write .ai-docs/DESIGN.md in the DESIGN.md format: YAML tokens + analysis section.
4. Report: the key tokens + what could NOT be extracted. Never invent tokens - mark unknowns as "to confirm".`,
          },
          "bulba-security": {
            mode: "subagent",
            description: "Total security audit: code + dependencies + system + config, read-only, exploitability-first",
            prompt: `SECURITY (total autonomous audit): find vulnerabilities in code, dependencies, config and the system. READ-ONLY - you audit, you do NOT fix (fixes only on explicit user request). Never run destructive commands.
1. CODE: scan for injection (SQL/command/XSS), auth/authz bypasses, crypto misuse (hardcoded keys, weak algorithms), unsafe deserialization, SSRF, path traversal, secrets in code/comments/logs, race conditions in critical paths. Use grep patterns for candidates, then READ the actual code around every match - a pattern match without reading the code is not a finding.
2. DEPENDENCIES: run whatever audit exists (npm audit / bun audit / cargo audit / pip-audit / trivy). Report known CVEs with severity and the fix version. No audit tool? List the manifest and note "manual review needed".
3. SYSTEM (machine audit): listening ports (ss -tlnp), running services, world-writable files in critical dirs, sudoers sanity, failed units, exposed credentials in common locations. Read-only queries only.
4. CONFIG: env vars and config files with secrets, debug endpoints exposed, permissive CORS, missing auth on internal services, default credentials.
5. Severity by ACTUAL exploitability, not theory: what an attacker needs, what they gain. Evidence for every finding: path:line + the exploit path. Mark each finding "verified" or "suspected" - never blur the line.
6. Report: .bulba/security/audit-<date>.md - findings table (severity | location | exploit path | fix), top 5 priorities, what was NOT covered. Reply with the top 5.`,
          },
          "bulba-skillfinder": {
            mode: "subagent",
            description: "Find or draft a skill - but NEVER install anything without asking the user first (hard security rules)",
            prompt: `SKILLFINDER: find or draft a skill for the task. SECURITY IS NON-NEGOTIABLE:
- NEVER download or run executables, scripts, or binaries from the web - no npm install, no pip install, no curl|bash, no fetched code execution. Ever.
- NEVER install any skill (permanent or temp) that came from the web without asking the user FIRST via the question tool: "I found <skill> from <source>, it may help with <task>, install it?" - present source, what it does, what it would change; WAIT for the answer.
- A skill YOU write yourself from your own analysis is just a text file of instructions: you may draft it at .bulba/skills/<name>/SKILL.md (session-scoped, gitignored, marked "draft"). Drafting your own text is fine; fetching or executing is not.
Workflow:
1. Check what exists: curated index (see /skill), skillsDir, .bulba/skills/. Good skill exists? Point to it, done.
2. Search for an official one (anthropics/skills, awesome-agent-skills, vendor repos). Evaluate the fetched SKILL.md against the task WITHOUT executing it.
3. Found a good one? ASK the user (question tool) before creating anything from it - even the temp copy. Present: source, what it covers, what it would install.
4. Nothing found? Research the task (search_web), write your OWN draft skill: .bulba/skills/<name>/SKILL.md - frontmatter + concrete instructions, marked "draft - refine with use".
5. Report: what exists / what was found / what you drafted, and what awaits the user's decision.`,
          },
          "bulba-researcher": {
            mode: "subagent",
            description: "Deep research, ANY domain (tech, health, ideas): evidence-based, 5+ candidates, comparison table, confidence",
            prompt: `RESEARCHER (deep research, evidence-based, ANY domain): find the BEST answer - never the first hit.
1. Query broadly, 2+ sources per angle, domain-appropriate:
   - tech/ML: arXiv (export.arxiv.org/api/query?search_query=all:"<topic>"&max_results=20), GitHub, papers-with-code, official docs.
   - software/tools: official docs, GitHub activity, benchmarks, release notes.
   - health/medicine: PubMed, WHO, reputable clinical sources and guidelines - NEVER random blogs or forums as evidence.
   - general: SearXNG (search_web) + official/primary sources.
   DECOMPOSE (STORM): split the core question into 3-5 concrete search queries covering different angles (background, state of the art, alternatives, controversy) - one query per angle, then run each.
2. For every candidate: read the ACTUAL source - methods, metrics, findings (not just titles). Check recency and credibility: who publishes, last update, citations, real usage. MERGE snippets from the same URL across queries (dedup by URL).
3. Examine AT LEAST 5 candidates before any verdict. Never recommend the first result; explicitly list rejected candidates and why.
4. Output a comparison table: candidate | source/date | key facts or metrics | credibility | effort to adopt/verify. For each column pick the TOP-K most relevant citations - not everything collected.
5. HONESTY BRANCH: if a candidate or a fact cannot be verified from the sources - say "I cannot answer based on available information" and mark it SPECULATION, never fabricate a citation.
6. STRICT EVIDENCE SEPARATION - the user must never doubt what is real:
   - Every factual claim carries its source reference right next to it.
   - Speculation is allowed when evidence is missing, but ONLY explicitly marked: "SPECULATION: no direct benchmark A vs B exists; based on [X] and [Y] I assume Z". Never present an assumption as a fact.
   - Both in the report and in the reply: two explicit sections - "VERIFIED (sourced)" and "SPECULATION (my inference)".
   - The verdict states what is proven, what is assumed, and the confidence rating applies ONLY to the verified part.
6. HEALTH TOPICS: mark the evidence level (clinical trial / guideline / expert opinion / anecdote), recency, conflicts of interest; end with "discuss with your doctor before acting" - never prescribe or diagnose definitively.
7. Write the full report to .bulba/research/<slug>.md (TL;DR, comparison table with evidence type per row, sources, open questions). Reply with the table + verdict with the verified/speculation split + confidence.`,
          },
          "bulba-critic": {
            mode: "subagent",
            description: "Adversarial idea reviewer: attacks the idea/architecture like a hostile expert (no sycophancy)",
            prompt: `CRITIC (adversarial idea reviewer): critique the idea or architecture like a hostile expert. No praise, no hedging.
1. Restate the idea precisely in one line; if ambiguous - list the assumptions you're judging.
2. Attack: theoretical flaws, implementation pitfalls, why it might fail, what's over-engineered, simpler alternatives.
3. Compare against the stated baseline: is it actually better? By which metric? What does it cost (complexity, compute, memory, maintenance)?
4. Verdict: adopt / adopt with changes / reject. Confidence + the single experiment that would falsify your verdict.
Be specific, cite mechanisms, no vibes.`,
          },
        }
      }
      // Keep the state dir out of git (scratch space). Relative entry when
      // the state dir lives inside the project (git ignores absolute paths).
      try {
        const rel = dir.startsWith(input.directory) ? dir.slice(input.directory.length).replace(/^[/\\]+/, "") : dir
        if (rel) {
          const gi = join(input.directory, ".gitignore")
          const existing = existsSync(gi) ? readFileSync(gi, "utf8") : ""
          if (!existing.split("\n").some((l) => l.trim() === `${rel}/`)) {
            writeFileSync(gi, `${existing.replace(/\n+$/, "")}\n${rel}/\n`)
          }
        }
      } catch {}
      // Skill auto-discovery: index <skillsDir>/*/SKILL.md descriptions (Hermes-style, one line each).
      if (cfg.skillsDir) {
        try {
          const entries = readdirSync(cfg.skillsDir, { withFileTypes: true })
          const lines = entries
            .filter((e) => e.isDirectory())
            .map((e) => {
              const md = join(cfg.skillsDir, e.name, "SKILL.md")
              if (!existsSync(md)) return
              const text = readFileSync(md, "utf8")
              const desc = text.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? ""
              return `- ${e.name}${desc ? `: ${desc.slice(0, 120)}` : ""}`
            })
            .filter(Boolean)
          if (lines.length) writeFileSync(join(dir, "skills-index.md"), `# Skills\n${lines.join("\n")}\n`)
        } catch {}
      }
    },
    // Local SearXNG web search (zero-dep tool, legacy JSON-schema args).
    tool: {
      search_web: {
        description:
          "Search the web via the local SearXNG instance. Returns ranked results (title, url, snippet). Use before webfetch to find relevant pages; prefer official docs.",
        args: {
          query: { type: "string", description: "Search query" },
          max_results: { type: "number", description: "Max results to return (default 8)" },
        },
        execute: async (args) => {
          const limit = Math.min(Number(args.max_results ?? cfg.searxngMaxResults) || 8, 20)
          let res
          try {
            res = await fetch(
              `${cfg.searxngUrl}/search?${new URLSearchParams({ q: String(args.query), format: "json" })}`,
              { signal: AbortSignal.timeout(15_000) },
            )
          } catch (e) {
            return `SearXNG unavailable at ${cfg.searxngUrl}: ${e.message}. Retry later or use another search method.`
          }
          if (!res.ok) return `SearXNG error: HTTP ${res.status}.`
          const data = await res.json().catch(() => undefined)
          const results = Array.isArray(data?.results) ? data.results : []
          if (!results.length) return "No results."
          return results
            .slice(0, limit)
            .map((r, i) => {
              const title = String(r.title ?? "").trim()
              const url = String(r.url ?? "")
              const content = String(r.content ?? "").trim().slice(0, 250)
              return `${i + 1}. [${title}](${url})\n   ${content}`
            })
            .join("\n")
        },
      },
      // Компакция контекста: вызывает session.summarize (AI-компакция opencode).
      // Модель зовёт этот тул на ~80-90% контекста ПОСЛЕ обновления базы знаний.
      compact_context: {
        description:
          "Trigger context compaction for this session (after you have updated the knowledge base). Call when context usage is ~80-90%. Returns when compaction is done.",
        args: {},
        execute: async (_args, context) => {
          try {
            await input.client.session.summarize({ path: { id: context.sessionID } })
            return "Compaction triggered. The knowledge base (.bulba/memory.md, lessons, sessions) is your source of truth now."
          } catch (e) {
            return `Compaction failed: ${e.message}. Update the KB manually and tell the user to compact.`
          }
        },
      },
      // Hermes-style recall: keyword search over project memory + session archive.
      search_memory: {        description:
          "Search project memory and past session notes (memory.md, sessions/, ai-docs). Returns matching excerpts with file references - use for recall before re-asking or re-learning.",
        args: {
          query: { type: "string", description: "Keywords to search (case-insensitive)" },
          max_results: { type: "number", description: "Max excerpts (default 5)" },
        },
        execute: async (args) => {
          const q = String(args.query)
          const limit = Math.min(Number(args.max_results) || 5, 10)
          const roots = [dir, join(input.directory, cfg.docsDir)]
          let out = ""
          for (const bin of ["rg", "grep"]) {
            try {
              const files = roots.filter((r) => existsSync(r))
              if (!files.length) return "No memory or docs yet."
              const { stdout } = await execFileAsync(
                bin,
                bin === "rg"
                  ? ["-i", "-n", "-m", String(limit * 2), "-e", q, ...files, "-g", "*.md"]
                  : ["-ri", "-n", "-m", String(limit * 2), q, ...files],
                { timeout: 8_000 },
              )
              if (stdout.trim()) {
                out = stdout.trim().split("\n").slice(0, limit)
                break
              }
            } catch {}
          }
          return out ? out.join("\n") : `Nothing in memory for "${q}". Suggest: append it to memory.md or run /docs.`
        },
      },
    },
    // AWAY-триггер: «я уйду» - решение харнесса, не модели (как omo auto-slash-commands).
    "chat.message": async (_input, output) => {
      const parts = output.parts ?? output.message?.parts ?? []
      const text = parts
        .filter((p) => p.type === "text")
        .map((p) => p.text ?? "")
        .join(" ")
        .slice(0, 300)
      if (!/я уйду|ухожу|отойду|пока меня нет|не мешаю|до моего возвращения|work until i return|while i'?m away|when i'?m gone|away mode/i.test(text)) return
      const active = activeWork()
      if (active.goalActive) return // уже есть цель
      try {
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, "goal.md"), `# Goal: ${text.trim()}\nMODE: AWAY\n`)
      } catch {}
    },
    // Memory/goal/rules injected every turn.
    "experimental.chat.system.transform": async (input, output) => {
      const block = systemBlock(input?.sessionID)
      if (block) output.system.push(block)
    },
    // AGENTS.md-правила + активная работа: прямо в результаты тулов (как omo, без roundtrip).
    "tool.execute.after": async (input, output) => {
      const { tool, sessionID, args } = input
      // Наблюдение цикла MEA: реальные вызовы task-тула с ролевыми субагентами.
      if (tool === "task" && sessionID) {
        const kind = String(args?.subagent_type ?? "")
        if (kind === "bulba-implementer" || kind === "bulba-reviewer") {
          const d = delegation.get(sessionID) ?? { implementer: 0, reviewer: 0 }
          if (kind === "bulba-implementer") d.implementer++
          else d.reviewer++
          delegation.set(sessionID, d)
        }
      }
      const { goalActive, planActive } = activeWork()
      // Правила в точке действия: компактный блок в edit/write при активной работе.
      if (cfg.rulesInject && (tool === "edit" || tool === "write") && (goalActive || planActive)) {
        output.output = `${output.output ?? ""}\n\n[Active work]\n- Tick the plan.md checklist after finishing this task; commit per task (no git add .).\n- Never self-review: delegate the diff to 2 bulba-reviewer subagents.\n- Done = verify gate green (tests, Review >= 2 findings, verify.md).`
        return
      }
      // Bash-гейт: python/sed-редактирование и grep через shell обходят инфорс - пинок.
      if (tool === "bash" && cfg.rulesInject) {
        const cmd = String(args?.command ?? "")
        const pythonWrite =
          /\bopen\(\s*["'][^"']+["']\s*,\s*["']w|write_text|write_bytes|os\.(remove|rename|unlink)|shutil\.(move|rmtree|copy)\b|sed\s+-i|perl\s+-pi/.test(cmd)
        const shellGrep = /(^|[\s;&|])(grep|rg|find)\s+/.test(cmd)
        if (pythonWrite) {
          output.output = `${output.output ?? ""}\n\n[Bulba] You edited files via python/shell - the harness enforcement (no-slop, guard, rules) can't see those edits. Use the edit/multiedit tools for text files; python is only for binary/data transforms.`
        } else if (shellGrep) {
          output.output = `${output.output ?? ""}\n\n[Bulba] You grepped via the shell - use the grep/glob tools instead (cheaper, matched lines only, rules injection works).`
        }
        return
      }
      if (tool === "read" && cfg.rulesInject) {        const file = args?.filePath ?? args?.path
        if (typeof file !== "string" || !sessionID) return
        const md = findNearestRulesMd(file)
        if (!md) return
        let cached = rulesCache.get(sessionID)
        if (!cached) {
          cached = new Map()
          rulesCache.set(sessionID, cached)
        }
        const sig = `${statSync(md).size}:${statSync(md).mtimeMs}`
        if (cached.get(md) === sig) return // уже дописаны в этой сессии
        let text
        try {
          text = readFileSync(md, "utf8").slice(0, 2_000)
        } catch {
          return
        }
        if (!text.trim()) return
        cached.set(md, sig)
        output.output = `${output.output ?? ""}\n\n[Rules: ${md}]\n${text}`
        return
      }
      // No-slop: проверить добавленный текст (как omo comment-checker, хеуристикой).
      if (!cfg.slopCheck || (tool !== "edit" && tool !== "write" && tool !== "multiedit")) return
      const added = tool === "write" ? args?.content : tool === "multiedit" ? (args?.edits ?? []).map((e) => e.new_string).join("\n") : args?.newString ?? args?.new_string
      const findings = checkSlop(added)
      if (!findings.length) return
      output.output = `${output.output ?? ""}\n\n[No-slop] ${findings.length} suspect comment(s):\n${findings
        .map((f) => `- line ~${f.line}: "${f.text}" (${f.why})`)
        .join("\n")}\nFix them or justify.`
    },
    // MEA: активный план - менеджер не редактирует код, только state-файлы.
    // Роль сессии из env (драйвер): implementer - может править, auditor - структурный read-only.
    "tool.execute.before": async (input, output) => {
      const role = resolveRole(input.sessionID)
      if (role === "auditor" && (input.tool === "edit" || input.tool === "write" || input.tool === "apply_patch" || input.tool === "multiedit")) {
        throw new Error("[Bulba auditor] read-only session - you audit, you do NOT edit. Report findings with the structured verdict.")
      }
      if (role === "auditor" && input.tool === "bash" && PY_WRITE_RE.test(String(output.args?.command ?? ""))) {
        throw new Error("[Bulba auditor] read-only session - no file edits.")
      }
      if (role === "implementer") {
        // имплементер - экзекутор, правки разрешены
        if (!cfg.blockPythonEdits || input.tool !== "bash") return
        if (PY_WRITE_RE.test(String(output.args?.command ?? ""))) {
          throw new Error(
            "[Bulba] python/shell file editing is blocked - use the edit/multiedit tools (the harness enforcement can't see python edits).",
          )
        }
        return
      }
      if (cfg.strictMode) {
        const { goalActive, planActive } = activeWork()
        if (goalActive || planActive) {
          if (input.tool === "edit" || input.tool === "write" || input.tool === "apply_patch" || input.tool === "multiedit") {
            throw new Error(
              "[Bulba strict mode] execution runs in the driver (bulba-driver.mjs via /orchestrate), not in this session. Your job here: plan, ask questions, review progress, approve. No direct edits while a goal/plan is active.",
            )
          }
          if (input.tool === "bash" && PY_WRITE_RE.test(String(output.args?.command ?? ""))) {
            throw new Error("[Bulba strict mode] no file edits from this session - run the driver.")
          }
        }
      }
      if (cfg.meaEditBlock && (input.tool === "edit" || input.tool === "write" || input.tool === "apply_patch" || input.tool === "multiedit")) {
        const { planActive, goalActive } = activeWork()
        if (planActive || goalActive) {
          const file = String(output.args?.filePath ?? output.args?.path ?? "")
          const rel = file.replaceAll("\\", "/")
          const stateRel = dir.replaceAll("\\", "/")
          // state-файлы (plan/goal/memory/...) менеджер редактирует; код - нет.
          if (!rel.includes(stateRel) && !/plan\.md$|goal\.md$|memory\.md$|lessons\.md$|verify\.md$|features\.json$|questions\.md$/.test(rel)) {
            throw new Error(
              "[Bulba MEA] You are the manager - you do NOT edit code directly. Delegate to bulba-implementer (task tool) and await its summary; then bulba-reviewer audits it.",
            )
          }
        }
      }
      if (!cfg.blockPythonEdits || input.tool !== "bash") return
      if (PY_WRITE_RE.test(String(output.args?.command ?? ""))) {
        throw new Error(
          "[Bulba] python/shell file editing is blocked - use the edit/multiedit tools (the harness enforcement can't see python edits).",
        )
      }
    },
    // AWAY: авто-ответы на permission (работа - allow, outward - reject). В обычном режиме не вмешиваемся.
    // Enforcer: on idle, keep the agent working until goal/plan closed.
    // On completion: verify the work actually happened (git clean, checklist, artifacts),
    // then one-time consolidation nudge while context is fresh.
    event: async ({ event }) => {
      // Ролевые сессии драйвера: энфорсер и гейты не нужны - драйвер сам цикл.
      const sessionID = event.properties?.sessionID
      if (!sessionID) return
      if (resolveRole(sessionID)) return
      // AWAY: авто-ответы на permission-запросы (работа - allow, outward - reject).
      if (cfg.awayAutoApprove && (event.type === "permission.v2.asked" || event.type === "permission.asked")) {
        const goal = readGoal(dir)
        if (goal?.away && !goal.done) {
          const p = event.properties ?? {}
          const action = String(p.action ?? p.permission ?? "")
          const resources = Array.isArray(p.resources)
            ? p.resources.map(String).join(" ")
            : Array.isArray(p.patterns)
              ? p.patterns.map(String).join(" ")
              : String(p.resources ?? "")
          const permissionID = String(p.id ?? p.permissionID ?? "")
          if (!permissionID) return
          if (action === "external_directory" || (action === "bash" && OUTWARD_RE.test(resources))) {
            await replyPermission(input.client, sessionID, permissionID, "reject", "outward action - not allowed in AWAY mode")
          } else if (action === "webfetch" && !/^https:\/\//i.test(resources.trim())) {
            await replyPermission(input.client, sessionID, permissionID, "reject", "non-https fetch blocked")
          } else {
            await replyPermission(input.client, sessionID, permissionID, "once")
          }
        }
        return
      }
      // Компакт: запомнить момент + сразу обновить базу знаний (память/уроки/сессии),
      // чтобы сжатый контекст опирался на KB, а не на потерянные детали.
      if (event.type === "session.compacted") {
        compactedAt.set(sessionID, Date.now())
        compactPrompted.delete(sessionID) // следующий цикл роста контекста снова сработает
        if (!kbUpdated.has(sessionID)) {
          kbUpdated.set(sessionID, true)
          await input.client.session
            .prompt({
              path: { sessionID },
              body: {
                prompt:
                  "[Bulba] Context was compacted. Before continuing, update the knowledge base with everything important from this session, structured as:\nGoal: what this session is trying to achieve (1 line)\nDecisions: what was decided and why (bullet list, no duplicates)\nFacts: what was learned - gotchas, numbers, findings (bullet list)\nWrite it to:\n1. .bulba/memory.md (the structured block above, merged without duplicates)\n2. .bulba/lessons.md - 1-2 lessons if any\n3. .bulba/sessions/<today>.md - a dated entry: what was done, key numbers.\nThen continue the work relying on the KB (it is injected each turn).",
              },
            })
            .catch(() => {})
        }
        return
      }
      // Синтетический idle из session.status (как omo: session-status-normalizer).
      if (event.type === "session.status") {
        if (event.properties?.status?.type !== "idle") return
      } else if (event.type !== "session.idle") {
        return
      }
      // Гейт после компакта: дать агенту пересобрать контекст.
      const now = Date.now()
      if (compactedAt.has(sessionID) && now - compactedAt.get(sessionID) < cfg.compactionGuardMs) return
      // ПРОГРАММНЫЙ триггер контекста: оцениваем токены по сообщениям, не верим модели.
      if (cfg.contextAutoCompact && !compactPrompted.has(sessionID)) {
        const est = await estimateContextTokens(sessionID)
        const window = (await resolveContextWindow(sessionID)) ?? cfg.contextWindowTokens
        if (est > 0 && window > 0 && est / window > cfg.contextCompactPct) {
          compactPrompted.set(sessionID, true)
          await input.client.session
            .prompt({
              path: { sessionID },
              body: {
                prompt:
                  "[Bulba] Context is ~" + Math.round((est / window) * 100) + "% full (detected window " + window + " tokens, estimated programmatically). Update the knowledge base now, structured as Goal / Decisions / Facts, into .bulba/memory.md + .bulba/lessons.md + .bulba/sessions/<today>.md - then compaction will be triggered automatically.",
              },
            })
            .catch(() => {})
          await input.client.session.summarize({ path: { id: sessionID } }).catch(() => {})
          return
        }
      }
      const { goal, plan, goalActive, planActive } = activeWork()
      const driven = rounds.has(sessionID)

      // Work finished while we were driving it: verify, then consolidate once.
      if (driven && !goalActive && !planActive && !consolidated.has(sessionID)) {
        const problems = []
        const planText = fileText(dir, "plan.md")
        if (planText && /- \[ \]/.test(planText)) {
          const open = (planText.match(/- \[ \]/g) ?? []).length
          problems.push(`${open} unchecked task(s) in plan.md`)
        }
        // Враждебное ревью: секция ## Review с >= 2 находками (детерминированно).
        if (planText) {
          const reviewMatch = planText.match(/##\s*Review\n([\s\S]*?)(?=\n##\s|\nSTATUS|$)/i)
          const findings = reviewMatch
            ? (reviewMatch[1].match(/^\s*[-*]\s+[^\n]+$/gm) ?? []).filter((l) => l.trim().length > 8)
            : []
          if (!reviewMatch || findings.length < 2) {
            problems.push("## Review section needs >= 2 findings (file:line) - the adversarial review evidence")
          }
        }
        // Long Horizon Harness: features.json - все фичи passes:true (победа-слишком-рано блок).
        const featuresText = fileText(dir, "features.json")
        if (featuresText) {
          let features
          try {
            features = JSON.parse(featuresText)
          } catch {
            problems.push("features.json is invalid JSON")
            features = null
          }
          if (features && Array.isArray(features)) {
            const open = features.filter((f) => !f.passes).length
            if (open > 0) problems.push(`${open} feature(s) still "passes": false in features.json - verify end-to-end first`)
          }
        }
        // Артефакт-гейт: verify.md с реальным выводом тестов, новее последнего коммита.
        if (planText) {
          let vStat
          try {
            vStat = statSync(join(dir, "verify.md"))
          } catch {}
          if (!vStat) {
            problems.push("no .bulba/verify.md (test proof: commands + real output required)")
          } else {
            const commitTs = await lastCommitTs(input.directory)
            if (commitTs && vStat.mtimeMs / 1000 < commitTs - 5) {
              problems.push("verify.md is older than the last commit - tests may not cover the final state")
            }
          }
        }
        const gitDirty = await dirtyWorkingTree(input.directory)
        if (gitDirty) problems.push(`uncommitted changes in git (${gitDirty} file(s))`)

        // Цикл MEA: доказательство делегирования. Драйвер (/orchestrate) - сам по себе цикл.
        const driverActive = existsSync(join(dir, "driver.json"))
        if (planText && !driverActive) {
          const d = delegation.get(sessionID) ?? { implementer: 0, reviewer: 0 }
          if (d.implementer < 1) {
            problems.push("no bulba-implementer delegation observed this session - the MEA cycle requires delegating tasks to the implementer")
          }
          if (d.reviewer < 1) {
            problems.push("no bulba-reviewer audit observed this session - the MEA cycle requires auditing before ticking tasks")
          }
        }

        // Gate-dedup (prime): если воркспейс И набор проблем не менялись с прошлой
        // проваленной верификации - не дёргаем снова, а помечаем заблокированным.
        if (problems.length) {
          const sig = `${await progressSignature()}|${problems.join(";")}`
          if (sig === lastVerifySig.get(sessionID)) {
            const fails = (verifyFails.get(sessionID) ?? 0) + 1
            verifyFails.set(sessionID, fails)
            if (fails >= 2) {
              rounds.delete(sessionID)
              saveState()
              await input.client.session
                .prompt({
                  path: { sessionID },
                  body: {
                    prompt:
                      "[Bulba] Verification failed twice with no changes in between - the work is blocked and needs the user: here is what's failing and why. Don't keep spinning; ask the user to intervene.",
                  },
                })
                .catch(() => {})
              return
            }
          } else {
            lastVerifySig.set(sessionID, sig)
            verifyFails.set(sessionID, 1)
          }
        } else {
          verifyFails.set(sessionID, 0)
        }

        if (problems.length) {
          // Verification failed: poke the model — it claimed done, it's not.
          await input.client.session
            .prompt({
              path: { sessionID },
              body: {
                prompt: `[Bulba Verify] You marked the work DONE, but verification found: ${problems.join("; ")}. Fix it properly (commit the work, tick the tasks), then close it again. Don't argue - fix.`,
              },
            })
            .catch(() => {})
          return
        }

        consolidated.add(sessionID)
        rounds.delete(sessionID)
        saveState()
        await input.client.session
          .prompt({
            path: { sessionID },
            body: {
              prompt:
                "[Bulba] Work is finished and verified. Consolidate while context is fresh (keep it small):\n1. Update .bulba/memory.md - decisions, gotchas, what changed (no duplicates).\n2. Append a dated session note to .bulba/sessions/<today>.md: goal, outcome, key numbers (2-5 lines).\n3. Append 1-2 lessons to .bulba/lessons.md (what worked / what failed).\n4. Refresh .ai-docs: INDEX.md and the files this work touched (facts only, <= 80 lines each, STALE markers for outdated).\n5. Report to the user: done, with test results.",
            },
          })
          .catch(() => {})
        return
      }
      if (!goalActive && !planActive) {
        const idleN = (idleCount.get(sessionID) ?? 0) + 1
        idleCount.set(sessionID, idleN)
        // Авто-саммари: сессия долго простаивает - конспект в sessions/ + память (без вопросов).
        if (cfg.autoSummarizeEvery > 0 && idleN % cfg.autoSummarizeEvery === 0 && !summarized.has(sessionID)) {
          summarized.set(sessionID, true)
          await input.client.session
            .prompt({
              path: { sessionID },
              body: {
                prompt:
                  "[Bulba] Auto-summarize this session (no user input needed):\n1. Write a dated summary to .bulba/sessions/<today>.md: what was done, decisions, key numbers (5-8 lines).\n2. Merge new decisions/gotchas into .bulba/memory.md (no duplicates).\n3. Keep it small - summaries beat transcripts.",
              },
            })
            .catch(() => {})
          return
        }
        // compaction: memory over the cap - one nudge per session
        try {
          if (!memoryCompacted.has(sessionID) && statSync(join(dir, "memory.md")).size > cfg.memoryMaxBytes) {
            memoryCompacted.set(sessionID, true)
            await input.client.session
              .prompt({
                path: { sessionID },
                body: {
                  prompt:
                    "[Bulba Memory] memory.md is over the size cap. Compact it: move stale entries to .bulba/archive/, keep only fresh decisions/gotchas. Keep it under the cap.",
                },
              })
              .catch(() => {})
            return
          }
        } catch {}
        // Hermes-style memory nudge: idle, nothing active - remind to save knowledge.
        if (cfg.memoryNudgeEvery > 0 && idleN % cfg.memoryNudgeEvery === 0 && !nudged.has(sessionID)) {
          nudged.set(sessionID, true)
          await input.client.session
            .prompt({
              path: { sessionID },
              body: {
                prompt:
                  "[Bulba Memory] Quick memory check (answer in one line): anything from this session worth saving to .bulba/memory.md - a decision, a gotcha, a why? Append 1-3 lines if yes, else reply 'nothing new'.",
              },
            })
            .catch(() => {})
        }
        return
      }

      if (stopped.has(sessionID)) return // stall-stop: не дёргаем, пока нет прогресса
      const away = goal?.away === true
      const cap = away ? cfg.awayMaxRounds : cfg.maxRounds
      const round = (rounds.get(sessionID) ?? 0) + 1
      if (round > cap) {
        rounds.delete(sessionID)
        saveState()
        return
      }
      rounds.set(sessionID, round)
      saveState()
      // Stall-детектор: нет прогресса N нуджей подряд — стоп, не жжём токены.
      const sig = await progressSignature()
      if (sig === lastSig.get(sessionID)) {
        stallCount.set(sessionID, (stallCount.get(sessionID) ?? 0) + 1)
        if ((stallCount.get(sessionID) ?? 0) >= cfg.stallRounds) {
          rounds.delete(sessionID)
          stopped.add(sessionID)
          saveState()
          await input.client.session
            .prompt({
              path: { sessionID },
              body: {
                prompt:
                  "[Bulba] No progress across several rounds - stopping to save tokens. Tell the user what's blocking you and what you tried. Don't keep spinning.",
              },
            })
            .catch(() => {})
          return
        }
      } else {
        stallCount.set(sessionID, 0)
        lastSig.set(sessionID, sig)
        stopped.delete(sessionID) // появился прогресс — можно снова дёргать
      }
      const last = lastIdle.get(sessionID)
      if (last && Date.now() - last < cfg.idleDelayMs) return
      lastIdle.set(sessionID, Date.now())

      const lines = []
      if (goalActive) lines.push(`# Goal: ${goal.goal}${away ? " (MODE: AWAY)" : ""}`)
      if (planActive) {
        lines.push(`# Plan: ${plan.title} - tick [x] tasks, STATUS: DONE in plan.md`)
        if (plan.open === 0) lines.push("No open tasks in plan.md - create the checklist first (todo tool or plan.md), then work through it.")
      }
      // Реальный todo-енфорсер: читаем todo сессии через API (как omo).
      const todos = await sessionTodos(input.client, sessionID)
      if (todos !== undefined) {
        const incomplete = incompleteTodos(todos)
        if (todos.length === 0) {
          lines.push("[Todo] No todo list for this session - create it with the todo tool (work items + statuses), the enforcer tracks it.")
        } else if (incomplete > 0) {
          lines.push(`[Todo] ${incomplete} incomplete todo(s) - work through them, tick as you go.`)
        }
      }
      const header = away
        ? `[Bulba AWAY, round ${round}] User is still away - keep working perfectly`
        : `[Bulba Enforcer, round ${round}/${cfg.maxRounds}] Work is not finished`
      await input.client.session
        .prompt({
          path: { sessionID },
          body: {
            prompt: `${header}:\n${lines.join("\n")}\nContinue. If blocked - resolve it yourself or stop with a report.`,
          },
        })
        .catch(() => {})
    },
  }
}

// Проверка «модель не наврала»: незакоммиченные изменения в git.
// Возвращает число грязных файлов или 0 (не git-репо/ошибка = 0).
async function dirtyWorkingTree(directory) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", directory, "status", "--porcelain"], {
      timeout: 5_000,
    })
    return stdout.trim() ? stdout.trim().split("\n").length : 0
  } catch {
    return 0
  }
}

// Время последнего коммита (сек) или undefined (не git-репо).
async function lastCommitTs(directory) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", directory, "log", "-1", "--format=%ct"], {
      timeout: 3_000,
    })
    const ts = Number(stdout.trim())
    return Number.isFinite(ts) && ts > 0 ? ts : undefined
  } catch {
    return undefined
  }
}
