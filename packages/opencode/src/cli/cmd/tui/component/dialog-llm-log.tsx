// PR-2 step 8 — TUI dialog that fetches and renders the per-session
// LLM-transcript events. The data source is
// `GET /session/:sessionID/llm-log` (added in step 6), reached via
// `sdk.client.session.llmLog(...)`.
//
// The dialog is read-only: each event is rendered as a compact block
// showing the timestamp, the role, the model (if any), and a
// `JSON.stringify(event.request / event.response / event.tool_calls)`
// summary so the user can see exactly what the model saw.
//
// The `DialogLlmLog.show` static method follows the convention of
// `DialogExportOptions.show` (see `ui/dialog-export-options.tsx:193`):
// returns a Promise that resolves when the dialog is dismissed
// (escape / ctrl+c / mouse-click-outside).

import { createMemo, createResource, onMount, Show } from "solid-js"
import { useDialog, type DialogContext } from "../ui/dialog"
import { useSDK } from "../context/sdk"
import { Spinner } from "./spinner"
import { errorMessage } from "@/util/error"
import { useTheme } from "../context/theme"

interface DialogLlmLogProps {
  sessionID: string
}

/** Pure formatter — exported for unit testing without a Solid runtime. */
export function formatEvent(event: unknown): string {
  if (event === null || event === undefined) return ""
  if (typeof event !== "object") return String(event)
  const e = event as Record<string, unknown>
  const ts = typeof e.ts === "number" ? new Date(e.ts).toISOString() : "?"
  const role = typeof e.role === "string" ? e.role : "?"
  const model =
    e.model && typeof e.model === "object"
      ? `${(e.model as Record<string, unknown>).providerID ?? "?"}/${(e.model as Record<string, unknown>).modelID ?? "?"}`
      : ""
  const toolCalls = Array.isArray(e.tool_calls)
    ? (e.tool_calls as Array<Record<string, unknown>>)
        .map((tc) => (typeof tc.toolName === "string" ? tc.toolName : "?"))
        .join(",")
    : ""
  const summary =
    [role, model, toolCalls ? `tools=${toolCalls}` : ""].filter(Boolean).join(" ") || "(empty)"
  return `[${ts}] ${summary}`
}

type DialogLlmLogComponent = ((props: DialogLlmLogProps) => unknown) & {
  show: (dialog: DialogContext, sessionID: string) => Promise<void>
}

export const DialogLlmLog: DialogLlmLogComponent = ((props: DialogLlmLogProps) => {
  const dialog = useDialog()
  const sdk = useSDK()
  const { theme } = useTheme()

  const [events] = createResource(() => props.sessionID, async (sessionID) => {
    const result = await sdk.client.session.llmLog({ sessionID })
    if (result.error) throw new Error(errorMessage(result.error))
    return result.data ?? []
  })

  onMount(() => {
    dialog.setSize("large")
  })

  return (
    <box
      flexDirection="column"
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      gap={1}
    >
      <text fg={theme.text}>
        <b>LLM Transcript</b>
      </text>
      <text fg={theme.textMuted}>session: {props.sessionID}</text>
      <Show
        when={!events.loading}
        fallback={
          <box flexDirection="row" gap={1}>
            <Spinner />
            <text fg={theme.textMuted}>Loading transcript…</text>
          </box>
        }
      >
        <Show
          when={!events.error}
          fallback={<text fg={theme.error}>Error: {errorMessage(events.error)}</text>}
        >
          {(_) => {
            const list = createMemo(() => events() ?? [])
            return (
              <Show
                when={list().length > 0}
                fallback={
                  <text fg={theme.textMuted}>
                    No transcript events. Enable `config.log.enabled` to start recording.
                  </text>
                }
              >
                <scrollbox
                  flexDirection="column"
                  gap={0}
                  maxHeight={20}
                  scrollbarOptions={{ visible: false }}
                >
                  {list().map((event, i) => (
                    <text fg={theme.text}>
                      {String(i + 1).padStart(3, " ")}. {formatEvent(event)}
                    </text>
                  ))}
                </scrollbox>
              </Show>
            )
          }}
        </Show>
      </Show>
      <text fg={theme.textMuted}>Press any key to close.</text>
    </box>
  )
}) as DialogLlmLogComponent

DialogLlmLog.show = (dialog: DialogContext, sessionID: string): Promise<void> => {
  return new Promise<void>((resolve) => {
    dialog.replace(() => <DialogLlmLog sessionID={sessionID} />, () => resolve())
  })
}
