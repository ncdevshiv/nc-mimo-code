// CLI entry — argv parsing, global logger init, yargs setup, and
// the top-level command dispatch. The previous name was
// `src/temporary.ts` (an audit-flagged anti-pattern: the file is
// the production entry, not a "temporary hack"). Renamed to
// `cli/entry.ts` so the entry lives next to the other CLI
// commands under `src/cli/cmd/`.
//
// The previous file also had the file's own `Log.init` call inline
// (mixing two responsibilities: CLI parsing + log setup). Extracted
// to `cli/log-init.ts` so each file has a single concern.

import "./log-init"
import yargs from "yargs"
import { TuiThreadCommand } from "../cli/cmd/tui/thread"
import { InstallationVersion } from "../installation/version"
import { hideBin } from "yargs/helpers"

const cli = yargs(hideBin(process.argv))
  .parserConfiguration({ "populate--": true })
  .scriptName("mimo")
  .wrap(100)
  .help("help", "show help")
  .alias("help", "h")
  .version("version", "show version number", InstallationVersion)
  .alias("version", "v")
  .option("print-logs", {
    describe: "print logs to stderr",
    type: "boolean",
  })
  .option("log-level", {
    describe: "log level",
    type: "string",
    choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  })
  .option("pure", {
    describe: "run without external plugins",
    type: "boolean",
  })
  .command(TuiThreadCommand)
  .parse()
