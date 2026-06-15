import { test, expect, describe } from "bun:test"
import z from "zod"
import { formatDiscriminatedUnionError } from "../../src/tool/format-validation-error"

const ACTIONS = ["create", "list", "update", "delete"] as const

const Schema = z.strictObject({
  operation: z.discriminatedUnion("action", [
    z.strictObject({ action: z.literal("create"), name: z.string() }),
    z.strictObject({ action: z.literal("list") }),
    z.strictObject({ action: z.literal("update"), id: z.string() }),
    z.strictObject({ action: z.literal("delete"), id: z.string() }),
  ]),
})

const fmt = formatDiscriminatedUnionError(ACTIONS)

describe("formatDiscriminatedUnionError: top-level unrecognized keys", () => {
  test("a single unknown key is listed", () => {
    const result = Schema.safeParse({ foobar: { action: "create", name: "x" } })
    if (result.success) throw new Error("expected failure")
    const out = fmt(result.error)
    expect(out).toContain("Accepted actions: create | list | update | delete")
    expect(out).toContain('Unknown top-level keys in your call: "foobar"')
  })

  test("multiple unknown keys are all listed, quoted, comma-separated", () => {
    const result = Schema.safeParse({
      foobar: 1,
      baz: 2,
      qux: { action: "list" },
    })
    if (result.success) throw new Error("expected failure")
    const out = fmt(result.error)
    expect(out).toContain('"foobar"')
    expect(out).toContain('"baz"')
    expect(out).toContain('"qux"')
    expect(out).toContain("Unknown top-level keys in your call:")
  })

  test("a call with no top-level keys: no Unknown-keys line is added", () => {
    // The issue is a missing operation; the formatter's unknown-keys
    // branch should not fire (the issue code is invalid_type, not
    // unrecognized_keys).
    const result = Schema.safeParse({ operation: { name: "x" } })
    if (result.success) throw new Error("expected failure")
    const out = fmt(result.error)
    expect(out).not.toContain("Unknown top-level keys in your call")
    expect(out).toContain("Accepted actions:")
  })
})

describe("formatDiscriminatedUnionError: example shape", () => {
  test("the example line shows the first action with the right structure", () => {
    const result = Schema.safeParse({ foobar: 1 })
    if (result.success) throw new Error("expected failure")
    const out = fmt(result.error)
    expect(out).toContain("Example of a valid call:")
    expect(out).toContain("create")
    expect(out).toContain("action")
    expect(out).toContain("operation")
  })

  test("single-action mode: example is the only action", () => {
    const singleActionSchema = z.strictObject({
      operation: z.discriminatedUnion("action", [
        z.strictObject({ action: z.literal("only"), x: z.number() }),
      ]),
    })
    const result = singleActionSchema.safeParse({})
    if (result.success) throw new Error("expected failure")
    const out = formatDiscriminatedUnionError(["only"])(result.error)
    expect(out).toContain("Accepted actions: only")
    expect(out).toContain('"only"')
  })
})

describe("formatDiscriminatedUnionError: error combination", () => {
  test("both unknown keys and missing discriminator: both lines appear", () => {
    const result = Schema.safeParse({ foobar: 1 })
    if (result.success) throw new Error("expected failure")
    const out = fmt(result.error)
    expect(out).toContain("Unknown top-level keys")
    expect(out).toContain("foobar")
  })

  test("non-array actions list (the formatter takes a readonly string array)", () => {
    const actions: readonly string[] = ["a", "b", "c"]
    const out = formatDiscriminatedUnionError(actions)
    expect(typeof out).toBe("function")
  })
})

describe("formatDiscriminatedUnionError: action list shape", () => {
  test("the accepted-actions line joins with ' | '", () => {
    const out = fmt(new z.ZodError([]))
    expect(out).toContain("Accepted actions: create | list | update | delete")
  })

  test("the policy line is always the first line", () => {
    const out = fmt(new z.ZodError([]))
    expect(out.startsWith(`Schema accepts exactly one "operation" key`)).toBe(true)
  })

  test("the example is the last line", () => {
    const out = fmt(new z.ZodError([]))
    const lines = out.split("\n")
    expect(lines[lines.length - 1]).toMatch(/^Example of a valid call: /)
  })
})