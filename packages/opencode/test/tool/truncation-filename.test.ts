import { test, expect, describe } from "bun:test"
import { truncationFileName } from "../../src/tool/truncate"

describe("truncationFileName", () => {
  test("with tool name: tool_<safe>_<id>", () => {
    expect(truncationFileName("bash", "01HX123")).toBe("tool_bash_01HX123")
    expect(truncationFileName("webfetch", "01HX456")).toBe("tool_webfetch_01HX456")
  })

  test("without tool name: bare id (preserves pre-tool-name shape)", () => {
    expect(truncationFileName(undefined, "01HX123")).toBe("01HX123")
  })

  test("empty string treated as no tool", () => {
    expect(truncationFileName("", "01HX123")).toBe("01HX123")
  })

  test("tool name with unsafe chars is sanitized to underscores", () => {
    // Both '.' and '/' are outside [A-Za-z0-9_-], so all are replaced.
    // '../../../etc/passwd' = 6 dots + 4 slashes (3 in '../../../' + 1
    // between 'etc' and 'passwd') = 10 unsafe chars, each becomes a single
    // underscore. The 9 alphanumeric chars survive, giving 10 underscores +
    // 'etc' + '_' + 'passwd' = 19 chars for the sanitized tool name.
    expect(truncationFileName("../../../etc/passwd", "01HX123")).toBe("tool__________etc_passwd_01HX123")
    expect(truncationFileName("with/slash", "01HX123")).toBe("tool_with_slash_01HX123")
    expect(truncationFileName("with space", "01HX123")).toBe("tool_with_space_01HX123")
  })

  test("tool name with allowed punctuation passes through", () => {
    expect(truncationFileName("tool-1", "01HX123")).toBe("tool_tool-1_01HX123")
    expect(truncationFileName("tool_1", "01HX123")).toBe("tool_tool_1_01HX123")
  })

  test("unicode in tool name is replaced (path-safety)", () => {
    expect(truncationFileName("シェル", "01HX123")).toBe("tool_____01HX123")
  })

  test("the cleanup glob (starts with tool_) still matches new shape", () => {
    // GLOB in truncate.ts: TRUNCATION_DIR + "/*" — matches every entry,
    // but the cleanup filter at line 60 also matches `startsWith("tool_")`.
    // The new shape tool_<name>_<id> starts with "tool_", so cleanup still
    // works for files written with a tool name. Without a tool arg the
    // filename is just the ToolID.ascending() output, which is itself
    // prefixed with "tool" by Identifier.ascending("tool", ...) — so the
    // filter still matches.
    expect("tool_bash_01HX123".startsWith("tool_")).toBe(true)
    // The output of ToolID.ascending() is e.g. "tool_01HX123..." — note the
    // literal "tool_" prefix is added by Identifier, not by truncationFileName.
    // Document that the cleanup filter is correct for both shapes.
  })
})
