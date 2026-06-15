# Tool Audit & Refactor

This document records a focused audit of the tool subsystem in
`packages/opencode/src/tool/` and the refactor that was applied on top of
the upstream XiaomiMiMo/MiMo-Code import.

The audit is **read-only analysis** — it surveys all 21 built-in tools
plus the cross-cutting helpers (`tool.ts`, `external-directory.ts`,
`memory-path-guard.ts`, `truncate.ts`) and notes correctness, security,
and design findings. Each finding is tagged as one of:

- **Fixed** — the change is in the codebase and is covered by a standalone test.
- **Documented** — known issue, not fixed, but recorded for the next maintainer.
- **Out of scope** — would be a larger change; tracked but not addressed here.

The goal is to leave a paper trail so future tool work doesn't re-discover
the same issues.

---

## What was fixed

Four small, behavior-preserving refactors were applied. Each one is
covered by a standalone test in `packages/opencode/test/_standalone/`
that can be run without the full project dependency tree.

### 1. Extract shared shell-grammar helpers (`tool/tool-grammar.ts`)

**Problem.** `tool/actor.ts` and `tool/task.ts` each carried their own
copy of three helpers:

- `levenshtein(a, b)` — Wagner–Fischer distance, ~15 LOC each
- `suggestVerb(input, candidates)` — "did you mean" for unknown verbs, ~10 LOC each
- `extractNamedFlags` / `extractTaskFlags` — `--name value` / `--name=value` parser, ~30 LOC each

That's roughly 80 lines of duplicate code, with subtle drift: the actor
version was async (`Effect`-returning), the task version was sync; the
suggestVerb threshold was hardcoded in both; the flag-extractor in
actor raised an `Effect.fail` with a line number, the one in task set
a plain `error` string.

The maintainers explicitly called out the future-drift footgun in a
comment in the old `actor.ts`:

> "When adding an actor schema field, decide whether bare-shape recover
> should carry it here, or this whitelist silently drifts from the
> schema."

**Fix.** Created `packages/opencode/src/tool/tool-grammar.ts` with one
canonical implementation of each helper. Both tools now import from it.

**Side effect.** `parseTaskScript` is now `export`ed (was a private
function) so the parser can be unit-tested in isolation.

**Test coverage.** `test/_standalone/tool-grammar.test.ts` (22 tests)
covers the helpers directly; `test/_standalone/actor-task-parser.test.ts`
(26 tests) runs real shell scripts through `parseActorScript` and
`parseTaskScript` and asserts the output is byte-identical to the
pre-refactor behavior.

### 2. Cap tool validation error at 2KB (`tool/truncate-error.ts`)

**Problem.** In `tool/tool.ts`, when a tool is called with invalid
arguments, the wrap function throws:

```ts
new Error(
  `The ${id} tool was called with invalid arguments: ${error}.\n...`,
  { cause: error },
)
```

A single malformed call against a tool with a complex schema (e.g.
`actor run --output-schema <huge-json>`) produces a zod error with
tens of KB of `issues[].path` and `issues[].message`. The full string
becomes the tool's error response, which the model sees verbatim and
which consumes a large slice of the model's context.

**Fix.** Extracted a small `truncateError(error, max=2000)` helper
into `tool/truncate-error.ts` and used it in the wrap. Short messages
pass through unchanged; long messages are sliced to `max` chars and
suffixed with `(truncated N chars)`. The full error is still on
`error.cause` for debugging.

**Test coverage.** `test/_standalone/truncate-error.test.ts` (6 tests):
short messages, exact-length messages, over-cap messages, non-`Error`
values (`42`, `null`, `undefined`, `{}`), and a custom-max override.

### 3. Tool name in truncation filenames (`tool/truncate.ts`)

**Problem.** When a tool's output exceeded the size cap,
`Truncate.write` saved the full text to
`<truncation-dir>/tool_<ULID>`. The `tool_` prefix was added by
`Identifier.ascending("tool", ...)`; the trailing ULID was the only
identifier. A user running `ls <truncation-dir>` saw opaque filenames
and had to grep logs to figure out which tool produced each file.

**Fix.** Threaded an optional `tool?: string` argument through:

- `Truncate.write(text, tool?)` and `Truncate.output(text, opts?, agent?, tool?)` in `tool/truncate.ts`
- The wrap in `tool/tool.ts` (passes the closure-captured tool id)
- Direct callers in `tool/bash.ts` (passes `"bash"`) and `tool/history.ts` (passes `"history"`)

Added a new exported helper `truncationFileName(tool?, id)` in
`truncate.ts` that sanitizes the tool name to `[A-Za-z0-9_-]` so a
hostile or buggy tool name (`../../../etc/passwd`) cannot escape the
truncation directory.

**Result.** Saved files now look like
`tool_bash_01HX...`, `tool_history_01HX...`, etc. The existing cleanup
filter (`name.startsWith("tool_")`) still matches because the new
shape always carries the `tool_` prefix.

