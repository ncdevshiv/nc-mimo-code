// Rough token estimator. Used by compaction, checkpoint budgeting,
// sidebar TPS, and the budgeted-read tool. A pure length/4 heuristic
// is wrong by 2-4× on CJK text and on code-heavy payloads, but it
// is fast, deterministic, and free of external dependencies.
//
// Callers may pass a custom divisor to calibrate for their content
// type (e.g. lower divisor → more tokens → more aggressive
// compaction). The default 4 matches the canonical "characters per
// token" approximation. The divisor can be tuned at runtime via
// `config.compaction.tokenEstimateDivisor` — call sites read the
// configured value and pass it through.

const DEFAULT_CHARS_PER_TOKEN = 4

export function estimate(input: string, charsPerToken: number = DEFAULT_CHARS_PER_TOKEN): number {
  return Math.max(0, Math.round((input || "").length / charsPerToken))
}