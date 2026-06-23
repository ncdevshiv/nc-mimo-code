// Verify `Token.estimate` honors the optional divisor parameter.
// The default (4) matches the previous behavior; passing a smaller
// divisor returns more tokens (more aggressive compaction).

import { describe, test, expect } from "bun:test"
import { Token } from "../../src/util"

describe("Token.estimate divisor", () => {
  test("default divisor is 4", () => {
    expect(Token.estimate("a".repeat(1000))).toBe(250)
  })

  test("lower divisor returns more tokens", () => {
    expect(Token.estimate("a".repeat(1000), 2)).toBe(500)
  })

  test("higher divisor returns fewer tokens", () => {
    expect(Token.estimate("a".repeat(1000), 8)).toBe(125)
  })

  test("empty string returns 0 regardless of divisor", () => {
    expect(Token.estimate("", 4)).toBe(0)
    expect(Token.estimate("", 2)).toBe(0)
  })

  test("nullish input is treated as empty", () => {
    // @ts-expect-error testing nullish handling
    expect(Token.estimate(null)).toBe(0)
    // @ts-expect-error testing undefined handling
    expect(Token.estimate(undefined)).toBe(0)
  })
})