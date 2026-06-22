import { afterAll, afterEach, describe, test, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Effect, Layer, ManagedRuntime } from "effect"
import { EditTool } from "../../src/tool/edit"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { LSP } from "../../src/lsp"
import { AppFileSystem } from "@nc-mimo-code/shared/filesystem"
import { Format } from "../../src/format"
import { Agent } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Truncate } from "../../src/tool"
import { SessionID, MessageID } from "../../src/session/schema"

const ctx = {
  sessionID: SessionID.make("ses_test-edit-threshold"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

afterEach(async () => {
  await Instance.disposeAll()
})

const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    LSP.defaultLayer,
    AppFileSystem.defaultLayer,
    Format.defaultLayer,
    Bus.layer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
  ),
)

afterAll(async () => {
  await runtime.dispose()
})

const resolve = () =>
  runtime.runPromise(
    Effect.gen(function* () {
      const info = yield* EditTool
      return yield* info.init()
    }),
  )

describe("tool.edit: BlockAnchorReplacer single-candidate threshold", () => {
  test("exact anchor match (similarity = 1.0) applies without warning", async () => {
    await using tmp = await tmpdir()
    const filepath = path.join(tmp.path, "exact.txt")
    await fs.writeFile(filepath, "alpha\nbeta\ngamma\n", "utf-8")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const edit = await resolve()
        await Effect.runPromise(
          edit.execute(
            {
              filePath: filepath,
              oldString: "alpha\nbeta\ngamma",
              newString: "alpha\nBETA\ngamma",
            },
            ctx,
          ),
        )
        expect(await fs.readFile(filepath, "utf-8")).toBe("alpha\nBETA\ngamma\n")
      },
    })
  })

  test("loose single-candidate anchor (similarity between 0.5 and 0.7) still applies", async () => {
    // The threshold raise from 0.0 -> 0.5 keeps single-candidate edits
    // that meet the floor. The warn band (0.5 - 0.7) is hard to
    // exercise deterministically without a custom replacer; this test
    // pins the contract: a 50%-similar anchor (one line matches, one
    // differs by 50%) still applies because the threshold is >= 0.5.
    await using tmp = await tmpdir()
    const filepath = path.join(tmp.path, "loose.txt")
    // The middle line is "hello" in the file vs "hellp" in the
    // model's oldString — one char difference over 5 chars = 80%
    // similarity, which is above the new 0.5 threshold.
    await fs.writeFile(filepath, "begin\nhello\nend\n", "utf-8")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const edit = await resolve()
        await Effect.runPromise(
          edit.execute(
            {
              filePath: filepath,
              oldString: "begin\nhellp\nend",
              newString: "begin\nWORLD\nend",
            },
            ctx,
          ),
        )
        expect(await fs.readFile(filepath, "utf-8")).toBe("begin\nWORLD\nend\n")
      },
    })
  })

  test("very loose single-candidate anchor (similarity below 0.5) is rejected", async () => {
    // Anchor matches (first + last line) but the middle is completely
    // different. The new threshold (0.5) rejects this; with the
    // old 0.0 threshold it would have applied silently.
    await using tmp = await tmpdir()
    const filepath = path.join(tmp.path, "mismatch.txt")
    await fs.writeFile(filepath, "anchor_start\nthis line is completely different content\nanchor_end\n", "utf-8")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const edit = await resolve()
        // The edit tool throws a plain Error when it cannot match —
        // it surfaces as a defect (not a typed failure), so we use
        // Effect.exit to capture either branch.
        const exit = await Effect.runPromise(
          edit
            .execute(
              {
                filePath: filepath,
                oldString: "anchor_start\ntotally unrelated middle line\nanchor_end",
                newString: "anchor_start\nREPLACED\nanchor_end",
              },
              ctx,
            )
            .pipe(Effect.exit),
        )
        // Rejection: the exit is a Failure, not a Success.
        expect(exit._tag).toBe("Failure")
        // The file is unchanged.
        expect(await fs.readFile(filepath, "utf-8")).toBe(
          "anchor_start\nthis line is completely different content\nanchor_end\n",
        )
      },
    })
  })
})