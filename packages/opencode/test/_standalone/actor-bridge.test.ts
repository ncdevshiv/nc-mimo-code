import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { Effect } from "effect"
import {
  setMonitorBridge,
  getMonitorBridge,
  monitorBridgeRef,
  type MonitorBridge,
  type SpawnInput,
} from "../../src/monitor/actor-bridge"

describe("actor-bridge: getMonitorBridge throws when ref is unpopulated", () => {
  beforeEach(() => {
    monitorBridgeRef.current = undefined
  })

  test("getMonitorBridge throws a descriptive error", () => {
    expect(() => getMonitorBridge()).toThrow(/Monitor bridge not initialized/)
  })

  test("getMonitorBridge throws even when called multiple times", () => {
    expect(() => getMonitorBridge()).toThrow()
    expect(() => getMonitorBridge()).toThrow()
  })
})

describe("actor-bridge: setMonitorBridge populates the ref", () => {
  afterEach(() => {
    monitorBridgeRef.current = undefined
  })

  test("setMonitorBridge returns a disposer that resets the ref", () => {
    const fake: MonitorBridge = {
      spawn: () => Effect.succeed("ok"),
    }
    const dispose = setMonitorBridge(fake)
    expect(monitorBridgeRef.current).toBe(fake)
    dispose()
    expect(monitorBridgeRef.current).toBeUndefined()
  })

  test("getMonitorBridge returns the populated bridge", () => {
    const fake: MonitorBridge = {
      spawn: () => Effect.succeed("ok"),
    }
    setMonitorBridge(fake)
    expect(getMonitorBridge()).toBe(fake)
  })
})

describe("actor-bridge: disposer is idempotent", () => {
  test("calling dispose twice does not throw and does not corrupt the ref", () => {
    const fake: MonitorBridge = {
      spawn: () => Effect.succeed("ok"),
    }
    const dispose = setMonitorBridge(fake)
    dispose()
    dispose()
    expect(monitorBridgeRef.current).toBeUndefined()
  })

  test("a second setMonitorBridge replaces the first; the old disposer no-ops", () => {
    const fake1: MonitorBridge = { spawn: () => Effect.succeed("1") }
    const fake2: MonitorBridge = { spawn: () => Effect.succeed("2") }
    const dispose1 = setMonitorBridge(fake1)
    setMonitorBridge(fake2)
    expect(monitorBridgeRef.current).toBe(fake2)
    dispose1()
    // dispose1 should NOT have removed fake2 (the ref checks identity)
    expect(monitorBridgeRef.current).toBe(fake2)
  })
})

describe("actor-bridge: a fake bridge can be exercised via getMonitorBridge", () => {
  afterEach(() => {
    monitorBridgeRef.current = undefined
  })

  test("spawn is called with the input the dispatcher passed", async () => {
    let captured: SpawnInput | undefined
    const fake: MonitorBridge = {
      spawn: (input) =>
        Effect.sync(() => {
          captured = input
          return "ok"
        }),
    }
    setMonitorBridge(fake)
    const bridge = getMonitorBridge()
    const result = await Effect.runPromise(
      bridge.spawn({
        sessionID: "sess-1",
        agentType: "tool-failure-repair",
        prompt: "hello",
        timeoutMs: 5000,
      }),
    )
    expect(result).toBe("ok")
    expect(captured).toEqual({
      sessionID: "sess-1",
      agentType: "tool-failure-repair",
      prompt: "hello",
      timeoutMs: 5000,
    })
  })

  test("a bridge that returns an empty string is observable by the dispatcher", async () => {
    const fake: MonitorBridge = {
      spawn: () => Effect.succeed(""),
    }
    setMonitorBridge(fake)
    const result = await Effect.runPromise(
      getMonitorBridge().spawn({
        sessionID: "sess-2",
        agentType: "bash-long-running",
        prompt: "p",
        timeoutMs: 1000,
      }),
    )
    expect(result).toBe("")
  })

  test("a bridge that throws surfaces the error to the caller", async () => {
    const fake: MonitorBridge = {
      spawn: () => Effect.fail(new Error("bridge died")),
    }
    setMonitorBridge(fake)
    await expect(
      Effect.runPromise(
        getMonitorBridge().spawn({
          sessionID: "sess-3",
          agentType: "x",
          prompt: "p",
          timeoutMs: 1000,
        }),
      ),
    ).rejects.toThrow("bridge died")
  })
})