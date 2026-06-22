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
import { LRU } from "../../src/util/lru"

const ctx = {
  sessionID: SessionID.make("ses_test-edit-locks"),
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

describe("tool.edit: locks LRU eviction", () => {
  test("editing >256 distinct files in one process stays bounded", async () => {
    await using tmp = await tmpdir()
    // Create 260 distinct files in the tmpdir, each with a unique
    // matching anchor so the edit tool's lock path is exercised for
    // each one. The locks map is private to edit.ts, so we observe
    // its behavior indirectly: the LRU cap (256) means the 257th
    // distinct file's lock can be allocated without blocking the
    // process, the 258th file's edit still applies, and the test
    // completes (the LRU evicted earlier entries to make room).
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const edit = await resolve()
        const fileCount = 260
        for (let i = 0; i < fileCount; i++) {
          const filepath = path.join(tmp.path, `file-${i}.txt`)
          await fs.writeFile(filepath, `marker-${i}\n`, "utf-8")
        }
        // Run edits sequentially. Each one allocates a lock entry;
        // after 257 the LRU starts evicting oldest.
        for (let i = 0; i < fileCount; i++) {
          const filepath = path.join(tmp.path, `file-${i}.txt`)
          await Effect.runPromise(
            edit.execute(
              {
                filePath: filepath,
                oldString: `marker-${i}`,
                newString: `marker-${i}-edited`,
              },
              ctx,
            ),
          )
        }
        // Verify all files were edited (no entries were dropped mid-flight).
        for (let i = 0; i < fileCount; i++) {
          const filepath = path.join(tmp.path, `file-${i}.txt`)
          const content = await fs.readFile(filepath, "utf-8")
          expect(content).toBe(`marker-${i}-edited\n`)
        }
      },
    })
  })

  test("re-editing the same file repeatedly keeps the lock entry alive (LRU promotes)", async () => {
    await using tmp = await tmpdir()
    const filepath = path.join(tmp.path, "stable.txt")
    await fs.writeFile(filepath, "v=0\n", "utf-8")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const edit = await resolve()
        // 10 sequential edits to the same file — the lock entry is
        // touched on every call so even if TTL were 0ms it would stay
        // alive (LRU.get promotes).
        for (let i = 0; i < 10; i++) {
          await Effect.runPromise(
            edit.execute(
              {
                filePath: filepath,
                oldString: `v=${i}`,
                newString: `v=${i + 1}`,
              },
              ctx,
            ),
          )
        }
        expect(await fs.readFile(filepath, "utf-8")).toBe("v=10\n")
      },
    })
  })

  test("LRU helper used by edit tool honors max + ttlMs", () => {
    // Direct test of the helper's contract — verifies the unit the
    // edit tool consumes behaves correctly even when isolated from
    // the tool's full Effect runtime.
    let now = 0
    const cache = new LRU<string, { value: number }>(256, { ttlMs: 10 * 60 * 1000, now: () => now })
    for (let i = 0; i < 300; i++) {
      cache.set(`file-${i}`, { value: i })
    }
    expect(cache.size).toBe(256)
    // The first 44 inserts (file-0 through file-43) were evicted to
    // make room for the last 256. file-44 is the 45th insert, still
    // present (and gets promoted by the next get).
    expect(cache.get("file-0")).toBeUndefined()
    expect(cache.get("file-43")).toBeUndefined()
    expect(cache.get("file-44")).toEqual({ value: 44 })
    // file-299 should be present (most recent).
    expect(cache.get("file-299")).toEqual({ value: 299 })
    // Touch file-50 to promote it. file-44 was promoted by the prior
    // get, so the new oldest is file-45.
    expect(cache.get("file-50")).toEqual({ value: 50 })
    cache.set("file-new", { value: -1 })
    expect(cache.size).toBe(256)
    // file-45 was the oldest and got evicted by the new insert.
    expect(cache.get("file-45")).toBeUndefined()
    // file-44 was promoted earlier and survived.
    expect(cache.get("file-44")).toEqual({ value: 44 })
    // TTL: advance past the window.
    now = 11 * 60 * 1000
    expect(cache.get("file-299")).toBeUndefined()
  })
})