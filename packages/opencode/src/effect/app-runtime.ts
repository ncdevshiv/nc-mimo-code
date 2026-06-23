import { Layer, ManagedRuntime } from "effect"
import { attach } from "./run-service"
import * as Observability from "./observability"

import { AppFileSystem } from "@nc-mimo-code/shared/filesystem"
import { Bus } from "@/bus"
import { Auth } from "@/auth"
import { Account } from "@/account/account"
import { Config } from "@/config"
import { Git } from "@/git"
import { Ripgrep } from "@/file/ripgrep"
import { File } from "@/file"
import { FileWatcher } from "@/file/watcher"
import { Storage } from "@/storage"
import { Snapshot } from "@/snapshot"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider"
import { ProviderAuth } from "@/provider"
import { Agent } from "@/agent/agent"
import { Skill } from "@/skill"
import { Discovery } from "@/skill/discovery"
import { Question } from "@/question"
import { Permission } from "@/permission"
import { Todo } from "@/session/todo"
import { Session } from "@/session"
import { SessionStatus } from "@/session/status"
import { SessionRunState } from "@/session/run-state"
import { Goal } from "@/session/goal"
import { SessionProcessor } from "@/session/processor"
import { SessionCompaction } from "@/session/compaction"
import { SessionPrune } from "@/session/prune"
import { SessionRevert } from "@/session/revert"
import { SessionSummary } from "@/session/summary"
import { SessionPrompt } from "@/session/prompt"
import { SessionCheckpoint } from "@/session/checkpoint"
import { Instruction } from "@/session/instruction"
import { LLM } from "@/session/llm"
import { LSP } from "@/lsp"
import { MCP } from "@/mcp"
import { McpAuth } from "@/mcp/auth"
import { Command } from "@/command"
import { Truncate } from "@/tool"
import { ToolRegistry } from "@/tool"
import { Pressure } from "@/util"
import { Format } from "@/format"
import { Project } from "@/project"
import { Vcs } from "@/project"
import { Worktree } from "@/worktree"
import { Pty } from "@/pty"
import { Installation } from "@/installation"
import { ShareNext } from "@/share"
import { SessionShare } from "@/share"
import { Npm } from "@/npm"
import { ActorRegistry } from "@/actor/registry"
import { ActorWaiter } from "@/actor/waiter"
import { Actor } from "@/actor/spawn"
import { TaskRegistry } from "@/task/registry"
import { WorkflowRuntime } from "@/workflow/runtime"
import { History } from "@/history"
import { Memory } from "@/memory"
import { wireMonitorBridge } from "@/monitor/service"
import * as BashInteractive from "@/tool/bash-interactive"
import { memoMap } from "./memo-map"

// Wrapped in Layer.suspend so the cross-module `.defaultLayer` reads defer to
// first use instead of running at module load — same TDZ fix as Actor.defaultLayer.
//
// `Layer.mergeAll` builds all layers concurrently with a shared memoMap.
// In `effect@4.0.0-beta.48` that concurrent build does NOT reliably satisfy
// cross-layer requirements (e.g. `Actor.defaultLayer` reading
// `Config.Service` at layer-body time, or `LLM.defaultLayer` requiring
// `Config.Service`): the dependent layer's body can run before its
// prerequisite's build has been memoized, and `Context.getReferenceUnsafe`
// throws `Service not found: @opencode/Config` from inside the server route
// handlers (e.g. `/provider`, `/experimental/console`, `/config`).
//
// The fix is to explicitly `Layer.provide` the layers that are depended on
// by other layers in the merge, so the dependent builds see those services
// in their context from the start (the provider chain is part of the
// layer's static `R` type, so its build always runs with the upstream
// service in context). `Config.defaultLayer` is the most-shared dependency
// (required transitively by `Actor`, `LLM`, `ProviderAuth`, etc.); providing
// it once to the merged graph satisfies every downstream requirement.
export const AppLayer = Layer.suspend(() =>
  Layer.mergeAll(
    Npm.defaultLayer,
    AppFileSystem.defaultLayer,
    Bus.defaultLayer,
    Auth.defaultLayer,
    Account.defaultLayer,
    Config.defaultLayer,
    Git.defaultLayer,
    Ripgrep.defaultLayer,
    File.defaultLayer,
    FileWatcher.defaultLayer,
    Storage.defaultLayer,
    Snapshot.defaultLayer,
    Plugin.defaultLayer,
    Provider.defaultLayer,
    ProviderAuth.defaultLayer,
    Agent.defaultLayer,
    Skill.defaultLayer,
    Discovery.defaultLayer,
    Question.defaultLayer,
    Permission.defaultLayer,
    Todo.defaultLayer,
    Session.defaultLayer,
    SessionStatus.defaultLayer,
    SessionRunState.defaultLayer,
    Goal.defaultLayer,
    SessionProcessor.defaultLayer,
    SessionCompaction.defaultLayer,
    SessionPrune.defaultLayer,
    SessionRevert.defaultLayer,
    SessionSummary.defaultLayer,
    SessionPrompt.defaultLayer,
    SessionCheckpoint.defaultLayer,
    Instruction.defaultLayer,
    LLM.defaultLayer,
    LSP.defaultLayer,
    MCP.defaultLayer,
    McpAuth.defaultLayer,
    Command.defaultLayer,
    Truncate.defaultLayer,
    ToolRegistry.defaultLayer,
    Pressure.defaultLayer,
    Format.defaultLayer,
    Project.defaultLayer,
    Vcs.defaultLayer,
    Worktree.defaultLayer,
    Pty.defaultLayer,
    Installation.defaultLayer,
    ShareNext.defaultLayer,
    SessionShare.defaultLayer,
    ActorRegistry.defaultLayer,
    ActorWaiter.defaultLayer,
    Actor.defaultLayer,
    TaskRegistry.defaultLayer,
    WorkflowRuntime.defaultLayer,
    Memory.defaultLayer,
    History.defaultLayer,
  )
    .pipe(
      // Explicit upstream-context injection for the most-shared
      // dependencies. `Config.defaultLayer` is required by Actor, LLM,
      // ProviderAuth, Worktree, and many route handlers. The transitive
      // providers (`EffectFlock`, `Env`) are already inside
      // `Config.defaultLayer`'s own chain, so providing `Config` here
      // also pulls them in. `Bus.defaultLayer` is required by
      // ActorRegistry, Inbox, Provider, and others.
      Layer.provide(Layer.merge(Config.defaultLayer, Bus.defaultLayer)),
    )
    .pipe(Layer.provideMerge(Observability.layer))
    .pipe(Layer.provideMerge(BashInteractive.defaultLayer)),
)

