#!/usr/bin/env bun
// Bulba driver — кросс-сессионный оркестратор. Запускает headless
// opencode-сессии по фазам: plan -> implement -> review -> verify.
// Работает, пока юзер не за компом; state в .bulba/.
//
// Usage:
//   bun bulba-driver.mjs <project-dir> [--task "<задача>"] [--opencode <bin>] [--max-rounds N]
//
// Фазы:
//   plan      — план + вопросы в plan.md/questions.md (read-only сессия)
//   implement — выполняет план; повторяется с "CONTINUE", пока план не DONE
//   review    — враждебное ревью (субагенты), фиксы
//   verify    — тесты/typecheck/линт до зелёного (не "smoke")
//   report    — итог в .bulba/driver-report.md
//
// Примечание: вопросы из plan-фазы юзер отвечает в .bulba/questions.md —
// driver продолжает с задокументированными допущениями, если их нет.

import { execFileSync, spawn } from "node:child_process"
import { tmpdir } from "node:os"
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

// Harness adapters: same phase prompts, any headless CLI.
//   opencode: run with -c prompt, plus --agent for role-restricted phases
//   claude:   -p prompt, text output, no TUI
//   codex:    exec prompt
// Pick per phase with --cli opencode|claude|codex, default opencode.
// Role agents with --agents on: implement -> bulba-implementer, audit -> bulba-reviewer,
// which denies edit/write/apply_patch - structural read-only like LongHorizon-Harness.
const HARNESSES = {
  opencode: (bin, prompt, agent) => ({ cmd: bin, args: agent ? ["run", "-c", prompt, "--agent", agent] : ["run", "-c", prompt] }),
  claude: (bin, prompt) => ({ cmd: bin, args: ["-p", prompt, "--output-format", "text"] }),
  codex: (bin, prompt) => ({ cmd: bin, args: ["exec", prompt] }),
}

const args = process.argv.slice(2)
const project = args[0]
if (!project || args.includes("--help") || args.includes("-h")) {
  console.log('Usage: bun bulba-driver.mjs <project-dir> [--task "<task>"] [--opencode <bin>] [--cli opencode|claude|codex] [--max-rounds N] [--parallel N] [--sandbox systemd] [--mem MB] [--cpu %] [--session-timeout s]')
  process.exit(args.includes("--help") ? 0 : 1)
}
const task = argValue(args, "--task") ?? "continue the active plan"
const opencodeBin = argValue(args, "--opencode") ?? "opencode"
const harnessName = argValue(args, "--cli") ?? "opencode"
const harness = HARNESSES[harnessName] ?? HARNESSES.opencode
const useRoles = argValue(args, "--agents") !== "off"
const maxRounds = Number(argValue(args, "--max-rounds") ?? 10)
const parallel = Math.max(1, Number(argValue(args, "--parallel") ?? 1))
// Песочница: systemd (cgroups-лимиты) или bwrap (fs-изоляция + no-net). Linux-only.
let sandbox = argValue(args, "--sandbox") // systemd | bwrap | off
if (sandbox !== "systemd" && sandbox !== "bwrap") sandbox = "off"
if (sandbox !== "off" && process.platform !== "linux") {
  console.warn(`[bulba-driver] --sandbox ${sandbox} is Linux-only, running without sandbox`)
  sandbox = "off"
}
if (sandbox === "bwrap") {
  try {
    execFileSync("which", ["bwrap"], { stdio: "ignore" })
  } catch {
    console.warn("[bulba-driver] bwrap not found, falling back to no sandbox")
    sandbox = "off"
  }
}
const memMB = Number(argValue(args, "--mem") ?? 1024)
const cpuQuota = Number(argValue(args, "--cpu") ?? 50)
const sessionTimeout = Number(argValue(args, "--session-timeout") ?? 3600)

