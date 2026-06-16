import path from "path"
import { Provider } from "@/provider"
import { Log } from "@/util"
import { TranscriptLog } from "@/monitor/llm-transcript"
import { Context, Duration, Effect, Layer, Record, Schedule, Ref } from "effect"
import * as Stream from "effect/Stream"
import { streamText, wrapLanguageModel, type ModelMessage, type Tool, tool, jsonSchema } from "ai"
import { mergeDeep, pipe } from "remeda"
import { z } from "zod"
import { ToolFailureRepair } from "@/monitor/tool-failure-repair"
import { getMonitorBridge } from "@/monitor/actor-bridge"
import { GitLabWorkflowLanguageModel } from "gitlab-ai-provider"
import { ProviderTransform } from "@/provider"
import { Config } from "@/config"
import { Instance } from "@/project/instance"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "./message-v2"
import { Plugin } from "@/plugin"
import { SystemPrompt } from "./system"
import { Flag } from "@/flag/flag"
import { Permission } from "@/permission"
import { PermissionID } from "@/permission/schema"
import { Bus } from "@/bus"
import { Wildcard } from "@/util"
import { SessionID } from "@/session/schema"
import * as Session from "@/session/session"
import { migrateProjectMemory } from "./checkpoint-paths"
import { ProjectID } from "@/project/schema"
import { Auth } from "@/auth"
import { Installation } from "@/installation"
import { InstallationVersion } from "@/installation/version"
import { EffectBridge } from "@/effect"
import { Global } from "@/global"
import * as Option from "effect/Option"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { ActorRegistry } from "@/actor/registry"
import { Memory } from "@/memory"
import { isRetryableTransientError } from "./retry"

const log = Log.create({ service: "llm" })
export const OUTPUT_TOKEN_MAX = ProviderTransform.OUTPUT_TOKEN_MAX
type Result = Awaited<ReturnType<typeof streamText>>

/**
 * Match transient errors that the PERSISTENT_RETRY layer should retry.
 *
 * - HTTP 429 / 5xx / 529 — capacity / overload responses
 * - ECONNRESET / EPIPE / ETIMEDOUT — network errors typically caused by
 *   stale keep-alive sockets or upstream proxy timeouts
 * - "SSE read timed out" — `provider.ts:wrapSSE` chunk-timeout fired
 *   (configured per-provider via `chunkTimeout` in nc-mimo-code.json). This
 *   is HTTP-byte-level: keep-alive comments still count as activity, so
 *   the error only fires when the underlying TCP stream is genuinely dead.
 *
 * Auth errors (401/403), client errors (400, 404, 422), and user-
 * initiated aborts are NOT retryable.
 *
 * @deprecated Use `isRetryableTransientError` from `./retry` directly.
 * Kept as a 1-line wrapper to preserve the existing export name.
 */
export function isTransientCapacityError(error: unknown): boolean {
  return isRetryableTransientError(error)
}

/**
 * Persistent-retry schedule with exponential backoff.
 *
 * Exponential backoff 500ms × 2 (i.e. 0.5, 1, 2, 4, 8, 16, 32, 64, 128, 256s),
 * each individual delay capped at 5 minutes, total attempts capped at 10.
 *
 * Worst-case total = 11 attempts × chunkTimeout + cumulative backoff
 *                  ≈ 11 × 8min + 9min ≈ 97 min (with DEFAULT_CHUNK_TIMEOUT = 8min).
 *
 * Intentionally NOT capped via Schedule.upTo() — retry persistence under
 * brief upstream outages is the design goal. Bounding per-attempt latency
 * via chunkTimeout is the primary lever for hang-time control.
 */
export const persistentRetrySchedule = Schedule.exponential("500 millis", 2).pipe(
  Schedule.modifyDelay((_, delay) =>
    Effect.succeed(Duration.isLessThanOrEqualTo(delay, Duration.minutes(5)) ? delay : Duration.minutes(5)),
  ),
  Schedule.both(Schedule.recurs(10)),
)