// Standalone Effect that installs the live `MonitorBridge` into
// `monitorBridgeRef` so `getMonitorBridge()` is populated for the
// tool-failure-repair dispatcher and the bash-long-running monitor.
// Run once at boot (after the app runtime is built) with the app
// runtime's context. Kept OUT of the `Layer.mergeAll` above because
// Layer.mergeAll's type inference of cross-layer requirement
// satisfaction with namespace re-exports of `Context.Service` tags
// does not narrow the requirement side correctly in effect
// 4.0.0-beta.48; running the wire-up as a separate Effect with the
// runtime's context avoids the inference problem entirely.
export const wireAppMonitor = wireMonitorBridge

const rt = ManagedRuntime.make(AppLayer, { memoMap })
type Runtime = Pick<typeof rt, "runSync" | "runPromise" | "runPromiseExit" | "runFork" | "runCallback" | "dispose">
const wrap = (effect: Parameters<typeof rt.runSync>[0]) => attach(effect as never) as never

export const AppRuntime: Runtime = {
  runSync(effect) {
    return rt.runSync(wrap(effect))
  },
  runPromise(effect, options) {
    return rt.runPromise(wrap(effect), options)
  },
  runPromiseExit(effect, options) {
    return rt.runPromiseExit(wrap(effect), options)
  },
  runFork(effect) {
    return rt.runFork(wrap(effect))
  },
  runCallback(effect) {
    return rt.runCallback(wrap(effect))
  },
  dispose: () => rt.dispose(),
}

// Wire the live `MonitorBridge` into the module-scoped `monitorBridgeRef`
// so `getMonitorBridge()` returns the implementation for the
// tool-failure-repair dispatcher (used by `experimental_repairToolCall`)
// and the bash-long-running monitor (Phase 3).
//
// The wiring is exported as `wireAppMonitor` (the Effect itself) so
// callers can run it with `AppRuntime.runPromise(wireAppMonitor)` at a
// point where async is acceptable. It is NOT auto-invoked at module
// load: the original `AppRuntime.runSync(wireAppMonitor)` line threw
// `AsyncFiberError` because `Actor.Service` is satisfied by a layer
// whose build is async, and `runSync` cannot run async work.
//
// Without the wiring the bridge is unpopulated; the affected call
// sites degrade safely:
//   - `BashLongRunning.spawn` / `ToolFailureRepair.spawn` fall through
//     to the `deps.bridge ?? getMonitorBridge()` check; the
//     `getMonitorBridge()` throw is caught upstream and the LLM is
//     told the call is unfixable.
//   - `experimental_repairToolCall` uses `getMonitorBridgeSafe()`
//     which returns `undefined` and routes the call to the `invalid`
//     tool safety net.
// The CLI bootstrap is the canonical place to call
// `AppRuntime.runPromise(wireAppMonitor)` after the Instance scope is
// established.

