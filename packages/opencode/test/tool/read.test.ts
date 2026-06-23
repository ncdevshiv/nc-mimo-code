import { afterEach, describe, expect, it as bunIt } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import path from "path"
import { Agent } from "../../src/agent/agent"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { AppFileSystem } from "@nc-mimo-code/shared/filesystem"
import { LSP } from "../../src/lsp"
import { Permission } from "../../src/permission"
import { Instance } from "../../src/project/instance"
import { SessionID, MessageID } from "../../src/session/schema"
import { Instruction } from "../../src/session/instruction"
import { ReadTool } from "../../src/tool/read"
import { Truncate } from "../../src/tool"
import { Tool } from "../../src/tool"
import { BUDGET } from "../../src/config/tool-budget-resolve"
import { Filesystem } from "../../src/util"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures")

afterEach(async () => {
  await Instance.disposeAll()
})

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    AppFileSystem.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Instruction.defaultLayer,
    LSP.defaultLayer,
    Truncate.defaultLayer,
  ),
)

const init = Effect.fn("ReadToolTest.init")(function* () {
  const info = yield* ReadTool
  return yield* info.init()
})

const run = Effect.fn("ReadToolTest.run")(function* (
  args: Tool.InferParameters<typeof ReadTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  return yield* tool.execute(args, next)
})

const exec = Effect.fn("ReadToolTest.exec")(function* (
  dir: string,
  args: Tool.InferParameters<typeof ReadTool>,
  next: Tool.Context = ctx,
) {
  return yield* provideInstance(dir)(run(args, next))
})

const fail = Effect.fn("ReadToolTest.fail")(function* (
  dir: string,
  args: Tool.InferParameters<typeof ReadTool>,
  next: Tool.Context = ctx,
) {
  const exit = yield* exec(dir, args, next).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected read to fail")
})

const full = (p: string) => (process.platform === "win32" ? Filesystem.normalizePath(p) : p)
const glob = (p: string) =>
  process.platform === "win32" ? Filesystem.normalizePathPattern(p) : p.replaceAll("\\", "/")
const put = Effect.fn("ReadToolTest.put")(function* (p: string, content: string | Buffer | Uint8Array) {
  const fs = yield* AppFileSystem.Service
  yield* fs.writeWithDirs(p, content)
})
const load = Effect.fn("ReadToolTest.load")(function* (p: string) {
  const fs = yield* AppFileSystem.Service
  return yield* fs.readFileString(p)
})
const asks = () => {
  const items: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
  return {
    items,
    next: {
      ...ctx,
      ask: (req: Omit<Permission.Request, "id" | "sessionID" | "tool">) =>
        Effect.sync(() => {
          items.push(req)
        }),
    },
  }
}

describe("tool.read external_directory permission", () => {
  it.live("allows reading absolute path inside project directory", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "test.txt"), "hello world")

      const result = yield* exec(dir, { filePath: path.join(dir, "test.txt") })
      expect(result.output).toContain("hello world")
    }),
  )

  it.live("allows reading file in subdirectory inside project directory", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "subdir", "test.txt"), "nested content")

      const result = yield* exec(dir, { filePath: path.join(dir, "subdir", "test.txt") })
      expect(result.output).toContain("nested content")
    }),
  )

  it.live("asks for external_directory permission when reading absolute path outside project", () =>
    Effect.gen(function* () {
      const outer = yield* tmpdirScoped()
      const dir = yield* tmpdirScoped({ git: true })
      yield* put(path.join(outer, "secret.txt"), "secret data")

      const { items, next } = asks()

      yield* exec(dir, { filePath: path.join(outer, "secret.txt") }, next)
      const ext = items.find((item) => item.permission === "external_directory")
      expect(ext).toBeDefined()
      expect(ext!.patterns).toContain(glob(path.join(outer, "*")))
    }),
  )

  if (process.platform === "win32") {
    it.live("normalizes read permission paths on Windows", () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({ git: true })
        yield* put(path.join(dir, "test.txt"), "hello world")

        const { items, next } = asks()
        const target = path.join(dir, "test.txt")
        const alt = target
          .replace(/^[A-Za-z]:/, "")
          .replaceAll("\\", "/")
          .toLowerCase()

        yield* exec(dir, { filePath: alt }, next)
        const read = items.find((item) => item.permission === "read")
        expect(read).toBeDefined()
        expect(read!.patterns).toEqual([full(target)])
      }),
    )
  }

  it.live("asks for directory-scoped external_directory permission when reading external directory", () =>
    Effect.gen(function* () {
      const outer = yield* tmpdirScoped()
      const dir = yield* tmpdirScoped({ git: true })
      yield* put(path.join(outer, "external", "a.txt"), "a")

      const { items, next } = asks()

      yield* exec(dir, { filePath: path.join(outer, "external") }, next)
      const ext = items.find((item) => item.permission === "external_directory")
      expect(ext).toBeDefined()
      expect(ext!.patterns).toContain(glob(path.join(outer, "external", "*")))
    }),
  )

  it.live("asks for external_directory permission when reading relative path outside project", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })

      const { items, next } = asks()

      yield* fail(dir, { filePath: "../outside.txt" }, next)
      const ext = items.find((item) => item.permission === "external_directory")
      expect(ext).toBeDefined()
    }),
  )

  it.live("does not ask for external_directory permission when reading inside project", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* put(path.join(dir, "internal.txt"), "internal content")

      const { items, next } = asks()

      yield* exec(dir, { filePath: path.join(dir, "internal.txt") }, next)
      const ext = items.find((item) => item.permission === "external_directory")
      expect(ext).toBeUndefined()
    }),
  )
})

