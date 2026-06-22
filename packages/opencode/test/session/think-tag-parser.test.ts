import { test, expect, describe } from "bun:test"
import { thinkHoldLen } from "../../src/session/processor"

const LT = String.fromCharCode(60) // <
const GT = String.fromCharCode(62) // >
const OPEN = LT + "think" + GT // <think...>
const CLOSE = LT + "/think" + GT //  .../think>

// Standalone simulator of the inline think-tag parser state machine that
// processor.ts runs over each streamed text-delta. The real one is buried in
// an Effect generator with side effects; this version is pure so we can
// exhaustively test chunk-boundary behaviour.
type Emit = { type: "text" | "reasoning"; text: string }

class Sim {
  buffer = ""
  active = false
  out: Emit[] = []

  private flush(text: string) {
    if (text.length === 0) return
    this.out.push({ type: this.active ? "reasoning" : "text", text })
  }

  step(delta: string) {
    this.buffer += delta
    let progress = true
    while (progress) {
      progress = false
      if (this.active) {
        const idx = this.buffer.indexOf(CLOSE)
        if (idx >= 0) {
          if (idx > 0) this.flush(this.buffer.slice(0, idx))
          this.buffer = this.buffer.slice(idx + CLOSE.length)
          this.active = false
          progress = true
          continue
        }
        const hold = thinkHoldLen(this.buffer, false)
        if (hold > 0 && this.buffer.length > hold) {
          this.flush(this.buffer.slice(0, this.buffer.length - hold))
          this.buffer = this.buffer.slice(-hold)
          progress = true
        } else if (hold === 0 && this.buffer.length > 0) {
          this.flush(this.buffer)
          this.buffer = ""
          progress = true
        }
      } else {
        const idx = this.buffer.indexOf(OPEN)
        if (idx >= 0) {
          if (idx > 0) this.flush(this.buffer.slice(0, idx))
          this.buffer = this.buffer.slice(idx + OPEN.length)
          this.active = true
          progress = true
          continue
        }
        const hold = thinkHoldLen(this.buffer, true)
        if (hold > 0 && this.buffer.length > hold) {
          this.flush(this.buffer.slice(0, this.buffer.length - hold))
          this.buffer = this.buffer.slice(-hold)
          progress = true
        } else if (hold === 0 && this.buffer.length > 0) {
          this.flush(this.buffer)
          this.buffer = ""
          progress = true
        }
      }
    }
  }

  endOfStream() {
    if (this.buffer.length > 0) {
      this.flush(this.buffer)
      this.buffer = ""
    }
    this.active = false
  }
}

function run(chunks: string[]) {
  const sim = new Sim()
  for (const chunk of chunks) sim.step(chunk)
  sim.endOfStream()
  return sim.out
}

function visible(segments: Emit[]) {
  return segments.filter((s) => s.type === "text").map((s) => s.text).join("")
}
function reasoning(segments: Emit[]) {
  return segments.filter((s) => s.type === "reasoning").map((s) => s.text).join("")
}

describe("thinkHoldLen (pure helper)", () => {
  test("open: longest prefix of OPEN that is a suffix of buffer", () => {
    expect(thinkHoldLen("", true)).toBe(0)
    expect(thinkHoldLen("h", true)).toBe(0)
    expect(thinkHoldLen(LT, true)).toBe(1)
    expect(thinkHoldLen("a" + LT + "t", true)).toBe(2)
    expect(thinkHoldLen("hello" + LT + "th", true)).toBe(3)
    expect(thinkHoldLen("hello" + LT + "thin", true)).toBe(5)
    expect(thinkHoldLen("hello" + LT + "think", true)).toBe(6)
  })

  test("close: longest prefix of CLOSE that is a suffix of buffer", () => {
    expect(thinkHoldLen("", false)).toBe(0)
    // `<` alone IS a valid 1-char prefix of `</think`, so we hold it.
    expect(thinkHoldLen(LT, false)).toBe(1)
    expect(thinkHoldLen(LT + "/", false)).toBe(2)
    expect(thinkHoldLen("a" + LT + "/t", false)).toBe(3)
    expect(thinkHoldLen("hello" + LT + "/thin", false)).toBe(6)
    expect(thinkHoldLen("hello" + LT + "/think", false)).toBe(7)
  })

  test("never holds a full tag", () => {
    expect(thinkHoldLen(OPEN, true)).toBeLessThan(OPEN.length)
    expect(thinkHoldLen(CLOSE, false)).toBeLessThan(CLOSE.length)
  })
})

