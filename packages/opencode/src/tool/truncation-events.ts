// Bus event published by the truncation directory's background
// cleanup fiber after each tick. Subscribers (health/metrics layers,
// the TUI's debug view) can use this to surface disk-usage stats or
// alert when cleanup keeps failing.

import z from "zod"
import { BusEvent } from "../bus/bus-event"

export const TruncationCleanup = BusEvent.define(
  "tool.truncation.cleanup",
  z.object({
    /** Number of files removed in this tick. */
    removed: z.number().int().nonnegative(),
    /** Files remaining in the truncation directory after the tick. */
    remainingFiles: z.number().int().nonnegative(),
    /** Total bytes still on disk after the tick. */
    remainingBytes: z.number().int().nonnegative(),
    /** True when the tick completed without error. */
    ok: z.boolean(),
    /** Error message when ok is false. */
    error: z.string().optional(),
  }),
)