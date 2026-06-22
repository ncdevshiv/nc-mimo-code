import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "../../src/storage"
import { HistoryFtsTable } from "../../src/history/fts.sql"
import { MessageTable, PartTable, SessionTable } from "../../src/session/session.sql"
import { ProjectTable } from "../../src/project/project.sql"
import { HistoryTool } from "../../src/tool/history"
import { History } from "../../src/history"
import { Truncate } from "../../src/tool"
import { Agent } from "../../src/agent/agent"
import { Instance } from "../../src/project/instance"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { SessionID, MessageID } from "../../src/session/schema"

// Audit §10: `history.result_format` (`ids | snippets | full`)
// gates how much output is rendered per hit. The default is
// `snippets` (back-compat); `ids` is the cheap mode for "which
// sessions touched X?"; `full` is the same as `snippets` today
// but lets the LLM be explicit when it wants untruncated bodies.

afterEach(async () => {
  Database.use((db) => {
    db.delete(HistoryFtsTable).run()
    db.delete(PartTable).run()
    db.delete(MessageTable).run()
    db.delete(SessionTable).run()
    db.delete(ProjectTable).run()
  })
  await Instance.disposeAll()
})

const it = testEffect(
  Layer.mergeAll(History.defaultLayer, Truncate.defaultLayer, Agent.defaultLayer, CrossSpawnSpawner.defaultLayer),
)

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

function seedRow(body: string, sessionID = "ses_a", messageID = "msg_a", kind = "user_text") {
  Database.use((db) => {
    db.insert(HistoryFtsTable)
      .values({
        part_id: `p_${messageID}`,
        session_id: sessionID,
        message_id: messageID,
        project_id: "proj_a",
        kind,
        tool_name: null,
        body,
        time_created: 1000,
      })
      .run()
  })
}

describe("HistoryTool: result_format", () => {
  it.live("default (no result_format) renders snippets", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        seedRow("JWT signing test")
        const info = yield* HistoryTool
        const tool = yield* info.init()
        const result = yield* tool.execute(
          { operation: "search", query: "JWT", scope: "global" },
          ctx as any,
        )
        expect(result.output).toContain("msg_a")
        // FTS5 wraps the matched term in <<>> markers, so the
        // snippet body shows `<<JWT>> signing test`. Asserting
        // on the marker (not the raw text) pins the test to
        // actual search behavior.
        expect(result.output).toContain("<<JWT>>")
        // Default format also includes the Time/Score line.
        expect(result.output).toContain("Time:")
        expect(result.metadata.count).toBe(1)
      }),
    ),
  )

  it.live("result_format: 'ids' renders only the header line, no snippet/time/score", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        seedRow("JWT signing test")
        const info = yield* HistoryTool
        const tool = yield* info.init()
        const result = yield* tool.execute(
          { operation: "search", query: "JWT", scope: "global", result_format: "ids" },
          ctx as any,
        )
        // IDs: header is preserved.
        expect(result.output).toContain("msg_a")
        // IDs: snippet body, Time, and Score are all omitted.
        expect(result.output).not.toContain("<<JWT>>")
        expect(result.output).not.toContain("Time:")
        expect(result.output).not.toContain("Score:")
        expect(result.metadata.count).toBe(1)
      }),
    ),
  )

  it.live("result_format: 'snippets' (explicit) renders header + time/score + snippet", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        seedRow("JWT signing test")
        const info = yield* HistoryTool
        const tool = yield* info.init()
        const result = yield* tool.execute(
          { operation: "search", query: "JWT", scope: "global", result_format: "snippets" },
          ctx as any,
        )
        expect(result.output).toContain("msg_a")
        expect(result.output).toContain("<<JWT>>")
        expect(result.output).toContain("Time:")
        expect(result.output).toContain("Score:")
        expect(result.metadata.count).toBe(1)
      }),
    ),
  )

  it.live("result_format: 'full' renders header + time/score + snippet (same as snippets today)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        seedRow("JWT signing test")
        const info = yield* HistoryTool
        const tool = yield* info.init()
        const result = yield* tool.execute(
          { operation: "search", query: "JWT", scope: "global", result_format: "full" },
          ctx as any,
        )
        expect(result.output).toContain("msg_a")
        expect(result.output).toContain("<<JWT>>")
        expect(result.output).toContain("Time:")
        expect(result.output).toContain("Score:")
        expect(result.metadata.count).toBe(1)
      }),
    ),
  )

  it.live("result_format: 'ids' across multiple hits preserves every header and skips every body", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        seedRow("JWT in session A", "ses_a", "msg_a")
        seedRow("JWT in session B", "ses_b", "msg_b")
        const info = yield* HistoryTool
        const tool = yield* info.init()
        const result = yield* tool.execute(
          { operation: "search", query: "JWT", scope: "global", result_format: "ids" },
          ctx as any,
        )
        expect(result.metadata.count).toBeGreaterThanOrEqual(1)
        // No body markers in ids mode.
        expect(result.output).not.toContain("<<JWT>>")
        // Headers preserved.
        expect(result.output).toContain("msg_a")
        expect(result.output).toContain("msg_b")
      }),
    ),
  )

  it.live("0-match path returns 0-matches output regardless of result_format", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const info = yield* HistoryTool
        const tool = yield* info.init()
        for (const fmt of ["ids", "snippets", "full"] as const) {
          const result = yield* tool.execute(
            { operation: "search", query: "nothing", scope: "global", result_format: fmt },
            ctx as any,
          )
          expect(result.metadata.count).toBe(0)
          expect(result.output).toContain("0 matches")
        }
      }),
    ),
  )
})
