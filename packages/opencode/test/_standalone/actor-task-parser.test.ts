// Standalone integration test for the actor shell-parser after the
// tool-grammar refactor. Imports the pure exported parser functions
// from actor.ts and task.ts and runs them with the Effect runtime
// bun provides. Skips the opencode workspace deps; only the parser
// pure functions are exercised.
//
// Run: `bun test test/_standalone/actor-task-parser.test.ts`
// (from packages/opencode, with bunfig.toml preload temporarily
//  removed — see test/_standalone/README)

import { test, expect, describe } from "bun:test"
import { Effect } from "effect"
import { parseActorScript, recoverActorArgs } from "../../src/tool/actor"
import { parseTaskScript } from "../../src/tool/task"

const runParseActor = (script: string) => Effect.runPromise(parseActorScript(script))
const runParseTask = (script: string) => Effect.runPromise(parseTaskScript(script) as any)

describe("parseActorScript (refactored to use tool-grammar)", () => {
  test("actor run: minimal three positional args", async () => {
    const out = await runParseActor(`actor run explore "fix the bug" "look at file X"`)
    expect(out).toEqual([
      {
        operation: {
          action: "run",
          subagent_type: "explore",
          description: "fix the bug",
          prompt: "look at file X",
        },
      },
    ])
  })

  test("actor run: with --model, --task, --timeout, --context", async () => {
    const out = await runParseActor(
      `actor run general "desc" "prompt" --model ultra --task T1 --timeout 30000 --context state`,
    )
    expect(out[0]).toMatchObject({
      operation: {
        action: "run",
        subagent_type: "general",
        description: "desc",
        prompt: "prompt",
        model: "ultra",
        task_id: "T1",
        timeout_ms: 30000,
        context: "state",
      },
    })
  })

  test("actor run: --output-schema parses JSON", async () => {
    const out = await runParseActor(
      `actor run general "d" "p" --output-schema '{"type":"object","properties":{"x":{"type":"string"}}}'`,
    )
    expect((out[0] as any).operation.output_schema).toEqual({
      type: "object",
      properties: { x: { type: "string" } },
    })
  })

  test("actor spawn: separate verb, no timeout, supports --command and --context", async () => {
    const out = await runParseActor(`actor spawn general "d" "p" --context full --command foo`)
    expect((out[0] as any).operation).toMatchObject({
      action: "spawn",
      context: "full",
      command: "foo",
    })
  })

  test("actor status: single actor_id", async () => {
    const out = await runParseActor(`actor status actor-1`)
    expect(out[0]).toEqual({ operation: { action: "status", actor_id: "actor-1" } })
  })

  test("actor wait: optional --timeout", async () => {
    const withTo = await runParseActor(`actor wait actor-1 --timeout 5000`)
    expect((withTo[0] as any).operation).toEqual({ action: "wait", actor_id: "actor-1", timeout_ms: 5000 })
    const without = await runParseActor(`actor wait actor-1`)
    expect((without[0] as any).operation).toEqual({ action: "wait", actor_id: "actor-1" })
  })

  test("actor cancel: single actor_id", async () => {
    const out = await runParseActor(`actor cancel actor-1`)
    expect(out[0]).toEqual({ operation: { action: "cancel", actor_id: "actor-1" } })
  })

  test("actor send: positional + --session", async () => {
    const out = await runParseActor(`actor send actor-1 "hello there" --session sid`)
    expect((out[0] as any).operation).toEqual({
      action: "send",
      to_actor_id: "actor-1",
      content: "hello there",
      to_session_id: "sid",
    })
  })

  test("unknown verb fails with suggestion", async () => {
    await expect(runParseActor(`actor rune general "d" "p"`)).rejects.toMatchObject({
      kind: "unknown-verb",
    })
  })

  test("arity mismatch produces a clear error", async () => {
    await expect(runParseActor(`actor run general "only two args"`)).rejects.toMatchObject({
      kind: "arity",
    })
  })

  test("value flag without value produces flag error (not silent drop)", async () => {
    // Previously actor's extractor returned Effect.fail for the dangling flag
    // (not silently dropping). The shared extractFlags preserves this contract.
    await expect(runParseActor(`actor run general "d" "p" --task`)).rejects.toMatchObject({
      kind: "flag",
    })
  })

  test("multiple statements in one script", async () => {
    const out = await runParseActor(
      `actor run general "d1" "p1"\nactor wait actor-1 --timeout 1000\nactor cancel actor-1`,
    )
    expect(out).toHaveLength(3)
    expect((out[0] as any).operation.action).toBe("run")
    expect((out[1] as any).operation.action).toBe("wait")
    expect((out[2] as any).operation.action).toBe("cancel")
  })
})

