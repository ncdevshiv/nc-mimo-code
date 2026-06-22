import { describe, test, expect } from "bun:test"
import z from "zod"
import { recoverActorArgs } from "../../src/tool/actor"
import { optionalKeys } from "../../src/util/zod"

// Audit §6.4.4: the bare-shape recover path's carry-over
// whitelist is now derived from the run/spawn Zod schemas
// (`optionalKeys` from `util/zod.ts`). This test pins the
// *contract* — the union of optional fields minus the three
// required fields — by building a fixture schema that mirrors
// the production run/spawn shape and exercising recoverActorArgs
// through it.
//
// If a future runSchema/spawnSchema adds a new optional, the
// fixture here is updated and the test confirms the recover
// path picks it up automatically. The hardcoded list that used
// to live inside recoverActorArgs (model/task_id/actor_id) is
// gone — the schema is the source of truth.
const runSchema = z.strictObject({
  action: z.literal("run"),
  subagent_type: z.string(),
  description: z.string(),
  prompt: z.string(),
  model: z.string().optional(),
  actor_id: z.string().optional(),
  task_id: z.string().optional(),
  output_schema: z.record(z.string(), z.any()).optional(),
})
const spawnSchema = z.strictObject({
  action: z.literal("spawn"),
  subagent_type: z.string(),
  description: z.string(),
  prompt: z.string(),
  model: z.string().optional(),
  actor_id: z.string().optional(),
  task_id: z.string().optional(),
  output_schema: z.record(z.string(), z.any()).optional(),
})

// Same construction as the production code at actor.ts:434-441.
const buildWhitelist = () => {
  const s = new Set<string>([...optionalKeys(runSchema), ...optionalKeys(spawnSchema)])
  s.delete("subagent_type")
  s.delete("description")
  s.delete("prompt")
  return s
}

describe("recoverActorArgs", () => {
  test("bare Task-prior fields → run operation", () => {
    expect(
      recoverActorArgs({ subagent_type: "explore", description: "d", prompt: "p" }, buildWhitelist()),
    ).toEqual({
      operation: { action: "run", subagent_type: "explore", description: "d", prompt: "p" },
    })
  })

  test("explicit action:spawn is honored", () => {
    expect(
      recoverActorArgs(
        { action: "spawn", subagent_type: "general", description: "d", prompt: "p" },
        buildWhitelist(),
      ),
    ).toEqual({ operation: { action: "spawn", subagent_type: "general", description: "d", prompt: "p" } })
  })

  test("background:true infers spawn", () => {
    const r = recoverActorArgs(
      { subagent_type: "general", description: "d", prompt: "p", background: true },
      buildWhitelist(),
    ) as any
    expect(r.operation.action).toBe("spawn")
  })

  test("async:true infers spawn", () => {
    const r = recoverActorArgs(
      { subagent_type: "general", description: "d", prompt: "p", async: true },
      buildWhitelist(),
    ) as any
    expect(r.operation.action).toBe("spawn")
  })

  test("optional model/task_id/actor_id carried; junk dropped", () => {
    expect(
      recoverActorArgs(
        { subagent_type: "explore", description: "d", prompt: "p", model: "lite", task_id: "T4", junk: 1 },
        buildWhitelist(),
      ),
    ).toEqual({
      operation: {
        action: "run",
        subagent_type: "explore",
        description: "d",
        prompt: "p",
        model: "lite",
        task_id: "T4",
      },
    })
  })

  test("carries future optionals automatically (the audit §6.4.4 contract)", () => {
    // output_schema is in the runSchema's optionals but was NOT
    // in the old hardcoded whitelist. The new schema-driven
    // whitelist picks it up.
    expect(
      recoverActorArgs(
        { subagent_type: "explore", description: "d", prompt: "p", output_schema: { type: "object" } },
        buildWhitelist(),
      ),
    ).toEqual({
      operation: {
        action: "run",
        subagent_type: "explore",
        description: "d",
        prompt: "p",
        output_schema: { type: "object" },
      },
    })
  })

  test("stringified operation envelope → parsed nested object", () => {
    expect(
      recoverActorArgs(
        { operation: '{"action":"run","subagent_type":"explore","description":"d","prompt":"p"}' },
        buildWhitelist(),
      ),
    ).toEqual({ operation: { action: "run", subagent_type: "explore", description: "d", prompt: "p" } })
  })

  test("already-nested operation → passthrough", () => {
    const op = { operation: { action: "run", subagent_type: "explore", description: "d", prompt: "p" } } as const
    expect(recoverActorArgs(op, buildWhitelist())).toEqual(op)
  })

  test("garbage / incomplete / non-object → undefined", () => {
    expect(recoverActorArgs({ foo: 1 }, buildWhitelist())).toBeUndefined()
    expect(recoverActorArgs({ description: "d" }, buildWhitelist())).toBeUndefined() // missing prompt+subagent_type
    expect(recoverActorArgs(null, buildWhitelist())).toBeUndefined()
    expect(recoverActorArgs("nope", buildWhitelist())).toBeUndefined()
  })

  test("array operation (object/string) is not mistaken for an envelope → undefined", () => {
    expect(recoverActorArgs({ operation: [1, 2, 3] }, buildWhitelist())).toBeUndefined()
    expect(recoverActorArgs({ operation: "[1,2,3]" }, buildWhitelist())).toBeUndefined()
  })
})
