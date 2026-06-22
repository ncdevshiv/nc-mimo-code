// LLM-transcript log — per-session JSONL log of every LLM request and
// response that flows through `session/llm.ts`. Each line is a JSON
// object with the shape:
//
//   { ts, sessionID, messageID, role, model, request, response, raw_chunks, tool_calls }
//
// The audit's §4 LLM-transcript log feature. The log is the single
// source of truth for "what exactly did the model send, including the
// raw request body, the raw response body, and the raw tool-call
// argument JSON?" — answering the user-facing debugging question that
// the rendered transcript (cli/cmd/tui/util/transcript.ts) cannot
// answer (the transcript elides raw fields).
//
// Storage: `Global.Path.log/sessions/<sessionID>.jsonl` (one line per
// LLM-message-boundary event; the file is append-only and rotated
// when it exceeds `config.log.maxBytesPerFile`).
//
// `request` / `response` are stored as raw JSON when the provider
// supports `includeRawChunks`. `raw_chunks` (optional) is the
// per-chunk raw stream bodies captured from the AI SDK's
// `fullStream` when `includeRawChunks` is enabled. The flag is
// exposed in two ways:
//   1. Per-SDK `providerOptions[<sdk-key>].includeRawChunks` (e.g.
//      `providerOptions.copilot.includeRawChunks`). The in-tree
//      Copilot SDK paths (`provider/sdk/copilot/*`) emit raw parts
//      deterministically from the SSE wire format.
//   2. Top-level `streamText({ includeRawChunks: true })` — the AI
//      SDK 6 stream wrapper synthesizes raw parts for every upstream
//      SDK (`@ai-sdk/openai`, `@ai-sdk/anthropic`, etc.) without any
//      per-provider plumbing. The `session/llm.ts` call site passes
//      this when the per-session flag is on.
// The `session/llm.ts:onFinish` callback consumes `result.fullStream`,
// filters `{ type: "raw" }` parts, and writes them to `raw_chunks`
// here. The `request` / `response` fields stay as the AI SDK's
// normalized `LanguageModelResponseMetadata` regardless.
//
// Redaction: the `Authorization`, `Cookie`, and any `sensitive`-tagged
// keys are stripped before write. The list is configurable via
// `config.log.redactKeys` (defaults to the standard set).
//
// Retention: 30 days by default, configurable via
// `config.log.retentionDays`. The `purgeExpired` helper runs on
// every LLM call (cheap, only touches the session's own file)
// and deletes the file when it is older than the retention window.
//
// Disabled by default — the LLM-transcript log adds disk I/O per
// request. Enable via `config.log.enabled = true` (or the equivalent
// CLI flag `--log-sessions`). When disabled the logger is a no-op
// (the `append` function returns immediately).

import { appendFile, mkdir, readFile, stat, unlink } from "fs/promises"
import { join, dirname } from "path"
import { Global } from "@/global"
import { Log } from "@/util"

const log = Log.create({ service: "llm-log" })

const REDACTED = '"[REDACTED]"'

// Default set of lowercased keys whose values are redacted. The
// module-level `redactKeys` set is seeded with these at module load
// and may be replaced wholesale via `setRedactKeys(...)` from the
// boot-time wire-up (`effect/wire-app-transcript-log.ts`). The
// comparison is always case-insensitive.
const DEFAULT_REDACT_KEYS = [
  "Authorization",
  "Cookie",
  "Set-Cookie",
  "X-Api-Key",
  "api-key",
  "apikey",
  "password",
  "token",
  "access_token",
  "refresh_token",
]

// Lowercased once at module load. `redact` compares each input key
// (lowercased) against this set; the original case is preserved in the
// output so the redacted field still appears in the JSON
// (just with the value replaced).
let redactKeys: ReadonlySet<string> = new Set(DEFAULT_REDACT_KEYS.map((k) => k.toLowerCase()))

/**
 * Redact sensitive keys from an arbitrary JSON value. Replaces
 * matching keys (case-insensitive) with the `[REDACTED]` marker.
 * Walks objects and arrays recursively; primitives are returned
 * as-is. The original structure is preserved.
 */
export function redact(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map(redact)
  if (typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (redactKeys.has(k.toLowerCase())) {
        out[k] = REDACTED
      } else {
        out[k] = redact(v)
      }
    }
    return out
  }
  return value
}

/**
 * Replace the redact-keys set wholesale. Keys are matched
 * case-insensitively. Pass `undefined` to reset to the default set
 * (`Authorization`, `Cookie`, `Set-Cookie`, `X-Api-Key`, `api-key`,
 * `apikey`, `password`, `token`, `access_token`, `refresh_token`).
 * Used by the boot-time wire-up so `config.log.redactKeys` overrides
 * the defaults.
 */
export function setRedactKeys(keys: ReadonlyArray<string> | undefined): void {
  redactKeys = new Set((keys ?? DEFAULT_REDACT_KEYS).map((k) => k.toLowerCase()))
}

