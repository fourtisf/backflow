/**
 * Small in-process caches for public, unauthenticated reads (audit L6, M3).
 * Concurrent callers share one in-flight promise, so a burst of requests
 * costs one database or RPC round trip, not one per caller. Failures are
 * not cached.
 */

/** A single cached value with a time to live. */
export function cached<T>(ttlMs: number) {
  let at = 0;
  let value: T | undefined;
  let has = false;
  let inflight: Promise<T> | null = null;
  return (load: () => Promise<T>): Promise<T> => {
    if (has && Date.now() - at < ttlMs) return Promise.resolve(value as T);
    if (inflight) return inflight;
    inflight = load()
      .then((v) => {
        value = v;
        has = true;
        at = Date.now();
        return v;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
}

/** A keyed cache with a time to live and a size cap (oldest entries are evicted first). */
export function keyedCache<K, V>(ttlMs: number, max: number) {
  const values = new Map<K, { at: number; v: V }>();
  const inflight = new Map<K, Promise<V>>();
  return (key: K, load: () => Promise<V>): Promise<V> => {
    const hit = values.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return Promise.resolve(hit.v);
    const running = inflight.get(key);
    if (running) return running;
    const p = load()
      .then((v) => {
        values.delete(key);
        values.set(key, { at: Date.now(), v });
        while (values.size > max) values.delete(values.keys().next().value as K);
        return v;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  };
}

/** Least-recently-used map with a size cap. */
export class Lru<K, V> {
  private readonly m = new Map<K, V>();
  constructor(private readonly max: number) {}
  get(key: K): V | undefined {
    const v = this.m.get(key);
    if (v !== undefined) {
      this.m.delete(key);
      this.m.set(key, v);
    }
    return v;
  }
  set(key: K, v: V): void {
    this.m.delete(key);
    this.m.set(key, v);
    while (this.m.size > this.max) this.m.delete(this.m.keys().next().value as K);
  }
  get size(): number {
    return this.m.size;
  }
  values(): IterableIterator<V> {
    return this.m.values();
  }
  entries(): IterableIterator<[K, V]> {
    return this.m.entries();
  }
}
