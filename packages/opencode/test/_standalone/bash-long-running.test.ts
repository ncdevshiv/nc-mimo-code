import { test, expect, describe } from "bun:test"
import {
  buildAssessmentPrompt,
  buildAssessmentSystemPrompt,
  parseAssessment,
  type AssessmentRequest,
} from "../../src/monitor/bash-long-running"

describe("BashLongRunning: buildAssessmentSystemPrompt", () => {
  test("the system prompt is non-empty and contains the policy", () => {
    const prompt = buildAssessmentSystemPrompt()
    expect(prompt.length).toBeGreaterThan(200)
    expect(prompt).toContain("You are assessing a long-running bash command")
    expect(prompt).toContain("Decision rules")
    expect(prompt).toContain('{"continue":')
    expect(prompt).toContain('{"warn":')
    expect(prompt).toContain('{"terminate":')
    expect(prompt).toContain("Default to `continue`")
  })

  test("the system prompt warns about false-positive cost", () => {
    const prompt = buildAssessmentSystemPrompt()
    expect(prompt).toContain("False positives (warning when everything is fine) are worse")
  })
})

describe("BashLongRunning: buildAssessmentPrompt (elapsed-time formatting)", () => {
  test("sub-minute elapsed: shows as e.g. '45s'", () => {
    const out = buildAssessmentPrompt({ command: "ls", elapsedMs: 45_000 })
    expect(out).toContain("running for 45s")
  })

  test("multi-minute elapsed: shows as e.g. '5m 30s'", () => {
    const out = buildAssessmentPrompt({ command: "npm install", elapsedMs: 330_000 })
    expect(out).toContain("running for 5m 30s")
  })

  test("zero elapsed: shows as '0s'", () => {
    const out = buildAssessmentPrompt({ command: "echo hi", elapsedMs: 0 })
    expect(out).toContain("running for 0s")
  })

  test("rounds sub-second elapsed to 0s", () => {
    const out = buildAssessmentPrompt({ command: "true", elapsedMs: 250 })
    expect(out).toContain("running for 0s")
  })

  test("handles negative elapsed (defensive) without throwing", () => {
    const out = buildAssessmentPrompt({ command: "ls", elapsedMs: -1000 })
    expect(out).toContain("running for -1s")
  })
})

describe("BashLongRunning: buildAssessmentPrompt (other fields)", () => {
  test("includes the command in a bash code fence", () => {
    const out = buildAssessmentPrompt({ command: "npm install foo", elapsedMs: 5000 })
    expect(out).toContain("```bash")
    expect(out).toContain("npm install foo")
    expect(out).toContain("```")
  })

  test("includes the pid when provided", () => {
    const out = buildAssessmentPrompt({ command: "ls", pid: 12345, elapsedMs: 5000 })
    expect(out).toContain("Process id: `12345`")
  })

  test("omits the pid line when not provided", () => {
    const out = buildAssessmentPrompt({ command: "ls", elapsedMs: 5000 })
    expect(out).not.toContain("Process id")
  })

  test("includes the user's intent when provided", () => {
    const out = buildAssessmentPrompt({
      command: "npm install",
      elapsedMs: 5000,
      description: "install react for the new project",
    })
    expect(out).toContain("User's intent: install react for the new project")
  })

  test("omits the intent line when description is empty/undefined", () => {
    const out1 = buildAssessmentPrompt({ command: "ls", elapsedMs: 5000 })
    expect(out1).not.toContain("User's intent")
    const out2 = buildAssessmentPrompt({ command: "ls", elapsedMs: 5000, description: "" })
    expect(out2).not.toContain("User's intent")
  })

  test("includes the output tail when provided, with byte count", () => {
    const out = buildAssessmentPrompt({
      command: "npm install",
      elapsedMs: 5000,
      outputTail: "added 100 packages",
    })
    expect(out).toContain("Recent output (last 18 bytes)")
    expect(out).toContain("added 100 packages")
  })

  test("shows '(no output tail available)' when not provided", () => {
    const out = buildAssessmentPrompt({ command: "ls", elapsedMs: 5000 })
    expect(out).toContain("(no output tail available)")
  })

  test("ends with a call to action", () => {
    const out = buildAssessmentPrompt({ command: "ls", elapsedMs: 5000 })
    expect(out).toMatch(/Return one of: continue, warn, or terminate/)
  })
})

