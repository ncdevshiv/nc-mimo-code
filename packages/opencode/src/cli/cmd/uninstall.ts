import type { Argv } from "yargs"
import { UI } from "../ui"
import * as prompts from "@clack/prompts"
import { AppRuntime } from "@/effect/app-runtime"
import { Installation } from "../../installation"
import { Global } from "../../global"
import { Config } from "../../config"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { Filesystem } from "../../util"
import { Process } from "../../util"

// PR-4 (audit §9): the install methods this npm-published build
// supports out of the box. brew/choco/scoop are listed in the
// `ConfigInstallation.Info.channels` schema but not in the default
// — they are flipped on at publish time. The uninstall command
// treats any method not in the resolved channel list as "skip":
// the summary hides the Package: line, the executor warns and
// moves on. This is the "no commented-out replacement code"
// behavior prescribed by mpr.md §6/§12.
const DEFAULT_CHANNELS: Installation.Method[] = ["npm", "pnpm", "bun"]

// Full map of install method -> argv for the package-manager
// uninstall command. Filtered at runtime by the user's
// `installation.channels` config — the data lives here as a flat
// record (not as commented-out code) so the config is the single
// source of truth for *which* channels to expose, and this map is
// the single source of truth for *what command* each channel runs.
const PACKAGE_MANAGER_UNINSTALL_CMDS: Record<Installation.Method, string[]> = {
  npm: ["npm", "uninstall", "-g", "@nc-mimo-code/cli"],
  pnpm: ["pnpm", "uninstall", "-g", "@nc-mimo-code/cli"],
  bun: ["bun", "remove", "-g", "@nc-mimo-code/cli"],
  brew: ["brew", "uninstall", "@nc-mimo-code/cli"],
  choco: ["choco", "uninstall", "-y", "@nc-mimo-code/cli"],
  scoop: ["scoop", "uninstall", "@nc-mimo-code/cli"],
  // curl and unknown are runtime-detected states, not publishable
  // channels. They never appear in `installation.channels` and so
  // never reach `buildPackageManagerCommandArrays`. Stub entries
  // keep the record's type honest; both branches are unreachable.
  curl: [],
  unknown: [],
}

interface UninstallArgs {
  keepConfig: boolean
  keepData: boolean
  dryRun: boolean
  force: boolean
}

interface RemovalTargets {
  directories: Array<{ path: string; label: string; keep: boolean }>
  shellConfig: string | null
  binary: string | null
}

export const UninstallCommand = {
  command: "uninstall",
  describe: "uninstall mimocode and remove all related files",
  builder: (yargs: Argv) =>
    yargs
      .option("keep-config", {
        alias: "c",
        type: "boolean",
        describe: "keep configuration files",
        default: false,
      })
      .option("keep-data", {
        alias: "d",
        type: "boolean",
        describe: "keep session data and snapshots",
        default: false,
      })
      .option("dry-run", {
        type: "boolean",
        describe: "show what would be removed without removing",
        default: false,
      })
      .option("force", {
        alias: "f",
        type: "boolean",
        describe: "skip confirmation prompts",
        default: false,
      }),

  handler: async (args: UninstallArgs) => {
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    prompts.intro("Uninstall NcMimoCode")

    const method = await AppRuntime.runPromise(Installation.Service.use((svc) => svc.method()))
    const config = await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.get()))
    const channels = resolveChannels(config.installation?.channels)
    prompts.log.info(`Installation method: ${method}`)

    const targets = await collectRemovalTargets(args, method)

    await showRemovalSummary(targets, method, channels)

    if (!args.force && !args.dryRun) {
      const confirm = await prompts.confirm({
        message: "Are you sure you want to uninstall?",
        initialValue: false,
      })
      if (!confirm || prompts.isCancel(confirm)) {
        prompts.outro("Cancelled")
        return
      }
    }

    if (args.dryRun) {
      prompts.log.warn("Dry run - no changes made")
      prompts.outro("Done")
      return
    }

    await executeUninstall(method, targets, channels)

    prompts.outro("Done")
  },
}

async function collectRemovalTargets(args: UninstallArgs, method: Installation.Method): Promise<RemovalTargets> {
  const directories: RemovalTargets["directories"] = [
    { path: Global.Path.data, label: "Data", keep: args.keepData },
    { path: Global.Path.cache, label: "Cache", keep: false },
    { path: Global.Path.config, label: "Config", keep: args.keepConfig },
    { path: Global.Path.state, label: "State", keep: false },
  ]

  const shellConfig = method === "curl" ? await getShellConfigFile() : null
  const binary = method === "curl" ? process.execPath : null

  return { directories, shellConfig, binary }
}