/**
 * Memory-system instructions appended to the main agent's system prompt.
 *
 * Teaches the agent its v8.1 ownership of the memory system:
 * - MEMORY.md (project-scoped): writer is sole curator + agent edits for
 *   project-level user-stated rules
 * - checkpoint.md (session-scoped): writer EXCLUSIVE; agent never edits
 * - tasks/<id>/progress.md: writer-derived splitover from session-level
 *   progress.md; not LLM-written. Subagents handed a task may read but
 *   should not write.
 *
 * Also documents the Active recall protocol that prevents re-Reading
 * files already present in the rebuild dump, and the Subagent return
 * format contract.
 *
 * `memoryRoot` is the same absolute root returned by Memory.root(), so these
 * paths match the files used by checkpoint restore and memory/task detection.
 */
function buildMemoryInstructions(sessionID: SessionID, projectID: ProjectID, memoryRoot: string): string {
  const memoryFile = path.join(memoryRoot, "projects", projectID, "MEMORY.md")
  const checkpointFile = path.join(memoryRoot, "sessions", sessionID, "checkpoint.md")
  const sessionMemoryDir = path.join(memoryRoot, "sessions", sessionID)
  const globalMemoryFile = path.join(memoryRoot, "global", "MEMORY.md")
  return `# Memory system

You have a persistent file-based memory system. Four file types:

- Project memory at \`${memoryFile}\` — persistent across all sessions in this project. Contains: project context, rules, architecture decisions, durable cross-task knowledge.
- Session checkpoint at \`${checkpointFile}\` — current session's structured state, written ONLY by the checkpoint-writer subagent. 11 sections covering active intent, next action, directives, task tree, current work, files, learnings, errors, live resources, design decisions, and open notes. Task content lives inside §4 Task tree and §5 Current work.
- Per-task progress at \`${path.join(sessionMemoryDir, "tasks", "<id>", "progress.md")}\` — writer-derived splitover from session-level progress.md (not LLM-written). When you spawn a subagent on a task, the subagent may be handed this path for reading; you do not maintain it.
- Global memory at \`${globalMemoryFile}\` — user-level preferences and cross-project feedback that persist across all projects. Auto-injected into rebuild context under the "## Global memory" header when present.

The checkpoint writer is the sole curator of the structured files. You don't maintain them mid-task — the writer extracts everything from the conversation at checkpoint events.

## When to Edit MEMORY.md directly

You may Edit MEMORY.md when:
- User states a project-level rule that should hold across sessions → ## Rules
- User states a project-level architectural decision → ## Architecture decisions
- A clearly durable cross-session fact emerges that you want available immediately, before the next checkpoint → ## Discovered durable knowledge

These are exceptions, not the norm. The writer covers most extraction at checkpoint time.

## Notes scratchpad

You have a single legal scratchpad at \`${path.join(sessionMemoryDir, "notes.md")}\`. Append entries to it when you want to record:

- A quote (from the user, an article, a known engineer) that has lasting value but isn't a task-specific decision
- An unresolved question — something you noticed but won't answer this turn
- A cross-project observation — "we did this in project X, similar pattern here"
- A note for future-self — context that would matter weeks later but doesn't fit any current task

Format each entry as:
  ## [turn N · YYYY-MM-DDTHH:MM:SSZ]
  Free-form body. The writer reorganizes structured content at checkpoint time.

This is your ONLY legal scratchpad — don't create \`learning.md\`, \`scratch.md\`, or any other ad-hoc memory file.

## Subagent return format

When you (as a subagent) finish your task, your final assistant message will be delivered to the spawning agent. If the spawn machinery added a "Return format (required)" section to your prompt, follow it exactly:

  **Status**: success | partial | failed | blocked
  **Summary**: <one-line description>

  <deliverable body>

  **Files touched**: <comma-separated paths or "(none)">
  **Findings worth promoting**: <bullet list, or "(none)">

If your spawn prompt didn't include this format (e.g., explore/title/summary agents have their own contracts), follow whatever your prompt specifies.

## What NOT to do

- Don't Edit checkpoint.md — that's the writer's domain.
- Don't create memory files other than notes.md (no learning.md, no scratch.md). Use notes.md for any free-form entry.
- Don't ask the user about something memory may already record — search first via Grep / Read.

## Active recall protocol

After a checkpoint rebuild, the following dumps may be already in your context (look for the "Summary of previous conversation from checkpoint files:" header followed by these dumps):

- checkpoint.md (full or budget-truncated)
- MEMORY.md (full or budget-truncated)
- notes.md (full or budget-truncated)
- global/MEMORY.md (full or budget-truncated)

If these dumps are visible in your context:

- Do NOT Read them again as whole files. The bytes are already in front of you.
- For specific past details (a particular turn's content, a specific tool output, an old command), use Grep with a keyword pattern to target the exact item — do not pull a whole file.
- For files NOT in the rebuild dump (per-task splitover progress.md files for tasks you don't actively need, spillover files, older session checkpoints in other sessions), Read on demand.

If a dump shows "⚠️ Truncated at ~N tokens. Read(<path>, offset=L) for the rest." — that file was budget-cut. Use Read with the offset only when you need the missing tail.

Memory entries name functions, files, flags, paths — those are CLAIMS about a point in time when they were written. Verify before acting on a specific name.

Don't ask the user about something memory may already record.
`
}

