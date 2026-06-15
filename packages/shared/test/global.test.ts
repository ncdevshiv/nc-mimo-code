import { describe, expect, test } from "bun:test"
import path from "path"
import { resolveNcMimoCodeHome } from "@nc-mimo-code/shared/global"

describe("resolveNcMimoCodeHome", () => {
  test("with NC_MIMO_CODE_HOME set, resolves 4 subdirs under root", () => {
    const result = resolveNcMimoCodeHome({
      NC_MIMO_CODE_HOME: "/tmp/profile-a",
    })
    expect(result.mode).toBe("nc_mimo_code_home")
    expect(result.root).toBe("/tmp/profile-a")
    expect(result.config).toBe(path.join("/tmp/profile-a", "config"))
    expect(result.data).toBe(path.join("/tmp/profile-a", "data"))
    expect(result.state).toBe(path.join("/tmp/profile-a", "state"))
    expect(result.cache).toBe(path.join("/tmp/profile-a", "cache"))
  })

  test("without NC_MIMO_CODE_HOME, falls through to xdg mode", () => {
    const result = resolveNcMimoCodeHome({})
    expect(result.mode).toBe("xdg")
    expect(result.root).toBeUndefined()
    // xdg paths end with "/ncmimocode" (the APP constant for nc-mimo-code)
    expect(result.config.endsWith(path.join("", "ncmimocode"))).toBe(true)
    expect(result.data.endsWith(path.join("", "ncmimocode"))).toBe(true)
    expect(result.state.endsWith(path.join("", "ncmimocode"))).toBe(true)
    expect(result.cache.endsWith(path.join("", "ncmimocode"))).toBe(true)
  })

  test("empty NC_MIMO_CODE_HOME string is treated as unset (xdg mode)", () => {
    const result = resolveNcMimoCodeHome({ NC_MIMO_CODE_HOME: "" })
    expect(result.mode).toBe("xdg")
  })

  test("relative NC_MIMO_CODE_HOME path throws with clear error", () => {
    expect(() => resolveNcMimoCodeHome({ NC_MIMO_CODE_HOME: "./foo" })).toThrow(
      /NC_MIMO_CODE_HOME must be an absolute path/,
    )
    expect(() => resolveNcMimoCodeHome({ NC_MIMO_CODE_HOME: "foo/bar" })).toThrow(
      /NC_MIMO_CODE_HOME must be an absolute path/,
    )
  })

  test("tilde-prefixed NC_MIMO_CODE_HOME throws (not treated as absolute)", () => {
    expect(() => resolveNcMimoCodeHome({ NC_MIMO_CODE_HOME: "~/profiles/a" })).toThrow(
      /NC_MIMO_CODE_HOME must be an absolute path/,
    )
  })

  test("error message includes the offending value", () => {
    expect(() => resolveNcMimoCodeHome({ NC_MIMO_CODE_HOME: "./relative" })).toThrow(
      /\.\/relative/,
    )
  })
})
