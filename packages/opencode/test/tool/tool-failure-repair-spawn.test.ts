// Integration test for `ToolFailureRepair.spawn` (T28 dispatcher).
//
// The dispatcher's contract: given a `RepairRequest` and a
// `MonitorBridge` (injected via `deps.bridge`), call the bridge to
// spawn a `tool-failure-repair` sub-actor and return a parsed
// `RepairResult`. The bridge is the only Effect-runtime coupling, so
// the test injects a fake bridge and exercises the full
// prompt → bridge → parse pipeline without booting `AppRuntime`.
//
// This sits in `_standalone/` because the dispatcher itself is
// deps-free (only the bridge injection point is Effect-aware). The
// real bridge is wired in `monitor/service.ts`; this test verifies
// the dispatcher's translation layer in isolation.

import { test, expect, describe } from "bun:test"
import { Effect } from "effect"
import {
  spawn,
  type RepairRequest,
  type RepairResult,
} from "../../src/monitor/tool-failure-repair"
import type { MonitorBridge, MonitorSpawnResult } from "../../src/monitor/actor-bridge"

const SAMPLE_REQUEST: RepairRequest = {
  tool: "edit",
  input: { filePath: "x.txt", oldString: "hello", newString: "hellp" },
  error: "oldString and newString must differ",
  schema: {
    type: "object",
    properties: {
      filePath: { type: "string" },
      oldString: { type: "string" },
      newString: { type: "string" },
    },
    required: ["filePath", "oldString", "newString"],
  },
}

function makeFakeBridge(reply: MonitorSpawnResult): { bridge: MonitorBridge; calls: unknown[] } {
  const calls: unknown[] = []
  const bridge: MonitorBridge = {
    spawn: (input) => {
      calls.push(input)
      return Effect.succeed(reply)
    },
  }
  return { bridge, calls }
}

