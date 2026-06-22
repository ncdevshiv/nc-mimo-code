import { Effect } from "effect"
import z from "zod"
import { Memory } from "@/memory"
import DESCRIPTION from "./memory.txt"
import * as Tool from "./tool"

const parameters = z.object({
  // Audit §10: `memory` is no longer a misnomer — `write` was
  // added so the LLM can persist a note/learning/memory and find
  // it later via `search`. The default `search` is applied at the
  // call site (not via `.default()`) to keep the Zod
  // input/output types aligned for the Tool.Def type signature.
  operation: z
    .enum(["search", "write"])
    .optional()
    .describe("Memory operation: 'search' (default) reads; 'write' persists a new memory file."),
  query: z.string().optional().describe("Search query (BM25 over markdown bodies). Required for operation=search."),
  scope: z.enum(["global", "projects", "sessions", "cc"]).optional().describe("Filter by memory scope"),
  scope_id: z
    .string()
    .optional()
    .describe("Filter by scope id (e.g., session id, task id, project id hash)"),
  type: z
    .string()
    .optional()
    .describe("Filter by memory type (pinned, snapshot, learning, progress, free, ...)"),
  limit: z.number().optional().describe("Max results (default 10)"),
  // write params — required when operation=write
  key: z
    .string()
    .optional()
    .describe(
      "write-only. Memory key (e.g. 'project/foo', 'memory', 'checkpoint'). Rejected if it contains '..' or starts with '/' (path-traversal guard).",
    ),
  body: z
    .string()
    .optional()
    .describe("write-only. The markdown body to persist. Required when operation=write."),
  // The default `scope` for `write` is `global` (the simplest
  // cross-session slot). `cc` is excluded — the CC tree is
  // read-only here.
  write_scope: z
    .enum(["global", "projects", "sessions"])
    .optional()
    .describe("write-only. Where to write. Default 'global'. 'cc' is not writable."),
  write_scope_id: z
    .string()
    .optional()
    .describe("write-only. Scope id (e.g. project id hash, session id). Required for write_scope='projects' or 'sessions'."),
  write_type: z
    .enum(["free", "memory", "checkpoint", "progress", "notes", "feedback", "project", "reference", "user"])
    .optional()
    .describe("write-only. Memory type tag. Default 'free'."),
})

export const MemoryTool = Tool.define(
  "memory",
  Effect.gen(function* () {
    const memory = yield* Memory.Service
    return {
      description: DESCRIPTION,
      parameters,
      formatValidationError: Tool.formatZodError({
        operation: { type: '"search" | "write"', required: true, values: ["search", "write"] },
        query: { type: "string (BM25 query)", required: false, note: "required when operation=search" },
        scope: { type: '"global" | "projects" | "sessions" | "cc"', required: false, values: ["global", "projects", "sessions", "cc"] },
        scope_id: { type: "string", required: false },
        type: { type: "string (memory type filter)", required: false },
        limit: { type: "number (default 10)", required: false },
        key: { type: "string (memory key)", required: false, note: "required when operation=write" },
        body: { type: "string (markdown body)", required: false, note: "required when operation=write" },
        write_scope: { type: '"global" | "projects" | "sessions"', required: false, values: ["global", "projects", "sessions"] },
        write_scope_id: { type: "string", required: false },
        write_type: { type: "free | memory | checkpoint | progress | notes | feedback | project | reference | user", required: false },
      }),
      execute: (args: z.infer<typeof parameters>) =>
        Effect.gen(function* () {
          const operation = args.operation ?? "search"
          if (operation === "write") {
            if (!args.key) {
              return {
                title: "Memory write: missing key",
                output: "operation=write requires a `key` argument.",
                metadata: { count: 0, created: false as const, path: "" },
              }
            }
            if (!args.body) {
              return {
                title: "Memory write: missing body",
                output: "operation=write requires a `body` argument.",
                metadata: { count: 0, created: false as const, path: "" },
              }
            }
            const result = yield* memory
              .write({
                key: args.key,
                body: args.body,
                scope: args.write_scope,
                scope_id: args.write_scope_id,
                type: args.write_type,
              })
              .pipe(Effect.orDie)
            return {
              title: `Memory write: ${args.key}${result.created ? " (created)" : " (overwritten)"}`,
              output: `Wrote ${result.path} (${result.created ? "new file" : "overwrote existing"}).\n\nFuture \`memory\` searches with operation=search will pick this up.`,
              metadata: { count: 1, created: result.created, path: result.path },
            }
          }

          // operation=search (default)
          if (!args.query) {
            return {
              title: "Memory search: missing query",
              output: "operation=search requires a `query` argument.",
              metadata: { count: 0, created: false as const, path: "" },
            }
          }
          const results = yield* memory.search({
            query: args.query,
            scope: args.scope,
            scope_id: args.scope_id,
            type: args.type,
            limit: args.limit,
          })
          if (results.length === 0) {
            return {
              title: `Memory search: 0 results`,
              output: [
                `No matches for "${args.query}".`,
                ``,
                `0 results does NOT mean it was never recorded. Escalate before giving up:`,
                `1. Retry with FEWER / more distinctive terms — queries are OR-joined and`,
                `   ranked, so 1-2 rare words (an exact ID, function name, flag) beat a long`,
                `   descriptive phrase. Drop generic words ("config", "params", "database").`,
                `2. For a LITERAL string the tokenizer splits (URLs like postgres://…, ports`,
                `   like 5433, paths) — Grep the memory dir directly; FTS can't see it.`,
                `3. For VERBATIM recall of something a summary may have glossed over (exact`,
                `   command, the user's precise wording) — use the history tool (raw`,
                `   conversation), which keeps original messages.`,
                `Widen scope progressively: session → project → global → history.`,
              ].join("\n"),
              metadata: { count: 0, created: false as const, path: "" },
            }
          }
          const lines = [
            `Found ${results.length} match${results.length === 1 ? "" : "es"} (BM25-ranked, best first).`,
            `A hit here is authoritative — use it even if a parallel/sibling query returned nothing.`,
            `If you need the FULL body (snippets are truncated), Read the path.`,
            `If you need an EXACT literal (a connection string, port, token, full command line, path) and the snippet/body only paraphrases or partially shows it, the curated memory may have dropped the precise form — query the history tool for the original message, which holds it verbatim.`,
            ``,
          ]
          for (const r of results) {
            lines.push(`### ${r.path}`)
            lines.push(
              `Scope: ${r.scope}${r.scope_id ? `/${r.scope_id}` : ""}, Type: ${r.type}, Score: ${r.score.toFixed(3)}`,
            )
            lines.push(r.snippet)
            lines.push("")
          }
          return {
            title: `Memory search: ${results.length} result${results.length === 1 ? "" : "s"}`,
            output: lines.join("\n"),
            metadata: { count: results.length, created: false as const, path: "" },
          }
        }),
    }
  }),
)
