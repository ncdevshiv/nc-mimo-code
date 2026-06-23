#!/usr/bin/env bun

// Builds @nc-mimo-code/cli as a single executable and installs it under
// three names (ncmimocode, ncmimo, nc) into a directory already on PATH.
//
// Usage: bun run install:local
//
// Override the install dir with INSTALL_DIR (defaults to ~/bin on POSIX
// or %USERPROFILE%\bin on Windows).

import { $ } from "bun"
import fs from "fs"
import os from "os"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const pkgDir = path.resolve(__dirname, "..")

process.chdir(pkgDir)

const isWindows = process.platform === "win32"
const exeSuffix = isWindows ? ".exe" : ""
const arch = process.arch
const platformName = isWindows ? "windows" : process.platform
const builtBinary = path.join(
  pkgDir,
  "dist",
  `mimocode-${platformName}-${arch}`,
  "bin",
  `mimo${exeSuffix}`,
)

const installDir = process.env.INSTALL_DIR
  ?? path.join(os.homedir(), "bin")

const aliases = ["ncmimocode", "ncmimo", "nc"]

console.log(`> Building single-binary dev build`)
const build = Bun.spawn({
  cmd: ["bun", "run", "build:dev"],
  cwd: pkgDir,
  stdio: ["inherit", "inherit", "inherit"],
})
const exitCode = await build.exited
if (exitCode !== 0) {
  console.error(`Build failed with exit code ${exitCode}`)
  process.exit(exitCode)
}

if (!(await Bun.file(builtBinary).exists())) {
  console.error(`Build did not produce expected binary at ${builtBinary}`)
  process.exit(1)
}

await fs.promises.mkdir(installDir, { recursive: true })

const installed = await Promise.all(
  aliases.map(async (name) => {
    const target = path.join(installDir, `${name}${exeSuffix}`)
    await fs.promises.copyFile(builtBinary, target)
    return target
  }),
)

for (const file of installed) console.log(`  installed ${file}`)

const smoke = Bun.spawn({
  cmd: [path.join(installDir, `ncmimocode${exeSuffix}`), "--version"],
  stdio: ["inherit", "inherit", "inherit"],
})
await smoke.exited