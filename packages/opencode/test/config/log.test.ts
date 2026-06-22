import { test, expect, describe } from "bun:test"
import { ConfigLog } from "../../src/config/log"

describe("ConfigLog: Info schema (zod)", () => {
  test("accepts an empty Info (all defaults)", () => {
    const result = ConfigLog.Info.zod.safeParse({})
    expect(result.success).toBe(true)
  })

  test("accepts enabled=true", () => {
    const result = ConfigLog.Info.zod.safeParse({ enabled: true })
    expect(result.success).toBe(true)
  })

  test("accepts a positive retentionDays", () => {
    const result = ConfigLog.Info.zod.safeParse({ retentionDays: 7 })
    expect(result.success).toBe(true)
  })

  test("accepts a positive maxBytesPerFile", () => {
    const result = ConfigLog.Info.zod.safeParse({ maxBytesPerFile: 10_485_760 })
    expect(result.success).toBe(true)
  })

  test("accepts a redactKeys array", () => {
    const result = ConfigLog.Info.zod.safeParse({ redactKeys: ["authorization", "x-api-key"] })
    expect(result.success).toBe(true)
  })

  test("accepts a path override", () => {
    const result = ConfigLog.Info.zod.safeParse({ path: "/var/log/mimocode/sessions" })
    expect(result.success).toBe(true)
  })

  test("accepts includeRawChunks=true", () => {
    const result = ConfigLog.Info.zod.safeParse({ includeRawChunks: true })
    expect(result.success).toBe(true)
  })

  test("accepts includeRawChunks=false", () => {
    const result = ConfigLog.Info.zod.safeParse({ includeRawChunks: false })
    expect(result.success).toBe(true)
  })

  test("accepts a full Info with every field set", () => {
    const result = ConfigLog.Info.zod.safeParse({
      enabled: true,
      retentionDays: 14,
      maxBytesPerFile: 100_000_000,
      redactKeys: ["authorization", "cookie", "token"],
      path: "/tmp/transcripts",
    })
    expect(result.success).toBe(true)
  })

  test("rejects a non-positive retentionDays", () => {
    const result = ConfigLog.Info.zod.safeParse({ retentionDays: 0 })
    expect(result.success).toBe(false)
  })

  test("rejects a negative retentionDays", () => {
    const result = ConfigLog.Info.zod.safeParse({ retentionDays: -1 })
    expect(result.success).toBe(false)
  })

  test("rejects a non-integer retentionDays", () => {
    const result = ConfigLog.Info.zod.safeParse({ retentionDays: 1.5 })
    expect(result.success).toBe(false)
  })

  test("rejects a non-positive maxBytesPerFile", () => {
    const result = ConfigLog.Info.zod.safeParse({ maxBytesPerFile: 0 })
    expect(result.success).toBe(false)
  })

  test("rejects a non-integer maxBytesPerFile", () => {
    const result = ConfigLog.Info.zod.safeParse({ maxBytesPerFile: 1024.5 })
    expect(result.success).toBe(false)
  })
})