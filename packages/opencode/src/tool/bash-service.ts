// Bash execution service — the `BashService.Service` is the single
// carrier of bash-related service dependencies (ChildProcessSpawner,
// AppFileSystem, Truncate, Plugin). The `BashTool` (in ./bash) yields
// it once and consumes the pure `Effect<..., never, never>` API it
// exposes.
//
// Why this lives in its own file: the bash tool's `execute` boundary
// must satisfy `Effect<ExecuteResult, never, never>` (per
// `tool.ts`'s `Tool.define` constraint), but the inner `run` function
// calls `trunc.write(...)`, which leaks `Truncate.Service` into the
// `R` channel. Lifting the service-yielding code behind a single
// `BashService.Service` yield collapses the public R to `never` while
// keeping the underlying dependencies explicit and testable.
//
// `makeRun(deps)` is a pure factory: pass the four upstream service
// *interfaces* in once, get back an object with `Effect<..., never,
// never>` methods. The default `Layer.effect(Service, ...)` wires
// this for production. Tests can build a
// `Layer.succeed(Service, makeRun({ ... }))` from fake deps.

import os from "os"
import { createWriteStream, readFileSync } from "node:fs"
import path from "path"
import { Context, Effect, Fiber, Layer, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import type { Node } from "web-tree-sitter"

import { AppFileSystem } from "@nc-mimo-code/shared/filesystem"

import { BashArity } from "@/permission/arity"
import { Plugin } from "@/plugin"
import { Shell } from "@/shell/shell"
import { Bus } from "@/bus"
import { Config } from "@/config"
import { Instance } from "@/project/instance"
import * as BashLongRunning from "@/monitor/bash-long-running"
import { getBashLongRunningConfig } from "@/monitor/bash-long-running-config"
import { BashExited, BashLongRunningWarn, BashStarted } from "@/monitor/bash-events"
import { killBashHandle, registerBashHandle, unregisterBashHandle } from "./bash-handle-registry"
import * as Truncate from "./truncate"
import * as Tool from "./tool"
import { Log } from "@/util"

const MAX_METADATA_LENGTH = 30_000
const PS = new Set(["powershell", "pwsh"])
const CWD = new Set(["cd", "push-location", "set-location"])
const FILES = new Set([
  ...CWD,
  "rm",
  "cp",
  "mv",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "cat",
  "get-content",
  "set-content",
  "add-content",
  "copy-item",
  "move-item",
  "remove-item",
  "new-item",
  "rename-item",
])
const FLAGS = new Set(["-destination", "-literalpath", "-path"])
const SWITCHES = new Set(["-confirm", "-debug", "-force", "-nonewline", "-recurse", "-verbose", "-whatif"])

const ERROR_PATTERN = /error|exception|failed|fatal|traceback|panic|exit code/i
const HEAD_BYTES = Math.floor(Truncate.MAX_BYTES * 0.7)
const HEAD_LINES = Math.floor(Truncate.MAX_LINES * 0.7)

const log = Log.create({ service: "bash-tool" })

export type Part = {
  type: string
  text: string
}

export type Scan = {
  dirs: Set<string>
  patterns: Set<string>
  always: Set<string>
}

export type Chunk = {
  text: string
  size: number
}

export interface BashDeps {
  readonly spawner: ChildProcessSpawner["Service"]
  readonly fs: AppFileSystem.Interface
  readonly truncate: Truncate.Interface
  readonly plugin: Plugin.Interface
}

export interface BashRunInput {
  shell: string
  name: string
  command: string
  cwd: string
  env: NodeJS.ProcessEnv
  timeout: number
  description: string
}

export interface BashRunResult {
  title: string
  metadata: {
    output: string
    exit: number | null
    description: string
    truncated: boolean
    outputPath?: string
  }
  output: string
}

export interface BashInterface {
  readonly resolvePath: (text: string, root: string, shell: string) => Effect.Effect<string, never, never>
  readonly collect: (root: Node, cwd: string, ps: boolean, shell: string) => Effect.Effect<Scan, never, never>
  readonly shellEnv: (ctx: Tool.Context, cwd: string) => Effect.Effect<NodeJS.ProcessEnv, never, never>
  readonly run: (input: BashRunInput, ctx: Tool.Context) => Effect.Effect<BashRunResult, never, never>
}

export class Service extends Context.Service<Service, BashInterface>()("@opencode/Bash") {}

// ---- pure helpers (no service deps) ---------------------------------------

function parts(node: Node): Part[] {
  const out: Part[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (child.type === "command_elements") {
      for (let j = 0; j < child.childCount; j++) {
        const item = child.child(j)
        if (!item || item.type === "command_argument_sep" || item.type === "redirection") continue
        out.push({ type: item.type, text: item.text })
      }
      continue
    }
    if (
      child.type !== "command_name" &&
      child.type !== "command_name_expr" &&
      child.type !== "word" &&
      child.type !== "string" &&
      child.type !== "raw_string" &&
      child.type !== "concatenation"
    ) {
      continue
    }
    out.push({ type: child.type, text: child.text })
  }
  return out
}

function source(node: Node) {
  return (node.parent?.type === "redirected_statement" ? node.parent.text : node.text).trim()
}

function commands(node: Node) {
  return node.descendantsOfType("command").filter((child): child is Node => Boolean(child))
}

function unquote(text: string) {
  if (text.length < 2) return text
  const first = text[0]
  const last = text[text.length - 1]
  if ((first === '"' || first === "'") && first === last) return text.slice(1, -1)
  return text
}

function home(text: string) {
  if (text === "~") return os.homedir()
  if (text.startsWith("~/") || text.startsWith("~\\")) return path.join(os.homedir(), text.slice(2))
  return text
}

function envValue(key: string) {
  if (process.platform !== "win32") return process.env[key]
  const name = Object.keys(process.env).find((item) => item.toLowerCase() === key.toLowerCase())
  return name ? process.env[name] : undefined
}

function auto(key: string, cwd: string, shell: string) {
  const name = key.toUpperCase()
  if (name === "HOME") return os.homedir()
  if (name === "PWD") return cwd
  if (name === "PSHOME") return path.dirname(shell)
}

function expand(text: string, cwd: string, shell: string) {
  const out = unquote(text)
    .replace(/\$\{env:([^}]+)\}/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$(HOME|PWD|PSHOME)(?=$|[\\/])/gi, (_, key: string) => auto(key, cwd, shell) || "")
  return home(out)
}

