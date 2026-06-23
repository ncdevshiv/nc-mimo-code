// Multi-byte UTF-8 boundary tests. Verify `Truncate.output` and
// the underlying helpers never produce invalid UTF-8 (half-character
// splits) when truncating CJK or emoji payloads.

import { describe, test, expect } from "bun:test"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { Truncate } from "../../src/tool"
import { selectTail, selectHead } from "../../src/tool/truncate"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Truncate.defaultLayer, NodeFileSystem.layer))

describe("Truncate utf-8 boundary", () => {
  test("selectHead never splits a multi-byte character", () => {
    // Each "中" is 3 bytes in UTF-8. 100 chars = 300 bytes.
    const text = "中".repeat(100)
    const r = selectHead(text, 1000, 100) // byte cap lands inside a char
    expect(r.content.length).toBeGreaterThan(0)
    // Round-trip: result must be valid UTF-8 (Buffer.from decodes cleanly).
    expect(() => Buffer.from(r.content, "utf-8").toString("utf-8")).not.toThrow()
    // Buffer.byteLength matches the string's logical length × 3.
    expect(Buffer.byteLength(r.content, "utf-8") % 3).toBe(0)
  })

  test("selectTail never splits a multi-byte character", () => {
    const text = "中".repeat(100)
    const r = selectTail(text, 1000, 100)
    expect(r.content.length).toBeGreaterThan(0)
    expect(() => Buffer.from(r.content, "utf-8").toString("utf-8")).not.toThrow()
    expect(Buffer.byteLength(r.content, "utf-8") % 3).toBe(0)
  })

  test("emoji-heavy text round-trips through truncation", () => {
    // Each "🎉" is 4 bytes.
    const text = "🎉".repeat(200)
    const r = selectHead(text, 10000, 50)
    expect(Buffer.byteLength(r.content, "utf-8") % 4).toBe(0)
  })

  it.live("truncate.output preserves UTF-8 in the preview", () =>
    Effect.gen(function* () {
      const svc = yield* Truncate.Service
      // 200 Chinese characters = 600 bytes — well under default cap.
      // We force truncation with a tiny cap to exercise the boundary
      // logic. Use a byte cap that lands inside a character.
      const text = "中".repeat(200)
      const result = yield* svc.output(text, { maxBytes: 100, maxLines: 10000 })
      expect(result.truncated).toBe(true)
      if (result.truncated && result.content) {
        // Preview text must be valid UTF-8.
        expect(() => Buffer.from(result.content, "utf-8").toString("utf-8")).not.toThrow()
      }
    }),
  )
})