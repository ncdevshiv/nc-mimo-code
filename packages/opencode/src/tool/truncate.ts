import { NodePath } from "@effect/platform-node"
import { Cause, Duration, Effect, Layer, Option, Schedule, Context } from "effect"
import path from "path"
import type { Agent } from "../agent/agent"
import { AppFileSystem } from "@nc-mimo-code/shared/filesystem"
import { evaluate } from "@/permission/evaluate"
import { Identifier } from "../id/id"
import { Log } from "../util"
import { ToolID } from "./schema"
import { TRUNCATION_DIR } from "./truncation-dir"
import { Bus } from "@/bus"
import { TruncationCleanup } from "./truncation-events"

const log = Log.create({ service: "truncation" })
const RETENTION_DAYS_FALLBACK = 7

export const MAX_LINES = 2000
export const MAX_BYTES = 50 * 1024
export const DIR = TRUNCATION_DIR
export const GLOB = path.join(TRUNCATION_DIR, "*")

export const ERROR_PATTERN = /error|exception|failed|fatal|traceback|panic|exit code/i
export const TAIL_SCAN_CHARS = 2048

/**
 * Local fallback knobs. The authoritative source for these values
 * lives in `config/tool-budget-resolve.ts`. We define them locally
 * rather than importing to avoid a circular dependency: the resolver
 * already imports `Truncate.MAX_BYTES` from this file. Tests can
 * override by reading `BUDGET.truncation.*` from
 * `@/config/tool-budget-resolve` directly.
 */
const DEFAULT_RETENTION_DAYS = 7
const DEFAULT_MAX_DIR_BYTES = 100 * 1024 * 1024
const DEFAULT_MIN_THRESHOLD_BYTES = 1024

export type Result = { content: string; truncated: false } | { content: string; truncated: true; outputPath?: string }

export interface Options {
  maxLines?: number
  maxBytes?: number
  direction?: "head" | "tail" | "head+tail"
  pressureCaps?: boolean
  /**
   * Skip the disk write when the truncation overshoot is at or below
   * this many bytes. Useful for tiny overshoots (a 50.1KB output on a
   * 50KB cap) where writing a full 50KB file to disk isn't worth
   * it. The preview is still returned, but `outputPath` is omitted
   * and `truncated` is still `true`. Defaults to the value resolved
   * from `BUDGET.truncation.minThresholdBytes`.
   */
  minThresholdBytes?: number
}

/**
 * Build the saved-file name for a truncation entry. `tool` is sanitized to
 * `[A-Za-z0-9_-]` so a stray `/` or unicode character can't escape the
 * truncation dir. When `tool` is omitted, the name is just the bare ULID
 * (preserves the pre-tool-name filename shape for the cleanup pass).
 */
export function truncationFileName(tool: string | undefined, id: string): string {
  const safe = tool ? tool.replaceAll(/[^a-zA-Z0-9_-]/g, "_") : undefined
  return safe ? `tool_${safe}_${id}` : id
}

function hasActorTool(agent?: Agent.Info) {
  if (!agent?.permission) return false
  return evaluate("actor", "*", agent.permission).action !== "deny"
}

// ---------- Pure helpers ----------
//
// These were extracted from the inline truncation logic in `output`
// so the bash service can reuse them without depending on the Effect
// service. All four are deterministic and side-effect-free.

/**
 * Pick the leading `maxLines` lines from `text`, staying under
 * `maxBytes` (UTF-8 byte count). Returns the joined preview plus the
 * number of bytes that were dropped.
 */
export function selectHead(
  text: string,
  maxLines: number,
  maxBytes: number,
): { content: string; removedBytes: number; removedLines: number; hitByteCap: boolean } {
  const lines = text.split("\n")
  const out: string[] = []
  let bytes = 0
  let hitByteCap = false
  for (let i = 0; i < lines.length && out.length < maxLines; i++) {
    const size = Buffer.byteLength(lines[i], "utf-8") + (i > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      hitByteCap = true
      break
    }
    out.push(lines[i])
    bytes += size
  }
  const removedBytes = Math.max(0, Buffer.byteLength(text, "utf-8") - bytes)
  const removedLines = Math.max(0, lines.length - out.length)
  return { content: out.join("\n"), removedBytes, removedLines, hitByteCap }
}

