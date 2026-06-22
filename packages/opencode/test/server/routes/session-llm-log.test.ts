// Tests for the `GET /session/:sessionID/llm-log` route handler.
// PR-2 step 6 — verifies the route reads the per-session JSONL
// transcript log and applies the `tool` and `last` filters.

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { tmpdir } from "../../fixture/fixture"
import { TranscriptLog, type TranscriptEvent } from "../../../src/monitor/llm-transcript"
import { SessionID } from "../../../src/session/schema"
import type { SessionID as SessionIDT } from "../../../src/session/schema"
import { Global } from "../../../src/global"

function makeEvent(sessionID: string, messageID: string, toolName?: string): TranscriptEvent {
  const e: TranscriptEvent = {
    ts: Date.now(),
    sessionID,
    messageID,
    role: "assistant",
    model: { providerID: "test", modelID: "test-model" },
    request: { messages: [], tools: [] },
    response: [{ type: "text", text: "ok" }],
  }
  if (toolName) (e as { tool_calls?: Array<{ toolName: string; args: unknown }> }).tool_calls = [{ toolName, args: {} }]
  return e
}

describe("GET /session/:sessionID/llm-log route (filter logic)", () => {
  let tmp: { path: string; [Symbol.asyncDispose]: () => Promise<void> }
  let sessionID: SessionIDT

  beforeEach(async () => {
    tmp = await tmpdir()
    TranscriptLog.setLogDir(path.join(tmp.path, "sessions"))
    TranscriptLog.setEnabled(true)
    sessionID = SessionID.make("ses_test-llm-log-route")
  })

  afterEach(async () => {
    TranscriptLog.setEnabled(false)
    TranscriptLog.setLogDir(undefined)
  })

  test("returns all events when no filter is applied", async () => {
    await TranscriptLog.append(makeEvent(sessionID, "m1"))
    await TranscriptLog.append(makeEvent(sessionID, "m2"))
    const events = await TranscriptLog.read(sessionID)
    expect(events).toHaveLength(2)
  })

  test("filters events by tool name when tool= is supplied", async () => {
    await TranscriptLog.append(makeEvent(sessionID, "m1", "read"))
    await TranscriptLog.append(makeEvent(sessionID, "m2", "write"))
    await TranscriptLog.append(makeEvent(sessionID, "m3", "read"))
    const events = await TranscriptLog.read(sessionID)
    const filtered = events.filter((e) => e.tool_calls?.some((tc) => tc.toolName === "read"))
    expect(filtered).toHaveLength(2)
    expect(filtered.every((e) => e.tool_calls?.some((tc) => tc.toolName === "read"))).toBe(true)
  })

  test("applies last=N after the tool filter", async () => {
    await TranscriptLog.append(makeEvent(sessionID, "m1", "read"))
    await TranscriptLog.append(makeEvent(sessionID, "m2", "write"))
    await TranscriptLog.append(makeEvent(sessionID, "m3", "read"))
    await TranscriptLog.append(makeEvent(sessionID, "m4", "read"))
    const events = await TranscriptLog.read(sessionID)
    const filtered = events.filter((e) => e.tool_calls?.some((tc) => tc.toolName === "read"))
    const sliced = filtered.slice(-2)
    expect(sliced).toHaveLength(2)
    // Last two `read` events are m3 and m4.
    expect(sliced[0]?.messageID).toBe("m3")
    expect(sliced[1]?.messageID).toBe("m4")
  })

  test("returns an empty array for an unknown session", async () => {
    const events = await TranscriptLog.read(SessionID.make("ses_does-not-exist"))
    expect(events).toEqual([])
  })

  test("events are redacted before write (auth headers scrubbed)", async () => {
    const e: TranscriptEvent = {
      ts: Date.now(),
      sessionID,
      messageID: "m1",
      role: "assistant",
      request: { messages: [], tools: [] },
      response: {
        headers: { Authorization: "Bearer sk-secret-should-be-redacted" },
        body: { messages: [] },
      },
    }
    await TranscriptLog.append(e)
    const events = await TranscriptLog.read(sessionID)
    const written = JSON.stringify(events)
    expect(written).not.toContain("sk-secret-should-be-redacted")
    expect(written).toContain("[REDACTED]")
  })
})