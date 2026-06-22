import { test, expect, describe } from "bun:test"
import z from "zod"
import { formatDiscriminatedUnionError } from "../../src/tool/tool"

const makeError = (issues: z.ZodIssue[]): z.ZodError => ({ name: "ZodError", issues } as z.ZodError)

describe("formatDiscriminatedUnionError", () => {
  const format = formatDiscriminatedUnionError(["create", "list", "done"])

  test("unrecognized_keys: lists the leaked keys", () => {
    const err = makeError([
      {
        code: "unrecognized_keys",
        keys: ['invoke name="memory"', "$text"],
        path: ["operation"],
        message: 'Unrecognized keys: "invoke name=\\"memory\\"", "$text"',
      } as z.ZodIssue,
      { code: "unrecognized_keys", keys: ["query"], path: [], message: "Unrecognized keys" } as z.ZodIssue,
    ])
    const out = format(err)
    expect(out).toContain("Accepted actions: create | list | done")
    expect(out).toContain('Unknown top-level keys in your call: "invoke name="memory"", "$text", "query".')
    expect(out).toContain(`Example of a valid call: {"operation":{"action":"create"}}`)
  })

  test("deduplicates unknown keys across multiple issues", () => {
    const err = makeError([
      { code: "unrecognized_keys", keys: ["x"], path: [], message: "" } as z.ZodIssue,
      { code: "unrecognized_keys", keys: ["x", "y"], path: [], message: "" } as z.ZodIssue,
    ])
    const out = format(err)
    expect(out.match(/"x"/g)?.length).toBe(1)
    expect(out).toContain(`"y"`)
  })

  test("missing discriminator surfaces a clear hint", () => {
    const err = makeError([
      { code: "invalid_type", expected: "object", received: "undefined", path: [], message: "Required" } as z.ZodIssue,
    ])
    const out = format(err)
    expect(out).toContain(`Your call is missing the required "operation" object.`)
    expect(out).not.toContain("Unknown top-level keys")
  })

  test("no issues at all produces a minimal recovery hint", () => {
    const out = format(makeError([]))
    expect(out).toContain("Schema accepts exactly one")
    expect(out).toContain("Accepted actions: create | list | done")
    expect(out).toContain("Example of a valid call:")
  })
})
