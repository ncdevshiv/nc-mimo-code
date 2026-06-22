import { test, expect, describe } from "bun:test"
import {
  buildRepairPrompt,
  buildRepairSystemPrompt,
  parseRepairResult,
  type RepairRequest,
} from "../../src/monitor/tool-failure-repair"

describe("ToolFailureRepair: buildRepairSystemPrompt", () => {
  test("the system prompt is non-empty and contains the policy", () => {
    const prompt = buildRepairSystemPrompt()
    expect(prompt.length).toBeGreaterThan(200)
    expect(prompt).toContain("You are repairing a malformed tool call")
    expect(prompt).toContain("Output format (strict, exactly one)")
    expect(prompt).toContain('{"input":')
    expect(prompt).toContain('{"unfixable":')
    expect(prompt).toContain("NEVER invent a value")
  })

  test("the system prompt mentions the strict output format constraint", () => {
    const prompt = buildRepairSystemPrompt()
    expect(prompt).toContain("Do not add any explanation, code fence, or markdown")
  })
})

describe("ToolFailureRepair: buildRepairPrompt", () => {
  const baseReq: RepairRequest = {
    tool: "edit",
    input: { filePath: "C:/foo.txt", oldString: "hello", newString: "hellp" },
    error: "oldString and newString must differ",
    schema: {
      type: "object",
      properties: {
        filePath: { type: "string" },
        oldString: { type: "string" },
        newString: { type: "string" },
      },
      required: ["filePath", "oldString", "newString"],
    },
  }

  test("includes the tool name in a backticked code span", () => {
    const out = buildRepairPrompt(baseReq)
    expect(out).toContain("Tool: `edit`")
  })

  test("includes the original call as JSON", () => {
    const out = buildRepairPrompt(baseReq)
    expect(out).toContain('"filePath": "C:/foo.txt"')
    expect(out).toContain('"oldString": "hello"')
    expect(out).toContain('"newString": "hellp"')
  })

  test("includes the validation error", () => {
    const out = buildRepairPrompt(baseReq)
    expect(out).toContain("oldString and newString must differ")
  })

  test("includes the JSON schema", () => {
    const out = buildRepairPrompt(baseReq)
    expect(out).toContain('"type": "object"')
    expect(out).toContain('"required": [')
  })

  test("ends with a call to action", () => {
    const out = buildRepairPrompt(baseReq)
    expect(out).toMatch(/Return the corrected `input` object/)
  })

  test("handles input with special characters (paths with backslashes)", () => {
    const req: RepairRequest = {
      ...baseReq,
      input: { filePath: "C:\\Users\\foo.txt", oldString: "x", newString: "y" },
    }
    const out = buildRepairPrompt(req)
    expect(out).toContain("C:\\\\Users\\\\foo.txt")
  })

  test("handles input with unicode characters", () => {
    const req: RepairRequest = {
      ...baseReq,
      input: { filePath: "/tmp/测试.txt", oldString: "中文", newString: "日本語" },
    }
    const out = buildRepairPrompt(req)
    expect(out).toContain("测试.txt")
    expect(out).toContain("中文")
    expect(out).toContain("日本語")
  })
})

