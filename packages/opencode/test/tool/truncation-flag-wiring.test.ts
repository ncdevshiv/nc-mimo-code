// Verify the env multiplier (`NC_MIMO_CODE_TOOL_OUTPUT_BUDGET`) flows
// through to byte caps in the resolver, and that per-tool overrides
// take precedence over the multiplier.
//
// The resolver reads `process.env` directly (not via the `Flag`
// module, which captures values once at module load). This lets
// tests mutate the env between calls and see the change.

import { describe, test, expect } from "bun:test"
import { resolveToolBudget } from "../../src/config/tool-budget-resolve"

describe("NC_MIMO_CODE_TOOL_OUTPUT_BUDGET flag wiring", () => {
  test("resolver scales byte caps when env is set", () => {
    const original = process.env["NC_MIMO_CODE_TOOL_OUTPUT_BUDGET"]
    try {
      process.env["NC_MIMO_CODE_TOOL_OUTPUT_BUDGET"] = "4"
      const r = resolveToolBudget(undefined)
      // 4x the default 50KiB.
      expect(r.read.maxBytes).toBe(50 * 1024 * 4)
      expect(r.bash.maxBytes).toBe(50 * 1024 * 4)
      expect(r._source).toBe("env")
    } finally {
      if (original === undefined) delete process.env["NC_MIMO_CODE_TOOL_OUTPUT_BUDGET"]
      else process.env["NC_MIMO_CODE_TOOL_OUTPUT_BUDGET"] = original
    }
  })

  test("per-tool byte override takes precedence over the env multiplier", () => {
    const original = process.env["NC_MIMO_CODE_TOOL_OUTPUT_BUDGET"]
    try {
      process.env["NC_MIMO_CODE_TOOL_OUTPUT_BUDGET"] = "8"
      const r = resolveToolBudget({ read: { maxBytes: 1024 } })
      // Per-tool override wins for `read`.
      expect(r.read.maxBytes).toBe(1024)
      // But bash (no override) still gets multiplied.
      expect(r.bash.maxBytes).toBe(50 * 1024 * 8)
      expect(r._source).toBe("config")
    } finally {
      if (original === undefined) delete process.env["NC_MIMO_CODE_TOOL_OUTPUT_BUDGET"]
      else process.env["NC_MIMO_CODE_TOOL_OUTPUT_BUDGET"] = original
    }
  })

  test("multiplier does not scale result counts or line lengths", () => {
    const original = process.env["NC_MIMO_CODE_TOOL_OUTPUT_BUDGET"]
    try {
      process.env["NC_MIMO_CODE_TOOL_OUTPUT_BUDGET"] = "10"
      const r = resolveToolBudget(undefined)
      // Result counts unaffected.
      expect(r.grep.maxResults).toBe(100)
      // Line lengths unaffected.
      expect(r.read.maxLineLength).toBe(2000)
      expect(r.grep.maxLineLength).toBe(2000)
    } finally {
      if (original === undefined) delete process.env["NC_MIMO_CODE_TOOL_OUTPUT_BUDGET"]
      else process.env["NC_MIMO_CODE_TOOL_OUTPUT_BUDGET"] = original
    }
  })

  test("ignores invalid env values", () => {
    const original = process.env["NC_MIMO_CODE_TOOL_OUTPUT_BUDGET"]
    try {
      process.env["NC_MIMO_CODE_TOOL_OUTPUT_BUDGET"] = "not-a-number"
      const r = resolveToolBudget(undefined)
      expect(r.read.maxBytes).toBe(50 * 1024)
      expect(r._source).toBe("default")
    } finally {
      if (original === undefined) delete process.env["NC_MIMO_CODE_TOOL_OUTPUT_BUDGET"]
      else process.env["NC_MIMO_CODE_TOOL_OUTPUT_BUDGET"] = original
    }
  })

  test("truncation section: maxDirBytes honors the multiplier", () => {
    const original = process.env["NC_MIMO_CODE_TOOL_OUTPUT_BUDGET"]
    try {
      process.env["NC_MIMO_CODE_TOOL_OUTPUT_BUDGET"] = "2"
      const r = resolveToolBudget(undefined)
      // Default 100 MiB × 2 = 200 MiB.
      expect(r.truncation.maxDirBytes).toBe(100 * 1024 * 1024 * 2)
    } finally {
      if (original === undefined) delete process.env["NC_MIMO_CODE_TOOL_OUTPUT_BUDGET"]
      else process.env["NC_MIMO_CODE_TOOL_OUTPUT_BUDGET"] = original
    }
  })
})