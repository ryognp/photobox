import "server-only";
import { CACHE_INSTANCE_ID } from "../cache/cacheInstance";

/**
 * Process-level TTL cache for Supabase Storage signed URLs.
 *
 * Signed URLs from photobox-private have a 15-minute (900s) expiry.
 * We cache for 14 minutes (840s) to ensure URLs are still valid when served.
 *
 * This is a simple in-process Map — appropriate for a single-instance
 * Next.js deployment. For multi-instance deployments, replace with
 * Upstash Redis / Vercel KV.
 */

const CACHE_TTL_MS = 840_000; // 14 min — safely under the 15 min signing expiry
const MAX_ENTRIES = 5_000;

interface Entry {
  url: string;
  expiresAt: number;
}

const cache = new Map<string, Entry>();

export function getSignedUrlCache(storagePath: string): string | null {
  const entry = cache.get(storagePath);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    cache.delete(storagePath);
    return null;
  }
  return entry.url;
}

export function setSignedUrlCache(storagePath: string, url: string): void {
  // Evict expired entries when approaching limit
  if (cache.size >= MAX_ENTRIES) {
    const now = Date.now();
    for (const [k, v] of cache) {
      if (now >= v.expiresAt) cache.delete(k);
    }
    // If still over 90% capacity, evict oldest 10%
    if (cache.size >= MAX_ENTRIES * 0.9) {
      let toRemove = Math.ceil(MAX_ENTRIES * 0.1);
      for (const k of cache.keys()) {
        if (toRemove-- <= 0) break;
        cache.delete(k);
      }
    }
  }
  cache.set(storagePath, { url, expiresAt: Date.now() + CACHE_TTL_MS });
}

export function getSignedUrlCacheStats(): {
  instanceId: string;
  size: number;
  maxEntries: number;
  ttlMs: number;
} {
  return { instanceId: CACHE_INSTANCE_ID, size: cache.size, maxEntries: MAX_ENTRIES, ttlMs: CACHE_TTL_MS };
}
