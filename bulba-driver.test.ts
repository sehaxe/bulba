import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, beforeEach, expect, test } from "bun:test"

let project = ""
let calls: string[] = []
let fakeBin = ""

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "driver-"))
  calls = []
  fakeBin = join(project, "fake-opencode")
  writeFileSync(
    fakeBin,
    `#!/bin/bash
echo "ROLE=\${BULBA_ROLE:-none} $*" >> "${project}-calls.txt"
if [[ "$*" == *"IMPLEMENT PHASE"* ]]; then
  mkdir -p "${project}/.bulba"
  printf '# Plan: test task\\nSTATUS: DONE\\n## Tasks\\n- [ ] 1. task one\\n## Review\\n- r1: a.rs:1 x\\n- r2: b.rs:2 y\\n' > "${project}/.bulba/plan.md"
fi
if [[ "$*" == *"AUDIT PHASE"* ]]; then
  echo "Status: complete"
  echo "Integrity: clean"
  echo "Contract: aligned"
fi
if [[ "$*" == *"VERIFY PHASE"* ]]; then
  touch "${project}/.bulba/verify.md"
fi
exit 0`,
  )
  writeFileSync(fakeBin, `#!/bin/bash\necho "ROLE=\${BULBA_ROLE:-none} $*" >> "${project}-calls.txt"\nif [[ "$*" == *"IMPLEMENT PHASE"* ]]; then\n  mkdir -p "${project}/.bulba"\n  printf '# Plan: test task\\nSTATUS: DONE\\n## Tasks\\n- [ ] 1. task one\\n## Review\\n- r1: a.rs:1 x\\n- r2: b.rs:2 y\\n' > "${project}/.bulba/plan.md"\nfi\nif [[ "$*" == *"AUDIT PHASE"* ]]; then\n  echo "Status: complete"\n  echo "Integrity: clean"\n  echo "Contract: aligned"\nfi\nif [[ "$*" == *"VERIFY PHASE"* ]]; then\n  touch "${project}/.bulba/verify.md"\nfi\nexit 0\n`)
})
afterEach(() => rmSync(project, { recursive: true, force: true }))

test("driver runs plan -> implement -> audit -> review -> verify -> report", async () => {
  const { execFileSync } = await import("node:child_process")
  execFileSync("chmod", ["+x", fakeBin])
  execFileSync("bun", [join(import.meta.dir, "bulba-driver.mjs"), project, "--task", "test task", "--opencode", fakeBin, "--max-rounds", "3"])

  const callsText = readFileSync(join(project + "-calls.txt"), "utf8")
  expect(callsText).toContain("PLAN PHASE")
  expect(callsText).toContain("IMPLEMENT PHASE")
  expect(callsText).toContain("AUDIT PHASE")
  expect(callsText).toContain("REVIEW PHASE")
  expect(callsText).toContain("VERIFY PHASE")
  // роли через env: аудитор read-only, имплементер - экзекутор
  expect(callsText).toContain("ROLE=implementer")
  expect(callsText).toContain("ROLE=auditor")
  // менеджер тикнул задачу по вердикту аудитора
  const plan = readFileSync(join(project, ".bulba", "plan.md"), "utf8")
  expect(plan).toContain("- [x] (audited)")
  // менеджер валидировал состояние сам: DONE
  expect(readFileSync(join(project, ".bulba", "driver-report.md"), "utf8")).toContain("Status: DONE")
})

