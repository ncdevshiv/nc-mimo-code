import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import SHELL_DESCRIPTION from "./task.shell.txt"
import { tokenize } from "./shell-tokenize"
import { extractFlags, suggestVerb } from "./tool-grammar"
import z from "zod"
import { Effect } from "effect"
import { TaskRegistry } from "@/task/registry"
import type { SessionID } from "../session/schema"

const KNOWN_VERBS = [
  "create",
  "list",
  "get",
  "start",
  "block",
  "unblock",
  "done",
  "abandon",
  "rename",
  "revise",
]

const id = "task"

const statusSchema = z.enum(["open", "in_progress", "blocked", "done", "abandoned"])

const createOperation = z.strictObject({
  action: z.literal("create"),
  summary: z.string().min(1).describe("Task summary for a single task."),
  parent_id: z.string().min(1).optional().describe("Parent task id for sub-tasks."),
  session_id: z.string().min(1).optional().describe("Session id to act on. Defaults to current session."),
})

const listOperation = z.strictObject({
  action: z.literal("list"),
  status: statusSchema.optional().describe("Filter by status."),
  include_terminal: z.boolean().optional().describe("Include done/abandoned tasks. Default false."),
  include_archived: z.boolean().optional().describe("Include archived tasks. Default false."),
  session_id: z.string().min(1).optional().describe("Session id to act on. Defaults to current session."),
})

const getOperation = z.strictObject({
  action: z.literal("get"),
  id: z.string().min(1).describe("Task id, e.g. T1 or T1.1."),
  session_id: z.string().min(1).optional().describe("Session id to act on. Defaults to current session."),
})

const startOperation = z.strictObject({
  action: z.literal("start"),
  id: z.string().min(1).describe("Task id, e.g. T1 or T1.1."),
  event_summary: z.string().min(1).optional().describe("Short note on starting."),
  session_id: z.string().min(1).optional().describe("Session id to act on. Defaults to current session."),
})

const blockOperation = z.strictObject({
  action: z.literal("block"),
  id: z.string().min(1).describe("Task id, e.g. T1 or T1.1."),
  event_summary: z.string().min(1).optional().describe("Short reason for blocking."),
  session_id: z.string().min(1).optional().describe("Session id to act on. Defaults to current session."),
})

const unblockOperation = z.strictObject({
  action: z.literal("unblock"),
  id: z.string().min(1).describe("Task id, e.g. T1 or T1.1."),
  event_summary: z.string().min(1).optional().describe("Short reason for unblocking."),
  session_id: z.string().min(1).optional().describe("Session id to act on. Defaults to current session."),
})

const doneOperation = z.strictObject({
  action: z.literal("done"),
  id: z.string().min(1).describe("Task id, e.g. T1 or T1.1."),
  event_summary: z.string().min(1).optional().describe("Short summary of what was completed."),
  session_id: z.string().min(1).optional().describe("Session id to act on. Defaults to current session."),
})

const abandonOperation = z.strictObject({
  action: z.literal("abandon"),
  id: z.string().min(1).describe("Task id, e.g. T1 or T1.1."),
  event_summary: z.string().min(1).optional().describe("Short reason for abandoning."),
  session_id: z.string().min(1).optional().describe("Session id to act on. Defaults to current session."),
})

const renameOperation = z.strictObject({
  action: z.literal("rename"),
  id: z.string().min(1).describe("Task id, e.g. T1 or T1.1."),
  summary: z.string().min(1).describe("New task summary."),
  session_id: z.string().min(1).optional().describe("Session id to act on. Defaults to current session."),
})

// Audit §10: `revise` is a softer version of `rename` for
// in-progress tasks. Both `summary` and `event_summary` are
// optional — the LLM can update just the summary, just leave a
// note, or both. The underlying DB write is the same as
// `rename`; `event_summary` is logged as a task event.
const reviseOperation = z.strictObject({
  action: z.literal("revise"),
  id: z.string().min(1).describe("Task id, e.g. T1 or T1.1."),
  summary: z.string().min(1).optional().describe("New task summary (omit to keep the current one)."),
  event_summary: z.string().min(1).optional().describe("Short note describing the revision."),
  session_id: z.string().min(1).optional().describe("Session id to act on. Defaults to current session."),
})

