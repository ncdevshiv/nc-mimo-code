export * as ConfigMonitor from "./monitor"

import { Schema } from "effect"
import { zod } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"

const MonitorKind = Schema.Literals(["tool-failure-repair", "bash-long-running", "custom"])

/**
 * Per-monitor config entry. Mirrors the discriminated union in
 * src/monitor/service.ts (MonitorConfig) so the config layer
 * and the runtime layer agree on the shape.
 *
 * Defaults applied at the runtime layer (resolveConfig in
 * service.ts); the config layer accepts partial entries.
 */
const EntrySchema = Schema.Struct({
  kind: MonitorKind,
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Whether this monitor is enabled. Default: true.",
  }),
  event: Schema.String.annotate({
    description: "The bus event type to listen on (e.g. 'tool.error', 'bash.start').",
  }),
  filter: Schema.optional(Schema.String).annotate({
    description: "Optional JavaScript expression evaluated against the event payload. Return true to fire the monitor. Example: 'p.code === \"validation\"'.",
  }),
  timeoutMs: Schema.optional(Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThan(0))).annotate({
    description: "Timeout in milliseconds for the sub-actor. Default: 30_000.",
  }),
  thresholdMs: Schema.optional(Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThan(0))).annotate({
    description: "BashLongRunning: threshold in ms for what counts as 'long running'. Default: 60_000.",
  }),
  pollIntervalMs: Schema.optional(Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThan(0))).annotate({
    description: "BashLongRunning: how often to poll the running command. Default: 30_000.",
  }),
  agentType: Schema.optional(Schema.String).annotate({
    description: "Custom: the agent type to spawn. Default: 'general'.",
  }),
  promptTemplate: Schema.optional(Schema.String).annotate({
    description: "Custom: the prompt template. Use {{event.type}} and {{event.payload}} placeholders.",
  }),
}).pipe(withStatics((s) => ({ zod: zod(s) })))

export const Entry = EntrySchema
export type Entry = Schema.Schema.Type<typeof Entry>

/**
 * Top-level monitor config. Has a list of user-defined monitor
 * entries plus a few global defaults. The runtime layer (T24
 * integration) loads the config, registers each entry as a
 * monitor trigger, and applies the defaults to per-entry
 * partial configs.
 */
export const InfoSchema = Schema.Struct({
  defaultTimeoutMs: Schema.optional(Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThan(0))).annotate({
    description: "Default timeout (ms) for monitor sub-actors. Default: 30_000.",
  }),
  monitors: Schema.optional(Schema.Array(Entry)).annotate({
    description: "User-defined monitor entries. The built-in monitors (tool-failure-repair, bash-long-running) are registered by default; this list ADDS to them (you can override their settings or add custom ones).",
  }),
}).pipe(withStatics((s) => ({ zod: zod(s) })))

export const Info = InfoSchema
export type Info = Schema.Schema.Type<typeof InfoSchema>