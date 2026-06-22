import path from "path"
import { pathToFileURL } from "url"
import z from "zod"
import { Effect } from "effect"
import * as Stream from "effect/Stream"
import { Ripgrep } from "../file/ripgrep"
import { Skill } from "../skill"
import * as Tool from "./tool"
import DESCRIPTION from "./skill.txt"

// Audit §10: the skill tool's file list (the `<skill_files>` block)
// is the expensive part — every call ripgreps the skill dir and
// re-renders up to 10 paths. When the LLM calls `skill` repeatedly
// in the same session to "remind itself" of a skill it has already
// loaded, the body is unchanged but the file list is rebuilt. The
// `cache_for` field (seconds; default 0 = always fresh) keys a
// process-local cache by `name` and skips the ripgrep when the
// cached list is still within the TTL.
//
// The body is ALWAYS read fresh — the cache is for the file list
// only. The body is a single small file; the file list is the
// hot path.
type CachedFileList = { dir: string; files: string; expiresAt: number }
const fileListCache = new Map<string, CachedFileList>()

function readCachedFileList(name: string, dir: string, cacheFor: number): string | null {
  if (cacheFor <= 0) return null
  const hit = fileListCache.get(name)
  const now = Date.now()
  if (hit && hit.dir === dir && hit.expiresAt > now) return hit.files
  return null
}

function writeCachedFileList(name: string, dir: string, files: string, cacheFor: number) {
  if (cacheFor <= 0) return
  fileListCache.set(name, { dir, files, expiresAt: Date.now() + cacheFor * 1000 })
}

const Parameters = z.object({
  name: z.string().describe("The name of the skill from available_skills"),
  // Default 0 (always fresh) preserves the existing behavior. A
  // positive value caches the file list for N seconds. The body
  // is still re-read every call — the cache is for the
  // ripgrep-driven file list only.
  cache_for: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "How long (seconds) to cache the file list for this skill. 0 = always fresh (default). The body is always re-read; only the file list is cached.",
    ),
})

export const SkillTool = Tool.define(
  "skill",
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    const rg = yield* Ripgrep.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      formatValidationError: Tool.formatZodError({
        name: { type: "string (skill name from available_skills)", required: true },
        cache_for: { type: "number (seconds, default 0)", required: false },
      }),
      execute: (params: z.infer<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const info = yield* skill.get(params.name)
          if (!info) {
            const all = yield* skill.all()
            const available = all.map((item) => item.name).join(", ")
            throw new Error(`Skill "${params.name}" not found. Available skills: ${available || "none"}`)
          }

          yield* ctx.ask({
            permission: "skill",
            patterns: [params.name],
            always: [params.name],
            metadata: {},
          })

          const dir = path.dirname(info.location)
          const base = pathToFileURL(dir).href
          const cacheFor = params.cache_for ?? 0
          let files: string
          const cached = readCachedFileList(params.name, dir, cacheFor)
          if (cached !== null) {
            files = cached
          } else {
            const limit = 10
            files = yield* rg.files({ cwd: dir, follow: false, hidden: true, signal: ctx.abort }).pipe(
              Stream.filter((file) => !file.includes("SKILL.md")),
              Stream.map((file) => path.resolve(dir, file)),
              Stream.take(limit),
              Stream.runCollect,
              Effect.map((chunk) => [...chunk].map((file) => `<file>${file}</file>`).join("\n")),
            )
            writeCachedFileList(params.name, dir, files, cacheFor)
          }

          return {
            title: `Loaded skill: ${info.name}`,
            output: [
              `<skill_content name="${info.name}">`,
              `# Skill: ${info.name}`,
              "",
              info.content.trim(),
              "",
              `Base directory for this skill: ${base}`,
              "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
              "Note: file list is sampled.",
              "",
              "<skill_files>",
              files,
              "</skill_files>",
              "</skill_content>",
            ].join("\n"),
            metadata: {
              name: info.name,
              dir,
              cache_for: cacheFor,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
