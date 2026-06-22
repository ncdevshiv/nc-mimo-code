// Wire the LLM-transcript log into the runtime. Mirrors the
// `wireAppMonitor` pattern (`effect/app-runtime.ts`):
//
//   - The wire-up reads `Config.Info` (which includes the new
//     `Config.Log` schema) and forwards the flags into
//     `monitor/llm-transcript.ts`'s module-level setters.
//   - The wire-up is exported as a stand-alone Effect so the boot
//     path can call it via `AppRuntime.runPromise(wireAppTranscriptLog)`
//     after the Instance scope is established.
//   - Tests can call it in isolation by providing `Config.defaultLayer`
//     and a stub `Instance` scope.
//
// Why a separate module (not inlined in `app-runtime.ts`)? Two reasons:
//   1. The transcript log is opt-in; a one-line boot call is easier to
//      find and reason about than a 30-line block buried in the layer
//      graph.
//   2. Tests can run `wireAppTranscriptLog` in isolation without
//      touching the boot layer, mirroring the `setMonitorBridge` /
//      `setEnabled` testability pattern.

import { Effect } from "effect"
import { Config } from "@/config"
import { TranscriptLog } from "@/monitor/llm-transcript"

export const wireAppTranscriptLog: Effect.Effect<void, never, Config.Service> = Effect.gen(
  function* () {
    const config = yield* Config.Service
    const cfg = yield* config.get()
    const log = cfg.log
    TranscriptLog.setEnabled(log?.enabled ?? false)
    TranscriptLog.setIncludeRawChunks(log?.includeRawChunks ?? false)
    TranscriptLog.setRedactKeys(log?.redactKeys)
    if (log?.path !== undefined) TranscriptLog.setLogDir(log.path)
    // retentionDays and maxBytesPerFile are read at the call site
    // (session/llm.ts:purgeExpired); defaults are baked into that file's
    // own fallback. Wiring them here would be redundant — the schema's
    // documented defaults match what the call site already uses.
  },
)