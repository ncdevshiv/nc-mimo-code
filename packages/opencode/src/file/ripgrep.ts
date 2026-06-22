import path from "path"
import z from "zod"
import { AppFileSystem } from "@nc-mimo-code/shared/filesystem"
import { Cause, Context, Effect, Fiber, Layer, Queue, Stream } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

import * as CrossSpawnSpawner from "@/effect/cross-spawn-spawner"
import { Global } from "@/global"
import { Log } from "@/util"
import { sanitizedProcessEnv } from "@/util/mimo-process"
import { which } from "@/util/which"

const log = Log.create({ service: "ripgrep" })
const VERSION = "15.1.0"
const PLATFORM = {
  "arm64-darwin": { platform: "aarch64-apple-darwin", extension: "tar.gz" },
  "arm64-linux": { platform: "aarch64-unknown-linux-gnu", extension: "tar.gz" },
  "x64-darwin": { platform: "x86_64-apple-darwin", extension: "tar.gz" },
  "x64-linux": { platform: "x86_64-unknown-linux-musl", extension: "tar.gz" },
  "arm64-win32": { platform: "aarch64-pc-windows-msvc", extension: "zip" },
  "ia32-win32": { platform: "i686-pc-windows-msvc", extension: "zip" },
  "x64-win32": { platform: "x86_64-pc-windows-msvc", extension: "zip" },
} as const

const Stats = z.object({
  elapsed: z.object({
    secs: z.number(),
    nanos: z.number(),
    human: z.string(),
  }),
  searches: z.number(),
  searches_with_match: z.number(),
  bytes_searched: z.number(),
  bytes_printed: z.number(),
  matched_lines: z.number(),
  matches: z.number(),
})

const Begin = z.object({
  type: z.literal("begin"),
  data: z.object({
    path: z.object({
      text: z.string(),
    }),
  }),
})

export const ContextLine = z.object({
  type: z.literal("context"),
  data: z.object({
    path: z.object({
      text: z.string(),
    }),
    lines: z.object({
      text: z.string(),
    }),
    line_number: z.number(),
    absolute_offset: z.number(),
    submatches: z.array(z.unknown()),
  }),
}).passthrough()

export const Match = z.object({
  type: z.literal("match"),
  data: z.object({
    path: z.object({
      text: z.string(),
    }),
    lines: z.object({
      text: z.string(),
    }),
    line_number: z.number(),
    absolute_offset: z.number(),
    submatches: z.array(
      z.object({
        match: z.object({
          text: z.string(),
        }),
        start: z.number(),
        end: z.number(),
      }),
    ),
  }),
}).passthrough()

const End = z.object({
  type: z.literal("end"),
  data: z.object({
    path: z.object({
      text: z.string(),
    }),
    binary_offset: z.number().nullable(),
    stats: Stats,
  }),
}).passthrough()

const Summary = z.object({
  type: z.literal("summary"),
  data: z.object({
    elapsed_total: z.object({
      human: z.string(),
      nanos: z.number(),
      secs: z.number(),
    }),
    stats: Stats,
  }),
}).passthrough()

const Result = z.union([Begin, ContextLine, Match, End, Summary])

export type Result = z.infer<typeof Result>
export type Match = z.infer<typeof Match>
export type Item = Match["data"]
export type Begin = z.infer<typeof Begin>
export type End = z.infer<typeof End>
export type Summary = z.infer<typeof Summary>
export type Row = Match["data"]

export type SearchResult =
  | { items: Item[]; partial: boolean; resultFormat: "content" }
  | { items: string[]; partial: boolean; resultFormat: "files_with_matches" | "count" }

export interface FilesInput {
  cwd: string
  glob?: string[]
  hidden?: boolean
  follow?: boolean
  maxDepth?: number
  signal?: AbortSignal
}

export interface SearchInput {
  cwd: string
  pattern: string
  glob?: string[]
  limit?: number
  follow?: boolean
  file?: string[]
  /**
   * Number of context lines around each match. Pass a single number
   * for symmetric context (`-C`), or `{ before, after }` for asymmetric
   * (`-B` + `-A`). Mirrors ripgrep's `--context` / `--before-context`
   * / `--after-context` flags. PR-1 step 6.
   */
  context?: number | { before: number; after: number }
  /**
   * Output format. `content` (default) emits `path:line: text`,
   * `files_with_matches` emits only paths (ripgrep `--files-with-matches`),
   * `count` emits a per-file match count (ripgrep `--count`). PR-1 step 6.
   */
  resultFormat?: "content" | "files_with_matches" | "count"
  signal?: AbortSignal
}