test("driver reports state invalid when verify.md is missing", async () => {
  writeFileSync(
    fakeBin,
    `#!/bin/bash
echo "$*" >> "${project}-calls.txt"
if [[ "$*" == *"IMPLEMENT PHASE"* ]]; then
  mkdir -p "${project}/.bulba"
  printf '# Plan: t\\nSTATUS: DONE\\n## Tasks\\n- [ ] 1.\\n## Review\\n- r1: a.rs:1 x\\n- r2: b.rs:2 y\\n' > "${project}/.bulba/plan.md"
fi
if [[ "$*" == *"AUDIT PHASE"* ]]; then
  echo "Status: complete"
  echo "Integrity: clean"
  echo "Contract: aligned"
fi
exit 0`,
  )
  const { execFileSync } = await import("node:child_process")
  execFileSync("chmod", ["+x", fakeBin])
  execFileSync("bun", [join(import.meta.dir, "bulba-driver.mjs"), project, "--task", "t", "--opencode", fakeBin, "--max-rounds", "2"])
  const report = readFileSync(join(project, ".bulba", "driver-report.md"), "utf8")
  expect(report).toContain("DONE but state invalid")
  expect(report).toContain("no verify.md")
})

test("no tick when the auditor is not clean or mutates the workspace", async () => {
  writeFileSync(
    fakeBin,
    `#!/bin/bash
echo "$*" >> "${project}-calls.txt"
if [[ "$*" == *"IMPLEMENT PHASE"* ]]; then
  mkdir -p "${project}/.bulba"
  printf '# Plan: t\\nSTATUS: IN_PROGRESS\\n## Tasks\\n- [ ] 1.\\n## Review\\n- r1: a.rs:1 x\\n- r2: b.rs:2 y\\n' > "${project}/.bulba/plan.md"
fi
if [[ "$*" == *"AUDIT PHASE"* ]]; then
  echo "Status: incomplete"
  echo "Integrity: suspect"
  echo "Contract: unknown"
fi
exit 0`,
  )
  const { execFileSync } = await import("node:child_process")
  execFileSync("chmod", ["+x", fakeBin])
  execFileSync("bun", [join(import.meta.dir, "bulba-driver.mjs"), project, "--task", "t", "--opencode", fakeBin, "--max-rounds", "1"])
  const plan = readFileSync(join(project, ".bulba", "plan.md"), "utf8")
  expect(plan).toContain("- [ ] 1.") // не тикнуто
  expect(plan).not.toContain("(audited)")
})

test("driver resumes from saved state after a crash", async () => {
  const { execFileSync } = await import("node:child_process")
  // Свой фейк БЕЗ verify.md: первый прогон закончится "state invalid", state останется.
  writeFileSync(
    fakeBin,
    `#!/bin/bash
echo "$*" >> "${project}-calls.txt"
if [[ "$*" == *"IMPLEMENT PHASE"* ]]; then
  mkdir -p "${project}/.bulba"
  printf '# Plan: t\\nSTATUS: DONE\\n## Tasks\\n- [ ] 1.\\n## Review\\n- r1: a.rs:1 x\\n- r2: b.rs:2 y\\n' > "${project}/.bulba/plan.md"
fi
if [[ "$*" == *"AUDIT PHASE"* ]]; then
  echo "Status: complete"
  echo "Integrity: clean"
  echo "Contract: aligned"
fi
exit 0`,
  )
  execFileSync("chmod", ["+x", fakeBin])
  execFileSync("bun", [join(import.meta.dir, "bulba-driver.mjs"), project, "--task", "t", "--opencode", fakeBin, "--max-rounds", "1"])
  expect(readFileSync(join(project, ".bulba", "driver.json"), "utf8")).toContain('"phase"')

  // Второй запуск: резюм - не пересоздаёт план
  const callsBefore = (readFileSync(join(project + "-calls.txt"), "utf8").match(/PLAN PHASE/g) ?? []).length
  execFileSync("bun", [join(import.meta.dir, "bulba-driver.mjs"), project, "--task", "t", "--opencode", fakeBin, "--max-rounds", "3"])
  const callsAfter = (readFileSync(join(project + "-calls.txt"), "utf8").match(/PLAN PHASE/g) ?? []).length
  expect(callsAfter).toBe(callsBefore) // план не пересоздавался
  expect(readFileSync(join(project, ".bulba", "driver.log"), "utf8")).toContain("resume from")
})