async function showRemovalSummary(
  targets: RemovalTargets,
  method: Installation.Method,
  channels: ReadonlyArray<Installation.Method>,
) {
  prompts.log.message("The following will be removed:")

  for (const dir of targets.directories) {
    const exists = await fs
      .access(dir.path)
      .then(() => true)
      .catch(() => false)
    if (!exists) continue

    const size = await getDirectorySize(dir.path)
    const sizeStr = formatSize(size)
    const status = dir.keep ? UI.Style.TEXT_DIM + "(keeping)" : ""
    const prefix = dir.keep ? "○" : "✓"

    prompts.log.info(`  ${prefix} ${dir.label}: ${shortenPath(dir.path)} ${UI.Style.TEXT_DIM}(${sizeStr})${status}`)
  }

  if (targets.binary) {
    prompts.log.info(`  ✓ Binary: ${shortenPath(targets.binary)}`)
  }

  if (targets.shellConfig) {
    prompts.log.info(`  ✓ Shell PATH in ${shortenPath(targets.shellConfig)}`)
  }

  if (method !== "curl" && method !== "unknown") {
    // The list of package-manager channels this build is published
    // to comes from the user's `installation.channels` config (with
    // the npm-published default applied by `resolveChannels` when
    // the field is absent). The `cmds` map is built dynamically
    // by `buildPackageManagerCommandArrays` so the uninstall
    // summary reflects exactly what `install` would have used —
    // no commented-out stubs, no placeholders. When a new channel
    // is published, flip on the `Method` in `installation.channels`
    // (or set the default in `DEFAULT_CHANNELS` at publish time).
    const cmds = buildPackageManagerCommandArrays(channels)
    const cmd = cmds[method]
    if (cmd) {
      prompts.log.info(`  ✓ Package: ${cmd.join(" ")}`)
    } else {
      prompts.log.info(`  ○ Package: ${method} (not in installation.channels, skipping)`)
    }
  }
}

/**
 * Resolve the effective channel list. Falls back to
 * `DEFAULT_CHANNELS` when the user has not configured
 * `installation.channels` (the npm-published build) or has set it
 * to an empty array (the user explicitly opted out of all package
 * managers — e.g. they want the binary-rm path that `curl` would
 * use).
 *
 * Exported for tests (PR-4 audit §9.6 "config-driven tests").
 */
export function resolveChannels(
  configured: ReadonlyArray<Installation.Method> | undefined,
): Installation.Method[] {
  if (!configured || configured.length === 0) return [...DEFAULT_CHANNELS]
  return [...configured]
}

/**
 * Build the package-manager -> uninstall-command array map, filtered
 * to the channels the user (or the publish-time default) has enabled.
 * Channels not in the resolved list are absent from the result; the
 * summary + executor then both treat "absent" as "skip".
 *
 * Exported for tests (PR-4 audit §9.6 "config-driven tests").
 */
export function buildPackageManagerCommandArrays(
  channels: ReadonlyArray<Installation.Method>,
): Record<string, string[]> {
  const cmds: Record<string, string[]> = {}
  for (const channel of channels) {
    const cmd = PACKAGE_MANAGER_UNINSTALL_CMDS[channel]
    if (cmd && cmd.length > 0) cmds[channel] = cmd
  }
  return cmds
}

