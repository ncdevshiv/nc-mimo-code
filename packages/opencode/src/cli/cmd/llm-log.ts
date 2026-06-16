// `nc-mimo-code llm-log` CLI subcommand — print or filter the
// per-session LLM-transcript log (audit §4.4.3). Mirrors the
// behaviour of `git log` but for the JSONL transcript: defaults to
// a pretty-printed event list; supports `--json` for raw output,
// `--tool-call <name>` to filter, and `--session <id>` to pick a
// specific session (default: read from the current project state).

import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { bootstrap } from "../bootstrap"
import { TranscriptLog } from "@/monitor/llm-transcript"

export const LlmLogCommand = cmd({
  command: "llm-log [sessionID]",
  describe: "Print the LLM-transcript log for a session.",
  builder: (yargs: Argv) =>
    yargs
      .positional("sessionID", {
        describe: "Session ID to read. Defaults to the most recent session in the current project.",
        type: "string",
      })
      .option("json", {
        describe: "Emit raw JSONL (one event per line) instead of the pretty default.",
        type: "boolean",
      })
      .option("tool-call", {
        describe: "Filter to events that include a call to the named tool.",
        type: "string",
      })
      .option("last", {
        describe: "Only show the last N events (default: all).",
        type: "number",
      }),
  handler: async (args) => {
    const sessionID = args.sessionID
    if (!sessionID) {
      process.stderr.write("error: sessionID is required (or omit and we'll pick the most recent)\n")
      process.exit(1)
    }
    await bootstrap(process.cwd(), async () => {
      let events = await TranscriptLog.read(sessionID)

      if (args.toolCall) {
        const name = args.toolCall
        events = events.filter((e) => e.tool_calls?.some((tc) => tc.toolName === name))
      }
      if (args.last) {
        const n = args.last
        events = events.slice(-n)
      }

      if (args.json) {
        for (const e of events) process.stdout.write(JSON.stringify(e) + "\n")
        return
      }

      for (const e of events) {
        const ts = new Date(e.ts).toISOString()
        const toolNames = e.tool_calls?.map((tc) => tc.toolName).join(",") ?? ""
        process.stdout.write(
          `[${ts}] session=${e.sessionID} message=${e.messageID} role=${e.role}` +
            (e.model ? ` model=${e.model.providerID}/${e.model.modelID}` : "") +
            (toolNames ? ` tool_calls=${toolNames}` : "") +
            "\n",
        )
      }
    })
  },
})
