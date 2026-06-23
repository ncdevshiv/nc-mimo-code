export * as ConfigToolBudget from "./tool-budget"

import { Schema } from "effect"
import { zod } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"

/**
 * Per-tool output budgets.
 *
 * Every tool in `src/tool/` historically hardcoded its own `MAX_BYTES`,
 * `MAX_LINES`, `MAX_RESULT_COUNT` style constants. For very large
 * projects (10K+ files, 10M+ LOC) those caps were too tight — the
 * LLM saw truncated output and lost context.
 *
 * This module exposes every cap through the config layer so a single
 * `opencode.json` edit can re-tune the agent for the project size.
 * Defaults still come from the per-tool source constants (kept in
 * sync by `tool-budget-resolve.ts`), so users who never touch this
 * section see zero behavior change.
 *
 * Resolution order (highest priority first):
 *   1. Per-tool override here (`toolBudget.read.maxBytes`, etc.)
 *   2. Uniform multiplier from `NC_MIMO_CODE_TOOL_OUTPUT_BUDGET`
 *      (applied to byte caps only; non-byte fields like result count
 *      are unaffected).
 *   3. Hardcoded tool defaults (`Truncate.MAX_BYTES`, etc.).
 *
 * All numeric fields use the standard `PositiveInt` constraint —
 * zod rejects 0, negatives, and non-integers at parse time.
 */
const PositiveInt = Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThan(0))

const ReadSchema = Schema.Struct({
  maxBytes: Schema.optional(PositiveInt).annotate({
    description:
      "Hard cap on total bytes returned by a single `read` call. Default: 51200 (50 KiB). Raise to 262144 or more for huge source files.",
  }),
  maxLines: Schema.optional(PositiveInt).annotate({
    description:
      "Default number of lines returned when the LLM omits `limit`. Per-call `limit` is still honored. Default: 2000.",
  }),
  maxLineLength: Schema.optional(PositiveInt).annotate({
    description:
      "Truncate any individual line longer than this many characters. Default: 2000.",
  }),
}).pipe(withStatics((s) => ({ zod: zod(s) })))

const GrepSchema = Schema.Struct({
  maxResults: Schema.optional(PositiveInt).annotate({
    description:
      "Maximum number of grep matches returned to the LLM. Default: 100. Raise to 500–2000 for big codebases.",
  }),
  maxLineLength: Schema.optional(PositiveInt).annotate({
    description: "Truncate any individual match line longer than this. Default: 2000.",
  }),
}).pipe(withStatics((s) => ({ zod: zod(s) })))

const GlobSchema = Schema.Struct({
  maxResults: Schema.optional(PositiveInt).annotate({
    description:
      "Maximum number of glob paths returned. Default: 100. Raise for repos with deep directory trees.",
  }),
}).pipe(withStatics((s) => ({ zod: zod(s) })))

const BashSchema = Schema.Struct({
  maxBytes: Schema.optional(PositiveInt).annotate({
    description:
      "Hard cap on bash tool output bytes before truncation kicks in. Default: 51200 (50 KiB).",
  }),
  maxLines: Schema.optional(PositiveInt).annotate({
    description: "Hard cap on bash tool output lines before truncation. Default: 2000.",
  }),
  maxMetadataLength: Schema.optional(PositiveInt).annotate({
    description:
      "Maximum characters of bash tool metadata (description, exit code, etc.) kept per turn. Default: 30000.",
  }),
}).pipe(withStatics((s) => ({ zod: zod(s) })))

const CodesearchSchema = Schema.Struct({
  maxQueryChars: Schema.optional(PositiveInt).annotate({
    description:
      "Maximum characters accepted in a codesearch query (zod `.max()` bound). Default: 50000.",
  }),
  maxResults: Schema.optional(PositiveInt).annotate({
    description: "Maximum number of code search results returned. Default: 5.",
  }),
}).pipe(withStatics((s) => ({ zod: zod(s) })))

const WebfetchSchema = Schema.Struct({
  maxBytes: Schema.optional(PositiveInt).annotate({
    description:
      "Hard cap on webfetch response body size. Default: 5242880 (5 MiB). Lower this for hostile/unknown URLs.",
  }),
  maxTimeoutMs: Schema.optional(PositiveInt).annotate({
    description: "Maximum allowed webfetch timeout in milliseconds. Default: 120000 (2 min).",
  }),
}).pipe(withStatics((s) => ({ zod: zod(s) })))

const WebsearchSchema = Schema.Struct({
  maxResults: Schema.optional(PositiveInt).annotate({
    description: "Maximum number of websearch results returned. Default: 8.",
  }),
  maxTimeoutMs: Schema.optional(PositiveInt).annotate({
    description: "Maximum allowed websearch timeout in milliseconds. Default: 120000 (2 min).",
  }),
  maxContextChars: Schema.optional(PositiveInt).annotate({
    description:
      "Default `contextMaxCharacters` for the websearch tool (LLM-optimized context string size). Default: 10000.",
  }),
}).pipe(withStatics((s) => ({ zod: zod(s) })))

