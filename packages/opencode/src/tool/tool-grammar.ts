// Shared grammar helpers for shell-form tool params (actor, task). The
// intent is one canonical implementation of levenshtein distance, the
// "did you mean" verb suggestion, and the `--name value` / `--name=value`
// flag extractor. Earlier each tool carried its own copy and drifted
// independently (e.g. actor's extractor is async, task's is sync; the
// suggester in actor used a 0..2 edit distance threshold that task
// duplicated verbatim).

/**
 * Standard Wagner–Fischer levenshtein with O(mn) memory. Adequate for
 * the short verb names these suggesters operate on; if you ever call
 * this on long strings, switch to a two-row implementation.
 */
export function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
    }
  }
  return dp[m][n]
}

/**
 * Suggest a single candidate verb from `candidates` within `maxDist`
 * edits. Returns undefined when zero or multiple candidates qualify
 * (the latter to avoid silently picking the wrong one).
 */
export function suggestVerb(input: string, candidates: readonly string[], maxDist = 2): string | undefined {
  const filtered = candidates.map((v) => ({ v, d: levenshtein(input, v) })).filter((c) => c.d <= maxDist)
  if (filtered.length !== 1) return undefined
  return filtered[0].v
}

export interface ExtractedFlags {
  /** Positionals — anything that wasn't a recognized --flag. */
  rest: string[]
  /** Last `--name` / `--name=value` value pair; empty if a value flag was dangling (see `error`). */
  flags: Record<string, string>
  /** Presence flags (no value). */
  bools: Record<string, boolean>
  /**
   * Set when a value flag is malformed (bare `--name` at end of args, or
   * `--name=` with no value). Callers should surface this as an arity
   * error rather than letting a dangling flag swallow a positional.
   */
  error?: string
}

/**
 * Walk `args` and split recognized value flags and bool flags out of the
 * positionals. `valueFlagNames` are `--name <value>` / `--name=<value>`
 * (consumes the next token). `boolFlagNames` are bare `--name` (no
 * value). Order of the input args is preserved in `rest`.
 */
export function extractFlags(
  args: string[],
  valueFlagNames: readonly string[],
  boolFlagNames: readonly string[] = [],
): ExtractedFlags {
  const rest: string[] = []
  const flags: Record<string, string> = {}
  const bools: Record<string, boolean> = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const boolName = boolFlagNames.find((n) => a === `--${n}`)
    if (boolName) {
      bools[boolName] = true
      continue
    }
    const valName = valueFlagNames.find((n) => a === `--${n}`)
    if (valName) {
      const next = args[i + 1]
      if (next === undefined) return { flags, bools, rest, error: `--${valName} requires a value` }
      flags[valName] = next
      i++
      continue
    }
    const eq = valueFlagNames.find((n) => a.startsWith(`--${n}=`))
    if (eq) {
      const v = a.slice(`--${eq}=`.length)
      if (v === "") return { flags, bools, rest, error: `--${eq} requires a value` }
      flags[eq] = v
      continue
    }
    rest.push(a)
  }
  return { flags, bools, rest }
}
