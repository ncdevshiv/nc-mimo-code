// Module-scoped registry of live bash child handles. The bash tool
// `register`s a handle after spawning and `unregister`s when the
// process exits; the long-running monitor (T28) calls `kill` on
// the handle when its sub-actor returns `kind: "terminate"`.
//
// Why a module-scoped registry: the bash tool's child handle is
// created inside `Effect.scoped` (the handle's lifetime is bound
// to the tool's execution scope), and the monitor service lives
// in a different scope. Passing the handle through the bus
// payload would force the bus to know about `ChildProcess` —
// undesirable. The registry is the minimal coupling: a `pid` (a
// primitive number) crosses the bus boundary, the monitor reads
// the handle from the map, and the bus never sees a child
// process.

import { Effect } from "effect"

export interface KillableHandle {
  readonly pid: number
  readonly kill: () => Effect.Effect<void>
}

const registry = new Map<number, KillableHandle>()

export function registerBashHandle(handle: KillableHandle): void {
  registry.set(handle.pid, handle)
}

export function unregisterBashHandle(pid: number): void {
  registry.delete(pid)
}

export function getBashHandle(pid: number): KillableHandle | undefined {
  return registry.get(pid)
}

export function killBashHandle(pid: number): Effect.Effect<boolean> {
  return Effect.suspend(() => {
    const handle = registry.get(pid)
    if (!handle) return Effect.succeed(false)
    return Effect.as(handle.kill(), true)
  })
}

/** Test-only: clear the registry. */
export function clearBashHandleRegistry(): void {
  registry.clear()
}
