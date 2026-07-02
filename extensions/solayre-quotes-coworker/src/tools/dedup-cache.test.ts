import { describe, expect, it, vi } from "vitest";
import { createDedupCache, dedupKey } from "./dedup-cache.js";

describe("dedup-cache", () => {
  it("returns undefined for unknown key", () => {
    const cache = createDedupCache(60_000);
    expect(cache.get("unknown")).toBeUndefined();
  });

  it("stores and retrieves a value", () => {
    const cache = createDedupCache(60_000);
    const entry = { createdAt: Date.now(), result: { success: true } };
    cache.set("key1", entry);
    expect(cache.get("key1")).toBe(entry);
  });

  it("sweeps expired entries on get", () => {
    const cache = createDedupCache(10); // 10ms TTL
    const entry = { createdAt: Date.now(), result: { success: true } };
    cache.set("key1", entry);
    expect(cache.get("key1")).toBe(entry);

    // Wait for TTL to expire
    const expired = { createdAt: Date.now() - 100, result: { success: false } };
    cache.set("key2", expired);

    // get triggers sweep; key2 should be gone
    expect(cache.get("key2")).toBeUndefined();
  });

  it("sweeps expired entries on set", () => {
    const cache = createDedupCache(10);
    const entry = { createdAt: Date.now(), result: { success: true } };
    cache.set("key1", entry);

    // Wait for TTL to expire
    const expired = { createdAt: Date.now() - 100, result: { success: false } };
    cache.set("key2", expired);

    // set triggers sweep; key2 should be gone
    expect(cache.get("key2")).toBeUndefined();
  });

  it("dedupKey builds consistent keys", () => {
    expect(dedupKey("5216672350818", "/tmp/receipt.pdf")).toBe("5216672350818::/tmp/receipt.pdf");
    expect(dedupKey("5216672350818", "/tmp/receipt.pdf")).toBe(
      dedupKey("5216672350818", "/tmp/receipt.pdf"),
    );
    expect(dedupKey("5216672350818", "/tmp/receipt.pdf")).not.toBe(
      dedupKey("5216672350819", "/tmp/receipt.pdf"),
    );
  });

  describe("claim", () => {
    it("runs the work function and caches the result", async () => {
      const cache = createDedupCache(60_000);
      const work = vi.fn(async () => ({ success: true }));

      const result = await cache.claim("key1", work);

      expect(result).toEqual({ success: true });
      expect(work).toHaveBeenCalledTimes(1);
      expect(cache.get("key1")?.result).toEqual({ success: true });
    });

    it("returns cached result on subsequent calls without running work", async () => {
      const cache = createDedupCache(60_000);
      const work = vi.fn(async () => ({ success: true }));

      await cache.claim("key1", work);
      const result = await cache.claim("key1", work);

      expect(result).toEqual({ success: true });
      expect(work).toHaveBeenCalledTimes(1);
    });

    it("shares a single in-flight promise for concurrent callers", async () => {
      const cache = createDedupCache(60_000);
      let resolveWork: (v: unknown) => void;
      const workPromise = new Promise((resolve) => {
        resolveWork = resolve;
      });
      const work = vi.fn(async () => {
        await workPromise;
        return { success: true };
      });

      // Two concurrent claims for the same key
      const claim1 = cache.claim("key1", work);
      const claim2 = cache.claim("key1", work);

      // Both should be waiting on the same promise
      expect(work).toHaveBeenCalledTimes(1);

      // Resolve the work
      resolveWork!({ success: true });

      const [r1, r2] = await Promise.all([claim1, claim2]);
      expect(r1).toEqual({ success: true });
      expect(r2).toEqual({ success: true });
      expect(work).toHaveBeenCalledTimes(1);
    });

    it("clears in-flight entry after work completes (success)", async () => {
      const cache = createDedupCache(60_000);
      const work = vi.fn(async () => ({ success: true }));

      await cache.claim("key1", work);

      // After completion, a new claim should hit the cache, not re-run work
      await cache.claim("key1", work);
      expect(work).toHaveBeenCalledTimes(1);
    });

    it("clears in-flight entry after work fails", async () => {
      const cache = createDedupCache(60_000);
      const work = vi.fn(async () => {
        throw new Error("boom");
      });

      await expect(cache.claim("key1", work)).rejects.toThrow("boom");

      // After failure, a new claim should re-run work (no cached result)
      const work2 = vi.fn(async () => ({ success: true }));
      await cache.claim("key1", work2);
      expect(work2).toHaveBeenCalledTimes(1);
    });

    it("does not cache failed results", async () => {
      const cache = createDedupCache(60_000);
      const work = vi.fn(async () => {
        throw new Error("boom");
      });

      await expect(cache.claim("key1", work)).rejects.toThrow("boom");
      expect(cache.get("key1")).toBeUndefined();
    });
  });
});
