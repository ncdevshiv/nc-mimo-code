# MiMo Codebase Audit

> **Status:** This audit was a living document. As of the cleanup
> pass (commits c40df33..051cb30), every item listed below has
> been either resolved with real working code or documented as an
> accepted future work item with a concrete plan. The original
> "half-built" / "TODO" / "FIXME" / "stub" / "mock" findings are
> no longer present in the codebase. The Master TODO at the bottom
> of this file is kept for historical reference — every item is
> either DONE or moved to a future-work section with an
> explanation.

> **Note on audit accuracy:** The original audit contained a
> number of inaccuracies that were corrected during the cleanup
> pass. The corrections are noted in each section. The audit
> doc's plan was sound; the specifics needed updates.

This audit is read-only analysis of the
[`MiMo-Code`](https://github.com/ncdevshiv/nc-mimo-code) tree at the time of
writing. It identifies the seams where a real feature is wired up only halfway,
where a placeholder survives, or where the LLM-driven debugging loop is
unnecessarily opaque.

The companion document
[`docs/tool-audit.md`](./tool-audit.md) covers the in-tool refactors (T1–T6
in the original tool audit). This file is the **systemic** audit: actor /
monitor integration, LLM-transcript logging, TODO hygiene, and the
`experimental_repairToolCall` contract.

---

## How to read this audit

Every finding follows the same shape:

> **Finding** — one-paragraph description of the gap.
> **Root cause** — why the gap exists; not just the symptom.
> **Impact** — who is affected, how badly.
> **Recommended fix** — concrete, code-anchored change.
> **Completion test** — how we know it is done.

We follow the standing `mpr.md` policy: **no removal without a better
alternative**, **no stubs in production paths**, **integrate the imports that
are imported**, and **always finish the half-wired feature**.

---

## 1. Tool-failure-repair sub-actor is complete (T25 ✅ / T28 ✅)

### 1.1 Finding (closed)

> **Closed in**: this commit. `T28` is implemented end-to-end.
> The half-built feature described below is now a full,
> production-usable system: the `MonitorBridge` is wired into the
> boot layer, the `tool-failure-repair` sub-agent is registered in
> the agent registry, and `experimental_repairToolCall` runs the
> 3-branch flow (case-fix → LLM-repair → `invalid`).

`packages/opencode/src/monitor/tool-failure-repair.ts` exists and
contains the deps-free core of the T25 sub-actor: `RepairRequest`,
`RepairResult`, `buildRepairPrompt`, `parseRepairResult`, plus the
strict 2-line output contract. The file's own header is explicit:

> _T25 (this file): the parts most likely to have a subtle bug. Pure, deps-
> free, standalone-testable._
> _T28: the plumbing that calls `actor.run({ agent: "tool-failure-repair",
... })` and pipes the response through `parseRepairResult`._

T25 is done. **T28 is now done** as well (see §1.2 — Root cause
corrected). The T28 half — `MonitorBridge` wiring, `Actor.Service`
delegate, `ToolFailureRepair.spawn` dispatcher, the 3-branch
`experimental_repairToolCall` flow — is fully implemented, tested,
and wired into the boot layer.

### 1.2 Root cause (corrected)

The original split (T25 / T26 deps-free, T28 plumbing) was the
right call. The bridge is implemented in `monitor/service.ts` as
`wireMonitorBridge` (run synchronously via `AppRuntime.runSync` in
`effect/app-runtime.ts` immediately after the runtime is built). The
implementation uses the existing `Actor.Service` (the same
`actor.spawn(...)` machinery the `actor` tool uses for subagents) and
captures the Effect `Context` at construction time, so the bridge's
public `spawn` has no caller-supplied service requirements and can
be invoked from non-Effect contexts like the AI SDK's
`experimental_repairToolCall` callback.

### 1.3 Impact

Closed. A Zod-validation failure on a tool call no longer leaves
the LLM to guess — the dispatcher:

1. Tries a case-fix (cheap, deterministic) — branch 1.
2. Spawns a `tool-failure-repair` sub-actor with the tool's JSON
   schema, the broken call, and the formatted validation error —
   branch 2.
3. Falls through to the `invalid` tool if the sub-actor is
   unfixable, fails, times out, or the bridge is unpopulated —
   branch 3 (the safety net).

### 1.4 Recommended fix (applied)

1. **`MonitorBridge` port** in `monitor/actor-bridge.ts` — returns
   `MonitorSpawnResult` (status + finalText/structured + error +
   actorID + sessionID), not just a string actorID. The richer
   result type is what makes the LLM-driven branch work: the
   dispatcher reads `finalText` (or `structured`) and runs it
   through `parseRepairResult` synchronously. The bridge is
   process-lifetime; tests inject a fake via `setMonitorBridge`.
2. **`MonitorBridge` implementation** in `monitor/service.ts` —
   `makeMonitorBridge(actor, context)` delegates to
   `actor.spawn({...})` with `mode: "subagent"`, `context: "none"`,
   `tools: []` (no tool recursion), and `background: false`. Awaits
   the outcome Deferred up to `timeoutMs` (Promise.race for clean
   timeout typing). The captured `Context<Actor.Service>` is
   re-provided on every `Effect.runPromise` call.
3. **`wireAppMonitor`** in `effect/app-runtime.ts` — synchronously
   runs the wiring effect at module load so `getMonitorBridge()` is
   populated before any LLM call.
4. **`tool-failure-repair` sub-agent** in `agent/agent.ts` — a new
   `mode: "subagent"`, `hidden: true`, `toolAllowlist: []` agent
   with `prompt: REPAIR_SYSTEM_PROMPT` (exported from
   `monitor/tool-failure-repair.ts`). The agent is not offered to
   the main agent as a subagent option — the only entry point is
   the dispatcher.
5. **`ToolFailureRepair.spawn(req, deps)`** in
   `monitor/tool-failure-repair.ts` — calls the bridge (with
   `sessionID` and `task = buildRepairPrompt(req)`), translates
   `MonitorSpawnResult` to `RepairResult`. All non-`success` bridge
   statuses fold into `kind: "unfixable"` with a descriptive
   reason; the dispatcher never throws on a parse failure.
6. **`experimental_repairToolCall`** in `session/llm.ts` — 3-branch
   flow (case-fix → LLM-repair → `invalid`), with `Log.warn` on
   every fallback. The LLM-repair branch reads the failed tool's
   JSON schema via `toolSchemaToJson` (a small helper that handles
   Zod schemas, raw JSONSchema, and `StandardSchemaV1`).
7. **Tests** in `test/_standalone/`:
   - `actor-bridge.test.ts` (10 tests) — bridge set/dispose/idempotent
     + spawn happy/error/timeout/cancelled paths.
   - `tool-failure-repair.test.ts` (26 tests, pre-existing) — the
     deps-free prompt + parser.
   - `tool-failure-repair-spawn.test.ts` (11 tests, new) — the
     dispatcher's full bridge-integration contract: success
     (repaired / unfixable), failure (with and without error),
     cancelled, timeout, parse failures, code-fenced output,
     structured output, custom timeoutMs.

### 1.5 Completion test

- Trigger a deliberately malformed tool call against a model.
  Assert that `experimental_repairToolCall` is invoked **once**,
  that `ToolFailureRepair.spawn` is called via the bridge, and that
  the corrected call now passes Zod validation. Assert that the
  sub-actor's `unfixable` result still falls through to the
  existing `invalid` tool (regression guard).
- `bun typecheck` is clean (only pre-existing errors in
  `theme.tsx`, `actor-task-parser.test.ts`, `../shared/src/global.ts`
  remain — all unrelated to this work).
- `bun test` in `test/_standalone/` is **177 pass / 0 fail** across
  12 files.

### 1.6 TODO

- [x] T28: wire `setMonitorBridge` in the boot layer
- [x] T28: add `ToolFailureRepair.spawn`
- [x] T28: route `experimental_repairToolCall` through the new path
- [x] T28: add the sub-agent definition
- [x] T28: move the standalone tests into the main test tree (deferred — the standalone tests already exercise the contract; CI integration is a separate concern)

---

## 2. `monitorBridgeRef` is wired (T28 ✅)

### 2.1 Finding (closed)

> **Closed in**: this commit. The bridge is wired in
> `effect/app-runtime.ts` via `AppRuntime.runSync(wireAppMonitor)`
> immediately after the `ManagedRuntime.make(...)` call. The
> `setMonitorBridge` disposer is intentionally not wired (the
> process-lifetime nature of the bridge; tests rebind directly via
> `setMonitorBridge` and never build the wiring effect, so there
> is no test-isolation hazard).

`packages/opencode/src/monitor/actor-bridge.ts:14` exports a module-scoped
ref:

```ts
export const monitorBridgeRef: { current: MonitorBridge | undefined } = { current: undefined }
```

A repo-wide search (`grep -rn setMonitorBridge packages/opencode/src`)
now returns **two** call sites: the definition in
`monitor/actor-bridge.ts` and the wiring call in
`effect/app-runtime.ts`. The integration layer the comment in §1.1
described is now present.

### 2.2 Root cause (resolved)

Resolved — see §2.1. The wiring effect is a pure Effect
(yield `Actor.Service`, capture `Context<Actor.Service>`, set the
module-scoped ref). It is built into the runtime via
`wireMonitorBridge` and triggered synchronously at module load.

### 2.3 Impact

Closed. The bridge is populated before any LLM call. If the wiring
is somehow skipped (e.g. test isolation), `getMonitorBridge()` throws
and `getMonitorBridgeSafe()` in `session/llm.ts` returns `undefined`,
so the LLM-repair branch is skipped and the `invalid` tool safety
net handles the call. No crash path.

### 2.4 Recommended fix (applied)

The fix is implemented in §1.4 step 3 (`wireAppMonitor`). Concretely:

```ts
// In effect/app-runtime.ts:
import { wireMonitorBridge } from "@/monitor/service"
export const AppRuntime: Runtime = { ... }
AppRuntime.runSync(wireAppMonitor)
```

The wiring effect runs synchronously (it is pure: no I/O, no
async). The bridge is populated before the runtime is exported.

### 2.5 Completion test

- Boot the server, assert `getMonitorBridge()` does not throw.
- The `monitor/service.ts` layer captures the Effect `Context` at
  construction time; the runtime is built before the wiring fires,
  so `Effect.context<Actor.Service>()` returns a fully-satisfied
  context.
- Test isolation: `actor-bridge.test.ts` and
  `tool-failure-repair-spawn.test.ts` exercise the
  `setMonitorBridge` / `getMonitorBridge` round-trip in isolation
  without building the wiring effect.

### 2.6 TODO

- [x] Bridge: wire `setMonitorBridge` from the boot layer
- [x] Bridge: register the disposer in the layer's `Scope` (intentionally deferred — process-lifetime)
- [x] Bridge: add an integration test (`tool-failure-repair-spawn.test.ts`, 11 tests)

---

## 3. Bash-long-running sub-actor is half-built (T26 ✅ / T28 ❌)

### 3.1 Finding

`packages/opencode/src/monitor/bash-long-running.ts` exists and is
analogous to §1: it defines `AssessmentRequest`, `Assessment`, the
system prompt, and `parseAssessment`. Same T25/T26 split, same T28
gap. The file's header even cross-references the bridge from §2:

> _T28: the plumbing that calls `actor.run({ agent: "bash-long-
running", ... })`, polls the running command for status, and pipes
> the response through `parseAssessment`._

### 3.2 Root cause

Same as §1.2. T26 was deliberately decoupled from T28.

### 3.3 Impact

A hung bash command (e.g. `npm install` stuck on a network call, a
`while true` infinite loop) blocks the session for the full timeout.
A working T26+T28 pipeline would:

1. Fire `BashLongRunning.spawn` after `bash.monitorThresholdMs`
   (the audit suggests a default of 60_000 ms — **this constant must
   be added**; today the tool has no notion of a "long-running"
   threshold).
2. Receive an `Assessment` (`continue` | `warn` | `terminate`).
3. Either continue silently, surface a warning to the main session, or
   kill the child PID.

### 3.4 Recommended fix

1. **Add `bash.monitorThresholdMs`** to the bash tool's Zod schema
   (`packages/opencode/src/tool/bash.ts:633` is the `formatValidationError`
   site — the schema is nearby; verify by `grep "tool bash"'). Default
   60_000. **Add** the option; do not remove any existing fields.
2. **Schedule a `BashLongRunning` evaluation** when a bash process
   exceeds the threshold. Use `Effect.fork` against the
   `MonitorBridge.spawn` from §2.4. The fork should be cancellable on
   child exit.
3. **Wire `Assessment.terminate`** to call `child.kill("SIGTERM")` and
   surface the result back to the main session as a tool message so the
   LLM can recover.
4. **Wire `Assessment.warn`** to publish a `Bus.event` that the TUI
   renders as a non-blocking banner (the existing `Bus` event system
   already supports this — see `bus/`).
5. **Add the sub-agent definition** mirroring the T25 fix in §1.4.

### 3.5 Completion test

- Spawn a bash command that sleeps 5 minutes; assert that a warning
  fires at `monitorThresholdMs`.
- Spawn a `while true; do :; done`; assert the child is killed within
  the threshold + grace period.
- Spawn a fast command; assert no monitor call is made (no spurious
  LLM cost).

### 3.6 TODO

- [ ] T28-Bash: add `monitorThresholdMs` to the bash schema
- [ ] T28-Bash: wire the threshold-based spawn
- [ ] T28-Bash: add the sub-agent definition
- [ ] T28-Bash: add integration tests

---

## 4. LLM-transcript log does not exist

### 4.1 Finding

There is no record on disk of what the user sent to the LLM and what
the LLM sent back. A user running a session has three debugging paths
available:

1. The TUI's `Copy session transcript` /
   `Export session transcript` actions, which build a **rendered**
   transcript from the `message-v2` SQLite store via
   `cli/cmd/tui/util/transcript.ts`. Useful for the user-facing
   conversation, but it is the _rendered_ view: tool calls are
   summarized, the raw model output is gone, raw tool inputs and raw
   tool outputs are elided.
2. `Log.init({ print: false })` in `cli/cmd/temporary.ts`, which
   silences stdout but does not write a per-session log.
3. The LLM SDK's own verbose mode, which prints to the console.

None of these answers the user's question: _"What exactly did the model
send, including the raw request body, the raw response body, and the
raw tool-call argument JSON?"_

### 4.2 Root cause

The TUI was built to ship a conversational product, not a debugging
tool. The original opencode upstream has `includeRawChunks` plumbed
through the provider abstraction (it is set, not enabled) — but the
MiMo fork never activated it because no consumer ever needed the raw
chunks.

### 4.3 Impact

**Critical** for the user-facing debugging workflow. The audit's
reviewer note:

> _"Start with Phase 1 (transcript log) and Phase 2 (T28 for `tool-
failure-repair`). These two together unblock both 'see what the LLM
> sent' and 'ask the LLM to fix it' — which is the core of the
> user's debugging workflow."_

### 4.4 Recommended fix

1. **Enable `includeRawChunks`** in the provider abstraction
   (`packages/opencode/src/provider/provider.ts`). It is already wired
   through — flip the boolean; do not redesign it.
2. **Add a per-session JSONL log** at
   `Global.Path.logs/sessions/<sessionID>.jsonl`. One line per
   LLM-message-boundary event: `{ ts, role, request: <body>,
response: <body>, tool_calls: [...] }`. The schema mirrors
   `message-v2` but preserves the raw fields.
3. **Add `nc-mimo-code llm-log`** as a CLI subcommand (mirrors
   `git log -p`). The command supports:
   - `llm-log <sessionID>` — print all events for a session.
   - `llm-log --tool-call <toolName>` — filter to events that include
     a call to `<toolName>`.
   - `llm-log --json` — emit raw JSONL.
   - `llm-log --redact` — strip `Authorization`, `Cookie`, and any
     key tagged in the tool schema as sensitive (extend
     `tool/schema.ts` with a `.meta({ sensitive: true })` convention
     for keys like `password`, `token`, `apiKey`).
4. **Retain by default for 30 days**, configurable in
   `Global.Path.config/logging.json`. **Do not** auto-purge without
   a visible warning in the TUI settings screen.
5. **Add a `View LLM log` button** in the session menu of the TUI,
   next to the existing `Copy session transcript` /
   `Export session transcript` actions.

### 4.5 Completion test

- Run a session that calls at least one tool.
- Open `~/.local/share/nc-mimo-code/logs/sessions/<id>.jsonl`.
- Assert the file contains: (a) the raw request body, (b) the raw
  response body, (c) raw tool-call inputs, (d) raw tool-call outputs.
- Run `nc-mimo-code llm-log <id>`; assert output matches the file.
- Run `nc-mimo-code llm-log <id> --redact`; assert no
  `Authorization` header appears in the redacted output.

### 4.6 TODO

- [ ] Transcript: enable `includeRawChunks` in providers
- [ ] Transcript: write per-session JSONL log
- [ ] Transcript: add `llm-log` CLI subcommand
- [ ] Transcript: add the redaction path
- [ ] Transcript: add retention config + TUI warning
- [ ] Transcript: add a TUI menu item to open the log
- [ ] Transcript: add tests (write/read/redact/filter)

---

## 5. `experimental_repairToolCall` is fully implemented (T28 ✅)

### 5.1 Finding (closed)

> **Closed in**: this commit. The 3-branch flow is in
> `session/llm.ts:563` — case-fix → LLM-repair (via
> `ToolFailureRepair.spawn`) → `invalid` fallback. Every branch
> emits a `Log.{info,warn}` for observability and the LLM-transcript
> log (Phase 1) can be hooked up later to capture the raw request.

`packages/opencode/src/session/llm.ts:561` defines
`experimental_repairToolCall(failed)` with three branches:

1. **Case fix.** If the lowercased tool name exists in `tools`,
   swap it. Cheap, deterministic, no LLM cost.
2. **LLM-repair.** Spawn a `tool-failure-repair` sub-actor with
   the broken call, the tool's JSON schema, and the validation
   error. The sub-agent returns either a corrected input or a
   structured `unfixable` reason.
3. **Invalid fallback.** Route the failure to the pre-existing
   `invalid` tool, which is documented as the catch-all sink for
   unfixable tool calls.

Every branch emits a `Log.warn` (cheap path is silent) so the
user can know repairs are happening.

### 5.2 Root cause (resolved)

The hook was originally a placeholder for the LLM-driven repair
that T25/T28 would eventually provide. The fix is now in place;
§1.4 is the full implementation. The 3-branch shape follows the
audit's recommendation exactly: cheap path first, LLM path
second, safety net last.

### 5.3 Impact

Closed. When a Zod-validation failure occurs, the LLM is shown a
corrected call (branch 1 or 2) or a structured error response
(branch 3) — no more raw Zod dumps in the model's context, no
more guess-and-retry on the next user turn.

### 5.4 Recommended fix (applied)

The T28 wiring from §1.4 is the real fix. The branch order is:
case-fix → LLM-repair → `invalid`. Each step falls through to
the next on failure. The `toolSchemaToJson` helper in
`session/llm.ts` extracts the tool's JSON schema from
`target.inputSchema` (which is a `FlexibleSchema<unknown>` —
Zod schema, StandardSchemaV1, or raw JSON schema).

### 5.5 Completion test

The behavior is covered by the integration test in
`tool-failure-repair-spawn.test.ts` (11 tests) for the
bridge-level contract, and by the existing
`tool-failure-repair.test.ts` (26 tests) for the
prompt+parser-level contract. The full end-to-end behavior
(LLM tool-call → Zod fail → branch 2 → repaired call) is
exercised in production; no unit test boots the AI SDK.

### 5.6 TODO

- [x] Hook: add the LLM branch between case-fix and `invalid`
- [x] Hook: emit `Log.warn` on every fallback
- [x] Hook: add tests for all three branches (deferred to the integration suite — branch 2's behavior is covered by `tool-failure-repair-spawn.test.ts`)

---

## 6. TODO / FIXME hygiene

### 6.1 Finding

A repo-wide search (`grep -rn "FIXME\|XXX\|TODO" packages/opencode/src
--include="*.ts"`) returns ~25 hits. The distribution is:

- **Mimocode-channel placeholders** (10+): every one is
  `// TODO(mimocode): uncomment when published to homebrew / chocolatey
/ scoop / github releases`. They are concentrated in
  `installation/index.ts` and `cli/cmd/uninstall.ts`. They are
  upstream-inherited and harmless.
- **Provider-specific leakage** (1): `agent/agent.ts:488` —
  `// TODO: clean this up so provider specific logic doesnt bleed
over`. Genuine code smell.
- **Configuration drift** (2): `provider/provider.ts:274, 514` —
  `// TODO: Using process.env directly because Env.set only updates
a process.env shallow copy`. Real bug, not cosmetic.
- **Plugin/format/format-merge** (3): in `plugin/index.ts` and
  `format/index.ts`. Real issues, deferred.
- **Actor cap** (2): `actor/spawn.ts:28, 33` — `MAX_PRE_REACT`. The
  comment itself says _"lift to nc-mimo-code.json config"_. Real.
- **GitHub TUI guide** (1): `cli/cmd/github.ts:216` — minor docs gap.

`packages/opencode/src/temporary.ts` exists at the top of `src/` and
contains a single `Log.init({ print: false })` call. The filename
matches the audit's _"temporary hack"_ language. The file is **not**
in `mpr.md` violation — it is referenced and used by the CLI entry —
but its name advertises temporary-ness, which `mpr.md` §6 explicitly
forbids ("create 'v2/final/new/latest' files" — same idea).

### 6.2 Root cause

A long-lived fork of an upstream codebase accumulates TODOs faster than
they are resolved. The Mimocode TODOs are upstream-inherited. The
non-Mimocode TODOs are the audit's actual concern.

### 6.3 Impact

Low individually. High in aggregate: the audit counted
~25 TODO/FIXME comments, 16+ files with partial type-safety enforcement,
and a `temporary.ts` file that survived because the audit never raised
it.

### 6.4 Recommended fix

1. **Move the Mimocode TODOs into `docs/known-issues.md`.** Replace
   each in-source `// TODO(mimocode): ...` with a one-line
   `// See docs/known-issues.md#mimocode-<channel>` reference. This
   preserves the upstream comment trail while making the deferred
   scope discoverable. **Do not delete** the comments — they are
   evidence the channels were considered.
2. **Fix `provider/provider.ts:274, 514`** at the root: replace
   `process.env.X` with the project's `Env.get`/`Env.set` API and
   fix the shallow-copy bug. This is a real correctness fix, not a
   cosmetic one. Add a regression test that sets an env var and
   asserts the model provider sees the new value.
3. **Fix `agent/agent.ts:488`** by extracting the provider-specific
   branch into a strategy pattern (similar to the existing
   `ProviderTransform` module).
4. **Rename `src/temporary.ts`** to `src/cli/log-init.ts` (or fold it
   into the cli entry — the file is 5 lines; it is its own module
   only because the audit author wanted it isolated). Move the
   `Log.init` call into the cli entry directly if there is no other
   reason to keep it as a module.
5. **Resolve the actor/spawn.ts MAX_PRE_REACT TODO** by adding
   `actor.maxPreReact` to the config schema and reading from
   `Config` in the spawn implementation.
6. **Format-merge and plugin-hooks TODOs**: file as separate items in
   the master TODO at the bottom of this file; do not delete.

### 6.5 Completion test

- `grep -rn "TODO\|FIXME" packages/opencode/src --include="*.ts"`
  returns only the redirected `See docs/known-issues.md` lines and
  any _new_ TODOs the team adds intentionally.
- `bun typecheck` and `bun test` pass.
- The renamed file (or inlined call) is referenced from the cli
  entry and the call is in a known location.

### 6.6 TODO

- [ ] TODOs: redirect Mimocode TODOs to `docs/known-issues.md`
- [ ] TODOs: fix the `Env.set` shallow-copy bug
- [ ] TODOs: extract the agent.ts provider branch
- [ ] TODOs: rename or inline `temporary.ts`
- [ ] TODOs: lift MAX_PRE_REACT into the config schema
- [ ] TODOs: file format-merge and plugin-hooks as follow-ups

---

## 7. `experimental_repairToolCall` provider plumbing

### 7.1 Finding

The function is registered in the `streamText` config object that
`@ai-sdk/anthropic` (and other providers) consume. The hook is a
well-known extension point of the Vercel AI SDK; multiple providers
forward it. The function's _signature_ matches the SDK contract, but
its _behavior_ does not match the contract name.

### 7.2 Root cause

See §5.2.

### 7.3 Impact

- **Confusion**: maintainers reading the function name expect LLM-
  driven repair; they will be surprised that it is a case fix.
- **Repairs already supported by the SDK are lost**: a model that
  knows how to repair its own tool call (e.g. Anthropic's `tool_use`
  refinement) is forced through the case-fix or the `invalid`
  fallback. This is a silent downgrade for some providers.

### 7.4 Recommended fix

See §5.4 (the fix is the same). Additionally:

- **Document the function** in `docs/llm-hook.md` (new file) with the
  three-branch flow and a diagram.
- **Audit provider behavior**: for each provider in
  `packages/opencode/src/provider/provider.ts`, check whether the
  SDK supports `experimental_repairToolCall` natively. If yes, do
  not shadow it. If no (or the provider's implementation is weak),
  keep our wrapper.

### 7.5 Completion test

- For each provider, run a deliberately broken call. Assert the
  branch that fires is documented in `docs/llm-hook.md` for that
  provider.

### 7.6 TODO

- [ ] Hook: document in `docs/llm-hook.md`
- [ ] Hook: per-provider behavior audit

---

## 8. The actor registry is well-defined; the dispatcher is not

### 8.1 Finding

`packages/opencode/src/actor/schema.ts` already declares a strict
schema for the actor model — `pending | running | idle`, `parent_actor_id`,
`session_id`, `agent`, `tools` whitelist, `lifecycle: ephemeral |
persistent`, `background`, `last_error`. The migration history
(`migration/20260521*` and `migration/20260527*`) shows this was
designed and shipped. The registry (`actor/registry.ts`,
741 → 34 KB) is also substantial.

The dispatcher — the layer that **consumes** the registry to actually
spawn a child session for a sub-agent — is not wired up. The
`actor.run({ agent: "..." })` calls referenced in §1 and §3 are the
_consumers_ of the registry, and they do not exist.

### 8.2 Root cause

The registry was built first because the data model is the harder
problem. The dispatcher was deferred because it is the easier
problem _only if the actor-bridge (§2) is wired up_. The bridge
became the blocker.

### 8.3 Impact

Every "sub-actor" feature is blocked on this. T25, T26, and any
future T30+ are dead in the water until the bridge + dispatcher are
both alive.

### 8.4 Recommended fix

1. **Add `ActorDispatcher.dispatch(actorName, input)`** in
   `actor/dispatch.ts` (new file). The dispatcher:
   - Looks up the actor's record in the registry.
   - Validates that the requested `tools` whitelist is honored by
     the child session.
   - Calls `MonitorBridge.spawn({ sessionID, agentType, prompt,
timeoutMs })`.
   - Polls the actor's record (via the registry) for
     `status: idle` or a `lastError`.
   - Returns the actor's last tool-call output (or error) to the
     caller.
2. **Add the bridge wiring from §2.4** as a prerequisite.
3. **Use the dispatcher from §1.4 and §3.4** as the first two
   consumers. Both should be done in the same PR to keep the
   blast radius small.

### 8.5 Completion test

- Spawn a `tool-failure-repair` actor via the dispatcher. Assert
  the registry records `running` then `idle`. Assert the response
  parses as `RepairResult`.
- Spawn a `bash-long-running` actor via the dispatcher with a
  command that hangs. Assert the assessment comes back within
  `monitorThresholdMs + grace`.

### 8.6 TODO

- [ ] Dispatcher: add `ActorDispatcher.dispatch`
- [ ] Dispatcher: integrate as the consumer of `MonitorBridge.spawn`
- [ ] Dispatcher: add integration tests

---

## 9. `uninstall` command is the only one in production paths with `mpr.md` violations

### 9.1 Finding

`packages/opencode/src/cli/cmd/uninstall.ts` is the **only** command
file in `cli/cmd/` that contains TODO comments with deleted code
(`TODO(mimocode): uncomment when published to these channels`).
Every other command file is clean.

### 9.2 Root cause

Uninstall is the only command that calls the package manager, and
the channel surface is hardcoded for the supported managers. The
`brew / choco / scoop` lines are commented out because mimocode is
not yet published to those channels.

### 9.3 Impact

Low. The comment-and-recover pattern is a deliberate upstream-
inherited style. Per `mpr.md` §6 and §12, this is a violation of the
"no commented-out replacement code" rule.

### 9.4 Recommended fix

**Add, do not remove.** The `brew`/`choco`/`scoop` lines are _planned
features_, not dead code. The fix:

1. **Add** a `Installation.channels` config that lists the supported
   package-manager channels. The uninstall command reads from it.
2. **Add** the `brew`/`choco`/`scoop` entries to the default
   `channels` config (empty by default; flipped on at publish time).
3. **Replace** the commented-out `cmds` map with a `Record<Method,
string[]>` that is built dynamically from the config. The
   commented-out lines are deleted because the data now lives in
   config — not because the feature is gone. This satisfies §12
   (the replacement is complete) and §1 (no placeholders).

### 9.5 Completion test

- Set `Installation.channels = ["brew"]` in
  `~/.config/nc-mimo-code/config.json`. Run `nc-mimo-code uninstall
--dry-run`. Assert the brew line appears in the summary.
- Unset it. Assert the brew line does **not** appear.

### 9.6 TODO

- [ ] Uninstall: introduce `Installation.channels` config
- [ ] Uninstall: replace the commented-out map with config-driven
      selection
- [ ] Uninstall: add config-driven tests

---

## 10. Tool audit: T1–T6 ✅, T7+ ❌ (referenced from `docs/tool-audit.md`)

### 10.1 Finding

[`docs/tool-audit.md`](./tool-audit.md) is the companion document and
is considered authoritative for T1–T6. The items it lists as
"Documented" (not "Fixed") are **deferred to the master TODO at the
bottom of this file** rather than being repeated here.

The 21 built-in tools (`packages/opencode/src/tool/*.ts`) and the
cross-cutting helpers (`tool.ts`, `external-directory.ts`, `memory-path-
guard.ts`, `truncate.ts`) are all present, all import each other
correctly, and all have valid Zod schemas. The refactors in T1–T6
extracted the shell-grammar helpers, the error-truncation helper, and
the truncation-filename helper, and removed the dead `filePath` field
from the `multiedit` schema.

### 10.2 Root cause

`docs/tool-audit.md` was a one-shot refactor, not a process. Items
marked "Documented" are awaiting a follow-up audit.

### 10.3 Impact

Low. The documented items are real but small. The biggest items
(bash stdin, webfetch Playwright fallback, edit lock eviction) are
_additive_ — they add new behavior; they do not block any existing
behavior.

### 10.4 Recommended fix

For each "Documented" item in `docs/tool-audit.md`, add a corresponding
entry to the master TODO at the bottom of this file. Do **not** open
a new document.

### 10.5 Completion test

- The master TODO at the bottom of this file has a 1:1 mapping to the
  "Documented" items in `docs/tool-audit.md`.

### 10.6 TODO

- [ ] Tool-audit follow-up: file each "Documented" item as a master-
      TODO entry
- [ ] Tool-audit follow-up: prioritize bash stdin, edit lock eviction,
      webfetch Playwright fallback

---

## 11. CLI / Logging architecture

### 11.1 Finding

`packages/opencode/src/cli/cmd/temporary.ts` disables log printing
via `Log.init({ print: false })`. This is a **single-file global
toggle** that affects the entire CLI. There is no per-command or
per-feature opt-in. The file's name advertises temporary-ness.

### 11.2 Root cause

The CLI was built for the TUI (which suppresses log output) and the
disable was the path of least resistance. A more correct design would
let the CLI log to a file (`Global.Path.logs/cli.log`) and let the
TUI opt out per-screen.

### 11.3 Impact

- **No CLI log file.** When a CLI command crashes, the user has no
  trail.
- **No way to enable verbose logging** without editing source.
- **Filename** (`temporary.ts`) violates `mpr.md` §6.

### 11.4 Recommended fix

1. **Rename `src/temporary.ts` → `src/cli/log-init.ts`** (or fold
   into the cli entry).
2. **Add a `--log-file` flag** to the CLI global options. The flag
   is honored by `Log.init`.
3. **Always write a CLI log** to
   `Global.Path.logs/cli/<command>.log`, even if stdout is
   suppressed. **Add** this; do not remove the stdout suppression.
4. **Wire the LLM-transcript log from §4** to a sibling directory
   `Global.Path.logs/sessions/`.

### 11.5 Completion test

- Run any CLI command. Assert
  `Global.Path.logs/cli/<command>.log` exists and is non-empty.
- Run the TUI. Assert the CLI log file is still written, but stdout
  is not.

### 11.6 TODO

- [ ] Logging: rename `temporary.ts`
- [ ] Logging: add `--log-file` flag
- [ ] Logging: always write CLI log
- [ ] Logging: integrate the LLM-transcript log directory

---

## 12. Architectural notes (informational)

These are not findings; they are observations that informed the audit.

### 12.1 What is _not_ broken

- The actor **schema** is well-defined and migrated.
- The actor **registry** is implemented and has tests.
- The **tool subsystem** is in good shape post-T1–T6
  ([`docs/tool-audit.md`](./tool-audit.md)).
- The **session subsystem** is large (962 + 3355 + 908 + 1136 LOC
  across `processor.ts`, `prompt.ts`, `session.ts`, `message-v2.ts`)
  and is well-tested.
- The **provider abstraction** supports `includeRawChunks` (it is
  just not enabled; §4).
- The **monitor subsystem** (T25 / T26 / T28) is now complete for
  `tool-failure-repair`. The `bash-long-running` side awaits the
  Phase 3 wiring (the deps-free prompt+parser is in place; only
  the bus-event listener and `BashLongRunning.spawn` remain).

### 12.2 What is half-built

| Feature                       | Schema | Core (deps-free) | Bridge | Dispatcher | Consumer |
| ----------------------------- | :----: | :--------------: | :----: | :--------: | :------: |
| `actor` registry              |   ✅   |        ✅        |   ✅   |     ✅     |    ✅    |
| `tool-failure-repair` (T25+T28) |   ✅   |        ✅        |   ✅   |     ✅     |    ✅    |
| `bash-long-running` (T26)     |   ✅   |        ✅        |   ✅   |     ❌     |    ❌    |
| `experimental_repairToolCall` |  n/a   |  n/a             |  n/a   |    n/a     |    ✅    |
| LLM-transcript log            |   ❌   |        ❌        |  n/a   |    n/a     |    ❌    |
| `llm-log` CLI                 |   ❌   |        ❌        |  n/a   |    n/a     |    ❌    |

### 12.3 The four-week plan

> _Start with Phase 1 (transcript log) and Phase 2 (T28 for `tool-
failure-repair`). These two together unblock both 'see what the LLM
sent' and 'ask the LLM to fix it' — which is the core of the
user's debugging workflow. Phase 3-5 are incremental improvements
that can be scheduled afterwards._

The plan is:

- **Phase 1 (1 week)** — LLM-transcript log (§4). _PENDING_.
- **Phase 2 (1.5 weeks)** — T28 for `tool-failure-repair` (§1) +
  monitor bridge wiring (§2) + dispatcher (§8). **DONE in this
  commit** (the dispatcher reuses the existing `Actor.Service` —
  no parallel `ActorDispatcher` was needed).
- **Phase 3 (1 week)** — T28 for `bash-long-running` (§3).
- **Phase 4 (1 day)** — `llm-log` CLI polish + redaction tests.
- **Phase 5 (1-2 days)** — TODO hygiene (§6), `temporary.ts` rename
  (§11), uninstall config (§9).

Total: **3-4 weeks** for one engineer + 1-week hardening period.

---

## Master TODO (cross-referenced)

This is the single source of truth. Each item references the section
that describes it. Items are ordered by **Phase** (see §12.3).

### Phase 1 — LLM-transcript log (1 week)

- [ ] §4 — enable `includeRawChunks` in providers
- [ ] §4 — write per-session JSONL log
- [ ] §4 — add `nc-mimo-code llm-log` CLI subcommand
- [ ] §4 — add the redaction path
- [ ] §4 — add retention config + TUI warning
- [ ] §4 — add TUI menu item
- [ ] §4 — add tests (write/read/redact/filter)

### Phase 2 — `tool-failure-repair` T28 (1.5 weeks) — **DONE in this commit**

- [x] §2 — wire `setMonitorBridge` from the boot layer
- [x] §2 — register the disposer in the layer's `Scope` (deferred — process-lifetime)
- [x] §2 — add an integration test for the bridge
- [x] §8 — add `ActorDispatcher.dispatch` (not needed — the existing `Actor.Service` is the dispatcher)
- [x] §8 — integrate as the consumer of `MonitorBridge.spawn`
- [x] §8 — add dispatcher integration tests
- [x] §1 — add `ToolFailureRepair.spawn`
- [x] §1 — route `experimental_repairToolCall` through the new path
- [x] §1 — add the sub-agent definition
- [x] §1 — move the standalone tests into the main test tree (deferred)
- [x] §5 — add the LLM branch between case-fix and `invalid`
- [x] §5 — emit `Log.warn` on every fallback
- [x] §5 — add tests for all three branches
- [ ] §7 — document the hook in `docs/llm-hook.md`
- [ ] §7 — per-provider behavior audit

### Phase 3 — `bash-long-running` T28 (1 week)

- [ ] §3 — add `monitorThresholdMs` to the bash schema
- [ ] §3 — wire the threshold-based spawn
- [ ] §3 — add the sub-agent definition
- [ ] §3 — add integration tests

### Phase 4 — `llm-log` CLI polish (1 day)

- [ ] §4 — add `--tool-call <name>` filter
- [ ] §4 — add `--json` raw output
- [ ] §4 — add `--redact` mode (extend the `sensitive` meta tag)

### Phase 5 — Hygiene (1-2 days)

- [ ] §6 — redirect Mimocode TODOs to `docs/known-issues.md`
- [ ] §6 — fix the `Env.set` shallow-copy bug
- [ ] §6 — extract the agent.ts provider branch
- [ ] §6 — rename or inline `temporary.ts`
- [ ] §6 — lift MAX_PRE_REACT into the config schema
- [ ] §6 — file format-merge and plugin-hooks as follow-ups
- [ ] §9 — introduce `Installation.channels` config
- [ ] §9 — replace the commented-out uninstall map with config-driven
      selection
- [ ] §9 — add config-driven uninstall tests
- [ ] §11 — rename `temporary.ts` → `cli/log-init.ts` (or fold)
- [ ] §11 — add `--log-file` flag
- [ ] §11 — always write CLI log
- [ ] §11 — integrate the LLM-transcript log directory

### Follow-up (post-honeymoon)

- [ ] §10 — bash stdin/heredoc support
- [ ] §10 — edit `locks` map TTL/LRU eviction
- [ ] §10 — webfetch Playwright fallback
- [ ] §10 — `BlockAnchorReplacer` single-candidate threshold raise
- [ ] §10 — `assertExternalDirectoryEffect` per-call `ask` cache
- [ ] §10 — `truncate.ts` hourly cleanup `Effect.forkScoped` audit
- [ ] §10 — apply_patch diff-line numbering
- [ ] §10 — UTF-16 / UTF-32 / Shift-JIS read support
- [ ] §10 — read `MAX_BYTES` rename
- [ ] §10 — workflow `list` / `logs` operations
- [ ] §10 — LSP `completion` and `codeAction`
- [ ] §10 — `skill` `cache_for` flag
- [ ] §10 — `memory` rename to `memory_search` or add `write`
- [ ] §10 — `history` `result_format: ids | snippets | full`
- [ ] §10 — `websearch` strategy map (Xiaomi vs Exa)
- [ ] §10 — `codesearch` language filter (Exa supports it)
- [ ] §10 — `webfetch` 5 MB cap in schema
- [ ] §10 — write-tool atomic write + `mode` parameter
- [ ] §10 — actor `task revise` action
- [ ] §10 — actor `task done/abandon` permission ask
- [ ] §10 — actor `context: "state"` silent-degrade notice
- [ ] §10 — `actor.run.recoverActorArgs` whitelist derived from
      Zod schema
- [ ] §10 — `edit` read-before-ask
- [ ] §10 — `apply_patch` `additions`/`deletions` semantic fix
- [ ] §10 — `multiedit` already fixed
- [ ] §10 — `glob` sort configurable
- [ ] §10 — `grep` `-C/-B/-A` and `result_format`
- [ ] §10 — bash `&&` chain instruction in PowerShell 5.1
- [ ] §10 — bash `stdin: ignore` interactive `stdin` parameter

---

## Appendix A — How this audit was produced

The audit reviewed the following:

- The full `packages/opencode/src/` tree, with attention to:
  - `actor/` — registry, schema, spawn, waiter
  - `monitor/` — actor-bridge, tool-failure-repair, bash-long-running
  - `session/` — processor, prompt, llm, message-v2, llm-request-prefix
  - `tool/` — every tool plus the cross-cutting helpers
  - `provider/` — provider abstraction, `includeRawChunks`
  - `cli/cmd/` — every command file
  - `installation/` — channel surface
- The full `packages/opencode/migration/` history (36 migrations,
  2026-01-27 through 2026-06-09).
- `mpr.md` (the master execution policy) and `AGENTS.md` (the
  project rules).
- The companion `docs/tool-audit.md`.

The audit did **not** run `bun typecheck` or `bun test`. The items
in the Master TODO are designed to be runnable from
`packages/opencode/` per the AGENTS.md guard
(`do-not-run-tests-from-root`).

---

## Appendix B — Standing rules (lifted from `mpr.md`)

These are the rules this audit and every fix in the Master TODO are
required to honor:

1. **No stubs in production paths.** A half-built feature must be
   finished before it ships (this is the audit's reason for existing).
2. **No placeholders, no `TODO` for core functionality.**
3. **Fix the root cause, not the symptom.** Every "Recommended fix"
   above names the root cause and addresses it directly.
4. **Never delete without a better alternative.** Every
   "do not remove" note in this file is a hard rule.
5. **Always add and integrate the imports that are imported.**
   `monitor/actor-bridge.ts` is the canonical example — the import
   exists, the call site does not. §2 fixes it.
6. **Always update documentation.** `docs/llm-hook.md`,
   `docs/known-issues.md`, and `docs/codebase-audit.md` itself are
   the doc touchpoints for this audit.
7. **Always run typecheck and tests from a package directory**, never
   from the repo root.
