import { AppRuntime } from "@/effect/app-runtime"
import { InstanceBootstrap } from "../project/bootstrap"
import { Instance } from "../project/instance"
import { SessionCheckpoint } from "@/session/checkpoint"
import { Log } from "@/util"
import { wireAppTranscriptLog } from "@/effect/wire-app-transcript-log"
import { wireAppMonitor } from "@/effect/app-runtime"

const log = Log.create({ service: "cli.bootstrap" })

export async function bootstrap<T>(directory: string, cb: () => Promise<T>) {
  return Instance.provide({
    directory,
    init: () => AppRuntime.runPromise(InstanceBootstrap),
    fn: async () => {
      try {
        // Wire the LLM-transcript log into the module-scoped setters
        // (`monitor/llm-transcript.ts`). Reads `config.log` and forwards
        // it to `TranscriptLog.{setEnabled,setRedactKeys,setLogDir}`.
        // Runs inside the Instance scope because `Config.Service` is
        // satisfied by the project bootstrap layer.
        await AppRuntime.runPromise(wireAppTranscriptLog).catch((err) =>
          log.warn("transcript-log wire failed", { error: String(err) }),
        )
        // PR-3 step 1 — wire the monitor bridge (`monitorBridgeRef`)
        // so the bash long-running monitor can spawn its sub-actor
        // (`BashLongRunning.spawn` → `bridge.spawn`). Without this the
        // bridge is unpopulated, `getMonitorBridge()` throws, and the
        // monitor fiber silently degrades to `{ kind: "continue" }`
        // for every hung command. Mirrors the error-swallow pattern of
        // the `wireAppTranscriptLog` call above.
        await AppRuntime.runPromise(wireAppMonitor).catch((err) =>
          log.warn("monitor-bridge wire failed", { error: String(err) }),
        )
        return await cb()
      } finally {
        // Give detached background checkpoint writers a chance to finish
        // before teardown. Headless `mimo run` would otherwise exit right
        // after the main response, killing any forked writer mid-LLM-call
        // and leaving zero checkpoint files on disk.
        //
        // Up to 120s for ALL pending writers collectively. Writers that
        // don't settle in time are abandoned — the runtime teardown will
        // kill them anyway, and their thresholds stay marked so the next
        // process invocation can observe the gap via fireCheckpoints.
        await AppRuntime.runPromise(
          SessionCheckpoint.Service.use((svc) => svc.drainWriters()),
        ).catch((err) => log.warn("checkpoint drain failed", { error: String(err) }))
        await Instance.dispose()
      }
    },
  })
}