describe("parser: single-chunk cases", () => {
  test("pure visible text", () => {
    const segs = run(["hello world"])
    expect(visible(segs)).toBe("hello world")
    expect(reasoning(segs)).toBe("")
  })

  test("pure inline thinking", () => {
    const segs = run([OPEN + "reasoning A" + CLOSE])
    expect(visible(segs)).toBe("")
    expect(reasoning(segs)).toBe("reasoning A")
  })

  test("thinking then visible", () => {
    const segs = run([OPEN + "plan X" + CLOSE + "answer"])
    expect(visible(segs)).toBe("answer")
    expect(reasoning(segs)).toBe("plan X")
  })

  test("visible then thinking", () => {
    const segs = run(["preface " + OPEN + "plan" + CLOSE])
    expect(visible(segs)).toBe("preface ")
    expect(reasoning(segs)).toBe("plan")
  })

  test("thinking sandwiched in visible", () => {
    const segs = run(["ab " + OPEN + "mid" + CLOSE + " cd"])
    expect(visible(segs)).toBe("ab  cd")
    expect(reasoning(segs)).toBe("mid")
  })

  test("multiple alternating blocks", () => {
    const segs = run(["a " + OPEN + "b" + CLOSE + " c " + OPEN + "d" + CLOSE + " e"])
    expect(visible(segs)).toBe("a  c  e")
    expect(reasoning(segs)).toBe("bd")
  })
})

describe("parser: tag split across chunk boundaries", () => {
  test("open tag split char-by-char", () => {
    const chunks = [LT, "t", "h", "i", "n", "k", GT + "reasoning" + CLOSE]
    const segs = run(chunks)
    expect(visible(segs)).toBe("")
    expect(reasoning(segs)).toBe("reasoning")
  })

  test("open tag split in half", () => {
    const segs = run(["hello" + LT + "th", "ink" + GT + "plan" + CLOSE])
    expect(visible(segs)).toBe("hello")
    expect(reasoning(segs)).toBe("plan")
  })

  test("close tag split char-by-char", () => {
    const chunks = [OPEN + "reasoning" + LT, "/", "t", "h", "i", "n", "k", GT + "rest"]
    const segs = run(chunks)
    expect(reasoning(segs)).toBe("reasoning")
    expect(visible(segs)).toBe("rest")
  })

  test("close tag split in half", () => {
    const segs = run([OPEN + "r1" + LT + "/th", "ink" + GT + "rest"])
    expect(reasoning(segs)).toBe("r1")
    expect(visible(segs)).toBe("rest")
  })

  test("open and close both split across chunks", () => {
    const segs = run(["x" + LT + "th", "ink" + GT + "r1" + LT + "/t", "hink" + GT + "y"])
    expect(visible(segs)).toBe("xy")
    expect(reasoning(segs)).toBe("r1")
  })

  test("complete tag delivered in a chunk that contains no other text", () => {
    const segs = run([OPEN, "r1" + CLOSE, "tail"])
    expect(reasoning(segs)).toBe("r1")
    expect(visible(segs)).toBe("tail")
  })

  test("text right before partial open tag stays held back", () => {
    const segs = run(["hi" + LT, "think" + GT + "plan" + CLOSE])
    expect(visible(segs)).toBe("hi")
    expect(reasoning(segs)).toBe("plan")
  })
})

describe("parser: partial tag that never completes", () => {
  test("open tag started but never closed: end-of-stream flushes remainder as reasoning", () => {
    const segs = run(["hi " + OPEN + "orphan"])
    expect(visible(segs)).toBe("hi ")
    expect(reasoning(segs)).toBe("orphan")
  })

  test("only a `<` and no follow-up: end-of-stream flushes it as visible text", () => {
    const segs = run(["abc " + LT])
    expect(visible(segs)).toBe("abc " + LT)
    expect(reasoning(segs)).toBe("")
  })

  test("partial close with no follow-up: end-of-stream flushes it as reasoning", () => {
    const segs = run([OPEN + "reasoning" + LT + "/"])
    expect(reasoning(segs)).toBe("reasoning" + LT + "/")
  })
})

