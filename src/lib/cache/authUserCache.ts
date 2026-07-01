import "server-only";
import { createHash } from "node:crypto";
import { getRedisClient } from "./redisClient";

/**
 * Short-lived cache for supabase.auth.getUser() results.
 *
 * Cache key: SHA-256 of the access token (token itself never stored or logged).
 * Cache value: user.id (string).
 * TTL: 60s — keeps the window for stale auth small; forced logout takes effect within 1 min.
 *
 * Primary: Upstash Redis (shared across Vercel instances).
 * Fallback: in-process Map (single lambda, dev).
 */

export type AuthUserCacheSource = "shared" | "memory" | "miss";

const REDIS_TTL_S = 60;
const MEMORY_TTL_MS = 60_000;
const MEMORY_MAX = 500;

// ---- In-process fallback ---------------------------------------------------

interface MemEntry { userId: string; expiresAt: number }
const memCache = new Map<string, MemEntry>();

function memGet(key: string): string | null {
  const e = memCache.get(key);
  if (!e) return null;
  if (Date.now() >= e.expiresAt) { memCache.delete(key); return null; }
  return e.userId;
}

function memSet(key: string, userId: string): void {
  if (memCache.size >= MEMORY_MAX) {
    const now = Date.now();
    for (const [k, v] of memCache) {
      if (now >= v.expiresAt) memCache.delete(k);
    }
    if (memCache.size >= MEMORY_MAX * 0.9) {
      let toRemove = Math.ceil(MEMORY_MAX * 0.1);
      for (const k of memCache.keys()) {
        if (toRemove-- <= 0) break;
        memCache.delete(k);
      }
    }
  }
  memCache.set(key, { userId, expiresAt: Date.now() + MEMORY_TTL_MS });
}

// ---- Key derivation --------------------------------------------------------

/** Returns SHA-256 hex of the access token. Token is never stored or logged. */
function tokenKey(accessToken: string): string {
  return "auth-user:" + createHash("sha256").update(accessToken).digest("hex");
}

// ---- Public API ------------------------------------------------------------

/**
 * Look up cached userId for the given access token.
 * Returns userId + cache layer, or null + "miss".
 */
export async function getAuthUserCache(
  accessToken: string,
): Promise<{ userId: string | null; source: AuthUserCacheSource }> {
  const key = tokenKey(accessToken);

  const redis = getRedisClient();
  if (redis) {
    try {
      const cached = await redis.get<string>(key);
      if (cached) return { userId: cached, source: "shared" };
    } catch {
      // Redis failure — fall through to in-process
    }
  }

  const mem = memGet(key);
  if (mem) return { userId: mem, source: "memory" };

  return { userId: null, source: "miss" };
}

/**
 * Cache userId for the given access token.
 * Writes to in-process Map first, then Redis (fire-and-forget on failure).
 */
export async function setAuthUserCache(
  accessToken: string,
  userId: string,
): Promise<void> {
  const key = tokenKey(accessToken);
  memSet(key, userId);

  const redis = getRedisClient();
  if (redis) {
    try {
      await redis.set(key, userId, { ex: REDIS_TTL_S });
    } catch {
      // Redis write failure is non-fatal
    }
  }
}
