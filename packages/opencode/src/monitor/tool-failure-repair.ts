// ToolFailureRepair — the deps-free core of the T25 sub-actor
// (prompt + parser + types), plus the T28 dispatcher that calls
// the `MonitorBridge` to spawn a sub-actor and pipes the response
// through `parseRepairResult`. Splitting the prompt/parser (T25)
// from the dispatcher (T28) keeps the parts most likely to have
// a subtle bug (bad prompt template, bad JSON recovery) pure and
// standalone-testable, while the dispatcher is a thin pass-through
// that delegates to the existing `Actor.Service`.
//
// The two halves are deliberately decoupled: T28 can be developed
// in parallel with T25. The contract between them is the
// `RepairRequest` and `RepairResult` types below; the dispatcher
// additionally uses the `MonitorBridge` port (see
// `monitor/actor-bridge.ts`) to talk to the actor subsystem without
// depending on it directly.

import { Effect } from "effect"
import { z } from "zod"
import { getMonitorBridge } from "./actor-bridge"

// ─────────────────────────────────────────────────────────────────
// Public input / output types
// ─────────────────────────────────────────────────────────────────

/**
 * The minimal payload the repair sub-LLM needs: the tool's name
 * (so it can describe what the model was trying to do), the
 * original call (the broken input the model produced), the
 * validation error (the Zod issue array, already formatted via the
 * T29 formatZodError helper), and the tool's JSON schema (so the
 * model can pick the right shape). Schema is passed as the
 * runtime-emitted JSON Schema (the same one the LLM sees in the
 * tool-call contract).
 */
export interface RepairRequest {
  readonly tool: string
  readonly input: unknown
  readonly error: string
  readonly schema: unknown
}

/**
 * The sub-LLM's response. Either a corrected input (parsed JSON
 * that should now pass the tool's validation), or a structured
 * "unfixable" with a reason (the model can't repair the call from
 * the available context — e.g. it needs user input, or the error
 * is unrecoverable). `parseRepairResult` maps the raw text output
 * to one of these.
 */
export type RepairResult =
  | { readonly kind: "repaired"; readonly input: unknown }
  | { readonly kind: "unfixable"; readonly reason: string }

// ─────────────────────────────────────────────────────────────────
// Prompt construction (deps-free)
// ─────────────────────────────────────────────────────────────────

/**
 * The system prompt for the repair sub-LLM. Kept as a constant
 * because every tool failure uses the same template (only the
 * `{{tool}}`, `{{error}}`, `{{schema}}`, `{{input}}` slots vary).
 *
 * The prompt's design:
 *
 *   1. Name the task explicitly: "you are repairing a malformed
 *      tool call".
 *   2. Give the schema (so the model can pick a valid shape).
 *   3. Give the original call (so the model sees what it sent).
 *   4. Give the validation error (already formatted via T29's
 *      formatZodError, so it's model-readable).
 *   5. Demand a strict output format: either `{"input": {...}}`
 *      with the corrected JSON, or `{"unfixable": "<reason>"}`.
 *
 * The strict output format is critical: the parseRepairResult
 * function relies on the model emitting exactly one of these two
 * shapes, and any deviation is logged as "unfixable" (the model
 * should not be trusted to repair a tool call if it can't even
 * follow a 2-line output contract).
 *
 * Exported (not just a module-local constant) so the agent
 * registry can install it as the `tool-failure-repair` sub-agent's
 * system prompt at boot time.
 */
export const REPAIR_SYSTEM_PROMPT = `You are repairing a malformed tool call that another language model produced.

Your task: given the tool's schema, the original call, and the validation error, return either the corrected input object or a structured "unfixable" reason.

Rules:
  1. The corrected input MUST be valid against the schema. Re-read the schema and the error before responding.
  2. Preserve the original intent. If the model wanted to read a file, the repaired call should still be a "read" of that file. Do not silently change the semantic of the call.
  3. If the error says "must differ" or "must be >= X" or "not a valid enum", the original call has a value-level error, not a shape-level error. Fix the value.
  4. If the model wrote the wrong key name (e.g. "filepath" instead of "filePath"), fix the key.
  5. If the error is unrecoverable from context alone (e.g. "missing required field 'command'" and there's no plausible value to fill in), return unfixable.
  6. NEVER invent a value. If the original call is missing a required field and you can't infer it, return unfixable.

Output format (strict, exactly one):

  - If you fixed the call: \`{"input": <corrected object>}\`
  - If you can't fix the call: \`{"unfixable": "<one-sentence reason>"}\`

Do not add any explanation, code fence, or markdown around the output. Just the JSON object.`