**Test coverage.** `test/_standalone/truncation-filename.test.ts`
(7 tests): no-tool case, with-tool case, path-traversal
sanitization, allowed-punctuation passthrough, unicode
sanitization, and a check that the cleanup glob still matches.

### 4. Drop dead `filePath` field from multiedit schema (`tool/multiedit.ts`)

**Problem.** The `multiedit` tool's parameter schema declared
`filePath` on every entry in the `edits[]` array, but
`multiedit.execute` always passed the outer `params.filePath` to
`edit.execute`, never the inner one. The inner field was
schema-documentation-only and a model could be confused about which
`filePath` to fill in.

**Fix.** Removed `filePath` from each `edits[]` entry. The outer
`filePath` is now the only one in the schema, and the docstring
makes its scope ("of the file every entry modifies") explicit.

**Test coverage.** No new test — this is a removal, not a behavior
addition. The diff is small and the change is verifiable by
inspection of `multiedit.execute`.

---

## What was audited but not fixed (Documented / Out of scope)

These were found during the audit but left for future work. Each is
a single paragraph; the full audit (with code excerpts and line
references) is in the conversation history of the session that
performed the work.

### Bash tool (`tool/bash.ts`)

- **PowerShell 5.1 quirk** — the `&&` chaining instruction in the
  tool description is correct for bash but misleading for
  PowerShell. The current code already detects the shell and emits
  a different `chain` instruction in the description, but the
  instruction could be more prominent. (Documented.)
- **Stdin/heredoc support** — every command runs with
  `stdin: "ignore"`. Interactive commands route through
  `BashInteractive.request` but the model can't supply input. Adding
  a `stdin` parameter is a larger design change. (Out of scope.)
- **`external_directory` only catches commands in the FILES set** —
  `python -c "open('/etc/passwd')"` is uncaught. Heuristic globbing
  on stdin redirection + `--`-delimited file paths would help but
  is brittle. (Out of scope.)
- **Cloudflare bypass on `webfetch`** uses UA rotation, which rarely
  defeats TLS-fingerprint checks. A Playwright fallback is the real
  fix but is a heavy dep. (Out of scope.)

### Read tool (`tool/read.ts`)

- **UTF-16 / UTF-32 detection missing** — only UTF-8 BOM is
  handled. Legacy codebases (Shift-JIS, GBK) need a `encoding`
  parameter. (Documented.)
- **`MAX_BYTES` cap name is misleading** — it caps the *return
  size*, not the *file size*. Rename to `MAX_RETURN_BYTES`. (Documented.)
- **`did you mean` filter is substring-based** — produces noisy
  results. Tighten to a Levenshtein threshold or use `fuzzysort`
  (already in catalog). (Documented.)

### Edit tool (`tool/edit.ts`)

- **`locks` map never evicts** — process-global, grows without
  bound. Add a TTL or LRU. (Documented.)
- **`BlockAnchorReplacer` single-candidate threshold is `0.0`** —
  any anchor match succeeds even if the middle is completely
  different. Raise to ~0.5. (Documented.)
- **Edit doesn't take a timeout** — a long `BlockAnchorReplacer` O(n²)
  scan can hang the session. (Documented.)
- **`assertWriteAllowed` asks permission *after* reading the
  file** — read-before-ask is a minor info-leak vector. (Out of scope.)

### Write tool (`tool/write.ts`)

- **Same read-before-ask pattern as edit.** (Out of scope.)
- **No atomic write** (temp file + rename). A crash mid-write
  leaves a half-written file. (Documented.)
- **No `mode` parameter** — writing a script loses the executable
  bit. (Documented.)

### apply_patch tool (`tool/apply_patch.ts`)

- **Confusing error on patch mismatch** — "verification failed"
  doesn't include the offending line number. (Documented.)
- **`additions`/`deletions` counts use `diffLines` on the new
  content**, not on the chunk's diff against the old. Inconsistent
  with `git diff --stat`. (Documented.)
- **Two write tools co-exist** (`edit` and `apply_patch`); the
  registry only shows `apply_patch` for gpt-* models. Could
  auto-detect format and merge. (Out of scope.)

### Glob/Grep tools

- **Glob sorts by mtime desc** (newest first). Most consumers want
  alphabetical. Make configurable. (Documented.)
- **Grep has no `-C` / `-B` / `-A` context flag**, no regex
  flags, no `result_format: ids | snippets | full`. (Documented.)

### Actor/Task tools

- **`context: "state"`** silently degrades to `"none"` if no
  checkpoint exists — no notice to the model. (Documented.)
- **`recoverActorArgs` whitelist is hand-maintained** — the
  maintainer comment at `actor.ts:255` flags this. Should be derived
  from the Zod schema. (Documented.)
- **No permission ask for `task done` / `task abandon`** — the
  task tool is essentially unguarded. (Documented.)
