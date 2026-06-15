// BashLongRunning — the deps-free core of the T26 sub-actor
// (prompt + parser + types). The actual sub-actor invocation
// (spawning a child session via the actor.run machinery) is T28's
// work. The same split as T25:
//
//   - T26 (this file): the parts most likely to have a subtle bug
//     (the prompt template, the JSON recovery). Pure, deps-free,
//     standalone-testable.
//   - T28: the plumbing that calls `actor.run({ agent: "bash-long-
//     running", ... })`, polls the running command for status,
//     and pipes the response through `parseAssessment`.
//
// The contract between the two halves is the `AssessmentRequest`
// and `Assessment` types below.
//
// Why this monitor exists: when a user asks the LLM to run a bash
// command, the command can hang (network stuck, paged input, dead
// lock). A LLM waiting 30 minutes for a hung `npm install` and
// then timing out is a poor experience. The BashLongRunning
// sub-actor fires after the command has been running for at
// least `thresholdMs` and asks: "is this command making progress
// or is it stuck? If stuck, what should we do?" The dispatcher
// (T28) then either:
//   - Does nothing (continue): the command is making progress.
//   - Surfaces a warning to the main session (warn): the command
//     looks suspicious; the LLM should consider interrupting.
//   - Kills the command (terminate): the command is clearly hung
//     or dangerous (e.g. infinite loop, runaway network call).

import { z } from "zod"

export interface AssessmentRequest {
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

const ASSESSMENT_SYSTEM_PROMPT = `You are assessing a long-running bash command that has exceeded its time threshold.

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

const AssessmentResponse = z.union([
  z.strictObject({ continue: z.string().optional() }),
  z.strictObject({ warn: z.string().min(1) }),
  z.strictObject({ terminate: z.string().min(1) }),
])

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

  if ("continue" in result.data) {
    return { kind: "continue", reason: result.data.continue }
  }
  if ("warn" in result.data) {
    return { kind: "warn", reason: result.data.warn }
  }
  return { kind: "terminate", reason: result.data.terminate }
}
