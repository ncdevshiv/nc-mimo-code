import { describe, test, expect } from "bun:test"
import { LRU } from "../../src/util/lru"

describe("LRU: basic operations", () => {
  test("set then get returns the value", () => {
    const lru = new LRU<string, number>(3)
    lru.set("a", 1)
    expect(lru.get("a")).toBe(1)
  })

  test("get on missing key returns undefined", () => {
    const lru = new LRU<string, number>(3)
    expect(lru.get("nope")).toBeUndefined()
  })

  test("delete removes the entry", () => {
    const lru = new LRU<string, number>(3)
    lru.set("a", 1)
    expect(lru.delete("a")).toBe(true)
    expect(lru.get("a")).toBeUndefined()
  })

  test("delete on missing key returns false", () => {
    const lru = new LRU<string, number>(3)
    expect(lru.delete("nope")).toBe(false)
  })

  test("clear empties the cache", () => {
    const lru = new LRU<string, number>(3)
    lru.set("a", 1)
    lru.set("b", 2)
    lru.clear()
    expect(lru.size).toBe(0)
    expect(lru.get("a")).toBeUndefined()
  })

  test("size reflects entries", () => {
    const lru = new LRU<string, number>(3)
    expect(lru.size).toBe(0)
    lru.set("a", 1)
    expect(lru.size).toBe(1)
    lru.set("b", 2)
    expect(lru.size).toBe(2)
  })

  test("overwriting an existing key does not grow size", () => {
    const lru = new LRU<string, number>(3)
    lru.set("a", 1)
    lru.set("a", 2)
    expect(lru.size).toBe(1)
    expect(lru.get("a")).toBe(2)
  })
})

describe("LRU: eviction", () => {
  test("evicts the oldest entry when max is exceeded", () => {
    const lru = new LRU<string, number>(2)
    lru.set("a", 1)
    lru.set("b", 2)
    lru.set("c", 3)
    expect(lru.size).toBe(2)
    expect(lru.get("a")).toBeUndefined()
    expect(lru.get("b")).toBe(2)
    expect(lru.get("c")).toBe(3)
  })

  test("get promotes entry to most-recently-used", () => {
    const lru = new LRU<string, number>(2)
    lru.set("a", 1)
    lru.set("b", 2)
    // Touch 'a' so 'b' becomes the oldest.
    lru.get("a")
    lru.set("c", 3)
    expect(lru.get("b")).toBeUndefined()
    expect(lru.get("a")).toBe(1)
    expect(lru.get("c")).toBe(3)
  })

  test("eviction respects max=1", () => {
    const lru = new LRU<string, number>(1)
    lru.set("a", 1)
    lru.set("b", 2)
    expect(lru.size).toBe(1)
    expect(lru.get("a")).toBeUndefined()
    expect(lru.get("b")).toBe(2)
  })

  test("constructor rejects non-positive max", () => {
    expect(() => new LRU<string, number>(0)).toThrow()
    expect(() => new LRU<string, number>(-1)).toThrow()
  })
})

describe("LRU: TTL", () => {
  test("TTL-expired entries return undefined and are evicted on get", () => {
    let now = 0
    const lru = new LRU<string, number>(3, { ttlMs: 100, now: () => now })
    lru.set("a", 1)
    now = 50
    expect(lru.get("a")).toBe(1)
    now = 150
    expect(lru.get("a")).toBeUndefined()
    expect(lru.size).toBe(0)
  })

  test("TTL is per-entry from insertion time, not from max-age", () => {
    let now = 0
    const lru = new LRU<string, number>(3, { ttlMs: 100, now: () => now })
    lru.set("a", 1)
    now = 60
    lru.set("b", 2)
    now = 130
    // 'a' is 130ms old (>100) and expired; 'b' is 70ms old (<100) and live.
    expect(lru.get("a")).toBeUndefined()
    expect(lru.get("b")).toBe(2)
  })

  test("no TTL means entries never expire", () => {
    let now = 0
    const lru = new LRU<string, number>(3, { now: () => now })
    lru.set("a", 1)
    now = 1_000_000
    expect(lru.get("a")).toBe(1)
  })

  test("default now() uses Date.now", () => {
    const lru = new LRU<string, number>(3, { ttlMs: 1 })
    lru.set("a", 1)
    // No fake clock — wait a couple ms.
    return new Promise<void>((resolve) => setTimeout(() => {
      expect(lru.get("a")).toBeUndefined()
      resolve()
    }, 10))
  })
})

describe("LRU: real-world usage", () => {
  test("history/resolve-shaped usage with two parallel caches", () => {
    const roleCache = new LRU<string, "user" | "assistant">(1024)
    const projectCache = new LRU<string, string>(512)
    roleCache.set("m1", "user")
    roleCache.set("m2", "assistant")
    projectCache.set("s1", "proj-a")
    projectCache.set("s2", "proj-b")
    expect(roleCache.get("m1")).toBe("user")
    expect(projectCache.get("s2")).toBe("proj-b")
    expect(roleCache.size).toBe(2)
    expect(projectCache.size).toBe(2)
  })

  test("edit lock map usage with bounded size + TTL", () => {
    let now = 0
    const locks = new LRU<string, { id: number }>(256, { ttlMs: 600_000, now: () => now })
    for (let i = 0; i < 256; i++) {
      locks.set(`file-${i}`, { id: i })
    }
    expect(locks.size).toBe(256)
    locks.set("file-256", { id: 256 })
    expect(locks.size).toBe(256)
    expect(locks.get("file-0")).toBeUndefined()
    expect(locks.get("file-256")).toEqual({ id: 256 })
    // After 11 minutes, all entries should be expired.
    now = 11 * 60 * 1000
    expect(locks.get("file-256")).toBeUndefined()
  })
})