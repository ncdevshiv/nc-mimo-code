// Pure-helper tests for the truncation math extracted into
// `Truncate.selectHead`, `selectTail`, `selectHeadTailWithErrors`.
// These functions don't need an Effect service — they're plain
// synchronous functions — so the tests run directly under `test()`
// without the `testEffect` runner.

import { describe, test, expect } from "bun:test"
import {
  selectHead,
  selectTail,
  selectHeadTailWithErrors,
  ERROR_PATTERN,
  TAIL_SCAN_CHARS,
} from "../../src/tool/truncate"

describe("Truncate.selectHead", () => {
  test("returns the full content when under the line cap", () => {
    const text = "a\nb\nc"
    const r = selectHead(text, 10, 1024)
    expect(r.content).toBe(text)
    expect(r.removedBytes).toBe(0)
    expect(r.hitByteCap).toBe(false)
  })

  test("trims to maxLines", () => {
    const text = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
    const r = selectHead(text, 5, 1024 * 1024)
    expect(r.content.split("\n").length).toBe(5)
    expect(r.removedBytes).toBeGreaterThan(0)
  })

  test("trims to maxBytes", () => {
    const text = "a".repeat(1000)
    const r = selectHead(text, 1000, 100)
    // Stopped at byte cap, not line cap.
    expect(r.hitByteCap).toBe(true)
    expect(Buffer.byteLength(r.content, "utf-8")).toBeLessThanOrEqual(100)
  })
})

describe("Truncate.selectTail", () => {
  test("returns the full content when small enough", () => {
    const text = "alpha\nbeta\ngamma"
    const r = selectTail(text, 100, 1024)
    expect(r.cut).toBe(false)
    expect(r.content).toBe(text)
    expect(r.removedBytes).toBe(0)
  })

  test("returns the trailing lines when over the cap", () => {
    const text = Array.from({ length: 50 }, (_, i) => `line${i}`).join("\n")
    const r = selectTail(text, 5, 1024 * 1024)
    expect(r.cut).toBe(true)
    expect(r.content.split("\n").length).toBe(5)
    expect(r.content).toContain("line49")
    expect(r.content).toContain("line45")
  })

  test("respects UTF-8 boundary when a single line exceeds the byte cap", () => {
    // Single long line with multi-byte chars (Chinese). The truncation
    // must not split a multi-byte character.
    const text = "中文".repeat(500) // 1500 bytes in UTF-8
    const r = selectTail(text, 100, 200)
    // The returned bytes should form valid UTF-8 (no half-character).
    expect(r.content).toMatch(/^[\u4e00-\u9fff]*$/)
  })
})

describe("Truncate.selectHeadTailWithErrors", () => {
  test("returns applied:false when no error pattern in tail scan", () => {
    const text = Array.from({ length: 100 }, (_, i) => `clean line ${i}`).join("\n")
    const r = selectHeadTailWithErrors(text, 50, 4096, ERROR_PATTERN, TAIL_SCAN_CHARS)
    expect(r.applied).toBe(false)
  })

  test("returns applied:true with 70/30 split when tail contains errors", () => {
    const lines = Array.from({ length: 100 }, (_, i) =>
      i >= 90 ? `fatal: line ${i} failed` : `ok line ${i}`,
    )
    const text = lines.join("\n")
    const r = selectHeadTailWithErrors(text, 30, 4096, ERROR_PATTERN, TAIL_SCAN_CHARS)
    expect(r.applied).toBe(true)
    expect(r.headCount).toBeGreaterThan(0)
    expect(r.tailCount).toBeGreaterThan(0)
    expect(r.head).toContain("ok line")
    expect(r.tail).toContain("fatal")
  })

  test("70/30 allocation: head gets ~70% of budget", () => {
    const lines = Array.from({ length: 100 }, (_, i) =>
      i >= 95 ? `error: line ${i}` : `ok-${i}-${"x".repeat(20)}`,
    )
    const text = lines.join("\n")
    const maxLines = 30
    const r = selectHeadTailWithErrors(text, maxLines, 10 * 1024, ERROR_PATTERN, TAIL_SCAN_CHARS)
    expect(r.applied).toBe(true)
    // 70% allocation for head (Math.floor), 30% for tail.
    expect(r.headCount).toBeLessThanOrEqual(Math.floor(maxLines * 0.7))
    expect(r.headCount + r.tailCount).toBeLessThanOrEqual(maxLines)
  })
})