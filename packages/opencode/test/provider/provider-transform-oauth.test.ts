// Tests for `ProviderTransform.message`'s OpenAI-oauth branch.
//
// Background: the AI SDK requires the system prompt to be passed
// via `providerOptions.openaiCompatible.instructions` (and dropped
// from the message list) when the auth method is `oauth`. The
// branch was previously inline in `agent.ts` and `session/llm.ts`;
// the audit (§6.4.3) flagged it as a provider-specific leak. The
// test exercises the transform's `openaiOauth: true` option to
// confirm the new contract.

import { test, expect, describe } from "bun:test"
import type { ModelMessage } from "ai"
import { ProviderTransform } from "../../src/provider/transform"
import type * as Provider from "../../src/provider/provider"

const fakeModel: Provider.Model = {
  providerID: "openai",
  id: "gpt-4o",
  api: { id: "openai", npm: "@ai-sdk/openai" },
  capabilities: { temperature: true, toolcall: true, input: { text: true, image: true }, output: { text: true } },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 0, input: 0, output: 0 },
  options: {},
} as unknown as Provider.Model

describe("ProviderTransform.message: OpenAI-oauth branch", () => {
  test("when openaiOauth is true, system messages are dropped from the list", () => {
    const msgs: ModelMessage[] = [
      { role: "system", content: "you are a helpful assistant" },
      { role: "user", content: "hi" },
    ]
    const out = ProviderTransform.message(msgs, fakeModel, { openaiOauth: true })
    const systemMessages = out.filter((m) => m.role === "system")
    expect(systemMessages).toHaveLength(0)
  })

  test("when openaiOauth is true, the system text is delivered via providerOptions.openaiCompatible.instructions on the first non-system message", () => {
    const msgs: ModelMessage[] = [
      { role: "system", content: "policy A" },
      { role: "system", content: "policy B" },
      { role: "user", content: "hi" },
    ]
    const out = ProviderTransform.message(msgs, fakeModel, { openaiOauth: true })
    const firstNonSystem = out[0]
    expect(firstNonSystem.role).toBe("user")
    expect(firstNonSystem.providerOptions).toEqual({
      openaiCompatible: { instructions: "policy A\n\npolicy B" },
    })
  })

  test("multiple system messages are joined with a blank-line separator (matches the AI SDK's default behavior)", () => {
    const msgs: ModelMessage[] = [
      { role: "system", content: "first" },
      { role: "system", content: "second" },
      { role: "user", content: "hi" },
    ]
    const out = ProviderTransform.message(msgs, fakeModel, { openaiOauth: true })
    const instructions = (out[0].providerOptions as Record<string, Record<string, string>>)
      .openaiCompatible.instructions
    expect(instructions).toBe("first\n\nsecond")
  })

  test("when there are no system messages, the first user message's providerOptions is empty (no instructions injected)", () => {
    const msgs: ModelMessage[] = [{ role: "user", content: "hi" }]
    const out = ProviderTransform.message(msgs, fakeModel, { openaiOauth: true })
    // First non-system message gets an empty providerOptions
    expect(out[0].providerOptions).toEqual({
      openaiCompatible: { instructions: "" },
    })
  })

  test("when openaiOauth is false (or absent), system messages stay in the list and no instructions are injected", () => {
    const msgs: ModelMessage[] = [
      { role: "system", content: "you are a helpful assistant" },
      { role: "user", content: "hi" },
    ]
    const outNoFlag = ProviderTransform.message(msgs, fakeModel, {})
    const outFalseFlag = ProviderTransform.message(msgs, fakeModel, { openaiOauth: false })
    for (const out of [outNoFlag, outFalseFlag]) {
      const systemMessages = out.filter((m) => m.role === "system")
      expect(systemMessages).toHaveLength(1)
      expect(systemMessages[0].content).toBe("you are a helpful assistant")
      // No instructions injected
      for (const m of out) {
        const opts = (m.providerOptions ?? {}) as Record<string, unknown>
        const oc = opts.openaiCompatible as { instructions?: string } | undefined
        expect(oc?.instructions).toBeUndefined()
      }
    }
  })

  test("the system-message join handles non-string content (defensive: array content becomes empty string)", () => {
    const msgs: ModelMessage[] = [
      { role: "system", content: [{ type: "text", text: "structured" }] as never },
      { role: "user", content: "hi" },
    ]
    const out = ProviderTransform.message(msgs, fakeModel, { openaiOauth: true })
    const instructions = (out[0].providerOptions as Record<string, Record<string, string>>)
      .openaiCompatible.instructions
    // Non-string content is coerced to "" in the join (the
    // system prompt is normally a string; array content is rare
    // but possible if the caller passes a structured system
    // message — we skip it rather than try to stringify).
    expect(instructions).toBe("")
  })
})
