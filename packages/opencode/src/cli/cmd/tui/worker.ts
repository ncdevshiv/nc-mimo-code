import { Installation } from "@/installation"
import { Server } from "@/server/server"
import { Log } from "@/util"
import { Instance } from "@/project/instance"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Rpc } from "@/util"
import { upgrade } from "@/cli/upgrade"
import { Config } from "@/config"
import { GlobalBus } from "@/bus/global"
import { Flag } from "@/flag/flag"
import { writeHeapSnapshot } from "node:v8"
import { Heap } from "@/cli/heap"
import { AppRuntime } from "@/effect/app-runtime"
import { wireAppTranscriptLog } from "@/effect/wire-app-transcript-log"
import { wireAppMonitor } from "@/effect/app-runtime"
import { ensureProcessMetadata } from "@/util/mimo-process"

ensureProcessMetadata("worker")

await Log.init({
  print: process.argv.includes("--print-logs"),
  dev: Installation.isLocal(),
  level: (() => {
    if (Installation.isLocal()) return "DEBUG"
    return "INFO"
  })(),
})

Heap.start()

process.on("unhandledRejection", (e) => {
  Log.Default.error("rejection", {
    e: e instanceof Error ? e.message : e,
  })
})

process.on("uncaughtException", (e) => {
  Log.Default.error("exception", {
    e: e instanceof Error ? e.message : e,
  })
})

// Subscribe to global events and forward them via RPC
GlobalBus.on("event", (event) => {
  Rpc.emit("global.event", event)
})

let server: Awaited<ReturnType<typeof Server.listen>> | undefined

export const rpc = {
  async fetch(input: { url: string; method: string; headers: Record<string, string>; body?: string }) {
    const headers = { ...input.headers }
    const auth = getAuthorizationHeader()
    if (auth && !headers["authorization"] && !headers["Authorization"]) {
      headers["Authorization"] = auth
    }
    const request = new Request(input.url, {
      method: input.method,
      headers,
      body: input.body,
    })
    const response = await Server.Default().app.fetch(request)
    const body = await response.text()
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body,
    }
  },
  snapshot() {
    const result = writeHeapSnapshot("server.heapsnapshot")
    return result
  },
  async server(input: { port: number; hostname: string; mdns?: boolean; cors?: string[] }) {
    if (server) await server.stop(true)
    server = await Server.listen(input)
    return { url: server.url.toString() }
  },
  async checkUpgrade(input: { directory: string }) {
    await Instance.provide({
      directory: input.directory,
      init: () => AppRuntime.runPromise(InstanceBootstrap),
      fn: async () => {
        // PR-2 step 5 — wire the LLM-transcript log flags
        // (enabled / includeRawChunks / redactKeys / path) into the
        // module-scoped setters inside `monitor/llm-transcript.ts`.
        // Without this, the TUI's `streamText` calls would never
        // honor `config.log.*` because the TUI does not run through
        // `cli/bootstrap.ts`. Mirrors the boot path in
        // `cli/bootstrap.ts:21-23` exactly.
        await AppRuntime.runPromise(wireAppTranscriptLog).catch((err) =>
          Log.Default.warn("transcript-log wire failed", { error: String(err) }),
        )
        // PR-3 step 1 — wire the monitor bridge for the bash
        // long-running monitor. Without this, hung bash commands
        // (5-min `npm install`, infinite loops, stuck network calls)
        // are never detected and the TUI never sees a
        // `BashLongRunningWarn` toast. Mirrors the boot path in
        // `cli/bootstrap.ts`.
        await AppRuntime.runPromise(wireAppMonitor).catch((err) =>
          Log.Default.warn("monitor-bridge wire failed", { error: String(err) }),
        )
        await upgrade().catch(() => {})
      },
    })
  },
  async reload() {
    await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.invalidate(true)))
  },
  async shutdown() {
    Log.Default.info("worker shutting down")

    await Instance.disposeAll()
    if (server) await server.stop(true)
  },
}

Rpc.listen(rpc)

function getAuthorizationHeader(): string | undefined {
  const password = Flag.NC_MIMO_CODE_SERVER_PASSWORD
  if (!password) return undefined
  const username = Flag.NC_MIMO_CODE_SERVER_USERNAME ?? "mimocode"
  return `Basic ${btoa(`${username}:${password}`)}`
}
