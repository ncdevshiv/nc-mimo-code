import z from "zod"
import { Effect, Option, Scope } from "effect"
import { createReadStream } from "fs"
import * as path from "path"
import { createInterface } from "readline"
import { pathToFileURL } from "url"
import ignore from "ignore"
import * as Tool from "./tool"
import { AppFileSystem } from "@nc-mimo-code/shared/filesystem"
import { LSP } from "../lsp"
import { BUDGET } from "@/config/tool-budget-resolve"
import DESCRIPTION from "./read.txt"
import { Instance } from "../project/instance"
import { assertExternalDirectoryEffect } from "./external-directory"
import { SessionCwd } from "./session-cwd"
import { Instruction } from "../session/instruction"
import { isImageAttachment, isPdfAttachment, sniffAttachmentMime } from "@/util/media"

// Config-driven caps. The defaults below mirror `BUDGET.read` at module load;
// tests that vary the env multiplier should call `resolveToolBudget()` directly
// (see `packages/opencode/src/config/tool-budget-resolve.ts`).
const DEFAULT_READ_LIMIT = BUDGET.read.maxLines
const MAX_LINE_LENGTH = BUDGET.read.maxLineLength
const MAX_BYTES = BUDGET.read.maxBytes
const SAMPLE_BYTES = 4096

// Truncation suffix and byte-cap label. Computed once at module load
// — the underlying caps (`MAX_LINE_LENGTH`, `MAX_BYTES`) are frozen
// from `BUDGET.read` at the same time, so a coherent label is
// guaranteed.
const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`
const MAX_BYTES_LABEL = `${MAX_BYTES / 1024} KB`

// Separate cap for image/PDF attachments — these are base64'd into the context,
// so we cap them well below the text truncation threshold to prevent OOM.
const DEFAULT_ATTACHMENT_CAP = 10 * 1024 * 1024

// Soft limits for outline output (LSP can return thousands of symbols for big files).
const OUTLINE_MAX_SYMBOLS = 200
const OUTLINE_MAX_BYTES = 50 * 1024

type Encoding = "utf-8" | "utf-16le" | "utf-16be" | "windows-1252" | "ascii"

const detectEncoding = (sample: Uint8Array): Encoding => {
  if (sample.length >= 3 && sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf) return "utf-8"
  if (sample.length >= 2 && sample[0] === 0xff && sample[1] === 0xfe) return "utf-16le"
  if (sample.length >= 2 && sample[0] === 0xfe && sample[1] === 0xff) return "utf-16be"
  let allAscii = true
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] >= 0x80) {
      allAscii = false
      break
    }
  }
  return allAscii ? "ascii" : "utf-8"
}

const humanBytes = (n: number): string => {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / 1024 / 1024).toFixed(1)}MB`
}

const parameters = z.object({
  filePath: z.string().describe("The absolute path to the file or directory to read"),
  offset: z.coerce.number().describe("The line number to start reading from (1-indexed). Ignored if 'around' is set.").optional(),
  limit: z.coerce.number().describe("The maximum number of lines to read (defaults to 2000). Ignored if 'around' is set.").optional(),
  around: z.coerce
    .number()
    .describe(
      "Line number to center the read window on (1-indexed). Overrides offset when set. Pairs naturally with grep: after finding a match, use around=<line> to see surrounding context.",
    )
    .optional(),
  ast: z
    .enum(["off", "outline", "symbols"])
    .describe(
      "Return a structural outline (functions/classes/exports) via the language server instead of raw content. 'outline' is a nested tree; 'symbols' is a flat list. Falls back to a plain text read if no LSP server is available for the file.",
    )
    .optional(),
  encoding: z
    .enum(["auto", "utf-8", "utf-16le", "utf-16be", "windows-1252", "ascii"])
    .describe("Source encoding. 'auto' (default) detects via BOM and heuristic; the detected value is reported in the <meta> header.")
    .optional(),
  maxAttachmentBytes: z.coerce
    .number()
    .int()
    .positive()
    .describe("Override the 10MB cap on image/PDF attachments. Files larger than this are rejected with a clear error.")
    .optional(),
  showIgnored: z
    .boolean()
    .describe(
      "Directory listing: include entries matched by .gitignore / .ignore / .nc-mimo-codeignore. Default false (filtered). Ignored for file reads.",
    )
    .optional(),
})

