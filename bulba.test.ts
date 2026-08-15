import { execFileSync } from "node:child_process"
import { createServer } from "node:http"
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test"

import { BulbaPlugin } from "./bulba.mjs"
import { beforeAll } from "bun:test"

let dir = ""
let prompts: { sessionID: string; prompt: string }[] = []
let todoStub: unknown[] | undefined = undefined
let permissionReplies: { id: string; reply: string }[] = []
let sessionGetStub: { parentID?: string | null; agent?: string } = { parentID: null }
let searxngPort = 0
let searxngServer: ReturnType<typeof createServer>

beforeAll(async () => {
  searxngPort = await new Promise<number>((resolve) => {
    const s = createServer()
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })
  searxngServer = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(
      JSON.stringify({
        results: [
          { title: "OpenCode Plugins", url: "https://opencode.ai/docs/plugins/", content: "Plugin API docs." },
          { title: "Second Result", url: "https://example.com/2", content: "Some snippet with more words." },
        ],
      }),
    )
  })
  searxngServer.listen(searxngPort, "127.0.0.1")
})

afterAll(() => searxngServer?.close())

function plugin(overrides: Record<string, unknown> = {}) {
  const { directory: pluginDir, ...options } = overrides
  return BulbaPlugin(
    {
      client: {
        session: {
          prompt: async (value: { path: { sessionID: string }; body: { prompt: string } }) => {
            prompts.push({ sessionID: value.path.sessionID, prompt: value.body.prompt })
          },
          todo: async () => ({ data: todoStub }),
          summarize: async () => ({ data: { ok: true } }),
          messages: async () => ({ data: [] }),
          get: async () => ({ data: sessionGetStub }),
          postSessionIdPermissionsPermissionId: async (value: {
            path: { permissionID: string }
            body: { reply: string }
          }) => {
            permissionReplies.push({ id: value.path.permissionID, reply: value.body.reply })
          },
        },
      },
      project: {} as never,
      directory: (pluginDir as string) ?? dir,
      worktree: (pluginDir as string) ?? dir,
      experimental_workspace: {} as never,
      serverUrl: new URL("http://127.0.0.1:1"),
      $: null as never,
    },
    { stateDir: dir, idleDelayMs: 0, ...options },
  )
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bulba-"))
  prompts = []
  todoStub = undefined
  permissionReplies = []
  sessionGetStub = { parentID: null }
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

test("config hook injects commands", async () => {
  const p = await plugin()
  const config: Record<string, unknown> = {}
  await p.config?.(config as never)
  expect(Object.keys(config.command ?? {})).toEqual([
    "away", "docs", "graph", "develop", "plan", "publish", "goal", "verify", "audit", "study", "research", "skill", "test_ui", "design", "orchestrate", "simplify", "security_review", "ci", "overhaul", "go", "critique", "retro", "danger", "status", "usage",
  ])
  expect((config.command as any).develop.template).toContain("MEA LOOP")
  expect((config.command as any).develop.template).toContain("bulba-implementer")
  expect((config.command as any).develop.template).toContain("verified facts")
  expect((config.command as any).develop.template).toContain("P7 VERIFY GATE")
  expect((config.command as any).develop.template).toContain("Status: complete|incomplete|blocked")
  expect((config.command as any).develop.template).toContain('task tool, "explore"')
  expect((config.command as any).develop.template).toContain("explore.md")
  expect((config.command as any).develop.template).toContain("## Review")
  expect((config.command as any).publish.template).toContain("## Summary")
  expect((config.command as any).plan.template).toContain("Critical Files")
  expect((config.command as any).away.template).toContain("MODE: AWAY")
  expect((config.command as any).docs.template).toContain("INDEX.md")
  expect((config.command as any).docs.template).toContain("CODEBASE.md")
  expect((config.command as any).graph.template).toContain("graphify query")
  expect((config.command as any).verify.template).toContain("don't count")
    expect((config.command as any).usage.template).toContain("compaction")
  expect((config.command as any).research.template).toContain("search_web")
  expect((config.command as any).study.template).toContain("git clone --depth 1")
  expect((config.command as any).skill.template).toContain("webapp-testing")
  expect((config.command as any).test_ui.template).toContain("Playwright")
  expect((config.command as any).design.template).toContain("design-md")
  expect((config.command as any).develop.template).toContain("## Review")
  expect((config.command as any).orchestrate.template).toContain("bulba-driver.mjs")
  expect((config.command as any).overhaul.template).toContain("behavior.json")
  expect((config.command as any).overhaul.template).toContain("ZERO functionality loss")
  expect((config.command as any).overhaul.template).toContain("P2 ARCHITECTURE")
  expect((config.command as any).overhaul.template).toContain("2 bulba-reviewer")
  expect((config.command as any).ci.template).toContain("gh run list")
  expect((config.command as any).critique.template).toContain("not a yes-man")
  expect((config.command as any).retro.template).toContain("lessons.md")
  expect((config.command as any).danger.template).toContain("SUDO_ASKPASS")
  expect((config.command as any).develop.template).toContain("CI check")
  expect((config.command as any).simplify.template).toContain("Altitude")
  expect((config.command as any).security_review.template).toContain("exploitability")
  expect((config.command as any).research.template).toContain("deep-research")
})

test("config hook injects guard permission rules", async () => {
  const p = await plugin()
  const config: Record<string, unknown> = { permission: { shell: { "*": "ask" } } }
  await p.config?.(config as never)
  const shell = (config.permission as any).shell
  expect(shell["git reset --hard*"]).toBe("deny")
  expect(shell["rm -rf*"]).toBe("deny")
  expect(shell["*"]).toBe("ask") // user rules preserved
})

test("config hook injects bulba agents and nested depth", async () => {
  const p = await plugin()
  const config: Record<string, unknown> = {}
  await p.config?.(config as never)
  expect((config as any).subagent_depth).toBe(2)
  expect((config as any).default_agent).toBeUndefined() // по умолчанию не захватываем дефолт
  const agents = (config as any).agent
  expect(Object.keys(agents).sort()).toEqual(
    ["bulba", "bulba-benchmarker", "bulba-critic", "bulba-debugger", "bulba-implementer", "bulba-optimizer", "bulba-paper-explainer", "bulba-planner", "bulba-researcher", "bulba-reviewer", "bulba-security", "bulba-skillfinder", "bulba-verifier", "bulba-webdev"].sort(),
  )
  expect(agents.bulba.mode).toBe("primary")
  expect(agents.bulba.color).toBe("#FF8C00")
  expect(agents.bulba.prompt).toContain("DEVELOP protocol")
  expect(agents.bulba.prompt).toContain("MODE: AWAY")
  expect(agents.bulba.prompt).toContain("ONE feature at a time")
  expect(agents["bulba-planner"].mode).toBe("subagent")
  expect(agents["bulba-planner"].permission).toMatchObject({ edit: "deny" })
  expect(agents["bulba-reviewer"].prompt).toContain("Status: complete|incomplete|blocked")
  expect(agents["bulba-researcher"].prompt).toContain("AT LEAST 5 candidates")
  expect(agents["bulba-researcher"].prompt).toContain("arxiv.org")
  expect(agents["bulba-researcher"].prompt).toContain("PubMed")
  expect(agents["bulba-researcher"].prompt).toContain("discuss with your doctor")
  expect(agents["bulba-researcher"].prompt).toContain("VERIFIED (sourced)")
  expect(agents["bulba-researcher"].prompt).toContain("SPECULATION")
  expect(agents["bulba-critic"].prompt).toContain("falsify")
  expect(agents["bulba-optimizer"].prompt).toContain("never crash the machine")
  expect(agents["bulba-optimizer"].prompt).toContain("nice/ionice")
  expect(agents["bulba-skillfinder"].prompt).toContain("NON-NEGOTIABLE")
  expect(agents["bulba-skillfinder"].prompt).toContain("NON-NEGOTIABLE")
  expect(agents["bulba-skillfinder"].prompt).toContain("curl|bash")
  expect(agents["bulba-skillfinder"].prompt).toContain("question tool")
  expect(agents["bulba-security"].prompt).toContain("ACTUAL exploitability")
  expect(agents["bulba-security"].prompt).toContain("ss -tlnp")
  expect(agents["bulba-security"].prompt).toContain("suspected")
  expect(agents["bulba-verifier"].prompt).toContain("FULL tests")
})

test("tool.execute.after injects nearby AGENTS.md rules once per session", async () => {
  mkdirSync(join(dir, "src"))
  writeFileSync(join(dir, "AGENTS.md"), "# Rules\n- always test\n")
  writeFileSync(join(dir, "src", "a.rs"), "fn main() {}")
  const p = await plugin()
  const output1: { output: string } = { output: "file content" }
  await (p as any)["tool.execute.after"](
    { tool: "read", sessionID: "s1", args: { filePath: join(dir, "src", "a.rs") } },
    output1,
  )
  expect(output1.output).toContain("[Rules:")
  expect(output1.output).toContain("always test")

  const output2: { output: string } = { output: "again" }
  await (p as any)["tool.execute.after"](
    { tool: "read", sessionID: "s1", args: { filePath: join(dir, "src", "a.rs") } },
    output2,
  )
  expect(output2.output).toBe("again") // повторно не дописываем
})

test("no-slop flags slop comments on edit, ignores clean code", async () => {
  const p = await plugin()
  const out1: { output: string } = { output: "ok" }
  await (p as any)["tool.execute.after"](
    { tool: "edit", sessionID: "s1", args: { filePath: "a.rs", newString: "// increment the counter — important!\ni += 1;\n" } },
    out1,
  )
  expect(out1.output).toContain("[No-slop]")
  expect(out1.output).toContain("em/long dash")

  const out2: { output: string } = { output: "ok" }
  await (p as any)["tool.execute.after"](
    { tool: "edit", sessionID: "s1", args: { filePath: "a.rs", newString: "// count entries\ncount_entries();\n" } },
    out2,
  )
  expect(out2.output).toContain("comment repeats the code")

  const out3: { output: string } = { output: "ok" }
  await (p as any)["tool.execute.after"](
    { tool: "write", sessionID: "s1", args: { filePath: "b.rs", content: "// TODO: add tests\nfn main() {}\n// explain why: the borrow rules\nlet x = &mut v;\n" } },
    out3,
  )
  expect(out3.output).toBe("ok") // TODO и осмысленные комментарии не флагаются
})

test("synthetic idle from session.status triggers the enforcer", async () => {
  writeFileSync(join(dir, "goal.md"), "# Goal: fix login\n")
  const p = await plugin()
  await (p as any).event?.({
    event: { id: "1", type: "session.status", properties: { sessionID: "s1", status: { type: "idle" } } },
  })
  expect(prompts).toHaveLength(1)
  expect(prompts[0].prompt).toContain("[Bulba Enforcer")
})

test("no nagging right after compaction (only the KB update)", async () => {
  writeFileSync(join(dir, "goal.md"), "# Goal: fix login\n")
  const p = await plugin()
  await (p as any).event?.({ event: { id: "1", type: "session.compacted", properties: { sessionID: "s1" } } })
  await (p as any).event?.({ event: { id: "1", type: "session.idle", properties: { sessionID: "s1" } } })
  expect(prompts).toHaveLength(1) // KB-апдейт, но не enforcer-нудж
  expect(prompts[0].prompt).toContain("knowledge base")
})

test("config hook gitignores the state dir", async () => {
  const p = await plugin({ stateDir: join(dir, ".bulba") })
  await p.config?.({} as never)
  const gi = (await import("node:fs")).readFileSync(join(dir, ".gitignore"), "utf8")
  expect(gi).toContain(".bulba/")
})

test("search_web tool queries local SearXNG", async () => {
  const p = await plugin({ searxngUrl: `http://127.0.0.1:${searxngPort}` })
  const out = await (p as any).tool.search_web.execute({ query: "opencode plugins" }, {})
  expect(out).toContain("[OpenCode Plugins](https://opencode.ai/docs/plugins/)")
  expect(out).toContain("Second Result")
})

test("system.transform merges into the first system message (single-message for litellm/vLLM)", async () => {
  const p = await plugin()
  const output: { system: string[] } = { system: ["You are a helpful assistant."] }
  await (p as any)["experimental.chat.system.transform"]({}, output)
  expect(output.system).toHaveLength(1)
  expect(output.system[0]).toContain("You are a helpful assistant.")
  expect(output.system[0]).toContain('"Done" = you ran full tests')
})

test("search_web tool fails gracefully when SearXNG is down", async () => {
  const p = await plugin({ searxngUrl: "http://127.0.0.1:1" })
  const out = await (p as any).tool.search_web.execute({ query: "x" }, {})
  expect(out).toContain("SearXNG unavailable")
})

test("core doctrine is always injected, even without plan", async () => {
  const p = await plugin()
  const output: { system: string[] } = { system: [] }
  await (p as any)["experimental.chat.system.transform"]({}, output)
  const joined = output.system.join("\n")
  expect(joined).toContain('"Done" = you ran full tests')
  expect(joined).toContain("never skip/delete tests")
  expect(joined).toContain("Paragraph comment")
  expect(joined).toContain("No slop")
  expect(joined).toContain("todo tool")
  expect(joined).toContain("Reversible local actions")
  expect(joined).toContain("best-quality implementation")
})

test("system.transform injects memory, goal and rules", async () => {
  writeFileSync(join(dir, "memory.md"), "# Memory\n- gateway on 8080\n")
  writeFileSync(join(dir, "goal.md"), "# Goal: fix login\n")
  const p = await plugin()
  const output: { system: string[] } = { system: [] }
  await (p as any)["experimental.chat.system.transform"]({}, output)
  const joined = output.system.join("\n")
  expect(joined).toContain("gateway on 8080")
  expect(joined).toContain("fix login")
  expect(joined).toContain("STATUS: DONE")
  expect(joined).toContain("Minimal scope")
})

test("system.transform injects active plan and readiness doctrine", async () => {
  writeFileSync(join(dir, "plan.md"), "# Plan: rewrite client\nSTATUS: IN_PROGRESS\n## Tasks\n- [ ] 1.\n")
  const p = await plugin()
  const output: { system: string[] } = { system: [] }
  await (p as any)["experimental.chat.system.transform"]({}, output)
  const joined = output.system.join("\n")
  expect(joined).toContain("rewrite client")
  expect(joined).toContain("git log")
  expect(joined).toContain("no push without user OK")
  expect(joined).toContain("never self-review")
})

test("system.transform injects docs index for context economy", async () => {
  mkdirSync(join(dir, ".ai-docs"))
  writeFileSync(join(dir, ".ai-docs", "INDEX.md"), "# INDEX\n- architecture.md - modules\n")
  const p = await plugin()
  const output: { system: string[] } = { system: [] }
  await (p as any)["experimental.chat.system.transform"]({}, output)
  const joined = output.system.join("\n")
  expect(joined).toContain("INDEX.md")
  expect(joined).toContain("graphify query")
})

test("enforcer nags on idle until DONE, capped by maxRounds", async () => {
  writeFileSync(join(dir, "goal.md"), "# Goal: fix login\n")
  const p = await plugin({ maxRounds: 2 })
  const ev = (id: string) => ({ event: { id: "1", type: "session.idle", properties: { sessionID: id } } })

  await (p as any).event?.(ev("s1"))
  await (p as any).event?.(ev("s1"))
  expect(prompts).toHaveLength(2)
  expect(prompts[0].prompt).toContain("[Bulba Enforcer, round 1/2]")
  expect(prompts[0].prompt).toContain("fix login")
  expect(prompts[1].prompt).toContain("round 2/2")

  await (p as any).event?.(ev("s1"))
  expect(prompts).toHaveLength(2) // cap 2
})

test("enforcer nags without cap in AWAY mode", async () => {
  writeFileSync(join(dir, "goal.md"), "# Goal: optimize hotpath\nMODE: AWAY\n")
  const p = await plugin({ maxRounds: 2, awayMaxRounds: 4, stallRounds: 99, idleDelayMs: 0 })
  const ev = (id: string) => ({ event: { id: "1", type: "session.idle", properties: { sessionID: id } } })

  for (let i = 0; i < 4; i++) await (p as any).event?.(ev("s1"))
  expect(prompts).toHaveLength(4) // awayMaxRounds (не Infinity) вместо maxRounds
  expect(prompts[0].prompt).toContain("[Bulba AWAY, round 1]")
  expect(prompts[3].prompt).toContain("[Bulba AWAY, round 4]")

  await (p as any).event?.(ev("s1")) // кап awayMaxRounds
  expect(prompts).toHaveLength(4)
})

test("enforcer stops nagging when stalled (no progress)", async () => {
  writeFileSync(join(dir, "goal.md"), "# Goal: fix login\n")
  const p = await plugin({ stallRounds: 2, idleDelayMs: 0 })
  const ev = (id: string) => ({ event: { id: "1", type: "session.idle", properties: { sessionID: id } } })

  await (p as any).event?.(ev("s1")) // round 1, sig recorded
  await (p as any).event?.(ev("s1")) // stall 1
  expect(prompts).toHaveLength(2)
  await (p as any).event?.(ev("s1")) // stall 2 >= stallRounds -> stop
  expect(prompts).toHaveLength(3)
  expect(prompts[2].prompt).toContain("No progress across several rounds")

  await (p as any).event?.(ev("s1")) // больше не дёргаем
  expect(prompts).toHaveLength(3)
})

test("verify pokes when plan lacks Review section", async () => {
  writeFileSync(join(dir, "plan.md"), "# Plan: rewrite client\nSTATUS: IN_PROGRESS\n## Tasks\n- [x] 1.\n")
  const p = await plugin()
  const ev = (id: string) => ({ event: { id: "1", type: "session.idle", properties: { sessionID: id } } })

  await (p as any).event?.(ev("s1")) // nag
  writeFileSync(join(dir, "plan.md"), "# Plan: rewrite client\nSTATUS: DONE\n## Tasks\n- [x] 1.\n")
  await (p as any).event?.(ev("s1")) // done, but no Review section
  expect(prompts).toHaveLength(2)
  expect(prompts[1].prompt).toContain("[Bulba Verify]")
  expect(prompts[1].prompt).toContain("## Review")

  // 1 finding is not enough, needs 2
  writeFileSync(join(dir, "plan.md"), "# Plan: rewrite client\nSTATUS: DONE\n## Tasks\n- [x] 1.\n## Review\n- r1 fixed\n")
  await (p as any).event?.(ev("s1"))
  expect(prompts).toHaveLength(3)
  expect(prompts[2].prompt).toContain(">= 2 findings")

  // Ревью с 2 находками -> теперь не хватает verify.md
  writeFileSync(join(dir, "plan.md"), "# Plan: rewrite client\nSTATUS: DONE\n## Tasks\n- [x] 1.\n## Review\n- r1: src/a.rs:12 use-after-free\n- r2: src/b.rs:4 lost await\n")
  await (p as any).event?.(ev("s1"))
  expect(prompts).toHaveLength(4)
  expect(prompts[3].prompt).toContain("verify.md")

  // verify.md свежий и делегирование доказано - консолидация
  writeFileSync(join(dir, "verify.md"), "bun test: 12 pass, 0 fail\n")
  await (p as any)["tool.execute.after"](
    { tool: "task", sessionID: "s1", args: { subagent_type: "bulba-implementer" } },
    { output: "ok" },
  )
  await (p as any)["tool.execute.after"](
    { tool: "task", sessionID: "s1", args: { subagent_type: "bulba-reviewer" } },
    { output: "ok" },
  )
  await (p as any).event?.(ev("s1"))
  expect(prompts).toHaveLength(5)
  expect(prompts[4].prompt).toContain("Consolidate")
})

test("verify pokes when features.json has unfinished features", async () => {
  writeFileSync(join(dir, "plan.md"), "# Plan: app\nSTATUS: IN_PROGRESS\n## Tasks\n- [x] 1.\n")
  writeFileSync(
    join(dir, "features.json"),
    JSON.stringify([{ description: "login", passes: false }, { description: "logout", passes: true }]),
  )
  const p = await plugin()
  const ev = (id: string) => ({ event: { id: "1", type: "session.idle", properties: { sessionID: id } } })

  await (p as any).event?.(ev("s1")) // nag
  writeFileSync(join(dir, "plan.md"), "# Plan: app\nSTATUS: DONE\n## Tasks\n- [x] 1.\n## Review\n- r1: a.rs:1 x\n- r2: b.rs:2 y\n")
  await (p as any).event?.(ev("s1")) // done, but login not passes
  expect(prompts).toHaveLength(2)
  expect(prompts[1].prompt).toContain('"passes": false')

  // Все фичи passes -> дальше verify.md
  writeFileSync(join(dir, "features.json"), JSON.stringify([{ description: "login", passes: true }]))
  await (p as any).event?.(ev("s1"))
  expect(prompts).toHaveLength(3)
  expect(prompts[2].prompt).toContain("verify.md")
})

test("verify pokes when git tree is dirty", async () => {
  // stateDir как поддиректория git-репо: .bulba/ уходит в .gitignore,
  // a.txt остаётся трекаемым.
  const repo = join(dir, "repo")
  mkdirSync(repo)
  const p = await plugin({ stateDir: join(repo, ".autopilot"), directory: repo })
  await p.config?.({} as never) // пишет .gitignore с .bulba/

  execFileSync("git", ["init", "-q", repo])
  execFileSync("git", ["-C", repo, "config", "user.email", "t@t"])
  execFileSync("git", ["-C", repo, "config", "user.name", "t"])
  writeFileSync(join(repo, "a.txt"), "v1")
  execFileSync("git", ["-C", repo, "add", "-A"])
  execFileSync("git", ["-C", repo, "commit", "-qm", "init"])

  mkdirSync(join(repo, ".autopilot"))
  writeFileSync(join(repo, ".autopilot", "goal.md"), "# Goal: fix login\n")
  const ev = (id: string) => ({ event: { id: "1", type: "session.idle", properties: { sessionID: id } } })

  await (p as any).event?.(ev("s1")) // nag
  writeFileSync(join(repo, "a.txt"), "v2") // uncommitted
  writeFileSync(join(repo, ".autopilot", "goal.md"), "# Goal: fix login\nSTATUS: DONE\n")
  await (p as any).event?.(ev("s1")) // done, but dirty
  expect(prompts).toHaveLength(2)
  expect(prompts[1].prompt).toContain("[Bulba Verify]")
  expect(prompts[1].prompt).toContain("uncommitted changes")

  // Коммитим -> консолидация
  execFileSync("git", ["-C", repo, "add", "a.txt"])
  execFileSync("git", ["-C", repo, "commit", "-qm", "fix"])
  await (p as any).event?.(ev("s1"))
  expect(prompts).toHaveLength(3)
  expect(prompts[2].prompt).toContain("Consolidate")
})

test("enforcer nags while plan is IN_PROGRESS", async () => {
  writeFileSync(join(dir, "plan.md"), "# Plan: db migration\nSTATUS: IN_PROGRESS\n## Tasks\n- [ ] 1.\n")
  const p = await plugin()
  await (p as any).event?.({ event: { id: "1", type: "session.idle", properties: { sessionID: "s1" } } })
  expect(prompts).toHaveLength(1)
  expect(prompts[0].prompt).toContain("db migration")
})

test("consolidation nudge fires once after work finishes", async () => {
  writeFileSync(join(dir, "goal.md"), "# Goal: fix login\n")
  const p = await plugin()
  const ev = (id: string) => ({ event: { id: "1", type: "session.idle", properties: { sessionID: id } } })

  await (p as any).event?.(ev("s1")) // nag
  expect(prompts).toHaveLength(1)
  expect(prompts[0].prompt).toContain("[Bulba Enforcer")

  writeFileSync(join(dir, "goal.md"), "# Goal: fix login\nSTATUS: DONE\n")
  await (p as any).event?.(ev("s1")) // done -> consolidate
  expect(prompts).toHaveLength(2)
  expect(prompts[1].prompt).toContain("Consolidate while context is fresh")
  expect(prompts[1].prompt).toContain(".ai-docs")

  await (p as any).event?.(ev("s1")) // no repeat
  expect(prompts).toHaveLength(2)
})

test("enforcer stops when goal is DONE", async () => {
  writeFileSync(join(dir, "goal.md"), "# Goal: fix login\nSTATUS: DONE\n")
  const p = await plugin()
  await (p as any).event?.({ event: { id: "1", type: "session.idle", properties: { sessionID: "s1" } } })
  expect(prompts).toHaveLength(0)
})

test("enforcer stops when plan is DONE", async () => {
  writeFileSync(join(dir, "plan.md"), "# Plan: db migration\nSTATUS: DONE\n")
  const p = await plugin()
  await (p as any).event?.({ event: { id: "1", type: "session.idle", properties: { sessionID: "s1" } } })
  expect(prompts).toHaveLength(0)
})

test("search_memory tool recalls project memory", async () => {
  mkdirSync(join(dir, "sessions"))
  writeFileSync(join(dir, "memory.md"), "# Memory\n- gateway timeout gotcha on port 8080\n")
  const p = await plugin()
  const out = await (p as any).tool.search_memory.execute({ query: "gateway" }, {})
  expect(out).toContain("gateway timeout")
})

test("skill auto-discovery writes index and injects it", async () => {
  const skills = join(dir, "skills")
  mkdirSync(skills)
  mkdirSync(join(skills, "webapp-testing"))
  writeFileSync(
    join(skills, "webapp-testing", "SKILL.md"),
    "---\nname: webapp-testing\ndescription: Test local web apps with Playwright\n---\n# Instructions\n",
  )
  const p = await plugin({ skillsDir: skills })
  await p.config?.({} as never)
  const idx = readFileSync(join(dir, "skills-index.md"), "utf8")
  expect(idx).toContain("webapp-testing")
  expect(idx).toContain("Playwright")

  const output: { system: string[] } = { system: [] }
  await (p as any)["experimental.chat.system.transform"]({}, output)
  expect(output.system.join("\n")).toContain("webapp-testing")
})

test("active plan injection includes resume with unchecked tasks", async () => {
  writeFileSync(join(dir, "plan.md"), "# Plan: rewrite client\nSTATUS: IN_PROGRESS\n## Tasks\n- [ ] 1. migrate auth\n- [x] 2. done\n")
  const p = await plugin()
  const output: { system: string[] } = { system: [] }
  await (p as any)["experimental.chat.system.transform"]({}, output)
  const joined = output.system.join("\n")
  expect(joined).toContain("Resume:")
  expect(joined).toContain("1 task(s) left")
  expect(joined).toContain("migrate auth")
})

test("memory nudge fires on idle without active work", async () => {
  const p = await plugin({ memoryNudgeEvery: 2 })
  const ev = (id: string) => ({ event: { id: "1", type: "session.idle", properties: { sessionID: id } } })
  await (p as any).event?.(ev("s1")) // idle 1
  await (p as any).event?.(ev("s1")) // idle 2 -> nudge
  expect(prompts).toHaveLength(1)
  expect(prompts[0].prompt).toContain("[Bulba Memory]")
  await (p as any).event?.(ev("s1")) // idle 3 -> no repeat
  expect(prompts).toHaveLength(1)
})

test("memory compaction nudge fires when memory exceeds the cap", async () => {
  writeFileSync(join(dir, "memory.md"), "# Memory\n" + "x".repeat(2000))
  const p = await plugin({ memoryMaxBytes: 500 })
  const ev = (id: string) => ({ event: { id: "1", type: "session.idle", properties: { sessionID: id } } })
  await (p as any).event?.(ev("s1"))
  expect(prompts).toHaveLength(1)
  expect(prompts[0].prompt).toContain("Compact it")
  await (p as any).event?.(ev("s1")) // один раз на сессию
  expect(prompts).toHaveLength(1)
})

test("lessons.md is injected into the system block", async () => {
  writeFileSync(join(dir, "lessons.md"), "## 2026-08-07\n- worktrees speed up review\n")
  const p = await plugin()
  const output: { system: string[] } = { system: [] }
  await (p as any)["experimental.chat.system.transform"]({}, output)
  expect(output.system.join("\n")).toContain("worktrees speed up review")
})

test("chat.message triggers AWAY goal deterministically", async () => {
  const p = await plugin()
  await (p as any)["chat.message"]?.(
    { sessionID: "s1" },
    { parts: [{ type: "text", text: "я уйду, поработай над оптимизацией" }] },
  )
  const goal = readFileSync(join(dir, "goal.md"), "utf8")
  expect(goal).toContain("MODE: AWAY")
  expect(goal).toContain("оптимизацией")
})

test("action rules appended to edit results during active work", async () => {
  writeFileSync(join(dir, "goal.md"), "# Goal: fix login\n")
  const p = await plugin()
  const out: { output: string } = { output: "ok" }
  await (p as any)["tool.execute.after"](
    { tool: "edit", sessionID: "s1", args: { filePath: "a.rs", newString: "x" } },
    out,
  )
  expect(out.output).toContain("[Active work]")
  expect(out.output).toContain("2 bulba-reviewer subagents")
})

test("bash gate pokes on python edits and shell grep", async () => {
  const p = await plugin()
  const out1: { output: string } = { output: "ok" }
  await (p as any)["tool.execute.after"](
    { tool: "bash", sessionID: "s1", args: { command: 'python3 -c \'open("a.rs", "w").write("x")\'' } },
    out1,
  )
  expect(out1.output).toContain("edited files via python/shell")

  const out2: { output: string } = { output: "ok" }
  await (p as any)["tool.execute.after"](
    { tool: "bash", sessionID: "s1", args: { command: "grep -rn foo src/" } },
    out2,
  )
  expect(out2.output).toContain("grepped via the shell")

  const out3: { output: string } = { output: "ok" }
  await (p as any)["tool.execute.after"](
    { tool: "bash", sessionID: "s1", args: { command: "cargo build" } },
    out3,
  )
  expect(out3.output).toBe("ok") // чистые команды не трогаем
})

test("todo enforcer reads the session todo list via API", async () => {
  writeFileSync(join(dir, "goal.md"), "# Goal: fix login\n")
  const ev = (id: string) => ({ event: { id: "1", type: "session.idle", properties: { sessionID: id } } })

  todoStub = [{ content: "a", status: "in_progress" }, { content: "b", status: "completed" }]
  const p1 = await plugin()
  await (p1 as any).event?.(ev("s1"))
  expect(prompts[0].prompt).toContain("[Todo] 1 incomplete todo(s)")

  todoStub = []
  const p2 = await plugin()
  await (p2 as any).event?.(ev("s2"))
  expect(prompts[1].prompt).toContain("No todo list for this session")

  todoStub = [{ content: "a", status: "completed" }]
  const p3 = await plugin()
  await (p3 as any).event?.(ev("s3"))
  expect(prompts[2].prompt).not.toContain("[Todo]")
})

test("python edits are blocked deterministically in tool.execute.before", async () => {
  const p = await plugin()
  await expect(
    (p as any)["tool.execute.before"]({ tool: "bash" }, { args: { command: 'python3 -c \'open("a.rs","w").write("x")\'' } }),
  ).rejects.toThrow("python/shell file editing is blocked")
  // чистые команды проходят
  await expect(
    (p as any)["tool.execute.before"]({ tool: "bash" }, { args: { command: "cargo build" } }),
  ).resolves.toBeUndefined()
})

test("AWAY mode auto-replies to permissions: reject outward, allow work", async () => {
  writeFileSync(join(dir, "goal.md"), "# Goal: optimize\nMODE: AWAY\n")
  const p = await plugin()
  const ev = (id: string, action: string, resources: string[]) => ({
    event: { id: "1", type: "permission.v2.asked", properties: { id, sessionID: "s1", action, resources } },
  })

  await (p as any).event?.(ev("p1", "bash", ["git push origin main"]))
  await (p as any).event?.(ev("p2", "bash", ["cargo build"]))
  await (p as any).event?.(ev("p3", "external_directory", ["/etc"]))
  expect(permissionReplies).toEqual([
    { id: "p1", reply: "reject" },
    { id: "p2", reply: "once" },
    { id: "p3", reply: "reject" },
  ])
})

test("no permission auto-replies outside AWAY", async () => {
  writeFileSync(join(dir, "goal.md"), "# Goal: fix login\n")
  const p = await plugin()
  await (p as any).event?.({
    event: { id: "1", type: "permission.v2.asked", properties: { id: "p1", sessionID: "s1", action: "bash", resources: ["git push"] } },
  })
  expect(permissionReplies).toEqual([])
})

test("strict mode blocks direct edits during active work, allows otherwise", async () => {
  writeFileSync(join(dir, "goal.md"), "# Goal: fix login\n")
  const p = await plugin({ strictMode: true })
  await expect(
    (p as any)["tool.execute.before"]({ tool: "edit" }, { args: { filePath: "a.rs", newString: "x" } }),
  ).rejects.toThrow("strict mode")
  await expect(
    (p as any)["tool.execute.before"]({ tool: "bash" }, { args: { command: 'python3 -c \'open("a.rs","w").write("x")\'' } }),
  ).rejects.toThrow("strict mode")

  // Без активной работы strict не мешает
  rmSync(join(dir, "goal.md"))
  await expect(
    (p as any)["tool.execute.before"]({ tool: "edit" }, { args: { filePath: "a.rs", newString: "x" } }),
  ).resolves.toBeUndefined()

  // Инъекция strict-блока
  writeFileSync(join(dir, "goal.md"), "# Goal: fix login\n")
  const output: { system: string[] } = { system: [] }
  await (p as any)["experimental.chat.system.transform"]({}, output)
  expect(output.system.join("\n")).toContain("STRICT MODE")
})

test("intake gate: pending plan does not trigger the enforcer", async () => {
  writeFileSync(join(dir, "plan.md"), "# Plan: app\nSTATUS: AWAITING_APPROVAL\n## Goal\n## Success criteria\n- [ ] c1\n## Tasks\n- [ ] 1.\n")
  const p = await plugin()
  const ev = (id: string) => ({ event: { id: "1", type: "session.idle", properties: { sessionID: id } } })
  await (p as any).event?.(ev("s1"))
  expect(prompts).toHaveLength(0) // не дёргаем, пока не одобрено

  const output: { system: string[] } = { system: [] }
  await (p as any)["experimental.chat.system.transform"]({}, output)
  expect(output.system.join("\n")).toContain("awaiting approval")
})

test("auto-summarize fires on idle without active work", async () => {
  const p = await plugin({ autoSummarizeEvery: 2 })
  const ev = (id: string) => ({ event: { id: "1", type: "session.idle", properties: { sessionID: id } } })
  await (p as any).event?.(ev("s1"))
  await (p as any).event?.(ev("s1"))
  expect(prompts).toHaveLength(1)
  expect(prompts[0].prompt).toContain("Auto-summarize this session")
  await (p as any).event?.(ev("s1")) // один раз на сессию
  expect(prompts).toHaveLength(1)
})

test("MEA blocks direct code edits during an active plan, allows state files", async () => {
  const state = join(dir, ".bulba")
  mkdirSync(state)
  writeFileSync(join(state, "plan.md"), "# Plan: app\nSTATUS: IN_PROGRESS\n## Tasks\n- [ ] 1. x\n")
  const p = await plugin({ stateDir: state, directory: dir })
  await expect(
    (p as any)["tool.execute.before"]({ tool: "edit" }, { args: { filePath: join(dir, "src", "a.rs"), newString: "x" } }),
  ).rejects.toThrow("You are the manager")
  // state-файлы менеджеру можно
  await expect(
    (p as any)["tool.execute.before"]({ tool: "edit" }, { args: { filePath: join(state, "plan.md"), newString: "- [x]" } }),
  ).resolves.toBeUndefined()
  // без активного плана правки разрешены
  rmSync(join(state, "plan.md"))
  await expect(
    (p as any)["tool.execute.before"]({ tool: "edit" }, { args: { filePath: join(dir, "a.rs"), newString: "x" } }),
  ).resolves.toBeUndefined()
})

test("MEA block never applies to subagent sessions (implementer must edit)", async () => {
  const state = join(dir, ".bulba")
  mkdirSync(state)
  writeFileSync(join(state, "plan.md"), "# Plan: app\nSTATUS: IN_PROGRESS\n## Tasks\n- [ ] 1. x\n")
  const p = await plugin({ stateDir: state, directory: dir })
  // менеджер (parentID null) - блок работает
  await expect(
    (p as any)["tool.execute.before"]({ tool: "edit", sessionID: "ses_mgr" }, { args: { filePath: join(dir, "a.rs") } }),
  ).rejects.toThrow("You are the manager")
  // субагент (parentID set) - правки разрешены
  sessionGetStub = { parentID: "ses_mgr" }
  await expect(
    (p as any)["tool.execute.before"]({ tool: "edit", sessionID: "ses_impl" }, { args: { filePath: join(dir, "a.rs") } }),
  ).resolves.toBeUndefined()
})

test("compaction triggers a knowledge base update", async () => {
  const p = await plugin()
  await (p as any).event?.({ event: { id: "1", type: "session.compacted", properties: { sessionID: "s1" } } })
  expect(prompts).toHaveLength(1)
  expect(prompts[0].prompt).toContain("update the knowledge base")
  // один раз на сессию
  await (p as any).event?.({ event: { id: "1", type: "session.compacted", properties: { sessionID: "s1" } } })
  expect(prompts).toHaveLength(1)
})

test("compact_context tool triggers session compaction", async () => {
  let called = false
  const p = await BulbaPlugin(
    {
      client: {
        session: {
          prompt: async () => {},
          todo: async () => ({ data: undefined }),
          summarize: async () => {
            called = true
            return { data: { ok: true } }
          },
        },
      },
      project: {} as never,
      directory: dir,
      worktree: dir,
      experimental_workspace: {} as never,
      serverUrl: new URL("http://127.0.0.1:1"),
      $: null as never,
    },
    { stateDir: dir },
  )
  const out = await (p as any).tool.compact_context.execute({}, { sessionID: "s1" })
  expect(called).toBe(true)
  expect(out).toContain("Compaction triggered")
})

test("core doctrine mentions the 80-90% KB-first compaction rule", async () => {
  const p = await plugin()
  const output: { system: string[] } = { system: [] }
  await (p as any)["experimental.chat.system.transform"]({}, output)
  expect(output.system.join("\n")).toContain("compact_context")
})

test("programmatic context trigger: KB update + compaction at ~85%", async () => {
  const big = "x".repeat(40_000) // ~11k токенов при окне 128k - мало
  let messagesData: unknown = []
  const p = await BulbaPlugin(
    {
      client: {
        session: {
          prompt: async (v: { body: { prompt: string } }) => prompts.push({ sessionID: "s1", prompt: v.body.prompt }),
          todo: async () => ({ data: undefined }),
          summarize: async () => {
            summarizedCalls++
            return { data: { ok: true } }
          },
          messages: async () => ({ data: messagesData }),
        },
      },
      project: {} as never,
      directory: dir,
      worktree: dir,
      experimental_workspace: {} as never,
      serverUrl: new URL("http://127.0.0.1:1"),
      $: null as never,
    },
    { stateDir: dir, contextWindowTokens: 10_000, contextCompactPct: 0.85 },
  )
  let summarizedCalls = 0
  // ниже порога: 40k символов / 3.5 = 11.4k > 8.5k - над порогом. Проверяем обе ветки:
  messagesData = [{ parts: [{ text: "y".repeat(3_000) }] }] // ~857 токенов < 8.5k
  await (p as any).event?.({ event: { id: "1", type: "session.idle", properties: { sessionID: "s1" } } })
  expect(prompts).toHaveLength(0) // ниже порога - ничего

  messagesData = [{ parts: [{ text: "y".repeat(40_000) }] }] // ~11.4k > 8.5k
  await (p as any).event?.({ event: { id: "1", type: "session.idle", properties: { sessionID: "s1" } } })
  expect(prompts).toHaveLength(1)
  expect(prompts[0].prompt).toContain("Context is ~")
  expect(summarizedCalls).toBe(1) // компакция вызвана программно

  // повторно не срабатывает до session.compacted
  await (p as any).event?.({ event: { id: "1", type: "session.idle", properties: { sessionID: "s1" } } })
  expect(prompts).toHaveLength(1)
  // после компакта сброс - следующий цикл снова сработает
  await (p as any).event?.({ event: { id: "1", type: "session.compacted", properties: { sessionID: "s1" } } })
  await (p as any).event?.({ event: { id: "1", type: "session.idle", properties: { sessionID: "s1" } } })
  expect(prompts).toHaveLength(2)
})

test("context window auto-detected from the model catalog", async () => {
  let messagesData: unknown = []
  const p = await BulbaPlugin(
    {
      client: {
        session: {
          prompt: async (v: { body: { prompt: string } }) => prompts.push({ sessionID: "s2", prompt: v.body.prompt }),
          todo: async () => ({ data: undefined }),
          summarize: async () => ({ data: { ok: true } }),
          messages: async () => ({ data: messagesData }),
          get: async () => ({ data: { model: { id: "lm-studio-1m", providerID: "lmstudio" } } }),
        },
        provider: {
          list: async () => ({
            data: {
              all: [{ id: "lmstudio", models: { "lm-studio-1m": { limit: { context: 1_000_000 } } } }],
            },
          }),
        },
      },
      project: {} as never,
      directory: dir,
      worktree: dir,
      experimental_workspace: {} as never,
      serverUrl: new URL("http://127.0.0.1:1"),
      $: null as never,
    },
    { stateDir: dir, contextWindowTokens: 10_000, contextCompactPct: 0.85 },
  )
  // 850k токенов текста - над 85% от 1M, но сильно ниже 85% от 10k-фолбэка...
  // окно определено как 1M: 900k / 1M = 90% > 85% - срабатывает
  messagesData = [{ parts: [{ text: "y".repeat(900_000 * 3.5) }] }]
  await (p as any).event?.({ event: { id: "1", type: "session.idle", properties: { sessionID: "s2" } } })
  expect(prompts).toHaveLength(1)
  expect(prompts[0].prompt).toContain("detected window 1000000")
})

test("MEA gate requires observed delegation (implementer + reviewer)", async () => {
  const state = join(dir, ".bulba")
  mkdirSync(state)
  writeFileSync(join(state, "plan.md"), "# Plan: app\nSTATUS: DONE\n## Tasks\n- [x] 1. x\n## Review\n- r1: a.rs:1 bug\n- r2: b.rs:2 race\n")
  writeFileSync(join(state, "verify.md"), "bun test: ok\n")
  const p = await plugin({ stateDir: state, directory: dir })
  // имитируем работу: nag, чтобы rounds запомнил сессию
  writeFileSync(join(state, "goal.md"), "# Goal: x\n")
  await (p as any).event?.({ event: { id: "1", type: "session.idle", properties: { sessionID: "s1" } } })
  rmSync(join(state, "goal.md"))
  await (p as any).event?.({ event: { id: "1", type: "session.idle", properties: { sessionID: "s1" } } })
  expect(prompts[1].prompt).toContain("no bulba-implementer delegation")
  expect(prompts[1].prompt).toContain("no bulba-reviewer audit")

  // после реальных вызовов task-тула - гейт проходит дальше
  const out: { output: string } = { output: "ok" }
  await (p as any)["tool.execute.after"](
    { tool: "task", sessionID: "s1", args: { subagent_type: "bulba-implementer" } },
    out,
  )
  await (p as any)["tool.execute.after"](
    { tool: "task", sessionID: "s1", args: { subagent_type: "bulba-reviewer" } },
    out,
  )
  await (p as any).event?.({ event: { id: "1", type: "session.idle", properties: { sessionID: "s1" } } })
  expect(prompts[2].prompt).not.toContain("delegation")
})

test("no goal → no nagging", async () => {
  const p = await plugin()
  await (p as any).event?.({ event: { id: "1", type: "session.idle", properties: { sessionID: "s1" } } })
  expect(prompts).toHaveLength(0)
})

test("danger mode denies reading the askpass file and injects rules", async () => {
  const p = await plugin({ dangerMode: true })
  const config: Record<string, unknown> = { permission: {} }
  await p.config?.(config as never)
  expect((config.permission as any).read["*/.sudo-askpass*"]).toBe("deny")
  expect((config.permission as any).bash["*sudo-askpass*"]).toBe("deny")

  const output: { system: string[] } = { system: [] }
  await (p as any)["experimental.chat.system.transform"]({}, output)
  expect(output.system.join("\n")).toContain("DANGER MODE")
  expect(output.system.join("\n")).toContain("Check twice, act once")
})
