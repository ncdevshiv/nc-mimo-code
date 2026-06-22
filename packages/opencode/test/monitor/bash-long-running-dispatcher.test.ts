// Tests for the T28 dispatcher — `BashLongRunning.spawn(req, deps)`.
// PR-3 step 4.
//
// The dispatcher delegates to a `MonitorBridge` (`deps.bridge`) and
// translates the bridge outcome into an `Assessment`. We inject a
// fake bridge here so the test runs without booting the full
// runtime. The bridge-not-populated default-continue fallback
// (audit concern) is also covered.

import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import * as BashLongRunning from "../../src/monitor/bash-long-running"
import type { MonitorBridge, MonitorSpawnResult } from "../../src/monitor/actor-bridge"

function fakeBridge(outcome: MonitorSpawnResult): MonitorBridge {
  return {
    spawn: () => Effect.succeed(outcome),
  }
}

function successOutcome(text: string): MonitorSpawnResult {
  return { status: "success", finalText: text, actorID: "actor_1", sessionID: "ses_x" }
}

function failureOutcome(status: "failure" | "cancelled" | "timeout", error?: string): MonitorSpawnResult {
  return { status, error, actorID: "actor_1", sessionID: "ses_x" }
}

describe("BashLongRunning.spawn dispatcher", () => {
  test("continue from the sub-actor returns kind: 'continue'", async () => {
    const result = await BashLongRunning.spawn(
      { sessionID: "ses_x", command: "ls", elapsedMs: 60_000 },
      { bridge: fakeBridge(successOutcome('{"continue":"making progress"}')) },
    )
    expect(result.kind).toBe("continue")
  })

  test("warn from the sub-actor returns kind: 'warn' with the reason", async () => {
    const result = await BashLongRunning.spawn(
      { sessionID: "ses_x", command: "npm install", elapsedMs: 1_800_000 },
      { bridge: fakeBridge(successOutcome('{"warn":"30 minutes with no progress"}')) },
    )
    expect(result.kind).toBe("warn")
    if (result.kind === "warn") {
      expect(result.reason).toBe("30 minutes with no progress")
    }
  })

  test("terminate from the sub-actor returns kind: 'terminate' with the reason", async () => {
    const result = await BashLongRunning.spawn(
      { sessionID: "ses_x", command: "while true; do :; done", elapsedMs: 600_000 },
      { bridge: fakeBridge(successOutcome('{"terminate":"infinite loop detected"}')) },
    )
    expect(result.kind).toBe("terminate")
    if (result.kind === "terminate") {
      expect(result.reason).toBe("infinite loop detected")
    }
  })

  test("code-fenced JSON is unwrapped before parsing", async () => {
    const result = await BashLongRunning.spawn(
      { sessionID: "ses_x", command: "ls", elapsedMs: 60_000 },
      {
        bridge: fakeBridge(
          successOutcome('```json\n{"warn":"slow but plausible"}\n```'),
        ),
      },
    )
    expect(result.kind).toBe("warn")
  })

  test("bridge status: failure maps to the conservative default-continue", async () => {
    const result = await BashLongRunning.spawn(
      { sessionID: "ses_x", command: "ls", elapsedMs: 60_000 },
      { bridge: fakeBridge(failureOutcome("failure", "LLM crashed")) },
    )
    expect(result.kind).toBe("continue")
    if (result.kind === "continue") {
      expect(result.reason).toContain("failure")
    }
  })

  test("bridge status: cancelled maps to default-continue (cancelled, not killed)", async () => {
    const result = await BashLongRunning.spawn(
      { sessionID: "ses_x", command: "ls", elapsedMs: 60_000 },
      { bridge: fakeBridge(failureOutcome("cancelled")) },
    )
    expect(result.kind).toBe("continue")
  })

  test("bridge status: timeout maps to default-continue", async () => {
    const result = await BashLongRunning.spawn(
      { sessionID: "ses_x", command: "ls", elapsedMs: 60_000 },
      { bridge: fakeBridge(failureOutcome("timeout")) },
    )
    expect(result.kind).toBe("continue")
  })

  test("unparseable output maps to default-continue (never kills on parse failure)", async () => {
    const result = await BashLongRunning.spawn(
      { sessionID: "ses_x", command: "ls", elapsedMs: 60_000 },
      { bridge: fakeBridge(successOutcome("not JSON")) },
    )
    expect(result.kind).toBe("continue")
  })

  test("empty output maps to default-continue", async () => {
    const result = await BashLongRunning.spawn(
      { sessionID: "ses_x", command: "ls", elapsedMs: 60_000 },
      { bridge: fakeBridge(successOutcome("")) },
    )
    expect(result.kind).toBe("continue")
  })

  test("multi-key response prefers terminate > warn > continue (conservative)", async () => {
    const result = await BashLongRunning.spawn(
      { sessionID: "ses_x", command: "ls", elapsedMs: 60_000 },
      { bridge: fakeBridge(successOutcome('{"continue":"x","warn":"y","terminate":"z"}')) },
    )
    expect(result.kind).toBe("terminate")
  })

  test("the bridge is called with the bash-long-running agent type and the built prompt", async () => {
    const calls: Array<{ agentType: string; task: string }> = []
    const bridge: MonitorBridge = {
      spawn: (input) => {
        calls.push({ agentType: input.agentType, task: input.task })
        return Effect.succeed(successOutcome('{"continue":"ok"}'))
      },
    }
    await BashLongRunning.spawn(
      { sessionID: "ses_y", command: "ls", elapsedMs: 5_000, description: "list files" },
      { bridge },
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]?.agentType).toBe("bash-long-running")
    expect(calls[0]?.task).toContain("ls")
    expect(calls[0]?.task).toContain("list files")
  })
})