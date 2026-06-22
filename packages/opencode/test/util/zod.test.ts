import { test, expect, describe } from "bun:test"
import z from "zod"
import { optionalKeys } from "../../src/util/zod"

// Audit §6.4.4: the recoverActorArgs whitelist is now derived
// from the Zod schema via `optionalKeys`. These tests pin the
// helper's contract: it must detect `.optional()` (and friends
// like `.default()`, `.nullable()`) at any depth, and skip
// required fields.
describe("optionalKeys", () => {
  test("returns the set of optional fields", () => {
    const schema = z.strictObject({
      required_field: z.string(),
      optional_field: z.string().optional(),
    })
    const result = optionalKeys(schema)
    expect(result.has("optional_field")).toBe(true)
    expect(result.has("required_field")).toBe(false)
  })

  test("detects .default() as optional (default makes the field optional)", () => {
    const schema = z.strictObject({
      has_default: z.string().default("hello"),
    })
    const result = optionalKeys(schema)
    expect(result.has("has_default")).toBe(true)
  })

  test("detects .nullable() as optional", () => {
    const schema = z.strictObject({
      maybe_null: z.string().nullable(),
    })
    const result = optionalKeys(schema)
    expect(result.has("maybe_null")).toBe(true)
  })

  test("deep-unwrap: chains .min(1).optional().default()", () => {
    const schema = z.strictObject({
      deep: z.string().min(1).optional().default("x"),
    })
    const result = optionalKeys(schema)
    expect(result.has("deep")).toBe(true)
  })

  test("returns an empty set for an all-required schema", () => {
    const schema = z.strictObject({
      a: z.string(),
      b: z.number(),
    })
    expect(optionalKeys(schema).size).toBe(0)
  })

  test("returns a fresh Set on each call (callers can mutate)", () => {
    const schema = z.strictObject({ x: z.string().optional() })
    const a = optionalKeys(schema)
    a.add("y")
    const b = optionalKeys(schema)
    expect(b.has("y")).toBe(false)
  })

  test("handles a schema with mixed required + optional + default + nullable", () => {
    const schema = z.strictObject({
      req: z.string(),
      opt: z.string().optional(),
      defaulted: z.number().default(0),
      nullish: z.boolean().nullable(),
    })
    const result = optionalKeys(schema)
    expect(result.has("req")).toBe(false)
    expect(result.has("opt")).toBe(true)
    expect(result.has("defaulted")).toBe(true)
    expect(result.has("nullish")).toBe(true)
  })
})