// bwrap: fs-isolation, repo writable, system read-only, tmpfs tmp, no network
function wrapBwrap(cwd, cmd, cmdArgs) {
  const binds = [
    "--die-with-parent",
    "--unshare-net",
    "--unshare-ipc",
    "--unshare-pid",
    "--ro-bind", "/usr", "/usr",
    "--ro-bind", "/etc", "/etc",
    "--ro-bind", "/opt", "/opt",
    "--bind", cwd, cwd,
    "--tmpfs", "/tmp",
    "--dev", "/dev",
    "--proc", "/proc",
  ]
  if (existsSync("/nix/store")) binds.push("--ro-bind", "/nix/store", "/nix/store")
  return { cmd: "bwrap", args: [...binds, "--", cmd, ...cmdArgs] }
}

// Убить дерево процессов: Windows - taskkill /T /F, Unix - группа процессов.
function killProcessTree(child) {
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" })
    } else {
      process.kill(-child.pid, "SIGKILL")
    }
  } catch {}
}

const dir = join(project, ".bulba")
const planFile = join(dir, "plan.md")
const questionsFile = join(dir, "questions.md")
const logFile = join(dir, "driver.log")
const reportFile = join(dir, "driver-report.md")
const stateFile = join(dir, "driver.json")
mkdirSync(dir, { recursive: true })
mkdirSync(join(dir, "sessions"), { recursive: true })

function saveState(phase, round) {
  try {
    writeFileSync(stateFile, JSON.stringify({ phase, round, task, updatedAt: Date.now() }))
  } catch {}
}
function loadState() {
  try {
    return JSON.parse(readFileSync(stateFile, "utf8"))
  } catch {
    return undefined
  }
}
function clearState() {
  try {
    rmSync(stateFile, { force: true })
  } catch {}
}

function log(line) {
  const entry = `[${new Date().toISOString()}] ${line}`
  console.log(entry)
  try {
    writeFileSync(logFile, `${existsSync(logFile) ? readFileSync(logFile, "utf8") : ""}${entry}\n`)
  } catch {}
}

function planDone() {
  const text = existsSync(planFile) ? readFileSync(planFile, "utf8") : ""
  return /STATUS:\s*DONE/i.test(text)
}

// Роли через env, а не --agent: opencode run --agent не принимает субагентов
// (откат на дефолт), поэтому драйвер помечает сессию через BULBA_ROLE -
// плагин в этой сессии переключает поведение: implementer может править,
// auditor - структурный read-only, manager (интерактив) - MEA-блок.
function runSession(prompt, role, cwd = project) {
  return new Promise((resolve) => {
    let { cmd, args: cmdArgs } = harness(opencodeBin, prompt, false)
    const env = { ...process.env }
    if (role) env.BULBA_ROLE = role
    else delete env.BULBA_ROLE
    // Песочница: systemd-run --scope c лимитами. Убьёт сессию при превышении памяти,
    // scope убирается сам (cgroups) - авто-очистка.
    if (sandbox === "systemd") {
      cmd = "systemd-run"
      cmdArgs = ["--scope", "--quiet", "-p", `MemoryMax=${memMB}M`, "-p", `CPUQuota=${cpuQuota}%`, "--", ...cmdArgs]
    } else if (sandbox === "bwrap") {
      ;({ cmd, args: cmdArgs } = wrapBwrap(cwd, cmd, cmdArgs))
    }
    log(`session (${harnessName}${sandbox === "systemd" ? `, sandbox mem=${memMB}M cpu=${cpuQuota}%` : ""}): ${cmd} ${cmdArgs[0]} "<${prompt.split("\n")[0].slice(0, 80)}...>"`)
    const child = spawn(cmd, cmdArgs, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true })
    let out = ""
    // Live-стрим для наблюдения + персистентный лог сессии.
    const slog = join(dir, "sessions", `${role ?? "phase"}-${new Date().toISOString().replace(/[:.]/g, "-")}.log`)
    const logChunk = (c) => {
      process.stdout.write(c) // видно в TTY: tail -f, watch
      out += c
      try {
        writeFileSync(slog, `${existsSync(slog) ? readFileSync(slog, "utf8") : ""}${c}`)
      } catch {}
    }
    child.stdout.on("data", logChunk)
    child.stderr.on("data", (c) => {
      process.stderr.write(c)
      out += c
      try {
        writeFileSync(slog, `${existsSync(slog) ? readFileSync(slog, "utf8") : ""}${c}`)
      } catch {}
    })
    const timer = setTimeout(() => {
      killProcessTree(child)
      out += "\n[Bulba driver] session TIMEOUT after " + sessionTimeout + "s - killed"
      log(`session timeout after ${sessionTimeout}s - killed`)
      resolve(out)
    }, sessionTimeout * 1000)
    child.on("close", (code) => {
      clearTimeout(timer)
      log(`session exit ${code}, output ${out.length} chars`)
      resolve(out)
    })
  })
}

