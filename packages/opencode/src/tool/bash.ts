// Bash tool — the `BashTool` registration. The service-yielding
// implementation lives in `./bash-service`; this file is the
// tool-definition shell that the AI SDK sees.
//
// The tool's `execute` boundary is `Effect<ExecuteResult, never, never>`
// (per `tool.ts`'s `Tool.define` constraint). All the service-yielding
// work (process spawn, filesystem checks, plugin shell env, truncate
// file write, etc.) is consolidated behind a single
// `BashService.Service` yield, which collapses the public R to `never`
// and keeps the public surface stable. See bash-service.ts for the
// dependency-injection details.

import z from "zod"
import path from "path"
import { Effect } from "effect"
import { fileURLToPath } from "url"
import { Language, type Node } from "web-tree-sitter"

import { AppFileSystem } from "@nc-mimo-code/shared/filesystem"
import { lazy } from "@/util/lazy"
import { Flag } from "@/flag/flag"
import { Shell } from "@/shell/shell"
import { Log } from "@/util"
import { Instance } from "@/project/instance"

import { SessionCwd } from "./session-cwd"
import * as BashInteractive from "./bash-interactive"
import * as Tool from "./tool"
import * as BashService from "./bash-service"
import * as Truncate from "./truncate"
import DESCRIPTION from "./bash.txt"

const DEFAULT_TIMEOUT = Flag.NC_MIMO_CODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS || 2 * 60 * 1000
const PS = new Set(["powershell", "pwsh"])

const Parameters = z.object({
  command: z.string().describe("The command to execute"),
  timeout: z.number().describe("Optional timeout in milliseconds").optional(),
  workdir: z
    .string()
    .describe(
      `The working directory to run the command in. Defaults to the current directory. Use this instead of 'cd' commands.`,
    )
    .optional(),
  interactive: z
    .boolean()
    .describe(
      "Set to true when the command requires user interaction (password input, y/N confirmation, SSH key passphrase, etc). The terminal will be handed to the user for direct interaction.",
    )
    .optional(),
  description: z
    .string()
    .describe(
      "Clear, concise description of what this command does in 5-10 words. Examples:\nInput: ls\nOutput: Lists files in current directory\n\nInput: git status\nOutput: Shows working tree status\n\nInput: npm install\nOutput: Installs package dependencies\n\nInput: mkdir foo\nOutput: Creates directory 'foo'",
    ),
})

export const log = Log.create({ service: "bash-tool" })

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

const parser = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const { default: psWasm } = await import("tree-sitter-powershell/tree-sitter-powershell.wasm" as string, {
    with: { type: "wasm" },
  })
  const bashPath = resolveWasm(bashWasm)
  const psPath = resolveWasm(psWasm)
  const [bashLanguage, psLanguage] = await Promise.all([Language.load(bashPath), Language.load(psPath)])
  const bash = new Parser()
  bash.setLanguage(bashLanguage)
  const ps = new Parser()
  ps.setLanguage(psLanguage)
  return { bash, ps }
})

const parse = Effect.fn("BashTool.parse")(function* (command: string, ps: boolean) {
  const tree = yield* Effect.promise(() => parser().then((p) => (ps ? p.ps : p.bash).parse(command)))
  if (!tree) throw new Error("Failed to parse command")
  return tree.rootNode
})

const ask = Effect.fn("BashTool.ask")(function* (ctx: Tool.Context, scan: BashService.Scan) {
  if (scan.dirs.size > 0) {
    const globs = Array.from(scan.dirs).map((dir) => {
      if (process.platform === "win32") return AppFileSystem.normalizePathPattern(path.join(dir, "*"))
      return path.join(dir, "*")
    })
    yield* ctx.ask({
      permission: "external_directory",
      patterns: globs,
      always: globs,
      metadata: {},
    })
  }

  if (scan.patterns.size === 0) return
  yield* ctx.ask({
    permission: "bash",
    patterns: Array.from(scan.patterns),
    always: Array.from(scan.always),
    metadata: {},
  })
})

