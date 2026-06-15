// Standalone helper for model-readable ZodError formatting. Kept
// deps-free so the standalone test can import it without needing
// `@nc-mimo-code/shared/*` (the test env in cycle 4 doesn't install
// the full workspace; see MEMORY-miMoCode-test-infra.md).
//
// Used by both the strict 3 tools (task/actor/workflow, via
// `formatDiscriminatedUnionError` here) and the plain `z.object`
// tools (read/edit/write/bash/webfetch/history/memory/question/
// skill/patch/multiedit/invalid, via `formatZodError` here).
//
// Re-exported from `tool/tool.ts` for the public surface.

import z from "zod"

/**
 * One-line description of a schema field, used by `formatZodError` to
 * give the model a recovery hint when its input fails validation. The
 * `type` is a human-readable shape (`"string"`, `"number"`, `"boolean"`,
 * `"object"`, `"array of string"`, etc.). The `required` flag tells the
 * model whether omitting the field is allowed.
 */
export interface FieldHint {
  type: string
  required?: boolean
  values?: readonly string[]
  note?: string
}

/**
 * Build a model-readable `formatValidationError` for a tool whose
 * schema is a plain `z.object(...)` (no `strictObject` and no
 * discriminated-union envelope). The default ZodError stringification
 * dumps the full issues array, which is verbose and unfriendly for an
 * LLM that needs to recover. This formatter:
 *
 *   - lists every issue, with the dotted path and what was wrong
 *   - shows the expected type and (for enums) the allowed values
 *   - shows the "required keys" summary so the model can see at a
 *     glance what it's missing
 *   - caps per-issue verbosity by using short labels
 *
 * Pass `hints` to teach the formatter about the tool's fields. Keys
 * are the schema field names; values are `FieldHint` describing the
 * expected type. Without hints, the formatter still works but the
 * model only sees the path + code (less helpful for picking the
 * right shape).
 *
 * Intended to be passed as `Tool.Def.formatValidationError`:
 *   parameters,
 *   formatValidationError: formatZodError({
 *     command: { type: "string", required: true },
 *     timeout: { type: "number", required: false },
 *   }),
 */
export function formatZodError(
  hints: Record<string, FieldHint> = {},
): (error: z.ZodError) => string {
  return (error) => {
    const lines: string[] = []
    lines.push("Your call did not match the expected schema. Details:")
    for (const issue of error.issues) {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)"
      const hint = path === "(root)" ? undefined : hints[issue.path[0]!]
      const typeHint = hint ? ` (expected ${hint.type})` : ""
      const valuesHint =
        hint?.values && hint.values.length > 0
          ? ` (one of: ${hint.values.map((v) => `"${v}"`).join(", ")})`
          : ""
      const noteHint = hint?.note ? ` — ${hint.note}` : ""
      switch (issue.code) {
        case "unrecognized_keys":
          lines.push(
            `  - ${path}: unknown key(s): ${(issue.keys as string[]).map((k) => `"${k}"`).join(", ")}.${noteHint}`,
          )
          break
        case "invalid_type":
          lines.push(
            `  - ${path}: got ${JSON.stringify(issue.received)}, expected ${issue.expected}${typeHint}.${noteHint}`,
          )
          break
        case "invalid_string":
          lines.push(
            `  - ${path}: ${issue.message}${typeHint}${valuesHint}.${noteHint}`,
          )
          break
        case "too_small":
          lines.push(
            `  - ${path}: must be ${issue.inclusive ? ">=" : ">"} ${issue.minimum}${hint ? ` (${hint.type})` : ""}.${noteHint}`,
          )
          break
        case "too_big":
          lines.push(
            `  - ${path}: must be ${issue.inclusive ? "<=" : "<"} ${issue.maximum}${hint ? ` (${hint.type})` : ""}.${noteHint}`,
          )
          break
        case "invalid_enum_value":
          lines.push(
            `  - ${path}: "${issue.received}" is not one of ${issue.options.map((o) => `"${o}"`).join(", ")}${valuesHint}.${noteHint}`,
          )
          break
        case "custom":
          lines.push(`  - ${path}: ${issue.message}${noteHint}`)
          break
        default:
          lines.push(`  - ${path}: ${issue.message}${typeHint}${noteHint}`)
      }
    }
    const requiredFields = Object.entries(hints)
      .filter(([, h]) => h.required !== false)
      .map(([k]) => `"${k}"`)
    if (requiredFields.length > 0 && requiredFields.length <= 8) {
      lines.push("")
      lines.push(`Required keys: ${requiredFields.join(", ")}.`)
    }
    return lines.join("\n")
  }
}

/**
 * Build a model-readable `formatValidationError` for a tool whose
 * schema is a `z.strictObject({ operation: z.discriminatedUnion("action", [...]) })`
 * — the shape used by task, actor, and workflow. The default ZodError
 * stringification dumps the full issues array (e.g. "unrecognized_keys: ..."
 * for every leaked top-level key), which is verbose and unfriendly for an
 * LLM that needs to recover. This formatter extracts the unrecognized keys,
 * lists the accepted actions, and shows a minimal example.
 *
 * Intended to be passed as `Tool.Def.formatValidationError`:
 *   parameters,
 *   formatValidationError: formatDiscriminatedUnionError(["create","list",...]),
 */
export function formatDiscriminatedUnionError(
  actions: readonly string[],
): (error: z.ZodError) => string {
  return (error) => {
    const unknown = new Set<string>()
    let discriminatorMissing = false
    for (const issue of error.issues) {
      if (issue.code === "unrecognized_keys") {
        for (const k of issue.keys) unknown.add(k)
      }
      if (issue.code === "invalid_type" && issue.path.length === 0) {
        discriminatorMissing = true
      }
    }
    const lines: string[] = []
    lines.push(
      `Schema accepts exactly one "operation" key, whose value is an object with an "action" discriminator.`,
    )
    lines.push(`Accepted actions: ${actions.join(" | ")}.`)
    if (unknown.size > 0) {
      const list = Array.from(unknown)
        .map((k) => `"${k}"`)
        .join(", ")
      lines.push(`Unknown top-level keys in your call: ${list}.`)
    }
    if (discriminatorMissing) {
      lines.push(`Your call is missing the required "operation" object.`)
    }
    const example = JSON.stringify({ operation: { action: actions[0] } })
    lines.push(`Example of a valid call: ${example}`)
    return lines.join("\n")
  }
}