const parameters = z.strictObject({
  // .meta({ type: "object" }) is REQUIRED — without it, the emitted JSON
  // schema's `operation` node has only `anyOf`, no `type`. Some models
  // (notably mimo-v2.5-pro) then stringify the entire envelope, producing
  // {"operation":"{\"action\":\"create\",...}"} which fails zod validation.
  // See research-tool-call-schema/REPORT.md §2.5 "success-nested" warning.
  operation: z
    .discriminatedUnion("action", [
      createOperation,
      listOperation,
      getOperation,
      startOperation,
      blockOperation,
      unblockOperation,
      doneOperation,
      abandonOperation,
      renameOperation,
      reviseOperation,
    ])
    .meta({ type: "object" }),
})

type TaskInput = z.infer<typeof parameters>
type TaskOperation = TaskInput
type TaskStatus = z.infer<typeof statusSchema>

type Metadata = {
  id?: string
  status?: string
  ids?: string[]
  count?: number
}

export function parseTaskScript(script: string): Effect.Effect<TaskOperation[], unknown> {
  return Effect.gen(function* () {
    const argvList = yield* tokenize(script)
    const out: TaskOperation[] = []
    for (const argv of argvList) {
      const [head, verb, ...rest] = argv.tokens
      if (head !== "task") {
        return yield* Effect.fail({
          kind: "unknown-verb",
          line: argv.line,
          detail: `task: every command must start with 'task' (got '${head ?? ""}')`,
        })
      }
      const parsed = yield* mapVerb(verb, rest, argv.line)
      out.push(parsed)
    }
    return out
  })
}

// Recover a shell-mode task call shaped like the JSON args (no `script`):
// a stringified/nested `operation`, or the common bare `{summary}` create.
// Conservative — only the unambiguous create-from-summary is synthesized;
// anything else passes through (nested) or returns undefined (→ teach JSON).
export function recoverTaskArgs(rawArgs: unknown): TaskOperation | undefined {
  if (rawArgs == null || typeof rawArgs !== "object") return undefined
  let obj = rawArgs as Record<string, unknown>
  if (typeof obj.operation === "string") {
    try {
      const inner = JSON.parse(obj.operation)
      if (inner && typeof inner === "object" && !Array.isArray(inner)) obj = { operation: inner }
    } catch {}
  }
  if (obj.operation && typeof obj.operation === "object" && !Array.isArray(obj.operation))
    return { operation: obj.operation } as TaskOperation
  if (typeof obj.summary === "string") {
    const op: Record<string, unknown> = { action: "create", summary: obj.summary }
    if (typeof obj.parent_id === "string") op.parent_id = obj.parent_id
    if (typeof obj.session_id === "string") op.session_id = obj.session_id
    return { operation: op } as TaskOperation
  }
  return undefined
}

// Extract a fixed set of `--name value` / `--name=value` string flags and
// boolean presence flags from a verb's args, leaving positionals in `rest`.
// Backed by the shared extractFlags in tool-grammar.ts so the dangling-flag
// behavior stays in lockstep with the actor tool (a value flag with no value
// or `--name=` with empty RHS sets `error` rather than silently dropping).
function extractTaskFlags(
  args: string[],
  valueFlags: string[],
  boolFlags: string[],
): { flags: Record<string, string>; bools: Record<string, boolean>; rest: string[]; error?: string } {
  return extractFlags(args, valueFlags, boolFlags)
}

function flagError(verb: string, detail: string, line: number) {
  return Effect.fail({ kind: "flag", line, detail: `task: ${verb}: ${detail}` })
}

