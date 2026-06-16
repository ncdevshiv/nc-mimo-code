// Monitor bridge wiring — installs the `MonitorBridge` port
// (`monitor/actor-bridge.ts`) into the module-scoped
// `monitorBridgeRef`, delegating `spawn` to the existing
// `Actor.Service` (`actor/spawn.ts`).
//
// The wire-up lives in its own file (not inlined in
// `effect/app-runtime.ts`) for two reasons:
//   1. Keeping the monitor subsystem self-contained — the app
//      runtime only needs one import line to enable the whole
//      tool-failure-repair / bash-long-running pipeline.
//   2. Allowing tests to override the bridge via `setMonitorBridge`
//      without touching the boot layer.
//
// Design note: the bridge's public `spawn` signature is
// `Effect<X, never>` (no service requirements), so it can be
// invoked from non-Effect contexts like the AI SDK's
// `experimental_repairToolCall` callback. The implementation
// captures the Effect `Context` at construction time
// (`Effect.context<R>()`) and re-provides it on every inner
// `Effect.runPromise` call, so the captured `Actor.Service` flows
// into the spawned sub-actor without exposing the requirement to
// the caller.

import { Context, Deferred, Effect } from "effect"
import { Actor } from "@/actor/spawn"
import { SessionID } from "@/session/schema"
import {
  setMonitorBridge,
  type MonitorBridge,
  type MonitorSpawnResult,
  type SpawnStatus,
} from "./actor-bridge"

interface AgentOutcomeShape {
  status: "success" | "failure" | "cancelled" | "timeout"
  finalText?: string
  structured?: unknown
  error?: string
}

interface WaitResult {
  status: "success" | "failure" | "cancelled" | "timeout"
  finalText?: string
  structured?: unknown
  error?: string
}

/**
 * Translate an `AgentOutcome` (the deferred the Actor service resolves
 * when a sub-actor terminates) into a `MonitorSpawnResult` (the port
 * type the monitor subsystem consumes). The mapping keeps the two type
 * hierarchies decoupled so the bridge port never imports actor-internals.
 */
function toMonitorResult(
  outcome: AgentOutcomeShape,
  actorID: string,
  sessionID: string,
): MonitorSpawnResult {
  const base = { actorID, sessionID }
  if (outcome.status === "success") {
    return {
      status: "success" satisfies SpawnStatus,
      ...(outcome.finalText !== undefined ? { finalText: outcome.finalText } : {}),
      ...(outcome.structured !== undefined ? { structured: outcome.structured } : {}),
      ...base,
    }
  }
  if (outcome.status === "failure") {
    return {
      status: "failure" satisfies SpawnStatus,
      error: outcome.error,
      ...base,
    }
  }
  return { status: "cancelled" satisfies SpawnStatus, ...base }
}

/**
 * Build the live `MonitorBridge` implementation. The actor + context are
 * captured at call time so the returned bridge's public `spawn` has no
 * caller-supplied service requirements: it can be invoked from a
 * non-Effect context (the AI SDK's `experimental_repairToolCall`
 * callback runs in the SDK's async world, not in the Effect runtime).
 */
export function makeMonitorBridge(
  actor: Actor.Interface,
  context: Context.Context<Actor.Service>,
): MonitorBridge {
  return {
    spawn: (input) =>
      Effect.promise(async () => {
        const sessionID = SessionID.make(input.sessionID)
        const result = await Effect.runPromise(
          actor
            .spawn({
              mode: "subagent",
              sessionID,
              agentType: input.agentType,
              description: input.description,
              task: input.task,
              // Monitor sub-actors get no parent context — they only need
              // the tool-call repair payload (or the bash command) to do
              // their job, and inheriting the parent conversation would
              // pollute the cache and waste prompt tokens.
              context: "none",
              // Tool whitelist intentionally empty: monitor sub-actors
              // must never recurse into a tool call. tool-failure-repair
              // is text-only; bash-long-running observes the parent's
              // child PID via the bus event, not via spawning its own
              // shell.
              tools: [],
              background: false,
            })
            .pipe(Effect.provideContext(context)),
        )

        // Race the outcome Deferred against a wall-clock timeout. Using
        // `Promise.race` (rather than `Effect.timeout`) keeps the result
        // typing clean — the await promise's resolved value carries a
        // tagged status, no exception-based control flow.
        const awaited: WaitResult = await Promise.race([
          Effect.runPromise(Deferred.await(result.outcome).pipe(Effect.provideContext(context))).then(
            (v) => v as WaitResult,
          ),
          new Promise<{ status: "timeout" }>((resolve) =>
            setTimeout(() => resolve({ status: "timeout" }), input.timeoutMs),
          ),
        ]).catch((err: unknown) => ({
          status: "failure" as const,
          error: err instanceof Error ? err.message : String(err),
        }))

        if (awaited.status === "timeout") {
          return {
            status: "timeout" as SpawnStatus,
            actorID: result.actorID,
            sessionID: result.sessionID,
          }
        }
        return toMonitorResult(awaited, result.actorID, result.sessionID)
      }),
  }
}

/**
 * Effect that wires the live `MonitorBridge` into the module-scoped
 * `monitorBridgeRef`. Must be run inside a context that provides
 * `Actor.Service` (i.e. inside the app layer graph). Returns `void`
 * — the bridge lives in the module-scoped ref, not in the Effect
 * environment, so it can be invoked from non-Effect call sites.
 */
export const wireMonitorBridge: Effect.Effect<void, never, Actor.Service> = Effect.gen(function* () {
  // The tag `Actor.Service` is a class; yielding it surfaces the
  // bound implementation. TypeScript's inference of the class
  // re-export through the `Actor` namespace re-export was losing the
  // interface side in this version of effect; the explicit cast
  // recovers it without depending on the original `Service` symbol.
  const actor = (yield* Actor.Service) as unknown as Actor.Interface
  const context = yield* Effect.context<Actor.Service>()
  setMonitorBridge(makeMonitorBridge(actor, context))
})