function provider(text: string) {
  const match = text.match(/^([A-Za-z]+)::(.*)$/)
  if (match) {
    if (match[1].toLowerCase() !== "filesystem") return
    return match[2]
  }
  const prefix = text.match(/^([A-Za-z]+):(.*)$/)
  if (!prefix) return text
  if (prefix[1].length === 1) return text
  return
}

function dynamic(text: string, ps: boolean) {
  if (text.startsWith("(") || text.startsWith("@(")) return true
  if (text.includes("$(") || text.includes("${") || text.includes("`")) return true
  if (ps) return /\$(?!env:)/i.test(text)
  return text.includes("$")
}

function prefix(text: string) {
  const match = /[?*[]/.exec(text)
  if (!match) return text
  if (match.index === 0) return
  return text.slice(0, match.index)
}

function pathArgs(list: Part[], ps: boolean) {
  if (!ps) {
    return list
      .slice(1)
      .filter((item) => !item.text.startsWith("-") && !(list[0]?.text === "chmod" && item.text.startsWith("+")))
      .map((item) => item.text)
  }

  const out: string[] = []
  let want = false
  for (const item of list.slice(1)) {
    if (want) {
      out.push(item.text)
      want = false
      continue
    }
    if (item.type === "command_parameter") {
      const flag = item.text.toLowerCase()
      if (SWITCHES.has(flag)) continue
      want = FLAGS.has(flag)
      continue
    }
    out.push(item.text)
  }
  return out
}

function preview(text: string) {
  if (text.length <= MAX_METADATA_LENGTH) return text
  return "...\n\n" + text.slice(-MAX_METADATA_LENGTH)
}

function head(text: string, maxLines: number, maxBytes: number): string {
  const lines = text.split("\n")
  const out: string[] = []
  let bytes = 0
  for (let i = 0; i < lines.length && out.length < maxLines; i++) {
    const size = Buffer.byteLength(lines[i], "utf-8") + (i > 0 ? 1 : 0)
    if (bytes + size > maxBytes) break
    out.push(lines[i])
    bytes += size
  }
  return out.join("\n")
}

function tail(text: string, maxLines: number, maxBytes: number) {
  const lines = text.split("\n")
  if (lines.length <= maxLines && Buffer.byteLength(text, "utf-8") <= maxBytes) {
    return { text, cut: false }
  }

  const out: string[] = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      if (out.length === 0) {
        const buf = Buffer.from(lines[i], "utf-8")
        let start = buf.length - maxBytes
        if (start < 0) start = 0
        while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
        out.unshift(buf.subarray(start).toString("utf-8"))
      }
      break
    }
    out.unshift(lines[i])
    bytes += size
  }
  return { text: out.join("\n"), cut: true }
}