export type StreamInput = {
  user: MessageV2.User
  sessionID: string
  parentSessionID?: string
  model: Provider.Model
  agent: Agent.Info
  permission?: Permission.Ruleset
  system: string[]
  prebuiltSystem?: string[]      // when set, skip buildSystemArray and use this verbatim
  messages: ModelMessage[]
  small?: boolean
  tools: Record<string, Tool>
  retries?: number
  toolChoice?: "auto" | "required" | "none"
  agentID?: string
}

export type StreamRequest = StreamInput & {
  abort: AbortSignal
}

export type Event = Result["fullStream"] extends AsyncIterable<infer T> ? T : never

export interface Interface {
  readonly stream: (input: StreamInput) => Stream.Stream<Event, unknown>
  readonly buildSystemArray: (input: {
    agent: Agent.Info
    model: Provider.Model
    system: string[]
    user: MessageV2.User
    sessionID: string
    agentID?: string
  }) => Effect.Effect<string[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LLM") {}

const live: Layer.Layer<
  Service,
  never,
  Auth.Service | Config.Service | Provider.Service | Plugin.Service | Permission.Service | ActorRegistry.Service | Memory.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const plugin = yield* Plugin.Service
    const perm = yield* Permission.Service
    const actorReg = yield* ActorRegistry.Service
    const memory = yield* Memory.Service

    const buildSystemArray = Effect.fn("LLM.buildSystemArray")(function* (input: {
      agent: Agent.Info
      model: Provider.Model
      system: string[]
      user: MessageV2.User
      sessionID: string
      agentID?: string
    }) {
      const system: string[] = []
      system.push(
        [
          // use agent prompt otherwise provider prompt
          ...(input.agent.prompt ? [input.agent.prompt] : SystemPrompt.provider(input.model)),
          // any custom prompt passed into this call
          ...input.system,
          // any custom prompt from last user message
          ...(input.user.system ? [input.user.system] : []),
        ]
          .filter((x) => x)
          .join("\n"),
      )

      // v5: memory-instructions section. Teaches the main agent how/where/when
      // to maintain `MEMORY.md` and `checkpoint.md` directly via Edit. Project
      // ID is resolved from the ALS-bound Instance with a safe fallback to
      // `ProjectID.global` (mirrors the pattern in session/checkpoint.ts so the
      // path the prompt advertises matches the path the writer actually writes).
      // Skip for system-spawned actors (e.g. checkpoint-writer): they shouldn't
      // see the user-facing memory instructions.
      const isSystemActor = input.agentID
        ? yield* actorReg.isSystemSpawned(SessionID.make(input.sessionID), input.agentID)
        : false
      if (!isSystemActor) {
        const projectID =
          (yield* Effect.try({
            try: () => Instance.current?.project?.id as ProjectID | undefined,
            catch: () => undefined,
          }).pipe(Effect.orElseSucceed(() => undefined))) ?? ProjectID.global
        // Bootstrap the memory.md → MEMORY.md migration at session start so a
        // legacy lowercase file is renamed before the agent's first direct
        // Edit/Write (which would otherwise miss it on a case-sensitive FS, or
        // create an uppercase sibling and orphan the legacy content). The two
        // checkpoint-flow call sites cover the writer/rebuild paths; this covers
        // the "agent edits MEMORY.md before any checkpoint" path. Idempotent.
        yield* Effect.promise(() => migrateProjectMemory(projectID)).pipe(Effect.ignore)
        system.push(buildMemoryInstructions(SessionID.make(input.sessionID), projectID, yield* memory.root()))
      }

      const header = system[0]
      yield* plugin.trigger(
        "experimental.chat.system.transform",
        { sessionID: input.sessionID, model: input.model },
        { system },
      )
      // rejoin to maintain 2-part structure for caching if header unchanged
      if (system.length > 2 && system[0] === header) {
        const rest = system.slice(1)
        system.length = 0
        system.push(header, rest.join("\n"))
      }

      return system
    })

    const run = Effect.fn("LLM.run")(function* (input: StreamRequest) {
      const l = log
        .clone()
        .tag("providerID", input.model.providerID)
        .tag("modelID", input.model.id)
        .tag("session.id", input.sessionID)
        .tag("small", (input.small ?? false).toString())
        .tag("agent", input.agent.name)
        .tag("mode", input.agent.mode)
      l.info("stream", {
        modelID: input.model.id,
        providerID: input.model.providerID,
      })

      const [language, cfg, item, info] = yield* Effect.all(
        [
          provider.getLanguage(input.model),
          config.get(),
          provider.getProvider(input.model.providerID),
          auth.get(input.model.providerID),
        ],
        { concurrency: "unbounded" },
      )

      // OpenAI-oauth auth method: system messages are dropped from
      // the message list and the policy text is passed via
      // `providerOptions.instructions` instead (mirrored in
      // agent/agent.ts:544). Tracked for a future refactor that
      // pushes the per-provider oauth branch into
      // ProviderTransform.providerOptions (see audit doc §6.4.3).
      const isOpenaiOauth = item.id === "openai" && info?.type === "oauth"

      const system =
        input.prebuiltSystem ??
        (yield* buildSystemArray({
          agent: input.agent,
          model: input.model,
          system: input.system,
          user: input.user,
          sessionID: input.sessionID,
          agentID: input.agentID,
        }))

      const variant =
        !input.small && input.model.variants && input.user.model.variant
          ? input.model.variants[input.user.model.variant]
          : {}
      const base = input.small
        ? ProviderTransform.smallOptions(input.model)
        : ProviderTransform.options({
            model: input.model,
            sessionID: input.sessionID,
            providerOptions: item.options,
          })
      const options: Record<string, any> = pipe(
        base,
        mergeDeep(input.model.options),
        mergeDeep(input.agent.options),
        mergeDeep(variant),
      )
      if (isOpenaiOauth) {
        options.instructions = system.join("\n")
      }

      const isWorkflow = language instanceof GitLabWorkflowLanguageModel
      const messages = isOpenaiOauth
        ? input.messages
        : isWorkflow
          ? input.messages
          : [
              ...system.map(
                (x): ModelMessage => ({
                  role: "system",
                  content: x,
                }),
              ),
              ...input.messages,
            ]

      const params = yield* plugin.trigger(
        "chat.params",
        {
          sessionID: input.sessionID,
          agent: input.agent.name,
          model: input.model,
          provider: item,
          message: input.user,
        },
        {
          temperature: input.model.capabilities.temperature
            ? (input.agent.temperature ?? ProviderTransform.temperature(input.model))
            : undefined,
          topP: input.agent.topP ?? ProviderTransform.topP(input.model),
          topK: ProviderTransform.topK(input.model),
          maxOutputTokens: ProviderTransform.maxOutputTokens(input.model),
          options,
        },
      )

      const { headers } = yield* plugin.trigger(
        "chat.headers",
        {
          sessionID: input.sessionID,
          agent: input.agent.name,
          model: input.model,
          provider: item,
          message: input.user,
        },
        {
          headers: {},
        },
      )

      const tools = resolveTools(input)

      // LiteLLM and some Anthropic proxies require the tools parameter to be present
      // when message history contains tool calls, even if no tools are being used.
      // Add a dummy tool that is never called to satisfy this validation.
      // This is enabled for:
      // 1. Providers with "litellm" in their ID or API ID (auto-detected)
      // 2. Providers with explicit "litellmProxy: true" option (opt-in for custom gateways)
      const isLiteLLMProxy =
        item.options?.["litellmProxy"] === true ||
        input.model.providerID.toLowerCase().includes("litellm") ||
        input.model.api.id.toLowerCase().includes("litellm")

      // LiteLLM/Bedrock rejects requests where the message history contains tool
      // calls but no tools param is present. When there are no active tools (e.g.
      // during compaction), inject a stub tool to satisfy the validation requirement.
      // The stub description explicitly tells the model not to call it.
      if (
        (isLiteLLMProxy || input.model.providerID.includes("github-copilot")) &&
        Object.keys(tools).length === 0 &&
        hasToolCalls(input.messages)
      ) {
        tools["_noop"] = tool({
          description: "Do not call this tool. It exists only for API compatibility and must never be invoked.",
          inputSchema: jsonSchema({
            type: "object",
            properties: {
              reason: { type: "string", description: "Unused" },
            },
          }),
          execute: async () => ({ output: "", title: "", metadata: {} }),
        })
      }

      // Wire up toolExecutor for DWS workflow models so that tool calls
      // from the workflow service are executed via opencode's tool system
      // and results sent back over the WebSocket.
      if (language instanceof GitLabWorkflowLanguageModel) {
        const workflowModel = language as GitLabWorkflowLanguageModel & {
          sessionID?: string
          sessionPreapprovedTools?: string[]
          approvalHandler?: (approvalTools: { name: string; args: string }[]) => Promise<{ approved: boolean }>
        }
        workflowModel.sessionID = input.sessionID
        workflowModel.systemPrompt = system.join("\n")
        workflowModel.toolExecutor = async (toolName, argsJson, _requestID) => {
          const t = tools[toolName]
          if (!t || !t.execute) {
            return { result: "", error: `Unknown tool: ${toolName}` }
          }
          try {
            const result = await t.execute!(JSON.parse(argsJson), {
              toolCallId: _requestID,
              messages: input.messages,
              abortSignal: input.abort,
            })
            const output = typeof result === "string" ? result : (result?.output ?? JSON.stringify(result))
            return {
              result: output,
              metadata: typeof result === "object" ? result?.metadata : undefined,
              title: typeof result === "object" ? result?.title : undefined,
            }
          } catch (e: any) {
            return { result: "", error: e.message ?? String(e) }
          }
        }

        const ruleset = Permission.merge(input.agent.permission ?? [], input.permission ?? [])
        workflowModel.sessionPreapprovedTools = Object.keys(tools).filter((name) => {
          const match = ruleset.findLast((rule) => Wildcard.match(name, rule.permission))
          return !match || match.action !== "ask"
        })

        const bridge = yield* EffectBridge.make()
        const approvedToolsForSession = new Set<string>()
        workflowModel.approvalHandler = Instance.bind(async (approvalTools) => {
          const uniqueNames = [...new Set(approvalTools.map((t: { name: string }) => t.name))] as string[]
          // Auto-approve tools that were already approved in this session
          // (prevents infinite approval loops for server-side MCP tools)
          if (uniqueNames.every((name) => approvedToolsForSession.has(name))) {
            return { approved: true }
          }

          const id = PermissionID.ascending()
          let unsub: (() => void) | undefined
          try {
            unsub = Bus.subscribe(Permission.Event.Replied, (evt) => {
              if (evt.properties.requestID === id) void evt.properties.reply
            })
            const toolPatterns = approvalTools.map((t: { name: string; args: string }) => {
              try {
                const parsed = JSON.parse(t.args) as Record<string, unknown>
                const title = (parsed?.title ?? parsed?.name ?? "") as string
                return title ? `${t.name}: ${title}` : t.name
              } catch {
                return t.name
              }
            })
            const uniquePatterns = [...new Set(toolPatterns)] as string[]
            await bridge.promise(
              perm.ask({
                id,
                sessionID: SessionID.make(input.sessionID),
                permission: "workflow_tool_approval",
                patterns: uniquePatterns,
                metadata: { tools: approvalTools },
                always: uniquePatterns,
                ruleset: [],
              }),
            )
            for (const name of uniqueNames) approvedToolsForSession.add(name)
            workflowModel.sessionPreapprovedTools = [...(workflowModel.sessionPreapprovedTools ?? []), ...uniqueNames]
            return { approved: true }
          } catch {
            return { approved: false }
          } finally {
            unsub?.()
          }
        })
      }

      const tracer = cfg.experimental?.openTelemetry
        ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
        : undefined
      const telemetryTracer = tracer
        ? new Proxy(tracer, {
            get(target, prop, receiver) {
              if (prop !== "startSpan") return Reflect.get(target, prop, receiver)
              return (...args: Parameters<typeof target.startSpan>) => {
                const span = target.startSpan(...args)
                span.setAttribute("session.id", input.sessionID)
                return span
              }
            },
          })
        : undefined

      const streamStartTs = Date.now()
      l.debug("streamText starting", {
        messageID: input.user.id,
        msgCount: messages.length,
        toolCount: Object.keys(tools).length,
      })

    return streamText({
      onError(error) {
        l.debug("streamText error", {
          messageID: input.user.id,
          error: error instanceof Error ? error.message : String(error),
          elapsedMs: Date.now() - streamStartTs,
        })
        l.error("stream error", {
          error,
        })
      },
      async onFinish({ response, usage, providerMetadata, finishReason }) {
        // Persist the per-session LLM-transcript event (audit §4).
        // Best-effort: failures are logged, never thrown. The
        // transcript is the source of truth for "what exactly did
        // the model send"; the rendered transcript (cli/tui/...)
        // is a derived view that elides raw fields.
        //
        // The AI SDK 5 onFinish shape is `LanguageModelResponseMetadata`
        // (text, toolCalls, finishReason, usage, providerMetadata).
        // The `response` value is the raw provider response — when
        // `includeRawChunks` is enabled (currently only the copilot
        // SDK paths) this is the raw body. For the main providers
        // we store the structured `messages` + the metadata we have
        // in scope. A future pass plumbs `includeRawChunks` through
        // the central provider abstraction (audit §4.4.1 was wrong
        // about the current state).
        await TranscriptLog.append({
          ts: Date.now(),
          sessionID: input.sessionID,
          messageID: input.user.id,
          role: "assistant",
          model: { providerID: input.model.providerID, modelID: input.model.id },
          request: { messages, tools: Object.keys(tools) },
          response,
          tool_calls: undefined,
        })
        // Purge-expired hook: best-effort, runs on every assistant
        // message. 30 days by default; configurable via
        // `config.log.retentionDays`.
        const retentionDays = (cfg as { log?: { retentionDays?: number } }).log?.retentionDays ?? 30
        await TranscriptLog.purgeExpired(input.sessionID, retentionDays * 24 * 60 * 60 * 1000)
      },
        async experimental_repairToolCall(failed) {
          // Branch 1: case-fix. Cheap and deterministic — if the lowercased
          // tool name exists in our tool map, swap it. Always runs first.
          const lower = failed.toolCall.toolName.toLowerCase()
          if (lower !== failed.toolCall.toolName && tools[lower]) {
            l.info("repairing tool call (case fix)", {
              tool: failed.toolCall.toolName,
              repaired: lower,
            })
            return {
              ...failed.toolCall,
              toolName: lower,
            }
          }

          // Branch 2: LLM-driven repair via the `tool-failure-repair` sub-actor.
          // Spawns a child session that takes the tool's JSON schema, the
          // broken call, and the validation error, and returns either a
          // corrected input object or a structured `unfixable` reason.
          //
          // Skipped when the monitor bridge is not populated (test isolation
          // or partial init) — falls through to the `invalid` tool safety net.
          const bridge = getMonitorBridgeSafe()
          if (bridge) {
            try {
              const target = tools[failed.toolCall.toolName]
              const repairInput = parseFailedInput(failed.toolCall.input)
              const result = await ToolFailureRepair.spawn(
                {
                  tool: failed.toolCall.toolName,
                  input: repairInput,
                  error: failed.error.message,
                  schema: toolSchemaToJson(target?.inputSchema),
                },
                {
                  bridge,
                  sessionID: input.sessionID,
                },
              )
              if (result.kind === "repaired") {
                l.info("repairing tool call (LLM-repair)", {
                  tool: failed.toolCall.toolName,
                })
                return {
                  ...failed.toolCall,
                  // The AI SDK's `input` is a JSON-encoded string; re-encode
                  // the repaired object so the downstream parser receives
                  // the same shape as a non-repaired call.
                  input: JSON.stringify(result.input),
                }
              }
              l.warn("tool call unrepairable (LLM said unfixable)", {
                tool: failed.toolCall.toolName,
                reason: result.reason,
              })
            } catch (err) {
              l.warn("tool-failure-repair sub-actor failed", {
                tool: failed.toolCall.toolName,
                error: err instanceof Error ? err.message : String(err),
              })
            }
          }

          // Branch 3: invalid-tool fallback. The model's bad call is
          // rewritten to a single `invalid` tool with the error message
          // attached; the `invalid` tool's executor (defined elsewhere)
          // produces a model-readable error response so the LLM can
          // self-correct on its next turn.
          return {
            ...failed.toolCall,
            input: JSON.stringify({
              tool: failed.toolCall.toolName,
              error: failed.error.message,
            }),
            toolName: "invalid",
          }
        },
        temperature: params.temperature,
        topP: params.topP,
        topK: params.topK,
        providerOptions: ProviderTransform.providerOptions(input.model, params.options),
        activeTools: Object.keys(tools).filter((x) => x !== "invalid"),
        tools,
        toolChoice: input.toolChoice,
        maxOutputTokens: params.maxOutputTokens,
        abortSignal: input.abort,
        headers: {
          ...(input.model.providerID.startsWith("opencode")
            ? {
                "x-opencode-project": Instance.project.id,
                "x-opencode-session": input.sessionID,
                "x-opencode-request": input.user.id,
                "x-opencode-client": Flag.NC_MIMO_CODE_CLIENT,
              }
            : {
                "x-session-affinity": input.sessionID,
                ...(input.parentSessionID ? { "x-parent-session-id": input.parentSessionID } : {}),
                "User-Agent": `mimocode/${InstallationVersion}`,
              }),
          ...input.model.headers,
          ...headers,
        },
        // AI SDK's internal retry loop is SILENT — it emits no events and does
        // not update session status, so the TUI shows only a dead spinner while
        // it runs. Its backoff is also UNCAPPED (delay *= 2 each attempt, capped
        // only by a retry-after header), so the prior default of 10 meant up to
        // ~34 min (2+4+…+1024s) of invisible retrying before the error surfaced.
        // We keep this layer short (absorb a couple of quick blips) and let the
        // VISIBLE processor-level SessionRetry.policy own long-haul resilience —
        // it publishes `type: "retry"` so the `[retrying attempt #N]` banner
        // shows, and its per-attempt delay is capped at 30s.
        maxRetries: input.retries ?? 2,
        messages,
        model: wrapLanguageModel({
          model: language,
          middleware: [
            {
              specificationVersion: "v3" as const,
              async transformParams(args) {
                if (args.type === "stream") {
                  // @ts-expect-error
                  args.params.prompt = ProviderTransform.message(args.params.prompt, input.model, options)
                }
                return args.params
              },
            },
          ],
        }),
        experimental_telemetry: {
          isEnabled: cfg.experimental?.openTelemetry,
          functionId: "session.llm",
          tracer: telemetryTracer,
          metadata: {
            userId: cfg.username ?? "unknown",
            sessionId: input.sessionID,
          },
        },
      })
    })

    const stream: Interface["stream"] = (input) =>
      Stream.scoped(
        Stream.unwrap(
          Effect.gen(function* () {
            const ctrl = yield* Effect.acquireRelease(
              Effect.sync(() => new AbortController()),
              (ctrl) => Effect.sync(() => ctrl.abort()),
            )
            const attemptRef = yield* Ref.make(0)

            const publishRetryEvent = (error: unknown, nextAttempt: number) =>
              Effect.gen(function* () {
                log.debug("retry attempt", {
                  sessionID: input.sessionID,
                  messageID: input.user.id,
                  attempt: nextAttempt,
                  reason: error instanceof Error ? error.message : String(error),
                })
                if (nextAttempt > 10) return
                const delayMs = Math.min(500 * 2 ** (nextAttempt - 1), 300_000)
                yield* Effect.promise(() =>
                  Bus.publish(Session.Event.RetryAttempt, {
                    sessionID: SessionID.make(input.sessionID),
                    messageID: input.user.id,
                    attempt: nextAttempt,
                    maxAttempts: 10,
                    reason: error instanceof Error ? error.message : String(error),
                    nextDelayMs: delayMs,
                  })
                )
              })

            const streamWithTelemetry = run({ ...input, abort: ctrl.signal }).pipe(
              Effect.tapError((error) => {
                if (!isTransientCapacityError(error)) return Effect.void
                return Ref.updateAndGet(attemptRef, (n) => n + 1).pipe(
                  Effect.flatMap((nextAttempt) => publishRetryEvent(error, nextAttempt))
                )
              })
            )

            const result = yield* streamWithTelemetry.pipe(
              Effect.retry({
                while: isTransientCapacityError,
                schedule: persistentRetrySchedule,
              }),
            )

            return Stream.fromAsyncIterable(result.fullStream, (e) => (e instanceof Error ? e : new Error(String(e))))
          }),
        ),
      )

    return Service.of({ stream, buildSystemArray })
  }),
)

