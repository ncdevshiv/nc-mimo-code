// Bus events for the bash long-running monitor. The bash tool
// publishes `BashStarted` when a child process is spawned and
// `BashExited` when the child terminates (or is killed/times out).
// The monitor layer subscribes to these events, applies the
// configured threshold, and asks a sub-actor whether the command
// is making progress, looks suspicious, or should be killed.

import z from "zod"
import { BusEvent } from "../bus/bus-event"

export const BashStarted = BusEvent.define(
  "tool.bash.started",
  z.object({
    sessionID: z.string(),
    messageID: z.string(),
    callID: z.string(),
    command: z.string().min(1),
    description: z.string().optional(),
    pid: z.number().int().positive(),
    startedAt: z.number().int().positive(),
  }),
)

export const BashExited = BusEvent.define(
  "tool.bash.exited",
  z.object({
    sessionID: z.string(),
    messageID: z.string(),
    callID: z.string(),
    pid: z.number().int().positive(),
    exitCode: z.number().int().nullable(),
    /**
     * Reason the child terminated. "exit" = clean exit, "kill" =
     * explicit kill (e.g. SIGTERM from the long-running monitor),
     * "timeout" = hit the bash tool's own timeout, "abort" =
     * upstream abort signal fired.
     */
    reason: z.enum(["exit", "kill", "timeout", "abort"]),
  }),
)

/**
 * `BashLongRunningWarn` is published by the long-running monitor
 * when the sub-actor returns `kind: "warn"`. The TUI subscribes
 * and renders a non-blocking banner. The main session is NOT
 * interrupted — the bash command continues running; the user is
 * just notified.
 */
export const BashLongRunningWarn = BusEvent.define(
  "tool.bash.long-running.warn",
  z.object({
    sessionID: z.string(),
    messageID: z.string(),
    callID: z.string(),
    reason: z.string().min(1),
    elapsedMs: z.number().int().nonnegative(),
  }),
)
