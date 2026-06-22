export * as ConfigLog from "./log"

import { Schema } from "effect"
import { zod } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"

/**
 * Configuration for the LLM-transcript log (audit §4).
 *
 * The log is the single source of truth for "what exactly did the
 * model send, including the raw request body, the raw response body,
 * and the raw tool-call argument JSON?" — answering the user-facing
 * debugging question that the rendered transcript (cli/tui/util/transcript.ts)
 * cannot answer (the rendered view elides raw fields).
 *
 * Storage: `Global.Path.log/sessions/<sessionID>.jsonl` (one line per
 * LLM-message-boundary event; the file is append-only).
 *
 * Defaults applied here match the constants previously embedded in
 * `monitor/llm-transcript.ts`. The schema mirrors `ConfigMonitor.Info`
 * (self-export pattern, `Schema.optional(...).annotate({ description })`,
 * positive-int checks, `withStatics` for the `.zod` accessor).
 */
const InfoSchema = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description:
      "Whether to write the per-session LLM-transcript log to disk. Disabled by default to avoid per-request disk I/O. Default: false.",
  }),
  includeRawChunks: Schema.optional(Schema.Boolean).annotate({
    description:
      "Pass `includeRawChunks: true` through to providers that support it (currently only the in-tree GitHub Copilot SDK paths). When enabled, raw SSE chunk bodies are persisted to the transcript log so the user can see exactly what bytes crossed the wire — not just the structured `messages`. Silently dropped for providers whose SDK does not respect this flag. Default: false.",
  }),
  retentionDays: Schema.optional(Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThan(0))).annotate({
    description:
      "How long to retain transcript files before purging. The purge-expired hook runs on every assistant message and deletes the session's file when it is older than this window. Default: 30 days.",
  }),
  maxBytesPerFile: Schema.optional(Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThan(0))).annotate({
    description:
      "Soft cap on a single transcript file's size in bytes. Writes beyond this cap are appended (rotation is a future feature; today this is informational). Default: 52_428_800 (50 MiB).",
  }),
  redactKeys: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description:
      "Lowercased JSON keys whose values are redacted before write. The default set covers Authorization, Cookie, Set-Cookie, X-Api-Key, api-key, apikey, password, token, access_token, refresh_token. Setting this replaces the default set entirely.",
  }),
  path: Schema.optional(Schema.String).annotate({
    description:
      "Override the directory where transcript files are written. Defaults to `<Global.Path.log>/sessions`. Useful for tests and for redirecting the log to a project-local path.",
  }),
}).pipe(withStatics((s) => ({ zod: zod(s) })))

export const Info = InfoSchema
export type Info = Schema.Schema.Type<typeof InfoSchema>