export interface TranscriptEvent {
  /** Unix epoch milliseconds. */
  readonly ts: number
  readonly sessionID: string
  readonly messageID: string
  readonly role: "user" | "assistant" | "tool" | "system"
  readonly model?: { providerID: string; modelID: string }
  /** The raw request body when `includeRawChunks` is enabled; otherwise
   * the structured `messages` array. Always redacted before write. */
  readonly request: unknown
  /** The raw response body when `includeRawChunks` is enabled;
   * otherwise the structured `content` / `tool_calls` parts. */
  readonly response: unknown
  /**
   * Per-chunk raw SSE / transport bodies captured from the AI SDK's
   * `fullStream` when `includeRawChunks` is enabled. Each entry has
   * the shape `{ type: "raw", rawValue: <string|object> }` as
   * defined by the AI SDK v3 stream protocol. Persisted only when the
   * flag is on at LLM-call time; otherwise the field is omitted.
   * Always redacted before write. See `session/llm.ts:onFinish`.
   */
  readonly raw_chunks?: ReadonlyArray<{ type: "raw"; rawValue: unknown }>
  /** Tool calls extracted from the response (for grep-ability). */
  readonly tool_calls?: Array<{ toolName: string; args: unknown }>
}

let enabled = false
let logDirOverride: string | undefined
let includeRawChunks = false

/**
 * Enable / disable the transcript log. Disabled by default to
 * avoid per-request disk I/O; enable via `config.log.enabled = true`.
 * Tests call this to enable the log in isolation; production code
 * reads the config flag and calls this at boot.
 */
export function setEnabled(value: boolean): void {
  enabled = value
}

/**
 * Enable / disable raw-chunk capture. When true, providers whose SDK
 * respects `includeRawChunks` (currently only the in-tree GitHub
 * Copilot SDK) emit raw SSE chunk bodies as `{type: "raw", rawValue}`
 * stream parts, which `session/llm.ts` persists to the transcript log
 * in place of (or alongside) the structured `messages`. PR-2 step 1.
 */
export function setIncludeRawChunks(value: boolean): void {
  includeRawChunks = value
}

/**
 * Read the current raw-chunk capture flag. PR-2 step 1.
 */
export function getIncludeRawChunks(): boolean {
  return includeRawChunks
}

/**
 * Override the log directory. Used by tests to redirect writes to a
 * temp directory; production code does not call this. Pass
 * `undefined` to reset to the default (`Global.Path.log/sessions`).
 */
export function setLogDir(dir: string | undefined): void {
  logDirOverride = dir
}

/**
 * Append a transcript event to the per-session JSONL log. No-op
 * when the log is disabled. Creates the `sessions/` directory on
 * first write. Failures are logged but never thrown — a broken
 * log must not fail the LLM call.
 */
export async function append(event: TranscriptEvent): Promise<void> {
  if (!enabled) return
  const file = transcriptPath(event.sessionID)
  const line =
    JSON.stringify({
      ...event,
      request: redact(event.request),
      response: redact(event.response),
      raw_chunks: event.raw_chunks ? redact(event.raw_chunks) : undefined,
    }) + "\n"
  try {
    await mkdir(dirname(file), { recursive: true })
    await appendFile(file, line, "utf8")
  } catch (err) {
    log.warn("failed to write transcript event", {
      sessionID: event.sessionID,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

function transcriptPath(sessionID: string): string {
  // `logDirOverride` is the test-only redirect (set by
  // `setLogDir`). If unset, use the default
  // `Global.Path.log/sessions`. If `Global.Path.log` is unavailable
  // (test env, partial init), fall back to `.` so the read path
  // returns [] instead of throwing — the worst case is a write
  // to the cwd, which the test suite avoids by always calling
  // `setLogDir(testDir)` in beforeEach.
  const base = logDirOverride ?? (Global.Path?.log ? join(Global.Path.log, "sessions") : ".")
  return join(base, `${sessionID}.jsonl`)
}

// Note: `dirname` is the standard `path.dirname` from the import at
// the top of the file. Do NOT define a local `function dirname`
// here — a previous version of this file had a forward-slashes-only
// `dirname` that shadowed the import and broke the Windows tests
// (`mkdir('.', {recursive: true})` failed with EEXIST because the
// path `C:\Users\...\sess.jsonl` has no forward slashes). If you
// need a custom dirname, rename it to `parentDir` to avoid the
// shadow.

// Public surface — re-exported under the `TranscriptLog` namespace
// so callers do `TranscriptLog.append(...)`, `TranscriptLog.read(...)`,
// etc. Keeping the public surface in a namespace means adding a new
// helper doesn't force every call site to update its import list.
export const TranscriptLog = {
  append,
  read,
  purgeExpired,
  redact,
  setEnabled,
  setLogDir,
  setRedactKeys,
  setIncludeRawChunks,
  getIncludeRawChunks,
} as const

/**
 * Read all events for a session (returns the full file as parsed
 * JSONL). Used by the `nc-mimo-code llm-log <sessionID>` CLI
 * subcommand. Returns an empty array if the file doesn't exist.
 */
export async function read(sessionID: string): Promise<TranscriptEvent[]> {
  const file = transcriptPath(sessionID)
  try {
    const text = await readFile(file, "utf8")
    return text
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as TranscriptEvent)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return []
    throw err
  }
}

/**
 * Delete the per-session log if it is older than `maxAgeMs`. Called
 * lazily on every `append` (the per-session check is cheap; the
 * stat call is on the same file we're about to write to).
 */
export async function purgeExpired(sessionID: string, maxAgeMs: number): Promise<void> {
  const file = transcriptPath(sessionID)
  try {
    const s = await stat(file)
    if (Date.now() - s.mtimeMs > maxAgeMs) {
      await unlink(file)
      log.info("purged expired transcript log", { sessionID, ageMs: Date.now() - s.mtimeMs })
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
  }
}