// Парсинг задач плана с зависимостями: "- [ ] 3. ... (dep: 1, 2)".
function parseTasks(text) {
  const tasks = []
  for (const line of text.match(/-\s*\[ \][^\n]*/g) ?? []) {
    const m = line.match(/-\s*\[ \]\s*(\d+)\.\s*([^\n]*)/)
    if (!m) {
      tasks.push({ num: null, raw: line.trim(), deps: [] })
      continue
    }
    const depM = m[2].match(/\(dep:\s*([\d,\s]+)\)/i)
    tasks.push({
      num: Number(m[1]),
      raw: line.trim(),
      deps: depM ? depM[1].split(",").map((s) => Number(s.trim())) : [],
    })
  }
  return tasks
}

function tickedNums(text) {
  const nums = new Set()
  for (const l of text.match(/-\s*\[x\][^\n]*/g) ?? []) {
    const n = Number((l.match(/-\s*\[x\][^\n]*?(\d+)\./) ?? [])[1])
    if (Number.isFinite(n)) nums.add(n)
  }
  return nums
}

// plan write lock: sequential ticks, no lost updates
let planLock = Promise.resolve()
function tickTask(task) {
  planLock = planLock.then(() => {
    try {
      let plan = readFileSync(planFile, "utf8")
      if (plan.includes(task.raw)) plan = plan.replace(task.raw, task.raw.replace("- [ ]", "- [x] (audited)"))
      writeFileSync(planFile, plan)
    } catch {}
  })
  return planLock
}