/**
 * Pick the trailing `maxLines` lines from `text`, staying under
 * `maxBytes`. When a single line alone exceeds `maxBytes`, the
 * returned preview is the UTF-8-safe tail slice of that line.
 *
 * Returns `cut: false` when the input was already small enough that
 * nothing was dropped (the caller can use this to skip the
 * `head+tail` rewrite path).
 */
export function selectTail(
  text: string,
  maxLines: number,
  maxBytes: number,
): { content: string; removedBytes: number; removedLines: number; cut: boolean } {
  const lines = text.split("\n")
  const totalBytes = Buffer.byteLength(text, "utf-8")
  if (lines.length <= maxLines && totalBytes <= maxBytes) {
    return { content: text, removedBytes: 0, removedLines: 0, cut: false }
  }

  const out: string[] = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      if (out.length === 0) {
        // UTF-8 boundary-safe slice of a single oversized line.
        const buf = Buffer.from(lines[i], "utf-8")
        let start = buf.length - maxBytes
        if (start < 0) start = 0
        while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
        out.unshift(buf.subarray(start).toString("utf-8"))
      }
      break
    }
    out.unshift(lines[i])
    bytes += size
  }
  return {
    content: out.join("\n"),
    removedBytes: Math.max(0, totalBytes - bytes),
    removedLines: Math.max(0, lines.length - out.length),
    cut: true,
  }
}

/**
 * 70/30 head+tail split when the trailing `tailScanChars` of `text`
 * match `errorPattern`. Returns `applied: false` when no error
 * pattern is found, signalling the caller to fall back to a plain
 * `selectHead` (this matches the behavior of the previous inline
 * implementation in `output`).
 */
export function selectHeadTailWithErrors(
  text: string,
  maxLines: number,
  maxBytes: number,
  errorPattern: RegExp,
  tailScanChars: number,
): {
  applied: boolean
  head: string
  tail: string
  headCount: number
  tailCount: number
  omittedLines: number
} {
  const tailScan = text.length > tailScanChars ? text.slice(-tailScanChars) : text
  if (!errorPattern.test(tailScan)) {
    return {
      applied: false,
      head: "",
      tail: "",
      headCount: 0,
      tailCount: 0,
      omittedLines: 0,
    }
  }
  const lines = text.split("\n")
  const headMaxLines = Math.floor(maxLines * 0.7)
  const headMaxBytes = Math.floor(maxBytes * 0.7)
  const tailMaxLines = maxLines - headMaxLines
  const tailMaxBytes = maxBytes - headMaxBytes

  // Head: walk forward, accumulating until either cap hits.
  const headOut: string[] = []
  let headBytes = 0
  for (let i = 0; i < lines.length && headOut.length < headMaxLines; i++) {
    const size = Buffer.byteLength(lines[i], "utf-8") + (i > 0 ? 1 : 0)
    if (headBytes + size > headMaxBytes) break
    headOut.push(lines[i])
    headBytes += size
  }

  // Tail: walk backward.
  const tailOut: string[] = []
  let tailBytes = 0
  for (let i = lines.length - 1; i >= 0 && tailOut.length < tailMaxLines; i--) {
    const size = Buffer.byteLength(lines[i], "utf-8") + (tailOut.length > 0 ? 1 : 0)
    if (tailBytes + size > tailMaxBytes) break
    tailOut.unshift(lines[i])
    tailBytes += size
  }

  return {
    applied: true,
    head: headOut.join("\n"),
    tail: tailOut.join("\n"),
    headCount: headOut.length,
    tailCount: tailOut.length,
    omittedLines: Math.max(0, lines.length - headOut.length - tailOut.length),
  }
}

// ---------- Service ----------

export interface Interface {
  readonly cleanup: () => Effect.Effect<void>
  /**
   * Writes `text` to the truncation directory. `tool` (optional) is the
   * tool id (e.g. "bash", "webfetch") and is folded into the filename so
   * a user listing the dir can tell which tool produced each file. Falls
   * back to the bare ULID-style id when omitted.
   */
  readonly write: (text: string, tool?: string) => Effect.Effect<string>
  /**
   * Returns output unchanged when it fits within the limits, otherwise writes the full text
   * to the truncation directory and returns a preview plus a hint to inspect the saved file.
   * `tool` is folded into the saved filename (see write).
   */
  readonly output: (text: string, options?: Options, agent?: Agent.Info, tool?: string) => Effect.Effect<Result>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Truncate") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    const cleanup = Effect.fn("Truncate.cleanup")(function* () {
      const retentionDays = DEFAULT_RETENTION_DAYS
      const maxDirBytes = DEFAULT_MAX_DIR_BYTES
      const cutoff = Identifier.timestamp(
        Identifier.create("tool", "ascending", Date.now() - Duration.toMillis(Duration.days(retentionDays))),
      )
      const entries = yield* fs.readDirectory(TRUNCATION_DIR).pipe(
        Effect.map((all) => all.filter((name) => name.startsWith("tool_"))),
        Effect.catch(() => Effect.succeed([])),
      )