/**
 * Build the user-message half of the sub-LLM prompt (the
 * system-prompt is the constant above; the user-message is the
 * per-call context). Pure function: same input, same output.
 *
 * Why a user-message and not just one big system-message: the
 * system-message is the policy; the user-message is the data.
 * Keeping them separate makes the data easy to log + diff for
 * debugging.
 */
export function buildRepairPrompt(req: RepairRequest): string {
  const schemaStr = JSON.stringify(req.schema, null, 2)
  const inputStr = JSON.stringify(req.input, null, 2)
  return [
    `Tool: \`${req.tool}\``,
    ``,
    `Original call (the one that failed validation):`,
    "```json",
    inputStr,
    "```",
    ``,
    `Validation error (already formatted for model readability):`,
    "```",
    req.error,
    "```",
    ``,
    `Tool's JSON schema (the one the call must conform to):`,
    "```json",
    schemaStr,
    "```",
    ``,
    `Return the corrected \`input\` object, or \`{"unfixable": "<reason>"}\`.`,
  ].join("\n")
}

/**
 * Expose the system prompt (used by the dispatcher to build the
 * sub-actor's full prompt). Kept as a separate function so the
 * test can verify the policy is exactly the expected string (and
 * not, say, accidentally truncated).
 */
export function buildRepairSystemPrompt(): string {
  return REPAIR_SYSTEM_PROMPT
}

// ─────────────────────────────────────────────────────────────────
// Response parsing (deps-free)
// ─────────────────────────────────────────────────────────────────

/**
 * The sub-LLM's response schema (Zod). Strict — extra fields are
 * not allowed (the sub-LLM is told to return exactly one of two
 * shapes; any deviation is a parse failure that surfaces as
 * unfixable). Uses `z.strictObject` to reject extra fields (in
 * zod 4, the default is `passthrough`, which would silently accept
 * `{input: ..., extra: ...}` — the sub-LLM is told not to do that
 * and the parser enforces it).
 */
const RepairResponse = z.union([
  z.strictObject({
    input: z.unknown(),
  }),
  z.strictObject({
    unfixable: z.string().min(1),
  }),
])

/**
 * Parse the sub-LLM's text output. The sub-LLM is told to return
 * exactly one of two JSON shapes, with no markdown fence, no
 * explanation. The parser:
 *
 *   1. Trims whitespace (the model may add a leading newline or
 *      trailing newline; we ignore).
 *   2. Strips a code fence if the model wrapped its output in
 *      one (this is a common LLM behavior even when told not to;
 *      rather than reject, we recover).
 *   3. JSON.parse.
 *   4. Zod-validate against RepairResponse.
 *
 * Returns `null` on any failure. The dispatcher logs + drops in
 * that case (the original error flows back to the main session
 * unchanged).
 *
 * The function is intentionally lenient on the input shape (so
 * a model that wraps in a code fence still works) but strict on
 * the parsed object (extra fields fail; missing fields fail).
 */
export function parseRepairResult(output: string): RepairResult | null {
  if (typeof output !== "string" || output.length === 0) return null

  // Strip the whitespace and the code fence.
  let text = output.trim()
  const fenceMatch = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/)
  if (fenceMatch) text = fenceMatch[1]!.trim()

  // Parse JSON.
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }

  // Validate against the strict schema.
  const result = RepairResponse.safeParse(parsed)
  if (!result.success) return null

  if ("input" in result.data) {
    return { kind: "repaired", input: result.data.input }
  }
  return { kind: "unfixable", reason: result.data.unfixable }
}

