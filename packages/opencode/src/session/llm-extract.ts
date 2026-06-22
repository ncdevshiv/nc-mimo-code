/**
 * Pure helpers for extracting structured data from AI SDK 5 streamText
 * responses. PR-2 step 2 — fixes the `tool_calls: undefined` field on
 * `TranscriptEvent` so the existing `nc-mimo-code llm-log --tool-call`
 * filter actually works.
 *
 * Why a separate file:
 *   - The helpers are pure (no Effect runtime), so they can be unit-tested
 *     without the full app-runtime scaffold.
 *   - They may grow as PR-2 adds more extractors (request-shape capture,
 *     reasoning extraction, etc.).
 *   - Keeps `session/llm.ts` (already 800+ lines) from growing further.
 *
 * The AI SDK 5 `onFinish({ response, ... })` shape:
 *   - `response` is an array of `AssistantContent` parts (text, tool-call,
 *     reasoning, etc.).
 *   - Each tool-call part has `type: "tool-call"`, `toolName: string`,
 *     and `input: unknown` (the parsed args).
 *   - Some SDK versions also expose `providerExecuted` and `toolCallId`
 *     fields; we only emit `{ toolName, args }` per `TranscriptEvent`.
 */

export interface ExtractedToolCall {
  toolName: string
  args: unknown
}

/**
 * Walk an AI SDK 5 response (array of `AssistantContent`) and emit one
 * `{ toolName, args }` entry per tool-call part. Order-preserving.
 * Returns an empty array when no tool calls were issued.
 *
 * Tolerates `undefined` and non-array inputs (older SDK shapes, mock
 * responses in tests) — the helper never throws.
 */
export function extractToolCalls(response: unknown): ExtractedToolCall[] {
  if (!Array.isArray(response)) return []
  const out: ExtractedToolCall[] = []
  for (const part of response) {
    if (!part || typeof part !== "object") continue
    const partRecord = part as Record<string, unknown>
    if (partRecord.type !== "tool-call") continue
    const toolName = typeof partRecord.toolName === "string" ? partRecord.toolName : ""
    if (!toolName) continue
    out.push({ toolName, args: partRecord.input })
  }
  return out
}