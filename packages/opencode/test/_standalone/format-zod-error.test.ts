import { test, expect, describe } from "bun:test"
import z from "zod"
import { formatZodError } from "../../src/tool/format-validation-error"

const makeError = (issues: z.ZodIssue[]): z.ZodError =>
  ({ name: "ZodError", issues } as z.ZodError)

describe("formatZodError", () => {
  test("invalid_type: shows expected vs received, with hint", () => {
    const schema = z.object({
      count: z.number(),
      name: z.string(),
    })
    const result = schema.safeParse({ count: undefined, name: undefined })
    if (result.success) throw new Error("expected failure")
    const fmt = formatZodError({
      count: { type: "number", required: true },
      name: { type: "string", required: true },
    })
    const out = fmt(result.error)
    expect(out).toContain("Your call did not match the expected schema")
    expect(out).toContain("count: got undefined, expected number (expected number)")
    expect(out).toContain("name: got undefined, expected string (expected string)")
  })

  test("unrecognized_keys: lists them", () => {
    // z.strictObject fires this; z.object does not
    const schema = z.strictObject({ name: z.string() })
    const result = schema.safeParse({ name: "ok", extra: 1, alsoExtra: 2 })
    if (result.success) throw new Error("expected failure")
    const fmt = formatZodError({
      name: { type: "string", required: true },
    })
    const out = fmt(result.error)
    expect(out).toContain('unknown key(s): "extra", "alsoExtra"')
  })

  test("too_small: shows bound with inclusive flag", () => {
    const schema = z.object({ n: z.number().min(0) })
    const result = schema.safeParse({ n: -1 })
    if (result.success) throw new Error("expected failure")
    const out = formatZodError({ n: { type: "number" } })(result.error)
    expect(out).toContain("n: must be >= 0 (number)")
  })

  test("too_big: shows bound with inclusive flag", () => {
    const schema = z.object({ timeout: z.number().max(120) })
    const result = schema.safeParse({ timeout: 999 })
    if (result.success) throw new Error("expected failure")
    const out = formatZodError({ timeout: { type: "number" } })(result.error)
    expect(out).toContain("timeout: must be <= 120 (number)")
  })

  test("invalid enum value (zod 4: invalid_value): shows received and allowed options", () => {
    const schema = z.object({ format: z.enum(["text", "markdown", "html"]) })
    const result = schema.safeParse({ format: "xml" })
    if (result.success) throw new Error("expected failure")
    const out = formatZodError({ format: { type: "enum", values: ["text", "markdown", "html"] } })(result.error)
    expect(out).toContain("format: Invalid option: expected one of")
    expect(out).toContain("text")
    expect(out).toContain("markdown")
    expect(out).toContain("html")
  })

  test("invalid_string with uuid validation: emits Zod's default message", () => {
    const schema = z.object({ id: z.string().uuid() })
    const result = schema.safeParse({ id: "not-a-uuid" })
    if (result.success) throw new Error("expected failure")
    const out = formatZodError({ id: { type: "uuid" } })(result.error)
    expect(out).toContain("id: Invalid UUID")
    expect(out).toContain("(expected uuid)")
  })

  test("missing required field: shows path at root", () => {
    const schema = z.object({ a: z.string(), b: z.string() })
    const result = schema.safeParse({ a: "ok" })
    if (result.success) throw new Error("expected failure")
    const out = formatZodError({
      a: { type: "string", required: true },
      b: { type: "string", required: true },
    })(result.error)
    expect(out).toContain('Required keys: "a", "b"')
  })

  test("no hints: still works (less informative)", () => {
    const schema = z.object({ x: z.number() })
    const result = schema.safeParse({ x: "wrong" })
    if (result.success) throw new Error("expected failure")
    const out = formatZodError()(result.error)
    expect(out).toContain("Your call did not match the expected schema")
    expect(out).toContain("x: got undefined, expected number")
    // no type hint because no hints were given
    expect(out).not.toContain("(expected number)")
  })

  test("multiple issues: all listed", () => {
    const schema = z.object({
      command: z.string(),
      timeout: z.number().min(0),
      description: z.string(),
    })
    const result = schema.safeParse({ command: 123, timeout: -1 })
    if (result.success) throw new Error("expected failure")
    const out = formatZodError({
      command: { type: "string" },
      timeout: { type: "number" },
      description: { type: "string" },
    })(result.error)
    expect(out).toContain("command:")
    expect(out).toContain("timeout:")
    expect(out).toContain("description:")
  })

  test("custom code: shows the issue message", () => {
    // Schema with refine that adds a custom path
    const schema = z.object({ a: z.string(), b: z.string() }).refine((v) => v.a !== v.b, {
      message: "a and b must differ",
      path: ["b"],
    })
    const result = schema.safeParse({ a: "x", b: "x" })
    if (result.success) throw new Error("expected failure")
    const out = formatZodError()(result.error)
    expect(out).toContain("b: a and b must differ")
  })
})