const HistorySchema = Schema.Struct({
  maxResults: Schema.optional(PositiveInt).annotate({
    description:
      "Hard cap on the `limit` parameter for the history tool. Default: 50 (zod description).",
  }),
  aroundMaxBytes: Schema.optional(PositiveInt).annotate({
    description:
      "Bytes cap on `history.around` output before truncation. Default: 20480 (20 KiB).",
  }),
}).pipe(withStatics((s) => ({ zod: zod(s) })))

const MemorySchema = Schema.Struct({
  maxResults: Schema.optional(PositiveInt).annotate({
    description: "Default and maximum number of memory search results. Default: 10.",
  }),
}).pipe(withStatics((s) => ({ zod: zod(s) })))

const SkillSchema = Schema.Struct({
  maxResults: Schema.optional(PositiveInt).annotate({
    description:
      "Maximum number of skill files surfaced per `skill` call. Default: 10.",
  }),
}).pipe(withStatics((s) => ({ zod: zod(s) })))

/**
 * Truncation-directory management knobs. These govern the cleanup
 * fiber that runs every hour inside the truncation service — not
 * the per-tool output caps (those live on the per-tool schemas
 * above).
 */
const TruncationSchema = Schema.Struct({
  maxDirBytes: Schema.optional(PositiveInt).annotate({
    description:
      "Maximum total bytes allowed in the truncation directory. Once exceeded, cleanup removes oldest files until under the cap. Default: 104857600 (100 MiB).",
  }),
  retentionDays: Schema.optional(PositiveInt).annotate({
    description:
      "Truncation files older than this many days are removed on each cleanup tick. Default: 7.",
  }),
  minThresholdBytes: Schema.optional(PositiveInt).annotate({
    description:
      "Skip the disk write when truncation overshoot is at or below this many bytes — useful for tiny overshoots that don't warrant a saved file. Default: 1024 (1 KiB).",
  }),
}).pipe(withStatics((s) => ({ zod: zod(s) })))

const InfoSchema = Schema.Struct({
  read: Schema.optional(ReadSchema).annotate({
    description: "Budget overrides for the `read` tool.",
  }),
  grep: Schema.optional(GrepSchema).annotate({
    description: "Budget overrides for the `grep` tool.",
  }),
  glob: Schema.optional(GlobSchema).annotate({
    description: "Budget overrides for the `glob` tool.",
  }),
  bash: Schema.optional(BashSchema).annotate({
    description: "Budget overrides for the `bash` tool.",
  }),
  codesearch: Schema.optional(CodesearchSchema).annotate({
    description: "Budget overrides for the `codesearch` tool.",
  }),
  webfetch: Schema.optional(WebfetchSchema).annotate({
    description: "Budget overrides for the `webfetch` tool.",
  }),
  websearch: Schema.optional(WebsearchSchema).annotate({
    description: "Budget overrides for the `websearch` tool.",
  }),
  history: Schema.optional(HistorySchema).annotate({
    description: "Budget overrides for the `history` tool.",
  }),
  memory: Schema.optional(MemorySchema).annotate({
    description: "Budget overrides for the `memory` tool.",
  }),
  skill: Schema.optional(SkillSchema).annotate({
    description: "Budget overrides for the `skill` tool.",
  }),
  truncation: Schema.optional(TruncationSchema).annotate({
    description: "Truncation directory management (size cap, retention, min-threshold).",
  }),
}).pipe(withStatics((s) => ({ zod: zod(s) })))

export const Info = InfoSchema
export type Info = Schema.Schema.Type<typeof InfoSchema>

export const Read = ReadSchema
export type Read = Schema.Schema.Type<typeof ReadSchema>
export const Grep = GrepSchema
export type Grep = Schema.Schema.Type<typeof GrepSchema>
export const Glob = GlobSchema
export type Glob = Schema.Schema.Type<typeof GlobSchema>
export const Bash = BashSchema
export type Bash = Schema.Schema.Type<typeof BashSchema>
export const Codesearch = CodesearchSchema
export type Codesearch = Schema.Schema.Type<typeof CodesearchSchema>
export const Webfetch = WebfetchSchema
export type Webfetch = Schema.Schema.Type<typeof WebfetchSchema>
export const Websearch = WebsearchSchema
export type Websearch = Schema.Schema.Type<typeof WebsearchSchema>
export const History = HistorySchema
export type History = Schema.Schema.Type<typeof HistorySchema>
export const Memory = MemorySchema
export type Memory = Schema.Schema.Type<typeof MemorySchema>
export const Skill = SkillSchema
export type Skill = Schema.Schema.Type<typeof SkillSchema>
export const Truncation = TruncationSchema
export type Truncation = Schema.Schema.Type<typeof TruncationSchema>