describe("recoverActorArgs (untouched by refactor; smoke test)", () => {
  test("recovers the bare {subagent_type, description, prompt} JSON shape", () => {
    const out = recoverActorArgs({ subagent_type: "general", description: "d", prompt: "p" })
    expect(out).toEqual({ operation: { action: "run", subagent_type: "general", description: "d", prompt: "p" } })
  })

  test("recovers {operation: {...}} nested shape", () => {
    const out = recoverActorArgs({ operation: { action: "spawn", subagent_type: "g", description: "d", prompt: "p" } })
    expect(out).toEqual({ operation: { action: "spawn", subagent_type: "g", description: "d", prompt: "p" } })
  })

  test("returns undefined for unrecognized shape", () => {
    expect(recoverActorArgs({ random: "object" })).toBeUndefined()
    expect(recoverActorArgs(null)).toBeUndefined()
    expect(recoverActorArgs(42)).toBeUndefined()
  })
})

describe("parseTaskScript (refactored to use tool-grammar)", () => {
  test("task create: minimal summary", async () => {
    const out = await runParseTask(`task create "do the thing"`)
    expect(out[0]).toEqual({ operation: { action: "create", summary: "do the thing" } })
  })

  test("task create: with --parent and --session", async () => {
    const out = await runParseTask(`task create "sub task" --parent T1 --session sid`)
    expect(out[0]).toEqual({
      operation: { action: "create", summary: "sub task", parent_id: "T1", session_id: "sid" },
    })
  })

  test("task list: with --include-terminal and --include-archived", async () => {
    const out = await runParseTask(`task list --include-terminal --include-archived`)
    expect(out[0]).toEqual({
      operation: { action: "list", include_terminal: true, include_archived: true },
    })
  })

  test("task list: with status positional", async () => {
    const out = await runParseTask(`task list open`)
    expect(out[0]).toEqual({ operation: { action: "list", status: "open" } })
  })

  test("task get: single id", async () => {
    const out = await runParseTask(`task get T1.2`)
    expect(out[0]).toEqual({ operation: { action: "get", id: "T1.2" } })
  })

  test("task start: with --reason", async () => {
    const out = await runParseTask(`task start T1 --reason "picking up"`)
    expect(out[0]).toEqual({
      operation: { action: "start", id: "T1", event_summary: "picking up" },
    })
  })

  test("task block / unblock / done / abandon take <id> <reason>", async () => {
    const block = await runParseTask(`task block T1 needs-deps`)
    expect(block[0]).toEqual({ operation: { action: "block", id: "T1", event_summary: "needs-deps" } })
    const unblock = await runParseTask(`task unblock T1 deps-ready`)
    expect(unblock[0]).toEqual({ operation: { action: "unblock", id: "T1", event_summary: "deps-ready" } })
    const done = await runParseTask(`task done T1 all-set`)
    expect(done[0]).toEqual({ operation: { action: "done", id: "T1", event_summary: "all-set" } })
    const abandon = await runParseTask(`task abandon T1 not-needed`)
    expect(abandon[0]).toEqual({ operation: { action: "abandon", id: "T1", event_summary: "not-needed" } })
  })

  test("task rename: <id> <new summary>", async () => {
    const out = await runParseTask(`task rename T1 "better title"`)
    expect(out[0]).toEqual({ operation: { action: "rename", id: "T1", summary: "better title" } })
  })

  test("unknown verb fails with suggestion", async () => {
    await expect(runParseTask(`task creat foo`)).rejects.toMatchObject({ kind: "unknown-verb" })
  })

  test("arity mismatch fails", async () => {
    await expect(runParseTask(`task get`)).rejects.toMatchObject({ kind: "arity" })
  })

  test("dangling value flag fails (not silent drop)", async () => {
    await expect(runParseTask(`task create "x" --session`)).rejects.toMatchObject({ kind: "flag" })
  })
})
