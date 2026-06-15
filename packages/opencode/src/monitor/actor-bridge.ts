import { Effect } from "effect"

export interface SpawnInput {
  readonly sessionID: string
  readonly agentType: string
  readonly prompt: string
  readonly timeoutMs: number
}

export interface MonitorBridge {
  readonly spawn: (input: SpawnInput) => Effect.Effect<string, never>
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