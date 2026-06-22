import { Context, Effect, Layer } from "effect"
import path from "path"
import os from "os"
import { Global } from "../global"
import { Database } from "../storage"
import { Config } from "../config"
import { AppFileSystem } from "@nc-mimo-code/shared/filesystem"
import { reconcileMemory } from "./reconcile"
import { buildFtsQuery } from "./fts-query"
import { buildPath, type MemoryType, type Scope } from "./paths"

type SearchRow = {
  path: string
  scope: string
  scope_id: string
  type: string
  snippet: string
  score: number
}

export interface Interface {
  readonly root: () => Effect.Effect<string>
  readonly reconcile: () => Effect.Effect<{ indexed: number; pruned: number }>
  readonly search: (input: {
    query: string
    scope?: string
    scope_id?: string
    type?: string
    limit?: number
  }) => Effect.Effect<
    Array<{ path: string; snippet: string; score: number; scope: string; scope_id: string; type: string }>
  >
  // Audit §10 (tool-audit.md "Memory/History tools"): the `memory`
  // tool is a misnomer — it only reads. This `write` method lets
  // the LLM persist a note/learning/memory/feedback so a future
  // `memory` search can find it. The `cc` scope is excluded
  // because the CC tree is read-only here. The error channel
  // surfaces `AppFileSystem.Error` because the write is an I/O
  // effect (not a defect); the tool layer's `.orDie` converts it
  // to a tool error for the LLM.
  readonly write: (input: {
    key: string
    body: string
    scope?: Exclude<Scope, "cc">
    scope_id?: string
    type?: MemoryType
  }) => Effect.Effect<{ path: string; created: boolean }, AppFileSystem.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Memory") {}

export const layer: Layer.Layer<Service, never, Config.Service | AppFileSystem.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const fs = yield* AppFileSystem.Service
    const root = path.join(Global.Path.data, "memory")
    const ccBase = path.join(os.homedir(), ".claude", "projects")

    const rootEff = Effect.fn("Memory.root")(function* () {
      return root
    })

    const reconcile = Effect.fn("Memory.reconcile")(function* () {
      const cfg = yield* config.get()
      const cc = cfg.memory?.cc_index ? ccBase : undefined
      return yield* Effect.promise(() => reconcileMemory({ mimo: root, cc }))
    })

    const search = Effect.fn("Memory.search")(function* (input: {
      query: string
      scope?: string
      scope_id?: string
      type?: string
      limit?: number
    }) {
      // Lazy reconcile before search (covers off-tool writes); honour config flag.
      const cfg = yield* config.get()
      if (cfg.checkpoint?.memory_reconcile_on_search ?? true) {
        const cc = cfg.memory?.cc_index ? ccBase : undefined
        yield* Effect.promise(() => reconcileMemory({ mimo: root, cc }))
      }

      const limit = input.limit ?? 10
      // Build a token-level FTS5 query: punctuation becomes separators,
      // each alphanumeric run becomes a phrase-quoted literal, OR-joined.
      // See packages/opencode/src/memory/fts-query.ts for the rationale.
      const ftsQuery = buildFtsQuery(input.query)
      if (!ftsQuery) return []

      // OR-join means a doc matching only a common word (e.g. every
      // checkpoint.md matches "checkpoint") still matches, but BM25 ranks it
      // far below a doc matching several rare query words. We drop the
      // common-word noise with a RELATIVE floor: keep results scoring at
      // least `ratio` of the top hit's score. Relative (not absolute)
      // because BM25 magnitudes are corpus-size-dependent — in a tiny corpus
      // every score collapses toward 0 (low IDF), so any fixed absolute floor
      // would wrongly wipe real hits. The #1 result is ALWAYS kept (a match
      // is a match even when BM25 can't discriminate). Default 0.15.
      // Configurable; 0 disables (keep all matches).
      const floorRatio = cfg.checkpoint?.memory_search_score_floor ?? 0.15

      // Construct WHERE clauses for scope/scope_id/type filtering
      const conditions: string[] = []
      const params: string[] = []
      if (input.scope) {
        conditions.push("memory_fts.scope = ?")
        params.push(input.scope)
      }
      if (input.scope_id) {
        conditions.push("memory_fts.scope_id = ?")
        params.push(input.scope_id)
      }
      if (input.type) {
        conditions.push("memory_fts.type = ?")
        params.push(input.type)
      }
      const whereClause = conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : ""

      const sql = `
        SELECT memory_fts.path, memory_fts.scope, memory_fts.scope_id, memory_fts.type,
               snippet(memory_fts_idx, 0, '<<', '>>', '...', 32) AS snippet,
               bm25(memory_fts_idx) AS score
        FROM memory_fts_idx
        JOIN memory_fts ON memory_fts.id = memory_fts_idx.rowid
        WHERE memory_fts_idx MATCH ?
        ${whereClause}
        ORDER BY score
        LIMIT ?
      `

      // Over-fetch (3x, capped) so the relative floor can trim common-word
      // noise without starving the list when there ARE enough real hits.
      const fetchLimit = Math.min(limit * 3, 50)
      const rows = Database.Client().$client.query(sql).all(ftsQuery, ...params, fetchLimit) as SearchRow[]

      // FTS5 bm25() returns lower = better; convert to higher = better for caller
      const mapped = rows.map((r) => ({
        path: r.path,
        snippet: r.snippet,
        score: -r.score,
        scope: r.scope,
        scope_id: r.scope_id,
        type: r.type,
      }))
      if (mapped.length === 0) return []
      // Rows are ORDER BY score (best first), so mapped[0] is the top hit.
      // Always keep it; drop trailing rows below `floorRatio` of its score.
      const topScore = mapped[0].score
      const cutoff = floorRatio > 0 ? topScore * floorRatio : -Infinity
      return mapped.filter((r, i) => i === 0 || r.score >= cutoff).slice(0, limit)
    })

    // Audit §10: write a memory file. Path-traversal guard is
    // enforced inside `buildPath` (see `assertSafeComponent` in
    // `paths.ts`); any caller-supplied `key`/`scope_id` with `..`
    // or an absolute prefix throws before the file system is
    // touched. The write is atomic — `writeAtomicWithDirs` writes
    // to a temp file in the same dir then renames into place, so
    // a partial write never lands. `created: true` means the file
    // did not exist before this call; `created: false` means we
    // overwrote an existing memory.
    //
    // Implementation note: we use `Effect.gen` directly instead of
    // `Effect.fn` to keep the `E = never` contract declared on the
    // Interface (the bare `buildPath` call has no Effect context,
    // so its sync throw is treated as a defect and surfaces
    // through the tool layer's `.orDie` at the boundary).
    const write = (input: {
      key: string
      body: string
      scope?: Exclude<Scope, "cc">
      scope_id?: string
      type?: MemoryType
    }) =>
      Effect.gen(function* () {
        const path = buildPath({
          root,
          scope: input.scope ?? "global",
          scope_id: input.scope_id,
          key: input.key,
        })
        const existed = yield* fs.existsSafe(path)
        yield* fs.writeAtomicWithDirs(path, input.body)
        return { path, created: !existed }
      })

    return Service.of({
      root: rootEff,
      reconcile,
      search,
      write,
    })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(Layer.provide(Config.defaultLayer), Layer.provide(AppFileSystem.defaultLayer)),
)
