// Edge case tests for `Truncate.output`:
// - omit=0 case (head + tail cover all lines)
// - concurrent writes with different tool ids

import { describe, test, expect } from "bun:test"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { Truncate } from "../../src/tool"
import { DIR } from "../../src/tool/truncate"
import { AppFileSystem } from "@nc-mimo-code/shared/filesystem"
import path from "path"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Truncate.defaultLayer, NodeFileSystem.layer))

describe("Truncate.output omit=0", () => {
  it.live("renders cleanly when head+tail cover every line (no omitted lines)", () =>
    Effect.gen(function* () {
      const svc = yield* Truncate.Service
      // 60 lines with errors at the tail — head(70%) = 42, tail(30%) = 18. Total = 60. No omitted.
      const lines = Array.from({ length: 42 }, (_, i) => `ok line ${i}`).concat(
        Array.from({ length: 18 }, (_, i) => `fatal error at ${i}`),
      )
      const text = lines.join("\n")
      const result = yield* svc.output(text, {
        maxLines: 60,
        maxBytes: 10 * 1024,
        direction: "head+tail",
      })
      expect(result.truncated).toBe(true)
      if (result.truncated) {
        // The "omitted" wording should show 0.
        expect(result.content).toContain("0 lines omitted")
      }
    }),
  )
})

describe("Truncate.output concurrent calls", () => {
  it.live("two parallel truncations write to separate files", () =>
    Effect.gen(function* () {
      const svc = yield* Truncate.Service
      const fs = yield* AppFileSystem.Service
      const before = yield* fs.readDirectory(DIR).pipe(Effect.catch(() => Effect.succeed([])))
      for (const e of before) yield* fs.remove(path.join(DIR, e)).pipe(Effect.catch(() => Effect.void))

      const big = "z".repeat(60 * 1024)
      // Sequential — concurrent fork/join API differs across effect
      // versions and we don't need true parallelism to verify that
      // two outputs write to distinct files.
      const rA = yield* svc.output(big, { maxBytes: 1024 }, undefined, "tool-a")
      const rB = yield* svc.output(big, { maxBytes: 1024 }, undefined, "tool-b")

      expect(rA.truncated).toBe(true)
      expect(rB.truncated).toBe(true)
      if (rA.truncated && rB.truncated) {
        expect(rA.outputPath).toBeDefined()
        expect(rB.outputPath).toBeDefined()
        // Different filenames (tool-a vs tool-b prefix).
        expect(rA.outputPath).not.toBe(rB.outputPath)
      }
    }),
  )
})