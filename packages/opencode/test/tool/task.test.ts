import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageID, SessionID } from "../../src/session/schema"
import { TaskRegistry } from "../../src/task/registry"
import { Truncate } from "../../src/tool"
import { TaskTool } from "../../src/tool/task"
import { shellWrap } from "../../src/tool/shell-wrap"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await Instance.disposeAll()
})

const it = testEffect(
  Layer.mergeAll(
    Bus.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Session.defaultLayer,
    TaskRegistry.defaultLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
  ),
)

const ctx = (sessionID: string) => ({
  sessionID: SessionID.make(sessionID),
  messageID: MessageID.ascending(),
  agent: "build",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

describe("task tool", () => {
  it.live("create with summary returns new task id", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const sess = yield* session.create({ title: "Test" })
        const info = yield* TaskTool
        const tool = yield* info.init()
        const result = yield* tool.execute({ operation: { action: "create", summary: "Implement auth" } }, ctx(sess.id))
        expect(result.output).toContain("T1")
        expect(result.metadata.id).toBe("T1")
      }),
    ),
  )

  it.live("list returns tasks for current session", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const reg = yield* TaskRegistry.Service
        const sess = yield* session.create({ title: "Test" })
        yield* reg.create({ session_id: sess.id, summary: "a" })
        yield* reg.create({ session_id: sess.id, summary: "b" })
        const info = yield* TaskTool
        const tool = yield* info.init()
        const result = yield* tool.execute({ operation: { action: "list" } }, ctx(sess.id))
        expect(result.metadata.count).toBe(2)
      }),
    ),
  )

  it.live("set_status=done transitions task", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const reg = yield* TaskRegistry.Service
        const sess = yield* session.create({ title: "Test" })
        const t = yield* reg.create({ session_id: sess.id, summary: "a" })
        const info = yield* TaskTool
        const tool = yield* info.init()
        yield* tool.execute({ operation: { action: "done", id: t.id } }, ctx(sess.id))
        const after = yield* reg.get({ session_id: sess.id, id: t.id })
        expect(after?.status).toBe("done")
      }),
    ),
  )

  it.live("rename with summary renames the task", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const reg = yield* TaskRegistry.Service
        const sess = yield* session.create({ title: "Test" })
        const t = yield* reg.create({ session_id: sess.id, summary: "old name" })
        const info = yield* TaskTool
        const tool = yield* info.init()
        yield* tool.execute({ operation: { action: "rename", id: t.id, summary: "new name" } }, ctx(sess.id))
        const after = yield* reg.get({ session_id: sess.id, id: t.id })
        expect(after?.summary).toBe("new name")
      }),
    ),
  )

  it.live("rejects old flat JSON shape", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const sess = yield* session.create({ title: "Test" })
        const info = yield* TaskTool
        const tool = yield* info.init()
        const exit = yield* Effect.exit(
          tool.execute({ action: "create", summary: "Implement auth" } as any, ctx(sess.id)),
        )
        expect(exit._tag).toBe("Failure")
      }),
    ),
  )

  it.live("rejects create without summary", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const sess = yield* session.create({ title: "Test" })
        const info = yield* TaskTool
        const tool = yield* info.init()
        const exit = yield* Effect.exit(tool.execute({ operation: { action: "create" } } as any, ctx(sess.id)))
        expect(exit._tag).toBe("Failure")
      }),
    ),
  )

  it.live("rejects progress without event_summary", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const reg = yield* TaskRegistry.Service
        const sess = yield* session.create({ title: "Test" })
        const t = yield* reg.create({ session_id: sess.id, summary: "a" })
        const info = yield* TaskTool
        const tool = yield* info.init()
        const exit = yield* Effect.exit(
          tool.execute({ operation: { action: "progress", id: t.id } } as any, ctx(sess.id)),
        )
        expect(exit._tag).toBe("Failure")
      }),
    ),
  )
})

