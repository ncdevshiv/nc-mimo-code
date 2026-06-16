// BashLongRunning — the deps-free core of the T26 sub-actor
// (prompt + parser + types) AND the T28 dispatcher that calls the
// `MonitorBridge` to spawn a sub-actor. Splitting the prompt/parser
// (T26) from the dispatcher (T28) keeps the parts most likely to
// have a subtle bug (bad prompt template, bad JSON recovery) pure
// and standalone-testable, while the dispatcher is a thin pass-
// through that delegates to the existing `Actor.Service`.
//
// The two halves are deliberately decoupled: T28 can be developed
// in parallel with T26. The contract between them is the
// `AssessmentRequest` and `Assessment` types below; the dispatcher
// additionally uses the `MonitorBridge` port (see
// `monitor/actor-bridge.ts`) to talk to the actor subsystem without
// depending on it directly.

import { Effect } from "effect"
import { z } from "zod"
import { getMonitorBridge } from "./actor-bridge"

export interface AssessmentRequest {
  readonly sessionID: string
  readonly command: string
  readonly pid?: number
  readonly elapsedMs: number
  readonly outputTail?: string
  readonly description?: string
}

export type Assessment =
  | { readonly kind: "continue"; readonly reason?: string }
  | { readonly kind: "warn"; readonly reason: string }
  | { readonly kind: "terminate"; readonly reason: string }

/**
 * The system prompt for the long-running bash monitor. Exported
 * (not just a module-local constant) so the agent registry can
 * install it as the `bash-long-running` sub-agent's system prompt
 * at boot time. Mirrors `monitor/tool-failure-repair.ts`'s
 * export pattern.
 */
export const ASSESSMENT_SYSTEM_PROMPT = `You are assessing a long-running bash command that has exceeded its time threshold.

Your task: based on the command, the elapsed time, and (if available) the recent output, decide whether the command is making progress, looks suspicious, or is clearly hung.

Decision rules:
  1. \`continue\` — the command is doing what it should and is making progress. Examples: \`npm install\` at 5 minutes, \`cargo build\` at 10 minutes, \`tar xf large-file.tar\` at 3 minutes.
  2. \`warn\` — the command looks suspicious or is taking longer than expected. Examples: \`npm install\` at 30 minutes with no progress, \`curl https://...\` at 5 minutes with a download that should be seconds.
  3. \`terminate\` — the command is clearly hung, in an infinite loop, or is dangerous. Examples: a \`while true; do ...; done\` with no break, a fork bomb, a network call that has been retrying for an hour.

Default to \`continue\` if the command is plausibly making progress. False positives (warning when everything is fine) are worse than false negatives (missing a stuck command) — the user can always check the bash output directly.

Output format (strict, exactly one):

  - \`{"continue": "<optional note>"}\`
  - \`{"warn": "<one-sentence reason>"}\`
  - \`{"terminate": "<one-sentence reason>"}\`

Do not add any explanation, code fence, or markdown around the output. Just the JSON object.`

export function buildAssessmentPrompt(req: AssessmentRequest): string {
  const elapsedSec = Math.round(req.elapsedMs / 1000)
  const elapsedMin = Math.floor(elapsedSec / 60)
  const elapsedStr =
    elapsedMin > 0 ? `${elapsedMin}m ${elapsedSec % 60}s` : `${elapsedSec}s`

  const parts: string[] = [
    `Command (running for ${elapsedStr}):`,
    "```bash",
    req.command,
    "```",
  ]

  if (req.pid !== undefined) {
    parts.push(``, `Process id: \`${req.pid}\``)
  }

  if (req.description) {
    parts.push(``, `User's intent: ${req.description}`)
  }

  if (req.outputTail) {
    parts.push(
      ``,
      `Recent output (last ${req.outputTail.length} bytes):`,
      "```",
      req.outputTail,
      "```",
    )
  } else {
    parts.push(``, `(no output tail available)`)
  }

  parts.push(``, `Return one of: continue, warn, or terminate.`)
  return parts.join("\n")
}

export function buildAssessmentSystemPrompt(): string {
  return ASSESSMENT_SYSTEM_PROMPT
}

