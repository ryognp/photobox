import "server-only";
import { CACHE_INSTANCE_ID } from "../cache/cacheInstance";
import { getRedisClient } from "../cache/redisClient";

/**
 * TTL cache for Supabase Storage signed URLs.
 *
 * Signed URLs from photobox-private expire in 900s (15 min).
 * We cache for 840s (14 min) to ensure URLs are still valid when served.
 *
 * Primary: Upstash Redis (shared across Vercel instances) when configured.
 * Fallback: in-process Map (single instance or dev).
 */

const CACHE_TTL_MS = 840_000; // 14 min
const REDIS_TTL_S = 840;       // same in seconds for Redis EX
const MAX_ENTRIES = 5_000;

// ---- In-process fallback ---------------------------------------------------

interface Entry {
  url: string;
  expiresAt: number;
}
const memCache = new Map<string, Entry>();

function memGet(key: string): string | null {
  const e = memCache.get(key);
  if (!e) return null;
  if (Date.now() >= e.expiresAt) { memCache.delete(key); return null; }
  return e.url;
}

function memSet(key: string, url: string): void {
  if (memCache.size >= MAX_ENTRIES) {
    const now = Date.now();
    for (const [k, v] of memCache) {
      if (now >= v.expiresAt) memCache.delete(k);
    }
    if (memCache.size >= MAX_ENTRIES * 0.9) {
      let toRemove = Math.ceil(MAX_ENTRIES * 0.1);
      for (const k of memCache.keys()) {
        if (toRemove-- <= 0) break;
        memCache.delete(k);
      }
    }
  }
  memCache.set(key, { url, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ---- Public API ------------------------------------------------------------

/**
 * Sync fast-path used in the hot loop (checks in-process Map only).
 * Call getSignedUrlCacheAsync for a full Redis lookup.
 */
export function getSignedUrlCache(storagePath: string): string | null {
  return memGet(storagePath);
}

/**
 * Full lookup: Redis first, then in-process Map.
 * Used in signedUrlMap before issuing Supabase Storage requests.
 */
export async function getSignedUrlCacheAsync(storagePath: string): Promise<string | null> {
  // Fast path: in-process Map
  const mem = memGet(storagePath);
  if (mem) return mem;

  // Shared cache: Redis
  const redis = getRedisClient();
  if (redis) {
    try {
      const raw = await redis.get<string>(storagePath);
      if (raw) {
        // Warm in-process Map for subsequent same-instance requests
        memSet(storagePath, raw);
        return raw;
      }
    } catch {
      // Redis failure — continue to return null (caller will re-sign)
    }
  }

  return null;
}

/** Store a signed URL. Writes to both in-process Map and Redis (if available). */
export async function setSignedUrlCacheAsync(storagePath: string, url: string): Promise<void> {
  memSet(storagePath, url);

  const redis = getRedisClient();
  if (redis) {
    try {
      await redis.set(storagePath, url, { ex: REDIS_TTL_S });
    } catch {
      // Redis write failure is non-fatal
    }
  }
}

/** @deprecated Use setSignedUrlCacheAsync. Kept for [id]/route.ts compat. */
export function setSignedUrlCache(storagePath: string, url: string): void {
  memSet(storagePath, url);
  // Fire-and-forget Redis write (no await — sync callers only)
  const redis = getRedisClient();
  if (redis) {
    redis.set(storagePath, url, { ex: REDIS_TTL_S }).catch(() => {});
  }
}

export function getSignedUrlCacheStats(): {
  instanceId: string;
  sharedCacheEnabled: boolean;
  size: number;
  maxEntries: number;
  ttlMs: number;
} {
  return {
    instanceId: CACHE_INSTANCE_ID,
    sharedCacheEnabled: getRedisClient() !== null,
    size: memCache.size,
    maxEntries: MAX_ENTRIES,
    ttlMs: CACHE_TTL_MS,
  };
}