function cmd(shell: string, name: string, command: string, cwd: string, env: NodeJS.ProcessEnv) {
  if (process.platform === "win32" && PS.has(name)) {
    return ChildProcess.make(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      cwd,
      env,
      stdin: "ignore",
      detached: false,
    })
  }

  return ChildProcess.make(command, [], {
    shell,
    cwd,
    env,
    stdin: "ignore",
    detached: process.platform !== "win32",
  })
}

// ---- the factory ------------------------------------------------------------

type Exit = { kind: "exit"; code: number | null } | { kind: "abort"; code: null } | { kind: "timeout"; code: null }

export const makeRun = (deps: BashDeps): BashInterface => {
  const { spawner, fs, truncate: trunc, plugin } = deps

  const cygpath = (shell: string, text: string): Effect.Effect<string | undefined, never, never> =>
    Effect.gen(function* () {
      const lines = yield* spawner
        .lines(ChildProcess.make(shell, ["-lc", 'cygpath -w -- "$1"', "_", text]))
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      const file = lines[0]?.trim()
      if (!file) return undefined
      return AppFileSystem.normalizePath(file)
    })

  const resolvePath: BashInterface["resolvePath"] = (text, root, shell) =>
    Effect.gen(function* () {
      if (process.platform === "win32") {
        if (Shell.posix(shell) && text.startsWith("/") && AppFileSystem.windowsPath(text) === text) {
          const file = yield* cygpath(shell, text)
          if (file) return file
        }
        return AppFileSystem.normalizePath(path.resolve(root, AppFileSystem.windowsPath(text)))
      }
      return path.resolve(root, text)
    })

  const argPath = (arg: string, cwd: string, ps: boolean, shell: string): Effect.Effect<string | undefined, never, never> =>
    Effect.gen(function* () {
      const text = ps ? expand(arg, cwd, shell) : home(unquote(arg))
      const file = text && prefix(text)
      if (!file || dynamic(file, ps)) return undefined
      const next = ps ? provider(file) : file
      if (!next) return undefined
      return yield* resolvePath(next, cwd, shell)
    })

  const collect: BashInterface["collect"] = (root, cwd, ps, shell) =>
    Effect.gen(function* () {
      const scan: Scan = {
        dirs: new Set<string>(),
        patterns: new Set<string>(),
        always: new Set<string>(),
      }

      for (const node of commands(root)) {
        const command = parts(node)
        const tokens = command.map((item) => item.text)
        const cmdName = ps ? tokens[0]?.toLowerCase() : tokens[0]

        if (cmdName && FILES.has(cmdName)) {
          for (const arg of pathArgs(command, ps)) {
            const resolved = yield* argPath(arg, cwd, ps, shell)
            log.info("resolved path", { arg, resolved })
            if (!resolved || Instance.containsPath(resolved)) continue
            const dir = (yield* fs.isDir(resolved)) ? resolved : path.dirname(resolved)
            scan.dirs.add(dir)
          }
        }

        if (tokens.length && (!cmdName || !CWD.has(cmdName))) {
          scan.patterns.add(source(node))
          scan.always.add(BashArity.prefix(tokens).join(" ") + " *")
        }
      }

      return scan
    })

  const shellEnv: BashInterface["shellEnv"] = (ctx, cwd) =>
    Effect.gen(function* () {
      const extra = yield* plugin.trigger(
        "shell.env",
        { cwd, sessionID: ctx.sessionID, callID: ctx.callID },
        { env: {} },
      )
      return {
        ...process.env,
        ...extra.env,
      } as NodeJS.ProcessEnv
    })

  const runBody = Effect.fn("BashService.run")(function* (input: BashRunInput, ctx: Tool.Context) {

        const bytes = Truncate.MAX_BYTES
        const lines = Truncate.MAX_LINES
        const keep = bytes * 2
        let full = ""
        let last = ""
        const list: Chunk[] = []
        let used = 0
        let file = ""
        let sink: ReturnType<typeof createWriteStream> | undefined
        let cut = false
        let expired = false
        let aborted = false

        yield* ctx.metadata({
          metadata: {
            output: "",
            description: input.description,
          },
        })

        const code: number | null = yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(cmd(input.shell, input.name, input.command, input.cwd, input.env))
            const startedAt = Date.now()

            yield* Effect.sync(() => {
              try {
                registerBashHandle({
                  pid: handle.pid,
                  kill: () => handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie),
                })
              } catch {
                // intentionally swallowed — registry failure must not
                // fail the bash invocation
              }
            })

            yield* Effect.promise(() =>
              Bus.publish(BashStarted, {
                sessionID: ctx.sessionID,
                messageID: ctx.messageID,
                callID: ctx.callID ?? "unknown",
                command: input.command,
                ...(input.description !== undefined ? { description: input.description } : {}),
                pid: handle.pid,
                startedAt,
              }),
            ).pipe(Effect.ignore)

            // Long-running monitor — Config.Service is yielded INSIDE the
            // fork body so its requirement stays local to the fork and
            // never leaks into `run`'s outer R (which must stay `never`).
            let killed = false
            const monitorFiber: Fiber.Fiber<void, never> = yield* Effect.forkChild(
              Effect.suspend(() =>
                Effect.gen(function* () {
                  const config = yield* Config.Service
                  const cfg = yield* config.get()
                  const monitorCfg = getBashLongRunningConfig(cfg)
                  if (!monitorCfg.enabled) return

                  yield* Effect.sleep(`${monitorCfg.thresholdMs} millis`)

                  while (true) {
                    const assessment: BashLongRunning.Assessment = yield* Effect.tryPromise(() =>
                      BashLongRunning.spawn({
                        sessionID: ctx.sessionID,
                        command: input.command,
                        pid: handle.pid,
                        elapsedMs: Date.now() - startedAt,
                        ...(input.description !== undefined ? { description: input.description } : {}),
                      }),
                    ).pipe(
                      Effect.catchCause(() =>
                        Effect.succeed<BashLongRunning.Assessment>({
                          kind: "continue",
                          reason: "monitor sub-actor errored",
                        }),
                      ),
                    )

                    if (assessment.kind === "warn") {
                      yield* Effect.promise(() =>
                        Bus.publish(BashLongRunningWarn, {
                          sessionID: ctx.sessionID,
                          messageID: ctx.messageID,
                          callID: ctx.callID ?? "unknown",
                          reason: assessment.reason,
                          elapsedMs: Date.now() - startedAt,
                        }),
                      ).pipe(Effect.ignore)
                    }
                    if (assessment.kind === "terminate") {
                      killed = true
                      const registryKilled = yield* killBashHandle(handle.pid).pipe(
                        Effect.catch(() => Effect.succeed(false)),
                      )
                      if (!registryKilled) {
                        yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.ignore)
                      }
                      yield* Effect.promise(() =>
                        Bus.publish(BashLongRunningWarn, {
                          sessionID: ctx.sessionID,
                          messageID: ctx.messageID,
                          callID: ctx.callID ?? "unknown",
                          reason: `terminated: ${assessment.reason}`,
                          elapsedMs: Date.now() - startedAt,
                        }),
                      ).pipe(Effect.ignore)
                      return
                    }
                    yield* Effect.sleep(`${monitorCfg.pollIntervalMs} millis`)
                  }
                }),
              ) as Effect.Effect<void, never, Config.Service>,
            )

            yield* Effect.forkScoped(
              Stream.runForEach(Stream.decodeText(handle.all), (chunk) => {
                const size = Buffer.byteLength(chunk, "utf-8")
                list.push({ text: chunk, size })
                used += size
                while (used > keep && list.length > 1) {
                  const item = list.shift()
                  if (!item) break
                  used -= item.size
                  cut = true
                }

                last = preview(last + chunk)

                if (file) {
                  sink?.write(chunk)
                } else {
                  full += chunk
                  if (Buffer.byteLength(full, "utf-8") > bytes) {
                    return trunc.write(full, "bash").pipe(
                      Effect.andThen((next) =>
                        Effect.sync(() => {
                          file = next
                          cut = true
                          sink = createWriteStream(next, { flags: "a" })
                          full = ""
                        }),
                      ),
                      Effect.andThen(
                        ctx.metadata({
                          metadata: {
                            output: last,
                            description: input.description,
                          },
                        }),
                      ),
                    )
                  }
                }

                return ctx.metadata({
                  metadata: {
                    output: last,
                    description: input.description,
                  },
                })
              }),
            )

            const abort = Effect.callback<void>((resume) => {
              if (ctx.abort.aborted) return resume(Effect.void)
              const handler = () => resume(Effect.void)
              ctx.abort.addEventListener("abort", handler, { once: true })
              return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
            })

            const timeout = Effect.sleep(`${input.timeout + 100} millis`)

            const exit: Exit = yield* Effect.raceAll([
              handle.exitCode.pipe(Effect.map((code): Exit => ({ kind: "exit" as const, code }))),
              abort.pipe(Effect.map((): Exit => ({ kind: "abort" as const, code: null }))),
              timeout.pipe(Effect.map((): Exit => ({ kind: "timeout" as const, code: null }))),
            ])

            if (exit.kind === "abort") {
              aborted = true
              yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
            }
            if (exit.kind === "timeout") {
              expired = true
              yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
            }

            yield* Fiber.interrupt(monitorFiber).pipe(Effect.ignore)

            yield* Effect.sync(() => unregisterBashHandle(handle.pid))
            yield* Effect.promise(() =>
              Bus.publish(BashExited, {
                sessionID: ctx.sessionID,
                messageID: ctx.messageID,
                callID: ctx.callID ?? "unknown",
                pid: handle.pid,
                exitCode: exit.kind === "exit" ? exit.code : null,
                reason: killed
                  ? "kill"
                  : exit.kind === "abort"
                    ? "abort"
                    : exit.kind === "timeout"
                      ? "timeout"
                      : "exit",
              }),
            ).pipe(Effect.ignore)

            return exit.kind === "exit" ? exit.code : null
          }),
        ).pipe(Effect.orDie)

        const meta: string[] = []
        if (expired) {
          meta.push(
            `bash tool terminated command after exceeding timeout ${input.timeout} ms. If this command is expected to take longer and is not waiting for interactive input, retry with a larger timeout value in milliseconds.`,
          )
        }
        if (aborted) meta.push("User aborted the command")
        const raw = list.map((item) => item.text).join("")
        const end = tail(raw, lines, bytes)
        if (end.cut) cut = true
        if (!file && end.cut) {
          file = yield* trunc.write(raw, "bash")
        }

        let output = end.text
        if (!output) output = "(no output)"

        if (cut && file) {
          const tailScan = end.text.length > 2048 ? end.text.slice(-2048) : end.text
          const hasErrors = ERROR_PATTERN.test(tailScan)
          if (hasErrors) {
            let fileContent: string | undefined
            try {
              fileContent = readFileSync(file, "utf-8")
            } catch {
              fileContent = undefined
            }
            if (fileContent) {
              const headText = head(fileContent, HEAD_LINES, HEAD_BYTES)
              output = `...output truncated (head+tail shown due to errors)...\n\nFull output saved to: ${file}\n\n${headText}\n\n...middle omitted...\n\n${end.text}`
            } else {
              output = `...output truncated...\n\nFull output saved to: ${file}\n\n` + output
            }
          } else {
            output = `...output truncated...\n\nFull output saved to: ${file}\n\n` + output
          }
        }

        if (meta.length > 0) {
          output += "\n\n<bash_metadata>\n" + meta.join("\n") + "\n</bash_metadata>"
        }
        if (sink) {
          const stream = sink
          yield* Effect.promise(
            () =>
              new Promise<void>((resolve) => {
                stream.end(() => resolve())
                stream.on("error", () => resolve())
              }),
          )
        }

        return {
          title: input.description,
          metadata: {
            output: last || preview(output),
            exit: code,
            description: input.description,
            truncated: cut,
            ...(cut && file ? { outputPath: file } : {}),
          },
          output,
        }
      })

  // `runBody` is a `BashService.run`-shaped function that may require
  // `Config.Service` for the long-running monitor's fork. At the public
  // `BashInterface.run` boundary we strip the requirement — the layer
  // composition (which provides `BashService.Service` to `BashTool`)
  // already provides `Config.Service` upstream in the runtime graph,
  // so this is a sound re-type. Documented in the audit doc as the
  // intentional R-narrowing the service extraction enables.
  const run: BashInterface["run"] = runBody as unknown as BashInterface["run"]

  return { resolvePath, collect, shellEnv, run }
}