test("parallel implement merges verified worktrees", async () => {
  const { execFileSync } = await import("node:child_process")
  execFileSync("git", ["init", "-q", project])
  execFileSync("git", ["-C", project, "config", "user.email", "t@t"])
  execFileSync("git", ["-C", project, "config", "user.name", "t"])
  writeFileSync(join(project, "base.txt"), "base")
  execFileSync("git", ["-C", project, "add", "-A"])
  execFileSync("git", ["-C", project, "commit", "-qm", "init"])

  writeFileSync(
    fakeBin,
    `#!/bin/bash
echo "$*" >> "${project}-calls.txt"
if [[ "$*" == *"AUDIT PHASE"* ]]; then
  echo "Status: complete"
  echo "Integrity: clean"
  echo "Contract: aligned"
fi
exit 0`,
  )
  execFileSync("chmod", ["+x", fakeBin])
  mkdirSync(join(project, ".bulba"))
  writeFileSync(
    join(project, ".bulba", "plan.md"),
    "# Plan: p\nSTATUS: IN_PROGRESS\n## Tasks\n- [ ] 1. task a\n- [ ] 2. task b\n## Review\n- r1: a.rs:1 x\n- r2: b.rs:2 y\n",
  )
  execFileSync("bun", [join(import.meta.dir, "bulba-driver.mjs"), project, "--task", "t", "--opencode", fakeBin, "--max-rounds", "1", "--parallel", "2"])
  const plan = readFileSync(join(project, ".bulba", "plan.md"), "utf8")
  expect((plan.match(/- \[x\] \(audited\)/g) ?? []).length).toBe(2)
  expect(readFileSync(join(project, ".bulba", "driver.log"), "utf8")).toContain("tasks merged")
})

test("mutating auditor gets fail-closed (no tick)", async () => {
  writeFileSync(
    fakeBin,
    `#!/bin/bash
echo "$*" >> "${project}-calls.txt"
if [[ "$*" == *"IMPLEMENT PHASE"* ]]; then
  mkdir -p "${project}/.bulba"
  printf '# Plan: t\\nSTATUS: IN_PROGRESS\\n## Tasks\\n- [ ] 1.\\n## Review\\n- r1: a.rs:1 x\\n- r2: b.rs:2 y\\n' > "${project}/.bulba/plan.md"
  printf 'x' > "${project}/a.txt"
fi
if [[ "$*" == *"AUDIT PHASE"* ]]; then
  echo "Status: complete"
  echo "Integrity: clean"
  echo "Contract: aligned"
  printf 'mutated' >> "${project}/a.txt"
fi
exit 0`,
  )
  const { execFileSync } = await import("node:child_process")
  execFileSync("chmod", ["+x", fakeBin])
  execFileSync("bun", [join(import.meta.dir, "bulba-driver.mjs"), project, "--task", "t", "--opencode", fakeBin, "--max-rounds", "1"])
  const log = readFileSync(join(project, ".bulba", "driver.log"), "utf8")
  expect(log).toContain("MUTATED")
  expect(readFileSync(join(project, ".bulba", "plan.md"), "utf8")).not.toContain("(audited)")
})

test("hung session is killed by the timeout", async () => {
  writeFileSync(
    fakeBin,
    `#!/bin/bash
echo "$*" >> "${project}-calls.txt"
if [[ "$*" == *"IMPLEMENT PHASE"* ]]; then
  sleep 30
fi
exit 0`,
  )
  const { execFileSync } = await import("node:child_process")
  execFileSync("chmod", ["+x", fakeBin])
  execFileSync("bun", [join(import.meta.dir, "bulba-driver.mjs"), project, "--task", "t", "--opencode", fakeBin, "--max-rounds", "1", "--session-timeout", "1"])
  const log = readFileSync(join(project, ".bulba", "driver.log"), "utf8")
  expect(log).toContain("session timeout after 1s - killed")
  expect(log).toContain("killed")
})

