import { test, expect, describe } from "bun:test"
import { ConfigMonitor } from "../../src/config/monitor"

describe("ConfigMonitor: Entry schema (zod)", () => {
  test("the Entry schema accepts a minimal tool-failure-repair entry", () => {
    const result = ConfigMonitor.Entry.zod.safeParse({
      kind: "tool-failure-repair",
      event: "tool.error",
    })
    expect(result.success).toBe(true)
  })

  test("the Entry schema accepts a full bash-long-running entry", () => {
    const result = ConfigMonitor.Entry.zod.safeParse({
      kind: "bash-long-running",
      event: "bash.start",
      enabled: true,
      thresholdMs: 30_000,
      pollIntervalMs: 10_000,
    })
    expect(result.success).toBe(true)
  })

  test("the Entry schema accepts a custom entry with agent + prompt", () => {
    const result = ConfigMonitor.Entry.zod.safeParse({
      kind: "custom",
      event: "session.start",
      agentType: "general",
      promptTemplate: "Watch the new session: {{event.payload}}",
    })
    expect(result.success).toBe(true)
  })

  test("the Entry schema rejects an unknown kind", () => {
    const result = ConfigMonitor.Entry.zod.safeParse({
      kind: "not-a-monitor",
      event: "x",
    })
    expect(result.success).toBe(false)
  })

  test("the Entry schema rejects a non-positive timeoutMs", () => {
    const result = ConfigMonitor.Entry.zod.safeParse({
      kind: "tool-failure-repair",
      event: "tool.error",
      timeoutMs: 0,
    })
    expect(result.success).toBe(false)
  })

  test("the Entry schema rejects a negative thresholdMs", () => {
    const result = ConfigMonitor.Entry.zod.safeParse({
      kind: "bash-long-running",
      event: "bash.start",
      thresholdMs: -1,
    })
    expect(result.success).toBe(false)
  })

  test("the Entry schema rejects a non-integer timeoutMs", () => {
    const result = ConfigMonitor.Entry.zod.safeParse({
      kind: "tool-failure-repair",
      event: "tool.error",
      timeoutMs: 1.5,
    })
    expect(result.success).toBe(false)
  })

  test("the Entry schema rejects missing event", () => {
    const result = ConfigMonitor.Entry.zod.safeParse({
      kind: "tool-failure-repair",
    })
    expect(result.success).toBe(false)
  })

  test("the Entry schema rejects missing kind", () => {
    const result = ConfigMonitor.Entry.zod.safeParse({
      event: "tool.error",
    })
    expect(result.success).toBe(false)
  })
})

describe("ConfigMonitor: Info schema (zod)", () => {
  test("accepts an empty Info (no monitors, no default)", () => {
    const result = ConfigMonitor.Info.zod.safeParse({})
    expect(result.success).toBe(true)
  })

  test("accepts a defaultTimeoutMs alone", () => {
    const result = ConfigMonitor.Info.zod.safeParse({ defaultTimeoutMs: 60_000 })
    expect(result.success).toBe(true)
  })

  test("accepts a list of monitors", () => {
    const result = ConfigMonitor.Info.zod.safeParse({
      defaultTimeoutMs: 30_000,
      monitors: [
        { kind: "tool-failure-repair", event: "tool.error" },
        { kind: "bash-long-running", event: "bash.start", thresholdMs: 60_000 },
      ],
    })
    expect(result.success).toBe(true)
  })

  test("rejects a negative defaultTimeoutMs", () => {
    const result = ConfigMonitor.Info.zod.safeParse({ defaultTimeoutMs: -1 })
    expect(result.success).toBe(false)
  })

  test("rejects a monitor list entry that fails the Entry schema", () => {
    const result = ConfigMonitor.Info.zod.safeParse({
      monitors: [{ kind: "not-a-monitor", event: "x" }],
    })
    expect(result.success).toBe(false)
  })
})