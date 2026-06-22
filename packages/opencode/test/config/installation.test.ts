import { test, expect, describe } from "bun:test"
import { ConfigInstallation } from "../../src/config/installation"

// PR-4 (audit §9.5 completion test) — the `installation.channels`
// config field must reject unknown channels at load time and accept
// any subset of the closed {npm,pnpm,bun,brew,choco,scoop} literal
// set.
describe("ConfigInstallation: Info schema (zod)", () => {
  test("accepts an empty Info (all defaults)", () => {
    const result = ConfigInstallation.Info.zod.safeParse({})
    expect(result.success).toBe(true)
  })

  test("accepts the npm-published default channels", () => {
    const result = ConfigInstallation.Info.zod.safeParse({ channels: ["npm", "pnpm", "bun"] })
    expect(result.success).toBe(true)
  })

  test("accepts a single-channel config (e.g. brew at publish time)", () => {
    const result = ConfigInstallation.Info.zod.safeParse({ channels: ["brew"] })
    expect(result.success).toBe(true)
  })

  test("accepts an empty channels array (user opts out)", () => {
    const result = ConfigInstallation.Info.zod.safeParse({ channels: [] })
    expect(result.success).toBe(true)
  })

  test("accepts every supported channel", () => {
    const result = ConfigInstallation.Info.zod.safeParse({
      channels: ["npm", "pnpm", "bun", "brew", "choco", "scoop"],
    })
    expect(result.success).toBe(true)
  })

  test("rejects an unknown channel", () => {
    const result = ConfigInstallation.Info.zod.safeParse({ channels: ["brew", "yum"] })
    expect(result.success).toBe(false)
  })

  test("rejects channels that is not an array", () => {
    const result = ConfigInstallation.Info.zod.safeParse({ channels: "brew" })
    expect(result.success).toBe(false)
  })
})