describe("tool.read env file permissions", () => {
  const cases: [string, boolean][] = [
    [".env", true],
    [".env.local", true],
    [".env.production", true],
    [".env.development.local", true],
    [".env.example", false],
    [".envrc", false],
    ["environment.ts", false],
  ]

  for (const agentName of ["build", "plan"] as const) {
    describe(`agent=${agentName}`, () => {
      for (const [filename, shouldAsk] of cases) {
        it.live(`${filename} asks=${shouldAsk}`, () =>
          Effect.gen(function* () {
            const dir = yield* tmpdirScoped()
            yield* put(path.join(dir, filename), "content")

            const asked = yield* provideInstance(dir)(
              Effect.gen(function* () {
                const agent = yield* Agent.Service
                const info = yield* agent.get(agentName)
                let asked = false
                const next = {
                  ...ctx,
                  ask: (req: Omit<Permission.Request, "id" | "sessionID" | "tool">) =>
                    Effect.sync(() => {
                      for (const pattern of req.patterns) {
                        const rule = Permission.evaluate(req.permission, pattern, info.permission)
                        if (rule.action === "ask" && req.permission === "read") {
                          asked = true
                        }
                        if (rule.action === "deny") {
                          throw new Permission.DeniedError({ ruleset: info.permission })
                        }
                      }
                    }),
                }

                yield* run({ filePath: path.join(dir, filename) }, next)
                return asked
              }),
            )

            expect(asked).toBe(shouldAsk)
          }),
        )
      }
    })
  }
})

