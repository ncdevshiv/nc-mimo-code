import { test, expect, describe } from "bun:test"
import {
  resolveChannels,
  buildPackageManagerCommandArrays,
} from "../../src/cli/cmd/uninstall"

// PR-4 (audit §9.5 completion test + §9.6 "config-driven tests").
// These tests pin the contract between the `installation.channels`
// config and the uninstall command's package-manager handling:
//   - the resolved channel list is the npm default when the user
//     has not configured anything (and the npm default is exactly
//     the three channels the build is published to);
//   - the user can opt in to other channels (e.g. `brew` at
//     publish time) and the corresponding uninstall command shows
//     up in the result;
//   - the user can opt out (empty array) and the npm default is
//     still applied, preserving the "every channel is supported by
//     default" contract;
//   - channels outside the resolved list are filtered out, so the
//     uninstall command is *not* offered for a method the build
//     wasn't published to.
describe("uninstall: config-driven channels", () => {
  describe("resolveChannels", () => {
    test("returns the npm-published default when the config is undefined", () => {
      expect(resolveChannels(undefined)).toEqual(["npm", "pnpm", "bun"])
    })

    test("returns the npm-published default when the config is empty", () => {
      // Empty array is treated as "user explicitly opted out" — the
      // uninstall command should still default to the npm channels
      // so uninstall-on-the-published-build keeps working.
      expect(resolveChannels([])).toEqual(["npm", "pnpm", "bun"])
    })

    test("returns a copy of the user's configured channels", () => {
      const configured = ["brew"] as const
      const resolved = resolveChannels(configured)
      expect(resolved).toEqual(["brew"])
      // The returned array is a fresh copy — mutating it must not
      // leak back into the caller's data.
      resolved.push("npm")
      expect(configured).toEqual(["brew"])
    })

    test("preserves the user's ordering and supports subsets", () => {
      expect(resolveChannels(["brew", "npm"])).toEqual(["brew", "npm"])
    })
  })

  describe("buildPackageManagerCommandArrays", () => {
    test("maps the npm-published default to npm/pnpm/bun uninstall commands", () => {
      const cmds = buildPackageManagerCommandArrays(resolveChannels(undefined))
      expect(Object.keys(cmds).sort()).toEqual(["bun", "npm", "pnpm"])
      expect(cmds.npm).toEqual(["npm", "uninstall", "-g", "@nc-mimo-code/cli"])
      expect(cmds.pnpm).toEqual(["pnpm", "uninstall", "-g", "@nc-mimo-code/cli"])
      expect(cmds.bun).toEqual(["bun", "remove", "-g", "@nc-mimo-code/cli"])
    })

    test("includes brew when the user opts in (audit §9.5 brew completion test)", () => {
      const cmds = buildPackageManagerCommandArrays(resolveChannels(["brew"]))
      expect(cmds.brew).toEqual(["brew", "uninstall", "@nc-mimo-code/cli"])
      // The npm channels are not in the result when the user has
      // restricted to brew only.
      expect(cmds.npm).toBeUndefined()
      expect(cmds.pnpm).toBeUndefined()
      expect(cmds.bun).toBeUndefined()
    })

    test("includes choco and scoop when opted in", () => {
      const cmds = buildPackageManagerCommandArrays(resolveChannels(["choco", "scoop"]))
      expect(cmds.choco).toEqual(["choco", "uninstall", "-y", "@nc-mimo-code/cli"])
      expect(cmds.scoop).toEqual(["scoop", "uninstall", "@nc-mimo-code/cli"])
    })

    test("returns an empty map when no channels are enabled (extreme opt-out)", () => {
      // resolveChannels never returns [] — it always falls back to
      // the npm default — so this exercises the function directly
      // with an empty input.
      const cmds = buildPackageManagerCommandArrays([])
      expect(cmds).toEqual({})
    })

    test("filters out channels that have no uninstall command (curl/unknown)", () => {
      // `curl` and `unknown` are runtime-detected states, not
      // publishable channels. If they ever leak into the input
      // (e.g. a future refactor), they must NOT produce a
      // destructive command — the helper drops them.
      const cmds = buildPackageManagerCommandArrays(["curl" as never, "npm"])
      expect(cmds.curl).toBeUndefined()
      expect(cmds.npm).toEqual(["npm", "uninstall", "-g", "@nc-mimo-code/cli"])
    })
  })

  describe("integration: the §9.5 dry-run completion test", () => {
    test("flipping on brew causes the brew line to appear in the summary map", () => {
      // Set Installation.channels = ["brew"], simulate the user
      // running `nc-mimo-code uninstall --dry-run`. The helper
      // resolves the user's config and the resulting map must
      // contain the brew uninstall command. This mirrors the
      // exact audit §9.5 completion test.
      const channels = resolveChannels(["brew"])
      const cmds = buildPackageManagerCommandArrays(channels)
      expect("brew" in cmds).toBe(true)
    })

    test("unsetting channels hides the brew line and reverts to the npm default", () => {
      // Unset Installation.channels. The brew line must NOT appear
      // (because the build is not published to brew), and the npm
      // default must be in effect.
      const channels = resolveChannels(undefined)
      const cmds = buildPackageManagerCommandArrays(channels)
      expect("brew" in cmds).toBe(false)
      expect("npm" in cmds).toBe(true)
    })
  })
})
