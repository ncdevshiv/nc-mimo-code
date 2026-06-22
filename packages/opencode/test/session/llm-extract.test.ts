import { describe, test, expect } from "bun:test"
import { extractToolCalls } from "../../src/session/llm-extract"

describe("extractToolCalls", () => {
  test("returns an empty array for an empty response", () => {
    expect(extractToolCalls([])).toEqual([])
  })

  test("returns an empty array for non-array inputs", () => {
    expect(extractToolCalls(undefined)).toEqual([])
    expect(extractToolCalls(null)).toEqual([])
    expect(extractToolCalls({ messages: [] })).toEqual([])
    expect(extractToolCalls("not an array")).toEqual([])
    expect(extractToolCalls(42)).toEqual([])
  })

  test("returns an empty array for an array with no tool-call parts", () => {
    expect(
      extractToolCalls([
        { type: "text", text: "Hello" },
        { type: "reasoning", text: "thinking..." },
      ]),
    ).toEqual([])
  })

  test("extracts a single tool-call part", () => {
    const result = extractToolCalls([
      { type: "text", text: "I'll grep for that." },
      {
        type: "tool-call",
        toolName: "grep",
        input: { pattern: "TODO", path: "./src" },
      },
    ])
    expect(result).toHaveLength(1)
    expect(result[0]?.toolName).toBe("grep")
    expect(result[0]?.args).toEqual({ pattern: "TODO", path: "./src" })
  })

  test("extracts multiple tool-call parts in order", () => {
    const result = extractToolCalls([
      { type: "tool-call", toolName: "read", input: { filePath: "/a" } },
      { type: "text", text: "Now editing." },
      { type: "tool-call", toolName: "edit", input: { filePath: "/a", oldString: "x", newString: "y" } },
      { type: "tool-call", toolName: "bash", input: { command: "ls" } },
    ])
    expect(result).toHaveLength(3)
    expect(result.map((c) => c.toolName)).toEqual(["read", "edit", "bash"])
    expect(result[1]?.args).toEqual({ filePath: "/a", oldString: "x", newString: "y" })
    expect(result[2]?.args).toEqual({ command: "ls" })
  })

  test("skips tool-call parts with empty toolName", () => {
    const result = extractToolCalls([
      { type: "tool-call", toolName: "", input: { x: 1 } },
      { type: "tool-call", toolName: "valid", input: { x: 2 } },
    ])
    expect(result).toHaveLength(1)
    expect(result[0]?.toolName).toBe("valid")
  })

  test("skips non-object parts", () => {
    const result = extractToolCalls([
      null,
      undefined,
      "string",
      42,
      { type: "tool-call", toolName: "valid", input: { x: 1 } },
    ] as unknown[])
    expect(result).toHaveLength(1)
    expect(result[0]?.toolName).toBe("valid")
  })

  test("preserves undefined args (the SDK may parse lazily)", () => {
    const result = extractToolCalls([{ type: "tool-call", toolName: "tool" }])
    expect(result).toHaveLength(1)
    expect(result[0]?.args).toBeUndefined()
  })

  test("preserves complex nested args", () => {
    const complexArgs = {
      filePath: "/x",
      oldString: "a\nb\nc",
      newString: "a\nB\nc",
      lines: [1, 2, 3],
      meta: { author: "test", tags: ["urgent", "reviewed"] },
    }
    const result = extractToolCalls([{ type: "tool-call", toolName: "edit", input: complexArgs }])
    expect(result[0]?.args).toEqual(complexArgs)
  })
})