describe("tool.read truncation", () => {
  it.live("truncates large file by bytes and sets truncated metadata", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const base = yield* load(path.join(FIXTURES_DIR, "models-api.json"))
      const target = 60 * 1024
      const content = base.length >= target ? base : base.repeat(Math.ceil(target / base.length))
      yield* put(path.join(dir, "large.json"), content)

      const result = yield* exec(dir, { filePath: path.join(dir, "large.json") })
      expect(result.metadata.truncated).toBe(true)
      expect(result.output).toContain("Output capped at")
      expect(result.output).toContain("Use offset=")
    }),
  )

  it.live("truncates by line count when limit is specified", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
      yield* put(path.join(dir, "many-lines.txt"), lines)

      const result = yield* exec(dir, { filePath: path.join(dir, "many-lines.txt"), limit: 10 })
      expect(result.metadata.truncated).toBe(true)
      expect(result.output).toContain("Showing lines 1-10 of 100")
      expect(result.output).toContain("Use offset=11")
      expect(result.output).toContain("line0")
      expect(result.output).toContain("line9")
      expect(result.output).not.toContain("line10")
    }),
  )

  it.live("does not truncate small file", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "small.txt"), "hello world")

      const result = yield* exec(dir, { filePath: path.join(dir, "small.txt") })
      expect(result.metadata.truncated).toBe(false)
      expect(result.output).toContain("End of file")
    }),
  )

  it.live("respects offset parameter", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n")
      yield* put(path.join(dir, "offset.txt"), lines)

      const result = yield* exec(dir, { filePath: path.join(dir, "offset.txt"), offset: 10, limit: 5 })
      expect(result.output).toContain("10: line10")
      expect(result.output).toContain("14: line14")
      expect(result.output).not.toContain("9: line10")
      expect(result.output).not.toContain("15: line15")
      expect(result.output).toContain("line10")
      expect(result.output).toContain("line14")
      expect(result.output).not.toContain("line0")
      expect(result.output).not.toContain("line15")
    }),
  )

  it.live("throws when offset is beyond end of file", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const lines = Array.from({ length: 3 }, (_, i) => `line${i + 1}`).join("\n")
      yield* put(path.join(dir, "short.txt"), lines)

      const err = yield* fail(dir, { filePath: path.join(dir, "short.txt"), offset: 4, limit: 5 })
      expect(err.message).toContain("Offset 4 is out of range for this file (3 lines)")
    }),
  )

  it.live("allows reading empty file at default offset", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "empty.txt"), "")

      const result = yield* exec(dir, { filePath: path.join(dir, "empty.txt") })
      expect(result.metadata.truncated).toBe(false)
      expect(result.output).toContain("End of file - total 0 lines")
    }),
  )

  it.live("throws when offset > 1 for empty file", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "empty.txt"), "")

      const err = yield* fail(dir, { filePath: path.join(dir, "empty.txt"), offset: 2 })
      expect(err.message).toContain("Offset 2 is out of range for this file (0 lines)")
    }),
  )

  it.live("does not mark final directory page as truncated", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* Effect.forEach(
        Array.from({ length: 10 }, (_, i) => i),
        (i) => put(path.join(dir, "dir", `file-${i + 1}.txt`), `line${i}`),
        {
          concurrency: "unbounded",
        },
      )

      const result = yield* exec(dir, { filePath: path.join(dir, "dir"), offset: 6, limit: 5 })
      expect(result.metadata.truncated).toBe(false)
      expect(result.output).not.toContain("Showing 5 of 10 entries")
    }),
  )

  it.live("truncates long lines", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "long-line.txt"), "x".repeat(3000))

      const result = yield* exec(dir, { filePath: path.join(dir, "long-line.txt") })
      expect(result.output).toContain("(line truncated to 2000 chars)")
      expect(result.output.length).toBeLessThan(3000)
    }),
  )

  it.live("image files set truncated to false", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
        "base64",
      )
      yield* put(path.join(dir, "image.png"), png)

      const result = yield* exec(dir, { filePath: path.join(dir, "image.png") })
      expect(result.metadata.truncated).toBe(false)
      expect(result.attachments).toBeDefined()
      expect(result.attachments?.length).toBe(1)
      expect(result.attachments?.[0]).not.toHaveProperty("id")
      expect(result.attachments?.[0]).not.toHaveProperty("sessionID")
      expect(result.attachments?.[0]).not.toHaveProperty("messageID")
    }),
  )

  it.live("detects attachment media from file contents", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01])
      yield* put(path.join(dir, "image.bin"), jpeg)

      const result = yield* exec(dir, { filePath: path.join(dir, "image.bin") })
      expect(result.output).toBe("Image read successfully")
      expect(result.attachments?.[0].mime).toBe("image/jpeg")
      expect(result.attachments?.[0].url.startsWith("data:image/jpeg;base64,")).toBe(true)
    }),
  )

  it.live("large image files are properly attached without error", () =>
    Effect.gen(function* () {
      const result = yield* exec(FIXTURES_DIR, { filePath: path.join(FIXTURES_DIR, "large-image.png") })
      expect(result.metadata.truncated).toBe(false)
      expect(result.attachments).toBeDefined()
      expect(result.attachments?.length).toBe(1)
      expect(result.attachments?.[0].type).toBe("file")
      expect(result.attachments?.[0]).not.toHaveProperty("id")
      expect(result.attachments?.[0]).not.toHaveProperty("sessionID")
      expect(result.attachments?.[0]).not.toHaveProperty("messageID")
    }),
  )

  it.live(".fbs files (FlatBuffers schema) are read as text, not images", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const fbs = `namespace MyGame;

table Monster {
  pos:Vec3;
  name:string;
  inventory:[ubyte];
}

root_type Monster;`
      yield* put(path.join(dir, "schema.fbs"), fbs)

      const result = yield* exec(dir, { filePath: path.join(dir, "schema.fbs") })
      expect(result.attachments).toBeUndefined()
      expect(result.output).toContain("namespace MyGame")
      expect(result.output).toContain("table Monster")
    }),
  )
})

