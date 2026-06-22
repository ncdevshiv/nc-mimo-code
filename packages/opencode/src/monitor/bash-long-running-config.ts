// Resolved configuration for the bash long-running monitor.
//
// The raw `Config.Monitor.Info` shape lets users supply either a
// list of per-monitor entries (each with their own `enabled`,
// `thresholdMs`, `pollIntervalMs`) or rely on the global
// `defaultTimeoutMs` fallback. The bash tool's monitor fiber needs a
// single resolved record with no missing fields, so this helper
// does the lookup-and-defaults walk in one place. PR-3 step 2.
//
// Lookup order:
//   1. The first entry in `cfg.monitor?.monitors` whose `kind`
//      matches `"bash-long-running"` and whose `enabled` is not
//      explicitly `false`.
//   2. If no such entry exists, `cfg.monitor?.defaultTimeoutMs` (or
//      30_000 if absent).
//   3. Hard-coded fallbacks for `thresholdMs` (60_000) and
//      `pollIntervalMs` (30_000) when the entry doesn't supply them.
//
// The helper is pure (no Effect runtime) so it's unit-testable in
// isolation. The bash tool's monitor fiber calls it once per
// invocation; the resolved record is then passed to the poll loop.

export const DEFAULT_BASH_LONG_RUNNING_THRESHOLD_MS = 60_000
export const DEFAULT_BASH_LONG_RUNNING_POLL_INTERVAL_MS = 30_000
export const DEFAULT_BASH_LONG_RUNNING_TIMEOUT_MS = 30_000

export interface ResolvedBashLongRunningConfig {
  readonly enabled: boolean
  readonly thresholdMs: number
  readonly pollIntervalMs: number
  /** Sub-actor timeout for `BashLongRunning.spawn`. Falls back to
   *  the global `cfg.monitor?.defaultTimeoutMs` if no per-Entry value. */
  readonly timeoutMs: number
}

interface MonitorEntryLike {
  readonly kind?: string
  readonly enabled?: boolean
  readonly thresholdMs?: number
  readonly pollIntervalMs?: number
  readonly timeoutMs?: number
}

interface MonitorConfigLike {
  readonly defaultTimeoutMs?: number
  readonly monitors?: ReadonlyArray<MonitorEntryLike>
}

export function getBashLongRunningConfig(
  cfg: { readonly monitor?: MonitorConfigLike } | undefined,
): ResolvedBashLongRunningConfig {
  const monitor = cfg?.monitor
  const entries = monitor?.monitors ?? []
  // Find the first matching entry, then resolve the enabled flag from
  // that entry (even if disabled). A user who explicitly disables the
  // bash-long-running monitor via config must see the disable honored
  // — falling back to "enabled" because the disabled entry was
  // filtered out would silently re-enable it.
  const firstMatch = entries.find((e) => e?.kind === "bash-long-running")
  const enabled = firstMatch ? firstMatch.enabled !== false : true
  if (firstMatch && firstMatch.enabled === false) {
    // Explicitly disabled — return the defaults but with `enabled: false`
    // so the bash tool's monitor fiber short-circuits. We deliberately
    // don't apply the per-Entry threshold/timeoutMs overrides because
    // the monitor is off; the values are inert until re-enabled.
    return {
      enabled: false,
      thresholdMs: firstMatch.thresholdMs ?? DEFAULT_BASH_LONG_RUNNING_THRESHOLD_MS,
      pollIntervalMs: firstMatch.pollIntervalMs ?? DEFAULT_BASH_LONG_RUNNING_POLL_INTERVAL_MS,
      timeoutMs: firstMatch.timeoutMs ?? monitor?.defaultTimeoutMs ?? DEFAULT_BASH_LONG_RUNNING_TIMEOUT_MS,
    }
  }
  const thresholdMs = firstMatch?.thresholdMs ?? DEFAULT_BASH_LONG_RUNNING_THRESHOLD_MS
  const pollIntervalMs = firstMatch?.pollIntervalMs ?? DEFAULT_BASH_LONG_RUNNING_POLL_INTERVAL_MS
  const timeoutMs =
    firstMatch?.timeoutMs ?? monitor?.defaultTimeoutMs ?? DEFAULT_BASH_LONG_RUNNING_TIMEOUT_MS
  return { enabled, thresholdMs, pollIntervalMs, timeoutMs }
}