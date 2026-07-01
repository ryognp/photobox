import "server-only";

/**
 * Process-level TTL cache for default workspace lookups.
 *
 * getDefaultWorkspaceForUser() issues a workspaceMember.findFirst + workspace JOIN
 * on every request (~1s RTT to Supabase DB). Caching by userId eliminates that
 * round-trip for repeated requests within the TTL window.
 *
 * Trade-off: workspace membership/role changes take up to TTL to reflect.
 * Call invalidateWorkspaceCache(userId) explicitly if immediate consistency is needed.
 */

const TTL_MS = 5 * 60 * 1_000; // 5 minutes
const MAX_ENTRIES = 1_000;

// Minimal workspace shape — only what the server needs per request.
// Keeps the cache small and avoids importing generated Prisma types here.
export interface CachedWorkspace {
  id: string;
  name: string;
  slug: string;
  plan: string;
}

interface Entry {
  workspace: CachedWorkspace;
  expiresAt: number;
}

const cache = new Map<string, Entry>();

/** Return cached workspace or null on miss / expired. */
export function getWorkspaceCache(userId: string): CachedWorkspace | null {
  const entry = cache.get(userId);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    cache.delete(userId);
    return null;
  }
  return entry.workspace;
}

/** Store workspace for userId. Does NOT cache null (no-workspace) to avoid
 *  hiding a newly-provisioned workspace. */
export function setWorkspaceCache(userId: string, workspace: CachedWorkspace): void {
  if (cache.size >= MAX_ENTRIES) {
    // Evict all expired entries first
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
  cache.set(userId, { workspace, expiresAt: Date.now() + TTL_MS });
}

/** Force-expire a user's cached workspace (call after membership changes). */
export function invalidateWorkspaceCache(userId: string): void {
  cache.delete(userId);
}

export function getWorkspaceCacheStats(): {
  size: number;
  maxEntries: number;
  ttlMs: number;
} {
  return { size: cache.size, maxEntries: MAX_ENTRIES, ttlMs: TTL_MS };
}