// ─────────────────────────────────────────────────────────────────
// T28: dispatcher — calls the bridge to spawn a sub-actor and
// translates the outcome into a `RepairResult`. The default
// `SpawnDeps` use the global `MonitorBridge`; tests inject a
// fake bridge to exercise the dispatcher end-to-end without
// booting the runtime.
// ─────────────────────────────────────────────────────────────────

/**
 * Optional dependencies for `spawn`. All fields have production
 * defaults that pull from the process-global `MonitorBridge`; tests
 * inject fakes. `timeoutMs` defaults to 30s (matches the audit's
 * Phase 1 default; tuned for a single repair attempt — too long and
 * the LLM is left waiting, too short and a busy model times out).
 */
export interface SpawnDeps {
  readonly bridge?: import("./actor-bridge").MonitorBridge
  readonly timeoutMs?: number
  /** Session id under which the sub-actor runs. The bridge passes it
   * through to `Actor.spawn` so the sub-actor can read parent state
   * (transcript, etc.) if its `context` mode allows. */
  readonly sessionID: string
}

const DEFAULT_TIMEOUT_MS = 30_000
const REPAIR_AGENT = "tool-failure-repair" as const

/**
 * Build the LLM-facing `RepairResult` from a `MonitorSpawnResult`.
 * Pulls the JSON text from `finalText` (or `structured` if the spawn
 * used a `format` option), then runs it through `parseRepairResult`.
 *
 * Maps every non-`success` bridge status to an `unfixable` result
 * with a descriptive reason — the caller's safety net (the `invalid`
 * tool fallback) treats `unfixable` and `repaired` distinctly, so
 * the dispatcher never returns a raw bridge error.
 */
function resultFromBridge(outcome: import("./actor-bridge").MonitorSpawnResult): RepairResult {
  if (outcome.status === "failure") {
    return { kind: "unfixable", reason: `sub-actor failed: ${outcome.error ?? "unknown error"}` }
  }
  if (outcome.status === "cancelled") {
    return { kind: "unfixable", reason: "sub-actor was cancelled" }
  }
  if (outcome.status === "timeout") {
    return { kind: "unfixable", reason: "sub-actor timed out before producing a result" }
  }

  // status === "success" — pull the text. `structured` takes precedence
  // when the spawn used the json_schema format (the validated object is
  // the authoritative result; the text is just whatever preamble the
  // model emitted around the tool call).
  const raw =
    outcome.structured !== undefined
      ? typeof outcome.structured === "string"
        ? outcome.structured
        : JSON.stringify(outcome.structured)
      : outcome.finalText
  if (raw === undefined || raw.length === 0) {
    return { kind: "unfixable", reason: "sub-actor produced no output" }
  }

  const parsed = parseRepairResult(raw)
  if (parsed) return parsed
  return {
    kind: "unfixable",
    reason: "sub-actor output did not match the strict `{\"input\": ...}` or `{\"unfixable\": ...}` shape",
  }
}

/**
 * Spawn the tool-failure-repair sub-actor and return the LLM-driven
 * repair outcome. Synchronous from the caller's perspective (it
 * `await`s the bridge), but the bridge is async-by-nature (the AI
 * SDK's `experimental_repairToolCall` callback is itself `async`).
 *
 * Three failure modes are folded into `RepairResult.kind === "unfixable"`:
 *   - the bridge itself throws (re-thrown after this fn returns — the
 *     caller decides whether to fall through to the `invalid` tool or
 *     re-raise);
 *   - the sub-actor reports `failure`, `cancelled`, or `timeout`;
 *   - the sub-actor's output doesn't parse.
 *
 * The dispatcher's contract is: never throw on a parse/parse-shape
 * failure; only throw if the bridge itself cannot be invoked (which
 * means the monitor layer was never installed — a hard programming
 * error).
 */
export async function spawn(req: RepairRequest, deps: SpawnDeps): Promise<RepairResult> {
  const bridge = deps.bridge ?? getMonitorBridge()
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const outcome = await Effect.runPromise(
    bridge.spawn({
      sessionID: deps.sessionID,
      agentType: REPAIR_AGENT,
      description: REPAIR_AGENT,
      task: buildRepairPrompt(req),
      timeoutMs,
    }),
  )

  return resultFromBridge(outcome)
}

export * as ToolFailureRepair from "./tool-failure-repair"
