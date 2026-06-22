import { describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Effect, Layer } from "effect"
import { MultiEditTool } from "../../src/tool/multiedit"
import { Instance } from "../../src/project/instance"
import { LSP } from "../../src/lsp"
import { AppFileSystem } from "@nc-mimo-code/shared/filesystem"
import { Format } from "../../src/format"
import { Bus } from "../../src/bus"
import { Truncate } from "../../src/tool"
import { Tool } from "../../src/tool"
import { Agent } from "../../src/agent/agent"
import { SessionID, MessageID } from "../../src/session/schema"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const ctx = {
  sessionID: SessionID.make("ses_test-multiedit"),
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
    LSP.defaultLayer,
    AppFileSystem.defaultLayer,
    Bus.layer,
    Format.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
  ),
)

const init = Effect.fn("MultiEditToolTest.init")(function* () {
  const info = yield* MultiEditTool
  return yield* info.init()
})

const run = Effect.fn("MultiEditToolTest.run")(function* (
  args: Tool.InferParameters<typeof MultiEditTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  return yield* tool.execute(args, next)
})

describe("tool.multiedit", () => {
  it.live("applies all edits when every oldString matches", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const filepath = path.join(dir, "multi.txt")
        yield* Effect.promise(() =>
          fs.writeFile(filepath, "alpha\nbeta\ngamma\n", "utf-8"),
        )

        const result = yield* run({
          filePath: filepath,
          edits: [
            { oldString: "alpha", newString: "ALPHA" },
            { oldString: "beta", newString: "BETA" },
            { oldString: "gamma", newString: "GAMMA" },
          ],
        })
        expect(result.metadata.results).toHaveLength(3)
        expect(yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))).toBe(
          "ALPHA\nBETA\nGAMMA\n",
        )
      }),
    ),
  )

  it.live(
    "rolls back to the pre-batch content when a later edit fails",
    () =>
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          const filepath = path.join(dir, "rollback.txt")
          const original = "first\nsecond\nthird\n"
          yield* Effect.promise(() => fs.writeFile(filepath, original, "utf-8"))

          const exit = yield* run({
            filePath: filepath,
            edits: [
              { oldString: "first", newString: "FIRST" },
              { oldString: "second", newString: "SECOND" },
              // This edit fails: "does-not-exist" is not in the file.
              { oldString: "does-not-exist", newString: "REPLACED" },
            ],
          }).pipe(Effect.exit)

          // The call exits with a Failure (the 3rd edit threw).
          expect(exit._tag).toBe("Failure")
          // The file is rolled back to the original content.
          expect(yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))).toBe(original)
        }),
      ),
  )

  it.live("rolls back a newly-created file when the first edit fails", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const filepath = path.join(dir, "fresh.txt")
        // File does not exist at start.
        const exit = yield* run({
          filePath: filepath,
          edits: [
            // First edit creates the file, then the second fails.
            { oldString: "", newString: "new content\n" },
            { oldString: "missing", newString: "REPLACED" },
          ],
        }).pipe(Effect.exit)

        expect(exit._tag).toBe("Failure")
        // The file was created then rolled back — it should not exist.
        const exists = yield* Effect.promise(() =>
          fs
            .stat(filepath)
            .then(() => true)
            .catch(() => false),
        )
        expect(exists).toBe(false)
      }),
    ),
  )

  it.live("rolls back when a middle edit fails", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const filepath = path.join(dir, "middle.txt")
        const original = "one\ntwo\nthree\nfour\n"
        yield* Effect.promise(() => fs.writeFile(filepath, original, "utf-8"))

        const exit = yield* run({
          filePath: filepath,
          edits: [
            { oldString: "one", newString: "ONE" },
            // Middle edit fails.
            { oldString: "absent", newString: "X" },
            { oldString: "three", newString: "THREE" },
            { oldString: "four", newString: "FOUR" },
          ],
        }).pipe(Effect.exit)

        expect(exit._tag).toBe("Failure")
        expect(yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))).toBe(original)
      }),
    ),
  )

  it.live("an empty edits array is a no-op", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const filepath = path.join(dir, "empty.txt")
        yield* Effect.promise(() => fs.writeFile(filepath, "untouched\n", "utf-8"))

        const result = yield* run({ filePath: filepath, edits: [] })
        expect(result.metadata.results).toHaveLength(0)
        expect(yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))).toBe("untouched\n")
      }),
    ),
  )

  it.live("single-edit batch behaves like the edit tool", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const filepath = path.join(dir, "single.txt")
        yield* Effect.promise(() => fs.writeFile(filepath, "hello\n", "utf-8"))

        const result = yield* run({
          filePath: filepath,
          edits: [{ oldString: "hello", newString: "goodbye" }],
        })
        expect(result.metadata.results).toHaveLength(1)
        expect(yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))).toBe("goodbye\n")
      }),
    ),
  )
})