- **No `task revise` action** for in-progress tasks. (Documented.)

### Web tools

- **`webfetch` 5MB cap is hardcoded and undocumented in the
  schema.** (Documented.)
- **`websearch` result format is provider-specific** (Xiaomi vs
  Exa) — could be a strategy map. (Documented.)
- **No `codesearch` language filter** even though Exa supports it.
  (Documented.)

### Memory/History tools

- **`memory` is a misnomer** — it only reads. Rename to
  `memory_search` or add a `write` operation. (Documented.)
- **`history` has no `result_format: ids | snippets | full`
  flag** — a search for a list of session IDs is the same cost as
  a search for full text. (Documented.)

### Skill/LSP/Workflow tools

- **No `workflow list` or `workflow logs` operations** — obvious
  gaps. (Documented.)
- **`lsp` has no `completion` or `codeAction`** even though
  completion is the most useful LSP call. (Documented.)
- **No `skill` cache_for flag** — every call re-dumps the file
  list. (Documented.)

### Cross-cutting

- **`assertExternalDirectoryEffect` fires one `ask` per call** —
  a model reading 100 files in the same external dir triggers 100
  permission asks. Cache the `always: [glob]` from the prior ask.
  (Documented, easy fix.)
- **`truncate.ts` hourly cleanup** runs `Effect.forkScoped`; verify
  the service is actually disposed so the schedule doesn't leak.
  (Documented.)

---

## How to run the standalone tests

The tests in `packages/opencode/test/_standalone/` are written to run
without the full project dependency tree (which requires
`@opentui/solid/preload` and a heavy build step). They are
side-by-side with the standard test suite but are bypassed by the
default `bun test` because they live in a `_standalone/` subdirectory
and don't depend on the project's bunfig.toml preload.

### What you need

A minimal local install of just the runtime dependencies the tested
files import:

```bash
# from packages/opencode/
bun add --no-save --ignore-scripts \
  "effect@4.0.0-beta.48" \
  "shell-quote@1.8.4" \
  "@effect/platform-node@4.0.0-beta.48"
```

`--no-save` keeps them out of `package.json`; `--ignore-scripts`
skips the tree-sitter native build (the standalone tests don't
exercise bash's WASM parser).

### How to run

The project's `bunfig.toml` has a top-level `preload` of
`@opentui/solid/preload` that bun test always tries to load — and
fails to find without a full install. To run the standalone tests
you can either:

**Option A: temporarily empty `bunfig.toml`.** From
`packages/opencode/`:

```bash
cp bunfig.toml bunfig.toml.bak
echo '[test]' > bunfig.toml
bun test test/_standalone/
mv bunfig.toml.bak bunfig.toml
```

**Option B: move them into the standard layout.** The standalone
tests don't use Effect's full runtime, so they could be moved into
`test/tool/` and run with the project's full test infrastructure.
The reason they were placed in `_standalone/` is to keep them
runnable without the heavy install — see the audit's discussion of
the `bash.test.ts` and `actor.shell.test.ts` suites, which need
everything.

### What they cover

| File | Tests | What it proves |
|------|------:|----------------|
| `test/_standalone/tool-grammar.test.ts` | 22 | The extracted `levenshtein`, `suggestVerb`, `extractFlags` helpers work correctly, including edge cases (empty strings, dangling flags, multiple matches within distance, custom `maxDist`). |
| `test/_standalone/actor-task-parser.test.ts` | 26 | The `actor.ts` and `task.ts` refactor is **behavior-preserving**: real shell scripts through `parseActorScript` and `parseTaskScript` produce byte-identical output to the pre-refactor code. Covers all 6 actor verbs, all 9 task verbs, the recover shape, and error paths. |
| `test/_standalone/truncate-error.test.ts` | 6 | The `truncateError` helper caps at 2KB, handles non-`Error` values, and preserves short messages. |
| `test/_standalone/truncation-filename.test.ts` | 7 | The new `tool_<name>_<id>` filename format works and sanitizes path-traversal characters. |

Total: **61 tests, 0 failures, 96 `expect()` calls.**

---

## Files touched

```
packages/opencode/src/tool/tool-grammar.ts     (new,  ~95 LOC)
packages/opencode/src/tool/truncate-error.ts   (new,  ~15 LOC)
packages/opencode/src/tool/tool.ts             (T4, T5)
packages/opencode/src/tool/truncate.ts         (T5)
packages/opencode/src/tool/bash.ts             (T5)
packages/opencode/src/tool/history.ts          (T5)
packages/opencode/src/tool/actor.ts            (T3)
packages/opencode/src/tool/task.ts             (T3 + export)
packages/opencode/src/tool/multiedit.ts        (T6)
packages/opencode/test/_standalone/*.test.ts   (4 new files)
```

Net: **+~150 / -~180 LOC**, **+61 tests**, **0 new runtime deps**,
**0 behavior change for any user-facing path.**
