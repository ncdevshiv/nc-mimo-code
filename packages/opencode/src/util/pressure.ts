// Live context-pressure level, threaded through the agent run loop so
// tool-level truncators can scale their output caps when context is
// filling up. The level comes from `session/overflow.ts:pressureLevel`
// (0 = <50%, 1 = 50–70%, 2 = 70–85%, 3 = ≥85%).
//
// The service is intentionally optional: tool execution paths that
// don't run inside the agent loop (or test harnesses that don't
// provide it) see `undefined` and skip pressure-driven shrinking.
// `shouldHalveCaps` captures the threshold we use for the auto-shrink
// behavior (level ≥ 2 means we're past 70%, so we tighten caps).

import { Context, Effect, Layer } from "effect"

export type PressureLevel = 0 | 1 | 2 | 3

export interface Interface {
  readonly level: PressureLevel
}

export class PressureService extends Context.Service<PressureService, Interface>()("@opencode/Pressure") {}

/**
 * Returns true when the supplied pressure level is high enough to
 * warrant halving per-tool output caps. Matches the threshold used by
 * the agent run loop's "context is filling up" nudge (≥ 70%).
 */
export function shouldHalveCaps(level: PressureLevel | undefined): boolean {
  return level !== undefined && level >= 2
}

/**
 * Provide a pressure level for the duration of the wrapped effect.
 * Used in `session/prompt.ts` to thread the live level into the
 * `tool.ts` wrap that runs every tool call.
 */
export function withPressure<A, E, R>(level: PressureLevel | undefined) {
  return <E2, R2>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | E2, R | R2> =>
    level === undefined
      ? (effect as Effect.Effect<A, E | E2, R | R2>)
      : Effect.provideService(effect as Effect.Effect<A, E, R>, PressureService, { level })
}

/**
 * Default layer: level 0 (no pressure). Tool execution paths that
 * don't run inside the agent run loop see this baseline. The run
 * loop overrides via `Effect.provideService` when context pressure
 * is high.
 */
export const defaultLayer = Layer.succeed(PressureService, { level: 0 as PressureLevel })

export * as Pressure from "."