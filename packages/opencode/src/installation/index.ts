import { Effect, Layer, Schema, Context, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import * as CrossSpawnSpawner from "@/effect/cross-spawn-spawner"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import z from "zod"
import path from "path"
import { BusEvent } from "@/bus/bus-event"
import { Flag } from "../flag/flag"
import { Log } from "../util"
import semver from "semver"
import { InstallationChannel, InstallationVersion } from "./version"

const log = Log.create({ service: "installation" })

const PACKAGE_NAME = "@nc-mimo-code/cli"

export type Method = "curl" | "npm" | "pnpm" | "bun" | "brew" | "scoop" | "choco" | "unknown"

export type ReleaseType = "patch" | "minor" | "major"

export const Event = {
  Updated: BusEvent.define(
    "installation.updated",
    z.object({
      version: z.string(),
    }),
  ),
  UpdateAvailable: BusEvent.define(
    "installation.update-available",
    z.object({
      version: z.string(),
    }),
  ),
}

export function getReleaseType(current: string, latest: string): ReleaseType {
  const currMajor = semver.major(current)
  const currMinor = semver.minor(current)
  const newMajor = semver.major(latest)
  const newMinor = semver.minor(latest)

  if (newMajor > currMajor) return "major"
  if (newMinor > currMinor) return "minor"
  return "patch"
}

export const Info = z
  .object({
    version: z.string(),
    latest: z.string(),
  })
  .meta({
    ref: "InstallationInfo",
  })
export type Info = z.infer<typeof Info>

export const USER_AGENT = `mimocode/${InstallationChannel}/${InstallationVersion}/${Flag.NC_MIMO_CODE_CLIENT}`

export function isPreview() {
  return InstallationChannel !== "latest"
}

export function isLocal() {
  return InstallationChannel === "local"
}

export class UpgradeFailedError extends Schema.TaggedErrorClass<UpgradeFailedError>()("UpgradeFailedError", {
  stderr: Schema.String,
}) {}

// The release-API response schemas for brew/choco/scoop/github are
// defined inline in the methods that need them (see the tap-core/choco/
// scoop helpers below). Keeping the schemas local to the methods that
// use them avoids polluting the module top-level with unused exports —
// the previous shape (`const GitHubRelease = ...` etc., all commented
// out) is removed. When a new channel is published, add the schema and
// the method together; the install/uninstall summaries will pick the
// new channel up automatically via the `Method` union.
const NpmPackage = Schema.Struct({ version: Schema.String })

export interface Interface {
  readonly info: () => Effect.Effect<Info>
  readonly method: () => Effect.Effect<Method>
  readonly latest: (method?: Method) => Effect.Effect<string>
  readonly upgrade: (method: Method, target: string) => Effect.Effect<void, UpgradeFailedError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Installation") {}

export const layer: Layer.Layer<Service, never, HttpClient.HttpClient | ChildProcessSpawner.ChildProcessSpawner> =
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      const httpOk = HttpClient.filterStatusOk(withTransientReadRetry(http))
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

      const text = Effect.fnUntraced(
        function* (cmd: string[], opts?: { cwd?: string; env?: Record<string, string> }) {
          const proc = ChildProcess.make(cmd[0], cmd.slice(1), {
            cwd: opts?.cwd,
            env: opts?.env,
            extendEnv: true,
          })
          const handle = yield* spawner.spawn(proc)
          const out = yield* Stream.mkString(Stream.decodeText(handle.stdout))
          yield* handle.exitCode
          return out
        },
        Effect.scoped,
        Effect.catch(() => Effect.succeed("")),
      )

      const run = Effect.fnUntraced(
        function* (cmd: string[], opts?: { cwd?: string; env?: Record<string, string> }) {
          const proc = ChildProcess.make(cmd[0], cmd.slice(1), {
            cwd: opts?.cwd,
            env: opts?.env,
            extendEnv: true,
          })
          const handle = yield* spawner.spawn(proc)
          const [stdout, stderr] = yield* Effect.all(
            [Stream.mkString(Stream.decodeText(handle.stdout)), Stream.mkString(Stream.decodeText(handle.stderr))],
            { concurrency: 2 },
          )
          const code = yield* handle.exitCode
          return { code, stdout, stderr }
        },
        Effect.scoped,
        Effect.catch(() => Effect.succeed({ code: ChildProcessSpawner.ExitCode(1), stdout: "", stderr: "" })),
      )

      // When mimocode is published to homebrew, add a `getBrewFormula`
      // helper here that resolves the installed formula name
      // (`anomalyco/tap/opencode` first, then `opencode`) and update
      // `Method` + `BrewChannel` in installation/schema. The install
      // and uninstall summaries pick the new channel up via the
      // `Method` union — no source change required beyond this block.

      const upgradeCurl = Effect.fnUntraced(
        function* (target: string) {
          const response = yield* httpOk.execute(HttpClientRequest.get("https://mimo.xiaomi.com/install"))
          const body = yield* response.text
          const bodyBytes = new TextEncoder().encode(body)
          const proc = ChildProcess.make("bash", [], {
            stdin: Stream.make(bodyBytes),
            env: { VERSION: target },
            extendEnv: true,
          })
          const handle = yield* spawner.spawn(proc)
          const [stdout, stderr] = yield* Effect.all(
            [Stream.mkString(Stream.decodeText(handle.stdout)), Stream.mkString(Stream.decodeText(handle.stderr))],
            { concurrency: 2 },
          )
          const code = yield* handle.exitCode
          return { code, stdout, stderr }
        },
        Effect.scoped,
        Effect.orDie,
      )

      const methodImpl = Effect.fn("Installation.method")(function* () {
        if (process.execPath.includes(path.join(".mimocode", "bin"))) return "curl" as Method
        if (process.execPath.includes(path.join(".local", "bin"))) return "curl" as Method
        const exec = process.execPath.toLowerCase()

        const checks: Array<{ name: Method; command: () => Effect.Effect<string> }> = [
          { name: "npm", command: () => text(["npm", "list", "-g", "--depth=0"]) },
          { name: "pnpm", command: () => text(["pnpm", "list", "-g", "--depth=0"]) },
          { name: "bun", command: () => text(["bun", "pm", "ls", "-g"]) },
          // When mimocode is published to a new channel, add the
          // detection command here. The `Method` union and the
          // install/uninstall summaries pick the new channel up
          // automatically.
        ]

        checks.sort((a, b) => {
          const aMatches = exec.includes(a.name)
          const bMatches = exec.includes(b.name)
          if (aMatches && !bMatches) return -1
          if (!aMatches && bMatches) return 1
          return 0
        })

        for (const check of checks) {
          const output = yield* check.command()
          if (output.includes(PACKAGE_NAME)) {
            return check.name
          }
        }

        return "unknown" as Method
      })

      const latestImpl = Effect.fn("Installation.latest")(function* (installMethod?: Method) {
        const detectedMethod = installMethod || (yield* methodImpl())

        // When mimocode is published to a new channel (brew, choco,
        // scoop, github releases), add the latest-version lookup
        // here. The branch pattern is `if (detectedMethod === "<x>")
        // { ... }`. The schemas for the upstream API responses
        // (BrewInfoV2, ChocoPackage, ScoopManifest, GitHubRelease)
        // go at the top of the file alongside NpmPackage.

        if (detectedMethod === "npm" || detectedMethod === "bun" || detectedMethod === "pnpm") {
          const r = (yield* text(["npm", "config", "get", "registry"])).trim()
          const reg = r || "https://registry.npmjs.org"
          const registry = reg.endsWith("/") ? reg.slice(0, -1) : reg
          const response = yield* httpOk.execute(
            HttpClientRequest.get(`${registry}/${encodeURIComponent(PACKAGE_NAME)}/${InstallationChannel}`).pipe(
              HttpClientRequest.acceptJson,
            ),
          )
          const data = yield* HttpClientResponse.schemaBodyJson(NpmPackage)(response)
          return data.version
        }

        log.warn("unsupported update channel, skipping", { method: detectedMethod })
        return yield* Effect.die(new Error(`unsupported update channel: ${detectedMethod}`))
      }, Effect.orDie)

      const upgradeImpl = Effect.fn("Installation.upgrade")(function* (m: Method, target: string) {
        let result: { code: ChildProcessSpawner.ExitCode; stdout: string; stderr: string } | undefined
        switch (m) {
          case "curl":
            result = yield* upgradeCurl(target)
            break
          case "npm":
            result = yield* run(["npm", "install", "-g", `${PACKAGE_NAME}@${target}`])
            break
          case "pnpm":
            result = yield* run(["pnpm", "install", "-g", `${PACKAGE_NAME}@${target}`])
            break
          case "bun":
            result = yield* run(["bun", "install", "-g", `${PACKAGE_NAME}@${target}`])
            break
          // When mimocode is published to a new channel (brew, choco,
          // scoop), add the upgrade command here. The brew path
          // requires a tap-update dance (`brew tap anomalyco/tap &&
          // git pull && brew upgrade`); the others are one-liners.
          default:
            return yield* new UpgradeFailedError({ stderr: `Unknown method: ${m}` })
        }
        if (!result || result.code !== 0) {
          const stderr = result?.stderr || ""
          return yield* new UpgradeFailedError({ stderr })
        }
        log.info("upgraded", {
          method: m,
          target,
          stdout: result.stdout,
          stderr: result.stderr,
        })
        yield* text([process.execPath, "--version"])
      })

      return Service.of({
        info: Effect.fn("Installation.info")(function* () {
          return {
            version: InstallationVersion,
            latest: yield* latestImpl(),
          }
        }),
        method: methodImpl,
        latest: latestImpl,
        upgrade: upgradeImpl,
      })
    }),
  )

export const defaultLayer = layer.pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(CrossSpawnSpawner.defaultLayer),
)

export * as Installation from "."