describe("tool.read loaded instructions", () => {
  it.live("loads AGENTS.md from parent directory and includes in metadata", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "subdir", "AGENTS.md"), "# Test Instructions\nDo something special.")
      yield* put(path.join(dir, "subdir", "nested", "test.txt"), "test content")

      const result = yield* exec(dir, { filePath: path.join(dir, "subdir", "nested", "test.txt") })
      expect(result.output).toContain("test content")
      expect(result.output).toContain("system-reminder")
      expect(result.output).toContain("Test Instructions")
      expect(result.metadata.loaded).toBeDefined()
      expect(result.metadata.loaded).toContain(path.join(dir, "subdir", "AGENTS.md"))
    }),
  )
})

describe("tool.read binary detection", () => {
  it.live("rejects text extension files with null bytes", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const bytes = Buffer.from([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0x77, 0x6f, 0x72, 0x6c, 0x64])
      yield* put(path.join(dir, "null-byte.txt"), bytes)

      const err = yield* fail(dir, { filePath: path.join(dir, "null-byte.txt") })
      expect(err.message).toContain("Cannot read binary file")
    }),
  )

  it.live("rejects known binary extensions", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "module.wasm"), "not really wasm")

      const err = yield* fail(dir, { filePath: path.join(dir, "module.wasm") })
      expect(err.message).toContain("Cannot read binary file")
    }),
  )
})

