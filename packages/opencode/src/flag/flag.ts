import { Config } from "effect"

function truthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

function falsy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "false" || value === "0"
}

function number(key: string) {
  const value = process.env[key]
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

const NC_MIMO_CODE_EXPERIMENTAL = truthy("NC_MIMO_CODE_EXPERIMENTAL")

// Defaults to false. When enabled, mimocode runs in pure-mimo mode:
//   — does NOT inherit Claude Code's settings (CLAUDE.md, ~/.claude/skills, etc.)
//   — does NOT pick up provider API keys from environment variables
//   — falls back to the mimo-auto model as the default
// Set NC_MIMO_CODE_MIMO_ONLY=true to disable .claude inheritance and env-based
// provider auto-detection.
const NC_MIMO_CODE_MIMO_ONLY = truthy("NC_MIMO_CODE_MIMO_ONLY")
const NC_MIMO_CODE_DISABLE_CLAUDE_CODE_ENV = truthy("NC_MIMO_CODE_DISABLE_CLAUDE_CODE")
const NC_MIMO_CODE_DISABLE_CLAUDE_CODE = NC_MIMO_CODE_MIMO_ONLY || NC_MIMO_CODE_DISABLE_CLAUDE_CODE_ENV

const NC_MIMO_CODE_DISABLE_EXTERNAL_SKILLS = truthy("NC_MIMO_CODE_DISABLE_EXTERNAL_SKILLS")
const NC_MIMO_CODE_DISABLE_CLAUDE_CODE_SKILLS =
  NC_MIMO_CODE_DISABLE_EXTERNAL_SKILLS || NC_MIMO_CODE_DISABLE_CLAUDE_CODE || truthy("NC_MIMO_CODE_DISABLE_CLAUDE_CODE_SKILLS")
const copy = process.env["NC_MIMO_CODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"]

export const Flag = {
  OTEL_EXPORTER_OTLP_ENDPOINT: process.env["OTEL_EXPORTER_OTLP_ENDPOINT"],
  OTEL_EXPORTER_OTLP_HEADERS: process.env["OTEL_EXPORTER_OTLP_HEADERS"],

  NC_MIMO_CODE_AUTO_SHARE: truthy("NC_MIMO_CODE_AUTO_SHARE"),
  NC_MIMO_CODE_AUTO_HEAP_SNAPSHOT: truthy("NC_MIMO_CODE_AUTO_HEAP_SNAPSHOT"),
  NC_MIMO_CODE_GIT_BASH_PATH: process.env["NC_MIMO_CODE_GIT_BASH_PATH"],
  NC_MIMO_CODE_CONFIG: process.env["NC_MIMO_CODE_CONFIG"],
  NC_MIMO_CODE_CONFIG_CONTENT: process.env["NC_MIMO_CODE_CONFIG_CONTENT"],

  NC_MIMO_CODE_DISABLE_AUTOUPDATE: truthy("NC_MIMO_CODE_DISABLE_AUTOUPDATE"),

  // Defaults to true (analytics enabled). Set NC_MIMO_CODE_ENABLE_ANALYSIS=false
  // to opt out of POSTing model_call/tool_call/agent_request metrics.
  NC_MIMO_CODE_ENABLE_ANALYSIS: !falsy("NC_MIMO_CODE_ENABLE_ANALYSIS"),
  NC_MIMO_CODE_ALWAYS_NOTIFY_UPDATE: truthy("NC_MIMO_CODE_ALWAYS_NOTIFY_UPDATE"),
  NC_MIMO_CODE_DISABLE_PRUNE: truthy("NC_MIMO_CODE_DISABLE_PRUNE"),
  NC_MIMO_CODE_DISABLE_TERMINAL_TITLE: truthy("NC_MIMO_CODE_DISABLE_TERMINAL_TITLE"),
  NC_MIMO_CODE_SHOW_TTFD: truthy("NC_MIMO_CODE_SHOW_TTFD"),
  NC_MIMO_CODE_PERMISSION: process.env["NC_MIMO_CODE_PERMISSION"],
  NC_MIMO_CODE_DISABLE_DEFAULT_PLUGINS: truthy("NC_MIMO_CODE_DISABLE_DEFAULT_PLUGINS"),
  NC_MIMO_CODE_DISABLE_LSP_DOWNLOAD: truthy("NC_MIMO_CODE_DISABLE_LSP_DOWNLOAD"),
  NC_MIMO_CODE_ENABLE_EXPERIMENTAL_MODELS: truthy("NC_MIMO_CODE_ENABLE_EXPERIMENTAL_MODELS"),
  NC_MIMO_CODE_DISABLE_AUTOCOMPACT: truthy("NC_MIMO_CODE_DISABLE_AUTOCOMPACT"),
  NC_MIMO_CODE_DISABLE_MODELS_FETCH: truthy("NC_MIMO_CODE_DISABLE_MODELS_FETCH"),
  NC_MIMO_CODE_DISABLE_MOUSE: truthy("NC_MIMO_CODE_DISABLE_MOUSE"),
  NC_MIMO_CODE_OUTPUT_LENGTH_CONTINUATION_LIMIT: number("NC_MIMO_CODE_OUTPUT_LENGTH_CONTINUATION_LIMIT") ?? 3,
  NC_MIMO_CODE_INVALID_OUTPUT_CONTINUATION_LIMIT: number("NC_MIMO_CODE_INVALID_OUTPUT_CONTINUATION_LIMIT") ?? 2,

  // Caps applied to image attachments before a prompt is sent. Both default to
  // undefined (no limit). NC_MIMO_CODE_MAX_PROMPT_IMAGES bounds how many images may
  // be sent per request (oldest excess images are dropped); NC_MIMO_CODE_MAX_PROMPT_IMAGE_SIZE
  // bounds the decoded byte size of a single image. Values must be positive integers.
  NC_MIMO_CODE_MAX_PROMPT_IMAGES: number("NC_MIMO_CODE_MAX_PROMPT_IMAGES"),
  NC_MIMO_CODE_MAX_PROMPT_IMAGE_SIZE: number("NC_MIMO_CODE_MAX_PROMPT_IMAGE_SIZE"),
  NC_MIMO_CODE_MIMO_ONLY,
  NC_MIMO_CODE_DISABLE_PROVIDER_ENV: NC_MIMO_CODE_MIMO_ONLY || truthy("NC_MIMO_CODE_DISABLE_PROVIDER_ENV"),
  NC_MIMO_CODE_DISABLE_CLAUDE_CODE,
  get NC_MIMO_CODE_DISABLE_CLAUDE_CODE_MCP() {
    // MCP compatibility stays on in mimo-only mode so users can reuse Claude Code
    // MCP servers without inheriting prompts, skills, or provider env keys.
    return NC_MIMO_CODE_DISABLE_CLAUDE_CODE_ENV || truthy("NC_MIMO_CODE_DISABLE_CLAUDE_CODE_MCP")
  },
  NC_MIMO_CODE_DISABLE_CLAUDE_CODE_PROMPT: NC_MIMO_CODE_DISABLE_CLAUDE_CODE || truthy("NC_MIMO_CODE_DISABLE_CLAUDE_CODE_PROMPT"),
  // Defaults to false (enabled): markdown commands under ~/.claude/commands and
  // {project}/.claude/commands load as slash commands. Independent of the
  // mimo-only master switch. Set NC_MIMO_CODE_DISABLE_CLAUDE_CODE_COMMANDS=true to disable.
  NC_MIMO_CODE_DISABLE_CLAUDE_CODE_COMMANDS: truthy("NC_MIMO_CODE_DISABLE_CLAUDE_CODE_COMMANDS"),
  NC_MIMO_CODE_DISABLE_CLAUDE_CODE_SKILLS,
  NC_MIMO_CODE_DISABLE_EXTERNAL_SKILLS,
  NC_MIMO_CODE_DISABLE_CODEX_SKILLS: NC_MIMO_CODE_DISABLE_EXTERNAL_SKILLS || truthy("NC_MIMO_CODE_DISABLE_CODEX_SKILLS"),
  NC_MIMO_CODE_DISABLE_OPENCODE_SKILLS: NC_MIMO_CODE_DISABLE_EXTERNAL_SKILLS || truthy("NC_MIMO_CODE_DISABLE_OPENCODE_SKILLS"),
  NC_MIMO_CODE_FAKE_VCS: process.env["NC_MIMO_CODE_FAKE_VCS"],

  // When enabled, skips all git subprocess calls during project discovery
  // (which git, rev-parse --git-common-dir, rev-parse --show-toplevel) and
  // branch detection. The project is treated as a non-git directory rooted at
  // the working directory. Use to avoid touching git in restricted/sandboxed
  // environments or where git startup probing is undesirable.
  NC_MIMO_CODE_DISABLE_GIT: truthy("NC_MIMO_CODE_DISABLE_GIT"),
  NC_MIMO_CODE_SERVER_PASSWORD: process.env["NC_MIMO_CODE_SERVER_PASSWORD"],
  NC_MIMO_CODE_SERVER_USERNAME: process.env["NC_MIMO_CODE_SERVER_USERNAME"],
  NC_MIMO_CODE_ENABLE_QUESTION_TOOL: truthy("NC_MIMO_CODE_ENABLE_QUESTION_TOOL"),

  // Experimental
  NC_MIMO_CODE_EXPERIMENTAL,
  NC_MIMO_CODE_EXPERIMENTAL_FILEWATCHER: Config.boolean("NC_MIMO_CODE_EXPERIMENTAL_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  NC_MIMO_CODE_EXPERIMENTAL_DISABLE_FILEWATCHER: Config.boolean("NC_MIMO_CODE_EXPERIMENTAL_DISABLE_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  NC_MIMO_CODE_EXPERIMENTAL_ICON_DISCOVERY: NC_MIMO_CODE_EXPERIMENTAL || truthy("NC_MIMO_CODE_EXPERIMENTAL_ICON_DISCOVERY"),
  NC_MIMO_CODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT:
    copy === undefined ? process.platform === "win32" : truthy("NC_MIMO_CODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"),
  NC_MIMO_CODE_ENABLE_EXA: truthy("NC_MIMO_CODE_ENABLE_EXA") || NC_MIMO_CODE_EXPERIMENTAL || truthy("NC_MIMO_CODE_EXPERIMENTAL_EXA"),
  NC_MIMO_CODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS: number("NC_MIMO_CODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS"),
  NC_MIMO_CODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: number("NC_MIMO_CODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX"),
  NC_MIMO_CODE_EXPERIMENTAL_OXFMT: NC_MIMO_CODE_EXPERIMENTAL || truthy("NC_MIMO_CODE_EXPERIMENTAL_OXFMT"),
  NC_MIMO_CODE_EXPERIMENTAL_LSP_TY: truthy("NC_MIMO_CODE_EXPERIMENTAL_LSP_TY"),
  NC_MIMO_CODE_EXPERIMENTAL_LSP_TOOL: NC_MIMO_CODE_EXPERIMENTAL || truthy("NC_MIMO_CODE_EXPERIMENTAL_LSP_TOOL"),
  NC_MIMO_CODE_EXPERIMENTAL_WORKFLOW_TOOL: NC_MIMO_CODE_EXPERIMENTAL || truthy("NC_MIMO_CODE_EXPERIMENTAL_WORKFLOW_TOOL"),
  NC_MIMO_CODE_EXPERIMENTAL_MARKDOWN: !falsy("NC_MIMO_CODE_EXPERIMENTAL_MARKDOWN"),
  NC_MIMO_CODE_MODELS_URL: process.env["NC_MIMO_CODE_MODELS_URL"],
  NC_MIMO_CODE_MODELS_PATH: process.env["NC_MIMO_CODE_MODELS_PATH"],
  NC_MIMO_CODE_DISABLE_EMBEDDED_WEB_UI: truthy("NC_MIMO_CODE_DISABLE_EMBEDDED_WEB_UI"),
  NC_MIMO_CODE_DB: process.env["NC_MIMO_CODE_DB"],

  // Defaults to true — all channels share a single mimocode.db. The per-channel
  // DB isolation (mimocode-{channel}.db) is unnecessary for mimocode since we
  // don't ship multiple release channels yet. Use NC_MIMO_CODE_HOME to isolate dev
  // environments instead. Set NC_MIMO_CODE_DISABLE_CHANNEL_DB=false to restore
  // per-channel isolation.
  NC_MIMO_CODE_DISABLE_CHANNEL_DB: !falsy("NC_MIMO_CODE_DISABLE_CHANNEL_DB"),
  NC_MIMO_CODE_SKIP_MIGRATIONS: truthy("NC_MIMO_CODE_SKIP_MIGRATIONS"),
  NC_MIMO_CODE_STRICT_CONFIG_DEPS: truthy("NC_MIMO_CODE_STRICT_CONFIG_DEPS"),

  NC_MIMO_CODE_WORKSPACE_ID: process.env["NC_MIMO_CODE_WORKSPACE_ID"],
  NC_MIMO_CODE_EXPERIMENTAL_HTTPAPI: truthy("NC_MIMO_CODE_EXPERIMENTAL_HTTPAPI"),
  NC_MIMO_CODE_EXPERIMENTAL_WORKSPACES: NC_MIMO_CODE_EXPERIMENTAL || truthy("NC_MIMO_CODE_EXPERIMENTAL_WORKSPACES"),

  // Evaluated at access time (not module load) because tests, the CLI, and
  // external tooling set these env vars at runtime.
  get NC_MIMO_CODE_DISABLE_COMPOSE_SKILLS() {
    return truthy("NC_MIMO_CODE_DISABLE_COMPOSE_SKILLS")
  },
  get NC_MIMO_CODE_DISABLE_PROJECT_CONFIG() {
    return truthy("NC_MIMO_CODE_DISABLE_PROJECT_CONFIG")
  },
  get NC_MIMO_CODE_TUI_CONFIG() {
    return process.env["NC_MIMO_CODE_TUI_CONFIG"]
  },
  get NC_MIMO_CODE_CONFIG_DIR() {
    return process.env["NC_MIMO_CODE_CONFIG_DIR"]
  },
  get NC_MIMO_CODE_HOME() {
    return process.env["NC_MIMO_CODE_HOME"]
  },
  get NC_MIMO_CODE_PURE() {
    return truthy("NC_MIMO_CODE_PURE")
  },
  get NC_MIMO_CODE_PLUGIN_META_FILE() {
    return process.env["NC_MIMO_CODE_PLUGIN_META_FILE"]
  },
  get NC_MIMO_CODE_CLIENT() {
    return process.env["NC_MIMO_CODE_CLIENT"] ?? "cli"
  },
}
