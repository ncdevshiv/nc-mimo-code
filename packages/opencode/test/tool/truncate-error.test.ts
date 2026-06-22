import { test, expect, describe } from "bun:test"
import { truncateError, MAX_VALIDATION_ERROR_CHARS } from "../../src/tool/truncate-error"

describe("truncateError", () => {
  test("returns short messages verbatim", () => {
    expect(truncateError(new Error("hi"))).toBe("hi")
    expect(truncateError("string error")).toBe("string error")
  })

  test("returns the exact 2KB message verbatim", () => {
    const msg = "x".repeat(MAX_VALIDATION_ERROR_CHARS)
    expect(truncateError(new Error(msg))).toBe(msg)
  })

  test("truncates longer messages and notes how much was cut", () => {
    const big = "a".repeat(MAX_VALIDATION_ERROR_CHARS + 5000)
    const out = truncateError(new Error(big))
    expect(out.startsWith("a".repeat(MAX_VALIDATION_ERROR_CHARS))).toBe(true)
    expect(out).toContain("... (truncated 5000 chars)")
    // The returned string itself should be larger than the cap (cap + suffix).
    expect(out.length).toBeGreaterThan(MAX_VALIDATION_ERROR_CHARS)
    expect(out.length).toBeLessThan(MAX_VALIDATION_ERROR_CHARS + 50)
  })

  test("non-Error values are coerced via String()", () => {
    expect(truncateError(42)).toBe("42")
    expect(truncateError({ code: "x" })).toBe("[object Object]")
    expect(truncateError(null)).toBe("null")
    expect(truncateError(undefined)).toBe("undefined")
  })

  test("custom max honored", () => {
    expect(truncateError(new Error("hello world"), 5)).toBe("hello... (truncated 6 chars)")
  })

  test("empty error message is preserved (length 0 < cap)", () => {
    expect(truncateError(new Error(""))).toBe("")
  })
})
