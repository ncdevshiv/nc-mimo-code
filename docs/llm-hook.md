# LLM hook: tool-call repair

The Mimocode project uses the Vercel AI SDK's
`experimental_repairToolCall` hook to give the LLM a structured
recovery path when it produces a tool call that fails Zod
validation. Without the hook, a broken tool call is silently
discarded (the message is logged, the conversation continues,
the LLM has no signal that the call failed). With the hook,
the broken call is sent to a sub-agent that returns a corrected
JSON object, and the conversation continues from the repaired
call.

This document pins the **three-branch dispatch flow** so a
provider port (or a future maintainer touching the
tool-failure-repair path) knows which branch fires for which
class of broken call.

## The three branches

```
        ┌──────────────────────────────────────────────┐
        │   experimental_repairToolCall(req, options)  │
        │   (provider SDK calls this on Zod failure)    │
        └──────────────────┬───────────────────────────┘
                           │
                           ▼
              ┌────────────────────────┐
              │  is the tool known?    │───── no ───▶  branch 3: return
              │  (registry.has(tool))  │               undefined (SDK
              └────────────┬───────────┘               logs and moves on)
                           │ yes
                           ▼
              ┌────────────────────────┐
              │  is monitor.tool-      │───── no ───▶  branch 2: return
              │  failure-repair        │               the SDK's
              │  enabled?              │               experimental_repairToolCall
              └────────────┬───────────┘               (provider-native)
                           │ yes
                           ▼
              ┌────────────────────────┐
              │  branch 1: spawn the   │
              │  tool-failure-repair   │
              │  sub-agent and wait    │
              │  for the parsed JSON   │
              │  return value          │
              └────────────────────────┘
```

### Branch 1 — Mimocode's `tool-failure-repair` sub-agent

Used when the **tool is registered** AND **`monitor.tool-failure-repair` is enabled**. The dispatcher in `effect/app-runtime.ts` spawns the `tool-failure-repair` sub-agent (see `agent/agent.ts:371` for the agent definition) with:

- `toolName` — the name of the broken call (`"edit"`, `"bash"`, …).
- `toolInput` — the broken JSON.
- `error` — the Zod issues stringified.
- `schema` — the tool's Zod schema, JSON-stringified.

The sub-agent has `toolAllowlist: ["read", "write", "edit", "glob", "grep", "memory", "bash"]` and is `hidden` (not offered to the main agent). It must return JSON text only — no recursive tool calls (which would re-enter the LLM and risk a feedback loop).

The dispatcher in `monitor/actor-bridge.ts` (`MonitorBridge.spawn`) returns a `MonitorSpawnResult` synchronously after the configured `timeoutMs` (default 30s) so the LLM hook sees the parsed JSON in one round trip — no `await new Promise` dance.

### Branch 2 — Provider SDK's native repair

Used when the **tool is registered** but the **monitor is disabled** (or the user has set `monitor.tool-failure-repair: false`). In that case we delegate to `options.experimental_repairToolCall` — the provider SDK's own repair, if any. This is the per-provider behavior:

| Provider | Native repair? | Notes |
| --- | --- | --- |
| Anthropic | yes | The SDK uses Anthropic's structured-output retry. Our wrapper is **skipped** in this branch. |
| OpenAI | yes | The SDK uses OpenAI's tool-call refinement. Our wrapper is **skipped** in this branch. |
| Xiaomi (Mimocode internal) | no | The Xiaomi SDK does not implement `experimental_repairToolCall` — our wrapper is the only path. |
| Other | unknown | Per `codebase-audit.md` §7.4 — the audit's recommendation is to verify per-provider. |

### Branch 3 — `undefined` (silent drop)

Used when the **tool is NOT in the registry**. We return `undefined` (the SDK convention) and the broken call is logged and the conversation continues without a retry. This is the same behavior the AI SDK has with no hook installed; it's the right answer for "the LLM invented a tool name" because no sub-agent could fix that.

## Files involved

- `packages/opencode/src/effect/app-runtime.ts:192` — the `experimental_repairToolCall` hook (the dispatch logic).
- `packages/opencode/src/monitor/actor-bridge.ts:9` — the bridge that synchronously returns the sub-agent outcome.
- `packages/opencode/src/monitor/service.ts:17` — the `ToolFailureRepair.spawn` implementation.
- `packages/opencode/src/agent/agent.ts:371` — the `tool-failure-repair` agent definition.
- `packages/opencode/src/provider/provider.ts` — where the per-provider `experimental_repairToolCall` is wrapped / bypassed (per `codebase-audit.md` §7.4).

## Completion test (per `codebase-audit.md` §7.5)

For each provider in `provider/provider.ts`, run a deliberately
broken tool call (a string where the schema wants a number, a
missing required field, a value outside an `enum`). Assert the
branch that fires:

- **Anthropic** with monitor enabled → branch 1.
- **Anthropic** with monitor disabled → branch 2 (SDK path).
- **OpenAI** with monitor enabled → branch 1.
- **Xiaomi** with monitor enabled → branch 1 (no native path).
- **Any** with a tool name not in the registry → branch 3 (silent drop).

This document is the **single source of truth** for the
three-branch contract. If a future maintainer changes the
dispatch logic in `app-runtime.ts`, update this file in the
same PR.