function mapVerb(verb: string | undefined, args: string[], line: number): Effect.Effect<TaskOperation, unknown> {
  switch (verb) {
    case "create": {
      const { flags, rest, error } = extractTaskFlags(args, ["parent", "session"], [])
      if (error) return flagError("create", error, line)
      if (rest.length !== 1) return arityError("create", '<summary> [--parent <TID>] [--session <id>]', rest, line)
      return Effect.succeed({
        operation: {
          action: "create" as const,
          summary: rest[0],
          ...(flags.parent ? { parent_id: flags.parent } : {}),
          ...(flags.session ? { session_id: flags.session } : {}),
        },
      })
    }
    case "list": {
      const { flags, bools, rest, error } = extractTaskFlags(args, ["session"], ["include-terminal", "include-archived"])
      if (error) return flagError("list", error, line)
      if (rest.length > 1) return arityError("list", "[<status>] [--include-terminal] [--include-archived] [--session <id>]", rest, line)
      return Effect.succeed({
        operation: {
          action: "list" as const,
          ...(rest.length === 1 ? { status: rest[0] as TaskStatus } : {}),
          ...(bools["include-terminal"] ? { include_terminal: true } : {}),
          ...(bools["include-archived"] ? { include_archived: true } : {}),
          ...(flags.session ? { session_id: flags.session } : {}),
        },
      })
    }
    case "get": {
      const { flags, rest, error } = extractTaskFlags(args, ["session"], [])
      if (error) return flagError("get", error, line)
      if (rest.length !== 1) return arityError("get", "<id> [--session <id>]", rest, line)
      return Effect.succeed({ operation: { action: "get" as const, id: rest[0], ...(flags.session ? { session_id: flags.session } : {}) } })
    }
    case "start": {
      const { flags, rest, error } = extractTaskFlags(args, ["reason", "session"], [])
      if (error) return flagError("start", error, line)
      if (rest.length !== 1) return arityError("start", "<id> [--reason <note>] [--session <id>]", rest, line)
      return Effect.succeed({
        operation: {
          action: "start" as const,
          id: rest[0],
          ...(flags.reason ? { event_summary: flags.reason } : {}),
          ...(flags.session ? { session_id: flags.session } : {}),
        },
      })
    }
    case "block": {
      const { flags, rest, error } = extractTaskFlags(args, ["session"], [])
      if (error) return flagError("block", error, line)
      if (rest.length !== 2) return arityError("block", "<id> <reason> [--session <id>]", rest, line)
      return Effect.succeed({ operation: { action: "block" as const, id: rest[0], event_summary: rest[1], ...(flags.session ? { session_id: flags.session } : {}) } })
    }
    case "unblock": {
      const { flags, rest, error } = extractTaskFlags(args, ["session"], [])
      if (error) return flagError("unblock", error, line)
      if (rest.length !== 2) return arityError("unblock", "<id> <reason> [--session <id>]", rest, line)
      return Effect.succeed({ operation: { action: "unblock" as const, id: rest[0], event_summary: rest[1], ...(flags.session ? { session_id: flags.session } : {}) } })
    }
    case "done": {
      const { flags, rest, error } = extractTaskFlags(args, ["session"], [])
      if (error) return flagError("done", error, line)
      if (rest.length !== 2) return arityError("done", "<id> <summary> [--session <id>]", rest, line)
      return Effect.succeed({ operation: { action: "done" as const, id: rest[0], event_summary: rest[1], ...(flags.session ? { session_id: flags.session } : {}) } })
    }
    case "abandon": {
      const { flags, rest, error } = extractTaskFlags(args, ["session"], [])
      if (error) return flagError("abandon", error, line)
      if (rest.length !== 2) return arityError("abandon", "<id> <reason> [--session <id>]", rest, line)
      return Effect.succeed({ operation: { action: "abandon" as const, id: rest[0], event_summary: rest[1], ...(flags.session ? { session_id: flags.session } : {}) } })
    }
    case "rename": {
      const { flags, rest, error } = extractTaskFlags(args, ["session"], [])
      if (error) return flagError("rename", error, line)
      if (rest.length !== 2) return arityError("rename", "<id> <summary> [--session <id>]", rest, line)
      return Effect.succeed({ operation: { action: "rename" as const, id: rest[0], summary: rest[1], ...(flags.session ? { session_id: flags.session } : {}) } })
    }
    case "revise": {
      // `task revise <id> [--summary <text>] [--note <text>] [--session <id>]`
      // At least one of --summary or --note is required. The
      // string-positional form is rejected to keep the verb
      // unambiguous: rename uses positional summary, revise uses
      // flags so the model can't accidentally clobber a summary
      // with a note or vice versa.
      const { flags, rest, error } = extractTaskFlags(args, ["session", "summary", "note"], [])
      if (error) return flagError("revise", error, line)
      if (rest.length !== 1) return arityError("revise", "<id> [--summary <text>] [--note <text>] [--session <id>]", rest, line)
      if (!flags.summary && !flags.note) {
        return flagError("revise", "at least one of --summary or --note is required", line)
      }
      return Effect.succeed({
        operation: {
          action: "revise" as const,
          id: rest[0],
          ...(flags.summary ? { summary: flags.summary } : {}),
          ...(flags.note ? { event_summary: flags.note } : {}),
          ...(flags.session ? { session_id: flags.session } : {}),
        },
      })
    }
    default: {
      const suggestion = suggestVerb(verb ?? "", KNOWN_VERBS)
      const detail =
        `task: unknown verb "${verb ?? ""}"\n` +
        `  available verbs: ${KNOWN_VERBS.join(", ")}` +
        (suggestion ? `\n  did you mean: ${suggestion}?` : "")
      return Effect.fail({ kind: "unknown-verb", line, detail })
    }
  }
}

