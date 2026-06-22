// Boot smoke test for the monitor bridge wiring.
//
// PR-3 step 5 — verifies that `wireAppMonitor` populates the
// module-scoped `monitorBridgeRef.current` after running the effect.
// Before PR-3 the wiring effect was never invoked, so
// `getMonitorBridge()` threw at runtime and the bash long-running
// monitor silently degraded to `{ kind: "continue" }` for every hung
// command. This test guards against a regression where the wiring is
// accidentally removed from the boot path.
//
// We run `wireAppMonitor` against a stub `Actor.Service` so the test
// does not boot the full app runtime. The stub actor returns a
// pre-canned outcome for any spawn call; we assert that the bridge
// reference is populated and that `getMonitorBridge()` does not
// throw.

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { Effect } from "effect"
import { wireAppMonitor } from "../../src/effect/app-runtime"
import { getMonitorBridge, setMonitorBridge } from "../../src/monitor/actor-bridge"
import type { MonitorBridge, MonitorSpawnResult } from "../../src/monitor/actor-bridge"
import { Actor } from "../../src/actor/spawn"

describe("wireAppMonitor (boot smoke)", () => {
  // Reset the module-scoped bridge ref before/after each test so the
  // state is isolated.
  beforeEach(() => {
    setMonitorBridge(undefined as unknown as MonitorBridge)
  })
  afterEach(() => {
    setMonitorBridge(undefined as unknown as MonitorBridge)
  })

  test("populates the bridge ref after running the wiring effect", async () => {
    // Pre-condition: getMonitorBridge() throws before wiring.
    expect(() => getMonitorBridge()).toThrow(/Monitor bridge not initialized/)

    // Build a stub Actor.Interface that returns a pre-canned outcome
    // for any spawn call.
    const stubOutcome: MonitorSpawnResult = {
      status: "success",
      finalText: '{"continue":"ok"}',
      actorID: "actor_stub",
      sessionID: "ses_stub",
    }
    const stubActor: Actor.Interface = {
      spawn: () =>
        Effect.succeed({
          actorID: "actor_stub",
          sessionID: "ses_stub",
          outcome: Effect.succeed(stubOutcome),
        }),
    } as unknown as Actor.Interface

    // Provide the stub Actor.Service so the wiring effect's
    // `yield* Actor.Service` resolves to our stub.
    await Effect.runPromise(
      wireAppMonitor.pipe(Effect.provideService(Actor.Service, stubActor)),
    )

    // Post-condition: getMonitorBridge() returns the populated bridge.
    const bridge = getMonitorBridge()
    expect(bridge).toBeDefined()
    expect(typeof bridge.spawn).toBe("function")
  })
})