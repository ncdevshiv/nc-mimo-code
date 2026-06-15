// ToolFailureRepair — the deps-free core of the T25 sub-actor
// (prompt + parser + types). The actual sub-actor invocation
// (spawning a child session via the actor.run machinery) is T28's
// work. Splitting it this way:
//   - T25 (this file): the parts most likely to have a subtle
//     bug (bad prompt template, bad JSON recovery). Pure, deps-
//     free, standalone-testable.
//   - T28: the plumbing that calls `actor.run({ agent: "tool-
//     failure-repair", ... })` and pipes the response through
//     `parseRepairResult`. This file's `buildRepairPrompt` and
//     `parseRepairResult` are the public surface that T28 will
//     use.
//
// The two halves are deliberately decoupled: T28 can be developed
// in parallel with T25 (e.g. T28 implements the actor-bridge
// shared by all dispatcher kinds while T25 is being reviewed).
// The contract between them is the `RepairRequest` and
// `RepairResult` types below.

import { z } from "zod"

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
 */
const REPAIR_SYSTEM_PROMPT = `You are repairing a malformed tool call that another language model produced.

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