async function executeUninstall(
  method: Installation.Method,
  targets: RemovalTargets,
  channels: ReadonlyArray<Installation.Method>,
) {
  const spinner = prompts.spinner()
  const errors: string[] = []

  for (const dir of targets.directories) {
    if (dir.keep) {
      prompts.log.step(`Skipping ${dir.label} (--keep-${dir.label.toLowerCase()})`)
      continue
    }

    const exists = await fs
      .access(dir.path)
      .then(() => true)
      .catch(() => false)
    if (!exists) continue

    spinner.start(`Removing ${dir.label}...`)
    const err = await fs.rm(dir.path, { recursive: true, force: true }).catch((e) => e)
    if (err) {
      spinner.stop(`Failed to remove ${dir.label}`, 1)
      errors.push(`${dir.label}: ${err.message}`)
      continue
    }
    spinner.stop(`Removed ${dir.label}`)
  }

  if (targets.shellConfig) {
    spinner.start("Cleaning shell config...")
    const err = await cleanShellConfig(targets.shellConfig).catch((e) => e)
    if (err) {
      spinner.stop("Failed to clean shell config", 1)
      errors.push(`Shell config: ${err.message}`)
    } else {
      spinner.stop("Cleaned shell config")
    }
  }

  if (method !== "curl" && method !== "unknown") {
    const cmds = buildPackageManagerCommandArrays(channels)
    const cmd = cmds[method]
    if (cmd) {
      spinner.start(`Running ${cmd.join(" ")}...`)
      const result = await Process.run(cmd, {
        nothrow: true,
      })
      if (result.code !== 0) {
        spinner.stop(`Package manager uninstall failed: exit code ${result.code}`, 1)
        prompts.log.warn(`You may need to run manually: ${cmd.join(" ")}`)
      } else {
        spinner.stop("Package removed")
      }
    } else {
      prompts.log.warn(`Uninstall not supported for method "${method}" (not in installation.channels), skipping package removal`)
    }
  }

  if (method === "curl" && targets.binary) {
    UI.empty()
    prompts.log.message("To finish removing the binary, run:")
    prompts.log.info(`  rm "${targets.binary}"`)

    const binDir = path.dirname(targets.binary)
    if (binDir.includes(".mimocode")) {
      prompts.log.info(`  rmdir "${binDir}" 2>/dev/null`)
    }
  }

  if (errors.length > 0) {
    UI.empty()
    prompts.log.warn("Some operations failed:")
    for (const err of errors) {
      prompts.log.error(`  ${err}`)
    }
  }

  UI.empty()
  prompts.log.success("Thank you for using NcMimoCode!")
}

async function getShellConfigFile(): Promise<string | null> {
  const shell = path.basename(process.env.SHELL || "bash")
  const home = os.homedir()
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(home, ".config")

  const configFiles: Record<string, string[]> = {
    fish: [path.join(xdgConfig, "fish", "config.fish")],
    zsh: [
      path.join(home, ".zshrc"),
      path.join(home, ".zshenv"),
      path.join(xdgConfig, "zsh", ".zshrc"),
      path.join(xdgConfig, "zsh", ".zshenv"),
    ],
    bash: [
      path.join(home, ".bashrc"),
      path.join(home, ".bash_profile"),
      path.join(home, ".profile"),
      path.join(xdgConfig, "bash", ".bashrc"),
      path.join(xdgConfig, "bash", ".bash_profile"),
    ],
    ash: [path.join(home, ".ashrc"), path.join(home, ".profile")],
    sh: [path.join(home, ".profile")],
  }

  const candidates = configFiles[shell] || configFiles.bash

  for (const file of candidates) {
    const exists = await fs
      .access(file)
      .then(() => true)
      .catch(() => false)
    if (!exists) continue

    const content = await Filesystem.readText(file).catch(() => "")
    if (content.includes("# mimocode") || content.includes(".nc-mimo-code/bin")) {
      return file
    }
  }

  return null
}

async function cleanShellConfig(file: string) {
  const content = await Filesystem.readText(file)
  const lines = content.split("\n")

  const filtered: string[] = []
  let skip = false

  for (const line of lines) {
    const trimmed = line.trim()

    if (trimmed === "# mimocode") {
      skip = true
      continue
    }

    if (skip) {
      skip = false
      if (trimmed.includes(".nc-mimo-code/bin") || trimmed.includes("fish_add_path")) {
        continue
      }
    }

    if (
      (trimmed.startsWith("export PATH=") && trimmed.includes(".nc-mimo-code/bin")) ||
      (trimmed.startsWith("fish_add_path") && trimmed.includes(".mimocode"))
    ) {
      continue
    }

    filtered.push(line)
  }

  while (filtered.length > 0 && filtered[filtered.length - 1].trim() === "") {
    filtered.pop()
  }

  const output = filtered.join("\n") + "\n"
  await Filesystem.write(file, output)
}

async function getDirectorySize(dir: string): Promise<number> {
  let total = 0

  const walk = async (current: string) => {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])

    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (entry.isFile()) {
        const stat = await fs.stat(full).catch(() => null)
        if (stat) total += stat.size
      }
    }
  }

  await walk(dir)
  return total
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function shortenPath(p: string): string {
  const home = os.homedir()
  if (p.startsWith(home)) {
    return p.replace(home, "~")
  }
  return p
}
