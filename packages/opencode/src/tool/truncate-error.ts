// Standalone helper used by the tool wrap (tool.ts) to cap the
// validation-error string that a tool can emit back to the model.
// A single malformed call with a 50KB zod error previously blew the
// model's context with the error text. Keep this dependency-free so
// it's unit-testable without the opencode workspace deps.

const MAX_VALIDATION_ERROR_CHARS = 2_000

export function truncateError(error: unknown, max = MAX_VALIDATION_ERROR_CHARS): string {
  const text = error instanceof Error ? error.message : String(error)
  if (text.length <= max) return text
  return text.slice(0, max) + `... (truncated ${text.length - max} chars)`
}

export { MAX_VALIDATION_ERROR_CHARS }