      let removed = 0
      // Two-phase eviction:
      //   1. age-based: anything older than `retentionDays`
      //   2. size-based: oldest first until total bytes <= maxDirBytes

      // Phase 1: age-based
      const remaining: string[] = []
      for (const entry of entries) {
        if (Identifier.timestamp(entry) < cutoff) {
          yield* fs.remove(path.join(TRUNCATION_DIR, entry)).pipe(Effect.catch(() => Effect.void))
          removed += 1
        } else {
          remaining.push(entry)
        }
      }

      // Phase 2: size-based. Sort remaining by ascending timestamp
      // (oldest first) and drop until total bytes are under the cap.
      // ULID-style ids encode timestamp at the start, so lexicographic
      // sort == chronological sort.
      const sized = yield* Effect.forEach(
        remaining.sort(),
        (entry) =>
          Effect.gen(function* () {
            const stat = yield* fs.stat(path.join(TRUNCATION_DIR, entry)).pipe(
              Effect.catch(() => Effect.succeed(undefined)),
            )
            return { entry, size: stat ? Number(stat.size) : 0 }
          }),
        { concurrency: 8 },
      )
      let totalBytes = sized.reduce((acc, e) => acc + e.size, 0)
      while (totalBytes > maxDirBytes && sized.length > 0) {
        const oldest = sized.shift()
        if (!oldest) break
        yield* fs.remove(path.join(TRUNCATION_DIR, oldest.entry)).pipe(Effect.catch(() => Effect.void))
        removed += 1
        totalBytes -= oldest.size
      }
      const finalFiles = sized.length
      const finalBytes = totalBytes

