import { describe, test, expect } from "bun:test"
import {
  getBashLongRunningConfig,
  DEFAULT_BASH_LONG_RUNNING_THRESHOLD_MS,
  DEFAULT_BASH_LONG_RUNNING_POLL_INTERVAL_MS,
  DEFAULT_BASH_LONG_RUNNING_TIMEOUT_MS,
} from "../../src/monitor/bash-long-running-config"

describe("getBashLongRunningConfig", () => {
  test("returns hard-coded defaults when cfg is undefined", () => {
    const result = getBashLongRunningConfig(undefined)
    expect(result.enabled).toBe(true)
    expect(result.thresholdMs).toBe(DEFAULT_BASH_LONG_RUNNING_THRESHOLD_MS)
    expect(result.pollIntervalMs).toBe(DEFAULT_BASH_LONG_RUNNING_POLL_INTERVAL_MS)
    expect(result.timeoutMs).toBe(DEFAULT_BASH_LONG_RUNNING_TIMEOUT_MS)
  })

  test("returns hard-coded defaults when cfg.monitor is empty", () => {
    const result = getBashLongRunningConfig({ monitor: {} })
    expect(result.thresholdMs).toBe(DEFAULT_BASH_LONG_RUNNING_THRESHOLD_MS)
    expect(result.pollIntervalMs).toBe(DEFAULT_BASH_LONG_RUNNING_POLL_INTERVAL_MS)
    expect(result.timeoutMs).toBe(DEFAULT_BASH_LONG_RUNNING_TIMEOUT_MS)
  })

  test("returns hard-coded defaults when no matching entry exists", () => {
    const result = getBashLongRunningConfig({
      monitor: { monitors: [{ kind: "tool-failure-repair" }, { kind: "custom" }] },
    })
    expect(result.thresholdMs).toBe(DEFAULT_BASH_LONG_RUNNING_THRESHOLD_MS)
  })

  test("uses a matching entry's threshold and pollIntervalMs", () => {
    const result = getBashLongRunningConfig({
      monitor: {
        monitors: [
          {
            kind: "bash-long-running",
            enabled: true,
            thresholdMs: 120_000,
            pollIntervalMs: 60_000,
          },
        ],
      },
    })
    expect(result.thresholdMs).toBe(120_000)
    expect(result.pollIntervalMs).toBe(60_000)
    expect(result.enabled).toBe(true)
  })

  test("falls back to defaultTimeoutMs when no matching entry exists", () => {
    const result = getBashLongRunningConfig({
      monitor: { defaultTimeoutMs: 45_000, monitors: [{ kind: "tool-failure-repair" }] },
    })
    expect(result.timeoutMs).toBe(45_000)
  })

  test("an explicit entry.timeoutMs wins over the global defaultTimeoutMs", () => {
    const result = getBashLongRunningConfig({
      monitor: {
        defaultTimeoutMs: 45_000,
        monitors: [{ kind: "bash-long-running", timeoutMs: 10_000 }],
      },
    })
    expect(result.timeoutMs).toBe(10_000)
  })

  test("entry.enabled === false disables the monitor", () => {
    const result = getBashLongRunningConfig({
      monitor: { monitors: [{ kind: "bash-long-running", enabled: false }] },
    })
    expect(result.enabled).toBe(false)
  })

  test("entry without enabled defaults to enabled (when matching)", () => {
    const result = getBashLongRunningConfig({
      monitor: { monitors: [{ kind: "bash-long-running" }] },
    })
    expect(result.enabled).toBe(true)
  })

  test("picks the first matching entry when multiple are present", () => {
    const result = getBashLongRunningConfig({
      monitor: {
        monitors: [
          { kind: "bash-long-running", thresholdMs: 10_000 },
          { kind: "bash-long-running", thresholdMs: 50_000 },
        ],
      },
    })
    expect(result.thresholdMs).toBe(10_000)
  })

  test("when the first matching entry is disabled, the monitor is disabled (not picking the next)", () => {
    // Semantic: an explicit `enabled: false` on the first matching
    // entry wins — we don't silently fall through to the next row.
    // The user has explicitly disabled the bash-long-running monitor
    // at this threshold; honoring that disable takes priority over
    // picking up overrides from a later row.
    const result = getBashLongRunningConfig({
      monitor: {
        monitors: [
          { kind: "bash-long-running", enabled: false, thresholdMs: 10_000 },
          { kind: "bash-long-running", thresholdMs: 25_000 },
        ],
      },
    })
    expect(result.enabled).toBe(false)
    expect(result.thresholdMs).toBe(10_000)
  })
})