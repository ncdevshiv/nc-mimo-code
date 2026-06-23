// Verify `Truncate.Options.minThresholdBytes` skips the disk write
// when the truncation overshoot is small. The preview is still
// returned and `truncated: true`, but `outputPath` is omitted.

import { describe, test, expect } from "bun:test"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { Truncate } from "../../src/tool"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Truncate.defaultLayer, NodeFileSystem.layer))

describe("Truncate.output minThresholdBytes", () => {
  it.live("writes to disk when overshoot exceeds threshold", () =>
    Effect.gen(function* () {
      const svc = yield* Truncate.Service
      const content = "a".repeat(60 * 1024) // 60KB
      const result = yield* svc.output(content, { maxBytes: 50 * 1024, minThresholdBytes: 1024 })
      expect(result.truncated).toBe(true)
      if (result.truncated) expect(result.outputPath).toBeDefined()
    }),
  )

  it.live("skips disk write when overshoot is at or below threshold", () =>
    Effect.gen(function* () {
      const svc = yield* Truncate.Service
      // 50.5KB → overshoot 512 bytes. Threshold 1024.
      const content = "a".repeat(50 * 1024 + 512)
      const result = yield* svc.output(content, { maxBytes: 50 * 1024, minThresholdBytes: 1024 })
      expect(result.truncated).toBe(true)
      if (result.truncated) {
        expect(result.outputPath).toBeUndefined()
        // Still surfaces a useful preview.
        expect(result.content).toContain("a")
      }
    }),
  )
})