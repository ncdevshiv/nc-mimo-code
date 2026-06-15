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

export interface FieldHint {
  type: string
  required?: boolean
  values?: readonly string[]
  note?: string
}

export function formatZodError(
  hints: Record<string, FieldHint> = {},
): (error: z.ZodError) => string {
  return (error) => {
    const lines: string[] = []
    lines.push("Your call did not match the expected schema. Details:")
    for (const issue of error.issues) {
      // Cast to a permissive shape because zod 4 renamed several
      // issue codes (`invalid_string` -> `invalid_format`,
      // `invalid_enum_value` -> `invalid_value`) and the field
      // names on the issue objects (`received` -> `input`). The
      // runtime values are correct; we just lose compile-time
      // narrowing on the discriminator.
      const i = issue as unknown as {
        code: string
        path: ReadonlyArray<PropertyKey>
        message: string
        keys?: string[]
        expected?: string
        input?: unknown
        received?: unknown
        inclusive?: boolean
        minimum?: number | bigint
        maximum?: number | bigint
        options?: ReadonlyArray<unknown>
        [k: string]: unknown
      }
      const path = i.path.length > 0 ? i.path.map(String).join(".") : "(root)"
      const firstKey = i.path.length > 0 ? String(i.path[0]) : undefined
      const hint = firstKey === undefined ? undefined : hints[firstKey]
      const typeHint = hint ? ` (expected ${hint.type})` : ""
      const valuesHint =
        hint?.values && hint.values.length > 0
          ? ` (one of: ${hint.values.map((v) => `"${v}"`).join(", ")})`
          : ""
      const noteHint = hint?.note ? ` — ${hint.note}` : ""
      const received = "input" in i ? i.input : "received" in i ? i.received : undefined
      switch (i.code) {
        case "unrecognized_keys":
          lines.push(
            `  - ${path}: unknown key(s): ${((i.keys as string[] | undefined) ?? []).map((k) => `"${k}"`).join(", ")}.${noteHint}`,
          )
          break
        case "invalid_type":
          lines.push(
            `  - ${path}: got ${JSON.stringify(received)}, expected ${i.expected ?? "unknown"}${typeHint}.${noteHint}`,
          )
          break
        case "invalid_string":
        case "invalid_format":
          lines.push(
            `  - ${path}: ${i.message}${typeHint}${valuesHint}.${noteHint}`,
          )
          break
        case "too_small":
          lines.push(
            `  - ${path}: must be ${i.inclusive ? ">=" : ">"} ${String(i.minimum)}${hint ? ` (${hint.type})` : ""}.${noteHint}`,
          )
          break
        case "too_big":
          lines.push(
            `  - ${path}: must be ${i.inclusive ? "<=" : "<"} ${String(i.maximum)}${hint ? ` (${hint.type})` : ""}.${noteHint}`,
          )
          break
        case "invalid_enum_value":
        case "invalid_value":
          lines.push(
            `  - ${path}: ${JSON.stringify(received)} is not one of ${((i.options as ReadonlyArray<unknown> | undefined) ?? []).map((o) => `"${String(o)}"`).join(", ")}${valuesHint}.${noteHint}`,
          )
          break
        case "custom":
          lines.push(`  - ${path}: ${i.message}${noteHint}`)
          break
        default:
          lines.push(`  - ${path}: ${i.message}${typeHint}${noteHint}`)
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

export function formatDiscriminatedUnionError(
  actions: readonly string[],
): (error: z.ZodError) => string {
  return (error) => {
    const unknown = new Set<string>()
    let discriminatorMissing = false
    for (const issue of error.issues) {
      const i = issue as unknown as { code: string; path: ReadonlyArray<PropertyKey>; [k: string]: unknown }
      if (i.code === "unrecognized_keys") {
        for (const k of (i.keys as string[] | undefined) ?? []) unknown.add(k)
      }
      if (i.code === "invalid_type" && i.path.length === 0) {
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