describe("BashLongRunning: parseAssessment", () => {
  test("plain continue JSON: parses to kind=continue", () => {
    const output = JSON.stringify({ continue: "making progress" })
    expect(parseAssessment(output)).toEqual({ kind: "continue", reason: "making progress" })
  })

  test("plain warn JSON: parses to kind=warn with reason", () => {
    const output = JSON.stringify({ warn: "no progress in 30 minutes" })
    expect(parseAssessment(output)).toEqual({ kind: "warn", reason: "no progress in 30 minutes" })
  })

  test("plain terminate JSON: parses to kind=terminate with reason", () => {
    const output = JSON.stringify({ terminate: "infinite loop with no break" })
    expect(parseAssessment(output)).toEqual({ kind: "terminate", reason: "infinite loop with no break" })
  })

  test("output wrapped in a code fence (json): still parses", () => {
    const output = '```json\n{"continue": "ok"}\n```'
    expect(parseAssessment(output)).toEqual({ kind: "continue", reason: "ok" })
  })

  test("output wrapped in a bare code fence: still parses", () => {
    const output = "```\n{\"warn\": \"hung\"}\n```"
    expect(parseAssessment(output)).toEqual({ kind: "warn", reason: "hung" })
  })

  test("output with leading/trailing whitespace: still parses", () => {
    const output = '   \n\n  {"terminate": "stuck"}  \n\n'
    expect(parseAssessment(output)).toEqual({ kind: "terminate", reason: "stuck" })
  })

  test("empty string: returns null", () => {
    expect(parseAssessment("")).toBeNull()
  })

  test("non-JSON string: returns null", () => {
    expect(parseAssessment("looks stuck to me")).toBeNull()
  })

  test("valid JSON but multiple keys: returns null (strict schema)", () => {
    expect(parseAssessment(JSON.stringify({ continue: "ok", warn: "no" }))).toBeNull()
  })

  test("valid JSON but extra fields: returns null (strict schema)", () => {
    expect(parseAssessment(JSON.stringify({ continue: "ok", extra: "no" }))).toBeNull()
  })

  test("warn with empty string: returns null (z.string().min(1))", () => {
    expect(parseAssessment(JSON.stringify({ warn: "" }))).toBeNull()
  })

  test("warn with non-string reason: returns null", () => {
    expect(parseAssessment(JSON.stringify({ warn: 42 }))).toBeNull()
  })

  test("non-string input: returns null (defensive)", () => {
    expect(parseAssessment(null as any)).toBeNull()
    expect(parseAssessment(undefined as any)).toBeNull()
    expect(parseAssessment(42 as any)).toBeNull()
  })
})

describe("BashLongRunning: end-to-end round trip", () => {
  test("a 'continue' response is recovered from a code-fenced output", () => {
    const req: AssessmentRequest = {
      command: "npm install",
      pid: 1234,
      elapsedMs: 300_000,
      description: "install dependencies",
      outputTail: "added 50 packages in 30s",
    }
    const prompt = buildAssessmentPrompt(req)
    expect(prompt).toContain("running for 5m 0s")
    expect(prompt).toContain("Process id: `1234`")
    expect(prompt).toContain("User's intent: install dependencies")
    expect(prompt).toContain("added 50 packages in 30s")

    const result = parseAssessment('```json\n{"continue": "package install is progressing normally"}\n```')
    expect(result?.kind).toBe("continue")
    if (result?.kind === "continue") {
      expect(result.reason).toBe("package install is progressing normally")
    }
  })

  test("a 'warn' response surfaces a reason to the main session", () => {
    const result = parseAssessment(JSON.stringify({ warn: "no progress in 30 minutes, possibly network-stalled" }))
    expect(result?.kind).toBe("warn")
    if (result?.kind === "warn") {
      expect(result.reason).toContain("no progress in 30 minutes")
    }
  })

  test("a 'terminate' response gives the dispatcher a reason to act", () => {
    const result = parseAssessment(JSON.stringify({ terminate: "infinite loop with no break condition" }))
    expect(result?.kind).toBe("terminate")
    if (result?.kind === "terminate") {
      expect(result.reason).toContain("infinite loop")
    }
  })
})