// Воркер-пул: каждая задача в СВОЁМ worktree, воркеры берут следующую готовую
// задачу (зависимости выполнены) как только освободились. Пока один аудитит,
// другой имплементит - код не пересекается. Зависимости планируют порядок:
// конфликт на мерже не возвращается, а не начинается.
async function parallelPool(round) {
  const text = existsSync(planFile) ? readFileSync(planFile, "utf8") : ""
  const all = parseTasks(text)
  if (!all.length) return
  const results = await Promise.all(
    Array.from({ length: Math.min(parallel, all.length) }, async (_, w) => {
      const done = []
      while (true) {
        const planText = readFileSync(planFile, "utf8")
        const doneNums = tickedNums(planText)
        const task = all.find(
          (t) => !doneNums.has(t.num) && t.deps.every((d) => doneNums.has(d)) && !done.includes(t.raw),
        )
        if (!task) break
        const idx = all.indexOf(task)
        const wt = join(tmpdir(), `bulba-wt-${process.pid}-${w}-${idx}`)
        const branch = `bulba-wt-${w}-${idx}`
        try {
          execFileSync("git", ["-C", project, "worktree", "add", "-b", branch, wt], { stdio: "ignore" })
          mkdirSync(join(wt, ".bulba"), { recursive: true })
          writeFileSync(join(wt, ".bulba", "plan.md"), planText)
          if (existsSync(questionsFile)) writeFileSync(join(wt, ".bulba", "questions.md"), readFileSync(questionsFile, "utf8"))
          const prompt = `IMPLEMENT PHASE (driver, pool round ${round}, worker ${w}): YOUR TASK ONLY:\n${task.raw}\n${PHASES.implement(round).split("\n").slice(1).join("\n")}`
          const before = workspaceFingerprintOf(wt)
          await runSession(prompt, "implementer", wt)
          const mutated = workspaceFingerprintOf(wt) !== before
          const audit = await runSession(PHASES.audit(round), "auditor", wt)
          const verdict = mutated ? "MUTATED" : parseAuditVerdict(audit)
          log(`worker ${w} task #${idx + 1} verdict: ${verdict}`)
          if (verdict !== "VERIFIED") {
            execFileSync("git", ["-C", project, "worktree", "remove", "--force", wt], { stdio: "ignore" })
            execFileSync("git", ["-C", project, "branch", "-D", branch], { stdio: "ignore" })
            continue
          }
          execFileSync("git", ["-C", project, "merge", "--ff-only", branch], { stdio: "ignore" })
          execFileSync("git", ["-C", project, "worktree", "remove", "--force", wt], { stdio: "ignore" })
          execFileSync("git", ["-C", project, "branch", "-D", branch], { stdio: "ignore" })
          await tickTask(task) // сразу - зависимости других задач видят тик
          done.push(task.raw)
        } catch (e) {
          log(`worker ${w} task #${idx + 1} failed: ${e.message}`)
          try {
            execFileSync("git", ["-C", project, "worktree", "remove", "--force", wt], { stdio: "ignore" })
            execFileSync("git", ["-C", project, "branch", "-D", branch], { stdio: "ignore" })
          } catch {}
        }
      }
      return done
    }),
  )
  log(`pool round done: ${results.flat().length}/${all.length} tasks merged`)
}

// версия fingerprint для ворктритов
function workspaceFingerprintOf(wt) {
  const git = (() => {
    try {
      return execFileSync("git", ["-C", wt, "status", "--porcelain"], { timeout: 3000 }).toString()
    } catch {
      return ""
    }
  })()
  if (git) return `git:${git}`
  let out = ""
  const walk = (d) => {
    let entries = []
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name === ".bulba" || e.name === ".git") continue
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else {
        try {
          const s = statSync(p)
          out += `${p}:${s.size}:${s.mtimeMs};`
        } catch {}
      }
    }
  }
  walk(wt)
  return out
}

const PHASES = {
  plan: (round) => `PLAN PHASE (driver, round ${round}): task: ${task}
Read-only: no code edits. Write ${planFile} with tasks + Critical Files + Risks (template in the Bulba plugin). Write clarifying questions to ${questionsFile} (max 5). Don't ask in chat - headless. If you must assume, document the assumption in plan.md.`,
  implement: (round) => `IMPLEMENT PHASE (driver, round ${round}): execute ${planFile} (Bulba /develop rules: subagents for long tasks, test per task, commit per task, adversarial review via 2 subagents, record ## Review in plan.md). Questions answered in ${questionsFile} - read it. When everything is green: STATUS: DONE in plan.md. If blocked: write BLOCKED + reason in plan.md.${round > 1 ? ` Previous rounds didn't finish - CONTINUE, don't restart, don't argue.` : ""}`,
  audit: (round) => `AUDIT PHASE (driver, round ${round}): you are the read-only AUDITOR (MEA loop). Verify the work from the ENVIRONMENT, not from claims.
1. Read ${planFile} - the task list and the Acceptance criteria.
2. For the first unchecked task: verify it actually works - run its tests, check the behavior end-to-end if possible. Backcheck the Acceptance criteria from the plan.
3. End with EXACTLY these three lines (nothing after them):
Status: complete|incomplete|blocked
Integrity: clean|suspect
Contract: aligned|unknown
You are read-only: no edits, no commits, no fixes. The driver ticks the task only on complete+clean+aligned. The workspace is snapshotted before and after you - any mutation invalidates your verdict.`,
  review: () => `REVIEW PHASE (driver): adversarial review of the diff since the plan started (see /develop P6). 2 subagents, only diff, assume wrong. Fix findings as own commits. Record findings in plan.md ## Review.`,
  verify: (round) => `VERIFY PHASE (driver, round ${round}): run the FULL test suite + typecheck + lint (not "smoke"), fix code until green. E2E check if possible: dev-server + curl for API, CLI verifier for CLI, existing e2e suite for UI. Report counts. Only then STATUS: DONE if not already.`,
}

