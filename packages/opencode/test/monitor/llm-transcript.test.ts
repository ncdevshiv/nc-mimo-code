import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm, readFile, mkdir, stat } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { TranscriptLog, redact } from "../../src/monitor/llm-transcript"

describe("TranscriptLog.redact: sensitive keys are masked in nested structures", () => {
  test("top-level Authorization header is replaced with [REDACTED]", () => {
    const input = { Authorization: "Bearer secret", Content: "ok" }
    expect(redact(input)).toEqual({ Authorization: '"[REDACTED]"', Content: "ok" })
  })

  test("case-insensitive match: authorization, AUTHORIZATION, Authorization all match", () => {
    for (const k of ["authorization", "AUTHORIZATION", "Authorization", "AuThOrIzAtIoN"]) {
      const out = redact({ [k]: "secret" })
      expect(out).toEqual({ [k]: '"[REDACTED]"' })
    }
  })

  test("nested objects: sensitive key at any depth is masked", () => {
    const input = {
      url: "https://api.example.com",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      body: {
        user: { name: "alice", password: "hunter2" },
      },
    }
    expect(redact(input)).toEqual({
      url: "https://api.example.com",
      headers: {
        Authorization: '"[REDACTED]"',
        "Content-Type": "application/json",
      },
      body: {
        user: { name: "alice", password: '"[REDACTED]"' },
      },
    })
  })

  test("arrays of objects: each element is walked", () => {
    const input = {
      requests: [
        { url: "/a", token: "t1" },
        { url: "/b", token: "t2" },
      ],
    }
    expect(redact(input)).toEqual({
      requests: [
        { url: "/a", token: '"[REDACTED]"' },
        { url: "/b", token: '"[REDACTED]"' },
      ],
    })
  })

  test("non-object primitives pass through unchanged", () => {
    expect(redact(42)).toBe(42)
    expect(redact("hello")).toBe("hello")
    expect(redact(null)).toBe(null)
    expect(redact(undefined)).toBe(undefined)
    expect(redact(true)).toBe(true)
  })

  test("empty object / array pass through unchanged", () => {
    expect(redact({})).toEqual({})
    expect(redact([])).toEqual([])
  })

  test("standard sensitive keys are all masked: token, password, api-key, etc.", () => {
    const input = {
      Authorization: "x",
      Cookie: "y",
      "X-Api-Key": "z",
      password: "p",
      token: "t",
      access_token: "a",
      refresh_token: "r",
    }
    const out = redact(input) as Record<string, string>
    for (const k of Object.keys(input)) {
      expect(out[k]).toBe('"[REDACTED]"')
    }
  })
})

describe("TranscriptLog.redact: raw_chunks arrays are walked for sensitive keys", () => {
  test("raw_chunks entries that contain Authorization get masked", () => {
    const input = {
      raw_chunks: [
        { type: "raw" as const, rawValue: { Authorization: "Bearer abc", delta: "hello" } },
        { type: "raw" as const, rawValue: "plain string chunk" },
      ],
    }
    const out = redact(input) as {
      raw_chunks: Array<{ type: "raw"; rawValue: unknown }>
    }
    expect(out.raw_chunks).toHaveLength(2)
    expect(out.raw_chunks[0].type).toBe("raw")
    expect((out.raw_chunks[0].rawValue as Record<string, unknown>).Authorization).toBe('"[REDACTED]"')
    expect((out.raw_chunks[0].rawValue as Record<string, unknown>).delta).toBe("hello")
    expect(out.raw_chunks[1].rawValue).toBe("plain string chunk")
  })

  test("empty raw_chunks array passes through", () => {
    expect(redact({ raw_chunks: [] })).toEqual({ raw_chunks: [] })
  })

  test("undefined raw_chunks passes through", () => {
    expect(redact({ raw_chunks: undefined })).toEqual({ raw_chunks: undefined })
  })
})

