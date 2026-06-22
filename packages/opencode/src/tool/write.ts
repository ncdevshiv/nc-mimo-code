import z from "zod"
import * as path from "path"
import { Effect } from "effect"
import * as Tool from "./tool"
import { LSP } from "../lsp"
import { createTwoFilesPatch } from "diff"
import DESCRIPTION from "./write.txt"
import { Bus } from "../bus"
import { File } from "../file"
import { FileWatcher } from "../file/watcher"
import { Format } from "../format"
import { AppFileSystem } from "@nc-mimo-code/shared/filesystem"
import { Instance } from "../project/instance"
import { SessionCwd } from "./session-cwd"
import { trimDiff } from "./edit"
import { assertWriteAllowed, askEditUnlessMemory } from "./external-directory"

const MAX_PROJECT_DIAGNOSTICS_FILES = 5

export const WriteTool = Tool.define(
  "write",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const fs = yield* AppFileSystem.Service
    const bus = yield* Bus.Service
    const format = yield* Format.Service

    return {
      description: DESCRIPTION,
      parameters: z.object({
        content: z.string().describe("The content to write to the file"),
        filePath: z.string().describe("The absolute path to the file to write (must be absolute, not relative)"),
        // PR-6 write tool hardening: explicit mode for scripts vs data
        // files. When omitted, the tool preserves the executable bit
        // of the pre-existing file (or defaults to 0o644 for new
        // files). `"executable"` sets 0o755 (scripts); `"file"` sets
        // 0o644 (data files / config). On non-POSIX platforms the
        // chmod call is a no-op (the AppFileSystem layer ignores it).
        mode: z
          .enum(["file", "executable"])
          .optional()
          .describe(
            "Explicit file mode. 'executable' for scripts (0o755), 'file' for data (0o644). When omitted, the existing file's executable bit is preserved (or 0o644 for new files).",
          ),
      }),
      formatValidationError: Tool.formatZodError({
        content: { type: "string", required: true },
        filePath: { type: "string (absolute path, not relative)", required: true },
      }),
      execute: (
        params: { content: string; filePath: string; mode?: "file" | "executable" },
        ctx: Tool.Context,
      ) =>
        Effect.gen(function* () {
          const filepath = path.isAbsolute(params.filePath)
            ? params.filePath
            : path.join(SessionCwd.get(ctx.sessionID), params.filePath)
          yield* assertWriteAllowed(ctx, filepath)

          const exists = yield* fs.existsSafe(filepath)
          const contentOld = exists ? yield* fs.readFileString(filepath) : ""

          const diff = trimDiff(createTwoFilesPatch(filepath, filepath, contentOld, params.content))
          yield* askEditUnlessMemory(ctx, filepath, {
            patterns: [path.relative(Instance.worktree, filepath)],
            diff,
          })

          // Resolve the target mode. Explicit `mode` param wins;
          // otherwise preserve the existing file's executable bit
          // (or 0o644 default for new files).
          let modeOctal: number | undefined
          if (params.mode === "executable") modeOctal = 0o755
          else if (params.mode === "file") modeOctal = 0o644
          else if (exists) {
            const stat = yield* fs.stat(filepath)
            const currentMode = stat.mode ?? 0
            modeOctal = (currentMode & 0o111) !== 0 ? 0o755 : 0o644
          } else {
            modeOctal = 0o644
          }

          yield* fs.writeAtomicWithDirs(filepath, params.content, modeOctal)
          yield* format.file(filepath)
          yield* bus.publish(File.Event.Edited, { file: filepath })
          yield* bus.publish(FileWatcher.Event.Updated, {
            file: filepath,
            event: exists ? "change" : "add",
          })

          let output = "Wrote file successfully."
          yield* lsp.touchFile(filepath, true)
          const diagnostics = yield* lsp.diagnostics()
          const normalizedFilepath = AppFileSystem.normalizePath(filepath)
          let projectDiagnosticsCount = 0
          for (const [file, issues] of Object.entries(diagnostics)) {
            const current = file === normalizedFilepath
            if (!current && projectDiagnosticsCount >= MAX_PROJECT_DIAGNOSTICS_FILES) continue
            const block = LSP.Diagnostic.report(current ? filepath : file, issues)
            if (!block) continue
            if (current) {
              output += `\n\nLSP errors detected in this file, please fix:\n${block}`
              continue
            }
            projectDiagnosticsCount++
            output += `\n\nLSP errors detected in other files:\n${block}`
          }

          return {
            title: path.relative(Instance.worktree, filepath),
            metadata: {
              diagnostics,
              filepath,
              exists: exists,
            },
            output,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