describe("task tool: deprecated verbs are rejected", () => {
  it.live("set_status operation itself is rejected (replaced by independent verbs)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const sess = yield* session.create({ title: "Test" })
        const info = yield* TaskTool
        const tool = yield* info.init()
        const exit = yield* Effect.exit(
          tool.execute({ operation: { action: "set_status", id: "T1", status: "blocked" } } as any, ctx(sess.id)),
        )
        expect(exit._tag).toBe("Failure")
      }),
    ),
  )

  it.live("progress operation is rejected", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const sess = yield* session.create({ title: "Test" })
        const info = yield* TaskTool
        const tool = yield* info.init()
        const exit = yield* Effect.exit(
          tool.execute({ operation: { action: "progress", id: "T1", event_summary: "x" } } as any, ctx(sess.id)),
        )
        expect(exit._tag).toBe("Failure")
      }),
    ),
  )

  it.live("approve operation is rejected", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const sess = yield* session.create({ title: "Test" })
        const info = yield* TaskTool
        const tool = yield* info.init()
        const exit = yield* Effect.exit(
          tool.execute({ operation: { action: "approve", id: "T1" } } as any, ctx(sess.id)),
        )
        expect(exit._tag).toBe("Failure")
      }),
    ),
  )

  it.live("rename with spec_ref is rejected", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const sess = yield* session.create({ title: "Test" })
        const info = yield* TaskTool
        const tool = yield* info.init()
        const exit = yield* Effect.exit(
          tool.execute({ operation: { action: "rename", id: "T1", spec_ref: "x" } } as any, ctx(sess.id)),
        )
        expect(exit._tag).toBe("Failure")
      }),
    ),
  )
})

describe("task tool: independent lifecycle verbs", () => {
  it.live("block operation accepted", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const sess = yield* session.create({ title: "Test" })
        const info = yield* TaskTool
        const def = yield* info.init()
        const result = def.parameters.safeParse({ operation: { action: "block", id: "T1", event_summary: "waiting" } })
        expect(result.success).toBe(true)
      }),
    ),
  )

  it.live("unblock operation accepted", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const sess = yield* session.create({ title: "Test" })
        const info = yield* TaskTool
        const def = yield* info.init()
        const result = def.parameters.safeParse({ operation: { action: "unblock", id: "T1" } })
        expect(result.success).toBe(true)
      }),
    ),
  )

  it.live("done operation accepted", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const sess = yield* session.create({ title: "Test" })
        const info = yield* TaskTool
        const def = yield* info.init()
        const result = def.parameters.safeParse({ operation: { action: "done", id: "T1", event_summary: "complete" } })
        expect(result.success).toBe(true)
      }),
    ),
  )

  it.live("abandon operation accepted", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const sess = yield* session.create({ title: "Test" })
        const info = yield* TaskTool
        const def = yield* info.init()
        const result = def.parameters.safeParse({ operation: { action: "abandon", id: "T1" } })
        expect(result.success).toBe(true)
      }),
    ),
  )

  it.live("block with invalid status field is rejected (strict)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const sess = yield* session.create({ title: "Test" })
        const info = yield* TaskTool
        const def = yield* info.init()
        const result = def.parameters.safeParse({ operation: { action: "block", id: "T1", status: "in_progress" } })
        expect(result.success).toBe(false)
      }),
    ),
  )

  it.live("shell-wrapped task create does not crash and renders operation=create", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const sess = yield* session.create({ title: "Test" })
        const info = yield* TaskTool
        const def = yield* info.init()
        const wrapped = shellWrap({ ...def, id: info.id })
        const result = yield* wrapped.execute({ script: 'task create "x"' }, ctx(sess.id) as any)
        // Regression: nested discriminator { operation: { action } } used to crash
        // shell-wrap with "H.replace is not a function". The XML attribute must
        // reflect the action verb, not "[object Object]".
        expect(result.output).toContain('operation="create"')
        expect(result.output).not.toContain("[object Object]")
        expect(result.metadata.success).toBe(1)
      }),
    ),
  )
})