      // Publish an event so subscribers (health, TUI debug) can see
      // how cleanup is going. Failure during publish is non-fatal
      // (subscribe failures are logged but don't fail cleanup). The
      // publish is optional — cleanup runs in tests that don't
      // provide Bus, and the Bus-less path simply skips the event.
      yield* Effect.serviceOption(Bus.Service).pipe(
        Effect.catch(() => Effect.succeed(Option.none())),
        Effect.flatMap((maybeBus) =>
          Option.isSome(maybeBus)
            ? maybeBus.value
                .publish(TruncationCleanup, {
                  removed,
                  remainingFiles: finalFiles,
                  remainingBytes: finalBytes,
                  ok: true,
                })
                .pipe(Effect.catch(() => Effect.void))
            : Effect.void,
        ),
      )
    })

    const write = Effect.fn("Truncate.write")(function* (text: string, tool?: string) {
      const file = path.join(TRUNCATION_DIR, truncationFileName(tool, ToolID.ascending()))
      yield* fs.ensureDir(TRUNCATION_DIR).pipe(Effect.orDie)
      yield* fs.writeFileString(file, text).pipe(Effect.orDie)
      return file
    })

    const output = Effect.fn("Truncate.output")(function* (
      text: string,
      options: Options = {},
      agent?: Agent.Info,
      tool?: string,
    ) {
      let maxLines = options.maxLines ?? MAX_LINES
      let maxBytes = options.maxBytes ?? MAX_BYTES
      const direction = options.direction ?? "head+tail"
      const pressureCaps = options.pressureCaps ?? false
      const minThreshold = options.minThresholdBytes ?? DEFAULT_MIN_THRESHOLD_BYTES

      if (pressureCaps) {
        maxLines = Math.floor(maxLines / 2)
        maxBytes = Math.floor(maxBytes / 2)
      }

      const lines = text.split("\n")
      const totalBytes = Buffer.byteLength(text, "utf-8")

      if (lines.length <= maxLines && totalBytes <= maxBytes) {
        return { content: text, truncated: false } as const
      }

      // Threshold check: if the overshoot is small enough, return
      // the preview without writing to disk. Caller still sees
      // `truncated: true` so the model knows output was capped.
      const overshoot = Math.max(totalBytes - maxBytes, 0)
      const skipWrite = minThreshold > 0 && overshoot <= minThreshold

      if (direction === "head+tail") {
        const split = selectHeadTailWithErrors(text, maxLines, maxBytes, ERROR_PATTERN, TAIL_SCAN_CHARS)
        if (split.applied) {
          if (skipWrite) {
            return {
              content:
                split.head +
                (split.omittedLines > 0
                  ? `\n\n... ${split.omittedLines} lines omitted — showing head and tail ...\n\n`
                  : "\n\n") +
                split.tail,
              truncated: true,
            } as const
          }
          const file = yield* write(text, tool)
          const hintText = hasActorTool(agent)
            ? `The tool call succeeded but the output was truncated. Full output saved to: ${file}\nUse the actor tool to have explore agent process this file with Grep and Read (with offset/limit). Do NOT read the full file yourself - delegate to save context.`
            : `The tool call succeeded but the output was truncated. Full output saved to: ${file}\nUse Grep to search the full content or Read with offset/limit to view specific sections.`
          return {
            content: `${split.head}\n\n... ${split.omittedLines} lines omitted — showing head and tail ...\n\n${split.tail}\n\n${hintText}`,
            truncated: true,
            outputPath: file,
          } as const
        }
        // No errors in tail: degrade to head behavior below.
      }

      const picked =
        direction === "tail"
          ? selectTail(text, maxLines, maxBytes)
          : (() => {
              const head = selectHead(text, maxLines, maxBytes)
              return {
                content: head.content,
                removedBytes: head.removedBytes,
                removedLines: head.removedLines,
                cut: head.hitByteCap || head.content.length < text.length,
                hitByteCap: head.hitByteCap,
              }
            })()

      // Pick the unit that better matches the dominant cause of
      // truncation. Byte cap triggered → "bytes" (matches what the
      // user wanted to bound); line cap triggered → "lines".
      const usedByteCap = (picked as { hitByteCap?: boolean }).hitByteCap === true
      const removed = usedByteCap ? picked.removedBytes : picked.removedLines
      const unit = usedByteCap ? "bytes" : "lines"
      const file = yield* skipWrite ? Effect.succeed(undefined) : write(text, tool)

      const hintText = hasActorTool(agent)
        ? `The tool call succeeded but the output was truncated${file ? `. Full output saved to: ${file}` : ""}.\nUse the actor tool to have explore agent process the rest${file ? ` of this file` : ""} with Grep and Read (with offset/limit). Do NOT read the full file yourself - delegate to save context.`
        : `The tool call succeeded but the output was truncated${file ? `. Full output saved to: ${file}` : ""}.\nUse Grep to search the full content or Read with offset/limit to view specific sections.`

      const baseContent =
        direction === "head" || direction === "head+tail"
          ? `${picked.content}\n\n...${removed} ${unit} truncated...\n\n${hintText}`
          : `...${removed} ${unit} truncated...\n\n${hintText}\n\n${picked.content}`

      return file
        ? ({
            content: baseContent,
            truncated: true,
            outputPath: file,
          } as const)
        : ({
            content: baseContent,
            truncated: true,
          } as const)
    })

    yield* cleanup().pipe(
      Effect.catchCause((cause) => {
        log.error("truncation cleanup failed", { cause: Cause.pretty(cause) })
        // Best-effort: surface a failure event so subscribers can see
        // the cleanup fiber is unhealthy. Skip if Bus is not provided
        // (test harnesses, bare-metal callers).
        return Effect.serviceOption(Bus.Service).pipe(
          Effect.catch(() => Effect.succeed(Option.none())),
          Effect.flatMap((maybeBus) =>
            Option.isSome(maybeBus)
              ? maybeBus.value
                  .publish(TruncationCleanup, {
                    removed: 0,
                    remainingFiles: 0,
                    remainingBytes: 0,
                    ok: false,
                    error: Cause.pretty(cause),
                  })
                  .pipe(Effect.catch(() => Effect.void), Effect.asVoid)
              : Effect.void,
          ),
        )
      }),
      Effect.repeat(Schedule.spaced(Duration.hours(1))),
      Effect.delay(Duration.minutes(1)),
      Effect.forkScoped,
    )

    return Service.of({ cleanup, write, output })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(AppFileSystem.defaultLayer), Layer.provide(NodePath.layer))