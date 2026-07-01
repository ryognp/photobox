import "server-only";
import { CACHE_INSTANCE_ID } from "./cacheInstance";
import { getRedisClient } from "./redisClient";

export { CACHE_INSTANCE_ID };

export interface CachedWorkspace {
  id: string;
  name: string;
  slug: string;
  plan: string;
}

// ---- Redis config ----------------------------------------------------------

const REDIS_PREFIX = "workspace:";
const REDIS_TTL_S = 300; // 5 min

// ---- In-process fallback ---------------------------------------------------
// Used when Redis is not configured or fails.

const MEMORY_TTL_MS = 5 * 60 * 1_000;
const MEMORY_MAX = 1_000;

interface MemEntry {
  workspace: CachedWorkspace;
  expiresAt: number;
}
const memCache = new Map<string, MemEntry>();

function memGet(userId: string): CachedWorkspace | null {
  const e = memCache.get(userId);
  if (!e) return null;
  if (Date.now() >= e.expiresAt) { memCache.delete(userId); return null; }
  return e.workspace;
}

function memSet(userId: string, workspace: CachedWorkspace): void {
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
  memCache.set(userId, { workspace, expiresAt: Date.now() + MEMORY_TTL_MS });
}

// ---- Public API ------------------------------------------------------------

export type WorkspaceCacheSource = "shared" | "memory" | "miss";

/**
 * Get cached workspace.
 * Returns workspace + the layer that served it, or null + "miss".
 */
export async function getWorkspaceCache(
  userId: string,
): Promise<{ workspace: CachedWorkspace | null; source: WorkspaceCacheSource }> {
  const redis = getRedisClient();

  if (redis) {
    try {
      const raw = await redis.get<CachedWorkspace>(`${REDIS_PREFIX}${userId}`);
      if (raw) return { workspace: raw, source: "shared" };
    } catch {
      // Redis failure — fall through to in-process
    }
  }

  const mem = memGet(userId);
  if (mem) return { workspace: mem, source: "memory" };

  return { workspace: null, source: "miss" };
}

/**
 * Store workspace. Null values are never cached.
 * Tries Redis first; also writes to in-process Map as L2.
 */
export async function setWorkspaceCache(
  userId: string,
  workspace: CachedWorkspace,
): Promise<void> {
  memSet(userId, workspace);

  const redis = getRedisClient();
  if (redis) {
    try {
      await redis.set(`${REDIS_PREFIX}${userId}`, workspace, { ex: REDIS_TTL_S });
    } catch {
      // Redis write failure is non-fatal; in-process cache is sufficient fallback
    }
  }
}

/** Force-expire a user's cached workspace (call after membership changes). */
export async function invalidateWorkspaceCache(userId: string): Promise<void> {
  memCache.delete(userId);
  const redis = getRedisClient();
  if (redis) {
    try {
      await redis.del(`${REDIS_PREFIX}${userId}`);
    } catch {
      // ignore
    }
  }
}

export function getWorkspaceCacheStats(): {
  instanceId: string;
  sharedCacheEnabled: boolean;
  memSize: number;
} {
  return {
    instanceId: CACHE_INSTANCE_ID,
    sharedCacheEnabled: getRedisClient() !== null,
    memSize: memCache.size,
  };
}