// Audit §10: `revise` is the new in-progress task update action
// (softer than `rename` — `summary` is optional). And `done` /
// `abandon` now require a permission ask.
describe("task tool: revise", () => {
  it.live("revise with a new summary updates the task", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const sess = yield* session.create({ title: "Test" })
        const info = yield* TaskTool
        const tool = yield* info.init()
        const ctxObj = ctx(sess.id)
        yield* tool.execute({ operation: { action: "create", summary: "Old" } }, ctxObj)
        const result = yield* tool.execute(
          { operation: { action: "revise", id: "T1", summary: "New" } },
          ctxObj,
        )
        expect(result.output).toContain("New")
        expect(result.metadata.id).toBe("T1")
      }),
    ),
  )

  it.live("revise with only an event_summary preserves the existing summary", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const reg = yield* TaskRegistry.Service
        const sess = yield* session.create({ title: "Test" })
        const info = yield* TaskTool
        const tool = yield* info.init()
        const ctxObj = ctx(sess.id)
        yield* tool.execute({ operation: { action: "create", summary: "Stable" } }, ctxObj)
        const result = yield* tool.execute(
          { operation: { action: "revise", id: "T1", event_summary: "spike ran, no change needed" } },
          ctxObj,
        )
        // The output includes the note…
        expect(result.output).toContain("spike ran, no change needed")
        expect(result.metadata.id).toBe("T1")
        // …and the task's stored summary is unchanged.
        const t = yield* reg.get({ session_id: sess.id, id: "T1" })
        expect(t?.summary).toBe("Stable")
      }),
    ),
  )

  it.live("revise with neither summary nor event_summary fails fast", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const sess = yield* session.create({ title: "Test" })
        const info = yield* TaskTool
        const tool = yield* info.init()
        const ctxObj = ctx(sess.id)
        yield* tool.execute({ operation: { action: "create", summary: "X" } }, ctxObj)
        const exit = yield* tool
          .execute({ operation: { action: "revise", id: "T1" } }, ctxObj)
          .pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
      }),
    ),
  )
})

describe("task tool: done/abandon permission ask", () => {
  // The `ask` is captured in a local list. After the call we
  // assert exactly one ask fired and the action matches.
  function capturingCtx(sessionID: string) {
    const asks: Array<{ permission: string; patterns: string[]; metadata: unknown }> = []
    return {
      asks,
      ctx: {
        ...ctx(sessionID),
        ask: (req: { permission: string; patterns: string[]; metadata: unknown }) =>
          Effect.sync(() => asks.push(req)),
      },
    }
  }

  it.live("done asks for permission before flipping to terminal", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const sess = yield* session.create({ title: "Test" })
        const info = yield* TaskTool
        const tool = yield* info.init()
        const { ctx: ctxObj, asks } = capturingCtx(sess.id)
        yield* tool.execute({ operation: { action: "create", summary: "X" } }, ctxObj)
        yield* tool.execute({ operation: { action: "start", id: "T1" } }, ctxObj)
        // Reset asks so we only count the done ask.
        asks.length = 0
        const result = yield* tool.execute({ operation: { action: "done", id: "T1" } }, ctxObj)
        expect(asks.length).toBe(1)
        expect(asks[0].permission).toBe("task")
        expect(asks[0].patterns).toContain("T1")
        expect(result.metadata.id).toBe("T1")
        expect(result.metadata.status).toBe("done")
      }),
    ),
  )

  it.live("abandon asks for permission before flipping to terminal", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const sess = yield* session.create({ title: "Test" })
        const info = yield* TaskTool
        const tool = yield* info.init()
        const { ctx: ctxObj, asks } = capturingCtx(sess.id)
        yield* tool.execute({ operation: { action: "create", summary: "X" } }, ctxObj)
        asks.length = 0
        const result = yield* tool.execute({ operation: { action: "abandon", id: "T1" } }, ctxObj)
        expect(asks.length).toBe(1)
        expect(asks[0].permission).toBe("task")
        expect(asks[0].patterns).toContain("T1")
        expect(result.metadata.id).toBe("T1")
        expect(result.metadata.status).toBe("abandoned")
      }),
    ),
  )

  it.live("non-terminal actions (start/block/unblock) do NOT ask for permission", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const sess = yield* session.create({ title: "Test" })
        const info = yield* TaskTool
        const tool = yield* info.init()
        const { ctx: ctxObj, asks } = capturingCtx(sess.id)
        yield* tool.execute({ operation: { action: "create", summary: "X" } }, ctxObj)
        asks.length = 0
        yield* tool.execute({ operation: { action: "start", id: "T1" } }, ctxObj)
        yield* tool.execute({ operation: { action: "block", id: "T1", event_summary: "stuck" } }, ctxObj)
        yield* tool.execute({ operation: { action: "unblock", id: "T1", event_summary: "unstuck" } }, ctxObj)
        expect(asks.length).toBe(0)
      }),
    ),
  )
})
