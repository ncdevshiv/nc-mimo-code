import type { ConfigToolBudget } from "./tool-budget"
import * as Truncate from "@/tool/truncate"

/**
 * Resolve the effective per-tool output budgets.
 *
 * Pure function — no Effect / Config service access. Tools import
 * `resolveToolBudget()` at module load to pick up `opencode.json`
 * overrides at boot. Subsequent in-process config edits are NOT
 * picked up (matches the existing pattern of module-level constants
 * like `Truncate.MAX_BYTES`).
 *
 * Resolution order (highest priority first):
 *   1. Per-tool override from `ConfigToolBudget.Info` (parsed from
 *      `opencode.json`'s `toolBudget` section).
 *   2. Uniform byte-cap multiplier from
 *      `NC_MIMO_CODE_TOOL_OUTPUT_BUDGET` (only when no per-tool
 *      override exists for that specific byte field).
 *   3. Hardcoded defaults from the tool source (kept in sync
 *      manually — see the constants referenced below).
 *
 * The env multiplier is intentionally narrow: it scales `*Bytes`
 * fields only. Result-count and line-count caps are unaffected
 * because they have different semantics (UI noise vs context cost).
 *
 * @example
 *   // In a tool file:
 *   const BUDGET = resolveToolBudget(undefined)
 *   const limit = BUDGET.grep.maxResults  // 100 by default
 */

export interface ResolvedRead {
  maxBytes: number
  maxLines: number
  maxLineLength: number
}

export interface ResolvedGrep {
  maxResults: number
  maxLineLength: number
}

export interface ResolvedGlob {
  maxResults: number
}

export interface ResolvedBash {
  maxBytes: number
  maxLines: number
  maxMetadataLength: number
}

export interface ResolvedCodesearch {
  maxQueryChars: number
  maxResults: number
}

export interface ResolvedWebfetch {
  maxBytes: number
  maxTimeoutMs: number
}

export interface ResolvedWebsearch {
  maxResults: number
  maxTimeoutMs: number
  maxContextChars: number
}

export interface ResolvedHistory {
  maxResults: number
  aroundMaxBytes: number
}

export interface ResolvedMemory {
  maxResults: number
}

export interface ResolvedSkill {
  maxResults: number
}

export interface ResolvedTruncation {
  maxDirBytes: number
  retentionDays: number
  minThresholdBytes: number
}

export interface ResolvedBudget {
  read: ResolvedRead
  grep: ResolvedGrep
  glob: ResolvedGlob
  bash: ResolvedBash
  codesearch: ResolvedCodesearch
  webfetch: ResolvedWebfetch
  websearch: ResolvedWebsearch
  history: ResolvedHistory
  memory: ResolvedMemory
  skill: ResolvedSkill
  truncation: ResolvedTruncation
  // Source-of-truth marker for tests / diagnostics.
  readonly _source: "config" | "env" | "default"
}

// Defaults pulled from the original tool source constants. When a
// tool's hardcoded constant is changed in source, update the matching
// default here too. Kept as constants (not imports of mutable values)
// so the values are frozen at build time.
const DEFAULT = {
  read: {
    maxBytes: 50 * 1024,
    maxLines: 2000,
    maxLineLength: 2000,
  },
  grep: {
    maxResults: 100,
    maxLineLength: 2000,
  },
  glob: {
    maxResults: 100,
  },
  bash: {
    maxBytes: Truncate.MAX_BYTES, // 50 * 1024
    maxLines: Truncate.MAX_LINES, // 2000
    maxMetadataLength: 30_000,
  },
  codesearch: {
    maxQueryChars: 50_000,
    maxResults: 5,
  },
  webfetch: {
    maxBytes: 5 * 1024 * 1024,
    maxTimeoutMs: 120 * 1000,
  },
  websearch: {
    maxResults: 8,
    maxTimeoutMs: 120 * 1000,
    maxContextChars: 10_000,
  },
  history: {
    maxResults: 50,
    aroundMaxBytes: 20 * 1024,
  },
  memory: {
    maxResults: 10,
  },
  skill: {
    maxResults: 10,
  },
  truncation: {
    maxDirBytes: 100 * 1024 * 1024, // 100 MiB
    retentionDays: 7,
    minThresholdBytes: 1024,
  },
} as const

// Read the env multiplier lazily so tests can monkey-patch
// `process.env` after import. We read `process.env` directly rather
// than going through `Flag.NC_MIMO_CODE_TOOL_OUTPUT_BUDGET` because
// Flag values are captured once at module load (static field), so
// mutating the env between calls would be silently ignored.
function readEnvMultiplier(): number | undefined {
  const raw = process.env["NC_MIMO_CODE_TOOL_OUTPUT_BUDGET"]
  if (!raw) return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) return undefined
  return n
}

function withMultiplier(value: number, multiplier: number | undefined): number {
  if (multiplier === undefined) return value
  return value * multiplier
}

/**
 * Resolve the effective budget from a parsed config + env.
 *
 * Returns a frozen plain object suitable for module-scope storage.
 */
