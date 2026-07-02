/**
 * In-memory dedup cache for receipt-processing tools.
 *
 * Prevents duplicate WhatsApp acknowledgements and redundant parse-and-quote
 * API calls when the same tool is invoked multiple times for the same
 * (deliveryPhone, mediaPath) pair within a short time window.
 *
 * Stateless plugins (coworker, leads) cannot use the pending_quote_jobs table,
 * so this lightweight in-memory cache provides the same guard without a DB.
 *
 * Concurrency: a promise-lock pattern ensures that concurrent invocations for
 * the same key share a single in-flight promise. The second caller awaits the
 * same promise instead of starting a duplicate flow.
 */

export interface DedupEntry {
  /** When this entry was first created (epoch ms). */
  createdAt: number;
  /** Cached result from the first invocation. */
  result: unknown;
}

export interface DedupCache {
  /** Returns a cached result when the same key was seen within the TTL. */
  get(key: string): DedupEntry | undefined;
  /** Stores a result under a key. */
  set(key: string, entry: DedupEntry): void;
  /**
   * Atomically claim a key for in-flight work. Returns a promise that resolves
   * to the final result when the work completes. If another caller already
   * claimed the same key, returns the same promise so both callers share one
   * execution. If a completed result is already cached, returns it immediately
   * without calling work.
   */
  claim(key: string, work: () => Promise<unknown>): Promise<unknown>;
  /** Prunes expired entries. */
  sweep(now: number): void;
}

export function createDedupCache(ttlMs: number = 5 * 60 * 1000): DedupCache {
  const store = new Map<string, DedupEntry>();
  /** In-flight promises keyed by dedup key. */
  const inflight = new Map<string, Promise<unknown>>();

  function sweep(now: number): void {
    const cutoff = now - ttlMs;
    for (const [key, entry] of store) {
      if (entry.createdAt < cutoff) {
        store.delete(key);
      }
    }
  }

  return {
    get(key: string): DedupEntry | undefined {
      sweep(Date.now());
      return store.get(key);
    },
    set(key: string, entry: DedupEntry): void {
      sweep(Date.now());
      store.set(key, entry);
    },
    claim(key: string, work: () => Promise<unknown>): Promise<unknown> {
      // Return a cached result if one exists (sweeps expired entries).
      const cached = this.get(key);
      if (cached) {
        return Promise.resolve(cached.result);
      }

      // Return an existing in-flight promise if one exists.
      const existing = inflight.get(key);
      if (existing) {
        return existing;
      }

      // Create a new promise and store it.
      const promise = work()
        .then((result) => {
          // Cache the successful result.
          store.set(key, { createdAt: Date.now(), result });
          return result;
        })
        .finally(() => {
          // Clean up the in-flight entry regardless of success/failure.
          inflight.delete(key);
        });

      inflight.set(key, promise);
      return promise;
    },
    sweep,
  };
}

/** Build a dedup key from the delivery phone and media path. */
export function dedupKey(deliveryPhone: string, mediaPath: string): string {
  return `${deliveryPhone}::${mediaPath}`;
}