describe("ToolFailureRepair: parseRepairResult", () => {
  test("plain repaired JSON: parses to kind=repaired", () => {
    const output = JSON.stringify({ input: { filePath: "x.txt", content: "y" } })
    const result = parseRepairResult(output)
    expect(result).toEqual({ kind: "repaired", input: { filePath: "x.txt", content: "y" } })
  })

  test("unfixable JSON: parses to kind=unfixable with the reason", () => {
    const output = JSON.stringify({ unfixable: "missing required field 'command' and no context" })
    const result = parseRepairResult(output)
    expect(result).toEqual({ kind: "unfixable", reason: "missing required field 'command' and no context" })
  })

  test("output wrapped in a code fence (json): still parses", () => {
    const output = '```json\n{"input": {"a": 1}}\n```'
    const result = parseRepairResult(output)
    expect(result).toEqual({ kind: "repaired", input: { a: 1 } })
  })

  test("output wrapped in a bare code fence (no language tag): still parses", () => {
    const output = "```\n{\"input\": {\"a\": 1}}\n```"
    const result = parseRepairResult(output)
    expect(result).toEqual({ kind: "repaired", input: { a: 1 } })
  })

  test("output with leading/trailing whitespace: still parses", () => {
    const output = '   \n\n  {"input": {"a": 1}}  \n\n'
    const result = parseRepairResult(output)
    expect(result).toEqual({ kind: "repaired", input: { a: 1 } })
  })

  test("empty string: returns null", () => {
    expect(parseRepairResult("")).toBeNull()
  })

  test("non-JSON string: returns null", () => {
    expect(parseRepairResult("I don't know how to fix this")).toBeNull()
  })

  test("valid JSON but wrong shape (both input and unfixable): returns null (strict)", () => {
    const output = JSON.stringify({ input: { a: 1 }, unfixable: "x" })
    expect(parseRepairResult(output)).toBeNull()
  })

  test("valid JSON but extra fields: returns null (strict schema)", () => {
    const output = JSON.stringify({ input: { a: 1 }, extra: "no" })
    expect(parseRepairResult(output)).toBeNull()
  })

  test("valid JSON but neither input nor unfixable: returns null", () => {
    const output = JSON.stringify({ fixed: true })
    expect(parseRepairResult(output)).toBeNull()
  })

  test("unfixable with empty string: returns null (z.string().min(1))", () => {
    const output = JSON.stringify({ unfixable: "" })
    expect(parseRepairResult(output)).toBeNull()
  })

  test("unfixable with non-string reason: returns null", () => {
    const output = JSON.stringify({ unfixable: 42 })
    expect(parseRepairResult(output)).toBeNull()
  })

  test("input is null: still parses (z.unknown() allows null)", () => {
    const output = JSON.stringify({ input: null })
    const result = parseRepairResult(output)
    expect(result).toEqual({ kind: "repaired", input: null })
  })

  test("input is a complex object: parses with full fidelity", () => {
    const complex = {
      filePath: "C:/Users/foo.txt",
      oldString: "line1\nline2",
      newString: "line1\nline2 changed",
      replaceAll: false,
    }
    const output = JSON.stringify({ input: complex })
    const result = parseRepairResult(output)
    expect(result).toEqual({ kind: "repaired", input: complex })
  })

  test("non-string input to parseRepairResult: returns null (defensive)", () => {
    expect(parseRepairResult(null as any)).toBeNull()
    expect(parseRepairResult(undefined as any)).toBeNull()
    expect(parseRepairResult(42 as any)).toBeNull()
  })
})

describe("ToolFailureRepair: end-to-end round trip (prompt -> response -> parse)", () => {
  test("a 'repaired' response from the model is recovered from a code-fenced output", () => {
    const req: RepairRequest = {
      tool: "edit",
      input: { filePath: "x.txt", oldString: "a", newString: "b" },
      error: "oldString and newString must differ",
      schema: { type: "object", properties: { filePath: { type: "string" }, oldString: { type: "string" }, newString: { type: "string" } } },
    }
    const prompt = buildRepairPrompt(req)
    expect(prompt).toContain("Tool: `edit`")

    const modelOutput = '```json\n{"input": {"filePath": "x.txt", "oldString": "a", "newString": "B"}}\n```'
    const result = parseRepairResult(modelOutput)
    expect(result?.kind).toBe("repaired")
    if (result?.kind === "repaired") {
      expect(result.input).toEqual({ filePath: "x.txt", oldString: "a", newString: "B" })
    }
  })

  test("an 'unfixable' response is preserved with the reason", () => {
    const req: RepairRequest = {
      tool: "edit",
      input: {},
      error: "missing required field 'filePath'",
      schema: { type: "object", required: ["filePath"] },
    }
    const prompt = buildRepairPrompt(req)
    expect(prompt).toContain("missing required field 'filePath'")

    const modelOutput = JSON.stringify({ unfixable: "no filePath was given and no context to infer from" })
    const result = parseRepairResult(modelOutput)
    expect(result?.kind).toBe("unfixable")
    if (result?.kind === "unfixable") {
      expect(result.reason).toContain("no filePath was given")
    }
  })
})
