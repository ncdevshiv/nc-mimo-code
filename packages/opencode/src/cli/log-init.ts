// Initialise the global logger. Called from `cli/entry.ts` at boot
// (before any other module reads `process.argv` or instantiates
// tool/session/etc.). Centralising the init here means the CLI
// entry stays focused on the argv-to-command path; tests can
// import this module to reset log state in `beforeEach` without
// dragging in the full entry module.

import { Log } from "../util"

Log.init({
  print: false,
})
