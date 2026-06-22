/**
 * Bounded LRU cache with optional per-entry TTL.
 *
 * Lifted from the private class that lived in `src/history/resolve.ts`
 * (PR-1, step 1). The cache is process-local; eviction is on insertion
 * when `max` is exceeded and on read when a TTL-expired entry is
 * touched. The implementation is intentionally dependency-free — no
 * `effect` import — so it can be used from synchronous code paths
 * (e.g. the `edit` tool's lock-map eviction, where Effect has not been
 * introduced yet).
 */
export class LRU<K, V> {
  private map = new Map<K, { value: V; expiresAt: number | undefined }>()
  private readonly max: number
  private readonly now: () => number

  constructor(max: number, opts?: { ttlMs?: number; now?: () => number }) {
    if (max <= 0) throw new Error("LRU: max must be > 0")
    this.max = max
    this.now = opts?.now ?? Date.now
    if (opts?.ttlMs !== undefined) this.ttlMs = opts.ttlMs
  }

  private ttlMs: number | undefined

  get(k: K): V | undefined {
    const entry = this.map.get(k)
    if (!entry) return undefined
    if (entry.expiresAt !== undefined && entry.expiresAt <= this.now()) {
      this.map.delete(k)
      return undefined
    }
    // Promote to MRU position.
    this.map.delete(k)
    this.map.set(k, entry)
    return entry.value
  }

  set(k: K, v: V): void {
    if (this.map.has(k)) this.map.delete(k)
    const entry = { value: v, expiresAt: this.ttlMs !== undefined ? this.now() + this.ttlMs : undefined }
    this.map.set(k, entry)
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) this.map.delete(oldest)
    }
  }

  delete(k: K): boolean {
    return this.map.delete(k)
  }

  clear(): void {
    this.map.clear()
  }

  get size(): number {
    return this.map.size
  }
}