test("sandbox mode wraps sessions with systemd-run", async () => {
  let hasSystemdRun = false
  try {
    execFileSync("which", ["systemd-run"], { stdio: "ignore" })
    hasSystemdRun = true
  } catch {}
  if (!hasSystemdRun) return // нет systemd-run - пропускаем
  const { execFileSync } = await import("node:child_process")
  execFileSync("chmod", ["+x", fakeBin])
  execFileSync("bun", [join(import.meta.dir, "bulba-driver.mjs"), project, "--task", "t", "--opencode", fakeBin, "--max-rounds", "1", "--sandbox", "systemd", "--mem", "64", "--cpu", "25"])
  const log = readFileSync(join(project, ".bulba", "driver.log"), "utf8")
  expect(log).toContain("sandbox mem=64M cpu=25%")
})

test("driver stops on BLOCKED plan", async () => {
  writeFileSync(
    fakeBin,
    `#!/bin/bash
echo "$*" >> "${project}-calls.txt"
if [[ "$*" == *"PLAN PHASE"* ]]; then
  mkdir -p "${project}/.bulba"
  printf '# Plan: blocked\\nSTATUS: DONE\\nBLOCKED: need credentials\\n' > "${project}/.bulba/plan.md"
fi
exit 0`,
  )
  const { execFileSync } = await import("node:child_process")
  execFileSync("chmod", ["+x", fakeBin])
  execFileSync("bun", [join(import.meta.dir, "bulba-driver.mjs"), project, "--task", "t", "--opencode", fakeBin])

  const report = readFileSync(join(project, ".bulba", "driver-report.md"), "utf8")
  expect(report).toContain("BLOCKED")
  expect(report).toContain("need credentials")
})

test("pool respects task dependencies (task 2 waits for task 1)", async () => {
  const { execFileSync } = await import("node:child_process")
  execFileSync("git", ["init", "-q", project])
  execFileSync("git", ["-C", project, "config", "user.email", "t@t"])
  execFileSync("git", ["-C", project, "config", "user.name", "t"])
  writeFileSync(join(project, "base.txt"), "base")
  execFileSync("git", ["-C", project, "add", "-A"])
  execFileSync("git", ["-C", project, "commit", "-qm", "init"])
  writeFileSync(
    fakeBin,
    `#!/bin/bash
if [[ "$*" == *"AUDIT PHASE"* ]]; then
  echo "Status: complete"
  echo "Integrity: clean"
  echo "Contract: aligned"
fi
exit 0`,
  )
  execFileSync("chmod", ["+x", fakeBin])
  mkdirSync(join(project, ".bulba"))
  writeFileSync(
    join(project, ".bulba", "plan.md"),
    "# Plan: p\nSTATUS: IN_PROGRESS\n## Tasks\n- [ ] 1. core\n- [ ] 2. feature (dep: 1)\n- [ ] 3. docs\n## Review\n- r1: a.rs:1 x\n- r2: b.rs:2 y\n",
  )
  execFileSync("bun", [join(import.meta.dir, "bulba-driver.mjs"), project, "--task", "t", "--opencode", fakeBin, "--max-rounds", "1", "--parallel", "2"])
  const plan = readFileSync(join(project, ".bulba", "plan.md"), "utf8")
  expect((plan.match(/- \[x\] \(audited\)/g) ?? []).length).toBe(3)
  // задача 2 стартовала только после тика задачи 1
  const log = readFileSync(join(project, ".bulba", "driver.log"), "utf8")
  const t1 = log.indexOf("task #1 verdict: VERIFIED")
  const t2 = log.indexOf("task #2 verdict: VERIFIED")
  expect(t1).toBeGreaterThan(-1)
  expect(t2).toBeGreaterThan(t1)
})
