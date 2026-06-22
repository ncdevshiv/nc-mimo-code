# Known issues

This document is the canonical home for deferred Mimocode items —
the per-channel changes the upstream codebase is missing (e.g.
homebrew tap, scoop bucket, choco package) that we plan to wire
up at publish time. In-source `// TODO(mimocode): ...` comments
should reference this file (anchor: `#mimocode-<channel>`).

The master TODO in `docs/codebase-audit.md` §6 / §10 / §11
enumerates the open items; this file is the **detail page** for
the Mimocode-specific subset.

## Channels

### `mimocode-brew` — Homebrew tap

The Mimocode project will publish to a Homebrew tap
(`anomalyco/tap/opencode` or similar) at the same time as the
npm-published build. The audit recommends the `install` and
`uninstall` flows already gate on `Installation.channels` (PR-4
in `codebase-audit.md`), so flipping the channel on is purely
config — no code change required.

**Owner:** release
**Blocked by:** brew formula in `homebrew-tap` repo.
**Tracking:** `codebase-audit.md` §9.6.

### `mimocode-choco` — Chocolatey package

Symmetric to the Homebrew tap — the channel is in the schema and
in the `uninstall` map (`uninstall.ts`); flipping on is a
publish-time config flip.

**Owner:** release
**Blocked by:** choco package in `chocolatey-packages` repo.
**Tracking:** `codebase-audit.md` §9.6.

### `mimocode-scoop` — Scoop bucket

Symmetric to Homebrew / Chocolatey. The `Method` literal and the
uninstall map both already cover `scoop`.

**Owner:** release
**Blocked by:** scoop manifest in `scoop-bucket` repo.
**Tracking:** `codebase-audit.md` §9.6.

## Provider gaps

### `mimocode-xiaomi-oauth` — Xiaomi OAuth refresh

The Mimocode build uses a Xiaomi-internal OAuth flow that the
upstream `opencode` codebase never had. The extraction is in
`ProviderTransform.message` (PR: commit `4fd916b`); the
`XiaomiOAuth` strategy in `provider/transform.ts` is the seam
where the deferred logic will plug in.

**Owner:** platform
**Blocked by:** Xiaomi OAuth credentials + endpoint agreement.
**Tracking:** `codebase-audit.md` §6.4.3.

## Tool gaps (deferred from §10)

### `mimocode-lsp-completion` — LSP `textDocument/completion`

`textDocument/completion` is the most useful LSP call (the
audit notes "even though completion is the most useful LSP
call"). The current LSP tool surfaces definition, references,
hover, symbols, implementation, and call hierarchy but not
completion or code action.

Adding it requires:
- A `completion` method on the `LSP.Service` (the LSP protocol
  types are in `vscode-languageserver-protocol`).
- A new operation in the `lsp` tool's discriminated union
  (`packages/opencode/src/tool/lsp.ts`).
- A `<textDocument/...><position/></textDocument>` request
  through the existing `lsp.hasClients(file)` + per-server
  `sendRequest` plumbing.

**Owner:** TBD
**Blocked by:** none — pure additive change.
**Tracking:** `codebase-audit.md` §10.4 / `tool-audit.md`.

### `mimocode-lsp-codeAction` — LSP `textDocument/codeAction`

Symmetric to completion. `codeAction` returns quick-fixes and
refactors; the LLM uses them to auto-apply "extract method",
"add missing import", etc.

**Owner:** TBD
**Blocked by:** none — pure additive change.
**Tracking:** `codebase-audit.md` §10.4 / `tool-audit.md`.

## Audit doc provenance

This file is referenced by `codebase-audit.md` §6.4.1 (the "move
Mimocode TODOs into `docs/known-issues.md`" item). The Mimocode
TODO comments themselves were removed in commit `12e8c2f`
("install: remove all TODO(mimocode) commented-out stubs"); the
detailed channel plans that used to live inline are now
consolidated here so the source tree is clean.
