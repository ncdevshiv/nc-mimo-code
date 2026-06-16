// MonitorBridge — the port the monitor subsystem (tool-failure-repair,
// bash-long-running, custom monitors) uses to spawn sub-actors. The
// implementation lives in `monitor/service.ts` and is wired into the boot
// layer in `effect/app-runtime.ts`.
//
// The bridge returns a `MonitorSpawnResult` (not just the actorID) so the
// caller can synchronously receive the sub-actor's outcome after the
// configured `timeoutMs`. This is what makes the LLM-driven repair in
// `experimental_repairToolCall` work: the bridge spawns the tool-failure-
// repair sub-actor and returns the parsed JSON in one round trip.

import { Effect } from "effect"

export interface SpawnInput {
  readonly sessionID: string
  readonly agentType: string
  readonly description: string
  /** The user-side message passed to the sub-actor. The sub-actor's own
   * `agent.prompt` becomes the system message; `task` is the user message. */
  readonly task: string
  /** Hard ceiling on the total time the bridge will wait for the outcome. */
  readonly timeoutMs: number
}

export type SpawnStatus = "success" | "failure" | "cancelled" | "timeout"

export interface MonitorSpawnResult {
  readonly status: SpawnStatus
  /** The sub-actor's final assistant text. Present when the LLM produced any
   * text output (the tool-failure-repair sub-agent returns JSON text; the
   * `parseRepairResult` parser is responsible for decoding it). */
  readonly finalText?: string
  /** Structured-output (json_schema) result. When the spawn used a `format`
   * option, the validated object surfaces here and takes precedence over
   * `finalText` in callers that prefer structured input. */
  readonly structured?: unknown
  /** Present when `status` is `"failure"`. The sub-actor's error message. */
  readonly error?: string
  readonly actorID: string
  readonly sessionID: string
}

export interface MonitorBridge {
  readonly spawn: (input: SpawnInput) => Effect.Effect<MonitorSpawnResult, never>
}

export const monitorBridgeRef: { current: MonitorBridge | undefined } = { current: undefined }

export function getMonitorBridge(): MonitorBridge {
  if (!monitorBridgeRef.current) {
    throw new Error("Monitor bridge not initialized; the integration layer must populate monitorBridgeRef.current")
  }
  return monitorBridgeRef.current
}

export function setMonitorBridge(bridge: MonitorBridge): () => void {
  monitorBridgeRef.current = bridge
  return () => {
    if (monitorBridgeRef.current === bridge) {
      monitorBridgeRef.current = undefined
    }
  }
}

export * as MonitorBridge from "./actor-bridge"
