import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { Global } from "../../src/global"
import { WorkflowPersistence } from "../../src/workflow/persistence"
import { provideTmpdirInstance } from "../fixture/fixture"

// Audit §10: the workflow tool gained `list` (already in the
// runtime) and `logs` (new — reads the per-run journal file).
// These tests pin the contract for `WorkflowPersistence.readJournal`
// (used by the `logs` operation) using a direct journal write
// — no Session service required, so the test doesn't depend on
// the WorkflowRuntime layer's Instance context (which the
// heavy `makeLayer()` lib requires).

describe("WorkflowPersistence.readJournal", () => {
  test("returns [] when no journal file exists for the run", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const events = yield* WorkflowPersistence.readJournal("wf_doesnotexist")
        expect(events).toEqual([])
      }),
    ),
  )

  test("returns parsed events in append order when a journal exists", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const runID = "wf_logstest1"
        const journal = path.join(Global.Path.data, "workflow", `${runID}.jsonl`)
        // Hand-roll the journal (skip recordStart — that would
        // require the Session service). The reader is purely a
        // file parser.
        yield* Effect.promise(() =>
          Bun.write(
            journal,
            [
              JSON.stringify({ t: "log", msg: "first", pass: 0 }),
              JSON.stringify({ t: "log", msg: "second", pass: 0 }),
              JSON.stringify({ t: "log", msg: "third", pass: 0 }),
            ].join("\n") + "\n",
          ),
        )
        const events = yield* WorkflowPersistence.readJournal(runID)
        expect(events.length).toBe(3)
        expect((events[0] as { msg: string }).msg).toBe("first")
        expect((events[1] as { msg: string }).msg).toBe("second")
        expect((events[2] as { msg: string }).msg).toBe("third")
      }),
    ),
  )

  test("skips torn/partial lines (crash mid-append)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const runID = "wf_torntest1"
        const journal = path.join(Global.Path.data, "workflow", `${runID}.jsonl`)
        // A good line, then a partial line (no closing brace, no newline).
        yield* Effect.promise(() =>
          Bun.write(journal, '{"t":"log","msg":"good"}\n{"t":"log",'),
        )
        const events = yield* WorkflowPersistence.readJournal(runID)
        expect(events.length).toBe(1)
        expect((events[0] as { msg: string }).msg).toBe("good")
      }),
    ),
  )

  test("returns events for an empty journal file (zero events, not an error)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const runID = "wf_emptyrun1"
        const journal = path.join(Global.Path.data, "workflow", `${runID}.jsonl`)
        yield* Effect.promise(() => Bun.write(journal, ""))
        const events = yield* WorkflowPersistence.readJournal(runID)
        expect(events).toEqual([])
      }),
    ),
  )
})