// Менеджер обновляет состояние только по вердикту аудитора (MEA: verified facts only).
// Вердикт аудитора: структурный (как у LongHorizon-Harness) + fallback VERIFIED/FAILED.
// VERIFIED = Status: complete + Integrity: clean + Contract: aligned.
function parseAuditVerdict(audit) {
  const status = audit.match(/^Status:\s*(\w+)/im)?.[1]?.toLowerCase()
  const integrity = audit.match(/^Integrity:\s*(\w+)/im)?.[1]?.toLowerCase()
  const contract = audit.match(/^Contract:\s*(\w+)/im)?.[1]?.toLowerCase()
  if (status || integrity || contract) {
    if (status === "complete" && integrity === "clean" && contract === "aligned") return "VERIFIED"
    return "FAILED"
  }
  if (/VERIFIED/i.test(audit)) return "VERIFIED"
  if (/FAILED/i.test(audit)) return "FAILED"
  return "UNKNOWN"
}

// Snapshot-guard: fingerprint воркспейса до/после аудита. Мутация = fail-closed.
// git-статус если репо, иначе mtime+size всех файлов (кроме .bulba - состояние менеджера).
function workspaceFingerprint() {
  const git = (() => {
    try {
      return execFileSync("git", ["-C", project, "status", "--porcelain"], { timeout: 3000 }).toString()
    } catch {
      return ""
    }
  })()
  if (git) return `git:${git}`
  let out = ""
  const walk = (d) => {
    let entries = []
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name === ".bulba" || e.name === ".git") continue
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else {
        try {
          const s = statSync(p)
          out += `${p}:${s.size}:${s.mtimeMs};`
        } catch {}
      }
    }
  }
  walk(project)
  return out
}

function tickFirstTask() {
  const text = existsSync(planFile) ? readFileSync(planFile, "utf8") : ""
  if (!/- \[ \]/.test(text)) return
  writeFileSync(planFile, text.replace(/- \[ \]/, "- [x] (audited)"))
  log("manager ticked the first unchecked task (auditor VERIFIED)")
}