// Use a less-strict schema that zod 4 narrows cleanly. The
// discriminator is the presence of the `continue`, `warn`, or
// `terminate` key. The exact shape (zod 4 issue with z.strictObject
// unions and keyof narrowing) is handled by a single object
// schema with optional fields and runtime property checks below.
const AssessmentResponse = z.object({
  continue: z.string().optional(),
  warn: z.string().optional(),
  terminate: z.string().optional(),
})

export function parseAssessment(output: string): Assessment | null {
  if (typeof output !== "string" || output.length === 0) return null

  let text = output.trim()
  const fenceMatch = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/)
  if (fenceMatch) text = fenceMatch[1]!.trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }

  const result = AssessmentResponse.safeParse(parsed)
  if (!result.success) return null

  // Pick the first present discriminator key. Exactly one of
  // `continue`, `warn`, `terminate` is expected; if multiple are
  // present, prefer terminate > warn > continue (the more
  // conservative action wins).
  const data = result.data as {
    continue?: string
    warn?: string
    terminate?: string
  }
  if (data.terminate !== undefined) {
    return { kind: "terminate", reason: data.terminate }
  }
  if (data.warn !== undefined) {
    return { kind: "warn", reason: data.warn }
  }
  if (data.continue !== undefined) {
    return { kind: "continue", reason: data.continue }
  }
  return null
}

// ─────────────────────────────────────────────────────────────────
// T28: dispatcher — calls the bridge to spawn a sub-actor and
// translates the outcome into an `Assessment`. Mirrors the
// `ToolFailureRepair.spawn` contract so a future bash-tap
// dispatcher can reuse the same bridge port.
// ─────────────────────────────────────────────────────────────────

/** Mirror of `monitor/actor-bridge.ts`'s `SpawnInput` (kept inline
 * so the public type from this module is self-describing). */
export interface SpawnInput {
  readonly sessionID: string
  readonly agentType: string
  readonly description: string
  readonly task: string
  readonly timeoutMs: number
}

const BASH_LONG_RUNNING_AGENT = "bash-long-running" as const
const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Optional dependencies for `spawn`. The `bridge` defaults to
 * `getMonitorBridge()`; `timeoutMs` defaults to 30s. Tests inject
 * a fake bridge via `deps.bridge` to avoid booting the runtime.
 */
export interface SpawnDeps {
  readonly bridge?: import("./actor-bridge").MonitorBridge
  readonly timeoutMs?: number
}

/**
 * Translate a `MonitorSpawnResult` to an `Assessment`. Pulls the
 * model output from `finalText` (or `structured` if the spawn used
 * a `format` option), then runs it through `parseAssessment`.
 *
 * Maps every non-`success` bridge status to `{kind: "continue"}`
 * (the conservative default — a hung or failing sub-actor is
 * treated as "the bash is making progress" so the dispatcher
 * doesn't kill the user's command because the LLM monitor had
 * a problem).
 */
function assessmentFromBridge(outcome: import("./actor-bridge").MonitorSpawnResult): Assessment {
  if (outcome.status !== "success") {
    return { kind: "continue", reason: `monitor sub-actor ${outcome.status}` }
  }
  const raw =
    outcome.structured !== undefined
      ? typeof outcome.structured === "string"
        ? outcome.structured
        : JSON.stringify(outcome.structured)
      : outcome.finalText
  if (raw === undefined || raw.length === 0) {
    return { kind: "continue", reason: "monitor sub-actor produced no output" }
  }
  const parsed = parseAssessment(raw)
  if (parsed) return parsed
  return { kind: "continue", reason: "monitor sub-actor output did not match the strict shape" }
}

/**
 * Spawn the bash-long-running sub-actor and return its
 * `Assessment`. Synchronous from the caller's perspective (it
 * `await`s the bridge).
 *
 * Like `ToolFailureRepair.spawn`, the dispatcher's contract is:
 * never throw on a parse/parse-shape failure; only throw if the
 * bridge itself cannot be invoked (which means the monitor
 * layer was never installed — a hard programming error).
 */
export async function spawn(req: AssessmentRequest, deps: SpawnDeps = {}): Promise<Assessment> {
  const bridge = deps.bridge ?? getMonitorBridge()
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const outcome = await Effect.runPromise(
    bridge.spawn({
      sessionID: req.sessionID,
      agentType: BASH_LONG_RUNNING_AGENT,
      description: BASH_LONG_RUNNING_AGENT,
      task: buildAssessmentPrompt(req),
      timeoutMs,
    }),
  )

  return assessmentFromBridge(outcome)
}