export interface TreeInput {
  cwd: string
  limit?: number
  signal?: AbortSignal
}

export interface Interface {
  readonly files: (input: FilesInput) => Stream.Stream<string, PlatformError | Error>
  readonly tree: (input: TreeInput) => Effect.Effect<string, PlatformError | Error>
  readonly search: (input: SearchInput) => Effect.Effect<SearchResult, PlatformError | Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Ripgrep") {}

function env() {
  const env = sanitizedProcessEnv()
  delete env.RIPGREP_CONFIG_PATH
  return env
}

function aborted(signal?: AbortSignal) {
  const err = signal?.reason
  if (err instanceof Error) return err
  const out = new Error("Aborted")
  out.name = "AbortError"
  return out
}

function waitForAbort(signal?: AbortSignal) {
  if (!signal) return Effect.never
  if (signal.aborted) return Effect.fail(aborted(signal))
  return Effect.callback<never, Error>((resume) => {
    const onabort = () => resume(Effect.fail(aborted(signal)))
    signal.addEventListener("abort", onabort, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", onabort))
  })
}

function error(stderr: string, code: number) {
  const err = new Error(stderr.trim() || `ripgrep failed with code ${code}`)
  err.name = "RipgrepError"
  return err
}

function clean(file: string) {
  return path.normalize(file.replace(/^\.[\\/]/, ""))
}

function row(data: Row): Row {
  return {
    ...data,
    path: {
      ...data.path,
      text: clean(data.path.text),
    },
  }
}

function parse(line: string) {
  return Effect.try({
    try: () => Result.parse(JSON.parse(line)),
    catch: (cause) => new Error("invalid ripgrep output", { cause }),
  })
}

function fail(queue: Queue.Queue<string, PlatformError | Error | Cause.Done>, err: PlatformError | Error) {
  Queue.failCauseUnsafe(queue, Cause.fail(err))
}

function filesArgs(input: FilesInput) {
  const args = ["--no-config", "--files", "--glob=!.git/*"]
  if (input.follow) args.push("--follow")
  if (input.hidden !== false) args.push("--hidden")
  if (input.hidden === false) args.push("--glob=!.*")
  if (input.maxDepth !== undefined) args.push(`--max-depth=${input.maxDepth}`)
  if (input.glob) {
    for (const glob of input.glob) args.push(`--glob=${glob}`)
  }
  args.push(".")
  return args
}

function searchArgs(input: SearchInput) {
  // `files_with_matches` and `count` are incompatible with `--json`
  // (the JSON output carries its own match structure). When the caller
  // requests either, drop `--json` and let ripgrep emit its native
  // plain-text output. The caller renders the output itself.
  const useJson = input.resultFormat === undefined || input.resultFormat === "content"
  const args = useJson
    ? ["--no-config", "--json", "--hidden", "--glob=!.git/*", "--no-messages"]
    : ["--no-config", "--hidden", "--glob=!.git/*", "--no-messages"]
  if (input.follow) args.push("--follow")
  if (input.glob) {
    for (const glob of input.glob) args.push(`--glob=${glob}`)
  }
  if (input.limit) args.push(`--max-count=${input.limit}`)
  if (input.resultFormat === "files_with_matches") args.push("--files-with-matches")
  else if (input.resultFormat === "count") args.push("--count")
  if (input.context !== undefined) {
    if (typeof input.context === "number") {
      args.push(`--context=${input.context}`)
    } else {
      args.push(`--before-context=${input.context.before}`)
      args.push(`--after-context=${input.context.after}`)
    }
  }
  args.push("--", input.pattern, ...(input.file ?? ["."]))
  return args
}

function raceAbort<A, E, R>(effect: Effect.Effect<A, E, R>, signal?: AbortSignal) {
  return signal ? effect.pipe(Effect.raceFirst(waitForAbort(signal))) : effect
}

export const layer: Layer.Layer<Service, never, AppFileSystem.Service | ChildProcessSpawner | HttpClient.HttpClient> =
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* AppFileSystem.Service
      const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
      const spawner = yield* ChildProcessSpawner

      const run = Effect.fnUntraced(function* (command: string, args: string[], opts?: { cwd?: string }) {
        const handle = yield* spawner.spawn(
          ChildProcess.make(command, args, { cwd: opts?.cwd, extendEnv: true, stdin: "ignore" }),
        )
        const [stdout, stderr, code] = yield* Effect.all(
          [
            Stream.mkString(Stream.decodeText(handle.stdout)),
            Stream.mkString(Stream.decodeText(handle.stderr)),
            handle.exitCode,
          ],
          { concurrency: "unbounded" },
        )
        return { stdout, stderr, code }
      }, Effect.scoped)

      const extract = Effect.fnUntraced(function* (
        archive: string,
        config: (typeof PLATFORM)[keyof typeof PLATFORM],
        target: string,
      ) {
        const dir = yield* fs.makeTempDirectoryScoped({ directory: Global.Path.bin, prefix: "ripgrep-" })

        if (config.extension === "zip") {
          const shell = (yield* Effect.sync(() => which("powershell.exe") ?? which("pwsh.exe"))) ?? "powershell.exe"
          const result = yield* run(shell, [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `$global:ProgressPreference = 'SilentlyContinue'; Expand-Archive -LiteralPath '${archive.replaceAll("'", "''")}' -DestinationPath '${dir.replaceAll("'", "''")}' -Force`,
          ])
          if (result.code !== 0) {
            return yield* Effect.fail(error(result.stderr || result.stdout, result.code))
          }
        }

        if (config.extension === "tar.gz") {
          const result = yield* run("tar", ["-xzf", archive, "-C", dir])
          if (result.code !== 0) {
            return yield* Effect.fail(error(result.stderr || result.stdout, result.code))
          }
        }

        const extracted = path.join(
          dir,
          `ripgrep-${VERSION}-${config.platform}`,
          process.platform === "win32" ? "rg.exe" : "rg",
        )
        if (!(yield* fs.isFile(extracted))) {
          return yield* Effect.fail(new Error(`ripgrep archive did not contain executable: ${extracted}`))
        }

        yield* fs.copyFile(extracted, target)
        if (process.platform === "win32") return
        yield* fs.chmod(target, 0o755)
      }, Effect.scoped)

      const filepath = yield* Effect.cached(
        Effect.gen(function* () {
          const system = yield* Effect.sync(() => which(process.platform === "win32" ? "rg.exe" : "rg"))
          if (system && (yield* fs.isFile(system).pipe(Effect.orDie))) return system

          const target = path.join(Global.Path.bin, `rg${process.platform === "win32" ? ".exe" : ""}`)
          if (yield* fs.isFile(target).pipe(Effect.orDie)) return target

          const platformKey = `${process.arch}-${process.platform}` as keyof typeof PLATFORM
          const config = PLATFORM[platformKey]
          if (!config) {
            return yield* Effect.fail(new Error(`unsupported platform for ripgrep: ${platformKey}`))
          }

          const filename = `ripgrep-${VERSION}-${config.platform}.${config.extension}`
          const url = `https://github.com/BurntSushi/ripgrep/releases/download/${VERSION}/${filename}`
          const archive = path.join(Global.Path.bin, filename)

          log.info("downloading ripgrep", { url })
          yield* fs.ensureDir(Global.Path.bin).pipe(Effect.orDie)

          const bytes = yield* HttpClientRequest.get(url).pipe(
            http.execute,
            Effect.flatMap((response) => response.arrayBuffer),
            Effect.mapError((cause) => (cause instanceof Error ? cause : new Error(String(cause)))),
          )
          if (bytes.byteLength === 0) {
            return yield* Effect.fail(new Error(`failed to download ripgrep from ${url}`))
          }

          yield* fs.writeWithDirs(archive, new Uint8Array(bytes))
          yield* extract(archive, config, target)
          yield* fs.remove(archive, { force: true }).pipe(Effect.ignore)
          return target
        }),
      )

      const check = Effect.fnUntraced(function* (cwd: string) {
        if (yield* fs.isDir(cwd).pipe(Effect.orDie)) return
        return yield* Effect.fail(
          Object.assign(new Error(`No such file or directory: '${cwd}'`), {
            code: "ENOENT",
            errno: -2,
            path: cwd,
          }),
        )
      })

      const command = Effect.fnUntraced(function* (cwd: string, args: string[]) {
        const binary = yield* filepath
        return ChildProcess.make(binary, args, {
          cwd,
          env: env(),
          extendEnv: true,
          stdin: "ignore",
        })
      })

      const files: Interface["files"] = (input) =>
        Stream.callback<string, PlatformError | Error>((queue) =>
          Effect.gen(function* () {
            yield* Effect.forkScoped(
              Effect.gen(function* () {
                yield* check(input.cwd)
                const handle = yield* spawner.spawn(yield* command(input.cwd, filesArgs(input)))
                const stderr = yield* Stream.mkString(Stream.decodeText(handle.stderr)).pipe(Effect.forkScoped)
                const stdout = yield* Stream.decodeText(handle.stdout).pipe(
                  Stream.splitLines,
                  Stream.filter((line) => line.length > 0),
                  Stream.runForEach((line) => Effect.sync(() => Queue.offerUnsafe(queue, clean(line)))),
                  Effect.forkScoped,
                )
                const code = yield* raceAbort(handle.exitCode, input.signal)
                yield* Fiber.join(stdout)
                if (code === 0 || code === 1) {
                  Queue.endUnsafe(queue)
                  return
                }
                fail(queue, error(yield* Fiber.join(stderr), code))
              }).pipe(
                Effect.catch((err) =>
                  Effect.sync(() => {
                    fail(queue, err)
                  }),
                ),
              ),
            )
          }),
        )

      const search: Interface["search"] = Effect.fn("Ripgrep.search")(function* (input: SearchInput) {
        yield* check(input.cwd)

        const useJson = input.resultFormat === undefined || input.resultFormat === "content"
        const program = Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(yield* command(input.cwd, searchArgs(input)))

            const [items, stderr, code] = yield* Effect.all(
              [
                useJson
                  ? Stream.decodeText(handle.stdout).pipe(
                      Stream.splitLines,
                      Stream.filter((line) => line.length > 0),
                      Stream.mapEffect(parse),
                      // Emit a synthetic "match" for `context` events so
                      // the existing render path can show context lines
                      // alongside the match line. The downstream filter
                      // (in grep.ts) only cares that the items are
                      // match-shaped.
                      Stream.filter((item): item is Match | { type: "context"; data: Match["data"] } =>
                        item.type === "match" || item.type === "context",
                      ),
                      Stream.map((item): Match => {
                        if (item.type === "match") return item
                        return {
                          type: "match",
                          data: {
                            ...item.data,
                            submatches: [],
                          },
                        } as Match
                      }),
                      Stream.map((item) => row(item.data)),
                      Stream.runCollect,
                      Effect.map((chunk) => [...chunk]),
                    )
                  : Stream.mkString(Stream.decodeText(handle.stdout)).pipe(
                      Effect.map((text) => text.split("\n").filter((line) => line.length > 0)),
                    ),
                Stream.mkString(Stream.decodeText(handle.stderr)),
                handle.exitCode,
              ],
              { concurrency: "unbounded" },
            )

            if (code !== 0 && code !== 1 && code !== 2) {
              return yield* Effect.fail(error(stderr, code))
            }

            if (useJson) {
              return {
                items: code === 1 ? [] : (items as Item[]),
                partial: code === 2,
                resultFormat: "content" as const,
              }
            }
            return {
              items: code === 1 ? [] : (items as string[]),
              partial: code === 2,
              resultFormat: input.resultFormat as "files_with_matches" | "count",
            }
          }),
        )

