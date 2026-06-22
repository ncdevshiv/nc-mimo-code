import z from "zod"

// Audit §6.4.4: helper for callers that want to enumerate the set
// of optional fields on a Zod object schema — for example,
// `recoverActorArgs` in `tool/actor.ts` uses this to build a
// schema-driven whitelist of "carry-over" fields for the
// bare-shape recovery path.
//
// `isOptionalField` walks the Zod AST to detect `ZodOptional`,
// `ZodDefault`, or `ZodNullable` wrappers at any depth — this
// matches `z.string().min(1).optional().default(...)` and the
// other common Zod composition patterns. The "deep unwrap" is
// important: the old hardcoded whitelist in
// `recoverActorArgs` would have silently drifted from the
// schema if a future field added `.default(...)` on top of
// `.optional()`; this helper follows the schema exactly.
//
// Zod v4 split its types into `$ZodType` (the new v4 internal
// representation) and the user-facing `z.ZodType` / `z.ZodTypeAny`
// wrappers. The two share an AST shape — both expose a `def`
// with a `typeName` string — so this helper takes `unknown` and
// casts at the boundary to stay compatible with whichever
// surface the caller has in hand (the test suite uses raw
// `z.strictObject`; production code uses `Effect.Schema`).

const OPTIONAL_TYPE_NAMES = new Set([
  "optional",
  "default",
  "nullable",
  "readonly",
  "catch",
  "branded",
])

function unwrapDef(field: unknown): { type: string; inner: unknown } | null {
  const def = (field as { def?: unknown })?.def
  if (!def || typeof def !== "object") return null
  const type = (def as { type?: unknown }).type
  if (typeof type !== "string") return null
  const inner = (def as { innerType?: unknown; schema?: unknown }).innerType
    ?? (def as { schema?: unknown }).schema
  return { type, inner }
}

function isOptionalField(field: unknown): boolean {
  let current: unknown = field
  for (let depth = 0; depth < 16; depth++) {
    const step = unwrapDef(current)
    if (!step) return false
    // The current node is an optional-wrapper node (`optional`,
    // `default`, `nullable`, etc.) — the field IS optional,
    // regardless of what it wraps. Return immediately.
    if (OPTIONAL_TYPE_NAMES.has(step.type)) return true
    // Not an optional wrapper — could be a chained pipe, a custom
    // refinement, or a base type. Step into the inner if there is
    // one; otherwise the field is required.
    const inner = (current as { def?: { innerType?: unknown; schema?: unknown } })?.def?.innerType
      ?? (current as { def?: { schema?: unknown } })?.def?.schema
    if (!inner) return false
    current = inner
  }
  return false
}

/**
 * Return the set of field names on a Zod object schema whose
 * values are optional (or defaulted / nullable). The result is
 * a fresh `Set` per call so callers can mutate it freely.
 */
export function optionalKeys(schema: z.ZodObject<z.ZodRawShape>): ReadonlySet<string> {
  const out = new Set<string>()
  for (const [key, field] of Object.entries(schema.shape)) {
    if (isOptionalField(field)) out.add(key)
  }
  return out
}