export function resolveToolBudget(raw: ConfigToolBudget.Info | undefined): ResolvedBudget {
  const mult = readEnvMultiplier()

  const readBytes = raw?.read?.maxBytes ?? withMultiplier(DEFAULT.read.maxBytes, mult)
  const readLines = raw?.read?.maxLines ?? DEFAULT.read.maxLines
  const readLineLen = raw?.read?.maxLineLength ?? DEFAULT.read.maxLineLength

  const grepResults = raw?.grep?.maxResults ?? DEFAULT.grep.maxResults
  const grepLineLen = raw?.grep?.maxLineLength ?? DEFAULT.grep.maxLineLength

  const globResults = raw?.glob?.maxResults ?? DEFAULT.glob.maxResults

  const bashBytes = raw?.bash?.maxBytes ?? withMultiplier(DEFAULT.bash.maxBytes, mult)
  const bashLines = raw?.bash?.maxLines ?? DEFAULT.bash.maxLines
  const bashMeta = raw?.bash?.maxMetadataLength ?? DEFAULT.bash.maxMetadataLength

  const codesearchQuery = raw?.codesearch?.maxQueryChars ?? DEFAULT.codesearch.maxQueryChars
  const codesearchResults = raw?.codesearch?.maxResults ?? DEFAULT.codesearch.maxResults

  const webfetchBytes = raw?.webfetch?.maxBytes ?? withMultiplier(DEFAULT.webfetch.maxBytes, mult)
  const webfetchTimeout = raw?.webfetch?.maxTimeoutMs ?? DEFAULT.webfetch.maxTimeoutMs

  const websearchResults = raw?.websearch?.maxResults ?? DEFAULT.websearch.maxResults
  const websearchTimeout = raw?.websearch?.maxTimeoutMs ?? DEFAULT.websearch.maxTimeoutMs
  const websearchContext = raw?.websearch?.maxContextChars ?? DEFAULT.websearch.maxContextChars

  const historyResults = raw?.history?.maxResults ?? DEFAULT.history.maxResults
  const historyAround = raw?.history?.aroundMaxBytes ?? withMultiplier(DEFAULT.history.aroundMaxBytes, mult)

  const memoryResults = raw?.memory?.maxResults ?? DEFAULT.memory.maxResults

  const skillResults = raw?.skill?.maxResults ?? DEFAULT.skill.maxResults

const truncationMaxDir = raw?.truncation?.maxDirBytes ?? withMultiplier(DEFAULT.truncation.maxDirBytes, mult)
const truncationRetention = raw?.truncation?.retentionDays ?? DEFAULT.truncation.retentionDays
const truncationMinThreshold = raw?.truncation?.minThresholdBytes ?? DEFAULT.truncation.minThresholdBytes

  // Source-of-truth marker: "config" if any field came from raw,
  // else "env" if any byte field used the multiplier, else "default".
  const anyFromConfig = raw !== undefined && Object.keys(raw).length > 0
  const source: ResolvedBudget["_source"] = anyFromConfig
    ? "config"
    : mult !== undefined
      ? "env"
      : "default"

  return Object.freeze({
    read: Object.freeze({
      maxBytes: readBytes,
      maxLines: readLines,
      maxLineLength: readLineLen,
    }),
    grep: Object.freeze({
      maxResults: grepResults,
      maxLineLength: grepLineLen,
    }),
    glob: Object.freeze({
      maxResults: globResults,
    }),
    bash: Object.freeze({
      maxBytes: bashBytes,
      maxLines: bashLines,
      maxMetadataLength: bashMeta,
    }),
    codesearch: Object.freeze({
      maxQueryChars: codesearchQuery,
      maxResults: codesearchResults,
    }),
    webfetch: Object.freeze({
      maxBytes: webfetchBytes,
      maxTimeoutMs: webfetchTimeout,
    }),
    websearch: Object.freeze({
      maxResults: websearchResults,
      maxTimeoutMs: websearchTimeout,
      maxContextChars: websearchContext,
    }),
    history: Object.freeze({
      maxResults: historyResults,
      aroundMaxBytes: historyAround,
    }),
    memory: Object.freeze({
      maxResults: memoryResults,
    }),
    skill: Object.freeze({
      maxResults: skillResults,
    }),
    truncation: Object.freeze({
      maxDirBytes: truncationMaxDir,
      retentionDays: truncationRetention,
      minThresholdBytes: truncationMinThreshold,
    }),
    _source: source,
  })
}

/**
 * Module-level singleton — resolved at first import. Tools that want
 * to honor runtime config edits should call `resolveToolBudget`
 * directly; tools that want speed and don't expect config to change
 * at runtime can import `BUDGET` instead.
 *
 * The env multiplier is read from `process.env` at module-load time.
 * Tests that need to vary it should call `resolveToolBudget` directly
 * with a hand-rolled config object.
 */
export const BUDGET: ResolvedBudget = resolveToolBudget(undefined)