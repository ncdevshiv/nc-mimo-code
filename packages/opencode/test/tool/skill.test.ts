import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { pathToFileURL } from "url"
import type { Permission } from "../../src/permission"
import type { Tool } from "../../src/tool"
import { Instance } from "../../src/project/instance"
import { SkillTool } from "../../src/tool/skill"
import { ToolRegistry } from "../../src/tool"
import { provideTmpdirInstance } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const baseCtx: Omit<Tool.Context, "ask"> = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
}

afterEach(async () => {
  await Instance.disposeAll()
})

const node = CrossSpawnSpawner.defaultLayer

const it = testEffect(Layer.mergeAll(ToolRegistry.defaultLayer, node))

describe("tool.skill", () => {
  it.live("execute returns skill content block with files", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const skill = path.join(dir, ".mimocode", "skill", "tool-skill")
          yield* Effect.promise(() =>
            Bun.write(
              path.join(skill, "SKILL.md"),
              `---
name: tool-skill
description: Skill for tool tests.
---

# Tool Skill

Use this skill.
`,
            ),
          )
          yield* Effect.promise(() => Bun.write(path.join(skill, "scripts", "demo.txt"), "demo"))

          const home = process.env.HOME
          const userProfile = process.env.USERPROFILE
          process.env.HOME = dir
          process.env.USERPROFILE = dir
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              process.env.HOME = home
              process.env.USERPROFILE = userProfile
            }),
          )

          const registry = yield* ToolRegistry.Service
          const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }
          const tool = (yield* registry.tools({
            providerID: "opencode" as any,
            modelID: "gpt-5" as any,
            agent,
          })).find((tool) => tool.id === SkillTool.id)
          if (!tool) throw new Error("Skill tool not found")

          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          const ctx: Tool.Context = {
            ...baseCtx,
            ask: (req) =>
              Effect.sync(() => {
                requests.push(req)
              }),
          }

          const result = yield* tool.execute({ name: "tool-skill" }, ctx)
          const file = path.resolve(skill, "scripts", "demo.txt")

          expect(requests.length).toBe(1)
          expect(requests[0].permission).toBe("skill")
          expect(requests[0].patterns).toContain("tool-skill")
          expect(requests[0].always).toContain("tool-skill")
          expect(result.metadata.dir).toBe(skill)
          expect(result.output).toContain(`<skill_content name="tool-skill">`)
          expect(result.output).toContain(`Base directory for this skill: ${pathToFileURL(skill).href}`)
          expect(result.output).toContain(`<file>${file}</file>`)
        }),
      { git: true },
    ),
  )

  // Audit §10: `cache_for` keeps the file list in a process-local
  // cache keyed by skill name. When the LLM calls `skill`
  // repeatedly with the same name, the second call within the
  // TTL must return the same `<skill_files>` block without
  // re-running ripgrep.
  it.live("cache_for skips the ripgrep on the second call within the TTL", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const skill = path.join(dir, ".mimocode", "skill", "cached-skill")
          yield* Effect.promise(() =>
            Bun.write(
              path.join(skill, "SKILL.md"),
              `---
name: cached-skill
description: Skill for cache_for tests.
---

# Cached

Cached body.
`,
            ),
          )
          yield* Effect.promise(() => Bun.write(path.join(skill, "a.txt"), "a"))
          yield* Effect.promise(() => Bun.write(path.join(skill, "b.txt"), "b"))

          const home = process.env.HOME
          const userProfile = process.env.USERPROFILE
          process.env.HOME = dir
          process.env.USERPROFILE = dir
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              process.env.HOME = home
              process.env.USERPROFILE = userProfile
            }),
          )

          const registry = yield* ToolRegistry.Service
          const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }
          const tool = (yield* registry.tools({
            providerID: "opencode" as any,
            modelID: "gpt-5" as any,
            agent,
          })).find((tool) => tool.id === SkillTool.id)
          if (!tool) throw new Error("Skill tool not found")

          const ctx: Tool.Context = {
            ...baseCtx,
            ask: () => Effect.void,
          }

          // First call: cache_for=60. The file list is computed
          // and cached. metadata.cache_for is the resolved value.
          const r1 = yield* tool.execute({ name: "cached-skill", cache_for: 60 }, ctx)
          expect(r1.metadata.cache_for).toBe(60)
          const files1 = r1.output.match(/<skill_files>([\s\S]*?)<\/skill_files>/)?.[1] ?? ""
          expect(files1).toContain("a.txt")
          expect(files1).toContain("b.txt")

          // Drop a new file into the skill dir. Without the
          // cache, the second call's file list would include
          // `c.txt`; with the cache, the second call returns the
          // original list (cache hit).
          yield* Effect.promise(() => Bun.write(path.join(skill, "c.txt"), "c"))

          const r2 = yield* tool.execute({ name: "cached-skill", cache_for: 60 }, ctx)
          const files2 = r2.output.match(/<skill_files>([\s\S]*?)<\/skill_files>/)?.[1] ?? ""
          expect(files2).toBe(files1)
          // `c.txt` is on disk but not in the cached list.
          expect(files2).not.toContain("c.txt")
        }),
      { git: true },
    ),
  )

  it.live("cache_for: 0 (default) always recomputes the file list", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const skill = path.join(dir, ".mimocode", "skill", "fresh-skill")
          yield* Effect.promise(() =>
            Bun.write(
              path.join(skill, "SKILL.md"),
              `---
name: fresh-skill
description: Skill for fresh tests.
---

# Fresh

Fresh body.
`,
            ),
          )
          yield* Effect.promise(() => Bun.write(path.join(skill, "a.txt"), "a"))

          const home = process.env.HOME
          const userProfile = process.env.USERPROFILE
          process.env.HOME = dir
          process.env.USERPROFILE = dir
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              process.env.HOME = home
              process.env.USERPROFILE = userProfile
            }),
          )

          const registry = yield* ToolRegistry.Service
          const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }
          const tool = (yield* registry.tools({
            providerID: "opencode" as any,
            modelID: "gpt-5" as any,
            agent,
          })).find((tool) => tool.id === SkillTool.id)
          if (!tool) throw new Error("Skill tool not found")

          const ctx: Tool.Context = {
            ...baseCtx,
            ask: () => Effect.void,
          }

          // First call (default cache_for = 0).
          const r1 = yield* tool.execute({ name: "fresh-skill" }, ctx)
          expect(r1.metadata.cache_for).toBe(0)
          // Add a new file on disk; second call (still default
          // cache_for = 0) must see it.
          yield* Effect.promise(() => Bun.write(path.join(skill, "b.txt"), "b"))
          const r2 = yield* tool.execute({ name: "fresh-skill" }, ctx)
          const files2 = r2.output.match(/<skill_files>([\s\S]*?)<\/skill_files>/)?.[1] ?? ""
          expect(files2).toContain("b.txt")
        }),
      { git: true },
    ),
  )
})