// ---- default layer ---------------------------------------------------------
//
// `defaultLayer` is self-contained: it bundles the upstream services
// (ChildProcessSpawner, AppFileSystem, Truncate, Plugin) and provides
// them to the inner `Layer.effect`. This collapses the public R to
// `never` so callers — both the production `AppLayer` and the various
// test fixtures that mount `BashTool` standalone — don't have to wire
// the four upstream services themselves. They get `BashService.Service`
// for free. The `Layer.provide` call is order-insensitive: each
// upstream `defaultLayer` is itself self-contained (its R is `never`).

import * as CrossSpawnSpawner from "@/effect/cross-spawn-spawner"

const innerLayer: Layer.Layer<
  Service,
  never,
  ChildProcessSpawner | AppFileSystem.Service | Truncate.Service | Plugin.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner
    const fs = yield* AppFileSystem.Service
    const truncate = yield* Truncate.Service
    const plugin = yield* Plugin.Service
    return Service.of(
      makeRun({
        spawner,
        fs,
        truncate,
        plugin,
      }) as unknown as BashInterface,
    )
  }),
)

export const defaultLayer: Layer.Layer<Service> = innerLayer.pipe(
  Layer.provide(
    Layer.mergeAll(
      CrossSpawnSpawner.defaultLayer,
      AppFileSystem.defaultLayer,
      Truncate.defaultLayer,
      Plugin.defaultLayer,
    ),
  ),
)
