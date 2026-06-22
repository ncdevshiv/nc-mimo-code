// Tests for `ProviderTransform.options`'s `includeRawChunks` branch.
//
// PR-2 step 3 — the flag is gated on the model's npm package (only
// `@ai-sdk/github-copilot` reads it today) and on the
// `providerOptions.includeRawChunks === true` toggle. Other providers
// silently drop the flag (the structured `messages` write path stays
// active).

import { test, expect, describe } from "bun:test"
import type * as Provider from "../../src/provider/provider"
import * as ProviderTransform from "../../src/provider/transform"

function fakeModel(npm: string, providerID = "copilot"): Provider.Model {
  return {
    providerID,
    id: "test-model",
    api: { id: "test-model", npm },
    capabilities: { temperature: true, toolcall: true, input: { text: true, image: true }, output: { text: true } },
    limit: { context: 128_000, output: 8_192 },
  } as unknown as Provider.Model
}

describe("ProviderTransform.options: includeRawChunks plumbing", () => {
  test("emits includeRawChunks for github-copilot when providerOptions sets it", () => {
    const result = ProviderTransform.options({
      model: fakeModel("@ai-sdk/github-copilot", "github-copilot"),
      sessionID: "ses_test",
      providerOptions: { includeRawChunks: true },
    })
    expect(result["includeRawChunks"]).toBe(true)
  })

  test("does NOT emit includeRawChunks for github-copilot when providerOptions is empty", () => {
    const result = ProviderTransform.options({
      model: fakeModel("@ai-sdk/github-copilot", "github-copilot"),
      sessionID: "ses_test",
      providerOptions: {},
    })
    expect(result["includeRawChunks"]).toBeUndefined()
  })

  test("does NOT emit includeRawChunks for non-copilot providers even if requested", () => {
    const result = ProviderTransform.options({
      model: fakeModel("@ai-sdk/openai", "openai"),
      sessionID: "ses_test",
      providerOptions: { includeRawChunks: true },
    })
    expect(result["includeRawChunks"]).toBeUndefined()
  })

  test("does NOT emit includeRawChunks for non-copilot providers (anthropic)", () => {
    const result = ProviderTransform.options({
      model: fakeModel("@ai-sdk/anthropic", "anthropic"),
      sessionID: "ses_test",
      providerOptions: { includeRawChunks: true },
    })
    expect(result["includeRawChunks"]).toBeUndefined()
  })

  test("emits includeRawChunks=false explicitly is treated as 'off'", () => {
    const result = ProviderTransform.options({
      model: fakeModel("@ai-sdk/github-copilot", "github-copilot"),
      sessionID: "ses_test",
      providerOptions: { includeRawChunks: false },
    })
    expect(result["includeRawChunks"]).toBeUndefined()
  })

  test("emits includeRawChunks alongside other copilot options", () => {
    const result = ProviderTransform.options({
      model: fakeModel("@ai-sdk/github-copilot", "github-copilot"),
      sessionID: "ses_test",
      providerOptions: { includeRawChunks: true, someOtherFlag: "x" },
    })
    expect(result["includeRawChunks"]).toBe(true)
    // The store=false branch (existing copilot default) is unaffected.
    expect(result["store"]).toBe(false)
  })

  test("emits includeRawChunks for opencode provider that uses copilot SDK", () => {
    // `providerID` can be a different value while still routing through
    // the copilot SDK (e.g. custom provider aliases).
    const result = ProviderTransform.options({
      model: fakeModel("@ai-sdk/github-copilot", "opencode"),
      sessionID: "ses_test",
      providerOptions: { includeRawChunks: true },
    })
    expect(result["includeRawChunks"]).toBe(true)
  })
})