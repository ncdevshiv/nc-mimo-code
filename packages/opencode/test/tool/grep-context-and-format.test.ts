import { describe, expect } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { GrepTool } from "../../src/tool/grep"
import { provideTmpdirInstance } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Truncate } from "../../src/tool"
import { Agent } from "../../src/agent/agent"
import { Ripgrep } from "../../src/file/ripgrep"
import { AppFileSystem } from "@nc-mimo-code/shared/filesystem"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    CrossSpawnSpawner.defaultLayer,
    AppFileSystem.defaultLayer,
    Ripgrep.defaultLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
  ),
)

const ctx = {
  sessionID: SessionID.make("ses_test-grep-flags"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

describe("tool.grep: context + result_format flags", () => {
  it.live("context: 2 includes 2 lines around each match", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const file = path.join(dir, "context.txt")
        yield* Effect.promise(() =>
          Bun.write(
            file,
            [
              "line1",
              "line2",
              "MATCH_LINE",
              "line4",
              "line5",
              "line6",
              "MATCH_AGAIN",
              "line8",
              "line9",
              "",
            ].join("\n"),
          ),
        )
        const info = yield* GrepTool
        const grep = yield* info.init()
        const result = yield* grep.execute(
          {
            pattern: "MATCH",
            path: dir,
            context: 2,
          },
          ctx,
        )
        // The output should contain the match line and at least the
        // surrounding context lines.
        expect(result.output).toContain("MATCH_LINE")
        expect(result.output).toContain("line2")
        expect(result.output).toContain("line4")
      }),
    ),
  )

  it.live("result_format: files_with_matches returns only paths", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const fileA = path.join(dir, "a.ts")
        const fileB = path.join(dir, "b.ts")
        const fileC = path.join(dir, "c.txt")
        yield* Effect.promise(() => Bun.write(fileA, "MATCH_HERE\n"))
        yield* Effect.promise(() => Bun.write(fileB, "MATCH_TOO\n"))
        yield* Effect.promise(() => Bun.write(fileC, "no match here\n"))
        const info = yield* GrepTool
        const grep = yield* info.init()
        const result = yield* grep.execute(
          {
            pattern: "MATCH",
            path: dir,
            result_format: "files_with_matches",
          },
          ctx,
        )
        // Output should list files containing matches.
        expect(result.output).toContain("Found")
        expect(result.output).toContain("a.ts")
        expect(result.output).toContain("b.ts")
        expect(result.output).not.toContain("c.txt")
      }),
    ),
  )

  it.live("result_format: count returns per-file match counts", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const fileA = path.join(dir, "a.ts")
        const fileB = path.join(dir, "b.ts")
        yield* Effect.promise(() => Bun.write(fileA, "MATCH\nMATCH\nMATCH\n"))
        yield* Effect.promise(() => Bun.write(fileB, "MATCH\n"))
        const info = yield* GrepTool
        const grep = yield* info.init()
        const result = yield* grep.execute(
          {
            pattern: "MATCH",
            path: dir,
            result_format: "count",
          },
          ctx,
        )
        expect(result.output).toContain("Match counts")
        // ripgrep emits `<path>:<count>` lines for `--count`; a.ts
        // should have 3 matches and b.ts should have 1.
        expect(result.output).toMatch(/a\.ts:3/)
        expect(result.output).toMatch(/b\.ts:1/)
      }),
    ),
  )

  it.live("context asymmetric (before/after object) only includes specified sides", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const file = path.join(dir, "asym.txt")
        yield* Effect.promise(() =>
          Bun.write(
            file,
            ["line1", "line2", "NEEDLE", "line4", "line5", ""].join("\n"),
          ),
        )
        const info = yield* GrepTool
        const grep = yield* info.init()
        const result = yield* grep.execute(
          {
            pattern: "NEEDLE",
            path: dir,
            context: { before: 1, after: 2 },
          },
          ctx,
        )
        // 1 line before + match + 2 lines after = line2, NEEDLE, line4, line5.
        expect(result.output).toContain("NEEDLE")
        expect(result.output).toContain("line2")
        expect(result.output).toContain("line4")
        expect(result.output).toContain("line5")
      }),
    ),
  )
})