export * as ConfigInstallation from "./installation"

import { Schema } from "effect"
import { zod } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"

// PR-4 (audit §9): list of package-manager channels mimocode is
// published to. `curl` and `unknown` are intentionally excluded —
// they are runtime-detected install states, not publishable
// channels. npm/pnpm/bun are always available for the npm-published
// build; brew/choco/scoop are flipped on at publish time. Keeping
// all six as a closed literal set lets the schema reject typos
// (`["bre"]`) at config-load time rather than at uninstall time.
const Channel = Schema.Literals(["npm", "pnpm", "bun", "brew", "choco", "scoop"])

export const Info = Schema.Struct({
  channels: Schema.optional(Schema.mutable(Schema.Array(Channel))).annotate({
    description:
      "Package-manager channels this build is published to. The uninstall command uses this list to render the package-manager command summary and to pick the uninstall command to run. Defaults to ['npm','pnpm','bun'] for the npm-published build; flip on brew/choco/scoop at publish time.",
  }),
}).pipe(withStatics((s) => ({ zod: zod(s) })))

export type Info = Schema.Schema.Type<typeof Info>