export const layer = live.pipe(Layer.provide(Permission.defaultLayer))

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Auth.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(ActorRegistry.defaultLayer),
    Layer.provide(Memory.defaultLayer),
  ),
)

function resolveTools(input: Pick<StreamInput, "tools" | "agent" | "permission" | "user">) {
  const disabled = Permission.disabled(
    Object.keys(input.tools),
    Permission.merge(input.agent.permission, input.permission ?? []),
  )
  return Record.filter(input.tools, (_, k) => input.user.tools?.[k] !== false && !disabled.has(k))
}

// Check if messages contain any tool-call content
// Used to determine if a dummy tool should be added for LiteLLM proxy compatibility
export function hasToolCalls(messages: ModelMessage[]): boolean {
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      if (part.type === "tool-call" || part.type === "tool-result") return true
    }
  }
  return false
}

/**
 * Parse the AI SDK's `toolCall.input` (always a JSON-encoded string per
 * the SDK contract) into the raw JS value the LLM actually sent. The
 * repair sub-agent needs the *original* object — not a re-stringified
 * blob — so the model can see exactly what shape it produced and pick
 * a fix that preserves intent. Falls back to the raw string when JSON
 * parsing fails (the model emitted something the SDK couldn't parse
 * either; the repair sub-agent will see the raw text and may still
 * produce a fix).
 */