// The tool is registered as "bash" because the LLM has learned to
// call the bash tool across many prompts and tests; the name is a
// vestigial choice from when only bash was supported. The tool now
// handles sh/zsh/powershell/pwsh/cmd transparently (the `shell`
// field in `BashService.BashRunInput` is set per-call to the
// detected shell).
//
// `BashService.defaultLayer` is `Effect.provide`'d at this level
// because `BashService.defaultLayer` is self-contained (it provides
// its own upstream services). The init Effect's R is `BashService.Service`
// (a single service), but the public `Info` R is `never` because the
// `.pipe(Effect.provide(BashService.defaultLayer))` resolves it
// before `Tool.define` reads the R. This means the production
// `AppLayer` and the various test fixtures that mount `BashTool`
// standalone don't have to know about `BashService.Service` — it's
// satisfied locally. The audit doc's "no `BashService` leak past
// the tool boundary" invariant is what this preserves.
export const BashTool = Tool.define(
  "bash",
  Effect.gen(function* () {
    const svc = yield* BashService.Service

    return () =>
      Effect.sync(() => {
        const shell = Shell.acceptable()
        const name = Shell.name(shell)
        const chain =
          name === "powershell"
            ? "If the commands depend on each other and must run sequentially, avoid '&&' in this shell because Windows PowerShell 5.1 does not support it. Use PowerShell conditionals such as `cmd1; if ($?) { cmd2 }` when later commands must depend on earlier success."
            : "If the commands depend on each other and must run sequentially, use a single Bash call with '&&' to chain them together (e.g., `git add . && git commit -m \"message\" && git push`). For instance, if one operation must complete before another starts (like mkdir before cp, Write before Bash for git operations, or git add before git commit), run these operations sequentially instead."
        log.info("bash tool using shell", { shell })

        return {
          description: DESCRIPTION.replaceAll("${directory}", Instance.directory)
            .replaceAll("${os}", process.platform)
            .replaceAll("${shell}", name)
            .replaceAll("${chaining}", chain)
            .replaceAll("${maxLines}", String(Truncate.MAX_LINES))
            .replaceAll("${maxBytes}", String(Truncate.MAX_BYTES)),
          parameters: Parameters,
          formatValidationError: Tool.formatZodError({
            command: { type: "string", required: true },
            timeout: { type: "number (milliseconds, must be > 0)", required: false, note: "default 2 min, max 10 min recommended" },
            workdir: { type: "string (absolute path)", required: false, note: "use instead of `cd` commands" },
            interactive: { type: "boolean", required: false, note: "set true when the command needs user input" },
            description: { type: "string (5-10 words)", required: true },
          }),
          execute: (params: z.infer<typeof Parameters>, ctx: Tool.Context) =>
            Effect.gen(function* () {
              const effectiveCwd = SessionCwd.get(ctx.sessionID)
              const cwd = params.workdir
                ? yield* svc.resolvePath(params.workdir, effectiveCwd, shell)
                : effectiveCwd
              if (params.timeout !== undefined && params.timeout < 0) {
                throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
              }
              const timeout = params.timeout ?? DEFAULT_TIMEOUT
              const ps = PS.has(name)
              const root: Node = yield* parse(params.command, ps)
              const scan = yield* svc.collect(root, cwd, ps, shell)
              if (!Instance.containsPath(cwd)) scan.dirs.add(cwd)
              yield* ask(ctx, scan)

              if (params.interactive) {
                const env = yield* svc.shellEnv(ctx, cwd)
                yield* ctx.metadata({
                  metadata: {
                    output: "(waiting for user interaction...)",
                    description: params.description,
                  },
                })
                const interactiveResult = yield* Effect.tryPromise(() =>
                  BashInteractive.request({
                    command: params.command,
                    cwd,
                    env: env as Record<string, string>,
                    description: params.description,
                  }),
                ).pipe(Effect.orDie)
                return {
                  title: params.description,
                  metadata: {
                    output: interactiveResult.output || "(interactive command completed)",
                    exit: interactiveResult.exitCode,
                    description: params.description,
                    truncated: false,
                  },
                  output:
                    interactiveResult.output ||
                    `(interactive command completed with exit code ${interactiveResult.exitCode})`,
                }
              }

              return yield* svc.run(
                {
                  shell,
                  name,
                  command: params.command,
                  cwd,
                  env: yield* svc.shellEnv(ctx, cwd),
                  timeout,
                  description: params.description,
                },
                ctx,
              )
            }),
        }
      })
  }),
).pipe(Effect.provide(BashService.defaultLayer))