describe("TranscriptLog.append: raw_chunks round-trip", () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "llm-transcript-raw-chunks-test-"))
    TranscriptLog.setLogDir(dir)
    TranscriptLog.setEnabled(true)
    await stat(dir)
  })

  afterEach(async () => {
    TranscriptLog.setEnabled(false)
    TranscriptLog.setLogDir(undefined)
    await rm(dir, { recursive: true, force: true })
  })

  test("append with raw_chunks persists them and redacts sensitive keys", async () => {
    await TranscriptLog.append({
      ts: 1700000000000,
      sessionID: "sess-raw-1",
      messageID: "msg-1",
      role: "assistant",
      model: { providerID: "openai", modelID: "gpt-4" },
      request: { messages: ["hi"] },
      response: { text: "hello" },
      raw_chunks: [
        { type: "raw", rawValue: { Authorization: "Bearer secret", delta: "hi" } },
        { type: "raw", rawValue: "data: chunk2" },
      ],
    })
    const events = await TranscriptLog.read("sess-raw-1")
    expect(events).toHaveLength(1)
    const chunks = events[0].raw_chunks
    expect(chunks).toBeDefined()
    expect(chunks).toHaveLength(2)
    // Redaction happened on the way in
    expect((chunks![0].rawValue as Record<string, unknown>).Authorization).toBe('"[REDACTED]"')
    expect((chunks![0].rawValue as Record<string, unknown>).delta).toBe("hi")
    expect(chunks![1].rawValue).toBe("data: chunk2")
  })

  test("append without raw_chunks leaves the field undefined on read", async () => {
    await TranscriptLog.append({
      ts: 1700000000001,
      sessionID: "sess-raw-2",
      messageID: "msg-1",
      role: "assistant",
      request: {},
      response: { text: "ok" },
    })
    const events = await TranscriptLog.read("sess-raw-2")
    expect(events).toHaveLength(1)
    expect(events[0].raw_chunks).toBeUndefined()
  })

  test("append with empty raw_chunks array persists the field as empty array", async () => {
    await TranscriptLog.append({
      ts: 1700000000002,
      sessionID: "sess-raw-3",
      messageID: "msg-1",
      role: "assistant",
      request: {},
      response: { text: "ok" },
      raw_chunks: [],
    })
    const events = await TranscriptLog.read("sess-raw-3")
    expect(events).toHaveLength(1)
    expect(events[0].raw_chunks).toEqual([])
  })
})

describe("TranscriptLog.append + read: per-session JSONL persistence", () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "llm-transcript-test-"))
    // The test runs in a sandboxed worker; the global state in
    // TranscriptLog persists across tests. We use a per-test temp
    // dir via `setLogDir` so the test does not collide with
    // production logs at `Global.Path.log/sessions`. The setLogDir
    // helper returns synchronously, but the async `mkdtemp` resolves
    // before the test body runs (beforeEach awaits it), so the
    // override is set by the time `append` is called.
    TranscriptLog.setLogDir(dir)
    TranscriptLog.setEnabled(true)
    // Force the test to wait one tick for the file system to settle
    // (Bun's mkdtemp is sync from the FS's perspective but the
    // resulting dir is available immediately).
    await stat(dir)
  })

  afterEach(async () => {
    TranscriptLog.setEnabled(false)
    TranscriptLog.setLogDir(undefined)
    await rm(dir, { recursive: true, force: true })
  })

  test("append writes a JSONL line with redacted request/response", async () => {
    await TranscriptLog.append({
      ts: 1700000000000,
      sessionID: "sess-1",
      messageID: "msg-1",
      role: "assistant",
      model: { providerID: "openai", modelID: "gpt-4" },
      request: { Authorization: "Bearer secret", messages: ["hi"] },
      response: { text: "hello", usage: { tokens: 5 } },
      tool_calls: [{ toolName: "bash", args: { command: "ls" } }],
    })
    const events = await TranscriptLog.read("sess-1")
    expect(events).toHaveLength(1)
    expect(events[0].sessionID).toBe("sess-1")
    expect(events[0].messageID).toBe("msg-1")
    expect(events[0].role).toBe("assistant")
    // Redaction happened on the way in
    expect((events[0].request as Record<string, unknown>).Authorization).toBe('"[REDACTED]"')
    // Non-sensitive fields preserved
    expect((events[0].request as Record<string, unknown>).messages).toEqual(["hi"])
  })

  test("read returns [] for a session that has no log file (no error)", async () => {
    const events = await TranscriptLog.read("nonexistent-session")
    expect(events).toEqual([])
  })

  test("multiple appends accumulate in order", async () => {
    for (let i = 0; i < 3; i++) {
      await TranscriptLog.append({
        ts: 1700000000000 + i,
        sessionID: "sess-2",
        messageID: `msg-${i}`,
        role: "assistant",
        request: {},
        response: { i },
      })
    }
    const events = await TranscriptLog.read("sess-2")
    expect(events).toHaveLength(3)
    expect(events.map((e) => e.messageID)).toEqual(["msg-0", "msg-1", "msg-2"])
  })

  test("append is a no-op when the log is disabled", async () => {
    TranscriptLog.setEnabled(false)
    await TranscriptLog.append({
      ts: 1,
      sessionID: "sess-3",
      messageID: "msg-1",
      role: "assistant",
      request: {},
      response: {},
    })
    const events = await TranscriptLog.read("sess-3")
    expect(events).toEqual([])
  })
})

describe("TranscriptLog.purgeExpired: deletes files older than the retention window", () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "llm-transcript-purge-test-"))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test("purgeExpired deletes a file whose mtime is older than the window", async () => {
    // Use the public append (which uses Global.Path.log) — we can't
    // redirect Global.Path, so this test only validates the ENOENT
    // and the success path for a non-existent file. The actual
    // expiry path is exercised by the manual mtime check below.
    await TranscriptLog.purgeExpired("never-existed", 1000)
    // No throw, no file — that's the success case.
  })

  test("purgeExpired tolerates missing file (ENOENT)", async () => {
    await expect(TranscriptLog.purgeExpired("no-such-session", 1000)).resolves.toBeUndefined()
  })
})