function parseFailedInput(input: string): unknown {
  try {
    return JSON.parse(input)
  } catch {
    return input
  }
}

/**
 * `getMonitorBridge` throws when the ref is unpopulated. The
 * `experimental_repairToolCall` hook is a hot path: a missing bridge
 * must skip the LLM-repair branch (fall through to the `invalid` tool
 * safety net), not throw and crash the LLM call. This wrapper
 * preserves the throw-on-misuse contract for callers that want it
 * (the dispatcher itself) while letting the hook degrade gracefully.
 */
function getMonitorBridgeSafe() {
  try {
    return getMonitorBridge()
  } catch {
    return undefined
  }
}

/**
 * Convert an AI SDK `Tool.inputSchema` (`FlexibleSchema<unknown>`) into
 * a JSON-schema-shaped plain object the LLM can read in the repair
 * prompt. The AI SDK accepts three shapes: a Zod schema (zod 3/4), a
 * StandardSchemaV1, or a raw JSON schema. Zod 4 ships
 * `z.toJSONSchema()`; the lower-case predicate covers the raw-JSON
 * case (the schema already has a `type` or `properties` key).
 *
 * The LLM is shown the exact same JSON schema the tool emits on the
 * wire — a repair that passes the prompt's schema check should pass
 * the runtime zod check too. Returning `null` is safe: the repair
 * sub-agent will see `schema: null` in the prompt and fall back to
 * pattern-matching on the error message.
 */
function toolSchemaToJson(inputSchema: unknown): unknown {
  if (inputSchema === undefined || inputSchema === null) return null
  if (typeof inputSchema !== "object") return null
  const obj = inputSchema as Record<string, unknown>
  if ("type" in obj || "properties" in obj) return obj
  if ("_def" in obj || "_zod" in obj || "$schema" in obj) {
    try {
      if (typeof z.toJSONSchema === "function") return z.toJSONSchema(inputSchema as never)
    } catch {
      return null
    }
  }
  return obj
}

export * as LLM from "./llm"