// Менеджер сам валидирует итоговое состояние (детерминированно, как enforcer в плагине):
// features.json все passes, Review >= 2 находок, verify.md новее последнего коммита.
function stateProblems() {
  const problems = []
  const plan = existsSync(planFile) ? readFileSync(planFile, "utf8") : ""
  if (!plan) return ["no plan.md"]
  const review = plan.match(/##\s*Review\n([\s\S]*?)(?=\n##\s|\nSTATUS|$)/i)
  const findings = review ? (review[1].match(/^\s*[-*]\s+[^\n]+$/gm) ?? []).filter((l) => l.trim().length > 8) : []
  if (findings.length < 2) problems.push("## Review needs >= 2 findings")
  const feats = join(dir, "features.json")
  if (existsSync(feats)) {
    try {
      const f = JSON.parse(readFileSync(feats, "utf8"))
      const open = (Array.isArray(f) ? f : []).filter((x) => !x.passes).length
      if (open > 0) problems.push(`${open} feature(s) still "passes": false`)
    } catch {
      problems.push("features.json invalid")
    }
  }
  const v = join(dir, "verify.md")
  try {
    const vStat = statSync(v)
    let commitTs = 0
    try {
      commitTs = Number(execFileSync("git", ["-C", project, "log", "-1", "--format=%ct"], { timeout: 3000 }).toString().trim()) || 0
    } catch {}
    if (commitTs && vStat.mtimeMs / 1000 < commitTs - 5) problems.push("verify.md older than the last commit")
  } catch {
    problems.push("no verify.md")
  }
  return problems
}

async function main() {
  let phase = "implement"
  let round = 0
  // Резюм после краша: состояние на диске (driver.json), план уже есть - продолжаем.
  const prev = loadState()
  if (prev && existsSync(planFile)) {
    phase = prev.phase === "plan" ? "implement" : prev.phase
    round = Math.max(0, (prev.round ?? 1) - 1)
    log(`driver start: project=${project} task="${task}" maxRounds=${maxRounds} parallel=${parallel} (resume from ${phase} round ${round})`)
  } else {
    log(`driver start: project=${project} task="${task}" maxRounds=${maxRounds} parallel=${parallel}`)
    if (!existsSync(planFile)) await runSession(PHASES.plan(1))
  }

  while (true) {
    round++
    saveState(phase, round)
    if (phase === "implement") {
      if (round > maxRounds) {
        log("driver exhausted maxRounds")
        writeFileSync(reportFile, `# Driver report\nTask: ${task}\nStatus: NOT DONE after ${maxRounds} rounds\nSee plan.md and driver.log.`)
        clearState()
        return
      }
      if (parallel > 1 && /- \[ \]/.test(existsSync(planFile) ? readFileSync(planFile, "utf8") : "")) {
        await parallelPool(round)
      } else {
        await runSession(PHASES.implement(round), "implementer")
      }
      // MEA: read-only аудитор верифицирует состояние из окружения.
      const beforeAudit = workspaceFingerprint()
      const audit = await runSession(PHASES.audit(round), "auditor")
      const mutated = workspaceFingerprint() !== beforeAudit
      const verdict = mutated ? "MUTATED" : parseAuditVerdict(audit)
      log(`audit verdict: ${verdict}${mutated ? " (workspace mutated by auditor - fail-closed)" : ""}`)
      if (verdict === "VERIFIED") tickFirstTask()
      const text = existsSync(planFile) ? readFileSync(planFile, "utf8") : ""
      if (/BLOCKED/i.test(text)) {
        log("plan BLOCKED - stopping, waiting for user")
        writeFileSync(reportFile, `# Driver report\nBLOCKED: ${text.match(/BLOCKED[^\n]*/)?.[0] ?? ""}\nSee plan.md.`)
        return
      }
      if (planDone()) {
        phase = "review"
        continue
      }
      continue // не готово — ещё раунд implement
    }
    if (phase === "review") {
      await runSession(PHASES.review())
      phase = "verify"
      continue
    }
    if (phase === "verify") {
      const out = await runSession(PHASES.verify(round))
      // Менеджер валидирует итог сам (MEA): план DONE + состояние чистое.
      const problems = stateProblems()
      if (planDone() && problems.length === 0) {
        writeFileSync(reportFile, `# Driver report\nTask: ${task}\nStatus: DONE\n\nLast verify output (tail):\n${out.slice(-3000)}`)
        clearState()
        log("driver done: DONE (state validated by the manager)")
        return
      }
      if (problems.length) log(`state problems: ${problems.join("; ")}`)
      if (round >= maxRounds) {
        writeFileSync(reportFile, `# Driver report\nTask: ${task}\nStatus: ${planDone() ? "DONE but state invalid" : "NOT DONE after " + maxRounds + " rounds"}\nProblems: ${problems.join("; ") || "none"}\nSee plan.md and driver.log.`)
        log(`driver done: ${planDone() ? "DONE but state invalid" : "NOT DONE"}`)
        return
      }
      phase = "implement" // verify нашёл проблемы — ещё раунд
    }
  }
}

function argValue(argv, name) {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined
}

main().catch((e) => {
  log(`driver error: ${e.stack ?? e}`)
  process.exit(1)
})