        return yield* raceAbort(program, input.signal)
      })

      const tree: Interface["tree"] = Effect.fn("Ripgrep.tree")(function* (input: TreeInput) {
        log.info("tree", input)
        const list = Array.from(yield* files({ cwd: input.cwd, signal: input.signal }).pipe(Stream.runCollect))

        interface Node {
          name: string
          children: Map<string, Node>
        }

        function child(node: Node, name: string) {
          const item = node.children.get(name)
          if (item) return item
          const next = { name, children: new Map() }
          node.children.set(name, next)
          return next
        }

        function count(node: Node): number {
          return Array.from(node.children.values()).reduce((sum, child) => sum + 1 + count(child), 0)
        }

        const root: Node = { name: "", children: new Map() }
        for (const file of list) {
          if (file.includes(".mimocode")) continue
          const parts = file.split(path.sep)
          if (parts.length < 2) continue
          let node = root
          for (const part of parts.slice(0, -1)) {
            node = child(node, part)
          }
        }

        const total = count(root)
        const limit = input.limit ?? total
        const lines: string[] = []
        const queue: Array<{ node: Node; path: string }> = Array.from(root.children.values())
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((node) => ({ node, path: node.name }))

        let used = 0
        for (let i = 0; i < queue.length && used < limit; i++) {
          const item = queue[i]
          lines.push(item.path)
          used++
          queue.push(
            ...Array.from(item.node.children.values())
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((node) => ({ node, path: `${item.path}/${node.name}` })),
          )
        }

        if (total > used) lines.push(`[${total - used} truncated]`)
        return lines.join("\n")
      })

      return Service.of({ files, tree, search })
    }),
  )

export const defaultLayer = layer.pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(CrossSpawnSpawner.defaultLayer),
)

export * as Ripgrep from "./ripgrep"