describe("parser: false starts and edge cases", () => {
  test("< followed by non-tag chars: < is visible text", () => {
    const segs = run(["text " + LT + "not-a-tag" + GT])
    expect(visible(segs)).toBe("text " + LT + "not-a-tag" + GT)
    expect(reasoning(segs)).toBe("")
  })

  test("<< literal: both < are visible text", () => {
    const segs = run([LT + LT + GT + GT])
    expect(visible(segs)).toBe(LT + LT + GT + GT)
    expect(reasoning(segs)).toBe("")
  })

  test("</ mid-text is visible (no matching OPEN)", () => {
    const segs = run(["foo" + LT + "/bar"])
    expect(visible(segs)).toBe("foo" + LT + "/bar")
    expect(reasoning(segs)).toBe("")
  })

  test("multiple OPENs: emits everything between first open and first close", () => {
    const segs = run([OPEN + "a " + OPEN + "b" + CLOSE + CLOSE])
    expect(reasoning(segs)).toBe("a " + OPEN + "b")
    expect(visible(segs)).toBe(CLOSE)
  })

  test("empty reasoning block: emits nothing for reasoning", () => {
    const segs = run(["hi " + OPEN + CLOSE + "there"])
    expect(visible(segs)).toBe("hi there")
    expect(reasoning(segs)).toBe("")
  })

  test("consecutive thinking blocks with no visible text between", () => {
    const segs = run([OPEN + "a" + CLOSE + OPEN + "b" + CLOSE])
    expect(reasoning(segs)).toBe("ab")
    expect(visible(segs)).toBe("")
  })
})

describe("parser: property — partition into visible and reasoning", () => {
  // Invariant: for any input and any chunking, concatenating all visible
  // segments must equal the input with every `OPEN...CLOSE` block removed,
  // and concatenating all reasoning segments must equal the concatenation
  // of every block's content in order. Segment boundaries are an
  // implementation detail — they only matter for how many updatePartDelta
  // calls the UI sees, not for the final content.
  const TAG_RE = new RegExp(OPEN + "([\\s\\S]*?)" + CLOSE, "g")
  function stripTags(s: string) {
    return s.replace(TAG_RE, "")
  }
  function tagsContent(s: string) {
    const out: string[] = []
    s.replace(TAG_RE, (_m, body) => {
      out.push(body)
      return ""
    })
    return out.join("")
  }

  const inputs: string[] = [
    "plain text only",
    OPEN + "only thinking" + CLOSE,
    "a " + OPEN + "b" + CLOSE + " c",
    OPEN + "plan X" + CLOSE + "answer" + OPEN + "why" + CLOSE + " done",
    "x" + LT + "tag" + GT + "y" + LT + "/tag" + GT + "z",
    "leading " + LT + " then " + OPEN + "real" + CLOSE + " end",
    OPEN + CLOSE, // empty open/close pair
    LT + "th" + "ink" + GT + "r1" + LT + "/" + "thi" + "nk" + GT + "r2" + CLOSE,
    // Malformed: close without matching open. The remainder becomes visible.
    OPEN + "r1" + CLOSE + "r2" + CLOSE,
  ]

  for (const input of inputs) {
    test(`input: ${JSON.stringify(input)}`, () => {
      const expectedVisible = stripTags(input)
      const expectedReasoning = tagsContent(input)
      for (let split = 1; split < input.length; split++) {
        const chunks = [input.slice(0, split), input.slice(split)]
        const segs = run(chunks)
        const v = visible(segs)
        const r = reasoning(segs)
        if (v !== expectedVisible || r !== expectedReasoning) {
          throw new Error(
            `split=${split} chunks=${JSON.stringify(chunks)}\n` +
              `  visible got=${JSON.stringify(v)} want=${JSON.stringify(expectedVisible)}\n` +
              `  reasoning got=${JSON.stringify(r)} want=${JSON.stringify(expectedReasoning)}\n` +
              `  segs=${JSON.stringify(segs)}`,
          )
        }
      }
    })
  }
})