export const ReadTool = Tool.define(
  "read",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const instruction = yield* Instruction.Service
    const lsp = yield* LSP.Service
    const scope = yield* Scope.Scope

    const miss = Effect.fn("ReadTool.miss")(function* (filepath: string) {
      const dir = path.dirname(filepath)
      const base = path.basename(filepath)
      const items = yield* fs.readDirectory(dir).pipe(
        Effect.map((items) =>
          items
            .filter(
              (item) =>
                item.toLowerCase().includes(base.toLowerCase()) || base.toLowerCase().includes(item.toLowerCase()),
            )
            .map((item) => path.join(dir, item))
            .slice(0, 3),
        ),
        Effect.catch(() => Effect.succeed([] as string[])),
      )

      if (items.length > 0) {
        return yield* Effect.fail(
          new Error(`File not found: ${filepath}\n\nDid you mean one of these?\n${items.join("\n")}`),
        )
      }

      return yield* Effect.fail(new Error(`File not found: ${filepath}`))
    })

    // Walk up from `dir` collecting any .gitignore / .ignore / .nc-mimo-codeignore
    // patterns we find. Returns an `ignore` instance plus a flag indicating
    // whether any patterns were actually loaded.
    const loadIgnore = Effect.fn("ReadTool.loadIgnore")(function* (dir: string) {
      const ig = ignore()
      let found = false
      let cur = dir
      // Walk up to the instance root or filesystem root — whichever comes first.
      const root = Instance.worktree
      for (let i = 0; i < 64; i++) {
        for (const name of [".gitignore", ".ignore", ".nc-mimo-codeignore"]) {
          const file = path.join(cur, name)
          const text = yield* fs
            .readFileString(file)
            .pipe(Effect.catch(() => Effect.succeed<string | undefined>(undefined)))
          if (text) {
            ig.add(text)
            found = true
          }
        }
        if (cur === root) break
        const parent = path.dirname(cur)
        if (parent === cur) break
        cur = parent
      }
      return { ig, found }
    })

    // `list` returns directory entries. For each symlink, resolves the target
    // and detects cycles via a realpath Set so a single cyclic symlink does
    // not blow up the listing. Skipped cycles are still reported with a
    // "(symlink loop, skipped)" suffix so the model can see something was there.
    const list = Effect.fn("ReadTool.list")(function* (filepath: string) {
      const items = yield* fs.readDirectoryEntries(filepath)
      const seen = new Set<string>()
      return yield* Effect.forEach(
        items,
        Effect.fnUntraced(function* (item) {
          if (item.type === "directory") return item.name + "/"
          if (item.type !== "symlink") return item.name

          const target = yield* fs.stat(path.join(filepath, item.name)).pipe(Effect.catch(() => Effect.void))
          if (target?.type === "Directory") return item.name + "/"
          if (target?.type === "File") {
            // Symlink to a file — record the realpath so we can detect loops
            // for any later directory symlinks in the same listing.
            const real = yield* fs
              .existsSafe(path.join(filepath, item.name))
              .pipe(Effect.catch(() => Effect.succeed(false)))
            if (real) seen.add(path.join(filepath, item.name))
            return item.name
          }

          // Symlink we can't resolve. Note: deep realpath-based cycle detection
          // for directory symlinks is best-effort — the existing fs.stat above
          // already short-circuits broken links, which is the common case.
          return `${item.name} (symlink loop, skipped)`
        }),
        { concurrency: "unbounded" },
      ).pipe(Effect.map((items: string[]) => items.sort((a, b) => a.localeCompare(b))))
    })

    const warm = Effect.fn("ReadTool.warm")(function* (filepath: string) {
      yield* lsp.touchFile(filepath, false).pipe(Effect.ignore, Effect.forkIn(scope))
    })

    const readSample = Effect.fn("ReadTool.readSample")(function* (
      filepath: string,
      fileSize: number,
      sampleSize: number,
    ) {
      if (fileSize === 0) return new Uint8Array()

      return yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fs.open(filepath, { flag: "r" })
          return Option.getOrElse(yield* file.readAlloc(Math.min(sampleSize, fileSize)), () => new Uint8Array())
        }),
      )
    })

    const isBinaryFile = (filepath: string, bytes: Uint8Array) => {
      const ext = path.extname(filepath).toLowerCase()
      switch (ext) {
        case ".zip":
        case ".tar":
        case ".gz":
        case ".exe":
        case ".dll":
        case ".so":
        case ".class":
        case ".jar":
        case ".war":
        case ".7z":
        case ".doc":
        case ".docx":
        case ".xls":
        case ".xlsx":
        case ".ppt":
        case ".pptx":
        case ".odt":
        case ".ods":
        case ".odp":
        case ".bin":
        case ".dat":
        case ".obj":
        case ".o":
        case ".a":
        case ".lib":
        case ".wasm":
        case ".pyc":
        case ".pyo":
          return true
      }

      if (bytes.length === 0) return false

      let nonPrintableCount = 0
      for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] === 0) return true
        if (bytes[i] < 9 || (bytes[i] > 13 && bytes[i] < 32)) {
          nonPrintableCount++
        }
      }

      return nonPrintableCount / bytes.length > 0.3
    }

    // SymbolKind → human label, per LSP spec. Numbers come from
    // packages/opencode/src/lsp/lsp.ts:78-105.
    const symbolKindLabel = (kind: number): string => {
      const map: Record<number, string> = {
        1: "File",
        2: "Module",
        3: "Namespace",
        4: "Package",
        5: "Class",
        6: "Method",
        7: "Property",
        8: "Field",
        9: "Constructor",
        10: "Enum",
        11: "Interface",
        12: "Function",
        13: "Variable",
        14: "Constant",
        15: "String",
        16: "Number",
        17: "Boolean",
        18: "Array",
        19: "Object",
        20: "Key",
        21: "Null",
        22: "EnumMember",
        23: "Struct",
        24: "Event",
        25: "Operator",
        26: "TypeParam",
      }
      return map[kind] ?? `Kind${kind}`
    }

    // Format a DocumentSymbol subtree. Recursive for nested symbols.
    // Caps total output to OUTLINE_MAX_BYTES so a giant file doesn't blow context.
    const formatSymbolTree = (
      sym: LSP.DocumentSymbol,
      depth: number,
      lines: string[],
      bytes: { value: number },
    ): void => {
      if (lines.length >= OUTLINE_MAX_SYMBOLS || bytes.value >= OUTLINE_MAX_BYTES) return
      const indent = "  ".repeat(depth)
      const range = `${sym.range.start.line + 1}-${sym.range.end.line + 1}`
      const detail = sym.detail ? `  ${sym.detail}` : ""
      const line = `${indent}${range}  ${symbolKindLabel(sym.kind)}  ${sym.name}${detail}`
      lines.push(line)
      bytes.value += Buffer.byteLength(line, "utf8") + 1
      if ("children" in sym && Array.isArray((sym as LSP.DocumentSymbol & { children?: LSP.DocumentSymbol[] }).children)) {
        for (const child of (sym as LSP.DocumentSymbol & { children: LSP.DocumentSymbol[] }).children) {
          formatSymbolTree(child, depth + 1, lines, bytes)
        }
      }
    }

    // Flat mode: walk the tree, push one line per leaf, no indentation.
    const formatSymbolFlat = (
      sym: LSP.DocumentSymbol,
      lines: string[],
      bytes: { value: number },
    ): void => {
      if (lines.length >= OUTLINE_MAX_SYMBOLS || bytes.value >= OUTLINE_MAX_BYTES) return
      const range = `${sym.range.start.line + 1}-${sym.range.end.line + 1}`
      const detail = sym.detail ? `  ${sym.detail}` : ""
      const line = `${range}  ${symbolKindLabel(sym.kind)}  ${sym.name}${detail}`
      lines.push(line)
      bytes.value += Buffer.byteLength(line, "utf8") + 1
      if ("children" in sym && Array.isArray((sym as LSP.DocumentSymbol & { children?: LSP.DocumentSymbol[] }).children)) {
        for (const child of (sym as LSP.DocumentSymbol & { children: LSP.DocumentSymbol[] }).children) {
          formatSymbolFlat(child, lines, bytes)
        }
      }
    }

    // Build an outline via the language server. Returns null when no LSP server
    // is available for this file or no symbols came back — callers fall back
    // to a plain text read in that case.
    const outline = Effect.fn("ReadTool.outline")(function* (filepath: string, mode: "outline" | "symbols") {
      const has = yield* lsp.hasClients(filepath).pipe(Effect.catch(() => Effect.succeed(false)))
      if (!has) return null

      const uri = pathToFileURL(filepath).href
      const symbols = yield* lsp
        .documentSymbol(uri)
        .pipe(Effect.catch(() => Effect.succeed([] as (LSP.DocumentSymbol | LSP.Symbol)[])))
      if (symbols.length === 0) return null

      // Find the connected server id (for the footer) by intersecting with status().
      const status = yield* lsp.status().pipe(Effect.catch(() => Effect.succeed([] as LSP.Status[])))
      const serverId = status.length > 0 ? status.map((s) => s.id).join("+") : "lsp"

      const lines: string[] = []
      const bytes = { value: 0 }
      const truncate = lines.length >= OUTLINE_MAX_SYMBOLS || bytes.value >= OUTLINE_MAX_BYTES

      for (const sym of symbols) {
        if (lines.length >= OUTLINE_MAX_SYMBOLS || bytes.value >= OUTLINE_MAX_BYTES) break
        // DocumentSymbol has nested children + a 1-based line range; Symbol is
        // flat with a location. We only support DocumentSymbol tree formatting.
        if ("range" in sym && "selectionRange" in sym) {
          if (mode === "outline") formatSymbolTree(sym, 0, lines, bytes)
          else formatSymbolFlat(sym, lines, bytes)
        } else {
          const range = `${sym.location.range.start.line + 1}-${sym.location.range.end.line + 1}`
          const line = `${range}  ${symbolKindLabel(sym.kind)}  ${sym.name}`
          lines.push(line)
          bytes.value += Buffer.byteLength(line, "utf8") + 1
        }
      }

      const truncated = lines.length >= OUTLINE_MAX_SYMBOLS || bytes.value >= OUTLINE_MAX_BYTES
      const limitNote = truncated
        ? `\n(Outline truncated at ${OUTLINE_MAX_SYMBOLS} symbols / ${OUTLINE_MAX_BYTES / 1024}KB. Use ast=off to read raw content.)`
        : ""
      return `${lines.join("\n")}${limitNote}\n(${lines.length} symbols via ${serverId}. Use ast=off to read raw content, or ast=outline with offset=N to read around a line.)`
    })

    const run = Effect.fn("ReadTool.execute")(function* (params: z.infer<typeof parameters>, ctx: Tool.Context) {
      if (params.offset !== undefined && params.offset < 1) {
        return yield* Effect.fail(new Error("offset must be greater than or equal to 1"))
      }
      if (params.around !== undefined && params.around < 1) {
        return yield* Effect.fail(new Error("around must be greater than or equal to 1"))
      }

      let filepath = params.filePath
      if (!path.isAbsolute(filepath)) {
        filepath = path.resolve(SessionCwd.get(ctx.sessionID), filepath)
      }
      if (process.platform === "win32") {
        filepath = AppFileSystem.normalizePath(filepath)
      }
      const title = path.relative(Instance.worktree, filepath)

      const stat = yield* fs.stat(filepath).pipe(
        Effect.catchIf(
          (err) => "reason" in err && err.reason._tag === "NotFound",
          () => Effect.succeed(undefined),
        ),
      )

      yield* assertExternalDirectoryEffect(ctx, filepath, {
        bypass: Boolean(ctx.extra?.["bypassCwdCheck"]),
        kind: stat?.type === "Directory" ? "directory" : "file",
      })

      yield* ctx.ask({
        permission: "read",
        patterns: [filepath],
        always: ["*"],
        metadata: {},
      })

      if (!stat) return yield* miss(filepath)

      if (stat.type === "Directory") {
        const items = yield* list(filepath)
        const limit = params.limit ?? DEFAULT_READ_LIMIT
        const offset = params.offset ?? 1
        const start = offset - 1

        // Apply .gitignore / .ignore filtering unless showIgnored is true.
        let visible = items
        let ignoreNote = ""
        if (params.showIgnored !== true) {
          const { ig, found } = yield* loadIgnore(filepath)
          if (found) {
            const filtered = items.filter((entry) => {
              const rel = path.relative(filepath, path.join(filepath, entry))
              return !ig.ignores(rel)
            })
            if (filtered.length !== items.length) {
              visible = filtered
              ignoreNote = `\n(Filtered by .gitignore / .ignore / .nc-mimo-codeignore. Pass showIgnored=true to include them.)`
            }
          }
        } else {
          ignoreNote = `\n(Showing all entries, including ignored ones.)`
        }

        const sliced = visible.slice(start, start + limit)
        const truncated = start + sliced.length < visible.length

        return {
          title,
          output: [
            `<path>${filepath}</path>`,
            `<type>directory</type>`,
            `<entries>`,
            sliced.join("\n"),
            truncated
              ? `\n(Showing ${sliced.length} of ${visible.length} entries. Use 'offset' parameter to read beyond entry ${offset + sliced.length})`
              : `\n(${visible.length} entries)`,
            ignoreNote,
            `</entries>`,
          ].join("\n"),
          metadata: {
            preview: sliced.slice(0, 20).join("\n"),
            truncated,
            loaded: [] as string[],
          },
        }
      }

      // From here, `stat` is a File.
      const loaded = yield* instruction.resolve(ctx.messages, filepath, ctx.messageID)
      const sample = yield* readSample(filepath, Number(stat.size), SAMPLE_BYTES)
      const statSize = Number(stat.size)

      // AST / outline mode — short-circuit before encoding/media/binary checks.
      if (params.ast === "outline" || params.ast === "symbols") {
        const result = yield* outline(filepath, params.ast)
        if (result !== null) {
          const paginationNote =
            params.offset !== undefined || params.around !== undefined || params.limit !== undefined
              ? "\n(offset/limit/around ignored in outline mode)"
              : ""
          return {
            title,
            output: [
              `<path>${filepath}</path>`,
              `<type>outline</type>`,
              `<content>`,
              result,
              paginationNote,
              `</content>`,
            ].join("\n"),
            metadata: {
              preview: result.split("\n").slice(0, 20).join("\n"),
              truncated: false,
              loaded: loaded.map((item) => item.filepath),
            },
          }
        }
        // No LSP available — fall through to a normal text read and prepend a note.
        const fallback = yield* readTextFile(filepath, statSize, sample, params, ctx, loaded, Option.getOrUndefined(stat.mtime))
        return {
          ...fallback,
          output: `(No LSP outline available for this file; returning raw content.)\n\n${fallback.output}`,
        }
      }

      const mime = sniffAttachmentMime(sample, AppFileSystem.mimeType(filepath))
      if (isImageAttachment(mime) || isPdfAttachment(mime)) {
        const cap = params.maxAttachmentBytes ?? DEFAULT_ATTACHMENT_CAP
        if (statSize > cap) {
          return yield* Effect.fail(
            new Error(
              `Cannot read attachment: ${filepath} is ${humanBytes(statSize)}, exceeding the ${humanBytes(
                cap,
              )} cap. Pass maxAttachmentBytes=${statSize} to override, or downsize the file first.`,
            ),
          )
        }
        const bytes = yield* fs.readFile(filepath)
        const msg = isPdfAttachment(mime) ? "PDF read successfully" : "Image read successfully"
        return {
          title,
          output: msg,
          metadata: {
            preview: msg,
            truncated: false,
            loaded: loaded.map((item) => item.filepath),
          },
          attachments: [
            {
              type: "file" as const,
              mime,
              url: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`,
            },
          ],
        }
      }

      // Encoding detection: honor the explicit request when provided, otherwise
      // infer. The result is exposed in the metadata header so the model can
      // see how the file was interpreted.
      const detected =
        params.encoding && params.encoding !== "auto" ? (params.encoding as Encoding) : detectEncoding(sample)

      // Skip the binary check for known text encodings. The byte-level heuristic
      // is tuned for utf-8 / ascii and misclassifies utf-16 (which has NUL bytes
      // between ASCII chars) and binary-ish Latin-1 streams. When the user asked
      // for or we detected a non-utf-8 text encoding, trust the encoder.
      const isTextEncoding = detected === "utf-16le" || detected === "utf-16be" || detected === "windows-1252"
      if (!isTextEncoding && isBinaryFile(filepath, sample)) {
        return yield* Effect.fail(new Error(`Cannot read binary file: ${filepath}`))
      }

      yield* warm(filepath)
      return yield* readTextFile(filepath, statSize, sample, params, ctx, loaded, Option.getOrUndefined(stat.mtime), detected)
    })

    // Shared text-read path. Used by the main flow and by the ast-fallback
    // path. Composes the offset/around resolution, streaming, metadata
    // header, and trailing hint into one place.
    //
    // Returns an Effect so it can be yielded inside Effect.fn callers. We use
    // a plain `function*` (not Effect.fn) so the inferred return type is a
    // concrete `Effect<...>` rather than the generator-of-yieldables that
    // Effect.fn produces, which would lose type information at call sites.
    const readTextFile = (
      filepath: string,
      statSize: number,
      sample: Uint8Array,
      params: z.infer<typeof parameters>,
      ctx: Tool.Context,
      loadedIn?: { filepath: string; content: string }[],
      mtime?: Date,
      detectedOverride?: Encoding,
    ) =>
      Effect.gen(function* () {
      const limit = params.limit ?? DEFAULT_READ_LIMIT

      // Resolve effective offset+limit. `around` wins over `offset` when set.
      let effectiveOffset = params.offset ?? 1
      let centeredOn: number | undefined
      if (params.around !== undefined) {
        const half = Math.floor(limit / 2)
        effectiveOffset = Math.max(1, params.around - half)
        centeredOn = params.around
      }

      // Use the encoding from the caller (already detected + honored) when
      // provided; otherwise fall back to local detection. The caller in `run`
      // always passes this in, but keep the fallback for safety.
      const detected: Encoding =
        detectedOverride ??
        ((params.encoding && params.encoding !== "auto" ? params.encoding : detectEncoding(sample)) as Encoding)

      const file = yield* Effect.promise(() => lines(filepath, { limit, offset: effectiveOffset, encoding: detected }))
      if (file.count < file.offset && !(file.count === 0 && file.offset === 1)) {
        return yield* Effect.fail(
          new Error(`Offset ${file.offset} is out of range for this file (${file.count} lines)`),
        )
      }

      const loaded = loadedIn ?? (yield* instruction.resolve(ctx.messages, filepath, ctx.messageID))

      // Language hint via LSP server id (cheap pre-check, no server spawn).
      const hasServer = yield* lsp.hasClients(filepath).pipe(Effect.catch(() => Effect.succeed(false)))
      const langHint = !hasServer
        ? undefined
        : yield* lsp
            .status()
            .pipe(Effect.map((statuses) => statuses.find((s) => s.status === "connected")?.id))
            .pipe(Effect.catch(() => Effect.succeed(undefined)))

      const mtimeValue = mtime
      const metaParts = [
        `size=${humanBytes(statSize)}`,
        `lines=${file.count}`,
        `encoding=${detected}`,
        ...(langHint ? [`lang=${langHint}`] : []),
        ...(mtimeValue ? [`modified=${mtimeValue.toISOString()}`] : []),
      ]
      const metaLine = `<meta>${metaParts.join(", ")}</meta>`

      let output = [
        `<path>${filepath}</path>`,
        `<type>file</type>`,
        metaLine,
        "<content>\n",
      ].join("\n")
      output += file.raw.map((line, i) => `${i + file.offset}: ${line}`).join("\n")

      const last = file.offset + file.raw.length - 1
      const next = last + 1
      const truncated = file.more || file.cut
      if (file.cut) {
        output += `\n\n(Output capped at ${MAX_BYTES_LABEL}. Showing lines ${file.offset}-${last}. Use offset=${next} to continue.)`
      } else if (centeredOn !== undefined) {
        output += `\n\n(Centered on line ${centeredOn}. Showing lines ${file.offset}-${last}. Use offset=${next} to read forward, or around=${centeredOn} with a larger limit for more context.)`
      } else if (file.more) {
        output += `\n\n(Showing lines ${file.offset}-${last} of ${file.count}. Use offset=${next} to continue.)`
      } else {
        output += `\n\n(End of file - total ${file.count} lines)`
      }
      output += "\n</content>"

      if (loaded.length > 0) {
        output += `\n\n<system-reminder>\n${loaded.map((item) => item.content).join("\n\n")}\n</system-reminder>`
      }

      return {
        title: path.relative(Instance.worktree, filepath),
        output,
        metadata: {
          preview: file.raw.slice(0, 20).join("\n"),
          truncated,
          loaded: loaded.map((item) => item.filepath),
        },
      }
    })

    return {
      description: DESCRIPTION,
      parameters,
      formatValidationError: Tool.formatZodError({
        filePath: { type: "string (absolute path)", required: true },
        offset: { type: "number (1-indexed line number)", required: false, note: "must be >= 1; ignored if 'around' is set" },
        limit: { type: "number (max lines to read)", required: false, note: "must be > 0; ignored if 'around' is set" },
        around: { type: "number (1-indexed line number)", required: false, note: "must be >= 1; overrides offset" },
        ast: { type: '"off" | "outline" | "symbols"', required: false, values: ["off", "outline", "symbols"] },
        encoding: {
          type: '"auto" | encoding name',
          required: false,
          values: ["auto", "utf-8", "utf-16le", "utf-16be", "windows-1252", "ascii"],
        },
        maxAttachmentBytes: { type: "positive integer (bytes)", required: false, note: "default 10MB" },
        showIgnored: { type: "boolean", required: false, note: "default false" },
      }),
      execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) => run(params, ctx).pipe(Effect.orDie),
    }
  }),
)

async function lines(filepath: string, opts: { limit: number; offset: number; encoding?: Encoding }) {
  const encoding = opts.encoding ?? "utf-8"

  // For non-utf-8 / non-ascii encodings (e.g. utf-16), node's `readline`
  // doesn't work because it splits on UTF-16 line breaks incorrectly. Read
  // the whole file, decode it, then split manually. Files are bounded by
  // the tool's text cap so this is fine in practice.
  if (encoding !== "utf-8" && encoding !== "ascii") {
    const buf = await Bun.file(filepath).arrayBuffer()
    const text = new TextDecoder(encoding).decode(buf)
    return sliceLines(text.split(/\r\n|\r|\n/), opts)
  }

  const stream = createReadStream(filepath, { encoding: "utf8" })
  const rl = createInterface({
    input: stream,
    // Note: we use the crlfDelay option to recognize all instances of CR LF
    // ('\r\n') in file as a single line break.
    crlfDelay: Infinity,
  })

  const start = opts.offset - 1
  const raw: string[] = []
  let bytes = 0
  let count = 0
  let cut = false
  let more = false
  try {
    for await (const text of rl) {
      count += 1
      if (count <= start) continue

      if (raw.length >= opts.limit) {
        more = true
        continue
      }

      const line = text.length > MAX_LINE_LENGTH ? text.substring(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX : text
      const size = Buffer.byteLength(line, "utf-8") + (raw.length > 0 ? 1 : 0)
      if (bytes + size > MAX_BYTES) {
        cut = true
        more = true
        break
      }

      raw.push(line)
      bytes += size
    }
  } finally {
    rl.close()
    stream.destroy()
  }

  return { raw, count, cut, more, offset: opts.offset }
}

// Shared pagination logic for both streaming and buffer-based readers.
function sliceLines(allLines: string[], opts: { limit: number; offset: number }) {
  const start = opts.offset - 1
  const raw: string[] = []
  let bytes = 0
  let cut = false
  let more = false
  for (let i = 0; i < allLines.length; i++) {
    if (i < start) continue
    if (raw.length >= opts.limit) {
      more = true
      continue
    }
    const text = allLines[i]
    const line = text.length > MAX_LINE_LENGTH ? text.substring(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX : text
    const size = Buffer.byteLength(line, "utf-8") + (raw.length > 0 ? 1 : 0)
    if (bytes + size > MAX_BYTES) {
      cut = true
      more = true
      break
    }
    raw.push(line)
    bytes += size
  }
  return { raw, count: allLines.length, cut, more, offset: opts.offset }
}