describe("ToolFailureRepair.spawn: bridge integration", () => {
  test("a successful sub-actor returning repaired JSON propagates to kind=repaired", async () => {
    const { bridge, calls } = makeFakeBridge({
      status: "success",
      finalText: JSON.stringify({ input: { filePath: "x.txt", oldString: "hello", newString: "HELLO" } }),
      actorID: "actor-1",
      sessionID: "sess-1",
    })
    const result: RepairResult = await spawn(SAMPLE_REQUEST, {
      bridge,
      sessionID: "sess-1",
    })
    expect(result).toEqual({
      kind: "repaired",
      input: { filePath: "x.txt", oldString: "hello", newString: "HELLO" },
    })
    // The bridge was called with the right task (user prompt) and a
    // reasonable timeout. The agentType is the hardcoded constant
    // `tool-failure-repair`; the dispatcher always uses it.
    expect(calls).toHaveLength(1)
    const call = calls[0] as Parameters<MonitorBridge["spawn"]>[0]
    expect(call.agentType).toBe("tool-failure-repair")
    expect(call.sessionID).toBe("sess-1")
    expect(call.description).toBe("tool-failure-repair")
    expect(call.task).toContain("Tool: `edit`")
    expect(call.task).toContain("oldString and newString must differ")
    expect(call.task).toContain('"type": "object"')
    expect(call.timeoutMs).toBe(30_000)
  })

  test("a successful sub-actor returning unfixable JSON propagates to kind=unfixable", async () => {
    const { bridge } = makeFakeBridge({
      status: "success",
      finalText: JSON.stringify({ unfixable: "missing required field 'filePath'" }),
      actorID: "actor-2",
      sessionID: "sess-2",
    })
    const result = await spawn(SAMPLE_REQUEST, { bridge, sessionID: "sess-2" })
    expect(result).toEqual({ kind: "unfixable", reason: "missing required field 'filePath'" })
  })

  test("a failure sub-actor becomes kind=unfixable with a descriptive reason", async () => {
    const { bridge } = makeFakeBridge({
      status: "failure",
      error: "spawn refused by permission check",
      actorID: "actor-3",
      sessionID: "sess-3",
    })
    const result = await spawn(SAMPLE_REQUEST, { bridge, sessionID: "sess-3" })
    expect(result.kind).toBe("unfixable")
    if (result.kind === "unfixable") {
      expect(result.reason).toContain("spawn refused by permission check")
    }
  })

  test("a failure sub-actor with no error message still yields a usable reason", async () => {
    const { bridge } = makeFakeBridge({
      status: "failure",
      actorID: "actor-3b",
      sessionID: "sess-3b",
    })
    const result = await spawn(SAMPLE_REQUEST, { bridge, sessionID: "sess-3b" })
    expect(result.kind).toBe("unfixable")
    if (result.kind === "unfixable") {
      expect(result.reason).toMatch(/unknown error|sub-actor failed/)
    }
  })

  test("a cancelled sub-actor becomes kind=unfixable", async () => {
    const { bridge } = makeFakeBridge({
      status: "cancelled",
      actorID: "actor-4",
      sessionID: "sess-4",
    })
    const result = await spawn(SAMPLE_REQUEST, { bridge, sessionID: "sess-4" })
    expect(result).toEqual({ kind: "unfixable", reason: "sub-actor was cancelled" })
  })

  test("a timeout sub-actor becomes kind=unfixable with a 'timed out' reason", async () => {
    const { bridge } = makeFakeBridge({
      status: "timeout",
      actorID: "actor-5",
      sessionID: "sess-5",
    })
    const result = await spawn(SAMPLE_REQUEST, { bridge, sessionID: "sess-5" })
    expect(result).toEqual({
      kind: "unfixable",
      reason: "sub-actor timed out before producing a result",
    })
  })

  test("a successful sub-actor whose output does not parse becomes kind=unfixable", async () => {
    const { bridge } = makeFakeBridge({
      status: "success",
      finalText: "I cannot fix this call because the model needs more context.",
      actorID: "actor-6",
      sessionID: "sess-6",
    })
    const result = await spawn(SAMPLE_REQUEST, { bridge, sessionID: "sess-6" })
    expect(result.kind).toBe("unfixable")
    if (result.kind === "unfixable") {
      expect(result.reason).toMatch(/did not match the strict/)
    }
  })

  test("a successful sub-actor with empty finalText becomes kind=unfixable", async () => {
    const { bridge } = makeFakeBridge({
      status: "success",
      finalText: "",
      actorID: "actor-7",
      sessionID: "sess-7",
    })
    const result = await spawn(SAMPLE_REQUEST, { bridge, sessionID: "sess-7" })
    expect(result).toEqual({ kind: "unfixable", reason: "sub-actor produced no output" })
  })

  test("a successful sub-actor whose finalText is code-fenced JSON still parses", async () => {
    const { bridge } = makeFakeBridge({
      status: "success",
      finalText: '```json\n{"input": {"filePath": "y.txt"}}\n```',
      actorID: "actor-8",
      sessionID: "sess-8",
    })
    const result = await spawn(SAMPLE_REQUEST, { bridge, sessionID: "sess-8" })
    expect(result).toEqual({ kind: "repaired", input: { filePath: "y.txt" } })
  })

  test("a custom timeoutMs is forwarded to the bridge", async () => {
    const { bridge, calls } = makeFakeBridge({
      status: "timeout",
      actorID: "actor-9",
      sessionID: "sess-9",
    })
    await spawn(SAMPLE_REQUEST, { bridge, sessionID: "sess-9", timeoutMs: 5_000 })
    expect((calls[0] as Parameters<MonitorBridge["spawn"]>[0]).timeoutMs).toBe(5_000)
  })

  test("a successful sub-actor with structured (object) output is JSON-stringified then parsed", async () => {
    const { bridge } = makeFakeBridge({
      status: "success",
      structured: { input: { filePath: "structured.txt" } },
      actorID: "actor-10",
      sessionID: "sess-10",
    })
    const result = await spawn(SAMPLE_REQUEST, { bridge, sessionID: "sess-10" })
    expect(result).toEqual({ kind: "repaired", input: { filePath: "structured.txt" } })
  })
})