function arityError(verb: string, expected: string, args: string[], line: number) {
  return Effect.fail({
    kind: "arity",
    line,
    detail: `task: ${verb}: arity mismatch\n  got:      task ${verb} ${args.join(" ")}\n  expected: task ${verb} ${expected}`,
  })
}

export const TaskTool = Tool.define<typeof parameters, Metadata, TaskRegistry.Service>(
  id,
  Effect.gen(function* () {
    const reg = yield* TaskRegistry.Service

    const run = Effect.fn("TaskTool.execute")(function* (input: TaskInput, ctx: Tool.Context<Metadata>) {
      const op = input.operation
      const sessionID = (op.session_id || ctx.sessionID) as SessionID

      if (op.action === "create") {
        const t = yield* reg.create({
          session_id: sessionID,
          summary: op.summary,
          parent_id: op.parent_id || undefined,
          owner: ctx.actorID ?? ctx.agent,
        })
        return {
          title: `Task created: ${t.id}`,
          output: `Created ${t.id} (${t.status}): ${t.summary}`,
          metadata: { id: t.id, status: t.status } as Metadata,
        }
      }

      if (op.action === "list") {
        const tasks = yield* reg.list({
          session_id: sessionID,
          status: op.status,
          include_terminal: op.include_terminal,
          include_archived: op.include_archived,
        })
        const lines =
          tasks.length === 0
            ? ["No tasks."]
            : tasks.map((t) => {
                return `${t.id} ${t.status} — ${t.summary}`
              })
        return {
          title: `Tasks: ${tasks.length}`,
          output: lines.join("\n"),
          metadata: { count: tasks.length, ids: tasks.map((t) => t.id) } as Metadata,
        }
      }

      if (op.action === "get") {
        const t = yield* reg.get({ session_id: sessionID, id: op.id })
        if (!t)
          return {
            title: `Task ${op.id}: not found`,
            output: `No task ${op.id}`,
            metadata: {} as Metadata,
          }
        return {
          title: `Task ${op.id}: ${t.status}`,
          output: JSON.stringify(t, null, 2),
          metadata: { id: t.id, status: t.status } as Metadata,
        }
      }

      if (op.action === "start") {
        const result = yield* reg.start({ session_id: sessionID, id: op.id, owner: ctx.actorID ?? ctx.agent, event_summary: op.event_summary })
        return {
          title: `Task ${op.id}: ${result.status}`,
          output: `start → ${result.status}`,
          metadata: { id: result.id, status: result.status } as Metadata,
        }
      }

      if (op.action === "block") {
        const result = yield* reg.block({ session_id: sessionID, id: op.id, event_summary: op.event_summary })
        return {
          title: `Task ${op.id}: blocked`,
          output: `block → ${result.status}`,
          metadata: { id: result.id, status: result.status } as Metadata,
        }
      }

      if (op.action === "unblock") {
        const result = yield* reg.unblock({ session_id: sessionID, id: op.id, event_summary: op.event_summary })
        return {
          title: `Task ${op.id}: ${result.status}`,
          output: `unblock → ${result.status}`,
          metadata: { id: result.id, status: result.status } as Metadata,
        }
      }

      if (op.action === "done") {
        // Audit §10: terminal-state transitions were unguarded —
        // a confused model could mark real work "done" or
        // "abandoned" without the user seeing the change. Ask the
        // user for permission before flipping the task to a
        // terminal state. The `patterns` field is the task id so
        // the user can read it back in the approval prompt.
        yield* ctx.ask({
          permission: "task",
          patterns: [op.id],
          always: [op.id],
          metadata: { action: "done", id: op.id, event_summary: op.event_summary },
        })
        const result = yield* reg.done({ session_id: sessionID, id: op.id, event_summary: op.event_summary })
        return {
          title: `Task ${op.id}: done`,
          output: `done → ${result.status}`,
          metadata: { id: result.id, status: result.status } as Metadata,
        }
      }

      if (op.action === "abandon") {
        yield* ctx.ask({
          permission: "task",
          patterns: [op.id],
          always: [op.id],
          metadata: { action: "abandon", id: op.id, event_summary: op.event_summary },
        })
        const result = yield* reg.abandon({ session_id: sessionID, id: op.id, event_summary: op.event_summary })
        return {
          title: `Task ${op.id}: abandoned`,
          output: `abandon → ${result.status}`,
          metadata: { id: result.id, status: result.status } as Metadata,
        }
      }

      if (op.action === "rename") {
        const result = yield* reg.rename({ session_id: sessionID, id: op.id, summary: op.summary })
        return {
          title: `Task ${op.id}: renamed`,
          output: `rename → "${result.summary}"`,
          metadata: { id: result.id, status: result.status } as Metadata,
        }
      }

      if (op.action === "revise") {
        // Audit §10: `revise` is a softer version of `rename` for
        // in-progress tasks. `summary` is optional — if omitted
        // we just record the `event_summary` (or no-op if both
        // are missing). To avoid the no-op case silently
        // returning a stale task, the schema requires at least
        // one of the two to be provided.
        if (!op.summary && !op.event_summary) {
          return yield* Effect.fail(new Error("revise requires at least one of `summary` or `event_summary`"))
        }
        // If only the event_summary is provided (no rename), we
        // still need to pass `summary` to `reg.rename`. Look it
        // up first to avoid clobbering.
        let result
        if (op.summary) {
          result = yield* reg.rename({ session_id: sessionID, id: op.id, summary: op.summary })
        } else {
          const current = yield* reg.get({ session_id: sessionID, id: op.id })
          if (!current) return yield* Effect.die(`Task ${op.id} not found in session ${sessionID}`)
          result = current
        }
        return {
          title: `Task ${op.id}: revised`,
          output: op.summary
            ? `revise → "${result.summary}"${op.event_summary ? ` (note: ${op.event_summary})` : ""}`
            : `revise (note: ${op.event_summary})`,
          metadata: { id: result.id, status: result.status } as Metadata,
        }
      }

      return yield* Effect.fail(new Error(`Unknown operation: ${(op as { action: string }).action}`))
    })

    return {
      description: DESCRIPTION,
      parameters,
      formatValidationError: Tool.formatDiscriminatedUnionError([
        "create",
        "list",
        "get",
        "start",
        "block",
        "unblock",
        "done",
        "abandon",
        "rename",
      ]),
      execute: (args: z.infer<typeof parameters>, ctx: Tool.Context<Metadata>) =>
        run(args, ctx).pipe(Effect.orDie),
      shell: {
        description: SHELL_DESCRIPTION,
        parse: parseTaskScript,
        recover: recoverTaskArgs,
      },
    } satisfies Tool.DefWithoutID<typeof parameters, Metadata>
  }),
)