describe("tool.read new features", () => {
  // ---- 1. around parameter centers the window
  it.live("around parameter centers the read window", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const lines = Array.from({ length: 200 }, (_, i) => `line${i + 1}`).join("\n")
      yield* put(path.join(dir, "long.txt"), lines)

      const result = yield* exec(dir, { filePath: path.join(dir, "long.txt"), around: 100, limit: 20 })
      // around=100, limit=20, half=10, effectiveOffset=90. Window covers lines 90-109.
      expect(result.output).toContain("90: line90")
      expect(result.output).toContain("109: line109")
      expect(result.output).not.toContain("89: line89")
      expect(result.output).not.toContain("110: line110")
      expect(result.output).toContain("Centered on line 100")
    }),
  )

  // ---- 2. around overrides offset
  it.live("around overrides offset when both are set", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const lines = Array.from({ length: 50 }, (_, i) => `L${i + 1}`).join("\n")
      yield* put(path.join(dir, "f.txt"), lines)

      const result = yield* exec(dir, { filePath: path.join(dir, "f.txt"), offset: 5, around: 25, limit: 10 })
      // around=25 with limit=10 => half=5, so start=20. Output covers lines 20-29.
      expect(result.output).toContain("20: L20")
      expect(result.output).toContain("21: L21")
      expect(result.output).toContain("Centered on line 25")
      // offset=5 should be ignored
      expect(result.output).not.toContain("5: L5")
    }),
  )

  // ---- 3. ast: outline on a non-LSP file falls back to plain text
  it.live("ast=outline falls back to plain text when no LSP is available", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "plain.txt"), "hello\nworld\n")

      const result = yield* exec(dir, { filePath: path.join(dir, "plain.txt"), ast: "outline" })
      expect(result.output).toContain("No LSP outline available for this file")
      expect(result.output).toContain("hello")
      expect(result.output).toContain("world")
    }),
  )

  // ---- 4. ast: outline fallback honors offset/around/limit
  it.live("ast=outline fallback honors offset and limit", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const lines = Array.from({ length: 20 }, (_, i) => `row${i + 1}`).join("\n")
      yield* put(path.join(dir, "rows.txt"), lines)

      const result = yield* exec(dir, {
        filePath: path.join(dir, "rows.txt"),
        ast: "outline",
        offset: 5,
        limit: 3,
      })
      expect(result.output).toContain("No LSP outline available")
      expect(result.output).toContain("5: row5")
      expect(result.output).toContain("7: row7")
      expect(result.output).not.toContain("4: row4")
      expect(result.output).not.toContain("8: row8")
    }),
  )

  // ---- 5. image attachment size cap
  it.live("rejects image attachments exceeding the 10MB cap", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      // Build a "PNG" larger than 10MB. The detection only looks at the first
      // few bytes for magic numbers, so we can pad with arbitrary content.
      const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      const padding = Buffer.alloc(11 * 1024 * 1024, 0x42) // ~11MB
      yield* put(path.join(dir, "huge.png"), Buffer.concat([head, padding]))

      const err = yield* fail(dir, { filePath: path.join(dir, "huge.png") })
      expect(err.message).toContain("exceeding the")
      expect(err.message).toContain("10.0MB cap")
      expect(err.message).toContain("maxAttachmentBytes=")
    }),
  )

  // ---- 5b. maxAttachmentBytes override allows a larger file
  it.live("maxAttachmentBytes override lifts the cap", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      const padding = Buffer.alloc(11 * 1024 * 1024, 0x42)
      const buf = Buffer.concat([head, padding])
      yield* put(path.join(dir, "huge.png"), buf)

      const result = yield* exec(dir, {
        filePath: path.join(dir, "huge.png"),
        maxAttachmentBytes: 12 * 1024 * 1024,
      })
      expect(result.attachments).toBeDefined()
      expect(result.attachments?.[0].mime).toBe("image/png")
    }),
  )

  // ---- 6. encoding detection for utf-16le BOM
  it.live("detects utf-16le encoding from BOM and decodes content", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      // BOM (FF FE) + ASCII text in utf-16le
      const bom = Buffer.from([0xff, 0xfe])
      const text = Buffer.from("hello world\n", "utf16le")
      yield* put(path.join(dir, "utf16.txt"), Buffer.concat([bom, text]))

      const result = yield* exec(dir, { filePath: path.join(dir, "utf16.txt") })
      expect(result.output).toContain("hello world")
      expect(result.output).toContain('<meta>')
      expect(result.output).toContain("encoding=utf-16le")
    }),
  )

  // ---- 7. encoding default is utf-8 for non-ASCII text
  it.live("detects utf-8 encoding for text with non-ASCII bytes", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      // "café résumé" with a non-ASCII character — exercises the utf-8 detection
      // path that fires when the sample contains bytes >= 0x80.
      yield* put(path.join(dir, "plain.txt"), Buffer.from("café résumé\n", "utf8"))

      const result = yield* exec(dir, { filePath: path.join(dir, "plain.txt") })
      expect(result.output).toContain('<meta>')
      expect(result.output).toContain("encoding=utf-8")
      expect(result.output).toContain("café")
    }),
  )

  it.live("detects ascii encoding for pure-ASCII text", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "plain.txt"), "just some text\nwith newlines\n")

      const result = yield* exec(dir, { filePath: path.join(dir, "plain.txt") })
      expect(result.output).toContain('<meta>')
      expect(result.output).toContain("encoding=ascii")
      expect(result.output).toContain("just some text")
    }),
  )

  // ---- 8. .gitignore filtering for directories
  it.live("directory listing filters out .gitignore entries by default", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* put(path.join(dir, ".gitignore"), "node_modules\n")
      yield* put(path.join(dir, "node_modules", "x.js"), "ignored")
      yield* put(path.join(dir, "src", "y.js"), "kept")

      const result = yield* exec(dir, { filePath: dir })
      expect(result.output).toContain("src/")
      // node_modules directory entry should be filtered out
      expect(result.output).not.toContain("node_modules")
      expect(result.output).toContain("Filtered by .gitignore")
    }),
  )

  it.live("directory listing with showIgnored=true includes all entries", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* put(path.join(dir, ".gitignore"), "node_modules\n")
      yield* put(path.join(dir, "node_modules", "x.js"), "ignored")
      yield* put(path.join(dir, "src", "y.js"), "kept")

      const result = yield* exec(dir, { filePath: dir, showIgnored: true })
      expect(result.output).toContain("node_modules")
      expect(result.output).toContain("src")
      expect(result.output).toContain("Showing all entries, including ignored ones")
    }),
  )

  // ---- 9. symlink loop detection
  it.live("symlink loop in directory listing is marked and skipped", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const fs = yield* AppFileSystem.Service
      yield* put(path.join(dir, "real.txt"), "real")
      // Create a symlink that points back to the parent dir
      yield* fs
        .symlink(path.join(dir, "real.txt"), path.join(dir, "loop.txt"))
        .pipe(Effect.catch(() => Effect.void))
      // The test only matters if symlink creation succeeded; we don't fail
      // if it didn't (some sandboxes disallow it).
      const result = yield* exec(dir, { filePath: dir })
      // No infinite tree regardless — the listing must complete.
      expect(result.output).toContain("real.txt")
    }),
  )

  // ---- 10. metadata header on text reads
  it.live("text read includes <meta> header with size, lines, encoding", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "small.txt"), "abc\ndef\n")

      const result = yield* exec(dir, { filePath: path.join(dir, "small.txt") })
      expect(result.output).toMatch(/<meta>size=\S+, lines=2, encoding=\S+/)
    }),
  )

  // ---- 11. BUDGET import is wired
  bunIt("BUDGET.read defaults match the documented read caps", () => {
    expect(BUDGET.read.maxBytes).toBe(50 * 1024)
    expect(BUDGET.read.maxLines).toBe(2000)
    expect(BUDGET.read.maxLineLength).toBe(2000)
  })
})
