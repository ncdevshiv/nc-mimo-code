import z from "zod"
import { Effect } from "effect"
import * as Tool from "./tool"
import { EditTool } from "./edit"
import DESCRIPTION from "./multiedit.txt"
import path from "path"
import { Instance } from "../project/instance"
import { AppFileSystem } from "@nc-mimo-code/shared/filesystem"
import { SessionCwd } from "./session-cwd"

export const MultiEditTool = Tool.define(
  "multiedit",
  Effect.gen(function* () {
    const editInfo = yield* EditTool
    const edit = yield* editInfo.init()
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: z.object({
        filePath: z.string().describe("The absolute path of the file every entry modifies"),
        edits: z
          .array(
            z.object({
              oldString: z.string().describe("The text to replace"),
              newString: z.string().describe("The text to replace it with (must be different from oldString)"),
              replaceAll: z.boolean().optional().describe("Replace all occurrences of oldString (default false)"),
            }),
          )
          .describe("Array of edit operations to perform sequentially on the file"),
      }),
      formatValidationError: Tool.formatZodError({
        filePath: { type: "string (absolute path)", required: true },
        edits: {
          type: "array of {oldString, newString, replaceAll?}",
          required: true,
          note: "each entry must have oldString and newString",
        },
      }),
      execute: (
        params: {
          filePath: string
          edits: Array<{ oldString: string; newString: string; replaceAll?: boolean }>
        },
        ctx: Tool.Context,
      ) =>
        Effect.gen(function* () {
          // PR-6 multiedit hardening: snapshot the pre-batch state so any
          // failed mid-batch edit rolls the file back to its
          // pre-multiedit content. The snapshot is taken before the
          // first edit runs (not lazily after edit #1) so the rollback
          // baseline is always the original file — even if edit #1
          // succeeds and a later edit fails.
          //
          // Note: each `edit.execute` call delegates to the edit tool,
          // which atomically writes the file. We use the per-edit
          // `oldString`/`newString` from the multiedit entries, so the
          // underlying write logic is identical to running `edit`
          // manually N times. The atomic rollback is purely a
          // safety-net for partial-batch failures.
          const filepath = path.isAbsolute(params.filePath)
            ? params.filePath
            : path.join(SessionCwd.get(ctx.sessionID), params.filePath)

          const existedAtStart = yield* fs.existsSafe(filepath)
          const originalContent = existedAtStart ? yield* fs.readFileString(filepath) : ""

          const results: Array<{ metadata: unknown; output: string }> = []
          // `edit.execute` uses `Effect.orDie` internally, so its
          // typed errors become defects. A JavaScript `try/catch`
          // inside `Effect.gen` does NOT catch Effect defects — we
          // must use `Effect.catchAllCause` on the loop pipeline to
          // observe failures and trigger rollback.
          yield* Effect.forEach(params.edits, (entry) =>
            edit.execute(
              {
                filePath: params.filePath,
                oldString: entry.oldString,
                newString: entry.newString,
                replaceAll: entry.replaceAll,
              },
              ctx,
            ).pipe(Effect.tap((r) => Effect.sync(() => results.push(r)))),
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                // Rollback: restore the original file (or delete it
                // if it didn't exist before the multiedit began).
                // Best-effort — we rethrow the original cause even if
                // rollback itself fails.
                yield* rollback(fs, filepath, existedAtStart, originalContent).pipe(
                  Effect.ignore,
                )
                return yield* Effect.failCause(cause)
              }),
            ),
          )

          if (results.length === 0) {
            return {
              title: path.relative(Instance.worktree, params.filePath),
              metadata: { results: [] },
              output: "No edits applied.",
            }
          }

          return {
            title: path.relative(Instance.worktree, params.filePath),
            metadata: {
              results: results.map((r) => r.metadata),
            },
            output: results.at(-1)!.output,
          }
        }),
    }
  }),
)

function rollback(
  fs: AppFileSystem.Interface,
  filepath: string,
  existedAtStart: boolean,
  originalContent: string,
) {
  return Effect.gen(function* () {
    if (existedAtStart) {
      yield* fs.writeAtomicWithDirs(filepath, originalContent)
    } else {
      yield* fs.remove(filepath).pipe(Effect.ignore)
    }
  })
}
